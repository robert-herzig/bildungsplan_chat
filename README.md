# 🎓 Bildungsplan GENT – KI-Assistent

Ein RAG-basierter (Retrieval-Augmented Generation) KI-Assistent für Lehrkräfte an SBBZ in Baden-Württemberg, Förderschwerpunkt **Geistige Entwicklung (GENT)**. Der Assistent nutzt den Bildungsplan 2022 als Wissensgrundlage und beantwortet Fragen über eine Weboberfläche mithilfe der Mistral-API.

**Live:** [https://eulenai.de/bildungsplan/](https://eulenai.de/bildungsplan/)

---

## Architektur

```
Bildungsplan_PDFs/          ← PDF-Dokumente (nicht im Git)
       │
       ▼
  ingest.py                 ← Extraktion, Chunking, Mistral-Embeddings
       │
       ▼
  chroma_db/                ← Lokale Vektordatenbank (nicht im Git)
       │
       ▼
  query_helper.py           ← Python-Brücke: ChromaDB-Suche für Node
       │
       ▼
  server.js                 ← Express-Server (Port 5001)
       │
       ▼
  nginx /bildungsplan/      ← Reverse Proxy auf eulenai.de
       │
       ▼
  templates/index.html      ← Deutsche Chat-Oberfläche
```

---

## Ersteinrichtung

### 1. Voraussetzungen

- **Node.js** ≥ 18 und **npm**
- **Python 3** ≥ 3.10
- **PM2** (`npm install -g pm2`)
- **Mistral API Key** → [console.mistral.ai](https://console.mistral.ai/)

### 2. Repository klonen

```bash
git clone https://github.com/robert-herzig/bildungsplan_chat.git
cd bildungsplan_chat
```

### 3. Umgebungsvariablen konfigurieren

```bash
cp .env.example .env
```

Dann `.env` öffnen und den API Key eintragen:

```env
MISTRAL_API_KEY=dein_api_key_hier
MISTRAL_MODEL=mistral-small-latest
PDF_FOLDER=./Bildungsplan_PDFs
CHROMA_DB_PATH=./chroma_db
TOP_K=8
PORT=5001
HOST=127.0.0.1
```

### 4. Abhängigkeiten installieren

```bash
# Node.js
npm install

# Python
pip3 install --user pymupdf chromadb python-dotenv
```

### 5. PDFs einfügen und indexieren

Bildungsplan-PDFs in den Ordner `Bildungsplan_PDFs/` legen und dann:

```bash
python3 ingest.py
```

Die Ingestion läuft automatisch durch alle PDFs, erzeugt Embeddings über die Mistral-API und speichert alles lokal in ChromaDB. Bei 22 PDFs (~2.300 Chunks) dauert das ca. 5–10 Minuten – der eingebaute Retry-Mechanismus behandelt Rate-Limits des Free-Tiers automatisch.

### 6. Server starten (Entwicklung)

```bash
node server.js
# → http://127.0.0.1:5001
```

---

## Deployment auf dem Server (eulenai.de)

### Deployen / aktualisieren

```bash
bash deploy.sh
```

Das Skript:
- Kopiert alle Dateien nach `/var/www/bildungsplan/`
- Führt `npm install --production` aus
- Startet/restartet den PM2-Prozess `bildungsplan_assistent`

### nginx-Konfiguration

Den Block aus `nginx_bildungsplan.conf` in den `server { listen 443 ssl; }`-Block der eulenai-Konfiguration einfügen (`/etc/nginx/sites-available/eulenai`):

```nginx
location /bildungsplan/ {
    proxy_pass http://127.0.0.1:5001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    rewrite ^/bildungsplan$ /bildungsplan/ permanent;
}
```

Dann:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### PM2-Status prüfen

```bash
pm2 list
pm2 logs bildungsplan_assistent
```

---

## Neue PDFs hinzufügen / Re-Indexieren

Wenn du neue Dokumente hinzufügst oder bestehende aktualisierst:

```bash
# 1. PDFs in den Ordner legen
cp neue_datei.pdf Bildungsplan_PDFs/

# 2. Neu indexieren (löscht und erstellt die DB komplett neu)
cd /home/herzi/mistral_schoolstuff
python3 ingest.py

# 3. Auf den Server deployen (kopiert auch die neue chroma_db)
bash deploy.sh
```

> **Hinweis:** `ingest.py` löscht bei jedem Lauf die bestehende ChromaDB-Collection und baut sie komplett neu auf. Dadurch werden auch entfernte PDFs sauber aus dem Index gelöscht.

---

## System-Prompt anpassen

Der System-Prompt steuert das Verhalten des Assistenten. Er kann auf zwei Wegen angepasst werden:

**Über die Web-Oberfläche:** Auf das ⚙-Symbol oben rechts klicken.

**Direkt in der Datei:**

```bash
nano /var/www/bildungsplan/system_prompt.txt
pm2 restart bildungsplan_assistent
```

---

## Projektstruktur

```
bildungsplan_chat/
├── Bildungsplan_PDFs/      ← PDFs hier ablegen (nicht im Git)
├── chroma_db/              ← Vektordatenbank, wird von ingest.py erzeugt (nicht im Git)
├── templates/
│   └── index.html          ← Chat-Oberfläche (deutsch)
├── static/
│   └── style.css           ← Styles (dunkles Theme, passend zu eulenai.de)
├── server.js               ← Express-Backend, Streaming-Chat, RAG-Integration
├── query_helper.py         ← ChromaDB-Suche (wird von server.js aufgerufen)
├── ingest.py               ← PDF → Chunks → Embeddings → ChromaDB
├── system_prompt.txt       ← Anweisungen für den Assistenten
├── ecosystem.config.js     ← PM2-Konfiguration
├── deploy.sh               ← Deployment-Skript
├── nginx_bildungsplan.conf ← nginx-Konfigurationsvorlage
├── package.json
├── requirements.txt        ← Python-Abhängigkeiten
└── .env.example            ← Vorlage für Umgebungsvariablen
```

---

## Modell & Kosten

Der Assistent verwendet standardmäßig `mistral-small-latest` – das ist das kostengünstigste Mistral-Modell und für diesen Anwendungsfall völlig ausreichend. Das Modell kann in `.env` geändert werden:

```env
# Kostenlos / günstig:
MISTRAL_MODEL=mistral-small-latest

# Leistungsfähiger (kostenpflichtig):
MISTRAL_MODEL=mistral-large-latest
```

Die Embeddings (`mistral-embed`) werden **nur bei der Ingestion** und pro Nutzeranfrage (für die Suche) verwendet, nicht für den Chat selbst.
