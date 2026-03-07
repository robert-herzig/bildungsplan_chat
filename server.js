/* Bildungsplan GENT Assistent – Node.js server (Express)
   Matches the existing eulenai.de deployment pattern.
   Runs on PORT 5001, proxied via nginx at /bildungsplan/ */

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const { execFile } = require("child_process");

const app = express();
app.use(express.json({ limit: "25mb" }));

// ── Config ──────────────────────────────────────────────────────────
const API_BASE = process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1";
const API_KEY = process.env.MISTRAL_API_KEY;
const MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";
const CHROMA_DB_PATH = process.env.CHROMA_DB_PATH || "./chroma_db";
const COLLECTION_NAME = "bildungsplan";
const TOP_K = parseInt(process.env.TOP_K || "8", 10);
const MIN_RELEVANCE_SCORE = parseFloat(process.env.MIN_RELEVANCE_SCORE || "0.79");
const PORT = parseInt(process.env.PORT || "5001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TIMEOUT = parseInt(process.env.MODEL_TIMEOUT || "120", 10) * 1000;
const CONV_MODEL = process.env.CONV_MODEL || "mistral-medium-latest";
const PRESETS_PATH = path.join(__dirname, "conversation_presets.json");
const CUSTOM_PRESETS_PATH = path.join(__dirname, "conversation_presets_custom.json");
const TMP_DIR = "/tmp";

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

// ── RAG & search helpers ────────────────────────────────────────────

/** Short or clearly conversational messages – skip RAG entirely */
function isConversational(msg) {
  const t = msg.trim();
  if (t.length < 20) return true;
  if (/^(test|hallo|hi|hey|danke|ok|okay|ja|nein|bitte|super|gut|tschüss|ciao|moin|servus|guten\s+\w+)[\s!?.]*$/i.test(t)) return true;
  return false;
}

/** Query ChromaDB via the Python helper script */
async function queryChromaDB(queryText, topK) {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [path.join(__dirname, "query_helper.py"), queryText, String(topK)],
      { cwd: __dirname, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) { console.error("ChromaDB query error:", stderr); resolve([]); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { console.error("JSON parse error:", stdout); resolve([]); }
      }
    );
  });
}

/** DuckDuckGo web search via the Python helper script */
async function searchWeb(query, maxResults = 4) {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [path.join(__dirname, "web_search.py"), query, String(maxResults)],
      { cwd: __dirname, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) { console.error("Web search error:", stderr || err.message); resolve([]); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve([]); }
      }
    );
  });
}

function formatDocContext(chunks) {
  return chunks
    .map((c) => `[Quelle: ${c.source}, Seite ${c.page}]\n${c.text}`)
    .join("\n\n---\n\n");
}

function formatWebResults(results) {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");
}

/**
 * Central context builder.
 * Returns { contextText, chunks, webResults, mode }
 * mode: 'docs' | 'web' | 'none'
 */
async function buildContext(message) {
  if (isConversational(message)) {
    return { contextText: "", chunks: [], webResults: [], mode: "none" };
  }

  // 1. Try document search
  const allChunks = await queryChromaDB(message, TOP_K);
  const chunks = allChunks.filter((c) => c.score >= MIN_RELEVANCE_SCORE);

  if (chunks.length > 0) {
    return {
      contextText: `Relevante Auszüge aus dem Bildungsplan GENT:\n\n${formatDocContext(chunks)}`,
      chunks,
      webResults: [],
      mode: "docs",
    };
  }

  // 2. Fallback: web search
  const webResults = await searchWeb(message, 4);
  if (webResults.length > 0) {
    return {
      contextText: `Ergebnisse aus der Websuche:\n\n${formatWebResults(webResults)}`,
      chunks: [],
      webResults,
      mode: "web",
    };
  }

  return { contextText: "", chunks: [], webResults: [], mode: "none" };
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
    // 1. Build context (docs → web → none)
    const { contextText, chunks, webResults, mode } = await buildContext(message);

    // 2. Build messages
    const systemPrompt = await readSystemPrompt();
    const messages = [{ role: "system", content: systemPrompt }];
    if (history && Array.isArray(history)) messages.push(...history.slice(-20));

    const augmentedMessage = contextText
      ? `${contextText}\n\n---\n\nFrage der Lehrkraft: ${message}`
      : message;
    messages.push({ role: "user", content: augmentedMessage });

    // 3. Call Mistral
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
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
      if (!seen.has(key)) { seen.add(key); sources.push({ source: c.source, page: c.page }); }
    }
    const webSources = webResults.map((r) => ({ title: r.title, url: r.url }));

    res.json({ answer, sources, webSources, mode });
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
    // 1. Build context (docs → web → none)
    const { contextText, chunks, webResults, mode } = await buildContext(message);

    // Send sources first so the UI can show them while streaming
    const sources = [];
    const seen = new Set();
    for (const c of chunks) {
      const key = c.source + "::" + c.page;
      if (!seen.has(key)) { seen.add(key); sources.push({ source: c.source, page: c.page }); }
    }
    const webSources = webResults.map((r) => ({ title: r.title, url: r.url }));
    res.write("data: " + JSON.stringify({ type: "sources", sources, webSources, mode }) + "\n\n");

    // 2. Build messages
    const systemPrompt = await readSystemPrompt();
    const messages = [{ role: "system", content: systemPrompt }];
    if (history && Array.isArray(history)) messages.push(...history.slice(-20));
    const augmentedMessage = contextText
      ? `${contextText}\n\n---\n\nFrage der Lehrkraft: ${message}`
      : message;
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

// ── Conversation Simulator ──────────────────────────────────────────

// Serve the conversation page
app.get("/conversation", async (req, res) => {
  try {
    const html = await fs.readFile(
      path.join(__dirname, "templates", "conversation.html"),
      "utf-8"
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Seite.");
  }
});

// Presets management
async function loadAllPresets() {
  let builtIn = [];
  try {
    const raw = await fs.readFile(PRESETS_PATH, "utf-8");
    builtIn = JSON.parse(raw).presets || [];
  } catch {}
  let custom = [];
  try {
    const raw = await fs.readFile(CUSTOM_PRESETS_PATH, "utf-8");
    custom = JSON.parse(raw) || [];
  } catch {}
  return [...builtIn, ...custom.map(p => ({ ...p, custom: true }))];
}

app.get("/conversation/presets", async (req, res) => {
  const presets = await loadAllPresets();
  res.json({ presets });
});

app.post("/conversation/presets/custom", async (req, res) => {
  const preset = req.body;
  if (!preset || !preset.id) return res.status(400).json({ error: "Ungültiges Preset." });
  let custom = [];
  try {
    const raw = await fs.readFile(CUSTOM_PRESETS_PATH, "utf-8");
    custom = JSON.parse(raw) || [];
  } catch {}
  custom.push(preset);
  await fs.writeFile(CUSTOM_PRESETS_PATH, JSON.stringify(custom, null, 2), "utf-8");
  res.json({ ok: true });
});

app.delete("/conversation/presets/custom/:id", async (req, res) => {
  let custom = [];
  try {
    const raw = await fs.readFile(CUSTOM_PRESETS_PATH, "utf-8");
    custom = JSON.parse(raw) || [];
  } catch {}
  custom = custom.filter(p => p.id !== req.params.id);
  await fs.writeFile(CUSTOM_PRESETS_PATH, JSON.stringify(custom, null, 2), "utf-8");
  res.json({ ok: true });
});

// STT – Speech to text via Voxtral
app.post("/conversation/stt", async (req, res) => {
  const { audio } = req.body;
  if (!audio) return res.status(400).json({ error: "Kein Audio." });

  const tmpFile = path.join(TMP_DIR, `stt_${Date.now()}.webm`);
  try {
    // Write base64 audio to temp file
    const buf = Buffer.from(audio, "base64");
    const fsSync = require("fs");
    fsSync.writeFileSync(tmpFile, buf);

    // Call Python STT helper
    const result = await new Promise((resolve) => {
      execFile(
        "python3",
        [path.join(__dirname, "stt_helper.py"), tmpFile, "de"],
        { cwd: __dirname, timeout: 60000, env: { ...process.env } },
        (err, stdout, stderr) => {
          if (err) {
            console.error("STT error:", stderr || err.message);
            resolve({ error: "Transkription fehlgeschlagen: " + (stderr || err.message) });
            return;
          }
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ error: "JSON-Fehler bei STT" }); }
        }
      );
    });

    // Clean up temp file
    try { fsSync.unlinkSync(tmpFile); } catch {}

    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (e) {
    try { require("fs").unlinkSync(tmpFile); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// TTS – Text to speech via edge-tts
app.post("/conversation/tts", async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: "Kein Text." });

  const ttsVoice = voice || "de-DE-KatjaNeural";
  const tmpFile = path.join(TMP_DIR, `tts_${Date.now()}.mp3`);

  try {
    const result = await new Promise((resolve) => {
      execFile(
        "python3",
        [path.join(__dirname, "tts_helper.py"), text, ttsVoice, tmpFile],
        { cwd: __dirname, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            console.error("TTS error:", stderr || err.message);
            resolve({ error: "TTS fehlgeschlagen" });
            return;
          }
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ error: "TTS JSON-Fehler" }); }
        }
      );
    });

    if (result.error) return res.status(500).json(result);

    // Stream audio file
    const fsSync = require("fs");
    const stat = fsSync.statSync(tmpFile);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    const stream = fsSync.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on("end", () => {
      try { fsSync.unlinkSync(tmpFile); } catch {}
    });
  } catch (e) {
    try { require("fs").unlinkSync(tmpFile); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// Conversation chat – uses mistral-medium with parent roleplay
const CONV_BASE_PROMPT = `Du spielst die Rolle eines Elternteils in einem Elterngespräch an einem SBBZ (Sonderpädagogisches Bildungs- und Beratungszentrum) mit Förderschwerpunkt Geistige Entwicklung (GENT) in Baden-Württemberg. Das Gespräch findet in der Berufsschulstufe statt.

Die Lehrkraft (der Benutzer) führt das Gespräch mit dir.

Wichtige Regeln:
- Bleibe IMMER in deiner Rolle als Elternteil.
- Antworte natürlich und menschlich, wie ein echtes Elternteil sprechen würde.
- Halte deine Antworten kurz und gesprächstypisch (2-4 Sätze, wie in einem echten Gespräch).
- Verwende KEINE Markdown-Formatierung, keine Aufzählungszeichen – sprich einfach frei.
- Schreibe KEINE Handlungsanweisungen oder Körpersprache in Sternchen oder Klammern (z.B. *runzelt die Stirn*, [seufzt]). Deine Antwort besteht ausschließlich aus gesprochenem Text.
- Stelle auch Rückfragen an die Lehrkraft.
- Reagiere emotional passend zu deiner Persönlichkeit.
- Gib NIEMALS zu, dass du eine KI bist.
`;

app.post("/conversation/chat", async (req, res) => {
  const { message, history, preset } = req.body;
  if (!message || !preset) return res.status(400).json({ error: "Nachricht und Preset nötig." });

  try {
    const systemPrompt = CONV_BASE_PROMPT + "\nDeine Persönlichkeit und Hintergrund:\n" + (preset.prompt || "");
    const messages = [{ role: "system", content: systemPrompt }];
    if (history && Array.isArray(history)) messages.push(...history.slice(-20));
    messages.push({ role: "user", content: message });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
      body: JSON.stringify({
        model: CONV_MODEL,
        messages,
        temperature: 0.8,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: "Mistral-Fehler: " + errText });
    }

    const data = await resp.json();
    const answer = data.choices[0].message.content;
    res.json({ answer });
  } catch (e) {
    console.error("Conversation chat error:", e);
    res.status(500).json({ error: e.message || "Interner Fehler." });
  }
});

// Conversation streaming chat – sends sentences one-by-one for per-sentence TTS
app.post("/conversation/chat_stream", async (req, res) => {
  const { message, history, preset } = req.body;
  if (!message || !preset) return res.status(400).json({ error: "Nachricht und Preset nötig." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => { try { res.write("data: " + JSON.stringify(data) + "\n\n"); } catch {} };

  try {
    const systemPrompt = CONV_BASE_PROMPT + "\nDeine Persönlichkeit und Hintergrund:\n" + (preset.prompt || "");
    const messages = [{ role: "system", content: systemPrompt }];
    if (history && Array.isArray(history)) messages.push(...history.slice(-20));
    messages.push({ role: "user", content: message });

    const controller = new AbortController();
    res.on("close", () => controller.abort()); // abort when client navigates away

    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
      body: JSON.stringify({ model: CONV_MODEL, messages, temperature: 0.8, max_tokens: 300, stream: true }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      send({ type: "error", error: "Mistral-Fehler: " + (await resp.text()) });
      return res.end();
    }

    const reader = resp.body;
    let sseBuffer = "";
    let textBuffer = "";
    let fullResponse = "";

    const flushSentence = (text) => {
      // Strip *action* and [action] markers before TTS
      const clean = text.replace(/\*[^*]*\*/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
      if (clean.length > 1) send({ type: "sentence", sentence: clean });
    };

    reader.on("data", (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const token = JSON.parse(payload).choices?.[0]?.delta?.content || "";
          if (!token) continue;
          textBuffer += token;
          fullResponse += token;
          // Flush on sentence boundaries (. ! ? followed by whitespace)
          let match;
          while ((match = /[.!?]+\s+/.exec(textBuffer)) !== null) {
            flushSentence(textBuffer.slice(0, match.index + match[0].trimEnd().length));
            textBuffer = textBuffer.slice(match.index + match[0].length);
          }
        } catch {}
      }
    });

    reader.on("end", () => {
      if (textBuffer.trim().length > 1) flushSentence(textBuffer);
      send({ type: "done", full: fullResponse.trim() });
      res.end();
    });

    reader.on("error", (err) => {
      if (err.name !== "AbortError") send({ type: "error", error: err.message });
      try { res.end(); } catch {}
    });

  } catch (e) {
    if (e.name !== "AbortError") send({ type: "error", error: e.message });
    try { res.end(); } catch {}
  }
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🎓 Bildungsplan-Assistent läuft auf http://${HOST}:${PORT}`);
  console.log(`   Chat-Modell: ${MODEL}`);
  console.log(`   Konversations-Modell: ${CONV_MODEL}`);
});
