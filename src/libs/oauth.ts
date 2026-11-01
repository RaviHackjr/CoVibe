// OAuth PKCE + loopback callback + token exchange/refresh — pure node (no vscode).
import * as http from "http";
import * as crypto from "crypto";
import { URLSearchParams } from "url";
import { AUTH_URL_BASE, AUTH_SUCCESS_REDIRECT, CLIENT_ID, CLIENT_SECRET, SCOPES, TOKEN_URL } from "../const";
import { Tokens } from "./util";

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(96).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(redirectUri: string, challenge: string, nonce: string): string {
  const q = new URLSearchParams({
    access_type: "offline",
    response_type: "code",
    code_challenge_method: "S256",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    state: `nonce=${nonce}`,
    scope: SCOPES.join(" "),
    prompt: "consent",
    code_challenge: challenge,
  });
  return `${AUTH_URL_BASE}?${q.toString()}`;
}

export interface LoopbackHandle {
  server: http.Server;
  port: number;
  code: string;
  done: Promise<string | { error: string }>;
}

/** Start loopback server on 127.0.0.1:{rand}. Resolves code after Google redirect. */
export async function startLoopback(nonce: string, timeoutMs = 5 * 60_000): Promise<LoopbackHandle> {
  let resolveCode: (v: string | { error: string }) => void;
  const done = new Promise<string | { error: string }>((res) => (resolveCode = res));
  const handle: Partial<LoopbackHandle> = { done, code: "" };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname !== "/") {
      res.writeHead(404);
      res.end();
      return;
    }
    const state = u.searchParams.get("state") || "";
    const inner = new URLSearchParams(state); // "nonce=xxx"
    const gotNonce = inner.get("nonce");
    const code = u.searchParams.get("code");
    if (!gotNonce || gotNonce !== nonce || !code) {
      res.writeHead(400).end("CoVibe bad callback: state/code missing");
      resolveCode!(u.searchParams.get("error") ? { error: u.searchParams.get("error") as string } : "");
      return;
    }
    res.writeHead(302, { Location: AUTH_SUCCESS_REDIRECT + "?state=vscode://google.colab/auth-success" });
    res.end();
    resolveCode!(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const port = (server.address() as { port: number }).port;
  setTimeout(() => {
    try {
      (handle as LoopbackHandle).server.close();
    } catch {}
  }, timeoutMs).unref();
  return { server, port, code: "", done } as LoopbackHandle;
}

export interface RequestInit2 {
  method?: string;
  body?: string | Buffer | Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Minimal fetch wrapper used by oauth + api + drive modules. */
export async function httpFetch(url: string, init: RequestInit2 = {}): Promise<{ status: number; text: string; ok: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? (init.body as any) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, ok: res.ok };
  } finally {
    clearTimeout(t);
  }
}

export function parseJson<T = any>(text: string): T {
  let t = text;
  if (t.startsWith(")]}'")) {
    const i = t.indexOf("\n");
    t = i >= 0 ? t.slice(i + 1) : t.slice(4);
  }
  return (t ? JSON.parse(t) : {}) as T;
}

async function tokenPost(params: URLSearchParams): Promise<Tokens> {
  const r = await httpFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    timeoutMs: 30_000,
  });
  if (!r.ok) {
    throw new Error(`token exchange ${r.status}: ${r.text.slice(0, 300)}`);
  }
  const j = parseJson(r.text) as Tokens & { expires_in?: number };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    scope: j.scope,
    expires_in: j.expires_in,
    expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
  };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<Tokens> {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const t = await tokenPost(q);
  if (!t.refresh_token) {
    throw new Error("no refresh_token in response");
  }
  return t;
}

/**
 * Token exchange — Google redirect_uri ko auth step wali EXACT string maangta hai.
 * Mismatch (e.g. asExternalUri ne uri badal diya) ho to alternate loopback
 * variants se retry karo (auth pe wahi accept hua tha).
 */
export async function exchangeCodeAdaptive(
  code: string,
  verifier: string,
  cbUri: string,
  port: number,
  log?: (m: string) => void,
): Promise<Tokens> {
  const attempts = [...new Set([cbUri, `http://127.0.0.1:${port}`, `http://localhost:${port}`])];
  let lastErr: unknown;
  for (const ru of attempts) {
    try {
      log?.(`↪ token exchange (redirect_uri=${ru})`);
      return await exchangeCode(code, verifier, ru);
    } catch (e) {
      lastErr = e;
      const m = String(e);
      if (/redirect_uri_mismatch/i.test(m) || /invalid_grant|expired/i.test(m)) {
        log?.(`  ↪ ${m.slice(0, 120)} — alternate redirect se retry…`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function refreshTokens(t: Tokens): Promise<Tokens> {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: t.refresh_token as string,
    grant_type: "refresh_token",
  });
  const newer = await tokenPost(q);
  return { ...newer, refresh_token: newer.refresh_token || t.refresh_token };
}

/** Simple GET probe of Colab user-info (proves token valid). */
export async function userInfo(tokens: Tokens): Promise<any> {
  const r = await httpFetch(`https://colab.pa.googleapis.com/v1/user-info?get_ccu_consumption_info=true`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${tokens.access_token}` },
    timeoutMs: 20_000,
  });
  return { status: r.status, body: r.ok ? parseJson(r.text) : r.text.slice(0, 200) };
}
