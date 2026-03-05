"""
PDF-Ingestion-Pipeline: Extrahiert Text aus PDFs, teilt ihn in Chunks,
erzeugt Embeddings und speichert alles in ChromaDB.

Verwendung:
    python3 ingest.py
"""

import os
import sys
import hashlib
import json
import urllib.request
import urllib.error
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("❌ PyMuPDF fehlt. Installiere mit: pip3 install pymupdf")
    sys.exit(1)

try:
    import chromadb
except ImportError:
    print("❌ chromadb fehlt. Installiere mit: pip3 install chromadb")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # .env wird manuell geladen oder env vars sind gesetzt

PDF_FOLDER = os.getenv("PDF_FOLDER", "./Bildungsplan_PDFs")
CHROMA_DB_PATH = os.getenv("CHROMA_DB_PATH", "./chroma_db")
COLLECTION_NAME = "bildungsplan"
MISTRAL_API_BASE = "https://api.mistral.ai/v1"

# --- Chunk-Einstellungen ---
CHUNK_SIZE = 1000       # Zeichen pro Chunk
CHUNK_OVERLAP = 200     # Überlappung zwischen Chunks


def extract_text_from_pdf(pdf_path):
    """Extrahiert Text seitenweise aus einer PDF-Datei."""
    doc = fitz.open(pdf_path)
    pages = []
    for page_num, page in enumerate(doc, start=1):
        text = page.get_text("text")
        if text.strip():
            pages.append({
                "text": text,
                "page": page_num,
                "source": os.path.basename(pdf_path),
            })
    doc.close()
    return pages


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Teilt einen langen Text in überlappende Chunks auf."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if end < len(text):
            last_period = chunk.rfind(". ")
            last_newline = chunk.rfind("\n")
            cut_at = max(last_period, last_newline)
            if cut_at > chunk_size * 0.3:
                chunk = chunk[:cut_at + 1]
                end = start + cut_at + 1
        chunks.append(chunk.strip())
        start = end - overlap
    return [c for c in chunks if len(c) > 50]


def make_chunk_id(source, page, chunk_index):
    """Erzeugt eine deterministische ID für einen Chunk."""
    raw = f"{source}::p{page}::c{chunk_index}"
    return hashlib.md5(raw.encode()).hexdigest()


def get_embeddings_batch(api_key, texts):
    """Erzeugt Embeddings über die Mistral-API mit Retry-Logik bei Rate-Limits."""
    import time
    all_embeddings = []
    batch_size = 25
    # Delay between batches to stay within free-tier rate limits
    BATCH_DELAY = 1.5   # seconds between successful batches
    MAX_RETRIES = 6     # max retries on 429

    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        payload = json.dumps({
            "model": "mistral-embed",
            "input": batch,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{MISTRAL_API_BASE}/embeddings",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with urllib.request.urlopen(req) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    for item in data["data"]:
                        all_embeddings.append(item["embedding"])
                break  # success, exit retry loop
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                if e.code == 429:
                    wait = BATCH_DELAY * (2 ** attempt)  # exponential backoff: 3s, 6s, 12s …
                    print(f"  ⏳ Rate-Limit – warte {wait:.0f}s (Versuch {attempt}/{MAX_RETRIES}) …")
                    time.sleep(wait)
                    if attempt == MAX_RETRIES:
                        print(f"❌ Rate-Limit nach {MAX_RETRIES} Versuchen. Abbruch.")
                        sys.exit(1)
                else:
                    print(f"❌ API-Fehler {e.code}: {body}")
                    sys.exit(1)

        end_idx = min(i + batch_size, len(texts))
        print(f"  Embeddings {i+1}–{end_idx} / {len(texts)} erstellt")
        time.sleep(BATCH_DELAY)

    return all_embeddings


def ingest_pdfs():
    """Hauptfunktion: Liest alle PDFs ein und speichert sie in ChromaDB."""
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key or api_key == "your_mistral_api_key_here":
        print("❌ Bitte setze deinen MISTRAL_API_KEY in der .env-Datei!")
        sys.exit(1)

    # ChromaDB initialisieren
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_PATH)

    # Bestehende Collection löschen und neu erstellen
    try:
        chroma_client.delete_collection(COLLECTION_NAME)
        print("🗑️  Alte Collection gelöscht.")
    except Exception:
        pass

    collection = chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    # PDFs finden
    pdf_folder = Path(PDF_FOLDER)
    pdf_files = sorted(pdf_folder.glob("*.pdf"))
    if not pdf_files:
        print(f"❌ Keine PDF-Dateien in {pdf_folder.resolve()} gefunden!")
        sys.exit(1)

    print(f"📂 {len(pdf_files)} PDF(s) gefunden in {pdf_folder.resolve()}")

    all_chunks = []
    all_ids = []
    all_metadatas = []

    for pdf_path in pdf_files:
        print(f"\n📄 Verarbeite: {pdf_path.name}")
        pages = extract_text_from_pdf(str(pdf_path))
        print(f"   {len(pages)} Seite(n) mit Text extrahiert")

        for page_info in pages:
            chunks = chunk_text(page_info["text"])
            for ci, chunk in enumerate(chunks):
                chunk_id = make_chunk_id(page_info["source"], page_info["page"], ci)
                all_chunks.append(chunk)
                all_ids.append(chunk_id)
                all_metadatas.append({
                    "source": page_info["source"],
                    "page": str(page_info["page"]),
                    "chunk_index": str(ci),
                })

    print(f"\n📊 Insgesamt {len(all_chunks)} Chunks erstellt.")

    if not all_chunks:
        print("❌ Keine Chunks zum Speichern – überprüfe die PDF-Dateien.")
        sys.exit(1)

    # Embeddings erzeugen
    print("\n🔄 Erzeuge Embeddings über Mistral-API...")
    embeddings = get_embeddings_batch(api_key, all_chunks)

    # In ChromaDB speichern
    print("\n💾 Speichere in ChromaDB...")
    batch_size = 100
    for i in range(0, len(all_chunks), batch_size):
        end = min(i + batch_size, len(all_chunks))
        collection.add(
            ids=all_ids[i:end],
            documents=all_chunks[i:end],
            embeddings=embeddings[i:end],
            metadatas=all_metadatas[i:end],
        )

    print(f"\n✅ Fertig! {collection.count()} Chunks in ChromaDB gespeichert.")
    print(f"   Datenbank-Pfad: {Path(CHROMA_DB_PATH).resolve()}")


if __name__ == "__main__":
    ingest_pdfs()
