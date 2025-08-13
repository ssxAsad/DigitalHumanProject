export async function handler(event) {
  // --- FIX: Handle the browser's security preflight check ---
  // This block allows the browser to make requests from your app.
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204, // No Content
      headers: {
        'Access-Control-Allow-Origin': '*', // Or your specific domain for production
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // Only allow POST requests for the main logic
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in your environment variables.");
    }

    // Using a modern, fast model. The API key is passed in the URL.
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    
    // The request body from main.js is already in the correct format for Gemini.
    const requestBodyFromFrontend = event.body;

    const geminiResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBodyFromFrontend,
    });

    // If Google's API returns an error, forward it to the browser for debugging.
    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.json();
      console.error('Gemini API Error:', errorBody);
      return {
        statusCode: geminiResponse.status,
        body: JSON.stringify(errorBody),
      };
    }

    // Get the JSON data from the successful Gemini response.
    const responseData = await geminiResponse.json();

    // Send the successful response back to the browser.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Allows the browser to read this response
      },
      body: JSON.stringify(responseData),
    };

  } catch (err) {
    console.error('Error in Gemini function:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
