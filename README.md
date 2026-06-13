<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Termul" />
  <h1>Termul</h1>
  <p><sub>(<b>TER</b>minal&nbsp;<b>mUL</b>tiplexer)</sub></p>

  <p><em>(it's not just a terminal.)</em></p>
  <p><strong>A lightweight, AI-native terminal &amp; dev workspace.</strong></p>

  <p>
    <img src="https://img.shields.io/github/v/release/binsarjr/termul?label=version&color=blue" alt="version" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
  </p>

  <p>
    <a href="https://github.com/binsarjr/termul">GitHub</a>
    ·
    <a href="https://github.com/binsarjr/termul/releases/latest">Releases</a>
  </p>
</div>

---

**Termul** (short for **TER**minal **mUL**tiplexer) is a lightweight, open-source terminal and dev workspace built on Tauri 2 + Rust and React 19. It pairs a native PTY backend and a WebGL-rendered, tabbed, splittable terminal with an agentic AI side-panel that runs on your own API keys or fully local models, and adds a built-in code editor, file explorer, and source control with a real git graph. Around 7-8 MB on disk. No telemetry. No account.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/terminal.png" alt="Terminal" /><br/><sub>Multi-tab terminal with WebGL rendering</sub></td>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" /><br/><sub>Custom themes, presets, and background images</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/source-control.png" alt="Source control and git graph" /><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/ai-workflow.png" alt="AI window" /><br/><sub>Agentic AI workflow with edit diffs in the code editor</sub></td>
  </tr>
</table>

## Why Termul

- **Tiny and native.** A Rust/Tauri shell instead of a bundled browser, so the whole app is roughly 7-8 MB and starts instantly. Features you don't use cost nothing.
- **A workspace, not just a prompt.** Terminal, editor, explorer, and git live side by side in one window, with splittable panes and tabs that keep streaming in the background.
- **AI on your terms.** Bring your own keys, or run entirely offline against a local model. Keys go to the OS keychain, never to disk or a server.
- **Private by default.** No telemetry, no account, no sign-in. Your code and keystrokes stay on your machine.

## Features

### Terminal

- xterm.js with the WebGL renderer, multi-tab with background streaming
- Native PTY backend via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Split panels, horizontal and vertical
- Inline search, link detection, true-color
- Per-tab workspace environments on Windows (Local, or any installed WSL distro)

### Code editor

- CodeMirror 6 with support for the popular languages (TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, and more)
- Inline AI autocomplete, including local-model support
- AI edit diffs you accept or reject hunk by hunk
- Vim mode
- Ten built-in editor themes: Atom One, Aura, Copilot, GitHub Dark / Light, Gruvbox Dark, Nord, Tokyo Night, Xcode Dark / Light

### Source control

- Stage and unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push with upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions
- Attach files and selections directly to the AI side-panel

### Themes and customization

- Build custom themes in-app and switch between bundled presets and your own
- Create themes, share them, or import from the community
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### AI

- **Bring your own key:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, plus any OpenAI-compatible endpoint
- **Local and offline:** LM Studio, MLX, Ollama
- **Agentic workflow:** plans, sub-agents, project memory via `AGENTS.md`, file read / write / edit / multi-edit / grep / glob, bash with approval gating, background processes
- **Composer:** snippets via `#handle`, files via `@path`, slash commands, voice input, attach-to-agent from the explorer or a selection
- **Custom agents** with their own system prompt and tool subset
- **Plan mode** for multi-step work that generates and confirms before acting

## Install

The latest installers are on the [Releases](https://github.com/binsarjr/termul/releases/latest) page, and the app auto-updates from there.

### Quick install (script)

**macOS / Linux** detects your platform and arch, downloads the matching asset from the latest release, and installs it. On macOS it also clears the quarantine flag and ad-hoc signs the app so Gatekeeper opens it (the builds are not notarized yet):

```sh
curl -fsSL https://raw.githubusercontent.com/binsarjr/termul/main/install.sh | sh
```

On Linux it picks `.deb`, `.rpm`, or `.AppImage` based on what your system uses.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/binsarjr/termul/main/install.ps1 | iex
```

### Windows notes

- On first launch Windows shows "Windows protected your PC" because the app is not code-signed yet. Click **More info**, then **Run anyway**.
- Default shell detection: `pwsh.exe` (PowerShell 7+), then `powershell.exe` (Windows PowerShell 5.1), then `cmd.exe`.
- WSL is a first-class workspace environment, not a wrapped subprocess.

### Linux notes

- **AppImage:** needs FUSE. Without it, run `./termul_*.AppImage --appimage-extract-and-run`. On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Otherwise the `.deb` and `.rpm` packages link against the system GTK stack and tend to be smoother.

## Configure AI

1. Open **Settings -> AI**.
2. Pick a provider and paste your API key. For local inference, point the app at your LM Studio / MLX / Ollama endpoint.
3. Keys are written to the OS keychain via `keyring`. They never touch disk or localStorage.

## Build from source

**Prerequisites**

- Rust (stable), https://rustup.rs
- Node 20+ and [pnpm](https://pnpm.io)
- Tauri prerequisites for your platform, https://tauri.app/start/prerequisites/

**Run**

```bash
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production bundle
```

**Checks**

```bash
pnpm exec tsc --noEmit                                            # frontend type-check
pnpm test                                                         # frontend tests
cd src-tauri && cargo clippy --all-targets --locked -D warnings   # Rust lint (matches CI)
cd src-tauri && cargo test --locked                               # Rust tests
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome. Open an issue, suggest a feature, or submit a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

Licensed under the Apache-2.0 License. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

## Star history

<div align="center">
  <a href="https://www.star-history.com/#binsarjr/termul&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=binsarjr/termul&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=binsarjr/termul&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=binsarjr/termul&type=Date" />
    </picture>
  </a>
</div>
