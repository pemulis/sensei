require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require("openai");
const next = require('next');
const sensei = require('./sensei.json');

let fullInstructions;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

const initializeFullInstructions = async (session) => {
  let contactsString = '';
  try {
    const contactsResult = await pool.query('SELECT contact, address FROM contacts WHERE companion = $1', [session.companion]);
    const contacts = contactsResult.rows;
    const contactDetailsObject = contacts.reduce((acc, contact) => {
      acc[contact.contact] = contact.address;
      return acc;
    }, {});
    contactsString = JSON.stringify(contactDetailsObject);
  } catch (err) {
    console.error('Error fetching contacts from database:', err);
  }

  let personalPrompt = '';
  try {
    const promptResult = await pool.query('SELECT prompt FROM prompts WHERE companion = $1', [session.companion]);
    if (promptResult.rows.length > 0) {
      personalPrompt = promptResult.rows[0].prompt;
    } else if (sensei.systemPromptPersonal) {
      personalPrompt = sensei.systemPromptPersonal;
    }
  } catch (err) {
    console.error('Error fetching personal prompt from database:', err);
  }

  let guideDetailsString = '';
  if (sensei.guides) {
    const guideDetailsObject = sensei.guides.reduce((acc, guide) => {
      acc[guide.name] = guide.description;
      return acc;
    }, {});
    guideDetailsString = JSON.stringify(guideDetailsObject);
  }

  // Construct fullInstructions ensuring no part is repeated
  fullInstructions = `${sensei.systemPromptFunctional}`;

  if (personalPrompt && !fullInstructions.includes(personalPrompt)) {
    fullInstructions += ` ${personalPrompt}`;
  }

  if (guideDetailsString && !fullInstructions.includes(guideDetailsString)) {
    fullInstructions += ` Here are the specialized guides available to you through the callGuide function: ${guideDetailsString}.`;
  }

  if (contactsString && !fullInstructions.includes(contactsString)) {
    fullInstructions += ` Here are the contacts and their Ethereum addresses: ${contactsString}.`;
  }
};

async function initializeSessionVariables(req) {
  const session = req.session;
  if (!session.companion) session.companion = session.companionId || null;
  if (!session.messages) session.messages = [];
  if (!session.guide) session.guide = '';
  if (!session.thread) session.thread = '';
  if (!session.requestQueue) session.requestQueue = {};
  console.log("session variables initialized");

  if (session.companion) {
    await initializeFullInstructions(session);
  }
}

async function main() {
  await nextApp.prepare();
  const app = express();

  // Middleware to redirect HTTP to HTTPS
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static('public'));
  app.use('/audio', express.static(path.join(__dirname, 'audio')));

  app.use(session({
    store: new pgSession({
      pool: pool,
      tableName: 'session'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
  }));

  app.set('trust proxy', 1);

  const upload = multer({ dest: 'uploads/' });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let functions = {};
  let vectorStore = null;

  async function initializeFunctions(session) {
    const functionsDir = path.join(__dirname, 'functions');
    const functionDefinitions = [];
    try {
      const files = await fs.promises.readdir(functionsDir);
      for (const file of files) {
        if (path.extname(file) === '.js') {
          const moduleName = path.basename(file, '.js');
          functions[moduleName] = require(path.join(functionsDir, file));
        } else if (path.extname(file) === '.json') {
          const definition = JSON.parse(await fs.promises.readFile(path.join(functionsDir, file), 'utf8'));
          functionDefinitions.push({
            type: "function",
            function: definition
          });
        }
      }
      console.log("Functions initialized:", functions);
    } catch (err) {
      console.error('Error loading functions into session:', err);
    }
    console.log("Function definitions:", functionDefinitions);
    return functionDefinitions;
  }

  async function saveMessage(role, content, guide = null, companion = null, thread = null) {
    const insertQuery = `INSERT INTO messages (role, content, guide, companion, thread, created_at) VALUES ($1, $2, $3, $4, $5, NOW())`;
    try {
      await pool.query(insertQuery, [role, content, guide, companion, thread]);
      console.log("Message role:", role);
      console.log("Message content:", content);
    } catch (err) {
      console.error('Error saving message to database:', err);
    }
  }

  async function respond(prompt, requestId, target, session) {
    await initializeSessionVariables({ session });

    try {
      let result;
      if (target === "chat") {
        result = await callChat(session.messages, prompt);
      }
      if (target === "assistant") {
        const { returnValue, guide: updatedGuide, thread: updatedThread } = await callAssistant(prompt, session);
        if (updatedGuide) session.guide = updatedGuide;
        if (updatedThread) session.thread = updatedThread;
        result = returnValue;
        console.log("Result before audio conversion:", result);
      }
      const ttsResponse = await openai.audio.speech.create({
        model: "tts-1-hd",
        voice: "nova",
        input: result.content,
      });
      const audioUrl = await handleTTSResponse(ttsResponse, requestId);
      result.audioUrl = audioUrl;
      console.log("Result after audio conversion:", result);
      session.requestQueue[requestId] = { status: 'completed', data: result };
    } catch (error) {
      session.requestQueue[requestId] = { status: 'failed', data: error.message };
    }
  }

  async function handleTTSResponse(ttsResponse, requestId) {
    const audioDirPath = path.join(__dirname, 'audio');
    const audioFilePath = path.join(audioDirPath, `${requestId}.mp3`);
    await fs.promises.mkdir(audioDirPath, { recursive: true });
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    await fs.promises.writeFile(audioFilePath, buffer);
    return `/audio/${requestId}.mp3`;
  }

  async function uploadFiles() {
    const filesDir = path.join(__dirname, 'files');
    const retryDelay = 1000;
    const maxRetries = 5;
    let retries = 0;
    try {
      await fs.promises.mkdir(filesDir, { recursive: true });
    } catch (err) {
      console.error("Error creating files directory:", err);
      throw err;
    }
    while (retries < maxRetries) {
      try {
        const files = await fs.promises.readdir(filesDir);
        const fileIds = [];
        for (const fileName of files) {
          const filePath = path.join(filesDir, fileName);
          const fileStream = fs.createReadStream(filePath);
          const file = await openai.files.create({
            file: fileStream,
            purpose: 'assistants',
          });
          fileIds.push(file.id);
        }
        if (fileIds.length === 0) {
          console.log("No files were uploaded.");
          return [];
        }
        vectorStore = await openai.beta.vectorStores.create({
          name: "Files",
          file_ids: fileIds
        });
        return fileIds;
      } catch (error) {
        console.error("Error uploading files, attempt #" + (retries + 1), error);
        retries++;
        if (retries < maxRetries) {
          console.log(`Retrying in ${retryDelay / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          console.error("Failed to upload files after retries.");
          throw error;
        }
      }
    }
  }

  async function callChat(messages, prompt) {
    messages.push({
      role: 'user',
      content: prompt,
    });
    saveMessage('companion', prompt);
    const response = await openai.chat.completions.create({
      model: sensei.model,
      messages,
    });
    const returnValue = response.choices[0].message;
    saveMessage('guide', returnValue.content);
    return returnValue;
  }

  async function callAssistant(prompt, session) {
    let { messages, guide, thread, companion } = session;
    messages.push({
      role: 'companion',
      content: prompt,
    });
    function delay(time) {
      return new Promise(resolve => setTimeout(resolve, time));
    }
    let localGuide = guide;
    let localThread = thread;
    if (!localGuide) {
      const functionDefinitions = await initializeFunctions(session);
      const fileIds = await uploadFiles();
      const tools = [...functionDefinitions, { type: "code_interpreter" }];
      if (fileIds.length > 0) {
        tools.push({ type: "file_search" });
      }
      localGuide = await openai.beta.assistants.create({
        name: sensei.branch,
        instructions: fullInstructions,
        tools: tools,
        model: sensei.model,
        tool_resources: fileIds.length > 0 ? {
          "file_search": {
            vector_store_ids: [vectorStore.id]
          },
          "code_interpreter": {
            "file_ids": fileIds
          }
        } : {
          "code_interpreter": {
            "file_ids": fileIds
          }
        },
        description: sensei.description,
        metadata: sensei.metadata,
        temperature: sensei.temperature,
        top_p: sensei.top_p,
        response_format: sensei.response_format
      });
      console.log("Local guide created");
      session.guide = localGuide;
    }
    if (!localThread) {
      localThread = await openai.beta.threads.create();
      session.thread = localThread;
      console.log("Local thread created");
    }
    saveMessage('companion', prompt, localGuide.id, companion, localThread.id);
    await openai.beta.threads.messages.create(
      localThread.id,
      {
        role: "user",
        content: prompt
      }
    );
    let run = await openai.beta.threads.runs.create(
      localThread.id,
      {
        assistant_id: localGuide.id,
      }
    );
    console.log("Run created:", run);
    let runId = run.id;
    while (run.status !== "completed") {
      console.log("Run id:", run.id);
      console.log("Run status:", run.status);
      await delay(2000);
      run = await openai.beta.threads.runs.retrieve(localThread.id, runId);
      if (run.status === "failed") {
        console.log("Run failed:", run);
      }
      if (run.status === "requires_action") {
        let tools_outputs = [];
        let tool_calls = run.required_action.submit_tool_outputs.tool_calls;
        for (let tool_call of tool_calls) {
          let functionName = tool_call.function.name;
          let functionArguments = Object.values(JSON.parse(tool_call.function.arguments));
          let response;
          if (Object.prototype.hasOwnProperty.call(functions, functionName)) {
            response = await functions[functionName](...functionArguments);
          } else {
            response = 'We had an issue calling an external function.'
          }
          console.log("Function response:", response);
          tools_outputs.push(
            {
              tool_call_id: tool_call.id,
              output: JSON.stringify(response)
            }
          );
        }
        try {
          run = await openai.beta.threads.runs.submitToolOutputs(
            localThread.id,
            runId,
            {
              tool_outputs: tools_outputs
            }
          );
          console.log("Submitted tool outputs");
        } catch (error) {
          console.error("Error submitting tool outputs:", error);
        }
      }
    }
    let originalMessageLength = messages.length;
    let completedThread = await openai.beta.threads.messages.list(localThread.id);
    let newMessages = completedThread.data.slice();
    for (let message of newMessages) {
      messages.push(message.content[0]);
    }
    messages = messages.slice(originalMessageLength);
    let guideMessage = messages[0].text.value;
    saveMessage('guide', guideMessage, localGuide.id, companion, localThread.id);
    let returnValue = {
      role: 'guide',
      content: guideMessage
    };
    return {
      returnValue,
      guide: localGuide,
      thread: localThread
    };
  }

  const convertAudioFormat = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .toFormat('mp3')
        .on('error', (err) => {
          console.error('An error occurred: ' + err.message);
          reject(err);
        })
        .on('end', () => {
          console.log('Processing finished!');
          resolve(outputPath);
        })
        .save(outputPath);
    });
  };

  async function processAudioInBackground(filePath, convertedFilePath, requestId, session) {
    try {
      await convertAudioFormat(filePath, convertedFilePath);
      const transcriptionResponse = await openai.audio.transcriptions.create({
        file: fs.createReadStream(convertedFilePath),
        model: "whisper-1",
      });
      console.log("Audio transcript:", transcriptionResponse.text);
      const sanitizedTranscript = sanitizeHtml(transcriptionResponse.text, {
        allowedTags: [],
        allowedAttributes: {},
      });
      session.requestQueue[requestId] = { status: 'completed', data: { transcription: sanitizedTranscript } };
      return;
    } catch (error) {
      console.error('Error processing audio:', error);
      session.requestQueue[requestId] = { status: 'failed', data: error.message };
      throw error;
    } finally {
      try {
        await fs.promises.unlink(filePath);
        await fs.promises.unlink(convertedFilePath);
      } catch (cleanupError) {
        console.error('Error cleaning up files:', cleanupError);
      }
    }
  }

  app.post('/prompt', [
    body('prompt').not().isEmpty().withMessage('Prompt is required'),
    body('prompt').trim().escape(),
  ], async (req, res) => {
    await initializeSessionVariables(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!req.session.companion && req.session.companionId) {
      req.session.companion = req.session.companionId;
    } else if (!req.session.companion) {
      req.session.companion = req.sessionID;
    }

    const sanitizedPrompt = sanitizeHtml(req.body.prompt, {
      allowedTags: [],
      allowedAttributes: {},
    });

    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    req.session.requestQueue[requestId] = { status: 'processing', data: null };

    respond(sanitizedPrompt, requestId, sensei.target, req.session).then(() => {
      req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err);
        }
      });
    });

    res.json({ requestId });
  });

  app.get('/status/:requestId', async (req, res) => {
    await initializeSessionVariables(req);
    const { requestId } = req.params;
    let { requestQueue } = req.session;

    if (requestQueue[requestId]) {
      const { status, data } = requestQueue[requestId];
      if (status === 'completed' || status === 'failed') {
        delete requestQueue[requestId];
        req.session.requestQueue = requestQueue;
      }
      res.json({ status, data });
    } else {
      res.status(404).send({ message: 'Request not found' });
    }
  });

  app.post('/upload-audio', upload.single('audioFile'), async (req, res) => {
    const filePath = req.file.path;
    const convertedFilePath = `${filePath}.mp3`;
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    await initializeSessionVariables(req);
    req.session.requestQueue[requestId] = { status: 'processing', data: null };
    res.json({ requestId });

    processAudioInBackground(filePath, convertedFilePath, requestId, req.session)
      .then(() => {
        req.session.save(err => {
          if (err) {
            console.error('Session save error:', err);
          }
        });
      })
      .catch(error => {
        console.error('Error processing audio: ', error);
      });
  });

  app.post('/api/send-signed-intention', async (req, res) => {
    const { intention, signature, from } = req.body;
    const server = process.env.BUNDLER_SERVER;

    if (!server) {
      console.error('Bundler server URL not configured');
      return res.status(500).json({ error: 'Bundler server URL not configured' });
    }

    const sendIntention = async (retryCount = 5) => {
      try {
        const response = await fetch(`${server}/intention`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ intention, signature, from }),
        });

        if (!response.ok) {
          throw new Error(`Failed to send intention to bundler server: ${response.statusText}`);
        }

        return await response.json();
      } catch (error) {
        if (retryCount === 0) {
          throw error;
        }
        console.log(`Retrying... Attempts left: ${retryCount}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return sendIntention(retryCount - 1);
      }
    };

    try {
      const result = await sendIntention();
      res.status(200).json(result);
    } catch (error) {
      console.error('Error sending signed intention:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/contacts', async (req, res) => {
    if (!req.session.companion) {
      return res.status(403).json({ message: 'User not authenticated' });
    }

    try {
      const contactsResult = await pool.query('SELECT contact, address FROM contacts WHERE companion = $1', [req.session.companion]);
      const contacts = contactsResult.rows.reduce((acc, contact) => {
        acc[contact.contact] = contact.address;
        return acc;
      }, {});

      res.status(200).json({ message: 'Contacts retrieved', contacts });
    } catch (error) {
      console.error('Error fetching contacts:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

  app.post('/api/update-contact', async (req, res) => {
    const { contact, address } = req.body;

    if (!contact || !address) {
      return res.status(400).json({ message: 'Contact and address are required' });
    }

    if (!req.session.companion) {
      return res.status(403).json({ message: 'User not authenticated' });
    }

    try {
      const existingContact = await pool.query("SELECT * FROM contacts WHERE contact = $1 AND companion = $2", [contact, req.session.companion]);

      if (existingContact.rows.length > 0) {
        console.log("Trying to update contact...");
        await pool.query(
          "UPDATE contacts SET address = $2 WHERE contact = $1 AND companion = $3 RETURNING *",
          [contact, address, req.session.companion]
        );
      } else {
        console.log("Trying to create new contact...");
        await pool.query(
          "INSERT INTO contacts (contact, address, companion) VALUES ($1, $2, $3) RETURNING *",
          [contact, address, req.session.companion]
        );
      }

      await initializeFullInstructions(req.session);

      const contactsResult = await pool.query('SELECT contact, address FROM contacts WHERE companion = $1', [req.session.companion]);
      const contacts = contactsResult.rows.reduce((acc, contact) => {
        acc[contact.contact] = contact.address;
        return acc;
      }, {});

      res.status(200).json({ message: 'Contact updated', contacts });
    } catch (error) {
      console.error('Error updating contact:', error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get('/api/system-prompt', async (req, res) => {
    if (!req.session.companion) {
      return res.status(403).json({ message: 'User not authenticated' });
    }
  
    try {
      await initializeFullInstructions(req.session);
      res.status(200).json({ prompt: fullInstructions });
    } catch (error) {
      res.status(500).json({ error: 'System prompt not available' });
    }
  });  

  app.post('/api/system-prompt', async (req, res) => {
    const { prompt } = req.body;
  
    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
    }
  
    if (!req.session.companion) {
      return res.status(403).json({ message: 'User not authenticated' });
    }
  
    try {
      await pool.query(
        'INSERT INTO prompts (companion, prompt) VALUES ($1, $2) ON CONFLICT (companion) DO UPDATE SET prompt = $2',
        [req.session.companion, prompt]
      );
  
      // Reinitialize the full instructions with the updated prompt
      await initializeFullInstructions(req.session);
  
      res.status(200).json({ message: 'System prompt updated', prompt: fullInstructions });
    } catch (error) {
      console.error('Error updating system prompt:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });  

  app.get('/api/balance/:address', async (req, res) => {
    const { address } = req.params;
    if (!address) {
      return res.status(400).json({ message: 'Address is required' });
    }
    try {
      const response = await fetch(`${process.env.OYA_API_SERVER}/balance/${address}`);
      const data = await response.json();
      console.log("Got balances:", data);
      res.status(200).json(data);
    } catch (error) {
      console.error('Error fetching balance:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

  app.get('/api/nonce/:address', async (req, res) => {
    const { address } = req.params;
    if (!address) {
      return res.status(400).json({ message: 'Address is required' });
    }
    try {
      const apiUrl = `${process.env.OYA_API_SERVER}/nonce/${address}`;
      console.log(`Fetching nonce from: ${apiUrl}`);
      const response = await fetch(apiUrl);
      if (response.status === 404) {
        return res.status(404).json({ message: 'Nonce not found' });
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch nonce: ${response.statusText}`);
      }
      const data = await response.json();
      console.log("Got nonce:", data);
      res.status(200).json(data);
    } catch (error) {
      console.error('Error fetching nonce:', error.message);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

  app.post('/api/nonce/:address', async (req, res) => {
    const { address } = req.params;
    const { nonce } = req.body;
    if (!address) {
      return res.status(400).json({ message: 'Address is required' });
    }
    if (nonce === undefined) {
      return res.status(400).json({ message: 'Nonce is required' });
    }
    try {
      const apiUrl = `${process.env.OYA_API_SERVER}/nonce/${address}`;
      console.log(`Posting nonce to: ${apiUrl}`);
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ nonce })
      });
      if (response.status === 404) {
        throw new Error(`Endpoint not found: ${apiUrl}`);
      }
      if (!response.ok) {
        throw new Error(`Failed to post nonce: ${response.statusText}`);
      }
      const data = await response.json();
      console.log("New nonce:", data);
      res.status(200).json(data);
    } catch (error) {
      console.error('Error posting nonce:', error.message);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

  app.get('/api/token-prices', async (req, res) => {
    const tokenIds = 'ethereum,weth,usd-coin,uma';
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(tokenIds)}`;
    try {
      const response = await axios.get(url, {
        headers: {
          'accept': 'application/json',
          'x-cg-demo-api-key': process.env.COINGECKO_API_KEY
        }
      });
      res.status(200).json(response.data);
    } catch (error) {
      console.error('Error fetching token prices:', error.response ? error.response.data : error.message);
      res.status(500).json({ message: 'Error fetching token prices' });
    }
  });

  app.post('/api/privy-login', async (req, res) => {
    const { address } = req.body;
  
    if (!address) {
      return res.status(400).json({ message: 'Address is required' });
    }
  
    try {
      const checkAccount = await pool.query("SELECT * FROM companions WHERE address = $1", [address]);
      if (checkAccount.rows.length > 0) {
        req.session.companionId = checkAccount.rows[0].id;
        req.session.companion = checkAccount.rows[0].id; // Ensure companion is set
        await initializeSessionVariables(req);
        return res.status(200).json({ message: 'Account already exists' });
      }
  
      const result = await pool.query(
        "INSERT INTO companions (address, created_at) VALUES ($1, NOW()) RETURNING *",
        [address]
      );
  
      req.session.companionId = result.rows[0].id;
      req.session.companion = result.rows[0].id; // Ensure companion is set
      await initializeSessionVariables(req);
  
      res.status(201).json({ message: 'Account saved successfully' });
    } catch (error) {
      console.error('Error saving account:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

  app.get('/api/messages', async (req, res) => {
    if (!req.session.companion) {
      return res.status(403).json({ message: 'User not authenticated' });
    }
  
    try {
      const result = await pool.query('SELECT * FROM messages WHERE companion = $1 ORDER BY created_at DESC', [req.session.companion]);
      res.status(200).json(result.rows);
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });  

  app.get('*', (req, res) => {
    return handle(req, res);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

main().catch(err => {
  console.error('Error initializing application:', err);
});