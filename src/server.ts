import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { info, warn } from "./logger";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKENS_FILE = path.join(process.cwd(), "tokens.json");

/**
 * /install - Bitrix will call this URL when installing the local app.
 * It typically sends JSON body with `auth` containing access_token and refresh_token.
 */
app.post("/install", (req, res) => {
  try {
    const body = req.body;
    const auth = body.auth ?? body.AUTH ?? body;
    const domain = body.domain ?? body.DOMAIN ?? (auth && auth.domain) ?? req.query.domain;

    if (!auth || !auth.access_token) {
      res.status(400).send("Missing auth.access_token in install payload");
      return;
    }

    const tokens = {
      domain,
      access_token: auth.access_token,
      refresh_token: auth.refresh_token ?? auth.refresh_token_key ?? null,
      expires_in: auth.expires_in ?? auth.expires ?? null,
      received_at: Date.now(),
      raw: body
    };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
    info("Install: tokens saved to tokens.json");
    res.send("<h2>App installed. Tokens saved.</h2>");
  } catch (err: any) {
    warn("Install error", err);
    res.status(500).send("Install error");
  }
});

// GET /install - support GET for manual testing
app.get("/install", (req, res) => {
  const q = req.query as any;
  const access_token = q["auth[access_token]"] || q["access_token"] || q.AUTH_ID;
  const refresh_token = q["auth[refresh_token]"] || q["refresh_token"] || q.REFRESH_ID;
  const domain = q.DOMAIN || q.domain || q.host;

  if (!access_token) return res.status(400).send("Missing access_token in query");
  const tokens = {
    domain,
    access_token,
    refresh_token: refresh_token ?? null,
    expires_in: null,
    received_at: Date.now(),
    raw_query: q
  };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
  info("Install GET: tokens saved");
  res.send("<h2>Install (GET) accepted. Tokens saved.</h2>");
});

app.post("/handler", (req, res) => {
  // placeholder for future push events
  console.log("[handler] event:", JSON.stringify(req.body).slice(0, 2000));
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, tokens_present: fs.existsSync(TOKENS_FILE) });
});

app.listen(PORT, () => {
  info(`Server listening on port ${PORT}`);
  info(`Install endpoint POST /install`);
});
