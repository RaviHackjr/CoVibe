// CoVibe — activate(): auth + engine + views + commands + status bar.
import * as vscode from "vscode";
import * as path from "path";
import { makePkce, buildAuthUrl, startLoopback, exchangeCodeAdaptive } from "./libs/oauth";
import { Tokens, buildLangCmd } from "./libs/util";
import {
  assignRuntime,
  listSpecs,
  listRuntimes,
  refreshRuntimeRow,
  releaseRuntime,
  RuntimeRow,
  shortId,
  varySpec,
} from "./libs/colabApi";
import { TokenStore } from "./vscode/tokenStore";
import { Engine } from "./vscode/engine";
import { ColabPtySession } from "./vscode/ptyTerminal";
import { RuntimesProvider } from "./vscode/views/runtimeTree";
import { ColabHomeProvider, HomeState } from "./vscode/homeView";
import type { RuntimeSpecKey } from "./libs/colabApi";

export function activate(context: vscode.ExtensionContext): void {
  const secrets = context.secrets;
  const tokenStore = new TokenStore(secrets);
  const engine = new Engine(context);
  // access token expire hone pe engine khud refresh pull kar sakta hai
  engine.tokenRefresh = async () => {
    const t = await tokenStore.ensure(true);
    engine.setTokens(t);
    return t;
  };
  // connect retries/boot notes panel log me dikhte
  engine.onNote = (m) => home.log(m);
  context.subscriptions.push({ dispose: () => engine.dispose() });

  const runtimes = new RuntimesProvider(engine, { get: () => tokenStore.get() });
  const treeView = vscode.window.createTreeView("colabPipe.runtimes", { treeDataProvider: runtimes });
  context.subscriptions.push(treeView);
  runtimes.refresh();

  async function hasTokens(): Promise<boolean> {
    return Boolean(await tokenStore.get());
  }

  async function homeState(): Promise<HomeState> {
    const authed = await hasTokens();
    const rows = engine.listRuntimeRows();
    const def = engine.getRuntime();
    return {
      authed,
      busy: false,
      hasRuntime: rows.length > 0,
      runtimeShort: def ? shortId(def.name) : undefined,
      runtimeSpec: def ? varySpec(def) : undefined,
      watching: engine.isWatching(),
      runtimes: rows.map((r) => ({
        name: r.name,
        short: shortId(r.name),
        spec: varySpec(r),
        isDefault: def?.name === r.name,
      })),
    };
  }
  const home = new ColabHomeProvider(context.extensionPath, homeState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ColabHomeProvider.viewType, home, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ColabHomeProvider.viewTypeSide, home, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Panel auto-position (Copilot-like): no-text editor active → secondary sidebar
  // (right). Explorer/terminal focus does NOT auto-move it back to the left;
  // clicking the Activity Bar icon returns it to the left and closes the right.
  let lastOnEditor: boolean | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const onEditor = Boolean(ed && ed.viewColumn !== undefined);
      if (!onEditor || onEditor === lastOnEditor) {
        return;
      }
      lastOnEditor = onEditor;
      void vscode.commands.executeCommand("colabPipe.homeSide.focus");
    }),
  );

  async function setStatus(): Promise<void> {
    void vscode.commands.executeCommand(
      "setContext",
      "colabPipe.hasTokens",
      await hasTokens(),
    );
    void vscode.commands.executeCommand(
      "setContext",
      "colabPipe.watching",
      engine.isWatching(),
    );
  }
  void setStatus();

  // status bar button
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998);
  sb.name = "CoVibe";
  sb.command = "colabPipe.menu";
  sb.text = "$(vm-connect) CoVibe";
  sb.tooltip = "CoVibe — click for menu";
  sb.show();
  context.subscriptions.push(sb);

  function withTokens(args: any[], engineCall: (tokens: Tokens, ...rest: any[]) => Promise<unknown>): () => Promise<unknown> {
    return async () => {
      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        return await engineCall(tokens, ...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`CoVibe: ${msg}`);
        throw e;
      }
    };
  }

  const reg = (cmd: string, fn: (tokens: Tokens) => Promise<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, withTokens([], fn as any) as any),
    );

  // ---------------- login / logout
  const login = vscode.commands.registerCommand("colabPipe.login", async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Colab: sign-in with Google..." },
        async () => {
          home.log("🔑 Sign-in started…");
          const nonce = Math.random().toString(36).slice(2);
          const { verifier, challenge } = makePkce();
          // loopback random port (await — port sirf 'listening' ke baad milta hai)
          const { server, port, done } = await startLoopback(nonce);
          // EK hi callback string — auth + token exchange dono me wahi use hoga
          // (Google exact-string match karta hai, warna redirect_uri_mismatch)
          const baseUri = vscode.Uri.parse(`http://127.0.0.1:${port}/`);
          let cbUri = baseUri.toString(true);
          try {
            cbUri = (await vscode.env.asExternalUri(baseUri)).toString(true);
          } catch {}
          const authUrl = buildAuthUrl(cbUri, challenge, nonce);
          void vscode.env.openExternal(vscode.Uri.parse(authUrl));
          home.log("🌐 Browser opened — complete Google sign-in and allow Drive access");
          void vscode.window.showInformationMessage(`Browser opened — complete Google sign-in. If blocked, open this URL: ${authUrl.slice(0, 80)}...`, "Copy URL").then((c) => {
            if (c === "Copy URL") {
              void vscode.env.clipboard.writeText(authUrl);
            }
          });
          const code = await done;
          if (typeof code !== "string" || !code) {
            throw new Error("OAuth callback not received (timeout or cancelled).");
          }
          home.log("✅ callback aaya — token exchange…");
          const tokens = await exchangeCodeAdaptive(code, verifier, cbUri, port, (m) => home.log(m));
          await tokenStore.set(tokens);
          engine.setTokens(tokens);
          server.close();
          home.log(`✅ signed in — scope: ${(tokens.scope || "").split(" ").slice(-2).join("+")}`);
          void vscode.window.showInformationMessage("CoVibe signed in ✅ (Drive + Colaboratory scope)");
        },
      );
      await setStatus();
      runtimes.refresh();
      void home.refresh();
      sb.text = "$(zap) CoVibe";
      engine.armWatcher();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Colab login failed: ${msg}`);
      home.log(`❌ login failed: ${msg}`);
    }
  });
  context.subscriptions.push(login);

  const logout = vscode.commands.registerCommand("colabPipe.logout", async () => {
    await tokenStore.clear();
    engine.disarmWatcher();
    await setStatus();
    runtimes.refresh();
    void home.refresh();
    sb.text = "$(vm-connect) CoVibe";
    void vscode.window.showInformationMessage("Signed out (tokens cleared from OS keychain).");
  });
  context.subscriptions.push(logout);

  // ---------------- runtime lifecycle
  const pickRuntime = vscode.commands.registerCommand("colabPipe.pickRuntime", async () => {
    try {
      const tokens = await tokenStore.ensure();
      engine.setTokens(tokens);
      const specs = (await listSpecs(tokens)).filter((s) => s.eligible);
      const choices = specs.map((s, i) => ({
        label: `${i + 1}. ${(s.key.variant || "").replace("VARIANT_", "")} ${s.key.accelerator === "NONE" ? "" : s.key.accelerator} ${s.key.shape || ""}`.trim(),
        detail: `var=${s.key.variant} accel=${s.key.accelerator} shape=${s.key.shape}`,
        key: s.key,
      }));
      const sel = await vscode.window.showQuickPick(choices, { title: "Assign Colab runtime" });
      if (!sel) {
        return;
      }
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Assigning runtime..." },
        async (p) => {
          const row = await assignRuntime(tokens, sel.key, { onWait: (s) => (p.report({ message: s })) });
          if (!row.runtimeSpec?.key) {
            row.runtimeSpec = { key: sel.key };
          }
          engine.setRuntime(row);
          void engine.warmup(row);
          const readyLine = `✅ Runtime ready — ${shortId(row.name)} (${varySpec(row)})`;
          void vscode.window.showInformationMessage(`Runtime ready: ${shortId(row.name)} (${varySpec(row)})`);
          runtimes.refresh();
          home.log(readyLine);
          void home.refresh();
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`assign: ${msg}`);
    }
  });
  context.subscriptions.push(pickRuntime);

  // quick-assign: CPU/GPU/TPU — real Colab spec fields tolerant matching
  // (accelerator often "NONE"; kind padhe variant shape strings se)
  const kindOf = (k: { variant?: string; accelerator?: string; shape?: string }): "CPU" | "GPU" | "TPU" => {
    const h = `${k.variant || ""} ${k.accelerator || ""} ${k.shape || ""}`.toUpperCase();
    if (/TPU/.test(h)) {
      return "TPU";
    }
    if (/GPU|T4|A100|L4|P100|V5000|V100|H100|B200/.test(h)) {
      return "GPU";
    }
    return "CPU";
  };
  let assignBusy = false;
  const quickAssign = (accel: "CPU" | "GPU" | "TPU") => {
    const cmd = accel === "CPU" ? "colabPipe.assignCpu" : accel === "GPU" ? "colabPipe.assignGpu" : "colabPipe.assignTpu";
    return vscode.commands.registerCommand(cmd, async () => {
      if (assignBusy) {
        home.log("…Assign already running — duplicate request skipped");
        return;
      }
      assignBusy = true;
      home.log(`⏳ Requesting ${accel} runtime…`);
      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        const specs = (await listSpecs(tokens)).filter((s) => s.eligible);
        if (!specs.length) {
          throw new Error("no eligible runtime spec (quota exhausted or restricted)");
        }
        const kinds = specs.map((s) => kindOf(s.key));
        const pick = specs.find((s, i) => kindOf(s.key) === accel);
        if (!pick) {
          const tally = kinds.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
          throw new Error(
            `no ${accel} runtime available for this account — app migration completed available: ${Object.keys(tally).join(", ")}`,
          );
        }
        home.log(`   spec: ${JSON.stringify(pick.key)} (${kindOf(pick.key)})`);
        const row = await assignRuntime(tokens, pick.key as RuntimeSpecKey, {
          onWait: (s) => home.log(`   ${s}`),
        });
        // LRO wait response me runtimeSpec hota kabhi-kabhi missing — inject (label/icon sahi)
        if (!row.runtimeSpec?.key) {
          row.runtimeSpec = { key: pick.key as RuntimeSpecKey };
        }
        engine.setRuntime(row);
        void engine.warmup(row);
        home.log(`✅ Runtime ready — ${shortId(row.name)} (${varySpec(row)})`);
        void vscode.window.showInformationMessage(`Runtime ready: ${shortId(row.name)} (${varySpec(row)})`);
        runtimes.refresh();
        void home.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        home.log(`❌ assign failed: ${msg}`);
        void vscode.window.showErrorMessage(`assign: ${msg}`);
      } finally {
        assignBusy = false;
        home.setBusy(false);
        void home.refresh();
      }
    });
  };
  context.subscriptions.push(quickAssign("CPU"), quickAssign("GPU"), quickAssign("TPU"));

  // ---------------- terminal (pseudo PTY to Colab TTY)
  /** ek runtime = ek terminal lifecycle. Rapid TERM clicks are THROTTLED:
   * 1.5s ke andar repeat → sirf focus (koi log spam/kick storm nahi). */
  const openStamps = new Map<string, number>();
  const openTerminalAt = async (row: RuntimeRow | undefined) => {
    const t0 = Date.now();
    const key = row?.name ?? "pick";
    const throttled = t0 - (openStamps.get(key) ?? 0) < 1500;
    openStamps.set(key, t0);
    home.setBusy(true);
    if (!throttled) {
      home.log("Updating connection state…");
    }
    try {
      const tokens = await tokenStore.ensure();
      engine.setTokens(tokens);
      const chosen = row ?? (await engine.pickRuntime(true));
      if (!chosen) {
        home.log("↻ No assigned runtime — pick a Machine card to assign one");
        return;
      }
      // 1) existing pty terminal for THIS runtime? — reuse single lifecycle
      const held = vscode.window.terminals.find((x) => {
        const p = (x as vscode.Terminal & { __colabPty__?: ColabPtySession }).__colabPty__;
        return p && p.row.name === chosen.name;
      });
      if (held) {
        const pty = (held as vscode.Terminal & { __colabPty__?: ColabPtySession }).__colabPty__!;
        if (!pty.isDisposed) {
          pty.kick();
          held.show(true);
          if (!throttled) {
            home.log(`   existing terminal focused — ${shortId(chosen.name)} (single connection in flight)`);
          }
          return;
        }
        // FAILED/CANCELLED session — dead tab ko close + recycle: fresh session niche banegi
        try {
          held.dispose();
        } catch {}
      }
      // 2) new session — connectionInfo fresh, default runtime untouched
      const fresh = await refreshRuntimeRow(tokens, chosen);
      engine.updateRow(fresh);
      if (!throttled) {
        home.log(`   tty → ${shortId(fresh.name)} (${varySpec(fresh) || "booting"})`);
      }
      const tok = engine.aliveToken(fresh.name);
      const refresh1 = async (): Promise<RuntimeRow> => {
        const t = await tokenStore.ensure();
        engine.setTokens(t);
        const rows = await listRuntimes(t);
        const r = rows.find((x) => x.name === fresh.name);
        if (!r) {
          throw new Error(`runtime ${shortId(fresh.name)} no longer exists (released)`);
        }
        engine.updateRow(r);
        return r;
      };
      const ptySession = new ColabPtySession(
        fresh,
        undefined,
        "interactive",
        (m) => home.log(m),
        refresh1,
        () => engine.isAlive(fresh.name, tok),
        () => engine.purgeRuntimeWS(fresh.name),
      );
      const terminal = vscode.window.createTerminal({
        name: `Colab: ${shortId(fresh.name)}`,
        pty: ptySession,
        isTransient: false,
      });
      (terminal as unknown as { __colabPty__: ColabPtySession }).__colabPty__ = ptySession;
      terminal.show(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      home.log(`❌ terminal: ${msg}`);
      void vscode.window.showErrorMessage(`CoVibe: ${msg}`);
    } finally {
      void home.refresh();
      home.setBusy(false);
    }
  };

  reg("colabPipe.openTerminal", async () => {
    // >1 runtime → runtime quickpick (multi pair support)
    const rows = engine.listRuntimeRows();
    if (rows.length <= 1) {
      await openTerminalAt(rows[0]);
      return;
    }
    const sel = await vscode.window.showQuickPick(
      rows.map((r) => ({
        label: `${engine.getRuntime()?.name === r.name ? "★ " : ""}${shortId(r.name)}`,
        description: varySpec(r),
        name: r.name,
      })),
      { title: "Which runtime's terminal?" },
    );
    if (!sel) {
      return;
    }
    await openTerminalAt(rows.find((r) => r.name === sel.name));
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("colabPipe.connectTerminalAt", async (row: RuntimeRow) => openTerminalAt(row)),
  );

  // panel row ✕ TERM ★ ke args wale commands
  context.subscriptions.push(
    vscode.commands.registerCommand("colabPipe.openTerminalAt", async (name?: string) => {
      if (!name) {
        return;
      }
      let row = engine.listRuntimeRows().find((r) => r.name === name);
      if (!row) {
        // engine state purana — listRuntimes se hydrate kar lo
        try {
          const t = await tokenStore.ensure();
          engine.setTokens(t);
          engine.hydrate(await listRuntimes(t));
          row = engine.listRuntimeRows().find((r) => r.name === name);
        } catch {}
      }
      if (!row) {
        home.log(`❌ runtime not found in state: ${shortId(name)}`);
        return;
      }
      await openTerminalAt(row);
    }),
    vscode.commands.registerCommand("colabPipe.setDefault", async (name?: string) => {
      if (!name) {
        return;
      }
      if (engine.setDefault(name)) {
        home.log(`★ Default runtime → ${shortId(name)} (sync & run now target it)`);
        runtimes.refresh();
        void home.refresh();
      } else {
        home.log(`❌ default set fail — ${shortId(name)} not present in engine state`);
      }
    }),
    vscode.commands.registerCommand("colabPipe.runOn", async () => {
      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        let rows = engine.listRuntimeRows();
        if (!rows.length) {
          engine.hydrate(await listRuntimes(tokens));
          rows = engine.listRuntimeRows();
        }
        if (!rows.length) {
          void vscode.window.showInformationMessage("Assign a runtime first — pick a Machine card.");
          return;
        }
        let target = rows[0];
        if (rows.length > 1) {
          const sel = await vscode.window.showQuickPick(
            rows.map((r) => ({
              label: `${engine.getRuntime()?.name === r.name ? "★ " : ""}${varySpec(r)}`,
              description: shortId(r.name),
              name: r.name,
            })),
            { title: "Run active file on which runtime?" },
          );
          if (!sel) {
            return;
          }
          target = rows.find((r) => r.name === sel.name) ?? target;
        }
        const doc = vscode.window.activeTextEditor?.document;
        home.log(`▶ Run on ${shortId(target.name)} — ${doc ? doc.fileName.split("/").pop() : "(no file open?)"}`);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Colab: run on ${shortId(target.name)}...` },
          async () => engine.runActive(doc, target),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        home.log(`❌ runOn: ${msg.slice(0, 160)}`);
        void vscode.window.showErrorMessage(`run: ${msg.slice(0, 160)}`);
      }
    }),
    vscode.commands.registerCommand("colabPipe.releaseRuntime", async (selArg?: string, ...rest: unknown[]) => {
      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        const argName = typeof selArg === "string" ? selArg : undefined;
        let targetName = argName;
        if (!targetName) {
          const rows = await listRuntimes(tokens);
          if (!rows.length) {
            void vscode.window.showInformationMessage("No assigned runtime.");
            return;
          }
          const pick = await vscode.window.showQuickPick(
            rows.map((r) => ({ label: shortId(r.name), description: varySpec(r), name: r.name })),
            { title: "Release (DELETE) which runtime?" },
          );
          if (!pick) {
            return;
          }
          targetName = pick.name;
        }
        const ok = await vscode.window.showWarningMessage(
          `Releasing ${shortId(targetName)} — its quota frees up. Terminals for it close too. Confirm?`,
          "Release",
        );
        if (ok !== "Release") {
          return;
        }
        // cancel FIRST (slow API call se pehle): scope bump + pty/exec close turant
        engine.clearRuntime(targetName);
        try {
          await releaseRuntime(tokens, targetName);
        } catch (e) {
          // release FAILED honestly show + reconcile with authoritative list
          const msg = e instanceof Error ? e.message : String(e);
          void vscode.window.showErrorMessage(`release failed: ${msg}`);
          home.log(`⚠ release request failed — reconciling runtime list: ${msg}`);
        }
        try {
          engine.hydrate(await listRuntimes(tokens));
        } catch {}
        runtimes.refresh();
        home.log(`🗑 released ${shortId(targetName)}`);
        void home.refresh();
        void vscode.window.showInformationMessage("Released.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`release: ${msg}`);
      }
    }),
  );

  // panel "refresh state" — listRuntimes se engine rows hydrate karta hai
  context.subscriptions.push(
    vscode.commands.registerCommand("colabPipe.refreshRt", async () => {      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        const rows = await listRuntimes(tokens);
        if (!rows.length) {
          home.log("↻ No assigned runtime — pick a Machine card to assign one");
          void home.refresh();
          return;
        }
        engine.hydrate(rows);
        // default runtime refresh khatam hone tak TOUCH nahi hota (hydrate sirf empty
        // state me default set karta hai) — user ki ★ choice ham me far iz na
        home.log(`↻ ${rows.length} runtime${rows.length > 1 ? "s" : ""} found — default: ${shortId((engine.getRuntime() ?? rows[0]).name)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        home.log(`↻ refresh failed: ${msg.slice(0, 140)}`);
      }
      void home.refresh();
    }),
    // palette: my runtimes listing (was referenced in manifest without a handler)
    vscode.commands.registerCommand("colabPipe.listRuntimes", async () => {
      try {
        const tokens = await tokenStore.ensure();
        engine.setTokens(tokens);
        const rows = await listRuntimes(tokens);
        engine.hydrate(rows);
        if (!rows.length) {
          void vscode.window.showInformationMessage("No assigned runtime.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          rows.map((r) => ({ label: shortId(r.name), description: varySpec(r), name: r.name })),
          { title: "My runtimes (★ default)" },
        );
        if (pick?.name) {
          engine.setDefault(pick.name);
          home.log(`★ default runtime → ${shortId(pick.name)}`);
          runtimes.refresh();
          void home.refresh();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`listRuntimes: ${msg}`);
      }
    }),
  );

  // ---------------- sync + watch
  reg("colabPipe.syncAll", async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Colab: full sync..." },
      async (p) => {
        p.report({ message: "push to runtime + pull outputs" });
        engine.setTokens(await tokenStore.ensure());
        const res = await engine.runtimeSync();
        void vscode.window.showInformationMessage(`sync: ${res.pulled} · push ${res.uploaded.length}, del ${res.deleted.length}`);
        home.log(`⇄ full sync done — pulled ${res.pulled}, pushed ${res.uploaded.length}, deleted ${res.deleted.length}`);
        sb.text = "$(zap) CoVibe";
      },
    );
  });

  const watch = vscode.commands.registerCommand("colabPipe.watchFiles", async () => {
    try {
      await tokenStore.ensure();
      engine.armWatcher();
      await setStatus();
      void home.refresh();
      home.log("🛰 watcher ON — save = instant runtime push + outputs pull");
      void vscode.window.showInformationMessage("watcher ON — save = instant runtime push + outputs pull.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`watch: ${msg}`);
    }
  });
  context.subscriptions.push(watch);

  // ---------------- run helpers
  const runActive = vscode.commands.registerCommand("colabPipe.runActive", async () => {
    try {
      engine.setTokens(await tokenStore.ensure());
      const doc = vscode.window.activeTextEditor?.document;
      home.log(`▶ run active file${doc ? ` — ${doc.fileName.split("/").pop()}` : ""}…`);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Colab: running..." },
        async () => engine.runActive(doc),
      );
      home.log("✅ run complete — result Colab terminal me dekho");
      sb.text = "$(zap) CoVibe";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      home.log(`❌ run failed: ${msg.slice(0, 180)}`);
      void vscode.window.showErrorMessage(`run: ${msg.slice(0, 180)}`);
    }
  });
  context.subscriptions.push(runActive);

  const runCmd = vscode.commands.registerCommand("colabPipe.runCmd", async () => {
    try {
      engine.setTokens(await tokenStore.ensure());
      // ACTIVE FILE ho to command PREFILL (extension ke hisaab se) — user edit
      // kar ke (params/flags) Enter dabata hai; bina edit Enter = direct run.
      const doc = vscode.window.activeTextEditor?.document;
      let prefill = "python main.py";
      let title = "Run on Colab — command";
      let editHint = "";
      if (doc) {
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        const root = folder ? folder.uri.fsPath : undefined;
        const rel = root ? path.relative(root, doc.uri.fsPath).split(path.sep).join("/") : "";
        if (rel && !rel.startsWith("..") && !rel.startsWith(".")) {
          prefill = buildLangCmd(rel) ?? `bash "${rel}"`;
          editHint = `${rel} · edit the command for args (e.g. python3 -m pkg.main), Enter to run`;
          title = `Run ${rel} on Colab`;
        }
      }
      const statement = await vscode.window.showInputBox({
        title,
        value: prefill,
        prompt: editHint || "Enter to run as-is · edit the command for flags/params, then Enter",
        placeHolder: "python3 -u main.py  |  make  |  ls -la",
      });
      if (!statement) {
        return;
      }
      await engine.runCommand(statement);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`run: ${msg.slice(0, 180)}`);
    }
  });
  context.subscriptions.push(runCmd);

  // ---------------- toolchains + menu + cleanup
  const toolchain = vscode.commands.registerCommand("colabPipe.installToolchain", async () => {
    try {
      engine.setTokens(await tokenStore.ensure());
      const lang = await vscode.window.showQuickPick(["all", "node", "rust", "go", "c", "java"], { title: "Install toolchain on runtime" });
      if (!lang) {
        return;
      }
      const APT = "sudo apt-get -qq update -y";
      const cmds: Record<string, string> = {
        all: `${APT} && sudo apt-get -y install gcc g++ default-jdk nodejs npm && curl -fsSL https://sh.rustup.rs | sh -s -- -y -q && export PATH=$PATH:$HOME/.cargo:/usr/local/go/bin`,
        node: `${APT} && sudo apt-get -y install nodejs npm && node -v`,
        rust: "curl -fsSL https://sh.rustup.rs | sh -s -- -y -q && export PATH=$PATH:$HOME/.cargo && rustc --version",
        go: "wget -qO /tmp/go.tgz https://go.dev/dl/go1.22.4.linux-amd64.tar.gz && sudo tar -C /usr/local -xzf /tmp/go.tgz && /usr/local/go/bin/go version",
        c: `${APT} && sudo apt-get -y install gcc g++ && gcc --version | head -1`,
        java: `${APT} && sudo apt-get -y install default-jdk && javac -version`,
      };
      home.log(`🧰 Installing toolchain: ${lang}…`);
      await engine.runCommand(cmds[lang] ?? cmds.c, `toolchain ${lang}`);
      home.log(`✅ Toolchain ${lang} queued — follow progress in the Colab terminal`);
      void vscode.window.showInformationMessage(`Toolchain job queued: ${lang}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      home.log(`❌ toolchain: ${msg}`);
      void vscode.window.showErrorMessage(`toolchain: ${msg}`);
    }
  });
  context.subscriptions.push(toolchain);

  const clean = vscode.commands.registerCommand("colabPipe.cleanRuntime", async () => {
    try {
      engine.setTokens(await tokenStore.ensure());
      const ok = await vscode.window.showWarningMessage("Delete /content/ws on runtime? (Drive untouched)", "Clean");
      if (ok !== "Clean") {
        return;
      }
      await engine.runCommand("rm -rf /content/ws && mkdir -p /content/ws && echo CLEANED", "clean");
    } catch (e) {
      /* ignore */
    }
  });
  context.subscriptions.push(clean);

  const menu = vscode.commands.registerCommand("colabPipe.menu", async () => {
    const authed = await hasTokens();
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Open Colab terminal", cmd: "colabPipe.openTerminal" },
        { label: "Run active file", cmd: "colabPipe.runActive" },
        { label: "Run command…", cmd: "colabPipe.runCmd" },
        { label: "Full sync (⇄ runtime)", cmd: "colabPipe.syncAll" },
        { label: "Assign runtime (CPU/GPU/TPU)", cmd: "colabPipe.pickRuntime" },
        { label: "Release runtime…", cmd: "colabPipe.releaseRuntime" },
        { label: "Install toolchain…", cmd: "colabPipe.installToolchain" },
        authed ? { label: "Sign out", cmd: "colabPipe.logout" } : { label: "Sign in with Google", cmd: "colabPipe.login" },
      ],
      { title: "CoVibe" },
    );
    if (choice) {
      void vscode.commands.executeCommand(choice.cmd);
    }
  });
  context.subscriptions.push(menu);

  // auto: if tokens exist at startup, hydrate engine quietly
  void (async () => {
    const t = await tokenStore.get();
    if (t) {
      engine.setTokens(t as Tokens);
      try {
        engine.hydrate(await listRuntimes(t as Tokens));
      } catch {}
      engine.armWatcher();
      sb.text = "$(zap) CoVibe";
      runtimes.refresh();
    }
    void home.refresh();
  })();
}

export function deactivate(): void {
  // nothing (engine disposed via subscriptions)
}
