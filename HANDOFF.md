# HANDOFF.md

## Context
AutomatedAncestry is a guided installer for a family-history AI assistant. It installs either:
- **Local mode**: Ollama + a hardware-sized qwen3.5 model + OpenClaw and/or Hermes Agent
- **Free online mode**: Hermes Agent routed through KurtLehnardt/free-claude-code-secure (FCC), with a guided, beginner-friendly flow for getting free API keys

Main code: `scripts/setup.mjs` and `scripts/free-cloud.mjs`. Start with README.md. Tests: `npm test`.

This was a finished, tested project when handed off for publishing. Do not refactor working code — explain before changing behavior.

## Task list for future agents
1. ~~Publish~~ — done: unzipped, tested, repo created & pushed.
2. ~~Add this HANDOFF.md~~ — done.
3. Verify with real services (ask the user for keys when needed; never commit keys):
   - Run `node scripts/setup.mjs --mode cloud` for real. Confirm each provider's key test passes and that the chosen model IDs exist (Gemini flash-lite name, Groq gpt-oss-120b, NVIDIA nemotron, openrouter/free). Fix `pickProviderModel` preferences if needed.
   - Start `fcc-hermes` and have a short chat to confirm it works.
   - Local mode with Hermes: confirm requests go to local Ollama, not OpenRouter (older Hermes versions had that bug).
4. Windows: test `install-windows.ps1` and free mode on Windows. As of this handoff, only a MacBook Pro M1 (Mac/ARM) was available — Windows testing is still outstanding. See the "Needs Windows testing" list below for what to cover.
5. In `KurtLehnardt/free-claude-code-secure`, on a branch, showing the user the diff first:
   - uv 0.12.x has no `uv tool install --locked`, so it's silently dropped. Use `uv export --frozen --format requirements-txt --no-emit-project --no-dev` plus `--constraints`.
   - `FCC_COMMIT` pins v6.1.2 while main is 6.8.0; propose a bump.
   - `install.checksums` still has REPLACE_ME entries. Run `--refresh-checksums` and show the hashes; don't paste them in until approved.
   - After any bump, update `FCC_COMMIT` in AutomatedAncestry's `scripts/free-cloud.mjs` to match.
6. Next feature: a "family history researcher" skill for Hermes and OpenClaw that keeps a research log (people, dates, places, sources searched, dead ends), cites the source for every fact, handles foreign-language and old-script records carefully (marks uncertain readings rather than guessing), and checks a website's terms before automating it. Propose the design to the user before building it.

## Test status at publish time
`npm test` → 128/128 passing, 0 failed, 20 suites, ~110ms. Matches the README's documented "128 hermetic unit tests, no network, Ollama, or FCC needed." No deviation to flag.

Environment: macOS (Apple Silicon, M1), Node v26.10.0 (floor is 24.16+). `npm install` reported 0 dependencies / 0 vulnerabilities — the project has no runtime deps, only Node's built-in test runner.

## Needs Windows testing
Not yet run on real Windows — only verified on a MacBook Pro M1 so far. `install-windows.ps1` and the following Windows-specific branches in the scripts are untested on actual Windows:

- **`install-windows.ps1` itself** — end-to-end: Node/git bootstrap, repo clone, handoff into `npm run setup`.
- **`scripts/setup.mjs`**:
  - RAM detection via `Get-CimInstance Win32_ComputerSystem` (line ~508) and free-disk via `Get-PSDrive` (line ~518) — both shell out to `powershell`.
  - `winget` detection/usage for auto-install (`hasWinget`, line ~201, ~525).
  - OpenClaw Windows installer path (`-NoOnboard`, line ~222-226) and Hermes Windows installer path (`-NonInteractive`, line ~302-306), both via `powershell -ExecutionPolicy Bypass`.
  - `ollamaWindowsDir` / launching `ollama app.exe` from `%LOCALAPPDATA%\Programs\Ollama` (line ~342, ~386).
  - PATH handling for Hermes bin dirs under `%LOCALAPPDATA%` and `.local\bin` (line ~336-337).
  - `shell: true` / `windowsHide: true` spawn behavior differences vs. macOS/Linux (line ~446, ~458).
- **`scripts/free-cloud.mjs`**:
  - `uv` install via `irm ${UV_INSTALL_PS1} | iex` (line ~317).
  - Windows health-check/background-start logic for `fcc-server` via `powershell -Command` (line ~207-211).
  - Launcher creation at `%LOCALAPPDATA%\AutomatedAncestry\Family History Assistant.cmd` plus a Desktop copy (line ~453-460).
  - Opening sign-up pages via `cmd /c start` (line ~154) and the "right-click/Ctrl+V" paste instructions (line ~161).
  - Path separator handling (`win32.join`, `;` vs `:` for PATH, line ~197, ~439).

None of this is exercised by the hermetic test suite (which mocks `platform` but doesn't run real Windows subprocesses), so it needs a live Windows machine or VM.
