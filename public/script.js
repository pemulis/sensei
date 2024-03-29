let recorder, audioStream;
const startRecordingButton = document.getElementById("startRecording");
const stopRecordingButton = document.getElementById("stopRecording");
const audioElement = document.getElementById("audioPrompt");

document.addEventListener('DOMContentLoaded', (event) => {
  const chatForm = document.getElementById('chatForm');
  const registerForm = document.getElementById('registerForm');
  const loginForm = document.getElementById('loginForm');

  // Explicitly set initial display state to match CSS
  chatForm.style.display = 'none';
  registerForm.style.display = 'none';
  loginForm.style.display = 'none';

  function toggleFormVisibility(buttonId, formId) {
    const button = document.getElementById(buttonId);
    const form = document.getElementById(formId);
  
    button.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
  }
  
  toggleFormVisibility('showChatForm', 'chatForm');
  toggleFormVisibility('showRegisterForm', 'registerForm');
  toggleFormVisibility('showLoginForm', 'loginForm');
});

document.getElementById('chatForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value;
  displayPrompt(prompt);
  sendPromptToBackend(prompt);
});

document.getElementById('registerForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const username = document.getElementById('registerUsername').value;
  const password = document.getElementById('registerPassword').value;
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
});

document.getElementById('loginForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
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
});
  
startRecordingButton.addEventListener("click", async () => {
  audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder = new MediaRecorder(audioStream  );
  let audioChunks = [];

  recorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  recorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/mpeg' });
    audioElement.src = URL.createObjectURL(audioBlob);
    audioElement.hidden = false; // Show the audio player
    
    // Prepare the audio blob for uploading
    const formData = new FormData();
    formData.append("audioFile", audioBlob, "audio.mp3");
    
    // Send the audio file to the server
    fetch("/upload-audio", {
      method: "POST",
      body: formData,
    })
    .then(response => response.json())
    .then(data => {
      console.log(data);
      if (data.requestId) {
        pollStatus(data.requestId, handleTranscriptionResult, handleError);
      }
    })
    .catch(error => {
      console.error("Error uploading audio: ", error);
    });
  };

  recorder.start();
  stopRecordingButton.disabled = false; // Enable the stop recording button
});

stopRecordingButton.addEventListener("click", () => {
  recorder.stop();
  audioStream.getTracks().forEach(track => track.stop());
  stopRecordingButton.disabled = true; // Disable the stop recording button again
});

function pollStatus(requestId, onSuccess, onError) {
  const intervalId = setInterval(() => {
    fetch(`/status/${requestId}`)
      .then(response => response.json())
      .then(data => {
        console.log('Polling response:', data);
        console.log('Success callback:', onSuccess);
        if (data.status === 'completed') {
          clearInterval(intervalId);
          console.log('Polling completed:', data);
          onSuccess(data); // Call onSuccess handler with the received data
        } else if (data.status === 'failed') {
          clearInterval(intervalId);
          onError(data); // Call onError handler with the error data
        }
        // If still processing, keep polling
      })
      .catch(error => {
        console.error('Polling error:', error);
        clearInterval(intervalId);
        onError(error); // Handle fetch errors
      });
  }, 2000); // Adjust polling interval as needed
}

function playAudioFromURL(audioUrl) {
  console.log("Attempting to play audio from URL:", audioUrl);
  const audioResponseElement = document.getElementById("audioResponse");
  audioResponseElement.src = audioUrl;
  audioResponseElement.hidden = false;
  audioResponseElement.play().catch(error => {
    console.error('Error playing audio:', error);
  });
}

function handleTranscriptionResult(data) {
  // This function will be called once the transcription is successfully retrieved
  displayPrompt(data.data.transcription);

  // Next, send the transcription as a prompt to get the guide's response
  sendPromptToBackend(data.data.transcription);
}

function handleTextPrompt(value) {
  // Send the text prompt to get the guide's response
  sendPromptToBackend(value);
}

function displayPrompt(prompt) {
  const promptElement = document.createElement("pre");
  promptElement.classList.add("jsonResponse");
  promptElement.textContent = JSON.stringify({ role: "user", content: prompt }, null, 2);
  threadContainer.insertBefore(promptElement, threadContainer.firstChild);
}

function sendPromptToBackend(prompt) {
  fetch('/prompt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: prompt }),
  })
  .then(response => response.json())
  .then(data => {
    if (data.requestId) {
      pollStatus(data.requestId, handleGuideResponse, handleError);
    }
  })
  .catch(error => console.error('Error sending prompt:', error));
}

function handleGuideResponse(data) {
  console.log("handling guide response:", data);
  // Check if the response has the expected structure with 'role', 'content', and 'audioUrl'
  if (data.data && data.data.role && data.data.content) {
    // Display the guide's text response
    displayTextResponse(data.data.content);

    // If there's also an audio URL, play it
    if (data.data.audioUrl) {
      playAudioFromURL(data.data.audioUrl);
    }
  } else {
    console.error("Unexpected data structure from backend:", data);
  }
}

function displayTextResponse(text) {
  const responseElement = document.createElement("pre");
  responseElement.classList.add("jsonResponse");
  responseElement.textContent = JSON.stringify({ role: "guide", content: text }, null, 2);
  threadContainer.insertBefore(responseElement, threadContainer.firstChild);
}

function handleError(error) {
  console.error("Polling error or processing error: ", error);
  // Implement UI feedback for errors, e.g., displaying an error message to the user
}