// SecretStorage-backed token store (OS keychain encrypted) + auto refresh.
import * as vscode from "vscode";
import { Tokens, tokenFresh } from "../libs/util";
import { refreshTokens } from "../libs/oauth";

const KEY = "colabPipe.tokens";

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(): Promise<Tokens | undefined> {
    const raw = await this.secrets.get(KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      return undefined;
    }
  }

  async set(t: Tokens): Promise<void> {
    await this.secrets.store(KEY, JSON.stringify(t));
  }

  async clear(): Promise<void> {
    try {
      await this.secrets.delete(KEY);
    } catch {}
  }

  /** Returns tokens, refreshing if near-expiry. force=true always refreshes. Throws when no login. */
  async ensure(force = false): Promise<Tokens> {
    const t = await this.get();
    if (!t) {
      throw new Error("Not signed in — run 'CoVibe: Sign in with Google (Drive)' first.");
    }
    if (!force && tokenFresh(t)) {
      return t;
    }
    if (!t.refresh_token) {
      throw new Error("No refresh token — sign in again.");
    }
    const newer = await refreshTokens(t);
    await this.set(newer);
    return newer;
  }
}
