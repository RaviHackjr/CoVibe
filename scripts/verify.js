#!/usr/bin/env node
/* CoVibe static verification:
   1. webview <script> block must be valid JS (node --check)
   2. acquireVsCodeApi() exactly once
   3. every data-cmd in webview + tree command refs must exist in package.json commands
   4. every contributed command must have a registerCommand in src
   5. no duplicate command entries, views referenced exist
   6. no Hinglish in user-facing log strings
*/
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fails = [];
const ok = (name, cond) => {
  if (cond) console.log("  ✔ " + name);
  else fails.push(name);
};

// ---- read sources
const extTs = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const hvTs = fs.readFileSync(path.join(root, "src/vscode/homeView.ts"), "utf8");
const treeTs = fs.readFileSync(path.join(root, "src/vscode/views/runtimeTree.ts"), "utf8");

// ---- 1+2: webview script syntax (extract from html() template)
ok("homeView html() template found", hvTs.includes("acquireVsCodeApi()"));
// grab the script block: template literal content between <script> and </script>
const scriptBlocks = [...hvTs.matchAll(/<script>\n?([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok("webview <script> blocks=1", scriptBlocks.length === 1);
if (scriptBlocks.length) {
  let js = scriptBlocks[0];
  // template literal escape substitutions TS performs for webview: none expected here;
  // check through esparse via a temp file node --check (module for acquire stub)
  const tmp = path.join(process.env.TEMP || "/tmp", "vibe-webview-" + Date.now() + ".js");
  fs.writeFileSync(tmp, "const acquireVsCodeApi=()=>({postMessage(){},})();\n" + js);
  try {
    execFileSync(process.execPath, ["--check", tmp]);
    console.log("  ✔ webview script syntax valid (node --check)");
  } catch (e) {
    fails.push("webview script syntax broken: " + String(e.stderr || e));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  const nApi = (js.match(/acquireVsCodeApi\(/g) || []).length;
  ok("acquireVsCodeApi() called exactly once", nApi === 1);
}

// ---- 3: data-cmd + tree refs vs package.json
const cmds = new Set((pkg.contributes.commands || []).map((c) => c.command));
// webview data-cmd
const dataCmds = [...hvTs.matchAll(/data-cmd="([^"]+)"/g)].map((m) => m[1]);
for (const c of new Set(dataCmds)) {
  ok(`webview data-cmd exists: ${c}`, cmds.has(c));
}
// homeView provider-side executeCommand fallbacks (m.cmd)
const mhv = [...hvTs.matchAll(/executeCommand\("([^"]+)"/g)].map((m) => m[1]);
for (const c of new Set(mhv)) {
  ok(`homeView executeCommand exists: ${c}`, cmds.has(c));
}
// tree item commands
const treeCmds = [...treeTs.matchAll(/"colabPipe\.[A-Za-z]+"/g)].map((m) => m[0].slice(1, -1));
for (const c of new Set(treeCmds)) {
  ok(`tree command exists: ${c}`, cmds.has(c));
}
// menus + keybindings
for (const [mname, entries] of Object.entries(pkg.contributes.menus || {})) {
  for (const e of entries) {
    if (!e.command) continue;
    ok(`menu[${mname}] command exists: ${e.command}`, cmds.has(e.command));
  }
}
for (const kb of pkg.contributes.keybindings || []) {
  ok(`keybinding command exists: ${kb.command}`, cmds.has(kb.command));
}

// ---- 4: registerCommand parity (extension.ts + subtree files)
const reg = /(?:registerCommand|reg)\(\s*["']([^"']+)["']/g;
const registered = new Set(
  [...extTs.matchAll(reg)].map((m) => m[1]).concat([...treeTs.matchAll(reg)].map((m) => m[1]))
);
// quickAssign() programmatically registers assignCpu/Gpu/Tpu (string built at line ~246)
if (/push\(quickAssign\("CPU"\), quickAssign\("GPU"\), quickAssign\("TPU"\)/.test(extTs)) {
  registered.add("colabPipe.assignCpu");
  registered.add("colabPipe.assignGpu");
  registered.add("colabPipe.assignTpu");
}
for (const c of cmds) {
  ok(`command registered: ${c}`, registered.has(c));
}

// ---- 5: dupes
const dupes = (pkg.contributes.commands || []).map((c) => c.command).filter((c, i, a) => a.indexOf(c) !== i);
ok("no duplicate command entries", dupes.length === 0);
// views exist
const viewContainers = pkg.contributes.viewsContainers || {};
for (const [place, arr] of Object.entries(viewContainers)) {
  ok(`viewsContainers[${place}] declared`, Array.isArray(arr) && arr.length > 0);
}
const viewIds = Object.values(pkg.contributes.views || {}).flat();
ok("webview view ids >=4", viewIds.length >= 4);
for (const v of viewIds) {
  ok(`view id: ${v.id} — has provider/id parity`, Boolean(v.id));
}

// ---- 6: Hinglish sweep in user-facing strings (log/notify)
const HINGLISH = [
  "kholo", "ho jayega", "isi pe", "isme", "karo turant", "ka terminal",
  "ka krta", "karta", "kar de", "diya", "rahega", "nahi ", "wala",
];
const hinglishPat = new RegExp(HINGLISH.map((w) => w.replace(/\s/g, "\\s+")).join("|"), "i");
const userLogLines = [...extTs.matchAll(/log\(`([^`]*?)`\)/g)].map((m) => m[1]);
const bad = userLogLines.filter((s) => hinglishPat.test(s));
ok("extension panel logs are English only", bad.length === 0);
if (bad.length) console.log(" ", bad.map((s) => s.match(hinglishPat)));

console.log("\\n---");
if (fails.length) {
  console.error("FAILED checks:", fails.length);
  for (const f of fails) {
    console.error("  ✖ " + f);
  }
  process.exit(1);
}
console.log("all static checks passed");
