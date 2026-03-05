"""
Web-Suche via DuckDuckGo (kein API-Key nötig).
Wird von server.js via child_process aufgerufen.

Verwendung:
    python3 web_search.py "Suchbegriff" 4
"""

import sys
import json

def main():
    if len(sys.argv) < 2:
        print("[]")
        sys.exit(0)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    try:
        from duckduckgo_search import DDGS
    except ImportError:
        print("[]", file=sys.stderr)
        print("duckduckgo_search nicht installiert. Installiere mit: pip3 install duckduckgo_search", file=sys.stderr)
        print("[]")
        sys.exit(0)

    try:
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results, region="de-de"):
                results.append({
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "snippet": r.get("body", ""),
                })
        print(json.dumps(results, ensure_ascii=False))
    except Exception as e:
        print(f"Suchfehler: {e}", file=sys.stderr)
        print("[]")


if __name__ == "__main__":
    main()
