"""
Speech-to-Text via Mistral Voxtral Mini Transcribe API.
Called by server.js via child_process.

Usage:
    python3 stt_helper.py /path/to/audio.webm [language]
"""

import sys
import os
import json
import requests

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Kein Audio-Pfad angegeben."}))
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "de"

    api_key = os.environ.get("MISTRAL_API_KEY", "")
    if not api_key:
        print(json.dumps({"error": "MISTRAL_API_KEY nicht gesetzt."}))
        sys.exit(1)

    api_base = os.environ.get("MISTRAL_API_BASE", "https://api.mistral.ai/v1")
    url = f"{api_base}/audio/transcriptions"

    try:
        with open(audio_path, "rb") as f:
            files = {
                "file": (os.path.basename(audio_path), f, "audio/webm"),
            }
            data = {
                "model": "voxtral-mini-latest",
                "language": language,
            }
            headers = {
                "Authorization": f"Bearer {api_key}",
            }
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)

        if resp.status_code != 200:
            print(json.dumps({"error": f"Mistral API Fehler {resp.status_code}: {resp.text[:500]}"}))
            sys.exit(1)

        result = resp.json()
        text = result.get("text", "")
        print(json.dumps({"text": text}, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
