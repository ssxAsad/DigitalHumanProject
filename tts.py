import asyncio
import json
import time
import io
import base64
import re
from typing import Literal
import os

import numpy as np
import soundfile as sf
import torch
import websockets

# =========================================================
# 0. GLOBAL SETTINGS
# =========================================================
TTS_HOST = "localhost"
TTS_PORT = 8765
STT_HOST = "localhost"
STT_PORT = 8766

STT_SAMPLE_RATE = 16000

USE_GPU = torch.cuda.is_available()

if USE_GPU:
    print("✅ CUDA (GPU) is available. Both TTS and STT will run on GPU.")
    torch.set_grad_enabled(False)
    torch.backends.cudnn.benchmark = True
    try:
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass
else:
    print("⚠️ CUDA (GPU) not found. Both TTS and STT will run on CPU (slower).")

device = "cuda" if USE_GPU else "cpu"


# =========================================================
# 1. TTS MODEL (GPU or CPU)
# =========================================================
print("Initializing TTS model...")
from TTS.api import TTS

tts = TTS("tts_models/en/ljspeech/vits")
tts.to(device)
TTS_SAMPLE_RATE = tts.synthesizer.output_sample_rate
print(f"✅ TTS model loaded on {device.upper()}. Sample rate: {TTS_SAMPLE_RATE}")


# =========================================================
# 2. STT MODEL (GPU or CPU, using Whisper)
# =========================================================
print("Initializing Whisper STT model (GPU-accelerated)...")
from transformers import pipeline

stt_pipeline = pipeline(
    "automatic-speech-recognition",
    model="distil-whisper/distil-small.en",
    device=device,
    torch_dtype=torch.float16 if USE_GPU else torch.float32,
)
print(f"✅ Whisper STT model loaded on {device.upper()}.")


# =========================================================
# 3. UTILITIES
# =========================================================
def process_and_encode_audio(wav_data: np.ndarray) -> str:
    buffer = io.BytesIO()
    wav_data = wav_data.astype(np.float32, copy=False)
    sf.write(buffer, wav_data, TTS_SAMPLE_RATE, format="WAV", subtype="FLOAT")
    audio_bytes = buffer.getvalue()
    return base64.b64encode(audio_bytes).decode("utf-8")

def get_tts_params_for_emotion(emotion: str):
    mapping = {
        "happy":   {"speed": 1.15},
        "sad":     {"speed": 0.9},
        "angry":   {"speed": 1.2},
        "relaxed": {"speed": 1.0},
    }
    return mapping.get(emotion, mapping["relaxed"])


# =========================================================
# 4. GPU TTS WEBSOCKET HANDLER (ws://localhost:8765)
# =========================================================
async def tts_handler(websocket):
    print(f"🔊 [TTS] Client connected: {websocket.remote_address}")
    try:
        async for message in websocket:
            start_time = time.time()
            text_to_speak = message
            emotion = "relaxed"
            
            if not text_to_speak:
                print("⚠️ [TTS] Empty message received. Skipping.")
                continue

            print(f"🔊 [TTS] Received text: '{text_to_speak}'")

            params = get_tts_params_for_emotion(emotion)
            wav_float = np.array(tts.tts(text=text_to_speak, speed=params["speed"]), dtype=np.float32)

            audio_base64 = await asyncio.to_thread(process_and_encode_audio, wav_float)
            
            elapsed = time.time() - start_time
            await websocket.send(json.dumps({"audio": audio_base64}))
            print(f"✅ [TTS] Sent audio ({len(audio_base64)} b64 chars). Latency: {elapsed:.2f}s")

    except websockets.exceptions.ConnectionClosed as e:
        print(f"❌ [TTS] Client disconnected ({e.code}): {e.reason}")
    except Exception as e:
        print(f"❌ [TTS] Error: {e}")


# =========================================================
# 5. GPU STT WEBSOCKET HANDLER (ws://localhost:8766)
# =========================================================

# --- Configuration for Silence Detection ---
# How long the user must be silent (in seconds) to trigger transcription.
SILENCE_THRESHOLD_S = 1.5
# How often we check for silence (in seconds).
SILENCE_CHECK_INTERVAL_S = 0.1
# The minimum amount of audio (in seconds) to process. Prevents processing noise.
MIN_AUDIO_DURATION_S = 1.0


async def stt_handler(websocket):
    print(f"🎤 [STT] Client connected: {websocket.remote_address}")
    
    audio_buffer = bytearray()
    last_audio_time = time.time()

    # --- Helper function to process the audio buffer ---
    async def process_buffer():
        nonlocal audio_buffer
        if not audio_buffer or len(audio_buffer) < STT_SAMPLE_RATE * MIN_AUDIO_DURATION_S * 2:
            audio_buffer.clear() # Clear buffer if it's too short
            return

        print(f"🎤 [STT] Processing buffer of size {len(audio_buffer)} bytes...")
        
        try:
            audio_np = np.frombuffer(audio_buffer, dtype=np.int16).astype(np.float32) / 32768.0
            
            result = stt_pipeline(
                audio_np, chunk_length_s=30, batch_size=4, return_timestamps=False
            )
            text = result["text"].strip()
            
            if text:
                print(f"🎤 [STT-RESULT] Final Text: '{text}'")
                await websocket.send(json.dumps({"type": "final", "text": text}))
        
        except Exception as e:
            print(f"❌ [STT] Error during transcription: {e}")
        
        finally:
            audio_buffer.clear() # Always clear buffer after processing

    # --- Background task to detect silence ---
    async def silence_detector():
        # --- CORRECTED: 'nonlocal' is now declared at the top of the function ---
        nonlocal last_audio_time
        while True:
            await asyncio.sleep(SILENCE_CHECK_INTERVAL_S)
            # This check can now safely use the 'last_audio_time' variable
            if time.time() - last_audio_time > SILENCE_THRESHOLD_S:
                if audio_buffer:
                    print("🎤 [STT] Silence detected, processing...")
                    await process_buffer()
                    # Reset timer after processing
                    last_audio_time = time.time()

    silence_task = asyncio.create_task(silence_detector())

    try:
        async for msg in websocket:
            if isinstance(msg, str):
                data = json.loads(msg)
                # The manual "flush" from the button still works as an override
                if data.get("type") == "flush":
                    print("🎤 [STT] Manual flush received.")
                    await process_buffer()
                    last_audio_time = time.time() # Reset timer
                continue

            # When audio comes in, append it and update the timestamp
            if isinstance(msg, (bytes, bytearray)):
                audio_buffer.extend(msg)
                last_audio_time = time.time()

    except websockets.exceptions.ConnectionClosed as e:
        print(f"❌ [STT] Client disconnected ({e.code}): {e.reason}")
    except Exception as e:
        print(f"❌ [STT] Error: {e}")
    finally:
        # --- Clean up the background task when the user disconnects ---
        silence_task.cancel()
        print(f"🎤 [STT] Cleaned up silence detector for {websocket.remote_address}")


# =========================================================
# 6. SERVER STARTUP
# =========================================================
async def main():
    print(f"🚀 Starting servers:")
    print(f"   🔊 TTS ({device.upper()}) → ws://{TTS_HOST}:{TTS_PORT}")
    print(f"   🎤 STT ({device.upper()}) → ws://{STT_HOST}:{STT_PORT}")

    tts_srv = websockets.serve(tts_handler, TTS_HOST, TTS_PORT, max_size=1024 * 1024 * 16)
    stt_srv = websockets.serve(stt_handler, STT_HOST, STT_PORT, max_size=1024 * 1024 * 16)

    await asyncio.gather(tts_srv, stt_srv)
    await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down servers.")