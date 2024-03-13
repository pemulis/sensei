async function callBrianAPI(prompt, chainId, address) {
  const fetch = (await import('node-fetch')).default;

  // Endpoint URI for Brian API
  const uri = 'https://us-api.brianknows.org/api/v0/agent/transaction';
  // Retrieve the API key from environment variables
  const apiKey = process.env.BRIAN_API_KEY;

  if (!apiKey) {
    console.error("API key for Brian not found.");
    return "API key not set.";
  }

  console.log(`Making request with prompt: '${prompt}', address: ${address}, and chainId: ${chainId}...`);

  try {
    const response = await fetch(uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-brian-api-key': apiKey
      },
      body: JSON.stringify({ prompt, address, chainId })
    });

    if (!response.ok) {
      // Handle HTTP errors
      let errMsg = `HTTP error while calling Brian API. Status: ${response.status} (${response.statusText})`;
      try {
        const errorBody = await response.json();
        errMsg += errorBody.error ? `; Error: ${errorBody.error}` : `; Message: ${errorBody.message || "Unknown error"}`;
      } catch (bodyError) {
        errMsg += `. Additionally, failed to parse the error response: ${bodyError.message}`;
      }
      throw new Error(errMsg);
    }

    // Assuming the response is successful and JSON formatted
    const data = await response.json();
    console.log("Received response from Brian API:", data);
    return data; // Pass the API response back to the caller for further processing
  } catch (error) {
    console.error("Failed to interact with the Brian API:", error);
    return "Failed to receive a valid response from the Brian API.";
  }
}

module.exports = callBrianAPI;