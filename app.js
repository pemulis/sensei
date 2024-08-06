// Environment configuration
require('dotenv').config();

// Core modules
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// External dependencies
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

// Application-specific imports
const sensei = require('./sensei.json');

// Placeholder variable for the full system prompt, constructed later
let fullInstructions;

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Next.js
const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

async function initializeFullInstructions() {
  let contactsString = '';
  try {
    const contactsResult = await pool.query('SELECT contact, address FROM contacts');
    const contacts = contactsResult.rows;
    const contactDetailsObject = contacts.reduce((acc, contact) => {
      acc[contact.contact] = contact.address;
      return acc;
    }, {});

    contactsString = JSON.stringify(contactDetailsObject);
  } catch (err) {
    console.error('Error fetching contacts from database:', err);
  }

  if (sensei.systemPromptPersonal && sensei.systemPromptFunctional) {
    if (sensei.guides) {
      // Create an object with guide names as keys and descriptions as values
      const guideDetailsObject = sensei.guides.reduce((acc, guide) => {
        acc[guide.name] = guide.description;
        return acc;
      }, {});

      // Stringify the guideDetailsObject
      const guideDetailsString = JSON.stringify(guideDetailsObject);

      fullInstructions = `${sensei.systemPromptPersonal} ${sensei.systemPromptFunctional} These are the specialized guides available to you through the callGuide function: ${guideDetailsString}. Here are the contacts and their Ethereum addresses: ${contactsString}`;
    } else {
      fullInstructions = `${sensei.systemPrompt} ${sensei.systemPromptFunctional} Here are the contacts and their Ethereum addresses: ${contactsString}`;
    }
  }
}

async function main() {
  await initializeFullInstructions();

  nextApp.prepare().then(() => {
    // Express application setup
    const app = express();

    // Middleware setup
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static('public'));
    app.use('/audio', express.static(path.join(__dirname, 'audio')));

    // Session configuration
    app.use(session({
      store: new pgSession({
        pool: pool, // Use the pool for session storage
        tableName: 'session' // Define a custom table for session storage
      }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: true,
      cookie: { secure: process.env.NODE_ENV === 'production' }
    }));

    // Trust the first proxy
    app.set('trust proxy', 1);

    // File upload configuration
    const upload = multer({ dest: 'uploads/' });

    // OpenAI client setup
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Global variables
    let functions = {}; // Will store function modules
    let vectorStore = null; // Will store the vector store for file search

    function initializeSessionVariables(session) {
      if (!session.companion) session.companion = null;
      if (!session.messages) session.messages = [];
      if (!session.guide) session.guide = '';
      if (!session.thread) session.thread = '';
      if (!session.requestQueue) session.requestQueue = {};
      console.log("session variables initialized");
    }

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
        console.log("functions initialized:", functions);
      } catch (err) {
        console.error('Error loading functions into session:', err);
      }

      console.log("function definitions:", functionDefinitions);
      return functionDefinitions;
    }

    async function saveMessage(role, content, guide = null, companion = null, thread = null) {
      const insertQuery = `INSERT INTO messages (role, content, guide, companion, thread, created_at) VALUES ($1, $2, $3, $4, $5, NOW())`;
      try {
        await pool.query(insertQuery, [role, content, guide, companion, thread]);
        console.log("message role:", role);
        console.log("message content:", content);
      } catch (err) {
        console.error('Error saving message to database:', err);
      }
    }

    async function respond(prompt, requestId, target, session) {
      initializeSessionVariables(session);

      try {
        let result;

        if (target === "chat") {
          result = await callChat(session.messages, prompt);
        }

        if (target === "assistant") {
          const {
            returnValue,
            guide: updatedGuide,
            thread: updatedThread
          } = await callAssistant(prompt, session);

          if (updatedGuide) session.guide = updatedGuide;
          if (updatedThread) session.thread = updatedThread;
          result = returnValue;
          console.log("result before audio conversion:", result);
        }

        // Call OpenAI's TTS API
        const ttsResponse = await openai.audio.speech.create({
          model: "tts-1-hd",
          voice: "nova",
          input: result.content,
        });

        const audioUrl = await handleTTSResponse(ttsResponse, requestId);
        result.audioUrl = audioUrl;
        console.log("result after audio conversion:", result);

        session.requestQueue[requestId] = { status: 'completed', data: result };
      } catch (error) {
        session.requestQueue[requestId] = { status: 'failed', data: error.message };
      }
    }

    async function handleTTSResponse(ttsResponse, requestId) {
      const audioDirPath = path.join(__dirname, 'audio');
      const audioFilePath = path.join(audioDirPath, `${requestId}.mp3`);

      // Ensure the directory exists
      await fs.promises.mkdir(audioDirPath, { recursive: true });

      // Convert the TTS response to a Buffer
      const buffer = Buffer.from(await ttsResponse.arrayBuffer());

      // Write the buffer to a file asynchronously
      await fs.promises.writeFile(audioFilePath, buffer);

      // Return a URL or a relative path that can be accessed by the client
      return `/audio/${requestId}.mp3`;
    }

    async function uploadFiles() {
      const filesDir = path.join(__dirname, 'files');
      const retryDelay = 1000; // Delay in milliseconds
      const maxRetries = 5; // Maximum number of retries
      let retries = 0;
    
      // Ensure the directory exists
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
            return []; // Return an empty array if no files were uploaded
          }
    
          // Create a vector store for file search
          vectorStore = await openai.beta.vectorStores.create({
            name: "Files", // Replace with your vector store name
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
            throw error; // Rethrow the last error encountered
          }
        }
      }
    }    

    async function callChat(messages, prompt) {
      messages.push({
        role: 'user', // have to call companion user for openai api
        content: prompt,
      });
      saveMessage('companion', prompt);

      const response = await openai.chat.completions.create({
        model: sensei.model,
        messages,
      });

      returnValue = response.choices[0].message;

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
        
        // If no files are uploaded, skip file_search tool
        const tools = [...functionDefinitions,
          { type: "code_interpreter" }];
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
        console.log("local guide created");
        session.guide = localGuide;
      }

      if (!localThread) {
        localThread = await openai.beta.threads.create();
        session.thread = localThread;
        console.log("local thread created");
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

      console.log("run created:", run);

      let runId = run.id;

      while (run.status !== "completed") {
        console.log("run id:", run.id);
        console.log("run status:", run.status);
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
            // Need to help the root guide get correct names for other guides here...
            let functionArguments = Object.values(JSON.parse(tool_call.function.arguments));
            let response;
            if (Object.prototype.hasOwnProperty.call(functions, functionName)) {
              response = await functions[functionName](...functionArguments);
            } else {
              response = 'We had an issue calling an external function.'
            }
            console.log("function response:", response);
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
            console.log("submitted tool outputs");
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
          .toFormat('mp3') // Convert to mp3 or another supported format
          .on('error', (err) => {
            console.error('An error occurred: ' + err.message);
            reject(err);
          })
          .on('end', () => {
            console.log('Processing finished !');
            resolve(outputPath);
          })
          .save(outputPath);
      });
    };

    async function processAudioInBackground(filePath, convertedFilePath, requestId, session) {
      try {
        // Convert the audio file format (this function needs to return a promise)
        await convertAudioFormat(filePath, convertedFilePath);

        // Transcribe the audio file
        const transcriptionResponse = await openai.audio.transcriptions.create({
          file: fs.createReadStream(convertedFilePath),
          model: "whisper-1",
        });

        // Log and sanitize the transcription
        console.log("Audio transcript:", transcriptionResponse.text);
        const sanitizedTranscript = sanitizeHtml(transcriptionResponse.text, {
          allowedTags: [],
          allowedAttributes: {},
        });

        // Update the session's requestQueue with the transcription data
        session.requestQueue[requestId] = { status: 'completed', data: { transcription: sanitizedTranscript } };

        // Since this is an async function, returning here resolves the promise
        return;
      } catch (error) {
        console.error('Error processing audio:', error);
        // Update the session's requestQueue to reflect the error
        session.requestQueue[requestId] = { status: 'failed', data: error.message };
        // Re-throw the error to be caught by the caller
        throw error;
      } finally {
        // Clean up: delete the original and converted files regardless of success or failure
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
      initializeSessionVariables(req.session);

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      if (!req.session.companion && req.session.companionId) {
        req.session.companion = req.session.companionId;
      } else if (!req.session.companion) {
        // If companion is not logged in, use the session ID as a pseudo-identifier for the companion
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

    app.get('/status/:requestId', (req, res) => {
      initializeSessionVariables(req.session);

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

    app.post('/register', [
      body('name').trim().escape(),
      body('password').trim(),
    ], async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, password } = req.body;
      const hashedpassword = await bcrypt.hash(password, 10);

      try {
        await pool.query(
          "INSERT INTO companions (name, hashedpassword, created_at) VALUES ($1, $2, NOW())",
          [name, hashedpassword]
        );
        res.status(201).json({ message: "Companion registered successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post('/login', [
      body('name').trim().escape(),
      body('password').trim(),
    ], async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, password } = req.body;

      try {
        const result = await pool.query("SELECT * FROM companions WHERE name = $1", [name]);
        if (result.rows.length > 0) {
          const foundCompanion = result.rows[0];
          const match = await bcrypt.compare(password, foundCompanion.hashedpassword);
          if (match) {
            req.session.companionId = foundCompanion.id;
            res.send({ message: "Logged in successfully" });
          } else {
            res.status(401).send("Password is incorrect");
          }
        } else {
          res.status(404).send("Companion not found");
        }
      } catch (error) {
        console.error(error);
        res.status(500).send("Server error");
      }
    });

    app.post('/upload-audio', upload.single('audioFile'), (req, res) => {
      const filePath = req.file.path;
      const convertedFilePath = `${filePath}.mp3`; // Define the output file path
      const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);

      // Initialize session variables and add to the request queue as 'processing'
      initializeSessionVariables(req.session);
      req.session.requestQueue[requestId] = { status: 'processing', data: null };

      // Immediately respond with the requestId for status checking
      res.json({ requestId });

      // Process audio in the background and save session afterwards
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
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
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

    app.post('/api/update-contact', async (req, res) => {
      const { contact, address } = req.body; // Destructure contact and address directly from req.body
    
      if (!contact || !address) {
        return res.status(400).json({ message: 'Contact and address are required' });
      }
    
      try {
        // Check if the contact name already exists
        const existingContact = await pool.query("SELECT * FROM contacts WHERE contact = $1", [contact]);
        
        if (existingContact.rows.length > 0) {
          // If contact name exists, update the address
          console.log("Trying to update contact...");
          const result = await pool.query(
            "UPDATE contacts SET address = $2 WHERE contact = $1 RETURNING *",
            [contact, address]
          );
        } else {
          // If contact name does not exist, insert a new contact
          console.log("Trying to create new contact...");
          const result = await pool.query(
            "INSERT INTO contacts (contact, address) VALUES ($1, $2) RETURNING *",
            [contact, address]
          );
        }

        // Re-initialize full instructions
        await initializeFullInstructions();

        // Fetch the updated list of contacts
        const contactsResult = await pool.query('SELECT contact, address FROM contacts');
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

    app.get('/api/system-prompt', (req, res) => {
      if (fullInstructions) {
        res.status(200).json({ prompt: fullInstructions });
      } else {
        res.status(500).json({ error: 'System prompt not available' });
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
    
      if (!address) {
        return res.status(400).json({ message: 'Address is required' });
      }
    
      try {
        const apiUrl = `${process.env.OYA_API_SERVER}/nonce/${address}`;
        console.log(`Posting nonce to: ${apiUrl}`);
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ nonce: 0 })
        });
        
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
            'x-cg-demo-api-key': process.env.COINGECKO_API_KEY // Ensure this matches your API key header
          }
        });
        res.status(200).json(response.data);
      } catch (error) {
        console.error('Error fetching token prices:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error fetching token prices' });
      }
    });

    // All other routes handled by Next.js
    app.get('*', (req, res) => {
      return handle(req, res);
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  });
}

main().catch(err => {
  console.error('Error initializing application:', err);
});
