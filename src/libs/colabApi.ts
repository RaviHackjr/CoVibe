// Colab runtime API (colaboratory.googleapis.com) — Bearer-auth'd subset used by extension.
import { COLAB_API, EXT_HEADERS } from "../const";
import { Tokens } from "./util";
import { httpFetch, parseJson } from "./oauth";

export interface ConnInfo {
  endpoint?: string;
  url?: string;
  token?: string;
  expireTime?: string;
}

export interface RuntimeSpecKey {
  variant?: string;
  accelerator?: string;
  shape?: string;
}

export interface RuntimeRow {
  name: string;
  version?: string;
  runtimeSpec?: { key?: RuntimeSpecKey };
  connectionInfo?: ConnInfo;
}

function authHeaders(t: Tokens): Record<string, string> {
  return { ...EXT_HEADERS, Accept: "application/json", Authorization: `Bearer ${t.access_token}` };
}

async function call(t: Tokens, path: string, init: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<any> {
  const r = await httpFetch(COLAB_API + path, { ...init, headers: authHeaders(t) });
  if (!r.ok) {
    let msg = r.text.slice(0, 400);
    try {
      const j = parseJson(r.text) as any;
      msg = (j.error?.message as string) || r.text.slice(0, 300);
    } catch {}
    throw new Error(`colab api ${init.method || "GET"} ${path}: ${r.status} ${msg}`);
  }
  return parseJson(r.text);
}

/** HAR row ka `name` EK format me hota hai (bare `r-…`, `runtimes/` prefix-less).
 *  Binden — assign (`/v1/operations:wait` response) row full "runtimes/r-…" de
 *  sakta hai, list (`/v1beta/runtimes`) bare de sakta hai. Mixed name scheme se
 *  refresh/find would NEVER match → runtime released jhootha cancel hota jata.
 *  canonRow sab boundaries pe lagta hai, so no more split-brain keys. */
export function canonRow(row: RuntimeRow): RuntimeRow {
  if (row.name.includes("/")) {
    return { ...row, name: shortId(row.name) };
  }
  return row;
}

export async function listRuntimes(t: Tokens): Promise<RuntimeRow[]> {
  const j = await call(t, "/v1beta/runtimes");
  return ((j.runtimes || []) as RuntimeRow[]).map(canonRow);
}

/** connectionInfo missing/expired ho gaya? (proxy token expireTime short-lived hota hai) */
export function connStale(row?: RuntimeRow): boolean {
  const ci = row?.connectionInfo;
  if (!ci?.url || !ci?.token) {
    return true;
  }
  if (ci.expireTime) {
    const tt = Date.parse(ci.expireTime);
    if (!Number.isNaN(tt) && tt - 30_000 < Date.now()) {
      return true;
    }
  }
  return false;
}

/** Stale row → fresh listRuntimes — STRICT same-name match.
 * Purana `?? rows[0]` fallback galat machine (e.g. CPU) ki connectionInfo
 * de deta tha jisne GPU release hota hi loop ki AN OTHER host pe bhagaya —
 * kabhi silent fallback nahi: released runtime ke liye clear error throw. */
export async function refreshRuntimeRow(t: Tokens, row: RuntimeRow): Promise<RuntimeRow> {
  if (!connStale(row)) {
    return row;
  }
  const rows = await listRuntimes(t);
  if (!rows.length) {
    throw new Error("no assigned runtime — assign a machine first (no assigned runtime)");
  }
  const exact = rows.find((r) => r.name === row.name);
  if (!exact) {
    throw new Error(`runtime ${shortId(row.name)} no longer exists (released)`);
  }
  return exact;
}

export async function listSpecs(t: Tokens): Promise<Array<{ eligible: boolean; key: RuntimeSpecKey }>> {
  const j = await call(t, "/v1beta/runtimespecs");
  return (j.runtimeSpecs || []) as any[];
}

export function shortId(name: string): string {
  return name.split("/").pop() || name;
}

export function varySpec(row: RuntimeRow): string {
  const k = row.runtimeSpec?.key || {};
  const v = (k.variant || "").toUpperCase();
  const accel = k.accelerator || "NONE";
  const shape = k.shape || "";
  const label = v.includes("TPU") ? "TPU" : v.includes("GPU") ? "GPU" : "CPU";
  return `${label} ${accel === "NONE" ? "" : accel} ${shape}`.trim();
}

export async function assignRuntime(
  t: Tokens,
  key: RuntimeSpecKey,
  opts: { onWait?: (status: string) => void; maxWaitMs?: number } = {},
): Promise<RuntimeRow> {
  const reqId = crypto.randomUUID();
  const op = await call(t, `/v1beta/runtimes?requestId=${reqId}`, {
    method: "POST",
    body: JSON.stringify({ runtimeSpec: key }),
  });
  if (op.error) {
    throw new Error(op.error.message || JSON.stringify(op.error));
  }
  let cur = op;
  if (!cur.done && cur.name) {
    const max = opts.maxWaitMs ?? 240_000;
    const start = Date.now();
    while (!cur.done && Date.now() - start < max) {
      opts.onWait?.("waiting for runtime...");
      const chunk = Math.min(20, Math.max(5, Math.floor((max - (Date.now() - start)) / 1000)));
      cur = await call(t, `/v1/operations/${cur.name.split("/").pop()}:wait?timeout=${chunk}s`);
    }
    if (!cur.done) {
      throw new Error("assign wait timeout");
    }
  }
  if (cur.error) {
    throw new Error(cur.error.message || JSON.stringify(cur.error));
  }
  return canonRow(cur.response as RuntimeRow);
}

export async function releaseRuntime(t: Tokens, name: string): Promise<void> {
  const id = shortId(name);
  try {
    await call(t, `/v1beta/runtimes/${id}`, { method: "DELETE" });
  } catch (e) {
    const full = encodeURIComponent(name);
    await call(t, `/v1beta/runtimes/${full}`, { method: "DELETE" });
  }
}

import crypto from "crypto";
