const express = require('express');
const { OpenAI } = require("openai");
const sensei = require('./sensei.json');

require('dotenv').config();
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let messages = [];
let assistant = '';
let thread = '';

if (sensei.systemPrompt) {
  messages.push({
    role: 'system',
    content: sensei.systemPrompt,
  });
}

async function callChat(messages, prompt) {
  messages.push({
    role: 'user',
    content: prompt,
  });

  const response = await openai.chat.completions.create({
    model: sensei.model,
    messages,
  });

  returnValue = response.choices[0].message;

  messages.push({
    role: returnValue.role,
    content: returnValue.content,
  });

  return returnValue;
}

async function callAssistant(messages, prompt, assistant, thread) {
  function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
  } 
  if (!assistant) {
    assistant = await openai.beta.assistants.create({
      name: sensei.branch,
      instructions: sensei.systemPrompt,
      tools: [{ type: "code_interpreter" }, { type: "retrieval"}],
      model: sensei.model
    });
  } else {
    // assistant already exists
  }

  if (!thread) {
    thread = await openai.beta.threads.create();
  } else {
    // thread already exists
  }

  await openai.beta.threads.messages.create(
    thread.id,
    {
      role: "user",
      content: prompt
    }
  );

  let run = await openai.beta.threads.runs.create(
    thread.id,
    { 
      assistant_id: assistant.id,
      // instructions: "You can add custom instructions, which will override the system prompt.."
    }
  );
  let runId = run.id;

  while (run.status != "completed") {
    await delay(2000);
    run = await openai.beta.threads.runs.retrieve(
      thread.id,
      runId
    );
    if (run.status === "failed") { console.log("run failed:", run); }
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
        tools_outputs.push(
          {
            tool_call_id: tool_call.id,
            output: JSON.stringify(response)
          }
        );
      }
      run = openai.beta.threads.runs.submitToolOutputs(
        thread.id,
        runId,
        {
          tool_outputs: tools_outputs
        }
      );
    }
  }

  let originalMessageLength = messages.length;
  let completedThread = await openai.beta.threads.messages.list(thread.id);
  let newMessages = completedThread.data.slice();
  for (let message of newMessages) {
    messages.push(message.content[0]);
  }
  messages = messages.slice(originalMessageLength);
  let botMessage = messages[0].text.value;
  let returnValue = {
    role: "assistant",
    content: botMessage
  }
  return {
    returnValue,
    assistant,
    thread
  };
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/status/:runId', (req, res) => {
  const runId = req.params.runId;

  let status = '';

  if (sensei.target == "chat") {
    // get status from chat id
  } else if (sensei.target == "assistant") {
    // get status from run id
  }

  if (status) {
      res.json({ status: status });
  } else {
      res.status(404).send('Run not found');
  }
});


app.post('/prompt', async (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) {
    return res.status(400).send({ message: 'Prompt is required' });
  }

  if (sensei.target == "chat") {
    returnValue = await callChat(messages, prompt);
    res.send(returnValue);
  }

  if (sensei.target == "assistant") {
    // If assistant or thread are unassigned, pass them as undefined or null to callAssistant
    const initialAssistant = assistant || null;
    const initialThread = thread || null;

    const { 
      returnValue,
      assistant: updatedAssistant,
      thread: updatedThread 
    } = await callAssistant(messages, prompt, initialAssistant, initialThread);

    if (updatedAssistant) assistant = updatedAssistant;
    if (updatedThread) thread = updatedThread;

    res.send(returnValue);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});