import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { BitrixClient, Tokens } from "./bitrixClient";
import { info, warn } from "./logger";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKENS_FILE = path.join(process.cwd(), "tokens.json");
const SETUP_TOKEN = process.env.SETUP_TOKEN; // optional secret to protect manual token set

// Helper: save tokens to file (and log minimal info)
function saveTokens(tokens: Tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
  info("Tokens saved to tokens.json");
}

// GET health
app.get("/health", (req, res) => {
  const exists = fs.existsSync(TOKENS_FILE);
  res.json({ ok: true, tokens_present: exists });
});

// GET tokens peek (careful: exposes sensitive data) — disabled unless DEBUG=1
app.get("/tokens", (req, res) => {
  if (process.env.DEBUG !== "1") return res.status(403).send("Forbidden");
  if (!fs.existsSync(TOKENS_FILE)) return res.json({ present: false });
  const data = fs.readFileSync(TOKENS_FILE, "utf-8");
  res.type("json").send(data);
});

/**
 * POST /install
 * Bitrix will send an `auth` object in the POST body when installing.
 * We accept a few formats and persist tokens.json.
 */
app.post("/install", (req, res) => {
  try {
    const body = req.body;
    const auth = body.auth ?? body.AUTH ?? body;
    const domain = body.domain ?? body.DOMAIN ?? (auth && auth.domain) ?? req.query.domain;

    if (!auth || !auth.access_token) {
      return res.status(400).send("Install payload missing auth.access_token");
    }

    const tokens: Tokens = {
      domain,
      access_token: auth.access_token,
      refresh_token: auth.refresh_token ?? auth.refresh_token_key ?? null,
      expires_in: auth.expires_in ?? auth.expires ?? null,
      received_at: Date.now(),
      raw: body
    };

    saveTokens(tokens);

    // Respond with a friendly message and token summary (no raw token in logs)
    res.send("<h2>Приложение установлено. Токены сохранены.</h2>");
  } catch (err: any) {
    warn("Error in /install:", err);
    res.status(500).send("Install error");
  }
});

/**
 * POST /set-tokens
 * Manual method to set tokens (useful for initial bootstrap if Bitrix cannot call /install)
 * Protect with SETUP_TOKEN env var: set SETUP_TOKEN=some-secret in Render env.
 */
app.post("/set-tokens", (req, res) => {
  const provided = req.headers["x-setup-token"] || req.query.setup_token || req.body.setup_token;
  if (SETUP_TOKEN && String(provided) !== SETUP_TOKEN) {
    return res.status(403).send("Forbidden: invalid setup token");
  }

  const body = req.body;
  const domain = body.domain || body.DOMAIN;
  const access_token = body.access_token || body.auth?.access_token;
  const refresh_token = body.refresh_token || body.auth?.refresh_token || null;
  const expires_in = body.expires_in ?? null;

  if (!domain || !access_token) return res.status(400).send("domain and access_token required");

  const tokens: Tokens = {
    domain,
    access_token,
    refresh_token,
    expires_in,
    received_at: Date.now()
  };

  saveTokens(tokens);
  res.json({ ok: true });
});

// simple handler endpoint for push events (placeholder)
app.post("/handler", (req, res) => {
  console.log("[handler] incoming:", JSON.stringify(req.body).slice(0, 2000));
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send("b24-deal-batcher is up. Use /install to set tokens.");
});

app.listen(Number(PORT), () => {
  info(`Server listening on port ${PORT}`);
  info(`Install endpoint: POST /install`);
  info(`Manual tokens endpoint: POST /set-tokens (protected by SETUP_TOKEN if set)`);
});
