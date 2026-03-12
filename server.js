/* EulenAI – Root Gateway Server
   Serves the landing page, handles central auth, and proxies
   requests to the sub-app servers (bildungsplan:5001, leichte-sprache:5000). */

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createProxyMiddleware } = require("http-proxy-middleware");
require("dotenv").config();

const app = express();

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const SESSION_SECRET = process.env.SESSION_SECRET || "eulenai-gateway-secret-" + Date.now();
const USERS_PATH = path.join(__dirname, "bildungsplan", "users.json");

// ── Body parsing – only for auth endpoints ─────────────────
// Proxy routes must NOT have their body pre-parsed; without parsing,
// http-proxy-middleware streams the raw body directly to the sub-app.
// This avoids the 100 kb default limit rejecting large payloads (e.g. base64 audio).
app.use("/auth", express.json({ limit: "1mb" }));
app.use("/auth", express.urlencoded({ extended: false }));

// ── Session ─────────────────────────────────────────────────
app.use(
  session({
    name: "eulenai.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
  })
);

// ── User helpers ────────────────────────────────────────────
async function readUsers() {
  try {
    const data = await fs.readFile(USERS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// ── Auth routes (public) ────────────────────────────────────
app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "landing", "login.html"));
});

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort erforderlich." });
  }

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

// ── Shared static assets (public) ──────────────────────────
app.use("/shared/static", express.static(path.join(__dirname, "shared", "static")));

// ── Auth middleware – everything below requires login ───────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("/login");
  }
  return res.status(401).json({ error: "Nicht angemeldet." });
}
app.use(requireAuth);

// ── Landing page (authenticated) ───────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing", "index.html"));
});

// ── Proxy to sub-apps ──────────────────────────────────────
const proxyOptions = {
  changeOrigin: true,
  ws: true,
  timeout: 600000,
  proxyTimeout: 600000,
};

app.use(
  "/bildungsplan",
  createProxyMiddleware({
    target: "http://127.0.0.1:5001",
    pathRewrite: { "^/bildungsplan": "" },
    ...proxyOptions,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.session && req.session.user) {
          proxyReq.setHeader("X-Gateway-User", JSON.stringify(req.session.user));
        }
      },
    },
  })
);

app.use(
  "/leichte-sprache",
  createProxyMiddleware({
    target: "http://127.0.0.1:5000",
    pathRewrite: { "^/leichte-sprache": "" },
    ...proxyOptions,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.session && req.session.user) {
          proxyReq.setHeader("X-Gateway-User", JSON.stringify(req.session.user));
        }
      },
    },
  })
);

// ── Start ───────────────────────────────────────────────────
app.listen(GATEWAY_PORT, HOST, () => {
  console.log(`EulenAI Gateway running on http://${HOST}:${GATEWAY_PORT}`);
});
