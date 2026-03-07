"""
Text-to-Speech via edge-tts (Microsoft Edge TTS, free, no API key).
Called by server.js via child_process.

Usage:
    python3 tts_helper.py "Text zum Vorlesen" "de-DE-KatjaNeural" "/tmp/output.mp3"
"""

import sys
import json
import asyncio

async def generate(text, voice, output_path):
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_path)

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: tts_helper.py <text> <voice> <output_path>"}))
        sys.exit(1)

    text = sys.argv[1]
    voice = sys.argv[2]
    output_path = sys.argv[3]

    if not text.strip():
        print(json.dumps({"error": "Leerer Text."}))
        sys.exit(1)

    try:
        asyncio.run(generate(text, voice, output_path))
        print(json.dumps({"ok": True, "path": output_path}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
