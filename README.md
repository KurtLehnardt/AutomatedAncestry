# AutomatedAncestry

An AI research assistant for family history that anyone can set up, on any computer.
One command checks your computer and offers two ways to run:

- **On this computer** — installs **Ollama**, a model sized for your hardware, and your
  choice of **OpenClaw** or **Hermes Agent** (or both). Private and offline.
- **Free online services** — for small computers like a 4 GB Chromebook. Runs Hermes Agent
  through [Free Claude Code – Secure](https://github.com/KurtLehnardt/free-claude-code-secure)
  on free AI services, and walks you through getting each free key step by step.

Either way you get a **Family History Assistant** shortcut to start it.

The models it installs can read images, which helps with scanned census pages,
certificates and handwritten records.

Built on the installer from [granted](https://github.com/KurtLehnardt/granted): same
memory detection, same old-macOS Ollama fallback, same `bash -c "$(curl …)"` pattern
that avoids the stdin truncation bug (granted #255).

> **Genealogy sites and automation:** many sites restrict bots and scripted access in
> their terms of use. Read the terms of any site (FamilySearch, Ancestry, etc.) before
> letting an agent log in or browse it for you. Using the agent on records and notes you
> already have is always fine.

## Install

**macOS**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-macos.sh)"
```

**Linux / Chromebook (Settings → Developers → turn on Linux first)**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-linux.sh)"
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-windows.ps1 | iex
```

Each one installs Node 24.16+ and git if needed, clones this repo, and runs the guided
setup. Already have the repo? `npm run setup` (or `npm run setup:dry` to preview).

## Free online mode

Built for people who have never used a terminal. Setup:

1. Explains, in plain words, what gets sent online and asks if that's okay.
2. Installs Hermes Agent and Free Claude Code – Secure (FCC) from a pinned commit:
   clone → check out the pinned SHA → verify `HEAD` → export `uv.lock` to constraints →
   `uv tool install` against them, so the whole dependency set is pinned on any uv version.
3. Starts FCC on `127.0.0.1` only.
4. Walks through each free service, one at a time:

   | Service | Why | Sign-up page |
   |---|---|---|
   | NVIDIA | Large, capable free models | build.nvidia.com/settings/api-keys |
   | Google Gemini | Good at reading photos of old records | aistudio.google.com/apikey |
   | Groq | Very fast, no credit card | console.groq.com/keys |
   | OpenRouter | Backup across many free models | openrouter.ai/keys |

   For each one it opens the page in the browser, lists the 3 clicks, tells you how to
   paste on your kind of computer, cleans up messy pastes, notices a key pasted into the
   wrong step, then saves it through FCC's local admin API and tests it. Bad keys are
   never left saved. Any service can be skipped; at least one is needed.
5. Sets the first working service as the main model and the rest as automatic backups.
6. Makes a **Family History Assistant** shortcut that starts FCC if needed, then opens
   Hermes through it (`fcc-hermes`).

Free mode uses Hermes only: FCC has a built-in Hermes launcher, but OpenClaw isn't one
of FCC's supported clients. Free tiers have daily limits, and what you type goes to
those companies — setup says so up front.

Skip the question with `--mode local` or `--mode cloud`.

## Pick your agent

Setup asks which one you want. Both run natively on Windows, macOS, Linux and a
Chromebook's Linux container, and both can share the same downloaded model.

| | **OpenClaw** | **Hermes Agent** |
|---|---|---|
| Best for | Reaching it from anywhere | Long research projects |
| Strengths | Chat from WhatsApp, Telegram, Signal, Slack, Discord and more; skills are files you install and review | Remembers across sessions; writes its own skills as it works |
| Made by | OpenClaw Foundation (nonprofit, no paid tiers) | Nous Research (free and open source, optional paid services) |
| Windows | Native | Native (newer) |
| Talks to Ollama via | Ollama's native API | Ollama's OpenAI-compatible API (setup builds a 64K-context copy of the model, the minimum Hermes accepts) |
| Start chatting | `openclaw tui` | `hermes` |
| Free online mode | — | ✓ (through FCC) |

Skip the question with `--agent openclaw`, `--agent hermes` or `--agent both`.
Unattended runs (`--yes`) default to OpenClaw.

## How the model is picked

Every model offered supports tool calling (both agents need it) and can read images,
which helps with scanned records.

| Usable memory | Model | Download | Notes |
|---|---|---|---|
| 90 GB+ | `qwen3.5:122b` | ~81 GB | GPU or big Mac only |
| 30–89 GB | `qwen3.5:35b` | ~24 GB | Mixture-of-experts: fast for its size, OK on CPU |
| 22–29 GB | `qwen3.5:27b` | ~17 GB | GPU or Mac only (too slow on CPU) |
| 10–21 GB | `qwen3.5:9b` | ~6.6 GB | |
| 6–9 GB | `qwen3.5:4b` | ~3.4 GB | |
| 4–5 GB | `qwen3.5:2b` | ~2.7 GB | |
| under 4 GB | `qwen3.5:0.8b` | ~1 GB | Setup recommends a cloud model instead |

"Usable" means: all NVIDIA cards' VRAM added together (Ollama splits a model across
them); 65% of an Apple Silicon Mac's memory; otherwise RAM minus 4 GB for the OS and
the agent. If you already have a tool-capable model in Ollama, setup offers to reuse
it. Override with `--model <tag>`.

## Differences from granted's setup:local

- Node floor is **24.16** (OpenClaw's requirement), not 22.
- No embeddings model or corpus re-embed; instead it installs and configures OpenClaw
  and/or Hermes Agent.
- Model tiers leave headroom for an agent's context (32K OpenClaw, 64K Hermes) and check tool support.
- Linux gets automatic Ollama install (official script, downloaded to a file first).
- Refuses to run as root.

## Development

```bash
npm test   # 128 hermetic unit tests, no network, Ollama, or FCC needed
```
