// Jupyter Contents API over the runtime proxy tunnel — files WITHOUT Drive.
// Live-verified (raw/colab_push.py): push = PUT {runtimeUrl}/api/contents/{path}
// {type:"file",format:"base64",content}; mkdir = PUT {type:"directory"};
// pull = GET ?content=1&format=base64; listing = GET ?content=1.
// Auth = X-Colab-Runtime-Proxy-Token header (NO Bearer) + vscode agent headers.
// Path note: leading-slash remote ("/content/ws") keeps the DOUBLE slash in the
// URL ("/api/contents//content/...") — that is the form their python probe used
// and it answers fine; replicate exactly.
import { EXT_HEADERS } from "../const";
import { httpFetch, parseJson } from "./oauth";
import { connStale, refreshRuntimeRow, RuntimeRow } from "./colabApi";
import { Tokens } from "./util";

/** proxy body limit — base64 +33% inflate; <=~36MB raw is the proven-safe zone. */
export const MAX_CONTENT_BYTES = 36 * 1024 * 1024;

export interface ContentsEntry {
  name: string;
  path: string;
  type: string; // "file" | "directory"
  size?: number;
  mimetype?: string;
}

function encPath(remotePath: string): string {
  // keep "/" separators, escape the rest — mirrors urllib.parse.quote(p, safe="/")
  return remotePath.split("/").map((s) => encodeURIComponent(s)).join("/");
}

function baseOf(row: RuntimeRow): { base: string; token: string } {
  const ci = row.connectionInfo;
  if (!ci?.url || !ci?.token) {
    throw new Error("connectionInfo missing (re-list runtimes)");
  }
  return { base: ci.url.replace(/\/+$/, ""), token: ci.token };
}

async function call(
  row: RuntimeRow,
  method: "GET" | "PUT" | "DELETE",
  remotePath: string,
  bodyObj?: unknown,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const { base, token } = baseOf(row);
  const url = `${base}/api/contents/${encPath(remotePath)}`;
  const r = await httpFetch(url, {
    method,
    headers: {
      ...EXT_HEADERS,
      Accept: "application/json",
      "X-Colab-Runtime-Proxy-Token": token,
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
    timeoutMs,
  });
  if (r.status >= 400) {
    throw new Error(`contents ${method} ${remotePath}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  try {
    return parseJson(r.text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** connectionInfo short-lived (~1h) — stale pe server-fresh row laao. */
export async function freshRow(t: Tokens, row: RuntimeRow): Promise<RuntimeRow> {
  if (!connStale(row)) {
    return row;
  }
  return refreshRuntimeRow(t, row);
}

/** ensure remote directory; "already exists" tolerate. */
export async function makeDir(row: RuntimeRow, dirRemote: string): Promise<void> {
  try {
    await call(row, "PUT", dirRemote, { type: "directory" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/HTTP 4\d\d/.test(msg)) {
      throw e;
    }
  }
}

export async function putFile(row: RuntimeRow, remotePath: string, data: Buffer): Promise<number> {
  if (data.length > MAX_CONTENT_BYTES) {
    throw new Error(`file too big for contents-push (${(data.length / 1048576).toFixed(1)}MB > 36MB) — use a smaller file`);
  }
  await call(
    row,
    "PUT",
    remotePath,
    { type: "file", format: "base64", content: data.toString("base64") },
    180_000,
  );
  return data.length;
}

export async function getFile(row: RuntimeRow, remotePath: string): Promise<Buffer> {
  const j = await call(row, "GET", remotePath, undefined, 180_000);
  const type = (j.type as string) || "";
  if (type === "directory") {
    throw new Error(`contents GET ${remotePath}: is a directory (pull files, not folders)`);
  }
  const b64 = (j.content as string) || "";
  if (!b64) {
    throw new Error(`contents GET ${remotePath}: empty content (HTTP)`);
  }
  return Buffer.from(b64, "base64");
}

/** directory listing; nonexistent dir → empty (treat as "nothing pulled yet"). */
export async function listDir(row: RuntimeRow, remoteDir: string): Promise<ContentsEntry[]> {
  let j: Record<string, unknown>;
  try {
    j = await call(row, "GET", remoteDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/HTTP 404/.test(msg)) {
      return [];
    }
    throw e;
  }
  const type = (j.type as string) || "";
  if (type !== "directory") {
    return [];
  }
  return ((j.content as ContentsEntry[]) || []).map((e) => ({
    name: e.name || "",
    path: e.path || "",
    type: e.type || "file",
    size: e.size,
    mimetype: e.mimetype,
  }));
}

export async function deleteFile(row: RuntimeRow, remotePath: string): Promise<void> {
  try {
    await call(row, "DELETE", remotePath, undefined, 60_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/HTTP 404/.test(msg)) {
      // 404 = already gone (fine); other statuses surface honestly
      throw e;
    }
  }
}

/** relative path pieces → remote dirs to ensure first (depth-sorted). */
export function dirsFor(rel: string, remoteRoot: string): string[] {
  const parts = rel.split("/").filter(Boolean);
  const dirs: string[] = [remoteRoot];
  let cur = remoteRoot;
  for (const p of parts.slice(0, -1)) {
    cur = `${cur}/${p}`;
    dirs.push(cur);
  }
  return dirs;
}
