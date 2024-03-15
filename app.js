// Environment configuration
require('dotenv').config();

// Core modules
const fs = require('fs');
const path = require('path');

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

// Application-specific imports
const sensei = require('./sensei.json');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
let fullInstructions = ''; // Compiled instructions from 'sensei.json'

if (sensei.systemPrompt) {
  if (sensei.guides) {
    // Create an object with guide names as keys and descriptions as values
    const guideDetailsObject = sensei.guides.reduce((acc, guide) => {
      acc[guide.name] = guide.description;
      return acc;
    }, {});

    // Stringify the guideDetailsObject
    const guideDetailsString = JSON.stringify(guideDetailsObject);

    fullInstructions = sensei.systemPrompt + " These are the specialized guides available to you through the callGuide function: " + guideDetailsString;
    saveMessage('system', fullInstructions);
  } else {
    fullInstructions = sensei.systemPrompt;
    saveMessage('system', fullInstructions);
    console.log("system prompt:", sensei.systemPrompt);
  }
}

function initializeSessionVariables(session) {
  if (!session.companion) session.companion = null;
  if (!session.messages) session.messages = [];
  if (!session.guide) session.guide = '';
  if (!session.thread) session.thread = '';
  if (!session.requestQueue) session.requestQueue = {};
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

function withMessageSaving(originalFunction, threadId) {
  return async function(...args) {
    const response = await originalFunction.apply(this, args);
    
    saveMessage('brian', JSON.stringify(response), null, null, threadId);
    
    return response;
  };
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
      voice: "alloy",
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
  const maxRetries = 3; // Maximum number of retries
  let retries = 0;

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
      }
      return fileIds;
    } catch (error) {
      console.error("Error uploading files, attempt #" + (retries + 1), error);
      retries++;
      if (retries < maxRetries) {
        console.log(`Retrying in ${retryDelay/1000} seconds...`);
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
    localGuide = await openai.beta.assistants.create({
      name: sensei.branch,
      instructions: fullInstructions,
      tools: [...functionDefinitions, { type: "code_interpreter" }, { type: "retrieval" }],
      model: sensei.model,
      file_ids: fileIds
    });
    console.log("local guide created");
    session.guide = localGuide;
  }

  if (!localThread) {
    localThread = await openai.beta.threads.create();
    session.thread = localThread;
    console.log("local thread created");
    saveMessage('system', 'A new thread has been created, with thread ID: ' + localThread.id);
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
        let functionArguments = Object.values(JSON.parse(tool_call.function.arguments));
        let response;
    
        if (Object.prototype.hasOwnProperty.call(functions, functionName)) {
          // Declare targetFunction here to ensure it's defined
          let targetFunction = functions[functionName];
    
          if (functionName === "callBrianAPI") {
            // Wrap the function if it's callBrianAPI
            targetFunction = withMessageSaving(functions[functionName], localThread.id);
            // Await the response from the wrapped function
            response = await targetFunction(...functionArguments);
          } else {
            // Call the function directly if it's not callBrianAPI
            response = await targetFunction(...functionArguments);
          }
        } else {
          response = 'We had an issue calling an external function.'
        }
    
        console.log("function response:", response);
        tools_outputs.push({
          tool_call_id: tool_call.id,
          output: JSON.stringify(response)
        });
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

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

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
      res.status(201).send("Companion registered successfully");
  } catch (error) {
      console.error(error);
      res.status(500).send("Server error");
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});