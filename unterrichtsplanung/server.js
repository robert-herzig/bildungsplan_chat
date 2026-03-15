/* Unterrichtsplanung – EulenAI Server
   Runs on PORT 5002, proxied via gateway at /unterrichtsplanung/ */

const express = require("express");
const fetch = require("node-fetch");
const AbortController = global.AbortController || require("abort-controller");
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_BASE = process.env.OPENWEBUI_API_BASE || process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1";
const API_KEY  = process.env.OPENWEBUI_API_KEY  || process.env.MISTRAL_API_KEY  || "";
const MODEL    = process.env.UNTERRICHT_MODEL   || process.env.MISTRAL_MODEL    || "mistral-large-latest";
const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT || 180) * 1000;

const PROMPT_PATH = path.join(__dirname, "system_prompt.txt");
const PROMPT_DEFAULT = "Du bist ein Experte für Unterrichtsplanung an SBBZ GEnt in Baden-Württemberg.";

async function readSystemPrompt() {
  try { return await fs.readFile(PROMPT_PATH, "utf-8"); }
  catch { return PROMPT_DEFAULT; }
}

// ── Web search helpers (reused from bildungsplan) ──────────────

/** DuckDuckGo web search via the Python helper script */
async function searchWeb(query, maxResults = 5) {
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

/**
 * Use a fast model call to turn the lesson topic + notes into an optimal German
 * search query (e.g. news-friendly terms for Tagesschau, Zeit Online, etc.)
 */
async function reformulateSearchQuery(thema, fach, notizen) {
  const raw = [thema, fach, notizen].filter(Boolean).join(" – ").slice(0, 400);
  try {
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          {
            role: "system",
            content: `Du bist ein Suchquery-Optimierer für Unterrichtsplanung. Formuliere aus den Themenangaben einer Lehrkraft eine präzise deutsche Suchanfrage, die aktuelle Quellen (Nachrichten, Wikipedia, Bildungsseiten) zu diesem Thema findet.\n\nRegeln:\n- Extrahiere die wichtigsten Inhaltsbegriffe\n- Entferne pädagogische Meta-Begriffe (\"Unterricht\", \"Stunde\", \"SuS\", \"SBBZ\")\n- Halte es sachlich und thematisch\n- Maximal 8 Wörter\n- Nur die Suchanfrage ausgeben, nichts anderes`,
          },
          { role: "user", content: raw },
        ],
        max_tokens: 40,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return raw;
    const data = await resp.json();
    const q = data.choices?.[0]?.message?.content?.trim();
    if (q && q.length > 3 && q.length < 150) {
      console.log(`  🔍 Search query: "${raw.slice(0,50)}" → "${q}"`);
      return q;
    }
    return raw;
  } catch {
    return raw;
  }
}

function formatWebResults(results) {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");
}

// ── Per-user data (teachers, student profiles) ─────────────
const USERDATA_DIR = path.join(__dirname, "userdata");
fs.mkdir(USERDATA_DIR, { recursive: true }).catch(() => {});

function getUserId(req) {
  try {
    const h = req.headers["x-gateway-user"];
    if (h) return JSON.parse(h).id || "default";
  } catch {}
  return "default";
}

async function readUserData(userId) {
  try {
    return JSON.parse(await fs.readFile(path.join(USERDATA_DIR, `${userId}.json`), "utf-8"));
  } catch {
    return { lehrkraefte: [], erwachsene: [], schueler: [], lastPrefs: {} };
  }
}

async function writeUserData(userId, data) {
  await fs.writeFile(path.join(USERDATA_DIR, `${userId}.json`), JSON.stringify(data, null, 2), "utf-8");
}

// ── Static & HTML ──────────────────────────────────────────
app.use("/static", express.static(path.join(__dirname, "static")));

app.get("/", async (req, res) => {
  try {
    const html = await fs.readFile(path.join(__dirname, "templates", "index.html"), "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Seite.");
  }
});

// ── Build user message from form data ─────────────────────
function buildUserMessage(data) {
  const {
    thema, klasse, fach, datum, uhrzeit,
    lehrkraft, anwesendeErwachsene, anwesendeSchueler,
    schuelerInfo, notizen
  } = data;

  const lines = ["Bitte erstelle eine vollständige Unterrichtsskizze mit folgenden Informationen:\n"];

  if (thema)               lines.push(`**Thema:** ${thema}`);
  if (klasse)              lines.push(`**Klasse/Gruppe:** ${klasse}`);
  if (fach)                lines.push(`**Fach:** ${fach}`);
  if (datum || uhrzeit)    lines.push(`**Datum/Uhrzeit:** ${datum || "–"}, ${uhrzeit || "–"}`);
  if (lehrkraft)           lines.push(`**Lehrkraft/Anwärterin:** ${lehrkraft}`);
  if (anwesendeErwachsene) lines.push(`**Anwesende Erwachsene:** ${anwesendeErwachsene}`);
  if (anwesendeSchueler)   lines.push(`**Anwesende SuS:** ${anwesendeSchueler}`);

  if (schuelerInfo && schuelerInfo.trim()) {
    lines.push("\n**Informationen zu den SuS (Kompetenzniveaus, Förderbedarf, Besonderheiten):**");
    lines.push(schuelerInfo.trim());
  }

  if (notizen && notizen.trim()) {
    lines.push("\n**Notizen, Ideen und Quellen für die Stunde:**");
    lines.push(notizen.trim());
  }

  return lines.join("\n");
}

// ── Streaming generation ───────────────────────────────────
app.post("/generate_stream", async (req, res) => {
  const body = req.body || {};
  const systemPrompt = await readSystemPrompt();
  const userMessage  = buildUserMessage(body);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  if (!userMessage.trim()) {
    res.write("data: ERROR: Keine Eingabe bereitgestellt.\n\n");
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // ── Optional web search ─────────────────────────────────
  let webContext = "";
  if (body.webSearch) {
    res.write("data: " + JSON.stringify("__STATUS__Suche im Web …") + "\n\n");
    const searchQuery = await reformulateSearchQuery(body.thema, body.fach, body.notizen);
    const results = await searchWeb(searchQuery, 5);
    if (results.length > 0) {
      webContext = `\n\nAktuelle Informationen aus der Websuche (Suchbegriff: "${searchQuery}"):\n\n${formatWebResults(results)}`;
      res.write("data: " + JSON.stringify("__STATUS__Generiere Unterrichtsskizze …") + "\n\n");
    } else {
      res.write("data: " + JSON.stringify("__STATUS__Keine Websuche-Ergebnisse – generiere direkt …") + "\n\n");
    }
  }

  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage + webContext },
    ],
    stream: true,
    temperature: 0.4,
    max_tokens: 4096,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!r.ok) {
      clearTimeout(timer);
      const errText = await r.text();
      res.write("data: ERROR: " + errText.replace(/\n/g, " ") + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let buffer = "";
    let acc    = "";
    const push = () => res.write("data: " + JSON.stringify(acc) + "\n\n");

    const processEvents = (events) => {
      for (const ev of events) {
        const m = ev.match(/^data:\s*(.*)$/s);
        if (!m) continue;
        const p = m[1];
        if (p === "[DONE]") {
          clearTimeout(timer);
          push();
          res.write("data: [DONE]\n\n");
          res.end();
          return true; // done
        }
        try {
          const obj   = JSON.parse(p);
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (delta) { acc += delta; push(); }
        } catch {
          acc += p; push();
        }
      }
      return false;
    };

    if (r.body && typeof r.body.getReader === "function") {
      const reader  = r.body.getReader();
      const decoder = new TextDecoder("utf-8");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        if (processEvents(events)) return;
      }
    } else if (r.body?.[Symbol.asyncIterator]) {
      for await (const chunk of r.body) {
        buffer += chunk.toString();
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        if (processEvents(events)) return;
      }
    } else {
      acc += await r.text();
      clearTimeout(timer);
    }

    clearTimeout(timer);
    push();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === "AbortError" ? "Timeout – Modell antwortet zu langsam." : (e?.message || "Unbekannter Fehler");
    res.write("data: ERROR: " + msg + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ── System prompt editor (admin only) ─────────────────────
app.get("/prompt", async (req, res) => {
  try { res.json({ prompt: await readSystemPrompt() }); }
  catch { res.json({ prompt: PROMPT_DEFAULT }); }
});

app.post("/prompt", async (req, res) => {
  const { prompt } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Kein Prompt angegeben." });
  }
  await fs.writeFile(PROMPT_PATH, prompt, "utf-8");
  res.json({ ok: true });
});

// ── User data routes ─────────────────────────────────────
app.get("/userdata", async (req, res) => {
  res.json(await readUserData(getUserId(req)));
});

app.post("/userdata/prefs", async (req, res) => {
  const userId = getUserId(req);
  const { lehrkraft, anwesendeErwachsene, klasse, fach } = req.body || {};
  const data = await readUserData(userId);
  data.lastPrefs = data.lastPrefs || {};
  if (lehrkraft) {
    data.lastPrefs.lehrkraft = lehrkraft;
    if (!data.lehrkraefte.includes(lehrkraft)) data.lehrkraefte.push(lehrkraft);
  }
  if (anwesendeErwachsene) {
    data.lastPrefs.anwesendeErwachsene = anwesendeErwachsene;
    anwesendeErwachsene.split(",").map(s => s.trim()).filter(Boolean).forEach(n => {
      if (!data.erwachsene.includes(n)) data.erwachsene.push(n);
    });
  }
  if (klasse) data.lastPrefs.klasse = klasse;
  if (fach) data.lastPrefs.fach = fach;
  await writeUserData(userId, data);
  res.json({ ok: true });
});

app.post("/userdata/student", async (req, res) => {
  const userId = getUserId(req);
  const { id, name, profil } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Name erforderlich." });
  const data = await readUserData(userId);
  const trimmed = { name: name.trim(), profil: (profil || "").trim() };
  if (id) {
    const idx = data.schueler.findIndex(s => s.id === id);
    if (idx >= 0) data.schueler[idx] = { id, ...trimmed };
    else data.schueler.push({ id, ...trimmed });
  } else {
    data.schueler.push({ id: "s_" + Date.now(), ...trimmed });
  }
  await writeUserData(userId, data);
  res.json({ ok: true, schueler: data.schueler });
});

app.delete("/userdata/student/:id", async (req, res) => {
  const userId = getUserId(req);
  const data = await readUserData(userId);
  data.schueler = data.schueler.filter(s => s.id !== req.params.id);
  await writeUserData(userId, data);
  res.json({ ok: true, schueler: data.schueler });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.UNTERRICHT_PORT || 5002;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Unterrichtsplanung server running on http://${HOST}:${PORT}`);
});
