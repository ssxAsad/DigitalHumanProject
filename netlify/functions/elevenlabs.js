export async function handler(event) {
  try {
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const body = JSON.parse(event.body);

    const voiceId = body.voiceId;
    const wsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const response = await fetch(wsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
      },
      body: JSON.stringify(body.payload)
    });

    const arrayBuffer = await response.arrayBuffer();
    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg" },
      body: Buffer.from(arrayBuffer).toString("base64"),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
