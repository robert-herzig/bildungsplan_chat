/* Bildungsplan GENT Assistent – Node.js server (Express)
   Matches the existing eulenai.de deployment pattern.
   Runs on PORT 5001, proxied via nginx at /bildungsplan/ */

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs/promises");
const session = require("express-session");
const bcrypt = require("bcryptjs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { execFile } = require("child_process");

const app = express();
app.use(express.json({ limit: "25mb" }));

// ── Config ──────────────────────────────────────────────────────────
const API_BASE = process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1";
let _apiKey = process.env.MISTRAL_API_KEY || "";
let _model = process.env.MISTRAL_MODEL || "mistral-medium-latest";
const CHROMA_DB_PATH = process.env.CHROMA_DB_PATH || "./chroma_db";
const COLLECTION_NAME = "bildungsplan";
const TOP_K = parseInt(process.env.TOP_K || "8", 10);
const MIN_RELEVANCE_SCORE = parseFloat(process.env.MIN_RELEVANCE_SCORE || "0.68");
const PORT = parseInt(process.env.PORT || "5001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TIMEOUT = parseInt(process.env.MODEL_TIMEOUT || "120", 10) * 1000;
let _convModel = process.env.CONV_MODEL || "mistral-medium-latest";
const ADMIN_CONFIG_PATH = path.join(__dirname, "admin_config.json");
try {
  const _cfg = JSON.parse(require("fs").readFileSync(ADMIN_CONFIG_PATH, "utf-8"));
  if (_cfg.apiKey) _apiKey = _cfg.apiKey;
  if (_cfg.model) _model = _cfg.model;
  if (_cfg.convModel) _convModel = _cfg.convModel;
} catch {}
const PRESETS_PATH = path.join(__dirname, "conversation_presets.json");
const CUSTOM_PRESETS_PATH = path.join(__dirname, "conversation_presets_custom.json");
const TMP_DIR = "/tmp";

const SYSTEM_PROMPT_PATH = path.join(__dirname, "system_prompt.txt");
const MEMORIES_PATH = path.join(__dirname, "memories.json");
const CONVERSATIONS_PATH = path.join(__dirname, "conversations.json");
const USERS_PATH = path.join(__dirname, "users.json");
const SESSION_SECRET = process.env.SESSION_SECRET || "bildungsplan-gent-secret-" + Date.now();
const DEFAULT_SYSTEM_PROMPT = `Du bist ein hilfreicher Assistent für Lehrkräfte an einem SBBZ in Baden-Württemberg, Förderschwerpunkt Geistige Entwicklung (GENT).

Antworte immer auf Deutsch, kurz und prägnant (maximal 2-3 kurze Absätze). Kein Markdown, keine Aufzählungen – nur Fließtext. Quellenangaben als "(Quelle 1, S. X)" im Text, keine Dateinamen.`;

// ── Session & Auth ──────────────────────────────────────────────────
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }, // 7 days
  })
);

async function readUsers() {
  try {
    const data = await fs.readFile(USERS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Auth routes (before auth middleware so they're accessible without login)
app.get("/login", async (req, res) => {
  // If coming through the gateway (already authenticated), just go to the app
  const gwHeader = req.headers["x-gateway-user"];
  if (gwHeader) return res.redirect("./");
  if (req.session && req.session.user) return res.redirect("./");
  try {
    const html = await fs.readFile(path.join(__dirname, "templates", "login.html"), "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Login-Seite.");
  }
});

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Benutzername und Passwort erforderlich." });

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Falscher Benutzername oder Passwort." });
  }

  req.session.user = { id: user.id, username: user.username, displayName: user.displayName };
  res.json({ ok: true });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post("/auth/change-password", async (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: "Nicht angemeldet." });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Beide Passwörter erforderlich." });
  if (newPassword.length < 6) return res.status(400).json({ error: "Neues Passwort muss mindestens 6 Zeichen lang sein." });

  const users = await readUsers();
  const user = users.find((u) => u.id === req.session.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: "Aktuelles Passwort ist falsch." });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), "utf-8");
  res.json({ ok: true });
});

// Auth middleware – protect all routes below this point
function requireAuth(req, res, next) {
  // Allow static files through
  if (req.path.startsWith("/static")) return next();
  // Always trust gateway auth header when present (gateway has already verified the session)
  const gwHeader = req.headers["x-gateway-user"];
  if (gwHeader) {
    try {
      req.session.user = JSON.parse(gwHeader);
      return next();
    } catch {}
  }
  // Fall back to bildungsplan-local session (e.g. direct access)
  if (req.session && req.session.user) return next();
  // Unauthenticated
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("./login");
  }
  return res.status(401).json({ error: "Nicht angemeldet." });
}
app.use(requireAuth);

// ── Static files & HTML ─────────────────────────────────────────────
app.use("/static", express.static(path.join(__dirname, "static")));

app.get("/", async (req, res) => {
  try {
    let html = await fs.readFile(
      path.join(__dirname, "templates", "index.html"),
      "utf-8"
    );
    const user = req.session.user || {};
    html = html.replace(
      '/* __SERVER_USER__ */',
      `window.__SERVER_USER__ = ${JSON.stringify({ id: user.id || '', username: user.username || '', displayName: user.displayName || '' })};`
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Seite.");
  }
});

// ── Helpers ─────────────────────────────────────────────────────────
async function readSystemPrompt(userId) {
  try {
    const base = await fs.readFile(SYSTEM_PROMPT_PATH, "utf-8");
    const memories = await readMemories(userId);
    if (memories.length > 0) {
      const memBlock = memories.map((m) => `- ${m.content}`).join("\n");
      return base + `\n\nDer Nutzer hat folgende persönliche Informationen hinterlegt, die du berücksichtigen sollst:\n${memBlock}`;
    }
    return base;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

// ── Per-user memories ───────────────────────────────────────────────
async function readAllMemories() {
  try {
    const data = await fs.readFile(MEMORIES_PATH, "utf-8");
    const parsed = JSON.parse(data);
    // Migration: if it's a flat array (old format), return as-is wrapped
    if (Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function readMemories(userId) {
  const all = await readAllMemories();
  return all[userId] || [];
}

async function writeMemories(userId, memories) {
  const all = await readAllMemories();
  all[userId] = memories;
  await fs.writeFile(MEMORIES_PATH, JSON.stringify(all, null, 2), "utf-8");
}

// ── Per-user conversation history ───────────────────────────────────
async function readAllConversations() {
  try {
    const data = await fs.readFile(CONVERSATIONS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function readUserConversations(userId) {
  const all = await readAllConversations();
  return all[userId] || [];
}

async function writeUserConversations(userId, convos) {
  const all = await readAllConversations();
  all[userId] = convos;
  await fs.writeFile(CONVERSATIONS_PATH, JSON.stringify(all, null, 2), "utf-8");
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

/** Build numbered source list from chunks (deduped by source+page) */
function buildNumberedSources(chunks) {
  const sources = [];
  const seen = new Map();
  for (const c of chunks) {
    const key = c.source + "::" + c.page;
    if (!seen.has(key)) {
      seen.set(key, sources.length + 1);
      sources.push({ num: sources.length + 1, source: c.source, page: c.page });
    }
  }
  return { sources, keyToNum: seen };
}

function formatDocContext(chunks, keyToNum) {
  return chunks
    .map((c) => {
      const key = c.source + "::" + c.page;
      const num = keyToNum.get(key);
      return `[Quelle ${num}, S. ${c.page}]\n${c.text}`;
    })
    .join("\n\n---\n\n");
}

function formatWebResults(results) {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");
}

/**
 * Use a fast LLM call to reformulate the user message into an optimal search query
 * for the document database. This bridges the gap between conversational speech
 * and the embedding-friendly keyword phrases that score well against ChromaDB.
 */
async function reformulateSearchQuery(userMessage) {
  try {
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + _apiKey },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          {
            role: "system",
            content: `Du bist ein Suchquery-Optimierer. Deine Aufgabe: Formuliere die Nutzerfrage in eine präzise deutsche Suchanfrage um, die optimal für eine Vektordatenbank-Suche in Bildungsplan-Dokumenten (SBBZ GENT Baden-Württemberg) und ILEB-Dokumenten geeignet ist.

Regeln:
- Extrahiere die Kernbegriffe und Fachbegriffe
- Entferne Füllwörter und Konversationsfloskeln
- Gib NUR die optimierte Suchanfrage zurück, NICHTS anderes
- Maximal 15 Wörter
- Wenn die Frage Abkürzungen enthält (z.B. ILEB, SBBZ), löse sie auf UND behalte die Abkürzung

Beispiele:
Nutzerfrage: "Erzähl mir mal was über ILEB"
Suchanfrage: ILEB Individuelle Lern- und Entwicklungsbegleitung Förderplanung

Nutzerfrage: "Was muss ich im Fach Deutsch beachten?"
Suchanfrage: Bildungsplan Deutsch Kompetenzen Anforderungen GENT

Nutzerfrage: "Wie fülle ich das ILEB Formular aus?"
Suchanfrage: ILEB Formular Förderplanung Dokumentation Bildungsplanung ausfüllen`,
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 60,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return userMessage;
    const data = await resp.json();
    const query = data.choices?.[0]?.message?.content?.trim();
    if (query && query.length > 3 && query.length < 200) {
      console.log(`  🔍 Reformulated: "${userMessage.slice(0, 50)}" → "${query}"`);
      return query;
    }
    return userMessage;
  } catch (e) {
    console.warn("Query reformulation failed, using raw query:", e.message);
    return userMessage;
  }
}

/**
 * Central context builder.
 * Returns { contextText, chunks, sources, webResults, mode }
 * mode: 'hybrid' | 'docs' | 'web' | 'none'
 *
 * Hybrid approach: when documents are found, also run a web search to
 * supplement with current information.  Both sources are combined.
 */
async function buildContext(message) {
  if (isConversational(message)) {
    return { contextText: "", chunks: [], sources: [], webResults: [], mode: "none" };
  }

  // 1. Reformulate user message into an optimal search query
  const searchQuery = await reformulateSearchQuery(message);

  // 2. Run document search AND web search in parallel
  const [allChunks, webResults] = await Promise.all([
    queryChromaDB(searchQuery, TOP_K),
    searchWeb(searchQuery, 4),
  ]);
  const chunks = allChunks.filter((c) => c.score >= MIN_RELEVANCE_SCORE);

  const hasDocs = chunks.length > 0;
  const hasWeb = webResults.length > 0;

  if (hasDocs && hasWeb) {
    const { sources, keyToNum } = buildNumberedSources(chunks);
    const docPart = `Relevante Auszüge aus dem Bildungsplan GENT:\n\n${formatDocContext(chunks, keyToNum)}`;
    const webPart = `\n\nErgänzende Informationen aus der Websuche:\n\n${formatWebResults(webResults)}`;
    return {
      contextText: docPart + webPart,
      chunks,
      sources,
      webResults,
      mode: "hybrid",
    };
  }

  if (hasDocs) {
    const { sources, keyToNum } = buildNumberedSources(chunks);
    return {
      contextText: `Relevante Auszüge aus dem Bildungsplan GENT:\n\n${formatDocContext(chunks, keyToNum)}`,
      chunks,
      sources,
      webResults: [],
      mode: "docs",
    };
  }

  if (hasWeb) {
    return {
      contextText: `Ergebnisse aus der Websuche:\n\n${formatWebResults(webResults)}`,
      chunks: [],
      sources: [],
      webResults,
      mode: "web",
    };
  }

  return { contextText: "", chunks: [], sources: [], webResults: [], mode: "none" };
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

// ── Memories endpoints (per-user) ───────────────────────────────────
app.get("/memories", async (req, res) => {
  const userId = req.session.user.id;
  const memories = await readMemories(userId);
  res.json({ memories });
});

app.post("/memories", async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Kein Inhalt." });
  const userId = req.session.user.id;
  const memories = await readMemories(userId);
  const newMem = { id: Date.now().toString(), content: content.trim(), created: new Date().toISOString() };
  memories.push(newMem);
  await writeMemories(userId, memories);
  res.json({ ok: true, memory: newMem });
});

app.put("/memories/:id", async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Kein Inhalt." });
  const userId = req.session.user.id;
  const memories = await readMemories(userId);
  const mem = memories.find((m) => m.id === req.params.id);
  if (!mem) return res.status(404).json({ error: "Erinnerung nicht gefunden." });
  mem.content = content.trim();
  mem.updated = new Date().toISOString();
  await writeMemories(userId, memories);
  res.json({ ok: true, memory: mem });
});

app.delete("/memories/:id", async (req, res) => {
  const userId = req.session.user.id;
  let memories = await readMemories(userId);
  const before = memories.length;
  memories = memories.filter((m) => m.id !== req.params.id);
  if (memories.length === before) return res.status(404).json({ error: "Erinnerung nicht gefunden." });
  await writeMemories(userId, memories);
  res.json({ ok: true });
});

// ── User management endpoints ───────────────────────────────────────
app.get("/auth/me", (req, res) => {
  res.json({ user: req.session.user });
});

app.get("/auth/users", async (req, res) => {
  const users = await readUsers();
  res.json({ users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, created: u.created })) });
});

app.post("/auth/users", async (req, res) => {
  if (req.session.user.username !== "admin") return res.status(403).json({ error: "Nur der Admin darf neue Benutzer anlegen." });
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Benutzername und Passwort erforderlich." });
  if (password.length < 6) return res.status(400).json({ error: "Passwort muss mindestens 6 Zeichen lang sein." });
  const users = await readUsers();
  if (users.find((u) => u.username === username)) return res.status(409).json({ error: "Benutzername bereits vergeben." });
  const newUser = {
    id: "user_" + Date.now(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: displayName || username,
    created: new Date().toISOString(),
  };
  users.push(newUser);
  await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), "utf-8");
  res.json({ ok: true, user: { id: newUser.id, username: newUser.username, displayName: newUser.displayName } });
});

app.delete("/auth/users/:id", async (req, res) => {
  if (req.session.user.username !== "admin") return res.status(403).json({ error: "Nur der Admin darf Benutzer löschen." });
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: "Du kannst dich nicht selbst löschen." });
  let users = await readUsers();
  const before = users.length;
  users = users.filter((u) => u.id !== req.params.id);
  if (users.length === before) return res.status(404).json({ error: "Benutzer nicht gefunden." });
  await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), "utf-8");
  res.json({ ok: true });
});

// ── Admin config endpoints ─────────────────────────────────────────
app.get("/admin/config", async (req, res) => {
  if (req.session.user.username !== "admin") return res.status(403).json({ error: "Nur Admin." });
  let storedCfg = {};
  try { storedCfg = JSON.parse(await fs.readFile(ADMIN_CONFIG_PATH, "utf-8")); } catch {}
  res.json({
    model: _model,
    convModel: _convModel,
    apiKeySet: !!_apiKey,
    apiKeyHint: _apiKey ? "••••••••" + _apiKey.slice(-4) : "(nicht gesetzt)",
  });
});

app.post("/admin/config", async (req, res) => {
  if (req.session.user.username !== "admin") return res.status(403).json({ error: "Nur Admin." });
  const { model, convModel, apiKey } = req.body;
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(ADMIN_CONFIG_PATH, "utf-8")); } catch {}
  if (model) { cfg.model = model; _model = model; }
  if (convModel) { cfg.convModel = convModel; _convModel = convModel; }
  if (apiKey !== undefined && apiKey !== "") { cfg.apiKey = apiKey; _apiKey = apiKey; }
  await fs.writeFile(ADMIN_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  res.json({ ok: true, model: _model, convModel: _convModel, apiKeyHint: _apiKey ? "••••••••" + _apiKey.slice(-4) : "(nicht gesetzt)" });
});

// ── Conversation history endpoints (per-user) ──────────────────────
app.get("/conversations", async (req, res) => {
  const userId = req.session.user.id;
  const convos = await readUserConversations(userId);
  // Return list without full messages (lighter)
  res.json({ conversations: convos.map((c) => ({ id: c.id, title: c.title, updated: c.updated, messageCount: c.messages.length })) });
});

app.get("/conversations/:id", async (req, res) => {
  const userId = req.session.user.id;
  const convos = await readUserConversations(userId);
  const convo = convos.find((c) => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: "Gespräch nicht gefunden." });
  res.json({ conversation: convo });
});

app.post("/conversations", async (req, res) => {
  const { id, title, messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Keine Nachrichten." });
  const userId = req.session.user.id;
  const convos = await readUserConversations(userId);
  const now = new Date().toISOString();
  const existing = id ? convos.find((c) => c.id === id) : null;
  if (existing) {
    existing.messages = messages;
    existing.title = title || existing.title;
    existing.updated = now;
  } else {
    const autoTitle = title || (messages.find((m) => m.role === "user")?.content || "Neues Gespräch").slice(0, 80);
    convos.unshift({ id: "conv_" + Date.now(), title: autoTitle, messages, created: now, updated: now });
  }
  // Keep max 50 conversations per user
  if (convos.length > 50) convos.length = 50;
  await writeUserConversations(userId, convos);
  res.json({ ok: true, id: existing ? existing.id : convos[0].id });
});

app.delete("/conversations/:id", async (req, res) => {
  const userId = req.session.user.id;
  let convos = await readUserConversations(userId);
  const before = convos.length;
  convos = convos.filter((c) => c.id !== req.params.id);
  if (convos.length === before) return res.status(404).json({ error: "Gespräch nicht gefunden." });
  await writeUserConversations(userId, convos);
  res.json({ ok: true });
});

// Extract memorable facts from a conversation using Mistral
app.post("/conversations/summarize", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length < 2) {
    return res.status(400).json({ memories: [] });
  }

  const convText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-40)
    .map((m) => `${m.role === "user" ? "Lehrkraft" : "Assistent"}: ${m.content}`)
    .join("\n\n");

  const prompt = `Analysiere das folgende Gespräch zwischen einer Lehrkraft und einem KI-Assistenten. Extrahiere daraus konkrete, merkwürdige Informationen, die sich als persönliche Erinnerung eignen.

Konzentriere dich auf:
- Konkrete Schüler:innen oder Personen (Name + relevante Eigenschaft/Situation)
- Spezifische Methoden, Materialien oder Förderansätze, die besprochen wurden
- Wichtige Fakten über die Klasse, Schule oder den Unterrichtskontext
- Besondere Herausforderungen oder Ziele, die genannt wurden

Gib NUR eine nummerierte Liste aus. Jede Zeile = eine Erinnerung, maximal 100 Zeichen, kurz und prägnant. Wenn es nichts Relevantes gibt, antworte nur mit "Keine".

Gespräch:
${convText}`;

  try {
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + _apiKey },
      body: JSON.stringify({
        model: _model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    if (text === "Keine" || text.startsWith("Keine")) return res.json({ memories: [] });
    const memories = text
      .split("\n")
      .map((l) => l.replace(/^\d+[\.\)]\s*/, "").trim())
      .filter((l) => l.length > 5 && l.length < 120);
    res.json({ memories });
  } catch (e) {
    res.status(500).json({ error: "Fehler beim Zusammenfassen." });
  }
});

// Chat endpoint (non-streaming)
app.post("/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "Keine Nachricht." });

  try {
    // 1. Build context (docs → web → none)
    const { contextText, sources, webResults, mode } = await buildContext(message);

    // 2. Build messages
    const userId = req.session?.user?.id;
    const systemPrompt = await readSystemPrompt(userId);
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
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + _apiKey },
      body: JSON.stringify({ model: _model, messages }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: "Mistral-Fehler: " + errText });
    }

    const data = await resp.json();
    const answer = data.choices[0].message.content;

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
    const { contextText, sources, webResults, mode } = await buildContext(message);

    // Send sources first so the UI can show them while streaming
    const webSources = webResults.map((r) => ({ title: r.title, url: r.url }));
    res.write("data: " + JSON.stringify({ type: "sources", sources, webSources, mode }) + "\n\n");

    // 2. Build messages
    const userId = req.session?.user?.id;
    const systemPrompt = await readSystemPrompt(userId);
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
        Authorization: "Bearer " + _apiKey,
      },
      body: JSON.stringify({ model: _model, messages, stream: true }),
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
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + _apiKey },
      body: JSON.stringify({
        model: _convModel,
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
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + _apiKey },
      body: JSON.stringify({ model: _convModel, messages, temperature: 0.8, max_tokens: 300, stream: true }),
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
  console.log(`   Chat-Modell: ${_model}`);
  console.log(`   Konversations-Modell: ${_convModel}`);
});
