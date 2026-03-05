/* Bildungsplan GENT Assistent – Node.js server (Express)
   Matches the existing eulenai.de deployment pattern.
   Runs on PORT 5001, proxied via nginx at /bildungsplan/ */

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const { ChromaClient } = require("chromadb");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── Config ──────────────────────────────────────────────────────────
const API_BASE = process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1";
const API_KEY = process.env.MISTRAL_API_KEY;
const MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";
const CHROMA_DB_PATH = process.env.CHROMA_DB_PATH || "./chroma_db";
const COLLECTION_NAME = "bildungsplan";
const TOP_K = parseInt(process.env.TOP_K || "8", 10);
const PORT = parseInt(process.env.PORT || "5001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TIMEOUT = parseInt(process.env.MODEL_TIMEOUT || "120", 10) * 1000;

const SYSTEM_PROMPT_PATH = path.join(__dirname, "system_prompt.txt");
const DEFAULT_SYSTEM_PROMPT = `Du bist ein hilfreicher Assistent für Lehrkräfte an einem SBBZ (Sonderpädagogisches Bildungs- und Beratungszentrum) in Baden-Württemberg, Förderschwerpunkt Geistige Entwicklung (GENT).

Du hast Zugriff auf Auszüge aus dem Bildungsplan 2022 für den Förderschwerpunkt GENT. Nutze diese Informationen, um die Fragen der Lehrkraft präzise und hilfreich zu beantworten.

Wichtige Regeln:
- Antworte immer auf Deutsch.
- Beziehe dich auf die bereitgestellten Quellen, wenn möglich.
- Nenne die Quelle (Dokument und Seite), wenn du dich auf spezifische Inhalte beziehst.
- Wenn die bereitgestellten Quellen die Frage nicht beantworten können, sage das ehrlich.
- Sei praxisorientiert und gib konkrete, umsetzbare Hinweise für den Unterricht.
- Verwende eine professionelle, aber zugängliche Sprache.`;

// ── Static files & HTML ─────────────────────────────────────────────
app.use("/static", express.static(path.join(__dirname, "static")));

app.get("/", async (req, res) => {
  try {
    const html = await fs.readFile(
      path.join(__dirname, "templates", "index.html"),
      "utf-8"
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Seite.");
  }
});

// ── Helpers ─────────────────────────────────────────────────────────
async function readSystemPrompt() {
  try {
    return await fs.readFile(SYSTEM_PROMPT_PATH, "utf-8");
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

let chromaCollection = null;

async function getCollection() {
  if (chromaCollection) return chromaCollection;
  try {
    const client = new ChromaClient({ path: undefined });
    // For persistent client we use the chromadb npm with path config
    // Actually chromadb JS client connects to a running Chroma server.
    // We'll query the DB directly via the REST API or use a simpler approach.
    // Since we store with Python, let's query via file-based approach.
    chromaCollection = "placeholder";
    return chromaCollection;
  } catch (e) {
    console.error("ChromaDB Fehler:", e.message);
    return null;
  }
}

async function getQueryEmbedding(text) {
  const resp = await fetch(API_BASE + "/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + API_KEY,
    },
    body: JSON.stringify({
      model: "mistral-embed",
      input: [text],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Embedding-Fehler: " + err);
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

// Cosine similarity
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Direct ChromaDB file-based query using the SQLite + parquet files
// Since chromadb JS client needs a server, we'll run a tiny Python helper
async function queryChromaDB(queryText, topK) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "python3",
      [path.join(__dirname, "query_helper.py"), queryText, String(topK)],
      { cwd: __dirname, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error("ChromaDB query error:", stderr);
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          console.error("JSON parse error:", stdout);
          resolve([]);
        }
      }
    );
  });
}

function formatContext(chunks) {
  if (!chunks || chunks.length === 0) {
    return "Es wurden keine relevanten Informationen in den Dokumenten gefunden.";
  }
  return chunks
    .map(
      (c, i) =>
        `[Quelle: ${c.source}, Seite ${c.page}]\n${c.text}`
    )
    .join("\n\n---\n\n");
}

// ── API endpoints ───────────────────────────────────────────────────

// System prompt management (same pattern as paraphrase_bot)
app.get("/system_prompt", async (req, res) => {
  const prompt = await readSystemPrompt();
  res.json({ prompt });
});

app.post("/system_prompt", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Kein Prompt angegeben." });
  try {
    await fs.writeFile(SYSTEM_PROMPT_PATH, prompt, "utf-8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Fehler beim Speichern." });
  }
});

// Chat endpoint (non-streaming)
app.post("/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "Keine Nachricht." });

  try {
    // 1. RAG retrieval
    const chunks = await queryChromaDB(message, TOP_K);
    const context = formatContext(chunks);

    // 2. Build messages
    const systemPrompt = await readSystemPrompt();
    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history (last 20 messages)
    if (history && Array.isArray(history)) {
      const recentHistory = history.slice(-20);
      messages.push(...recentHistory);
    }

    // User message with RAG context
    const augmentedMessage =
      `Kontext aus dem Bildungsplan:\n\n${context}\n\n---\n\nFrage der Lehrkraft: ${message}`;
    messages.push({ role: "user", content: augmentedMessage });

    // 3. Call Mistral
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API_KEY,
      },
      body: JSON.stringify({ model: MODEL, messages }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: "Mistral-Fehler: " + errText });
    }

    const data = await resp.json();
    const answer = data.choices[0].message.content;

    // 4. Prepare sources
    const sources = [];
    const seen = new Set();
    for (const c of chunks) {
      const key = c.source + "::" + c.page;
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({ source: c.source, page: c.page });
      }
    }

    res.json({ answer, sources });
  } catch (e) {
    console.error("Chat error:", e);
    res.status(500).json({ error: e.message || "Interner Fehler." });
  }
});

// Streaming chat endpoint
app.get("/chat_stream", async (req, res) => {
  const message = req.query.message;
  const historyRaw = req.query.history;
  if (!message) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: ERROR:Keine Nachricht.\n\n");
    return res.end();
  }

  let history = [];
  try {
    if (historyRaw) history = JSON.parse(historyRaw);
  } catch {}

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    // 1. RAG retrieval
    const chunks = await queryChromaDB(message, TOP_K);
    const context = formatContext(chunks);

    // Send sources first
    const sources = [];
    const seen = new Set();
    for (const c of chunks) {
      const key = c.source + "::" + c.page;
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({ source: c.source, page: c.page });
      }
    }
    res.write("data: " + JSON.stringify({ type: "sources", sources }) + "\n\n");

    // 2. Build messages
    const systemPrompt = await readSystemPrompt();
    const messages = [{ role: "system", content: systemPrompt }];
    if (history && Array.isArray(history)) {
      messages.push(...history.slice(-20));
    }
    const augmentedMessage =
      `Kontext aus dem Bildungsplan:\n\n${context}\n\n---\n\nFrage der Lehrkraft: ${message}`;
    messages.push({ role: "user", content: augmentedMessage });

    // 3. Stream from Mistral
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API_KEY,
      },
      body: JSON.stringify({ model: MODEL, messages, stream: true }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      res.write("data: ERROR:" + errText + "\n\n");
      return res.end();
    }

    let fullText = "";
    const reader = resp.body;
    let buffer = "";

    reader.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          res.write("data: [DONE]\n\n");
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (delta && delta.content) {
            fullText += delta.content;
            res.write("data: " + JSON.stringify(fullText) + "\n\n");
          }
        } catch {}
      }
    });

    reader.on("end", () => {
      res.write("data: [DONE]\n\n");
      res.end();
    });

    reader.on("error", (err) => {
      res.write("data: ERROR:" + err.message + "\n\n");
      res.end();
    });

    req.on("close", () => {
      controller.abort();
    });
  } catch (e) {
    res.write("data: ERROR:" + e.message + "\n\n");
    res.end();
  }
});

// DB info endpoint
app.get("/db_info", async (req, res) => {
  try {
    const { execFile } = require("child_process");
    execFile(
      "python3",
      [path.join(__dirname, "query_helper.py"), "--info"],
      { cwd: __dirname, timeout: 10000 },
      (err, stdout) => {
        if (err) return res.json({ count: 0, error: "DB nicht verfügbar" });
        try {
          res.json(JSON.parse(stdout));
        } catch {
          res.json({ count: 0 });
        }
      }
    );
  } catch (e) {
    res.json({ count: 0, error: e.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🎓 Bildungsplan-Assistent läuft auf http://${HOST}:${PORT}`);
  console.log(`   Modell: ${MODEL}`);
});
