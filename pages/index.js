import React, { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import styles from '../styles/Home.module.css';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import regexPatterns from '../regex';  // Import the regex patterns

const tokenNameMap = {
  "0x0000000000000000000000000000000000000000": "Ethereum (ETH)",
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USD Coin (USDC)",
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "Wrapped Ether (WETH)",
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "UMA (UMA)",
  "0x0000000000000000000000000000000000000001": "Oya Token (OYA)"
};

const tokenAddressToSymbol = {
  "0x0000000000000000000000000000000000000000": "eth",
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "usdc",
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "weth",
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "uma",
  "0x0000000000000000000000000000000000000001": "oya"
};

const tokenDecimalMap = {
  "0x0000000000000000000000000000000000000000": 18, // ETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": 6,  // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": 18, // WETH
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": 18, // UMA
  "0x0000000000000000000000000000000000000001": 18  // OYA
};

const formatBalance = (balance, decimals) => {
  return (balance / Math.pow(10, decimals)).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  });
};

const Home = () => {
  const { login, logout, signMessage, user, authenticated } = usePrivy();
  const { ready, wallets } = useWallets();
  const [isRecording, setIsRecording] = useState(false);
  const [audioPromptUrl, setAudioPromptUrl] = useState('');
  const [audioResponseUrl, setAudioResponseUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visibleForm, setVisibleForm] = useState(''); // Track which form is visible
  const [errorMessage, setErrorMessage] = useState(''); // Track the error message
  const [isDashboardVisible, setIsDashboardVisible] = useState(''); // Track the dashboard visibility and type
  const [systemPrompt, setSystemPrompt] = useState(''); // Track the system prompt
  const [contacts, setContacts] = useState({}); // Track the contacts
  const [intentions, setIntentions] = useState([]);
  const [balance, setBalance] = useState([]);
  const [tokenPrices, setTokenPrices] = useState({});
  const [messages, setMessages] = useState([]); // Track all messages with audio
  const [nonce, setNonce] = useState([]);
  const audioPromptRef = useRef();
  const audioResponseRef = useRef();
  const threadContainerRef = useRef();
  const recorderRef = useRef(null); // useRef for recorder
  const audioStreamRef = useRef(null); // useRef for audio stream

  // Fetch the system prompt when the component mounts
  useEffect(() => {
    const fetchSystemPrompt = async () => {
      try {
        const response = await fetch('/api/system-prompt');
        const data = await response.json();
        if (response.ok) {
          setSystemPrompt(data.prompt);
          console.log('System Prompt:', data.prompt);
          const contactsStringMatch = data.prompt.match(/Here are the contacts and their Ethereum addresses: (.+)/);
          if (contactsStringMatch && contactsStringMatch[1]) {
            const contactsObject = JSON.parse(contactsStringMatch[1]);
            setContacts(contactsObject);
            console.log('Contacts Object:', contactsObject);
          }
        } else {
          console.error('Error fetching system prompt:', data.error);
        }
      } catch (error) {
        console.error('Error fetching system prompt:', error);
      }
    };

    fetchSystemPrompt();
  }, []);

  // Assign the functions to the window object
  useEffect(() => {
    window.handleSignMessage = (e, action) => handleSignMessage(e, action, wallets);
    window.updateContact = (e, contactObject) => updateContact(e, contactObject);
    window.toggleDashboard = (e, dashboardType) => toggleDashboard(e, dashboardType);
  }, [wallets]);

  const handleStopRecording = () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
    }
    setIsRecording(false);
  };
  
  const handleStartRecording = async () => {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(audioStream);
    let audioChunks = [];
  
    recorder.ondataavailable = e => {
      audioChunks.push(e.data);
    };
  
    recorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      setAudioPromptUrl(audioUrl);
  
      const newMessage = {
        role: 'Companion',
        content: '',
        audioUrl: audioUrl
      };
      setMessages(prevMessages => [...prevMessages, newMessage]); // Add the message to the thread immediately
  
      const formData = new FormData();
      formData.append("audioFile", audioBlob, "audio.mp3");
  
      try {
        const response = await fetch("/upload-audio", {
          method: "POST",
          body: formData,
        });
        const data = await response.json();
        if (data.requestId) {
          pollStatus(data.requestId, handleTranscriptionResult, handleError);
        }
      } catch (error) {
        console.error("Error uploading audio: ", error);
      }
    };
  
    recorder.start();
    recorderRef.current = recorder;
    audioStreamRef.current = audioStream;
    setIsRecording(true);
  };  

  const handleSubmitPrompt = async (e) => {
    e.preventDefault();
    const newMessage = {
      role: 'Companion',
      content: prompt,
      audioUrl: null
    };
    setMessages(prevMessages => [...prevMessages, newMessage]);
    setAudioPromptUrl(''); // Reset audio URL after submission
    setPrompt(''); // Clear the prompt after submission
  
    try {
      const response = await fetch('/prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: prompt }),
      });
      const data = await response.json();
      if (data.requestId) {
        pollStatus(data.requestId, handleGuideResponse, handleError);
      }
    } catch (error) {
      console.error('Error sending prompt:', error);
    }
  };  

  const handleRegister = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch('/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: username, password }),
      });

      if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await response.json();
          throw new Error(data.message || 'Registration failed');
        } else {
          throw new Error('Server error');
        }
      }

      const data = await response.json();
      console.log('Registration successful', data);
      setErrorMessage('');
    } catch (error) {
      console.error('Error:', error);
      setErrorMessage(error.message);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: username, password }),
      });

      if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await response.json();
          throw new Error(data.message || 'Login failed');
        } else {
          throw new Error('Server error');
        }
      }

      const data = await response.json();
      console.log('Login successful', data);
      setErrorMessage('');
    } catch (error) {
      console.error('Error:', error);
      setErrorMessage(error.message);
    }
  };

  const handlePrivyLogin = async (e) => {
    e.preventDefault();
    if (!ready || (ready && authenticated)) return;

    try {
      await login();
      setErrorMessage('');
    } catch (error) {
      console.error('Privy login error:', error);
      setErrorMessage(error.message);
    }
  };

  const handlePrivyLogout = async (e) => {
    e.preventDefault();
    if (!ready || (ready && !authenticated)) return;

    try {
      await logout();
      setErrorMessage('');
    } catch (error) {
      console.error('Privy logout error:', error);
      setErrorMessage(error.message);
    }
  };

  // Function to sign an intention with the embedded Privy wallet
  const handleSignMessage = async (e, action, wallets) => {
    if (e) e.preventDefault();
    console.log("handleSignMessage called with action:", action);
    setIsDashboardVisible('intentions'); // Automatically show the intentions dashboard
    if (!wallets || wallets.length === 0) {
      console.error("No wallets available.");
      setErrorMessage("No wallets available.");
      return;
    }
    console.info("Wallets:", wallets);
    const wallet = wallets[0];
  
    let nonce;
    try {
      // Fetch the nonce from the remote API server
      const response = await fetch(`/api/nonce/${wallet.address}`);
      if (response.ok) {
        // If the response is good, increment the nonce
        nonce = await response.json();
        console.log('Fetched nonce:', nonce);
        nonce += 1;
      } else if (response.status === 404) {
        // If there is no nonce, set it to 0 and send a POST request to set the nonce to 0
        nonce = 0;
        const postResponse = await fetch(`/api/nonce/${wallet.address}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ nonce })
        });
  
        if (!postResponse.ok) {
          throw new Error('Failed to set nonce to 0');
        }
  
        console.log('Set nonce to 0');
      } else {
        throw new Error('Failed to fetch nonce');
      }
      setNonce(nonce);
    } catch (error) {
      console.error('Error fetching nonce:', error);
      setErrorMessage(error.message);
      return; // Exit the function if there's an error fetching or setting the nonce
    }
  
    // Construct the message object using the action parameter and environment variables
    const message = {
      action: action,
      from: wallet.address,
      bundler: '0x42fA5d9E5b0B1c039b08853cF62f8E869e8E5bAf',
      expiry: 1734752013,
      nonce: nonce
    };
  
    const uiConfig = {
      title: 'Intention Check',
      description: 'Please sign this message if it matches what you want to do. After you sign, it will be sent to the bundler to be executed on the Oya virtual chain.',
      buttonText: 'Sign and Continue',
    };
  
    // Add the initial message with a "Signed" status
    setIntentions(prevIntentions => [...prevIntentions, { message, status: 'Signed' }]);
  
    try {
      const signature = await signMessage(JSON.stringify(message), uiConfig);
      const response = await fetch('/api/send-signed-intention', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          intention: message,
          signature: signature,
          from: wallet.address,
        }),
      });
  
      if (!response.ok) {
        throw new Error('Something went wrong when sending the intention to bundler server.');
      }
  
      const result = await response.json();
      console.log('Intention processed:\n', result);
      setErrorMessage('');
      const thanks = "Thank you, I signed and sent the intention to the Oya bundler, and it is now pending. The bundler has reviewed it and queued it for inclusion in a bundle.";
      displayPrompt(thanks);
      sendPromptToBackend(thanks);
  
      // Update the intention status to "Pending"
      setIntentions(prevIntentions => prevIntentions.map(intent => 
        intent.message === message ? { ...intent, status: 'Pending' } : intent
      ));
    } catch (error) {
      console.error('Sign message error:', error);
      setErrorMessage(error.message);
      if (error.message === 'The user rejected the request.') {
        displayPrompt("The account holder rejected the request.");
        sendPromptToBackend(error.message + ' Please ask clarifying questions instead of returning an intention object.');
  
        // Update the intention status to "Rejected"
        setIntentions(prevIntentions => prevIntentions.map(intent => 
          intent.message === message ? { ...intent, status: 'Rejected' } : intent
        ));
      } else {
        displayPrompt(error.message);
        sendPromptToBackend(error.message);
  
        // Update the intention status to "Error When Signing"
        setIntentions(prevIntentions => prevIntentions.map(intent => 
          intent.message === message ? { ...intent, status: 'Error When Signing' } : intent
        ));
      }
    }
  };  

  const updateContact = async (e, contactObject) => {
    if (e) e.preventDefault();
    console.log("updateContact called with contact information:", contactObject);
    try {
      const response = await fetch('/api/update-contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(contactObject),
      });
      if (!response.ok) {
        throw new Error('Failed to update contact');
      }
      const result = await response.json();
      console.log('Contact updated:', result);
      if (result.contacts) {
        setContacts(result.contacts);
        setIsDashboardVisible('contacts'); // Automatically show the contacts dashboard
      }
    } catch (error) {
      console.error('Error updating contact:', error);
      setErrorMessage(error.message);
    }
  };   

  const showForm = (form) => {
    setVisibleForm(form);
    setErrorMessage(''); // Clear any existing error message when switching forms
  };

  const pollStatus = (requestId, onSuccess, onError) => {
    const intervalId = setInterval(async () => {
      try {
        const response = await fetch(`/status/${requestId}`);
        const data = await response.json();
        if (data.status === 'completed') {
          clearInterval(intervalId);
          onSuccess(data);
        } else if (data.status === 'failed') {
          clearInterval(intervalId);
          onError(data);
        }
      } catch (error) {
        console.error('Polling error:', error);
        clearInterval(intervalId);
        onError(error);
      }
    }, 2000);
  };

  const handleTranscriptionResult = (data) => {
    setMessages(prevMessages => {
      const updatedMessages = [...prevMessages];
      const lastMessageIndex = updatedMessages.length - 1;
      if (lastMessageIndex >= 0 && updatedMessages[lastMessageIndex].role === 'Companion' && updatedMessages[lastMessageIndex].audioUrl) {
        updatedMessages[lastMessageIndex].content = data.data.transcription;
      }
      return updatedMessages;
    });
    sendPromptToBackend(data.data.transcription);
  };   

  // Custom function to convert basic Markdown to HTML, this should be improved
  const convertMarkdownToHtml = (markdown) => {
    let html = markdown
      // Convert headers
      .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Convert blockquotes
      .replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>')
      // Convert bold and italic
      .replace(/\*\*\*(.*)\*\*\*/gim, '<b><i>$1</i></b>')
      .replace(/\*\*(.*)\*\*/gim, '<b>$1</b>')
      .replace(/\*(.*)\*/gim, '<i>$1</i>')
      // Convert unordered lists
      .replace(/^\s*\n\*/gm, '<ul>\n*')
      .replace(/^(\*.+)\s*\n([^\*])/gm, '$1\n</ul>\n\n$2')
      .replace(/^\*(.+)/gm, '<li>$1</li>')
      // Convert ordered lists
      .replace(/^\s*\n\d\./gm, '<ol>\n1.')
      .replace(/^(\d\..+)\s*\n([^\d\.])/gm, '$1\n</ol>\n\n$2')
      .replace(/^\d\.(.+)/gm, '<li>$1</li>')
      // Convert links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" target="_blank">$1</a>')
      // Convert images
      .replace(/\!\[([^\]]+)\]\(([^)]+)\)/gim, '<img src="$2" alt="$1" />')
      // Convert tables
      .replace(/^\|(.+)\|\n\|([\s\S]+?)\|$/gm, (match, header, body) => {
        const headerHtml = header.split('|').map(cell => `<th>${cell.trim()}</th>`).join('');
        const bodyHtml = body.split('\n').map(row => {
          return `<tr>${row.split('|').map(cell => `<td>${cell.trim()}</td>`).join('')}</tr>`;
        }).join('');
        return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
      })
      // Convert line breaks
      .replace(/\n/g, '<br />');

    return html.trim();
  };

  const displayPrompt = (prompt) => {
    const newMessage = {
      role: 'Companion',
      content: prompt
    };
    setMessages(prevMessages => [...prevMessages, newMessage]);
    threadContainerRef.current.scrollTop = threadContainerRef.current.scrollHeight;
  };

  const sendPromptToBackend = async (prompt) => {
    try {
      const response = await fetch('/prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: prompt }),
      });
      const data = await response.json();
      if (data.requestId) {
        pollStatus(data.requestId, handleGuideResponse, handleError);
      }
    } catch (error) {
      console.error('Error sending prompt:', error);
    }
  };

  const handleGuideResponse = (data) => {
    if (data.data && data.data.role && data.data.content) {
      const matchedPattern = regexPatterns.find(pattern => {
        const match = data.data.content.match(pattern.regex);
        return match;
      });

      if (matchedPattern) {
        const match = data.data.content.match(matchedPattern.regex);
        const input = match ? (match[0]) : null;

        if (input) {
          let functionName = matchedPattern.functionName;

          try {
            const validJsonString = input.replace(/'/g, '"');
            const parsedObject = JSON.parse(validJsonString);
            if (functionName === 'handleSignMessage') {
              const action = parsedObject.intention;
              if (typeof window[functionName] === 'function') {
                console.log("Calling function:", functionName, "with action:", action);
                window[functionName](null, action, wallets);
              } else {
                console.error(`Function ${functionName} not found.`);
              }
            } else if (functionName === 'updateContact') {
              if (typeof window[functionName] === 'function') {
                console.log("Calling function:", functionName, "with input:", parsedObject);
                window[functionName](null, parsedObject);
              } else {
                console.error(`Function ${functionName} not found.`);
              }
            } else if (functionName === 'toggleDashboard') {
              const dashboardType = parsedObject.toggleDashboard;
              if (typeof window[functionName] === 'function') {
                console.log("Calling function:", functionName, "with dashboardType:", dashboardType);
                window[functionName](null, dashboardType);
              } else {
                console.error(`Function ${functionName} not found.`);
              }
            }
          } catch (error) {
            console.error("Failed to parse JSON information:", error);
            setErrorMessage("Failed to parse JSON information");
          }
        }
      } else {
        console.error("No matching pattern found in the content that would trigger a function call. Returning guide response.");
        const newMessage = {
          role: 'Oya Guide',
          content: data.data.content,
          audioUrl: data.data.audioUrl
        };
        setMessages(prevMessages => [...prevMessages, newMessage]);
      }
    } else {
      console.error("Unexpected data structure from backend:", data);
    }
  };

  const fetchTokenPrices = async () => {
    try {
      const response = await fetch('/api/token-prices');
      if (!response.ok) {
        throw new Error('Failed to fetch token prices');
      }
      const data = await response.json();
      const tokenPrices = data.reduce((acc, token) => {
        acc[token.symbol.toLowerCase()] = token.current_price;
        return acc;
      }, {});
      console.log('Fetched Token Prices:', tokenPrices);
      setTokenPrices(tokenPrices);
      return tokenPrices;
    } catch (error) {
      console.error('Error fetching token prices:', error);
      setErrorMessage(error.message);
    }
  };  

  const toggleDashboard = async (e, dashboardType) => {
    if (e) e.preventDefault();
    setIsDashboardVisible(dashboardType);
    const thanks = "Thank you, I can see my " + dashboardType + " dashboard now.";
    displayPrompt(thanks);
    sendPromptToBackend(thanks);
  
    if (dashboardType === 'balance' || dashboardType === 'rewards') {
      try {
        const response = await fetch(`/api/balance/${wallets[0].address}`);
        if (!response.ok) {
          throw new Error('Failed to fetch balance');
        }
        const data = await response.json();
        const tokenPrices = await fetchTokenPrices();
  
        console.log('Balances:', data);
        console.log('Token Prices:', tokenPrices);
  
        if (!data.length) {
          console.log('No balances found');
          return;
        }
  
        const updatedBalance = data.map(bal => {
          const tokenSymbol = tokenAddressToSymbol[bal.token];
          if (!tokenSymbol) {
            console.error('Missing token symbol for:', bal.token);
            return { ...bal, usdValue: 0 };
          }
  
          let tokenPrice = tokenPrices[tokenSymbol];
          if (!tokenPrice) {
            if (tokenSymbol === 'usdc') {
              tokenPrice = 1; // USDC is pegged to USD
            } else if (tokenSymbol === 'oya') {
              tokenPrice = 1.337; // OYA test tokens set to a value of $1.33
            } else {
              console.error('Missing token price for:', tokenSymbol);
              return { ...bal, usdValue: 0 };
            }
          }
  
          const usdValue = (bal.balance / Math.pow(10, tokenDecimalMap[bal.token] || 18)) * tokenPrice;
  
          console.log('Token:', tokenSymbol, 'Price:', tokenPrice, 'Balance:', bal.balance, 'USD Value:', usdValue);
  
          return {
            ...bal,
            tokenPrice,
            usdValue
          };
        });
  
        console.log('Updated Balance:', updatedBalance);
        setBalance(updatedBalance);
      } catch (error) {
        console.error('Error fetching balance:', error);
        setErrorMessage(error.message);
      }
    }
  };

  const handleError = (error) => {
    console.error("Polling error or processing error: ", error);
  };

  return (
    <div className={styles.container}>
      <Head>
        <title>Sensei</title>
        <link rel="stylesheet" href="/style.css" />
      </Head>

      {!authenticated ? (
        <div className={styles.loginContainer}>
          <button type="button" disabled={!ready || (ready && authenticated)} onClick={handlePrivyLogin}>
            Log in with Privy
          </button>
        </div>
      ) : (
        <div className={isDashboardVisible ? styles.mainContentWithDashboard : styles.mainContent}>

          <div id="threadContainer" ref={threadContainerRef}>
            {messages.map((message, index) => (
              <div key={index} className={styles.chatBox}>
                <div className={styles.chatRole}>{message.role}</div>
                <div className={styles.chatContent} dangerouslySetInnerHTML={{ __html: convertMarkdownToHtml(message.content) }}></div>
                {message.audioUrl && <audio src={message.audioUrl} controls />}
              </div>
            ))}
          </div>

          {errorMessage && <p className={styles.errorMessage}>{errorMessage}</p>}

          <div id="audioRecordingSection">
            <h3>Record your prompt</h3>
            <button type="button" onClick={handleStartRecording} disabled={isRecording}>Start Recording</button>
            <button type="button" onClick={handleStopRecording} disabled={!isRecording}>Stop Recording</button>
          </div>

          <form id="chatForm" className={visibleForm === 'chat' ? '' : styles.hidden} onSubmit={handleSubmitPrompt}>
            <label htmlFor="prompt">Enter your prompt:</label>
            <textarea id="prompt" name="prompt" rows="10" cols="60" value={prompt} onChange={(e) => setPrompt(e.target.value)}></textarea>
            <button type="submit">Send</button>
          </form>

          <form id="registerForm" className={visibleForm === 'register' ? '' : styles.hidden} onSubmit={handleRegister}>
            <label htmlFor="username">Username:</label>
            <input type="text" id="registerUsername" name="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            <label htmlFor="password">Password:</label>
            <input type="password" id="registerPassword" name="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit">Register</button>
          </form>

          <form id="loginForm" className={visibleForm === 'login' ? '' : styles.hidden} onSubmit={handleLogin}>
            <label htmlFor="username">Username:</label>
            <input type="text" id="loginUsername" name="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            <label htmlFor="password">Password:</label>
            <input type="password" id="loginPassword" name="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit">Log in</button>
          </form>

          <button type="button" onClick={() => showForm('chat')}>Show Chat Form</button>
          <button type="button" disabled={!ready || (ready && authenticated)} onClick={handlePrivyLogin}>Log in with Privy</button>
          <button type="button" disabled={!ready || (ready && !authenticated)} onClick={handlePrivyLogout}>Log out with Privy</button>
          <button type="button" onClick={() => showForm('chat')}>Vibe Check</button>
        </div>
      )}

      {isDashboardVisible && authenticated && (
        <div className={styles.dashboard}>
          {isDashboardVisible === 'contacts' && (
            <div>
              <h3>Contacts Dashboard</h3>
              <ul>
                {Object.keys(contacts).map(contact => (
                  <li key={contact}>{contact}: {contacts[contact]}</li>
                ))}
              </ul>
            </div>
          )}
          {isDashboardVisible === 'intentions' && (
            <div>
              <h3>Intentions Dashboard</h3>
              <div className={styles.intentionsContainer}>
                <ul>
                  {intentions.map((intention, index) => (
                    <li key={index}>
                      <strong>Intention:</strong><br></br>
                      <pre className={styles.intentionMessage}>{JSON.stringify(intention.message, null, 2)}</pre>
                      <br />
                      <strong>Status:</strong> {intention.status}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {isDashboardVisible === 'balance' && (
            <div>
              <h3>Balance Dashboard</h3>
              {balance.length > 0 ? (
                <div>
                  <div className={styles.totalPortfolioValue}>
                    <strong>Total Portfolio Value:</strong> $
                    {balance.reduce((acc, bal) => acc + (bal.usdValue || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  {balance.map((bal, index) => (
                    <div key={index} className={styles.balanceItem}>
                      <strong>Token:</strong> {tokenNameMap[bal.token] || bal.token}<br />
                      <strong>Quantity:</strong> {formatBalance(bal.balance, tokenDecimalMap[bal.token] || 18)}<br />
                      <strong>Token Price:</strong> ${bal.tokenPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<br />
                      <strong>USD Value:</strong> ${bal.usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  ))}
                </div>
              ) : (
                <p>No balance data available.</p>
              )}
            </div>
          )}
          {isDashboardVisible === 'goals' && <div>Goals Dashboard</div>}
          {isDashboardVisible === 'rewards' && (
            <div>
              <h3>Rewards Dashboard</h3>
              {balance.length > 0 && balance.find(bal => bal.token === "0x0000000000000000000000000000000000000001") ? (
                <div className={styles.balanceItem}>
                  {balance.map((bal, index) => (
                    bal.token === "0x0000000000000000000000000000000000000001" && (
                      <div key={index}>
                        <strong>Oya Token Balance:</strong> {formatBalance(bal.balance, tokenDecimalMap[bal.token] || 18)}<br />
                        <strong>Oya Token USD Value:</strong> ${bal.usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    )
                  ))}
                </div>
              ) : (
                <p>No Oya token balance data available.</p>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
};

export default Home;
