require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const bcrypt = require('bcrypt');
const { OpenAI } = require("openai");
const sensei = require('./sensei.json');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
const app = express();
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (sensei.systemPrompt) {
  saveMessage('system', sensei.systemPrompt);
}

function initializeSessionVariables(session) {
  if (!session.companion) session.companion = null;
  if (!session.messages) session.messages = [];
  if (!session.guide) session.guide = '';
  if (!session.thread) session.thread = '';
  if (!session.requestQueue) session.requestQueue = {};
  if (!session.functions) session.functions = {};
}

async function initializeFunctions(session) {
  const functionsDir = path.join(__dirname, 'functions');
  const functionDefinitions = [];
  try {
    const files = await fs.promises.readdir(functionsDir);
    for (const file of files) {
      if (path.extname(file) === '.js') {
        const moduleName = path.basename(file, '.js');
        session.functions[moduleName] = require(path.join(functionsDir, file));
        console.log("session functions:", session.functions);
      } else if (path.extname(file) === '.json') {
        const definition = JSON.parse(await fs.promises.readFile(path.join(functionsDir, file), 'utf8'));
        functionDefinitions.push({
          type: "function",
          function: definition
        });
      }
    }
  } catch (err) {
    console.error('Error loading functions into session:', err);
  }

  return functionDefinitions;
}

async function saveMessage(role, content, guide = null, companion = null, thread = null) {
  const insertQuery = `INSERT INTO messages (role, content, guide, companion, thread, created_at) VALUES ($1, $2, $3, $4, $5, NOW())`;
  try {
    await pool.query(insertQuery, [role, content, guide, companion, thread]);
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
    }
    
    session.requestQueue[requestId] = { status: 'completed', data: result };
  } catch (error) {
    session.requestQueue[requestId] = { status: 'failed', data: error.message };
  }
}

async function uploadFiles() {
  const filesDir = path.join(__dirname, 'files');

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
    console.error("Error uploading files:", error);
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
      instructions: sensei.systemPrompt,
      tools: [...functionDefinitions, { type: "code_interpreter" }, { type: "retrieval" }],
      model: sensei.model,
      file_ids: fileIds
    });
    console.log("local guide tools:", localGuide.tools);
    session.guide = localGuide;
  }

  if (!localThread) {
    localThread = await openai.beta.threads.create();
    session.thread = localThread;
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

  let runId = run.id;

  while (run.status !== "completed") {
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
        console.log("function name:", functionName);
        let functionArguments = Object.values(JSON.parse(tool_call.function.arguments));
        console.log("function arguments:", functionArguments);
        let response;
        console.log("session functions:", session.functions);
        if (Object.prototype.hasOwnProperty.call(session.functions, functionName)) {
          response = await session.functions[functionName](...functionArguments);
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
      run = openai.beta.threads.runs.submitToolOutputs(
        localThread.id,
        runId,
        {
          tool_outputs: tools_outputs
        }
      );
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


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});