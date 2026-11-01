// Pure helpers with no vscode dependency — unit-testable (smoke.ts).
import { LANG_TEMPLATES } from "../const";

/** 'a/b/c.py' -> 'a@@b@@c.py' (flat Drive name — mirrors raw/colab_pipe.py) */
export function relToDriveName(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/\//g, "@@");
}
/** inverse of relToDriveName */
export function driveNameToRel(name: string): string {
  return name.replace(/@@/g, "/");
}

export function encodeRelForFlatDrive(rel: string): string {
  return rel.replace(/\\/g, "/").replace("/", "@@");
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface SyncFileState extends FileStamp {
  driveId?: string;
}

export interface SyncPlan {
  toUpload: string[];
  toDelete: string[];
}

export function planSync(
  now: Record<string, FileStamp>,
  prev: Record<string, SyncFileState>,
): SyncPlan {
  const toUpload: string[] = [];
  const toDelete: string[] = [];
  for (const [rel, stamp] of Object.entries(now)) {
    const p = prev[rel];
    if (!p || p.size !== stamp.size || Math.abs(p.mtimeMs - stamp.mtimeMs) > 1) {
      toUpload.push(rel);
    }
  }
  for (const rel of Object.keys(prev)) {
    if (!(rel in now)) {
      toDelete.push(rel);
    }
  }
  toUpload.sort();
  toDelete.sort();
  return { toUpload, toDelete };
}

export function matchIgnores(rel: string, patterns: string[]): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  for (const pat of patterns) {
    if (!pat) {
      continue;
    }
    if (pat.includes("*")) {
      const rx = new RegExp(
        "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (rx.test(rel) || rx.test(base)) {
        return true;
      }
      continue;
    }
    if (parts.includes(pat)) {
      return true;
    }
    if (base === pat || rel === pat) {
      return true;
    }
  }
  return false;
}

export function langOf(rel: string): string | null {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  return ext && ext in LANG_TEMPLATES ? ext : null;
}

/** Build executable command for a relative file path. */
export function buildLangCmd(rel: string): string | null {
  const ext = langOf(rel);
  if (!ext) {
    return null;
  }
  const tmpl = LANG_TEMPLATES[ext];
  const cls = rel.slice(rel.lastIndexOf("/") + 1);
  const main = cls.slice(0, cls.lastIndexOf("."));
  const safeCls = main.replace(/[-.]/g, "_").replace(/^[0-9]/, "_$&");
  return tmpl.replace("{src}", rel).replace("{cls}", safeCls);
}

/** Decide: runnable file (single arg with known ext) or raw shell command. */
export function buildRunCommand(statement: string): string {
  const st = statement.trim();
  const parts = st.split(/\s+/);
  if (parts.length === 1) {
    const lc = buildLangCmd(parts[0]);
    if (lc) {
      return lc;
    }
  }
  if (parts.length >= 1) {
    const lc = buildLangCmd(parts[0]);
    if (lc) {
      return lc + st.slice(parts[0].length).trimEnd();
    }
  }
  return st;
}

/** Strip ANSI CSI/OSC so only base64 chars remain (mirrors Python clean_b64). */
export function cleanB64(s: string): string {
  const noOsc = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const noCsi = noOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return noCsi.replace(/[^A-Za-z0-9+/=]/g, "");
}

export const CHUNK_LINE = 1800; // base64 chars per TTY line (safe < 4096 canonical)

export function chunkB64(bytes: Buffer): string[] {
  const b64 = bytes.toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_LINE) {
    chunks.push(b64.slice(i, i + CHUNK_LINE));
  }
  return chunks;
}

export interface ExecResult {
  out: string;
  exit?: string;
}

/** Find arg after marker followed by exit code digits. */
export function splitAtMarker(text: string, marker: string): { out: string; exit?: string } {
  const idx = text.indexOf(marker);
  if (idx < 0) {
    return { out: text };
  }
  const head = text.slice(0, idx);
  const tail = text.slice(idx + marker.length);
  const lineEnd = tail.indexOf("\n");
  const first = lineEnd >= 0 ? tail.slice(0, lineEnd) : tail;
  const m = /\s*(\d+)/.exec(first);
  return { out: head, exit: m ? m[1] : undefined };
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  expiry_date: number; // epoch ms
}

export function tokenFresh(t: Tokens): boolean {
  return Date.now() < t.expiry_date - 60_000;
}

// ============================================================
// Connection-failure classification + retry maths (pure, tested in smoke.ts).
// Colab reality: fresh VM ka proxy host pe ENOTFOUND lagta hai jab tak VM
///proxy boot nahi hota (DNS baad me field hota hai) — kind distinguishes
// genuinely retryable failures from auth/finished-token/protocol fatal cases.
// ============================================================

export type ConnectErrKind = "dns" | "conn" | "proxy" | "auth" | "released" | "fatal";

export function classifyConnect(msg: string): ConnectErrKind {
  const m = msg || "";
  // runtime vanished from the authoritative list (user released it)
  if (/no longer exists|\breleased\b|no assigned runtime|runtime not found/i.test(m)) {
    return "released";
  }
  // authentication / proxy token problems — re подключение CAN be fixed by
  // refreshing connectionInfo, but do it bounded, never in a loop forever
  if (/\(401\)|\(403\)|UNAUTHENTICATED|PERMISSION_DENIED|unauthorized|proxy token|token expired|invalid_grant|forbidden/i.test(m)) {
    return "auth";
  }
  // DNS — the classic "VM still booting" case
  if (/ENOTFOUND|EAI_AGAIN|Name or service not known|Temporary failure in name resolution|nxdomain/i.test(m)) {
    return "dns";
  }
  // transport-level — refused/reset/timeout etc
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTCONN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|timeout|websocket|1006|handshake/i.test(m)) {
    return "conn";
  }
  // proxy/HTTP-level transient — tunnel up but server not ready/overloaded
  if (/\(502\)|\(503\)|\(429\)|bad gateway|service unavailable|too many requests/i.test(m)) {
    return "proxy";
  }
  // TLS/cert/protocol/config — retrying with same inputs won't help soon
  return "fatal";
}

/** retry-relevant kinds (what a bounded retry loop may keep around for). */
export function retryableKind(kind: ConnectErrKind): boolean {
  return kind === "dns" || kind === "conn" || kind === "proxy";
}

export interface BackoffOpts {
  baseMs?: number;
  factor?: number;
  capMs?: number;
  jitter?: number; // 0..1 — applied symmetrically
}

/** bounded exponential backoff with jitter; attempt starts at 1. */
export function backoffMs(attempt: number, o: BackoffOpts = {}, rnd: () => number = Math.random): number {
  const base = o.baseMs ?? 1500;
  const factor = o.factor ?? 1.6;
  const cap = o.capMs ?? 8000;
  const jit = o.jitter ?? 0.25;
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(cap, base * Math.pow(factor, n - 1));
  return Math.max(250, Math.round(raw * (1 - jit + rnd() * 2 * jit)));
}

/** one canonical budget per establishment operation — no magic fixed 6s loops */
export const EXEC_CONNECT_BUDGET_MS = 120_000; // hidden exec pool
export const TERMINAL_CONNECT_TRIES = 25; // user-facing terminal (waits up to ~2-4 min)
