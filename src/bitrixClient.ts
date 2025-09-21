import fs from "fs";
import path from "path";
import axios, { AxiosResponse } from "axios";
import dotenv from "dotenv";
import { info, debug } from "./logger";

dotenv.config();

export type Tokens = {
  domain: string;
  access_token: string;
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
  private tokens: Tokens;

  constructor(private readonly autoRefresh = true) {
    if (!fs.existsSync(TOKENS_PATH)) {
      throw new Error(`tokens.json not found. Install app via /install or create tokens.json manually at project root.`);
    }
    this.tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8")) as Tokens;
    if (!this.tokens.domain || !this.tokens.access_token) {
      throw new Error("Invalid tokens.json (missing domain or access_token)");
    }
  }

  private saveTokens() {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(this.tokens, null, 2), "utf-8");
    debug("tokens.json updated");
  }

  private async refreshIfNeeded() {
    if (!this.autoRefresh) return;
    if (!this.tokens.expires_in || !this.tokens.received_at) return;
    const expiresAt = (this.tokens.received_at ?? 0) + (this.tokens.expires_in ?? 0) * 1000;
    // refresh 60s before expiry
    if (Date.now() < expiresAt - 60_000) return;
    if (!this.tokens.refresh_token) throw new Error("No refresh_token in tokens.json; re-install app.");

    const client_id = process.env.BITRIX_CLIENT_ID;
    const client_secret = process.env.BITRIX_CLIENT_SECRET;
    if (!client_id || !client_secret) {
      throw new Error("Missing BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET for token refresh");
    }

    const url = `https://oauth.bitrix.info/oauth/token/`;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      refresh_token: this.tokens.refresh_token,
    });

    info("Refreshing access token...");
    const res = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const data = res.data;
    this.tokens.access_token = data.access_token;
    this.tokens.refresh_token = data.refresh_token ?? this.tokens.refresh_token;
    this.tokens.expires_in = data.expires_in ?? this.tokens.expires_in;
    this.tokens.received_at = Date.now();
    this.saveTokens();
    info("Token refreshed");
  }

  /**
   * Универсальный вызов Bitrix: method like 'crm.deal.list' or 'batch'
   * params will be sent in body; auth param is injected automatically.
   */
  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<BitrixResponse<T>> {
    await this.refreshIfNeeded();
    const url = `https://${this.tokens.domain}/rest/${method}`;
    const body = { ...params, auth: this.tokens.access_token };
    debug("Bitrix call", method, body);
    const res: AxiosResponse<any> = await axios.post(url, body, { timeout: 30000 });
    if (!res.data) throw new Error(`Empty response from Bitrix method ${method}`);
    if (res.data.error) throw new Error(`${res.data.error}: ${res.data.error_description || JSON.stringify(res.data)}`);
    return res.data as BitrixResponse<T>;
  }

  // batch helper
  async batch(commands: Record<string, string>) {
    return this.call<{ [key: string]: any }>("batch", { cmd: commands });
  }
}
