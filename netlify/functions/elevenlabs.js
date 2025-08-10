export async function handler(event) {
  try {
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const body = JSON.parse(event.body);

    const voiceId = body.voiceId;
    const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    console.log("➡️ Calling ElevenLabs API:", apiUrl);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
      },
      body: JSON.stringify(body.payload)
    });

    // Log status code
    console.log("🔄 ElevenLabs status:", response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ ElevenLabs API Error Response:", errorText);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: errorText })
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log("✅ Received audio, size:", arrayBuffer.byteLength, "bytes");

    const base64Audio = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg"
      },
      body: base64Audio,
      isBase64Encoded: true
    };

  } catch (err) {
    console.error("💥 Function Error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
