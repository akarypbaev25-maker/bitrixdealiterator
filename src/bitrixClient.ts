import fs from "fs";
import path from "path";
import axios, { AxiosResponse } from "axios";

interface Tokens {
  domain: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  received_at?: number;
}

export class BitrixClient {
  private tokens: Tokens;

  constructor() {
    const tokensPath = path.join(__dirname, "../tokens.json");
    if (!fs.existsSync(tokensPath)) {
      throw new Error("Файл tokens.json не найден. Установите приложение через /install.");
    }
    this.tokens = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    if (!this.tokens.expires_in || !this.tokens.received_at) return;

    const expiresAt = this.tokens.received_at + this.tokens.expires_in * 1000;
    if (Date.now() < expiresAt - 60000) return; // если не истёк, выходим

    if (!this.tokens.refresh_token) {
      throw new Error("Нет refresh_token. Нужно переустановить приложение.");
    }

    const url = `https://${this.tokens.domain}/oauth/token/`;
    const res: AxiosResponse<any> = await axios.post(url, {
      grant_type: "refresh_token",
      client_id: process.env.BITRIX_CLIENT_ID,
      client_secret: process.env.BITRIX_CLIENT_SECRET,
      refresh_token: this.tokens.refresh_token,
    });

    this.tokens.access_token = res.data.access_token;
    this.tokens.refresh_token = res.data.refresh_token;
    this.tokens.expires_in = res.data.expires_in;
    this.tokens.received_at = Date.now();

    fs.writeFileSync(path.join(__dirname, "../tokens.json"), JSON.stringify(this.tokens, null, 2));
  }

  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.refreshTokenIfNeeded();

    const url = `https://${this.tokens.domain}/rest/${method}`;
    const res: AxiosResponse<T> = await axios.post(url, {
      ...params,
      auth: this.tokens.access_token,
    });

    return res.data;
  }
}
