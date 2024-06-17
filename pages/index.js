import React, { useState, useRef } from 'react';
import Head from 'next/head';
import styles from '../styles/Home.module.css';

const Home = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioPromptUrl, setAudioPromptUrl] = useState('');
  const [audioResponseUrl, setAudioResponseUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visibleForm, setVisibleForm] = useState('');
  const audioPromptRef = useRef();
  const audioResponseRef = useRef();
  const threadContainerRef = useRef();
  let recorder, audioStream;

  const handleStartRecording = async () => {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(audioStream);
    let audioChunks = [];

    recorder.ondataavailable = e => {
      audioChunks.push(e.data);
    };

    recorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      setAudioPromptUrl(audioUrl);

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
    setIsRecording(true);
  };

  const handleStopRecording = () => {
    recorder.stop();
    audioStream.getTracks().forEach(track => track.stop());
    setIsRecording(false);
  };

  const handleSubmitPrompt = async (e) => {
    e.preventDefault();
    displayPrompt(prompt);
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
      const data = await response.json();
      console.log('Registration successful', data);
    } catch (error) {
      console.error('Error:', error);
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
      const data = await response.json();
      console.log('Login successful', data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const showForm = (form) => {
    setVisibleForm(visibleForm === form ? '' : form);
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

  const playAudioFromURL = (audioUrl) => {
    setAudioResponseUrl(audioUrl);
    audioResponseRef.current.play().catch(error => {
      console.error('Error playing audio:', error);
    });
  };

  const handleTranscriptionResult = (data) => {
    displayPrompt(data.data.transcription);
    sendPromptToBackend(data.data.transcription);
  };

  const displayPrompt = (prompt) => {
    const promptElement = document.createElement("pre");
    promptElement.classList.add(styles.jsonResponse);
    promptElement.textContent = JSON.stringify({ role: "user", content: prompt }, null, 2);
    threadContainerRef.current.insertBefore(promptElement, threadContainerRef.current.firstChild);
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
      displayTextResponse(data.data.content);
      if (data.data.audioUrl) {
        playAudioFromURL(data.data.audioUrl);
      }
    } else {
      console.error("Unexpected data structure from backend:", data);
    }
  };

  const displayTextResponse = (text) => {
    const responseElement = document.createElement("pre");
    responseElement.classList.add(styles.jsonResponse);
    responseElement.textContent = JSON.stringify({ role: "guide", content: text }, null, 2);
    threadContainerRef.current.insertBefore(responseElement, threadContainerRef.current.firstChild);
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
      <div id="audioRecordingSection">
        <h3>Record your prompt</h3>
        <button type="button" onClick={handleStartRecording} disabled={isRecording}>Start Recording</button>
        <button type="button" onClick={handleStopRecording} disabled={!isRecording}>Stop Recording</button>
        {audioPromptUrl && (
          <audio ref={audioPromptRef} src={audioPromptUrl} controls hidden={!audioPromptUrl} />
        )}
        {audioResponseUrl && (
          <audio ref={audioResponseRef} src={audioResponseUrl} controls hidden={!audioResponseUrl} />
        )}
      </div>

      <br /><br />

      <div id="threadContainer" ref={threadContainerRef}></div>

      <br /><br />

      {visibleForm === 'chat' && (
        <form id="chatForm" onSubmit={handleSubmitPrompt}>
          <label htmlFor="prompt">Enter your prompt:</label>
          <br />
          <textarea id="prompt" name="prompt" rows="10" cols="60" value={prompt} onChange={(e) => setPrompt(e.target.value)}></textarea>
          <br />
          <button type="submit">Send</button>
        </form>
      )}

      {visibleForm === 'register' && (
        <form id="registerForm" onSubmit={handleRegister}>
          <label htmlFor="username">Username:</label>
          <input type="text" id="registerUsername" name="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <label htmlFor="password">Password:</label>
          <input type="password" id="registerPassword" name="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit">Register</button>
        </form>
      )}

      {visibleForm === 'login' && (
        <form id="loginForm" onSubmit={handleLogin}>
          <label htmlFor="username">Username:</label>
          <input type="text" id="loginUsername" name="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <label htmlFor="password">Password:</label>
          <input type="password" id="loginPassword" name="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit">Log in</button>
        </form>
      )}

      <button type="button" onClick={() => showForm('chat')}>Show Chat Form</button>
      <button type="button" onClick={() => showForm('register')}>Show Register Form</button>
      <button type="button" onClick={() => showForm('login')}>Show Login Form</button>
    </div>
  );
};

export default Home;
