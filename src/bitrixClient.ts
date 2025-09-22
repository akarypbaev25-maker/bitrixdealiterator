import fs from "fs";
import path from "path";
import axios, { AxiosResponse } from "axios";
import dotenv from "dotenv";
import { info, debug } from "./logger";

dotenv.config();

export type Tokens = {
  domain?: string;
  access_token?: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  received_at?: number | null;
  raw?: any;
};

export type BitrixResponse<T = any> = {
  result: T;
  next?: number;
  time?: any;
  error?: string;
  error_description?: string;
};

const TOKENS_PATH = path.join(process.cwd(), "tokens.json");

export class BitrixClient {
  private tokens: Tokens | null = null;
  private autoRefresh: boolean;

  constructor(autoRefresh = true) {
    this.autoRefresh = autoRefresh;
    if (fs.existsSync(TOKENS_PATH)) {
      try {
        const raw = fs.readFileSync(TOKENS_PATH, "utf-8");
        this.tokens = JSON.parse(raw) as Tokens;
        debug("Loaded tokens.json");
      } catch (e) {
        debug("Failed to parse tokens.json", e);
        this.tokens = null;
      }
    } else {
      // fallback to env (useful for initial bootstrap on Render)
      const domain = process.env.BITRIX_DOMAIN;
      const access = process.env.BITRIX_ACCESS_TOKEN;
      if (domain && access) {
        this.tokens = {
          domain,
          access_token: access,
          refresh_token: process.env.BITRIX_REFRESH_TOKEN ?? null,
          expires_in: process.env.BITRIX_EXPIRES_IN ? Number(process.env.BITRIX_EXPIRES_IN) : null,
          received_at: Date.now()
        };
        try {
          fs.writeFileSync(TOKENS_PATH, JSON.stringify(this.tokens, null, 2), "utf-8");
          debug("Saved tokens.json from env");
        } catch (e) {
          debug("Cannot write tokens.json", e);
        }
      } else {
        this.tokens = null;
      }
    }
  }

  isConfigured(): boolean {
    return !!(this.tokens && this.tokens.domain && this.tokens.access_token);
  }

  getTokens(): Tokens | null { return this.tokens; }

  saveTokensToFile(tokens: Tokens) {
    this.tokens = tokens;
    try {
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
      info("tokens.json saved");
    } catch (e) {
      console.error("Failed to save tokens.json:", e);
    }
  }

  private async refreshIfNeeded(): Promise<void> {
    if (!this.autoRefresh) return;
    if (!this.tokens || !this.tokens.expires_in || !this.tokens.received_at) return;
    const expiresAt = (this.tokens.received_at ?? 0) + (this.tokens.expires_in ?? 0) * 1000;
    if (Date.now() < expiresAt - 60_000) return;
    if (!this.tokens.refresh_token) throw new Error("No refresh_token available.");
    const client_id = process.env.BITRIX_CLIENT_ID;
    const client_secret = process.env.BITRIX_CLIENT_SECRET;
    if (!client_id || !client_secret) {
      throw new Error("Missing BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET for refresh.");
    }
    const url = `https://oauth.bitrix.info/oauth/token/`;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      refresh_token: this.tokens.refresh_token,
    });
    info("Refreshing Bitrix token...");
    const res: AxiosResponse<any> = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const d = res.data;
    this.tokens.access_token = d.access_token;
    this.tokens.refresh_token = d.refresh_token ?? this.tokens.refresh_token;
    this.tokens.expires_in = d.expires_in ?? this.tokens.expires_in;
    this.tokens.received_at = Date.now();
    this.saveTokensToFile(this.tokens);
    info("Token refreshed");
  }

  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<BitrixResponse<T>> {
    if (!this.isConfigured()) {
      throw new Error("BitrixClient not configured: no tokens. Use /install or set BITRIX_ACCESS_TOKEN/BITRIX_DOMAIN.");
    }
    await this.refreshIfNeeded();
    const url = `https://${this.tokens!.domain}/rest/${method}`;
    const body = { ...params, auth: this.tokens!.access_token };
    debug("Calling Bitrix method", method);
    const res: AxiosResponse<any> = await axios.post(url, body, { timeout: 30000 });
    if (!res.data) throw new Error(`Empty response from Bitrix method ${method}`);
    if (res.data.error) throw new Error(`${res.data.error}: ${res.data.error_description || JSON.stringify(res.data)}`);
    return res.data as BitrixResponse<T>;
  }

  async batch(commands: Record<string, string>) {
    return this.call<{ [k: string]: any }>("batch", { cmd: commands });
  }
}
