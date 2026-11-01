<div align="center">

# CoVibe

**Run anything, anywhere. From your editor.**

CoVibe pairs VS Code with remote CPU · GPU · TPU machines — files sync as you type,
runs stream back in real time, and a real terminal is one keystroke away.

<table><tr><td>v0.15</td><td>works on Windows · macOS · Linux</td><td>MIT licensed</td></tr></table>

</div>

---

## ✨ What it does

| | Feature | Why you'll like it |
|---|---|---|
| ▶ | **One-key run** | The active file runs in its native toolchain — Python, JS, shell, Go, C, C++, Rust, Java are detected automatically |
| ⚡ | **Real-time output** | Unbuffered streaming — output appears as your program prints it, never after exit |
| ⊙ | **Run with args** | A pre-filled, editable command box (`python3 -u test.py`) — add flags, then Enter |
| ⇄ | **Instant sync** | Saves fly to the remote machine in milliseconds-sized deltas; outputs come back automatically |
| 🖥 | **Real terminal** | Full PTY: `htop`, `nano`, colors, Ctrl-C — survives network drops with history intact |
| 🤖 | **Toolchain one-click** | gcc / g++ / node / go / rust / java — idempotent, never installs twice |
| 🧩 | **Machine pairs** | CPU + GPU + TPU attached together; a ★ default machine runs everything unless you say otherwise |

Machines come from **Google Colab** — CPU (2 vCPU · 12 GB), GPU (T4 · 16 GB VRAM) and TPU (v5e) are supported out of the box, and yes, the free tier works.

---

## 🚀 Getting started

```text
1. Install:     code --install-extension covibe-x.y.z.vsix
2. Reload:      Ctrl+Shift+P → "Developer: Reload Window"
3. Sign in:     click the CoVibe icon → "Sign in with Google"
4. Pick a box:  CPU / GPU / TPU card — done, files are already syncing
5. Open a file: press Ctrl+Alt+R — output starts streaming
```

First connect pushes the **whole workspace folder**; every later save pushes only what changed.

---

## ⌨️ Keymap

| Action | Key |
|---|---|
| Run active file | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> |
| Run with args (editable, pre-filled) | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> |
| Machine terminal | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> |
| Full sync (push + pull) | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Y</kbd> |

Hover any editor button or panel button — its shortcut is shown right there.

## 🖱 Editor buttons

Any file open → top-right shows:

- **▶** — run it now, stream output
- **🖥 ⟨/⟩** — run-with-args input (comes pre-filled; edit for flags like `python3 -m pkg.main --fast`, Enter runs as-is)

## 📋 Commands (palette)

`Sign in / Sign out` · `Assign runtime — full spec picker` · `Assign CPU/GPU/TPU` ·
`Set default runtime (★)` · `Run active file` · `Run on a specific runtime…` ·
`Run command…` · `Open terminal (by runtime)` · `Full sync` · `File watcher (on/off)` ·
`List runtimes` · `Release runtime` · `Install toolchain…` · `Clean remote workspace`

## ⚙️ Settings

| Setting | Default | |
|---|---|---|
| `colabPipe.remoteRoot` | `/content/ws` | where your workspace lives on the machine |
| `colabPipe.ignore` | `.git, __pycache__, node_modules, .venv, venv, *.pyc` | transfer ignore list |
| `colabPipe.autoSync` | `true` | save ⇒ instant push |
| `colabPipe.autoRun` | `false` | also run after save |
| `colabPipe.filesMaxMB` | `36` | skip transfers above this size |

---

## 🧭 Good to know

- Releasing a machine (✕) wipes its sync state — the next assign re-pushes everything, so stale mappings never bite.
- Files over ~36 MB are skipped with a visible note — load heavy datasets directly and keep them in `ignore`.
- One terminal per machine, tmux-backed — typing survives disconnects.
- Not affiliated with Google; runtimes are your own Colab sessions under your account.

## 📝 License

[MIT](LICENSE.md) — © Blakite Ravi
