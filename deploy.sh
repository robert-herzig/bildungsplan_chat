#!/bin/bash
# ── EulenAI – Unified Deployment Script ──────────────────────
# Deploys all tools (Bildungsplan + Leichte Sprache + Landing)

set -e

DEPLOY_DIR="/var/www/eulenai"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🦉 EulenAI – Deployment"
echo "========================"

# 1. Create deployment directory
echo ""
echo "📁 Erstelle Deployment-Verzeichnis..."
sudo mkdir -p "$DEPLOY_DIR"/{bildungsplan,leichte-sprache,unterrichtsplanung,landing,shared/static/img}
sudo chown -R "$USER:$USER" "$DEPLOY_DIR"

# ── Gateway server ─────────────────────────────────────────
echo "📋 Kopiere Gateway-Server..."
cp "$SOURCE_DIR/server.js" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/package.json" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/package-lock.json" "$DEPLOY_DIR/" 2>/dev/null || true

# ── Shared assets ──────────────────────────────────────────
echo "📋 Kopiere gemeinsame Assets..."
cp -r "$SOURCE_DIR/shared/static/"* "$DEPLOY_DIR/shared/static/"
cp "$SOURCE_DIR/landing/index.html" "$DEPLOY_DIR/landing/"
cp "$SOURCE_DIR/landing/login.html" "$DEPLOY_DIR/landing/"

# ── .env (shared, only if not present) ─────────────────────
if [ ! -f "$DEPLOY_DIR/.env" ]; then
    if [ -f "$SOURCE_DIR/.env" ]; then
        cp "$SOURCE_DIR/.env" "$DEPLOY_DIR/"
    else
        cp "$SOURCE_DIR/.env.example" "$DEPLOY_DIR/.env"
        echo "⚠️  Bitte MISTRAL_API_KEY in $DEPLOY_DIR/.env setzen!"
    fi
fi

# ── Gateway npm install ───────────────────────────────────
echo ""
echo "📦 Installiere Gateway npm-Pakete..."
cd "$DEPLOY_DIR"
npm install --production

# ── Bildungsplan ───────────────────────────────────────────
echo ""
echo "📋 Kopiere Bildungsplan-Dateien..."
cp "$SOURCE_DIR/bildungsplan/server.js" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/package.json" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/query_helper.py" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/ingest.py" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/system_prompt.txt" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/tts_server.py" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/tts_helper.py" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/stt_helper.py" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/conversation_presets.json" "$DEPLOY_DIR/bildungsplan/"
cp "$SOURCE_DIR/bildungsplan/web_search.py" "$DEPLOY_DIR/bildungsplan/"
cp -r "$SOURCE_DIR/bildungsplan/templates" "$DEPLOY_DIR/bildungsplan/"
cp -r "$SOURCE_DIR/bildungsplan/static" "$DEPLOY_DIR/bildungsplan/"

# Preserve user data files
for f in users.json memories.json conversations.json; do
    if [ ! -f "$DEPLOY_DIR/bildungsplan/$f" ]; then
        cp "$SOURCE_DIR/bildungsplan/$f" "$DEPLOY_DIR/bildungsplan/" 2>/dev/null || true
    fi
done

# Bildungsplan PDFs & ChromaDB
if [ -d "$SOURCE_DIR/bildungsplan/Bildungsplan_PDFs" ]; then
    cp -r "$SOURCE_DIR/bildungsplan/Bildungsplan_PDFs" "$DEPLOY_DIR/bildungsplan/" 2>/dev/null || true
fi
if [ -d "$SOURCE_DIR/bildungsplan/chroma_db" ]; then
    echo "💾 Kopiere ChromaDB..."
    cp -r "$SOURCE_DIR/bildungsplan/chroma_db" "$DEPLOY_DIR/bildungsplan/"
fi

echo "📦 Installiere Bildungsplan npm-Pakete..."
cd "$DEPLOY_DIR/bildungsplan"
npm install --production

# ── Leichte Sprache ───────────────────────────────────────
echo ""
echo "📋 Kopiere Leichte-Sprache-Dateien..."
cp "$SOURCE_DIR/leichte-sprache/server.js" "$DEPLOY_DIR/leichte-sprache/"
cp "$SOURCE_DIR/leichte-sprache/package.json" "$DEPLOY_DIR/leichte-sprache/"
cp "$SOURCE_DIR/leichte-sprache/system_prompt_leichte.txt" "$DEPLOY_DIR/leichte-sprache/"
cp "$SOURCE_DIR/leichte-sprache/system_prompt_einfache.txt" "$DEPLOY_DIR/leichte-sprache/"
cp "$SOURCE_DIR/leichte-sprache/system_prompt_cleanup.txt" "$DEPLOY_DIR/leichte-sprache/"
cp -r "$SOURCE_DIR/leichte-sprache/templates" "$DEPLOY_DIR/leichte-sprache/"
cp -r "$SOURCE_DIR/leichte-sprache/static" "$DEPLOY_DIR/leichte-sprache/"

echo "📦 Installiere Leichte-Sprache npm-Pakete..."
cd "$DEPLOY_DIR/leichte-sprache"
npm install --production
# ── Unterrichtsplanung ─────────────────────────────────────────
echo ""
echo "📋 Kopiere Unterrichtsplanung-Dateien..."
cp "$SOURCE_DIR/unterrichtsplanung/server.js" "$DEPLOY_DIR/unterrichtsplanung/"
cp "$SOURCE_DIR/unterrichtsplanung/package.json" "$DEPLOY_DIR/unterrichtsplanung/"
cp "$SOURCE_DIR/unterrichtsplanung/system_prompt.txt" "$DEPLOY_DIR/unterrichtsplanung/"
cp "$SOURCE_DIR/unterrichtsplanung/web_search.py" "$DEPLOY_DIR/unterrichtsplanung/"
mkdir -p "$DEPLOY_DIR/unterrichtsplanung/templates" "$DEPLOY_DIR/unterrichtsplanung/static"
cp -r "$SOURCE_DIR/unterrichtsplanung/templates" "$DEPLOY_DIR/unterrichtsplanung/"
cp -r "$SOURCE_DIR/unterrichtsplanung/static" "$DEPLOY_DIR/unterrichtsplanung/"

echo "📦 Installiere Unterrichtsplanung npm-Pakete..."
cd "$DEPLOY_DIR/unterrichtsplanung"
npm install --production
# ── Python dependencies ───────────────────────────────────
echo ""
echo "🐍 Prüfe Python-Abhängigkeiten..."
pip3 install --user pymupdf chromadb python-dotenv edge-tts ddgs 2>/dev/null || {
    echo "⚠️  Python-Pakete konnten nicht installiert werden."
    echo "   Bitte manuell installieren: pip3 install pymupdf chromadb python-dotenv edge-tts ddgs"
}

# ── PM2 ───────────────────────────────────────────────────
echo ""
echo "✨ Starte/Neustarte PM2-Prozesse..."
cp "$SOURCE_DIR/ecosystem.config.js" "$DEPLOY_DIR/"

pm2 describe "bildungsplan" > /dev/null 2>&1 && {
    pm2 restart "bildungsplan"
} || {
    cd "$DEPLOY_DIR"
    pm2 start ecosystem.config.js --only "bildungsplan"
}

pm2 describe "leichte-sprache" > /dev/null 2>&1 && {
    pm2 restart "leichte-sprache"
} || {
    cd "$DEPLOY_DIR"
    pm2 start ecosystem.config.js --only "leichte-sprache"
}

pm2 describe "unterrichtsplanung" > /dev/null 2>&1 && {
    pm2 restart "unterrichtsplanung"
} || {
    cd "$DEPLOY_DIR"
    pm2 start ecosystem.config.js --only "unterrichtsplanung"
}

pm2 describe "gateway" > /dev/null 2>&1 && {
    pm2 restart "gateway"
} || {
    cd "$DEPLOY_DIR"
    pm2 start ecosystem.config.js --only "gateway"
}

pm2 save

echo ""
echo "✅ Deployment abgeschlossen!"
echo ""
echo "   Gateway:          http://127.0.0.1:3000  →  / (nginx)"
echo "   Bildungsplan:     http://127.0.0.1:5001  →  /bildungsplan/"
echo "   Leichte Sprache:  http://127.0.0.1:5000  →  /leichte-sprache/"
echo "   Unterrichtspl.:   http://127.0.0.1:5002  →  /unterrichtsplanung/"
echo ""
echo "   Nächste Schritte:"
echo "   1. Nginx-Config aktualisieren (siehe nginx.conf)"
echo "   2. sudo nginx -t && sudo systemctl reload nginx"
echo "   3. Zugriff über: https://eulenai.de/"
