"""
Piper TTS HTTP server — keeps voice models loaded in memory for fast synthesis.
Runs on localhost:5002, called by server.js.

Voices:
  - thorsten_emotional: male German (medium quality, natural)
  - eva_k: female German (x_low quality, fast)

Usage:
    python3 tts_server.py
"""

import io
import wave
import time
import logging
from flask import Flask, request, send_file, jsonify
from piper import PiperVoice

logging.basicConfig(level=logging.INFO, format="%(asctime)s [PiperTTS] %(message)s")
log = logging.getLogger(__name__)

import os
VOICE_DIR = os.environ.get("PIPER_VOICE_DIR", "/home/herzi/piper_voices")
VOICES = {}

def load_voices():
    """Pre-load all voice models into memory."""
    voice_files = {
        "male":   f"{VOICE_DIR}/thorsten_emotional.onnx",
        "female": f"{VOICE_DIR}/eva_k.onnx",
    }
    for name, path in voice_files.items():
        try:
            start = time.time()
            VOICES[name] = PiperVoice.load(path)
            elapsed = (time.time() - start) * 1000
            log.info(f"Loaded voice '{name}' from {path} in {elapsed:.0f}ms")
        except Exception as e:
            log.error(f"Failed to load voice '{name}': {e}")


app = Flask(__name__)

@app.route("/synthesize", methods=["POST"])
def synthesize():
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    voice_id = data.get("voice", "female")

    if not text:
        return jsonify({"error": "No text provided"}), 400

    voice = VOICES.get(voice_id)
    if not voice:
        return jsonify({"error": f"Unknown voice: {voice_id}"}), 400

    try:
        start = time.time()
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(voice.config.sample_rate)
            for audio_chunk in voice.synthesize(text):
                wf.writeframes(audio_chunk.audio_bytes)
        elapsed = (time.time() - start) * 1000

        buf.seek(0)
        log.info(f"Synthesized {len(text)} chars with '{voice_id}' in {elapsed:.0f}ms")
        return send_file(buf, mimetype="audio/wav", download_name="tts.wav")
    except Exception as e:
        log.error(f"Synthesis error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "voices": list(VOICES.keys())})


if __name__ == "__main__":
    load_voices()
    log.info("Piper TTS server starting on port 5002")
    app.run(host="127.0.0.1", port=5002, threaded=True)
