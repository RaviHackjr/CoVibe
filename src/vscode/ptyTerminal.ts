// Pseudoterminal relay: native VS Code terminal tab ↔ Colab /colab/tty WebSocket.
//
// AUTHORITATIVE connection lifecycle per terminal (no competing loops):
//   idle → connecting → connected
//   connecting → (classified transient error → bounded backoff+jitter) → connecting
//   connecting → cancelled  (runtime released / terminal disposed)
//   connecting → failed     (deadline tried out — honest message, manual retry)
// Repeated openTerminal commands reuse the SAME terminal via kick() — one
// retry counter, one WebSocket, no duplicate establishment loops.
import * as vscode from "vscode";
import { TtyClient, sleep } from "../libs/ttyClient";
import { RuntimeRow } from "../libs/colabApi";
import { backoffMs, classifyConnect, retryableKind, TERMINAL_CONNECT_TRIES } from "../libs/util";

export class ColabPtySession implements vscode.Pseudoterminal {
  private readonly onDidWriteEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.onDidWriteEmitter.event;
  private readonly onDidCloseEmitter = new vscode.EventEmitter<number | undefined>();
  readonly onDidClose: vscode.Event<number | undefined> = this.onDidCloseEmitter.event;
  private readonly onDidDimEmitter = new vscode.EventEmitter<vscode.TerminalDimensions | undefined>();
  readonly onDidOverrideDimensions: vscode.Event<vscode.TerminalDimensions | undefined> = this.onDidDimEmitter.event;

  private connecting = false;
  private disposed = false;
  private queuedInput = "";
  private lastDims = { cols: 120, rows: 30 };
  private bootTry = 0;
  private bootTimer?: NodeJS.Timeout;
  private cycleStart = 0;

  constructor(
    public row: RuntimeRow,
    private tty?: TtyClient,
    public runningMode = "interactive",
    public notify?: (msg: string) => void,
    /** har retry se pehle fresh connectionInfo wali row deta */
    public refresher?: () => Promise<RuntimeRow>,
    /** runtime released? (engine.isAlive(name, captured token)) */
    public cancelCheck?: () => boolean,
    /** SUCCESSFUL attach par — engine exec WS purge (single-WS invariant) */
    public onConnected?: () => void,
  ) {}

  /** terminal's knowledge of its runtime is still current? */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private alive(): boolean {
    return !this.disposed && !(this.cancelCheck?.() ?? false);
  }

  /** engine borrowTty — THIS terminal ki live WS (single-WS invariant). */
  get client(): TtyClient | undefined {
    return this.tty && !this.tty.closed ? this.tty : undefined;
  }

  private wire(tty: TtyClient): void {
    tty.onData = (chunk: string) => {
      // terminal handles raw ANSI directly — pass verbatim.
      this.onDidWriteEmitter.fire(chunk);
    };
    tty.onClose = () => {
      this.onDidWriteEmitter.fire(`\r\n\u001b[90m─ Colab tty closed — type anything to reconnect ─\u001b[0m\r\n`);
      this.tty = undefined;
    };
  }

  /** Visible shell ko apne private tmux session me shift — engine exec (pane 0 ko
   * target karta hai) user ke screen pe size/noise print karta nahi. Session name
   * deterministic (runtime id tail) — reconnect pe WAHI shell/history milta hai. */
  private async isolate(tty: TtyClient): Promise<void> {
    const sn = `lp_${shortId(this.row.name).replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
    tty.sendKeys(
      `command -v tmux >/dev/null 2>&1 || exit 0; ` +
        `tmux has-session -t ${sn} 2>/dev/null || tmux new-session -d -s ${sn} 2>/dev/null; ` +
        `tmux switch-client -c "$TMUX" -t ${sn} 2>/dev/null; stty echo 2>/dev/null; clear\n`,
    );
    await sleep(900);
    tty.drain();
  }

  async open(initial?: vscode.TerminalDimensions): Promise<void> {
    if (initial) {
      this.lastDims = { cols: initial.columns, rows: initial.rows };
    }
    await this.connect();
  }

  /** repeated "open terminal" command — if a session exists, focus + single retry push */
  kick(): void {
    const now = Date.now();
    if (now - this.lastKick < 900) {
      return;
    }
    this.lastKick = now;
    if (this.connecting || (this.tty && !this.tty.closed)) {
      return;
    }
    this.onDidWriteEmitter.fire(`\u001b[90m─ manual reconnect requested ─\u001b[0m\r\n`);
    void this.connect();
  }

  private lastKick = 0;

  private cancelled(reason: string, cause?: string): void {
    this.disposed = true;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    this.tty?.close();
    this.tty = undefined;
    const causeLine = cause ? `\n\u001b[90m  · cause: ${String(cause).slice(0, 160)}\u001b[0m` : "";
    this.onDidWriteEmitter.fire(`\r\n\u001b[33m─ Connection cancelled — ${reason} ─${causeLine}\r\n`);
    this.notify?.(`Connection cancelled — ${reason}${cause ? ` (${String(cause).slice(0, 120)})` : ""}`);
    this.queuedInput = "";
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.disposed) {
      return;
    }
    // release claim VERIFY policy: ONLY the server's list decides (refresher =
    // listRuntimes + strict same-name find). Internal bookkeeping (scope/rows)
    // ne pehle jhoothi release claim kar di thi — cancel NO-SAY now.
    if (!this.alive() && !this.disposed) {
      if (!this.refresher) {
        this.cancelled("the runtime was released");
        return;
      }
      this.connecting = true;
      try {
        this.row = await this.refresher();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.cancelled("the runtime was released", msg);
        this.connecting = false;
        return;
      }
      this.connecting = false;
      // server said the runtime EXISTS. Only a real tab-close cancels now.
      if (this.disposed) {
        return;
      }
    }
    this.connecting = true;
    if (this.bootTry === 0) {
      this.cycleStart = Date.now();
    }
    const cols = this.lastDims.cols;
    const rows = this.lastDims.rows;
    try {
      if (!this.tty || this.tty.closed) {
        this.notify?.(`Refreshing runtime connection… (${shortId(this.row.name)})`);
        if (this.bootTry > 0 && this.refresher) {
          // retries keep the row's connectionInfo fresh — release shows up as a throw here
          this.row = await this.refresher();
          if (this.disposed) {
            return;
          }
        }
        const id0 = shortId(this.row.name);
        this.notify?.(`Connecting terminal… (${id0})`);
        this.tty = await TtyClient.open(this.row, undefined, { cols, rows });
        // stale-establishment guard — tab closed during establishment: silent stop
        if (this.disposed) {
          this.tty?.close();
          this.tty = undefined;
          return;
        }
        this.wire(this.tty);
        this.bootTry = 0;
        this.cycleStart = Date.now();
        // engine's hidden execs stay off-screen — switch user client away from pane-0
        await this.isolate(this.tty);
        if (this.disposed) {
          return;
        }
        this.onDidWriteEmitter.fire(`\r\n\u001b[32m─ Terminal connected — Colab ${id0} private shell (^C pass-through, 'exit' closes) ─\u001b[0m\r\n`);
        this.notify?.(`✅ Terminal connected — ${id0}`);
        this.onConnected?.();
      } else if (this.tty) {
        this.tty.resize(cols, rows);
      }
      // keystrokes typed before connect — flush now
      const q = this.queuedInput;
      this.queuedInput = "";
      if (q && this.tty) {
        this.onDidWriteEmitter.fire(`\u001b[90m(flushing ${q.length} queued chars)\u001b[0m\r\n`);
        this.tty.sendKeys(q);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const id0 = shortId(this.row.name);
      this.tty = undefined;
      // server-truth cancels only: refresher ne listRuntimes se CONFIRM kiya released hai
      if (/no longer exists|no assigned runtime/i.test(msg)) {
        this.cancelled("the runtime was released", msg);
        return;
      }
      const kind = classifyConnect(msg);
      if ((kind === "dns" || kind === "conn" || kind === "proxy") && this.bootTry < TERMINAL_CONNECT_TRIES) {
        this.bootTry++;
        const wait = backoffMs(this.bootTry, { baseMs: 2000, factor: 1.55, capMs: 10_000 }, Math.random);
        const elapsed = Math.max(1, Math.round((Date.now() - this.cycleStart) / 1000));
        this.onDidWriteEmitter.fire(
          `\u001b[90m─ Resolving runtime host… connection delayed — retrying (attempt ${this.bootTry}/${TERMINAL_CONNECT_TRIES}, elapsed ${elapsed}s) ─\u001b[0m\r\n`,
        );
        this.notify?.(`Connection delayed — retrying (attempt ${this.bootTry}, elapsed ${elapsed}s)`);
        this.bootTimer = setTimeout(() => void this.connect(), wait);
        return;
      }
      this.bootTry = 0;
      const reason =
        kind === "auth"
          ? "proxy authentication failed — refresh the runtime connection and try again"
          : /released|no longer exists/i.test(msg)
            ? "runtime released"
            : kind === "dns"
              ? "runtime host never resolvable — likely released or quota-cycled"
              : "terminal connect failed";
      this.onDidWriteEmitter.fire(`\r\n\u001b[31mCoVibe terminal: ${reason}: ${msg}\u001b[0m\r\n`);
      this.onDidWriteEmitter.fire(
        `\u001b[90m  · Connection timed out — retry or inspect runtime status ("CoVibe: Open terminal" opens a new attempt)\u001b[0m\r\n`,
      );
      this.notify?.(`❌ ${reason}: ${id0}`);
      setTimeout(() => this.onDidCloseEmitter.fire(2), 400);
      return;
    } finally {
      this.connecting = false;
    }
  }

  close(): void {
    this.disposed = true;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    this.tty?.close();
    this.tty = undefined;
    this.queuedInput = "";
    this.onDidCloseEmitter.fire(undefined);
  }

  handleInput(data: string): void {
    if (this.tty && !this.tty.closed) {
      try {
        this.tty.sendKeys(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.onDidWriteEmitter.fire(`\r\n\u001b[31mCoVibe: ${msg}\u001b[0m\r\n`);
        this.tty = undefined;
      }
      return;
    }
    // no session yet — queue + manual/authoritative reconnect
    this.queuedInput += data;
    if (this.queuedInput.length > 2048) {
      this.queuedInput = this.queuedInput.slice(-2048);
    }
    if (this.disposed) {
      this.onDidWriteEmitter.fire(
        `\u001b[90m  · this terminal's runtime is gone — assign it again, then open a new terminal\u001b[0m\r\n`,
      );
      this.queuedInput = this.queuedInput.slice(-32);
      return;
    }
    if (!this.connecting) {
      this.onDidWriteEmitter.fire(`\u001b[90m─ reconnecting… ${this.queuedInput.length} char(s) queued ─\u001b[0m\r\n`);
      void this.connect();
    }
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.lastDims = { cols: dims.columns, rows: dims.rows };
    try {
      this.tty?.resize(dims.columns, dims.rows);
    } catch {}
  }

  writeLocal(text: string): void {
    this.onDidWriteEmitter.fire(text);
  }
}

function shortId(name: string): string {
  const s = name.split("/").pop() || name;
  return s.length > 18 ? s.slice(0, 8) + "…" : s;
}
