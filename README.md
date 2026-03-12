# 🦉 EulenAI – KI-Werkzeuge für Lehrkräfte

Eine Sammlung KI-gestützter Werkzeuge für Lehrkräfte an SBBZ in Baden-Württemberg, Förderschwerpunkt **Geistige Entwicklung (GENT)**. Die Plattform bietet einen Bildungsplan-Assistenten, einen Elterngespräch-Simulator, einen Leichte-Sprache-Übersetzer und ein Notizen-Werkzeug – alles hinter einem zentralen Authentifizierungs-Gateway.

**Live:** [https://eulenai.de/](https://eulenai.de/)

---

## Überblick: Werkzeuge

| Werkzeug | URL | Beschreibung |
|---|---|---|
| 📚 **Bildungsplan-Assistent** | `/bildungsplan/` | RAG-Chat mit dem Bildungsplan 2022 GENT |
| 🗣️ **Elterngespräch-Simulator** | `/bildungsplan/conversation` | Rollenspiel-Training für Elterngespräche |
| 🌿 **Leichte & Einfache Sprache** | `/leichte-sprache/` | Texte in Leichte/Einfache Sprache übersetzen |
| ✏️ **Notizen ausformulieren** | `/leichte-sprache/notizen` | Stichpunkte zu professionellen Texten |

---

## Architektur

```
Browser / nginx (HTTPS :443)
        │
        ▼
  server.js – Gateway (Port 3000)
  ├── Zentrales Login / Session-Management
  ├── Proxy → bildungsplan (Port 5001)
  └── Proxy → leichte-sprache (Port 5000)
        │                     │
        ▼                     ▼
  bildungsplan/           leichte-sprache/
  server.js               server.js
  ├── RAG-Chat            ├── Paraphrase (Leichte/Einfache Sprache)
  ├── Elterngespräch      └── Notizen ausformulieren
  ├── TTS / STT
  ├── Speicher (Memories)
  └── Admin-Panel
        │
        ▼
  query_helper.py  ←  chroma_db/  ←  ingest.py  ←  Bildungsplan_PDFs/
```

**PM2-Prozesse** (verwaltet via `ecosystem.config.js`):
- `gateway` – Root-Gateway, Auth, Proxy
- `bildungsplan` – Bildungsplan & Elterngespräch
- `leichte-sprache` – Leichte Sprache & Notizen

---

## Features im Detail

### 📚 Bildungsplan-Assistent (`/bildungsplan/`)

- **Hybrid-RAG**: Kombination aus ChromaDB-Dokumentensuche (Mistral Embeddings) und DuckDuckGo-Websuche. Kurze oder konversationelle Nachrichten überspringen das RAG automatisch.
- **Query-Reformulierung**: Eine schnelle LLM-Vorablaufschicht reformuliert die Nutzerfrage in eine optimale Suchanfrage bevor ChromaDB abgefragt wird.
- **Streaming-Antworten**: Token-für-Token-Ausgabe via Server-Sent Events; Quellen erscheinen erst nach der Antwort.
- **Quellenangaben**: Nummerierte Belege aus den PDF-Dokumenten sowie Weblinks werden nach jeder Antwort aufgelistet.
- **Mermaid-Diagramme**: Antworten können Flowcharts als interaktive Mermaid-Grafiken enthalten; diese lassen sich als PNG exportieren.
- **Sprachein- / -ausgabe (STT / TTS)**:
  - 🎙️-Taste oder Leertaste aktiviert die Aufnahme (Whisper via Mistral STT-API)
  - Antworten werden bei Sprachsteuerung automatisch vorgelesen (TTS via `tts_helper.py`)
  - Laufende Wiedergabe kann durch erneutes Drücken der Mikrofontaste unterbrochen werden
- **Gesprächsgedächtnis (Memories)**:
  - 🧠 **Merken**-Taste: zeigt eine Review-Maske mit Checkboxen, in der extrahierte Fakten vor dem Speichern bearbeitet werden können
  - Automatische stille Extraktion beim Beenden / Verlassen des Chats (kein Modal)
  - Memories werden in jedem neuen Chat im System-Prompt berücksichtigt
  - Verwaltung gespeicherter Erinnerungen über das Speicher-Panel (editierbar & löschbar)
- **Gesprächshistorie**: Alle Chats werden pro Nutzer persistent gespeichert und können über die linke Seitenleiste geladen werden (max. 50 Gespräche).
- **System-Prompt**: Über ⚙ jederzeit anpassbar, pro Nutzer gespeichert.
- **Mobil-optimiert**: Vollresponsive Oberfläche, Overflow-Schutz, dynamische Viewport-Höhe.

### 🗣️ Elterngespräch-Simulator (`/bildungsplan/conversation`)

- Rollenspiel: Die KI übernimmt die Rolle eines Elternteils (verschiedene Persönlichkeiten mit Szenariobeschreibung), die Lehrkraft übt die Gesprächsführung.
- **Sprachsteuerung**: Aufnahme per 🎙️-Taste / Leertaste, automatischer Stopp bei Sprechpause.
- **TTS-Antworten**: Das simulierte Elternteil antwortet akustisch; Wiedergabe kann unterbrochen werden.
- **Vorgaben (Presets)**: Mitgelieferte und eigene Persona-/Szenariodefinitionen; eigene Presets erstellbar.
- **Gesprächshistorie**: Per-Nutzer-Speicherung mit Seitenleiste zum Laden früherer Übungsgespräche.
- **Eigenes Modell konfigurierbar**: Admin kann das Konversationsmodell separat vom RAG-Modell einstellen.

### 🌿 Leichte & Einfache Sprache (`/leichte-sprache/`)

- Zwei Tabs: **Leichte Sprache** (vereinfacht nach den Regeln für Leichte Sprache) und **Einfache Sprache** (klar und verständlich, aber weniger strikt).
- Streaming-Ausgabe mit Fortschrittsanzeige.
- **Verlaufsleiste**: Overlay-Seitenleiste (linke Seite) mit Verlauf der übersetzen Texte; ✕-Schaltfläche zum Schließen.
- System-Prompt über ⚙ anpassbar.

### ✏️ Notizen ausformulieren (`/leichte-sprache/notizen`)

- Verwandelt Stichpunkte und rohe Notizen in fehlerfreie, professionelle Texte (z. B. für Berichte, E-Mails, Protokolle).
- Verlaufsleiste analog zu Leichte Sprache.

### 🔒 Authentifizierung & Nutzerverwaltung

- Zentrales Login über das Gateway (`/login`); Session-Cookie (`eulenai.sid`) mit `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Persistente Sessions**: Session-Dateien (`sessions/`) überleben Server-Neustarts; stabile `SESSION_SECRET` in `.env`.
- Per-Nutzer-Daten: Memories, Gesprächshistorie, System-Prompt (`memories.json`, `conversations.json`).
- **Admin-Panel** (nur für `admin`-Account): Nutzerverwaltung (erstellen / löschen), Modellauswahl (Chat-Modell & Konversationsmodell separat), API-Schlüssel ändern – alles über ein Modal im Browser.
- Passwort-Änderung für alle Nutzer über `/auth/change-password`.

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

Dann `.env` öffnen und anpassen:

```env
MISTRAL_API_KEY=dein_api_key_hier
MISTRAL_MODEL=mistral-medium-latest
PDF_FOLDER=./Bildungsplan_PDFs
CHROMA_DB_PATH=./chroma_db
TOP_K=8
PORT=5001
HOST=127.0.0.1
SESSION_SECRET=ein-langes-zufaelliges-geheimnis
```

> **Wichtig:** `SESSION_SECRET` muss stabil sein (nicht `Date.now()` o. ä.), damit Sessions Server-Neustarts überleben.

### 4. Abhängigkeiten installieren

```bash
# Node.js (im Projekt-Root – installiert Gateway + alle Sub-Apps)
npm install

# Python
pip3 install --user pymupdf chromadb python-dotenv
```

### 5. PDFs einfügen und indexieren

Bildungsplan-PDFs in `bildungsplan/Bildungsplan_PDFs/` legen und dann:

```bash
cd bildungsplan
python3 ingest.py
```

Die Ingestion erzeugt Embeddings über die Mistral-API und speichert alles in ChromaDB. Bei ~22 PDFs dauert das ca. 5–10 Minuten; ein eingebauter Retry-Mechanismus behandelt Rate-Limits automatisch.

> `ingest.py` löscht und erstellt die ChromaDB-Collection bei jedem Lauf komplett neu.

### 6. Server starten (Entwicklung)

```bash
# Gateway (startet auf Port 3000)
node server.js

# In weiteren Terminals:
cd bildungsplan && node server.js   # Port 5001
cd leichte-sprache && node server.js # Port 5000
```

Oder alle auf einmal via PM2:

```bash
pm2 start ecosystem.config.js
```

---

## Deployment auf dem Server (eulenai.de)

### Deployen / aktualisieren

```bash
bash deploy.sh
```

Das Skript kopiert alle Dateien nach `/var/www/eulenai/`, führt `npm install --production` aus und startet alle drei PM2-Prozesse neu.

### nginx-Konfiguration

Die aktive Konfiguration liegt unter `/etc/nginx/sites-enabled/eulenai`. Alles wird über den Gateway-Port 3000 geleitet:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### PM2-Status prüfen

```bash
pm2 list
pm2 logs gateway
pm2 logs bildungsplan
pm2 logs leichte-sprache
```

---

## Neue PDFs hinzufügen / Re-Indexieren

```bash
# 1. PDF in den Ordner legen
cp neue_datei.pdf bildungsplan/Bildungsplan_PDFs/

# 2. Neu indexieren
cd /home/herzi/mistral_schoolstuff/bildungsplan
python3 ingest.py

# 3. Auf den Server deployen
bash deploy.sh
```

---

## System-Prompt anpassen

Jeder Nutzer hat seinen eigenen System-Prompt, der über das ⚙-Symbol in der Oberfläche bearbeitet werden kann. Alternativ direkt auf dem Server:

```bash
nano /var/www/eulenai/bildungsplan/system_prompt.txt
pm2 restart bildungsplan
```

---

## Projektstruktur

```
mistral_schoolstuff/
├── server.js                   ← Gateway: Auth, Session, Proxy (Port 3000)
├── sessions/                   ← Persistente Session-Dateien (nicht im Git)
├── ecosystem.config.js         ← PM2-Konfiguration (gateway, bildungsplan, leichte-sprache)
├── deploy.sh                   ← Deployment-Skript
├── package.json
├── .env                        ← Geheime Konfiguration (nicht im Git)
│
├── landing/
│   ├── index.html              ← Startseite (nach Login)
│   └── login.html              ← Login-Seite
│
├── shared/
│   └── static/img/             ← Gemeinsam genutzte Assets (Logo etc.)
│
├── bildungsplan/
│   ├── server.js               ← Express-Backend (Port 5001): Chat, RAG, Auth, Admin
│   ├── ingest.py               ← PDF → Chunks → Embeddings → ChromaDB
│   ├── query_helper.py         ← ChromaDB-Suche (wird von server.js aufgerufen)
│   ├── web_search.py           ← DuckDuckGo-Websuche (Python-Helfer)
│   ├── stt_helper.py           ← Sprache-zu-Text via Mistral API
│   ├── tts_helper.py           ← Text-zu-Sprache
│   ├── tts_server.py           ← TTS-Server-Helfer
│   ├── system_prompt.txt       ← Standard-System-Prompt
│   ├── users.json              ← Nutzerdaten (nicht im Git)
│   ├── conversations.json      ← Gesprächshistorie aller Nutzer (nicht im Git)
│   ├── memories.json           ← Gespeicherte Erinnerungen aller Nutzer (nicht im Git)
│   ├── conversation_presets.json       ← Eingebaute Elterngespräch-Personas
│   ├── Bildungsplan_PDFs/      ← PDFs hier ablegen (nicht im Git)
│   ├── chroma_db/              ← Vektordatenbank (nicht im Git)
│   ├── templates/
│   │   ├── index.html          ← Bildungsplan-Chat-Oberfläche
│   │   ├── conversation.html   ← Elterngespräch-Simulator
│   │   └── login.html          ← (Sub-App-Login, nicht aktiv genutzt)
│   └── static/
│       ├── style.css           ← Bildungsplan-Styles
│       └── conversation.css    ← Elterngespräch-Styles
│
├── leichte-sprache/
│   ├── server.js               ← Express-Backend (Port 5000): Paraphrase, Notizen
│   ├── templates/
│   │   ├── index.html          ← Leichte & Einfache Sprache
│   │   └── notizen.html        ← Notizen ausformulieren
│   └── static/
│       └── style.css           ← Leichte-Sprache-Styles
│
└── requirements.txt            ← Python-Abhängigkeiten
```
