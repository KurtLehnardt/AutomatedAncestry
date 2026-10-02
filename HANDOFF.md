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
6. ~~Next feature: a "family history researcher" skill~~ — built (`scripts/family-skill.mjs`, `scripts/familysearch.mjs`, `scripts/__tests__/familySkill.test.mjs`, `scripts/__tests__/familysearch.test.mjs`): research log, mandatory citation, confidence-tagged foreign-language/old-script transcription, terms-of-service check before automating any site, and a real FamilySearch.org OAuth integration (read + confirmed-per-write edit) — scoped to FamilySearch only; Ancestry.com was explicitly excluded (their ToS prohibits automated access, confirmed by actually reading https://www.familysearch.org/legal/terms — "you will not use any software, technology, or device to perform a bulk download, to scrape content, or to otherwise harvest any information"; that same clause is why a browser-automation-with-real-credentials fallback was also rejected for FamilySearch itself, not just Ancestry — using real credentials doesn't change that it's still "software... interacting with the site").
   - **Kurt still needs to do, manually, before this is live**: register a FamilySearch developer app at https://developers.familysearch.org (type: Desktop/Native, redirect URI exactly `http://localhost:4567/auth/familysearch/callback`), then run `node scripts/setup.mjs --familysearch-setup` (CLI entry point now wired up) and paste the app's Client ID when asked. This can't be done by an agent — it's tied to Kurt's own FamilySearch account.
   - **Resolved**: a fresh app key's non-production tier is confirmed automatic (no approval wait) per developers.familysearch.org/main/docs/getting-started — FamilySearch's docs just disagree on what to call that tier (Integration/Sandbox on one page, Beta on another). **Still open**: real Production access (the live, public tree) requires their business/nonprofit-only "Compatible Solution Program" (formal agreements + solution evaluation, per their compatibility-review-process page) — whether an individual's personal tool can reach Production through any lighter path isn't addressed anywhere fetchable. Kurt should ask FamilySearch Developer Support directly rather than assume either way; `scripts/familysearch.mjs`'s `ENVIRONMENT NOTE` comment has the full citation trail.
   - Ancestry.com, and any other site beyond FamilySearch, falls under the skill's generic "check terms before automating" rule (which tells the agent to refuse and suggest the manual/official path) — no site-specific integration was built for them, by design.
   - **Also built**: a `SOUL.md` persona (`SOUL_BODY` in `scripts/family-skill.mjs`) for both agents — scoped safely, never the user's default: a dedicated Hermes profile (`hermes profile create family-history`, since SOUL.md is profile-scoped there) and a dedicated OpenClaw workspace at `~/.family-history/` (since SOUL.md there resolves per-cwd, not globally). Installed via the same opt-in prompt as the skill in `setup.mjs`/`free-cloud.mjs`. Live-verified on Hermes (`hermes -p family-history -z "..."` reflects the persona's documented behavior); statically verified on OpenClaw (no model configured locally to test live — confirmed via OpenClaw's own `resolveWorkspaceBootstrapPath` function that it resolves to the written file). Never overwrites a SOUL.md that already exists at either location, in case Kurt has since customized it.
   - **Not built** (raised, explicitly declined per the ToS finding above): emailing county/vital-records offices to request records. This is plain email, not site automation, so it has no ToS problem — unlike the site-automation items, this is a real open opportunity, not a declined one. Would need an email-sending integration (e.g. an MCP server) wired into Hermes, plus a skill extension that drafts the request and gets per-email confirmation before sending, same pattern as the FamilySearch writes.

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
