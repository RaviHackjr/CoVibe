// CoVibe Home panel — refined webview UI: sign-in flow → machine picker → actions + log.
// Protocol: handshake ("webviewReady"), poll ("__poll__"), dense state pushes.
import * as vscode from "vscode";
import * as path from "path";

export interface HomeState {
  authed: boolean;
  busy: boolean;
  hasRuntime: boolean;
  runtimeShort?: string;
  runtimeSpec?: string;
  watching: boolean;
  runtimes: Array<{ name: string; short: string; spec: string; isDefault: boolean }>;
}

type Snap = () => Promise<HomeState>;

export class ColabHomeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "colabPipe.home";
  public static readonly viewTypeSide = "colabPipe.homeSide";
  private views: vscode.WebviewView[] = [];
  private logs: string[] = [];
  private busy = false;

  constructor(private readonly extPath: string, private readonly snapshot: Snap) {}

  /** Activity Bar icon click (primary view becomes visible) → close secondary sidebar so the panel settles LEFT. */
  private closeSecondarySide(): void {
    void (async () => {
      const candidates = [
        "workbench.action.closeAuxiliaryBar",
        "workbench.action.secondarySideBar.hide",
        "workbench.action.closeSecondarySideBar",
      ];
      for (const c of candidates) {
        try {
          await vscode.commands.executeCommand(c);
          return;
        } catch {
          /* unknown command on this VS Code version */
        }
      }
    })();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.push(view);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.extPath, "resources"))],
    };
    view.webview.html = this.html(view);
    view.webview.onDidReceiveMessage((m) => {
      if (!m || typeof m.cmd !== "string") {
        return;
      }
      if (m.cmd === "webviewReady" || m.cmd === "__poll__") {
        void this.refresh();
        return;
      }
      void vscode.commands.executeCommand(m.cmd, ...(m.args || []));
    });
    // primary home view visible hai (icon click) → right side band, panel LEFT
    view.onDidChangeVisibility(() => {
      if (view.visible && view.viewType === ColabHomeProvider.viewType) {
        this.closeSecondarySide();
      }
    });
  }

  log(msg: string): void {
    const t = new Date();
    const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    const line = `[${hh}] ${msg}`;
    // poll-generated identical lines bachaate hain ("No assigned runtime" ×N spam)
    const last = this.logs[this.logs.length - 1];
    if (last?.replace(/^\[[\d:]+\]\s*/, "") === msg) {
      return;
    }
    this.logs.push(line);
    if (this.logs.length > 60) {
      this.logs = this.logs.slice(-60);
    }
    void this.refresh();
  }

  setBusy(b: boolean): void {
    this.busy = b;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.views.length) {
      return;
    }
    try {
      const st = await this.snapshot();
      st.busy = this.busy;
      const alive: vscode.WebviewView[] = [];
      for (const v of this.views) {
        try {
          await v.webview.postMessage({ type: "state", state: st, logs: this.logs });
          alive.push(v);
        } catch {
          /* disposed view */
        }
      }
      this.views = alive;
    } catch {
      /* snapshot may throw */
    }
  }

  private html(view?: vscode.WebviewView): string {
    const v = view ?? this.views[0];
    if (!v) {
      throw new Error("no webview");
    }
    const logo = v.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extPath, "resources", "icon.png")),
    );
    const csp = `default-src 'none'; img-src ${v.webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
/* ── scale ───────────────────────────────── */
:root{
  --bg:var(--vscode-sideBar-background);
  --fg:var(--vscode-foreground);
  --line:rgba(128,128,128,.18);
  --card:rgba(128,128,128,.06);
  --card-h:rgba(128,128,128,.11);
  --accent:#2ea043; --accent2:#3fb950; --blue:#58a6ff; --warn:#d29922; --err:#f85149;
  --r:8px; --r-sm:6px;
  --gap:10px; --pad:14px;
  --btn-h:30px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family);font-size:12.5px;line-height:1.45;
  -webkit-font-smoothing:antialiased}
.hidden{display:none!important}
button{font-family:inherit}

/* ── header ──────────────────────────────── */
.head{display:flex;align-items:center;gap:10px;padding:13px 14px 11px;border-bottom:1px solid var(--line)}
.head img{width:36px;height:36px;border-radius:9px;flex:none}
.head .t{font-size:13.5px;font-weight:650;letter-spacing:.01em;margin:0;line-height:1.25}
.head .s{font-size:10.5px;opacity:.6;margin-top:1px}
.brand{position:absolute;top:15px;right:14px;font-size:10px;opacity:.5}
.brand b{color:var(--accent2);font-weight:600}

.wrap{padding:0 14px 14px}

/* ── section titles ──────────────────────── */
.sect{display:flex;align-items:center;gap:8px;margin:15px 0 8px}
.sect span{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;opacity:.55;white-space:nowrap}
.sect i{flex:1;height:1px;background:var(--line)}

/* ── pills ───────────────────────────────── */
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:600;border:1px solid var(--line)}
.pill i{width:6px;height:6px;border-radius:50%;display:inline-block}
.pill.ok{color:var(--accent2);border-color:rgba(63,185,80,.45);background:rgba(46,160,67,.12)} .pill.ok i{background:var(--accent2)}
.pill.off{color:var(--warn);border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.1)} .pill.off i{background:var(--warn)}

/* ── buttons ─────────────────────────────── */
.btn{display:flex;align-items:center;gap:8px;width:100%;height:var(--btn-h);padding:0 10px;border:none;
  border-radius:var(--r-sm);font-size:12px;cursor:pointer;text-align:left;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn:hover{filter:brightness(1.15)}
.btn:active{transform:translateY(1px)}
.btn .ic{font-size:13px;width:16px;text-align:center;flex:none;opacity:.95}
.btn .lb{flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn .kb{font-size:9px;opacity:.55;letter-spacing:.03em}
.btn.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn.sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--fg);width:auto;height:22px;padding:0 9px;font-size:10.5px;align-self:center}
.btn.ghost:hover{background:var(--card-h)}
.btn.dang{background:rgba(248,81,73,.10);color:var(--err);border:1px solid rgba(248,81,73,.35)}
.btn.dang:hover{background:rgba(248,81,73,.18)}
.btn:ddisabled,.btn.dis{opacity:.5;pointer-events:none}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.grid2 .btn{margin:0}

/* ── sign-in view ───────────────────────── */
.si{padding:30px 18px 20px;text-align:center}
.si .gl{font-size:36px;line-height:1}
.si h2{font-size:14px;margin:14px 0 6px;font-weight:650}
.si p{opacity:.62;font-size:11.5px;margin:0 0 4px;line-height:1.55}
.si code{font-size:10px;opacity:.85}
.si .btn{margin:18px auto 0;width:auto;display:inline-flex;height:32px;padding:0 18px;font-size:12.5px;border-radius:var(--r)}

/* ── machine cards ──────────────────────── */
.mcards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mcard{position:relative;padding:12px 6px 10px 6px;border:1px solid var(--line);border-radius:var(--r);cursor:pointer;
  text-align:center;background:var(--card);transition:background .12s,border-color .12s,transform .12s}
.mcard:hover{background:var(--card-h);border-color:rgba(63,185,80,.55)}
.mcard:active{transform:scale(.985)}
.mcard .ic{font-size:18px;line-height:1.1;display:block}
.mcard .nm{font-size:12px;font-weight:650;margin-top:5px}
.mcard .ds{font-size:9.5px;opacity:.55;margin-top:2px}
.mcard.sel{border-color:var(--accent);background:rgba(46,160,67,.14);box-shadow:inset 0 0 0 1px var(--accent)}
.mcard.dis,.mcard:disabled{opacity:.45;pointer-events:none}
.mcard .dot{position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--accent2);box-shadow:0 0 6px var(--accent2);animation:pulse 1.7s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── active runtime ─────────────────────── */
.rrow{display:flex;align-items:center;gap:6px;margin-top:6px;padding:7px 9px;border:1px solid var(--line);border-radius:var(--r);background:var(--card)}
.rrow.def{border-color:rgba(63,185,80,.45);background:rgba(46,160,67,.08)}
.rrow .k{flex:none;font-size:13px}
.rrow .m{font-family:var(--vscode-editor-font-family);font-size:10.5px;color:var(--fg);min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.95}
.rrow .sp{flex:none;font-size:9px;opacity:.55;text-transform:uppercase;letter-spacing:.04em}
.rrow.def .sp{color:var(--accent2);opacity:.9}
.rrow button{flex:none;width:22px;height:20px;padding:0;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--fg);opacity:.75;cursor:pointer;font-size:10px;font-family:inherit;line-height:1}
.rrow button:hover{opacity:1;background:var(--card-h)}
.rrow button.star{color:var(--warn)}
.rrow button.x:hover{color:var(--err);border-color:rgba(248,81,73,.4)}
.rrow button.tb:hover{color:var(--blue);border-color:rgba(88,166,255,.4)}
.rrow.haze{opacity:.5;pointer-events:none}
.empty{margin-top:8px;padding:9px 10px;border:1px dashed var(--line);border-radius:var(--r);font-size:10.5px;opacity:.6;text-align:center}

/* ── busy bar ───────────────────────────── */
.busy{display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 10px;border:1px solid rgba(63,185,80,.3);
  border-radius:var(--r);background:rgba(46,160,67,.05);font-size:11px;color:var(--accent2)}
.spinner{width:11px;height:11px;border:2px solid rgba(63,185,80,.25);border-top-color:var(--accent2);border-radius:50%;
  animation:spin .7s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── log ────────────────────────────────── */
.log{margin-top:2px;background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:var(--r);
  padding:7px 9px;font-family:var(--vscode-editor-font-family);font-size:10px;line-height:1.65;
  height:132px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.log .l{padding:.5px 0}
.log::-webkit-scrollbar{width:7px}
.log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:4px}

.foot{margin-top:12px;padding-top:9px;border-top:1px solid var(--line);font-size:9.5px;opacity:.4;text-align:center}
</style></head>
<body>
 <div class="head"><img src="${logo}">
   <div><div class="t">CoVibe</div><div class="s">Local VS Code ▸ cloud machines</div></div>
 </div>
 <div class="brand">by <b>Blakite Ravi</b> · v${vscode.extensions.getExtension("blakite-ravi.covibe")?.packageJSON?.version ?? "dev"}</div>
 <div class="wrap">

  <!-- SIGN-IN -->
  <div id="v-out" class="hidden si">
    <div class="gl">🔐</div>
    <h2>Sign in to get started</h2>
    <p>Sign in with your Google account to create and drive the CoVibe runtimes.</p>
    <p>Tokens are stored only in your OS keychain — never plain text.</p>
    <button class="btn" data-cmd="colabPipe.login"><span class="ic">🔑</span><span class="lb">Sign in with Google</span></button>
  </div>

  <!-- MAIN -->
  <div id="v-in" class="hidden">
    <div class="sect" style="margin-top:14px"><span>Account</span><i></i>
      <button class="btn ghost" data-cmd="colabPipe.logout">Logout</button></div>
    <div><span class="pill ok" id="acc-pill"><i></i>Signed in — ready</span></div>

    <div class="sect"><span>Machine</span><i></i></div>
    <div class="mcards" id="mcards">
      <div class="mcard" id="m-cpu" data-cmd="colabPipe.assignCpu"><span class="ic">🧠</span><div class="nm">CPU</div><div class="ds">2 vCPU · 12 GB</div></div>
      <div class="mcard" id="m-gpu" data-cmd="colabPipe.assignGpu"><span class="ic">🎮</span><div class="nm">GPU</div><div class="ds">T4 · 16 GB VRAM</div></div>
      <div class="mcard" id="m-tpu" data-cmd="colabPipe.assignTpu"><span class="ic">⚡</span><div class="nm">TPU</div><div class="ds">v5e · slices</div></div>
    </div>

    <div id="busy" class="busy hidden"><span class="spinner"></span><span id="busytext">Working — talking to Colab…</span></div>
    <div id="rt-list"></div>
    <div id="rt-empty" class="empty hidden">No runtime yet — assign one with a card above</div>

    <div class="grid2" style="margin-top:8px">
      <button class="btn sec" data-cmd="colabPipe.pickRuntime"><span class="ic">☰</span><span class="lb">Full specs</span></button>
      <button class="btn sec" data-cmd="colabPipe.refreshRt"><span class="ic">↻</span><span class="lb">Refresh state</span></button>
    </div>
    <div class="hint" style="margin-top:5px;font-size:9.5px;opacity:.5;text-align:center">★ = default (sync & run target) · TERM = that VM's terminal · ✕ = release</div>

    <div class="sect"><span>Actions</span><i></i></div>
    <div class="grid2">
      <button class="btn" data-cmd="colabPipe.openTerminal" title="Open runtime terminal (Ctrl+Alt+T)"><span class="ic">🖥</span><span class="lb">Terminal</span></button>
      <button class="btn" data-cmd="colabPipe.runActive" title="Run the active file (Ctrl+Alt+R) — realtime output in the runtime terminal"><span class="ic">▶</span><span class="lb">Run file</span></button>
      <button class="btn sec" data-cmd="colabPipe.runCmd" title="Run with command/args — pre-filled from the active file, edit then Enter (Ctrl+Shift+Alt+R)"><span class="ic">⌨</span><span class="lb">Run with args…</span></button>
      <button class="btn sec" data-cmd="colabPipe.syncAll" title="Full sync — push workspace + pull outputs (Ctrl+Alt+Y)"><span class="ic">⇄</span><span class="lb">Full sync</span></button>
      <button class="btn sec" data-cmd="colabPipe.watchFiles" id="b-watch" title="Toggle watcher — save = instant runtime push (Shift auto toggle)"><span class="ic">🛰</span><span class="lb">Watcher: OFF</span></button>
      <button class="btn sec" data-cmd="colabPipe.installToolchain" title="Install a toolchain (gcc/java/node/go/rust) on the runtime"><span class="ic">🧰</span><span class="lb">Toolchain</span></button>
    </div>
    <button class="btn dang" style="margin-top:7px" data-cmd="colabPipe.cleanRuntime"><span class="ic">🧹</span><span class="lb">Clean remote /content/ws</span></button>

    <div class="sect"><span>Activity</span><i></i></div>
    <div class="log" id="log"></div>
  </div>

  <div class="foot">diff-based Drive sync · zero-upload runner · private</div>
 </div>

<script>
(function(){
  const vs = acquireVsCodeApi();   // exactly once
  const $ = (id) => document.getElementById(id);
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;");

  document.addEventListener("click", (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest("[data-cmd]") : null;
    if (!el || el.classList.contains("dis")) return;
    // optimistic disable — double-click = double runtime assignment classic bug
    if (el.id && el.id.startsWith("m-")) {
      document.querySelectorAll(".mcard").forEach((c) => c.classList.add("dis"));
    }
    const arg = el.getAttribute("data-arg");
    vs.postMessage({ cmd: el.getAttribute("data-cmd"), args: arg ? [arg] : [] });
  });

  function render(st, logs){
    $("v-out").classList.toggle("hidden", st.authed);
    $("v-in").classList.toggle("hidden", !st.authed);
    if(!st.authed) return;

    // machine cards
    ["m-cpu","m-gpu","m-tpu"].forEach((id)=>{
      const c = $(id);
      c.classList.toggle("dis", st.busy);
    });
    document.querySelectorAll(".mcard .dot").forEach(d=>d.remove());
    $("busy").classList.toggle("hidden", !st.busy);
    $("busytext").textContent = st.busy ? "Working — talking to Colab…" : "";

    // runtime rows (multi — pair support)
    const list = $("rt-list");
    list.innerHTML = "";
    const rows = Array.isArray(st.runtimes) ? st.runtimes : (st.hasRuntime && st.runtimeShort ? [{name:"",short:st.runtimeShort,spec:st.runtimeSpec||"",isDefault:true}] : []);
    if(rows.length){
      $("rt-empty").classList.add("hidden");
      for(const r of rows){
        const spec = (r.spec||"").toUpperCase();
        const kico = spec.includes("TPU") ? "⚡" : spec.includes("GPU") ? "🎮" : "🧠";
        const div = document.createElement("div");
        div.className = "rrow" + (r.isDefault ? " def" : "");
        div.innerHTML =
          '<span class="k">'+kico+'</span>' +
          '<span class="m">'+esc(r.short||"")+'</span>' +
          '<span class="sp">'+esc(r.spec||"")+'</span>' +
          (r.isDefault
            ? '<button class="star dis" title="default runtime">★</button>'
             : '<button class="star" title="Make default (sync & run target this VM)" data-cmd="colabPipe.setDefault" data-arg="'+esc(r.name)+'">☆</button>') +
          '<button class="tb" title="Terminal on this VM" data-cmd="colabPipe.openTerminalAt" data-arg="'+esc(r.name)+'">TERM</button>' +
          '<button class="x" title="Release (quota free)" data-cmd="colabPipe.releaseRuntime" data-arg="'+esc(r.name)+'">✕</button>';
        if(st.busy){ div.classList.add("haze"); }
        list.appendChild(div);
      }
      // default row ke kind pe card selection ring
      const d = rows.find(x=>x.isDefault);
      if(d){
        const spec=(d.spec||"").toUpperCase();
        const kind = spec.includes("TPU") ? "m-tpu" : spec.includes("GPU") ? "m-gpu" : "m-cpu";
        $(kind).classList.add("sel");
        const dot = document.createElement("span"); dot.className="dot"; $(kind).appendChild(dot);
      }
    } else {
      $("rt-empty").classList.remove("hidden");
    }

    // watcher chip
    $("b-watch").querySelector(".lb").textContent = "Watcher: " + (st.watching ? "ON" : "OFF");

    // log
    if(logs && logs.length){
      const lg = $("log");
      lg.innerHTML = logs.map(l=>'<div class="l">'+esc(l)+'</div>').join("");
      lg.scrollTop = lg.scrollHeight;
    }
  }

  window.addEventListener("message", (e)=>{
    const d = e.data;
    if(d && d.type==="state") render(d.state, d.logs);
  });

  vs.postMessage({ cmd:"webviewReady" });
  setInterval(()=>vs.postMessage({ cmd:"__poll__" }), 5000);
})();
</script>
</body></html>`;
  }
}
