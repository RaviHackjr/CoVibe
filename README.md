# CoVibe

> Run code on remote CPU / GPU / TPU machines directly from VS Code — files sync as you type, output streams in real time, and a full terminal is one keystroke away.

**Version 0.15.6** · [MIT License](LICENSE.md) · VS Code 1.90+

A private-build editor extension that pairs your local workspace with remote machines: save a file, it is already on the machine; press run, output streams back as the program produces it. Supports Python, JavaScript, shell, Go, C, C++, Rust and Java project layouts, and lets several machines work at once with a default target.

---

## Features

| Feature | Description |
|---|---|
| One-key run | Runs the active file in its native toolchain, detected from the file extension |
| Real-time output | Unbuffered streaming — output appears as the program prints it, not after exit |
| Run with args | Opens a pre-filled, editable command box (`python3 -u test.py`); edit flags and press Enter |
| Instant sync | Changes are pushed as deltas on save; generated outputs are pulled back automatically |
| Integrated terminal | Full PTY over WebSocket: htop, nano, colors, Ctrl-C; history survives network drops |
| Toolchains | One-click installers for gcc, g++, node, go, rust and java; idempotent |
| Machine pairs | A CPU + GPU + TPU set can be attached together with a starred default for runs |

Machines are provided by your own Google Colab account (CPU 2 vCPU / 12 GB, GPU T4 / 16 GB VRAM, TPU v5e). The free tier works.

---

## Installation

### 1. Download

Download `covibe-0.15.6.vsix` from [Releases](https://github.com/RaviHackjr/CoVibe/releases/latest).

### 2. Install

**Option A — command line:**

```bash
code --install-extension covibe-0.15.6.vsix
```

**Option B — VS Code UI:** open the **Extensions** view, click the **⋯** menu, choose **Install from VSIX...** and select the downloaded file.

**Option C — one-liner (Windows PowerShell):**

```powershell
Invoke-WebRequest "https://github.com/RaviHackjr/CoVibe/releases/download/v0.15.6/covibe-0.15.6.vsix" -OutFile covibe-0.15.6.vsix; code --install-extension covibe-0.15.6.vsix
```

### 3. Reload

`Ctrl+Shift+P` → **Developer: Reload Window**.

---

## Getting started

1. Click the **CoVibe** icon in the Activity Bar.
2. Choose **Sign in with Google**. Tokens are stored in the OS keychain and refreshed automatically.
3. Pick a machine card — **CPU**, **GPU** or **TPU** — or use **CoVibe: Assign runtime** from the palette for the full spec list.
4. Open any file in the workspace. The first save pushes the **complete folder** to the machine; later saves push only what changed.
5. Press **Ctrl+Alt+R** to run.

---

## Usage

### Editor buttons

With a file open, two buttons appear at the top right of the editor:

- **▶ Run** — runs the current file immediately.
- **⟨/⟩ Run with args** — opens a pre-filled command input; edit it for extra flags (`python3 -m pkg.main --fast`) and press Enter to run as-is.

### Keybindings

| Action | Key |
|---|---|
| Run active file | `Ctrl+Alt+R` |
| Run with args | `Ctrl+Shift+Alt+R` |
| Machine terminal | `Ctrl+Alt+T` |
| Full sync (push + pull) | `Ctrl+Alt+Y` |

Hover any button to see its shortcut.

### Command palette commands

| Command | Description |
|---|---|
| `CoVibe: Sign in` / `Sign out` | OAuth login; tokens go to the OS keychain |
| `CoVibe: Assign runtime (full spec picker)` | Choose any eligible machine spec |
| `CoVibe: Assign CPU/GPU/TPU runtime` | One-click machine add |
| `CoVibe: Set default runtime` | Starred machine used by runs and sync |
| `CoVibe: Run active file` | Push + run with real-time output |
| `CoVibe: Run active file on…` | Run on a specific machine in the pair |
| `CoVibe: Run command...` | Pre-filled, editable shell command |
| `CoVibe: Open terminal` / `Open terminal (runtime)…` | PTY terminal, per machine |
| `CoVibe: Full sync` | Push changed files and pull outputs |
| `CoVibe: Start file watcher` | Save-to-push loop on/off |
| `CoVibe: Install toolchain...` | gcc / node / go / rust / java / C |
| `CoVibe: Clean remote workspace` | Removes the remote workspace directory |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `colabPipe.remoteRoot` | `/content/ws` | Workspace directory on the remote machine |
| `colabPipe.ignore` | `.git, __pycache__, node_modules, .venv, venv, *.pyc` | Transfer ignore list |
| `colabPipe.autoSync` | `true` | Push on save |
| `colabPipe.autoRun` | `false` | Also run after save |
| `colabPipe.filesMaxMB` | `36` | Skip transfers larger than this size |

---

## Notes

- Releasing a machine wipes its sync state, so the next attach pushes the whole folder again — no stale mappings.
- Files over the size limit are skipped with a visible log; keep large datasets in the ignore list.
- Terminal sessions are tmux-backed and auto-reconnect.
- Not affiliated with Google. Runtimes are your own Colab sessions under your own account, and usage follows Google Colab's Terms of Service.

## License

Released under the [MIT License](LICENSE.md). © 2026 Blakite Ravi.
