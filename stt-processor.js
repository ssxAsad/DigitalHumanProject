/**
 * This AudioWorkletProcessor receives raw audio data (Float32Array),
 * converts it to 16-bit PCM, and sends it to the main thread
 * to be relayed over a WebSocket.
 */
class SttProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.port.onmessage = (event) => {
            // This worklet does not need to receive messages currently,
            // but you could add logic here for start/stop commands.
        };
    }

    process(inputs, outputs, parameters) {
        // We only expect one input, and we'll take the first channel.
        const inputData = inputs[0][0];

        if (inputData) {
            // Convert Float32 data (-1.0 to 1.0) to 16-bit PCM (-32768 to 32767)
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                let s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            // Post the raw buffer back to the main thread.
            // The second argument [pcm16.buffer] is a Transferable object,
            // which transfers ownership to the main thread for efficiency.
            this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
        }

        // Return true to keep the processor alive.
        return true;
    }
}

registerProcessor('stt-processor', SttProcessor);