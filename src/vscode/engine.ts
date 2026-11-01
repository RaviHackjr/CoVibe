// Orchestration: connection pool (per-runtime hidden exec sessions), sync engine, runner.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Tokens } from "../libs/util";
import type { ColabPtySession } from "./ptyTerminal";
import { TtyClient, sleep } from "../libs/ttyClient";
import {
  RuntimeRow,
  listRuntimes,
  refreshRuntimeRow,
  varySpec,
} from "../libs/colabApi";
import {
  MAX_CONTENT_BYTES,
  deleteFile as contentsDelete,
  dirsFor,
  freshRow as contentsFreshRow,
  getFile as contentsGet,
  listDir as contentsList,
  makeDir as contentsMkdir,
  putFile as contentsPut,
} from "../libs/contentsApi";
import {
  FileStamp,
  SyncFileState,
  buildLangCmd,
  buildRunCommand,
  classifyConnect,
  langOf,
  matchIgnores,
  planSync,
  retryableKind,
  backoffMs,
  EXEC_CONNECT_BUDGET_MS,
} from "../libs/util";

export interface SyncPlanResult {
  uploaded: string[];
  deleted: string[];
  pulled?: string;
  skipped: number;
}

function walkMatch(name: string, pats: string[]): boolean {
  // folder entries checked by name; file ext patterns like *.pyc also matched via wildcard fn
  return matchIgnores(name, pats);
}

export class Engine {
  private execPool = new Map<string, TtyClient>();
  private execBusy = new Map<string, Promise<number>>();
  private watcher?: vscode.Disposable;
  private syncDebtTimer?: NodeJS.Timeout;
  private runtime: RuntimeRow | undefined;
  /** saare assigned runtimes — multi-runtime pair support (CPU+GPU/TPU). */
  private rows = new Map<string, RuntimeRow>();
  /** sab hidden execs ek chain me — pane-0 pe do exec race nahi karte (garble root cause) */
  private execChain: Promise<unknown> = Promise.resolve();
  /** runtime-scoped release generation: release pe bump → purane retry loops
   * apna captured generation KHARAP hone pe khud band ho jate hain (no aborted
   * op can mark/connect or publish rows afterwards). */
  private scopes = new Map<string, number>();
  /** ek runtime ke liye ek hi warmup ka the pramāṇ time */
  private warming = new Set<string>();

  /** serialize any tty op — run one at a time, next waits. */
  private chain<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.execChain.then(fn, fn);
    this.execChain = run.catch(() => undefined);
    return run;
  }

  constructor(
    private readonly ctx: vscode.ExtensionContext,
  ) {}

  // ---- tokens (provided by caller)
  private tokens?: Tokens;
  /** access token expire hone pe extension-side refresh engine bula sakta hai */
  tokenRefresh?: () => Promise<Tokens>;
  /** panel log sink — connect retries/boot waiting user ko dikhta hai */
  onNote?: (msg: string) => void;

  setTokens(t: Tokens): void {
    this.tokens = t;
  }

  private requireTokens(): Tokens {
    if (!this.tokens) {
      throw new Error("Not signed in.");
    }
    return this.tokens;
  }

  // ---- workspace root
  private root(): string {
    return vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? process.cwd();
  }

  private opts(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("colabPipe");
  }

  private ignores(): string[] {
    return this.opts().get("ignore", [".git", "__pycache__", "node_modules", ".venv", "venv", "*.pyc"]);
  }

  private remoteRoot(): string {
    return String(this.opts().get("remoteRoot", "/content/ws"));
  }

  /** per-runtime sync state — fresh assign ka naya state file = PURA folder push
   *  (runtime me kuch nahi hota, isliye state device-major nahi — runtime-major). */
  private runtimeKey(name?: string): string {
    return (name ?? this.runtime?.name ?? "").replace(/[^a-z0-9-]/gi, "").slice(-12) || "none";
  }

  private stateFileFor(name?: string): string {
    return path.join(this.ctx.globalStorageUri.fsPath, `sync-state-${this.runtimeKey(name)}.json`);
  }

  private stateFile(): string {
    return this.stateFileFor();
  }

  private loadState(): Record<string, SyncFileState> {
    if (!this.runtime) {
      return {};
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile(), "utf8")) as Record<string, SyncFileState>;
      return raw;
    } catch {
      return {};
    }
  }

  private saveState(st: Record<string, SyncFileState>): void {
    fs.mkdirSync(path.dirname(this.stateFile()), { recursive: true });
    fs.writeFileSync(this.stateFile(), JSON.stringify(st), "utf8");
  }

  private walkLocal(root: string): Record<string, FileStamp> {
    const out: Record<string, FileStamp> = {};
    const push = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (walkMatch(e.name, this.ignores())) {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          push(full);
        } else if (e.isFile()) {
          const st = fs.statSync(full);
          const rel = path.relative(root, full).split(path.sep).join("/");
          out[rel] = { size: st.size, mtimeMs: st.mtimeMs };
        }
      }
    };
    push(root);
    return out;
  }

  // ================= runtime selection
  /** saare known runtimes — default first. */
  listRuntimeRows(): RuntimeRow[] {
    const def = this.runtime?.name;
    return [...this.rows.values()].sort(
      (a, b) => Number(b.name === def) - Number(a.name === def),
    );
  }

  /** listRuntimes se sab rows engine me hydrate karo (default preserve/login ke baad bw).
   *  list rows ka runtimeSpec ABSENT hota hai (Colab list projection) — purane
   *  helpers/prerow ka spec merge karo war-na panel cards "(CPU)" false dikhte hain. */
  hydrate(rows: RuntimeRow[]): void {
    for (const r of rows) {
      this.rows.set(r.name, this.mergeSpec(this.rows.get(r.name), r));
    }
    if (this.runtime && !this.rows.has(this.runtime.name)) {
      // default released tha — pehla baaq row default
      this.runtime = rows[0];
    }
    if (!this.runtime && rows.length) {
      this.runtime = rows[0];
    }
  }

  async pickRuntime(interactive = true): Promise<RuntimeRow> {
    const t = this.requireTokens();
    const rows = await listRuntimes(t);
    this.hydrate(rows);
    if (!rows.length) {
      throw new Error("No assigned runtime — use 'Colab: Assign runtime'.");
    }
    let current = (this.runtime && rows.some((r) => r.name === this.runtime!.name) ? this.runtime : rows[0]) as RuntimeRow;
    if (rows.length === 1 || !interactive) {
      this.runtime = current;
      return current;
    }
    const pick = await vscode.window.showQuickPick(
      rows.map((r, i) => ({
        label: `${r.name === current.name ? "★ " : ""}${i + 1}. ${varySpec(r)}`,
        description: shortId(r.name),
        row: r,
      })),
      { title: "Select a Colab runtime" },
    );
    if (pick?.row) {
      this.runtime = pick.row;
      current = pick.row;
    }
    return current;
  }

  getRuntime(): RuntimeRow | undefined {
    return this.runtime;
  }

  /** assign/refresh ke baad — map me bhi daalo + default. */
  setRuntime(row: RuntimeRow): void {
    this.rows.set(row.name, row);
    this.runtime = row;
  }

  /** panel ★ — default (sync/run) pe switch, terminal nahi badalta. */
  setDefault(name: string): boolean {
    const r = this.rows.get(name);
    if (!r) {
      return false;
    }
    this.runtime = r;
    return true;
  }

  clearRuntime(name?: string): void {
    // 1) invalid FIRST — any in-flight or queued op aborts on next await-check
    if (name) {
      this.scopes.set(name, (this.scopes.get(name) ?? 0) + 1);
    } else {
      for (const k of this.rows.keys()) {
        this.scopes.set(k, (this.scopes.get(k) ?? 0) + 1);
      }
      if (this.runtime) {
        this.scopes.set(this.runtime.name, (this.scopes.get(this.runtime.name) ?? 0) + 1);
      }
    }
    // released runtime ka per-device sync state wipe — fresh assign = full folder push
    try {
      if (name) {
        fs.rmSync(this.stateFileFor(name), { force: true });
      }
    } catch {}
    // 2) close hidden exec socket for the released runtime (idempotent)
    if (name) {
      const tty = this.execPool.get(name);
      tty?.close();
      this.execPool.delete(name);
      this.rows.delete(name);
      if (this.runtime?.name === name) {
        this.runtime = this.rows.size ? [...this.rows.values()][0] : undefined;
      }
    } else {
      for (const t of this.execPool.values()) {
        t.close();
      }
      this.execPool.clear();
      this.rows.clear();
      this.runtime = undefined;
    }
    // 3) user-facing pty terminals bound to this runtime — VS Code closes tab,
    //    ColabPtySession.close() stops its retry timer (release kill-switch)
    this.closeTerminalsFor(name);
  }

  /** pty terminals holding this runtime — dispose se unke retry loops band. */
  private closeTerminalsFor(name?: string): void {
    for (const t of vscode.window.terminals) {
      const p = (t as vscode.Terminal & { __colabPty__?: import("./ptyTerminal").ColabPtySession }).__colabPty__;
      if (!p) {
        continue;
      }
      if (!name || p.row.name === name) {
        try {
          t.dispose();
        } catch {}
      }
    }
  }

  // ---- lifecycle tokens (ptyTerminal cancelCheck in):

  /** CURRENT released-ready generation captured by caller (terminal/session). */
  aliveToken(name?: string): number {
    return name ? (this.scopes.get(name) ?? 0) : -1;
  }

  /** token abhi bhi valid? (released=false for identical generation + rows map hold) */
  isAlive(name: string, token: number): boolean {
    return (this.scopes.get(name) ?? 0) === token && this.rows.has(name);
  }

  /** incoming row pe runtimeSpec ABSENT ho (list projection) to existing merge. */
  private mergeSpec(prev: RuntimeRow | undefined, row: RuntimeRow): RuntimeRow {
    if (!row.runtimeSpec?.key && prev?.runtimeSpec?.key) {
      return { ...row, runtimeSpec: prev.runtimeSpec };
    }
    return row;
  }

  /** rows-only refresh — ★ default runtime hard se flip NAHI hota (pair runs) */
  updateRow(row: RuntimeRow): void {
    this.rows.set(row.name, this.mergeSpec(this.rows.get(row.name), row));
    if (this.runtime?.name === row.name) {
      this.runtime = this.rows.get(row.name);
    }
  }

  // ================= drive sync (upload diff)
  /**
   * SINGLE-WS INVARIANT — Colab runtime per ek hi tty WebSocket jhelta hai:
   * doosra WS attach hote hi pehla server-side mar jaata hai. Isliye engine ops
   * (helper/sync/run) pehle USER terminal ki WIRED tty borrow karte hain
   * (messages ENGINE markers/frames user pane pe display-gate se INVISIBLE);
   * borrow fail tabhi engine-owned exec WS fallback (connectionInfo fresh).
   * ops execChain se serialized — ek waqt me ek hi typing flow.
   */

  /* wrapper around workspace display info */
  private ptyTerminalFor(name: string): ColabPtySession | undefined {
    for (const vt of vscode.window.terminals) {
      const p = (vt as vscode.Terminal & { __colabPty__?: ColabPtySession }).__colabPty__;
      if (p && p.row.name === name && !p.isDisposed) {
        return p;
      }
    }
    return undefined;
  }

  /** user terminal bound to THIS runtime ki live tty (borrow queue target). */
  private borrowTty(row: RuntimeRow): TtyClient | undefined {
    const p = this.ptyTerminalFor(row.name);
    return p?.client ?? undefined;
  }

  /** user pty ATTACH ho gayi — engine-owned exec WS band (single-WS invariant). */
  purgeRuntimeWS(name: string): void {
    const t = this.execPool.get(name);
    if (t) {
      try {
        t.close();
      } catch {}
      this.execPool.delete(name);
    }
  }

  private async _connectExec(row: RuntimeRow): Promise<TtyClient> {
    const key = row.name;
    const had = this.execPool.get(key);
    if (had && !had.closed) {
      return had;
    }
    this.execPool.delete(key);
    const tok = this.scopes.get(key) ?? 0;
    const cancelled = (): boolean => !this.isAlive(key, tok);
    const deadline = Date.now() + EXEC_CONNECT_BUDGET_MS;
    let attempt = 0;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (cancelled()) {
        throw new Error(`connection cancelled — runtime ${shortId(key)} released`);
      }
      attempt++;
      try {
        const fresh = await refreshRuntimeRow(this.requireTokens(), row);
        if (cancelled()) {
          throw new Error(`connection cancelled — runtime ${shortId(key)} released`);
        }
        // strict same-name (refreshRuntimeRow guarantees) — kabhi galat machine nahi
        this.updateRow(fresh);
        const tty = await TtyClient.open(fresh, undefined);
        // STALE-PUBLISH GUARD — release/dial ka race: purana attempt kabhi
        // connect nahi kar sakta ab released rows me
        if (cancelled()) {
          try {
            tty.close();
          } catch {}
          throw new Error(`connection cancelled — runtime ${shortId(key)} released`);
        }
        this.execPool.set(key, tty);
        if (attempt > 1) {
          this.onNote?.(`✅ hidden exec connected — ${shortId(key)} (after ${attempt - 1} boot wait)`);
        }
        return tty;
      } catch (e) {
        lastErr = e;
        if (cancelled()) {
          throw new Error(`connection cancelled — runtime ${shortId(key)} released`);
        }
        const msg = e instanceof Error ? e.message : String(e);
        const kind = classifyConnect(msg);
        if (!retryableKind(kind)) {
          break; // auth/released/fatal — loop-retry with same creds soon ended
        }
        const wait = backoffMs(attempt, { baseMs: 1500, factor: 1.6, capMs: 8000, jitter: 0.25 });
        this.onNote?.(
          `⏳ Resolving runtime host — hidden exec retry #${attempt} (${kind as string}) — next in ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "connection deadline reached"));
  }

  /** assign ke turant baad pool garam — per-runtime ek hi warmup ka time (dedupe) */
  async warmup(row?: RuntimeRow): Promise<void> {
    const target = row ?? this.runtime;
    if (!target || this.warming.has(target.name)) {
      return;
    }
    this.warming.add(target.name);
    try {
      await this.chain(() => this._connectExec(target));
    } catch {
      // silent — repeated execution path pe connectExec khud phir se try karega
    } finally {
      this.warming.delete(target.name);
    }
  }

  // ================= drive sync (upload diff)
  /**
   * SYNCKING = DIRECT Contents API over the runtime proxy tunnel (NO Drive in the
   * hot path, NO helper script, NO tty typing):
   *   push = PUT /api/contents/<path> (base64 body)  — save watch pe debounced
   *   pull = GET /api/contents/<dir>?content=1 (listing) → GET file (base64)
   * Drive round-trips and `.gdrive_sync.py` install ka poora machinery hata —
   * runtime connect hote hi files DIRECT pahunch jaati hain (drag-drop feel).
   */

  /** LOCAL → RUNTIME diff-push (Contents API). Mutter: incremental state based. */
  private async _pushToRuntime(row: RuntimeRow): Promise<{ up: string[]; del: string[]; skipped: number; failed: string[] }> {
    const root = this.root();
    const st: Record<string, SyncFileState> = this.loadState();
    const now = this.walkLocal(root);
    const plan = planSync(now, st as Record<string, FileStamp>);
    const rr = this.remoteRoot();
    const failed: string[] = [];
    const uploaded: string[] = [];
    const deleted: string[] = [];
    let skipped = 0;
    // parent-dirs ensure (depth-sorted, duplicate-free)
    const dirSet = new Set<string>();
    for (const rel of plan.toUpload) {
      for (const d of dirsFor(rel, rr)) {
        dirSet.add(d);
      }
    }
    const dirs = [...dirSet].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    // depth-groups parallel (parent-first chain preserved, per batch Promise.all)
    const dirGroups = new Map<number, string[]>();
    for (const d of dirs) {
      const n = d.split("/").length;
      const g = dirGroups.get(n) ?? (dirGroups.set(n, []).get(n) as string[]);
      g.push(d);
    }
    for (const depth of [...dirGroups.keys()].sort((a, b) => a - b)) {
      await Promise.all(dirGroups.get(depth)!.map((x) => contentsMkdir(row, x).catch(() => undefined)));
    }
    // uploads — local reads (instant) + HTTP pool of 6 (proxy tunnel ka asli samay yahi bachata hai)
    const jobs: { rel: string; data: Buffer; stamp: FileStamp }[] = [];
    for (const rel of plan.toUpload) {
      const full = path.join(root, rel);
      try {
        const data = fs.readFileSync(full);
        if (data.byteLength > MAX_CONTENT_BYTES) {
          skipped++;
          continue;
        }
        jobs.push({ rel, data, stamp: { size: now[rel].size, mtimeMs: now[rel].mtimeMs } });
      } catch {
        // file vanished between plan and push — skip silently
        continue;
      }
    }
    const q = [...jobs];
    await Promise.all(
      Array.from({ length: Math.min(6, Math.max(1, q.length)) }, async () => {
        while (q.length) {
          const j = q.shift()!;
          try {
            await contentsPut(row, `${rr}/${j.rel}`, j.data);
            st[j.rel] = j.stamp;
            uploaded.push(j.rel);
          } catch (e) {
            failed.push(`${j.rel}: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
          }
        }
      }),
    );
    const dq = [...plan.toDelete];
    await Promise.all(
      Array.from({ length: Math.min(6, Math.max(1, dq.length)) }, async () => {
        while (dq.length) {
          const rel = dq.shift()!;
          try {
            await contentsDelete(row, `${rr}/${rel}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/HTTP 404/.test(msg)) {
              failed.push(`del ${rel}: ${msg.slice(0, 80)}`);
            }
          }
          delete st[rel];
          deleted.push(rel);
        }
      }),
    );
    this.saveState(st);
    return { up: uploaded, del: deleted, skipped, failed };
  }

  /** RUNTIME → LOCAL recursive pull. mtime/size state-based — unchanged files HTTP list level highway skip. */
  private async _pullFromRuntime(row: RuntimeRow): Promise<string> {
    const root = this.root();
    const rr = this.remoteRoot();
    const st: Record<string, SyncFileState> = this.loadState();
    const pulledList: string[] = [];
    let failed = 0;
    const walk = async (rd: string): Promise<void> => {
      const entries = await contentsList(row, rd);
      for (const e of entries) {
        const epath = `${rd}/${e.name}`;
        const rel = epath.slice(rr.length).replace(/^\//, "");
        if (walkMatch(rel, this.ignores())) {
          continue;
        }
        if (e.type === "directory") {
          await walk(epath);
          continue;
        }
        const local = path.join(root, rel);
        try {
          let stat: fs.Stats | undefined;
          try {
            stat = fs.statSync(local);
          } catch {}
          if (stat && st[rel] && st[rel].size === stat.size) {
            // size unchanged + pehle pull ho chuka — pull-skip
            if (e.size === undefined || e.size === stat.size) {
              continue;
            }
          }
          const bytes = await contentsGet(row, epath);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, bytes);
          const after = fs.statSync(local);
          st[rel] = { size: bytes.length, mtimeMs: after.mtimeMs };
          pulledList.push(rel);
        } catch (err) {
          failed++;
          this.onNote?.(`⚠ pull failed ${rel}: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
        }
      }
    };
    await walk(rr);
    this.saveState(st);
    return `{"pulled": ${pulledList.length}, "deleted": 0, "failed": ${failed}}`;
  }

  /** watcher/external save-sync — serialized. */
  async runtimeSync(): Promise<SyncPlanResult> {
    return this.chain(() => this._runtimeSync());
  }

  /** runCommand ke chain context ke andar se (already serialized) */
  private runtimeSyncQuiet(): Promise<SyncPlanResult> {
    return this._runtimeSync();
  }

  private async _runtimeSync(): Promise<SyncPlanResult> {
    const t = this.requireTokens();
    const row = this.runtime ?? (await this.pickRuntime(false));
    // connectionInfo short-lived — pehla stale → fresh row (engine state update)
    const fresh = await contentsFreshRow(t, row);
    if (fresh !== row) {
      this.updateRow(fresh);
    }
    const target = fresh;
    const push = await this._pushToRuntime(target);
    const pulled = await this._pullFromRuntime(target);
    const failNote = push.failed.length ? ` failed(push): ${push.failed.join(" | ")}` : "";
    return {
      uploaded: push.up,
      deleted: push.del,
      skipped: push.skipped,
      pulled: pulled + failNote,
    };
  }

  // ================= run
  async runActive(doc: vscode.TextDocument | undefined, targetRow?: RuntimeRow): Promise<void> {
    if (!doc) {
      void vscode.window.showErrorMessage("No active file.");
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const root = folder ? folder.uri.fsPath : this.root();
    let rel = path.relative(root, doc.uri.fsPath).split(path.sep).join("/");
    if (rel.startsWith("..") || rel.startsWith(".")) {
      void vscode.window.showErrorMessage("Active file lies outside the first workspace folder.");
      return;
    }
    const ext = langOf(rel);
    const cmd = ext ? buildLangCmd(rel) : `bash "${rel}"`; // unknown ext => bash script
    // run se PEHLE auto-save — dirty file ka aakhri content hi runtime pe push ho
    try {
      if (doc.isDirty) {
        await doc.save();
      }
    } catch {}
    await this.runCommand(cmd?.trim() || `bash "${rel}"`, `run ${rel}`, targetRow);
  }

  async runCommand(statement: string, titleLabel?: string, targetRow?: RuntimeRow): Promise<void> {
    return this.chain(() => this._runCommand(statement, titleLabel, targetRow));
  }

  private async _runCommand(statement: string, titleLabel?: string, targetRow?: RuntimeRow): Promise<void> {
    const row = targetRow ?? this.runtime ?? (await this.pickRuntime(false));
    // 1. sync FIRST (push→runtime direct HTTP, outputs pull back) — file runtime pe fresh
    let syncNote = "";
    try {
      await this.runtimeSyncQuiet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      syncNote = `⚠ sync FAILED (${msg.slice(0, 120)}) — runtime file may be stale or missing`;
    }
    // 2. exec — DIRECT command (b64 decode inside the shell; python template is -u
    // unbuffered → REAL-TIME stream). helper/.lp_exec.sh install ka chakkar khatam.
    // single-WS invariant: user tty borrow else engine-owned WS.
    const t0 = Date.now();
    let borrowed = this.borrowTty(row);
    if (!borrowed && !this.ptyTerminalFor(row.name)) {
      // run WITHOUT an open terminal — ek terminal is runtime pe khulwao (realtime tab)
      this.onNote?.(`🛰 no terminal attached — opening one for this runtime…`);
      void vscode.commands.executeCommand("colabPipe.openTerminalAt", row.name);
      // attach wait (connect may boot-wait) — max 25s, phir engine-own WS fallback
      for (let i = 0; i < 125 && !borrowed; i++) {
        await sleep(200);
        if (Date.now() - t0 > 25_000) {
          break;
        }
        borrowed = this.borrowTty(row);
      }
    }
    const tty = borrowed ?? (await this._connectExec(row));
    const base = buildRunCommand(statement);
    const b64 = Buffer.from(base, "utf8").toString("base64");
    // eval inside bash -c child: cwd = remote root; b64 quote-safe ([A-Za-z0-9+/=])
    const full = `cd ${this.remoteRoot()} && bash -c "$(printf '%s' '${b64}' | base64 -d)"`;
    // output target: the pty bound to THIS runtime — undefined-safe (fresh window
    // ya koi Colab terminal band ho to crash NAHI hota; output fallback channel pe)
    const bound = this.ptyTerminalFor(row.name);
    const term = bound
      ? vscode.window.terminals.find((x) => (x as vscode.Terminal & { __colabPty__?: ColabPtySession }).__colabPty__ === bound)
      : vscode.window.terminals.find((x) => x.name.startsWith("Colab"));
    if (term) {
      term.show(true);
    }
    const pty = term
      ? (term as vscode.Terminal & { __colabPty__?: ColabPtySession }).__colabPty__
      : undefined;
    if (syncNote && pty) {
      pty.writeLocal(`\u001b[33m${syncNote}\u001b[0m\r\n`);
    }
    if (pty) {
      pty.writeLocal(`\u001b[90m▌ CoVibe run ▸ ${titleLabel ?? statement}\u001b[0m\r\n`);
    }
    // single-WS display routing — pre-capsule work hidden, run output LIVE renders;
    // RAW pty.onData tee hata (wo helper noise bhi dump kar deta tha)
    let res;
    try {
      res = await tty.exec(full, 900_000, {
        interrupt: borrowed ? "ctrl-u" : "ctrl-c",
        visible: true,
      });
    } finally {
      // display state exec() ke finally me restore hota hai — no leak
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    vsConsole(`[run] ${titleLabel ?? statement} — exit ${res.exit ?? "?"} in ${elapsed}s`);
    if (!pty) {
      const out = res.out;
      const chh = vscode.window.createOutputChannel("CoVibe");
      chh.append(out);
      chh.show(true);
    } else {
      pty.writeLocal(`\u001b[90m▌ exit ${res.exit ?? "?"} · ${elapsed}s\u001b[0m\r\n`);
    }
  }

  // ================= watcher (instant save → drive)
  armWatcher(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!this.opts().get("autoSync", true) || !doc) {
        return;
      }
      // schedule debounce 800ms
      if (this.syncDebtTimer) {
        clearTimeout(this.syncDebtTimer);
      }
      this.syncDebtTimer = setTimeout(async () => {
        try {
          await this.runtimeSync();
          void vscode.window.setStatusBarMessage("$(cloud-upload) Colab synced", 3000);
          if (this.opts().get("autoRun", false) && doc.languageId) {
            await this.runActive(doc);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          void vscode.window.setStatusBarMessage(`Colab sync failed: ${msg.slice(0, 60)}`, 8000);
        }
      }, 800);
    });
    this.ctx.subscriptions.push(this.watcher);
  }

  disarmWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  isWatching(): boolean {
    return !!this.watcher;
  }

  dispose(): void {
    for (const t of this.execPool.values()) {
      t.close();
    }
    this.execPool.clear();
    this.disarmWatcher();
  }
}

export function shortId(name: string): string {
  const s = name.split("/").pop() || name;
  return s.length > 18 ? s.slice(0, 8) + "…" : s;
}

// tiny channel helper
let chan: vscode.OutputChannel | undefined;
function ch(): vscode.OutputChannel {
  chan ??= vscode.window.createOutputChannel("CoVibe");
  return chan;
}

export function vsConsole(msg: string): void {
  ch().appendLine(msg);
  // eslint-disable-next-line no-restricted-properties
}
export function showChan(): void {
  ch().show(true);
}
