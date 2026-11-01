// Colab runtime TTY over WebSocket — {"data": ...} frames; exec/markers + file push.
import WebSocket from "ws";
import { X_RUNTIME_TOKEN } from "../const";
import { chunkB64, cleanB64, ExecResult, splitAtMarker } from "./util";
import { ConnInfo, RuntimeRow } from "./colabApi";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TtyClient {
  private ws?: WebSocket;
  private buffer = "";
  private openOnce = false;
  closed = false;
  cols = 120;
  rows = 30;
  /** true while stty -echo active in the shared pane (restored in finally/close) */
  private echoOff = false;
  /** onData gate — borrowed USER tty pe engine pre-work (markers/stty/wc/base64)
   *  INVISIBLE rakhne ke liye; buffer hamesha accumulate karta hai (capture safe). */
  display = true;
  onData?: (chunk: string) => void; // live sink; buffer always accumulates
  onClose?: () => void;

  private constructor(public readonly serverId: string) {}

  static async open(
    row: RuntimeRow,
    onChunk?: (s: string) => void,
    dims?: { cols: number; rows: number },
  ): Promise<TtyClient> {
    const ci = row.connectionInfo as ConnInfo;
    if (!ci?.url || !ci?.token) {
      throw new Error("connectionInfo missing (re-list runtimes)");
    }
    const url = ci.url.replace(/^http/, "ws").replace(/\/+$/, "") + "/colab/tty";
    const me = new TtyClient(row.name);
    me.onData = onChunk;
    me.cols = dims?.cols ?? 120;
    me.rows = dims?.rows ?? 30;
    // 2 attempts — handshake flakiness / transient proxy errors
    try {
      await me.connect(url, ci.token);
    } catch (e) {
      if (me.attempts >= 2 || /401|403|forbidden|invalid/i.test(String(e))) {
        throw e;
      }
      await sleep(900);
      me.attempts++;
      me.closed = false;
      me.ws = undefined;
      me.openOnce = false;
      await me.connect(url, ci.token);
    }
    return me;
  }

  private attempts = 1;

  private connect(url: string, proxyToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { [X_RUNTIME_TOKEN]: proxyToken },
        handshakeTimeout: 20_000,
      });
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
        reject(new Error("tty connect timeout"));
      }, 25_000);
      ws.once("open", () => {
        clearTimeout(timer);
        this.openOnce = true;
        this.send({ cols: this.cols, rows: this.rows }); // resize first, like extension
        resolve();
      });
      ws.on("message", (d: unknown, isBin: boolean) => {
        const raw = (d as Buffer).toString("utf8");
        let obj: any;
        try {
          obj = JSON.parse(raw);
        } catch {
          this.append(raw as string);
          return;
        }
        if (obj && typeof obj.data === "string") {
          this.append(obj.data);
        }
      });
      ws.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          try {
            this.onClose?.();
          } catch {}
        }
      });
      ws.on("error", (err) => {
        this.closed = true;
        if (!this.openOnce) {
          const em = (err as Error)?.message || String(err);
          reject(new Error(`tty connect failed: ${em}`));
        }
      });
      // keepalive — dovelike: ws.ping() + application frame; Colab proxy WS pings
      // aur long silence dono ke saath "(detached)" aata tha
      const k = setInterval(() => {
        if (this.closed || this.ws?.readyState !== WebSocket.OPEN) {
          clearInterval(k);
          return;
        }
        try {
          this.ws.ping();
          this.ws.send(JSON.stringify({ data: "" }));
        } catch {}
      }, 15_000);
      this.keepAlive = k as unknown as NodeJS.Timeout;
    });
  }

  private keepAlive?: NodeJS.Timeout;

  private append(s: string): void {
    this.buffer += s;
    if (!this.display) {
      return;
    }
    try {
      this.onData?.(s);
    } catch {}
  }

  drain(): string {
    const b = this.buffer;
    this.buffer = "";
    return b;
  }

  private send(o: unknown): void {
    const ws = this.requireWs();
    ws.send(JSON.stringify(o));
  }

  private requireWs(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("tty not connected");
    }
    return this.ws;
  }

  sendKeys(s: string): void {
    this.send({ data: s });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.send({ cols, rows });
  }

  /** wait until buffer (given callback predicate) hits; does not consume. */
  private async waitFor(pred: (whole: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    let all = this.buffer;
    while (Date.now() < end) {
      if (pred(all)) {
        return all;
      }
      await sleep(120);
      all = this.buffer;
      if (this.closed) {
        break;
      }
    }
    return all;
  }

  /** One-shot exec with echo capsule: phases — interrupt → m1-marker → stty-hide →
   *  run(cmd + m2) → restore. Options:
   *   interrupt "ctrl-c" (engine-own tty: foreground kill) | "ctrl-u" (borrowed user
   *   tty: sirf half-typed line clear — user ke running job ko na maare)
   *   visible=true → command OUTPUT frames onData pe jaate (user pane LIVE stream,
   *   run ke liye); default false → engine pre-work/post noise kabhi render nahi.
   * capsule: typed text stty-echo se hidden; m1 phase display=false (visible tab pe
   * "echo __X0_…" leak bhi nahi). Guaranties: stty restore always (finally). */
  async exec(
    cmd: string,
    timeoutMs = 600_000,
    opts: { interrupt?: "ctrl-c" | "ctrl-u"; visible?: boolean } = {},
  ): Promise<ExecResult> {
    const m1 = `__X0_${Math.random().toString(36).slice(2)}__`;
    const m2 = `__X1_${Math.random().toString(36).slice(2)}__`;
    const interrupt = opts.interrupt ?? "ctrl-c";
    this.drain();
    if (interrupt === "ctrl-c") {
      this.sendKeys("\x03\n"); // interrupt anything prior (engine-own shell)
    } else if (interrupt === "ctrl-u") {
      this.sendKeys("\x15\n"); // borrowed user tty — half-line clear, no kill
    }
    await sleep(300);
    this.drain();
    this.display = false; // marker/stty typing — kisi bhi attached display pe nahi
    this.sendKeys(`echo ${m1}\n`);
    let all = await this.waitFor((w) => w.includes(m1), 10_000);
    this.drain();
    // capsule: hide the statement text from the shared pane, always restore after
    this.sendKeys(`stty -echo 2>/dev/null\n`);
    this.echoOff = true;
    await sleep(140);
    this.drain();
    try {
      this.display = opts.visible === true;
      this.sendKeys(`${cmd}\n echo ${m2} $?\n stty echo 2>/dev/null\n`);
      this.echoOff = false;
      // m1 pehle drain ho chuka — ab sirf m2 ka intezar (m1 dobara kabhi
      // echo nahi hota; m1&&m2 check run ko 15-min timeout tak latka deta tha
      // jabki output dikh chuka hota — THE "running..." stuck bug)
      all = await this.waitFor((w) => w.includes(m2), timeoutMs);
      const parsed = splitAtMarker(all, m2);
      const out = cleanB64unused(parsed.out);
      return { out, exit: parsed.exit };
    } finally {
      this.display = false; // stty restore line bhi rahne do visible na ho
      this.drain();
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.sendKeys(`stty echo 2>/dev/null\n`);
        }
      } catch {}
      this.echoOff = false;
      this.display = true; // idle state — user display wapas
    }
  }

  /** push bytes to remote path over TTY (b64 chunk frames, echo-hidden).
   *  Borrowed user tty pe bhi chunks/markers INVISIBLE (display gate). */
  async sendFile(remotePath: string, bytes: Buffer, verifySize = true): Promise<number> {
    const chunks = chunkB64(bytes);
    this.drain();
    this.display = false; // base64 chunks + stty capsules user pane pe nahi
    this.sendKeys(`stty -echo 2>/dev/null\n rm -f ${remotePath}.b64\n`);
    this.echoOff = true;
    await sleep(160);
    this.drain();
    try {
      for (const c of chunks) {
        this.sendKeys(`printf '%s\\n' '${c}' >> ${remotePath}.b64\n`);
        await sleep(70);
        this.drain();
      }
      this.sendKeys(`base64 -d ${remotePath}.b64 > ${remotePath} && wc -c < ${remotePath}\n echo __W_DONE__ $? \n stty echo 2>/dev/null\n`);
      this.echoOff = false;
      const all = await this.waitFor((w) => w.includes("__W_DONE__"), 120_000);
      const parsed = splitAtMarker(all, "__W_DONE__");
      const m = /(\d+)\s*[\r|\n]/.exec(cleanB64unused(parsed.out).trim().split(/\r?\n/).join("\n"));
      const n = m ? Number(m[1]) : -1;
      if (verifySize && n !== bytes.length) {
        throw new Error(`sendFile size mismatch: local ${bytes.length} remote ${n}`);
      }
      return n;
    } finally {
      this.display = false;
      this.drain();
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.sendKeys(`stty echo 2>/dev/null\n`);
        }
      } catch {}
      this.echoOff = false;
      this.display = true;
    }
  }

  close(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
    if (this.echoOff) {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ data: "stty echo 2>/dev/null\n" }));
        }
      } catch {}
      this.echoOff = false;
    }
    try {
      this.ws?.close();
    } catch {}
    this.ws = undefined;
    this.closed = true;
  }
}

function cleanB64unused(s: string): string {
  const noOsc = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const noCsi = noOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return noCsi;
}
