// functions/elevenlabs.js

import { PassThrough } from 'stream';

export async function handler(event) {
  // Check if the request is a preflight OPTIONS request (for CORS)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Be more specific in production
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  try {
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!ELEVENLABS_API_KEY) {
        throw new Error("ElevenLabs API key is not configured.");
    }
    
    const body = JSON.parse(event.body);
    const voiceId = body.voiceId;
    
    // --- CHANGE 1: Use the streaming endpoint ---
    // We add "/stream" to the URL to tell ElevenLabs we want a live stream.
    const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

    console.log("➡️ Calling ElevenLabs STREAMING API:", apiUrl);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: JSON.stringify(body.payload),
    });

    console.log("🔄 ElevenLabs stream status:", response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ ElevenLabs API Error Response:", errorText);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `ElevenLabs API Error: ${errorText}` }),
      };
    }
    
    // --- CHANGE 2: Stream the response back to the browser ---
    // Instead of waiting for the file to finish, we send each chunk as it arrives.
    // This is what allows for real-time playback and lip-sync.
    const stream = new PassThrough();
    response.body.pipe(stream);

    return {
      statusCode: 200,
      isBase64Encoded: false, // We are sending raw data, not base64
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        'Access-Control-Allow-Origin': '*', // For local development
      },
      body: stream, // Return the stream directly
    };

  } catch (err) {
    console.error("💥 Function Error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
