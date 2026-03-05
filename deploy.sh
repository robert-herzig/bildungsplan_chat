#!/bin/bash
# Deployment-Skript für den Bildungsplan GENT Assistenten
# Führt alle Schritte aus, um die App auf dem Server zu deployen.

set -e

APP_NAME="bildungsplan_assistent"
DEPLOY_DIR="/var/www/bildungsplan"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🎓 Bildungsplan GENT Assistent – Deployment"
echo "============================================="

# 1. Verzeichnis erstellen
echo ""
echo "📁 Erstelle Deployment-Verzeichnis..."
sudo mkdir -p "$DEPLOY_DIR"
sudo chown -R "$USER:$USER" "$DEPLOY_DIR"

# 2. Dateien kopieren
echo "📋 Kopiere Dateien..."
cp "$SOURCE_DIR/server.js" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/package.json" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/query_helper.py" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/ingest.py" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/system_prompt.txt" "$DEPLOY_DIR/"
cp "$SOURCE_DIR/ecosystem.config.js" "$DEPLOY_DIR/"
cp -r "$SOURCE_DIR/templates" "$DEPLOY_DIR/"
cp -r "$SOURCE_DIR/static" "$DEPLOY_DIR/"

# .env kopieren (nur wenn nicht schon vorhanden)
if [ ! -f "$DEPLOY_DIR/.env" ]; then
    if [ -f "$SOURCE_DIR/.env" ]; then
        cp "$SOURCE_DIR/.env" "$DEPLOY_DIR/"
    else
        cp "$SOURCE_DIR/.env.example" "$DEPLOY_DIR/.env"
        echo "⚠️  Bitte MISTRAL_API_KEY in $DEPLOY_DIR/.env setzen!"
    fi
fi

# Bildungsplan PDFs verlinken/kopieren
if [ -d "$SOURCE_DIR/Bildungsplan_PDFs" ]; then
    cp -r "$SOURCE_DIR/Bildungsplan_PDFs" "$DEPLOY_DIR/" 2>/dev/null || true
fi

# ChromaDB kopieren (falls vorhanden)
if [ -d "$SOURCE_DIR/chroma_db" ]; then
    echo "💾 Kopiere ChromaDB..."
    cp -r "$SOURCE_DIR/chroma_db" "$DEPLOY_DIR/"
fi

# 3. npm install
echo ""
echo "📦 Installiere npm-Pakete..."
cd "$DEPLOY_DIR"
npm install --production

# 4. Python-Abhängigkeiten
echo ""
echo "🐍 Prüfe Python-Abhängigkeiten..."
pip3 install --user pymupdf chromadb python-dotenv 2>/dev/null || {
    echo "⚠️  Python-Pakete konnten nicht installiert werden."
    echo "   Bitte manuell installieren: pip3 install pymupdf chromadb python-dotenv"
}

# 5. PM2 starten/neustarten
echo ""
echo "🚀 Starte/Neustarte PM2-Prozess..."
pm2 describe "$APP_NAME" > /dev/null 2>&1 && {
    pm2 restart "$APP_NAME"
} || {
    cd "$DEPLOY_DIR"
    pm2 start ecosystem.config.js
}
pm2 save

echo ""
echo "✅ Deployment abgeschlossen!"
echo ""
echo "   App läuft auf: http://127.0.0.1:5001"
echo ""
echo "   Nächste Schritte:"
echo "   1. Falls noch nicht geschehen, MISTRAL_API_KEY in $DEPLOY_DIR/.env setzen"
echo "   2. PDFs indexieren: cd $DEPLOY_DIR && python3 ingest.py"
echo "   3. Nginx-Config hinzufügen (siehe nginx_bildungsplan.conf)"
echo "   4. sudo nginx -t && sudo systemctl reload nginx"
echo "   5. Zugriff über: https://eulenai.de/bildungsplan/"
