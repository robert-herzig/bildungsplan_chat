"""
Kleiner Helper für ChromaDB-Abfragen aus Node.js.
Wird von server.js via child_process aufgerufen.

Verwendung:
    python3 query_helper.py "Suchbegriff" 8
    python3 query_helper.py --info
"""

import sys
import os
import json

try:
    import chromadb
except ImportError:
    print("[]")
    sys.exit(0)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

CHROMA_DB_PATH = os.getenv("CHROMA_DB_PATH", "./chroma_db")
COLLECTION_NAME = "bildungsplan"
MISTRAL_API_BASE = "https://api.mistral.ai/v1"


def get_embedding(api_key, text):
    import urllib.request
    payload = json.dumps({
        "model": "mistral-embed",
        "input": [text],
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{MISTRAL_API_BASE}/embeddings",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data["data"][0]["embedding"]


def main():
    if len(sys.argv) < 2:
        print("[]")
        sys.exit(0)

    # --info mode: return DB stats
    if sys.argv[1] == "--info":
        try:
            client = chromadb.PersistentClient(path=CHROMA_DB_PATH)
            coll = client.get_collection(name=COLLECTION_NAME)
            count = coll.count()
            # Get unique sources — paginate through all chunks
            sources = set()
            page_size = 500
            offset = 0
            while offset < count:
                result = coll.get(include=["metadatas"], limit=page_size, offset=offset)
                if not result or not result["metadatas"]:
                    break
                for m in result["metadatas"]:
                    sources.add(m.get("source", ""))
                offset += page_size
            print(json.dumps({
                "count": count,
                "sources": sorted(list(sources)),
            }))
        except Exception as e:
            print(json.dumps({"count": 0, "error": str(e)}))
        sys.exit(0)

    query_text = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        print("[]")
        sys.exit(0)

    try:
        client = chromadb.PersistentClient(path=CHROMA_DB_PATH)
        collection = client.get_collection(name=COLLECTION_NAME)
    except Exception:
        print("[]")
        sys.exit(0)

    try:
        embedding = get_embedding(api_key, query_text)
    except Exception as e:
        print("[]", file=sys.stderr)
        print(f"Embedding error: {e}", file=sys.stderr)
        sys.exit(0)

    results = collection.query(
        query_embeddings=[embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )

    chunks = []
    if results and results["documents"]:
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            chunks.append({
                "text": doc,
                "source": meta.get("source", "unbekannt"),
                "page": meta.get("page", "0"),
                "score": round(1 - dist, 3),
            })

    print(json.dumps(chunks, ensure_ascii=False))


if __name__ == "__main__":
    main()
