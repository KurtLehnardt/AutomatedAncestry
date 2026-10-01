/**
 * AutomatedAncestry — "free online" mode.
 *
 * Runs Hermes Agent through Free Claude Code – Secure (FCC), a local proxy that
 * routes the agent to free cloud AI services. This module:
 *   1. installs FCC from the pinned commit of KurtLehnardt/free-claude-code-secure,
 *      verifying HEAD before `uv tool install --locked` (the same supply-chain
 *      pinning FCC's own installer does, without its unpinned-checksum gate);
 *   2. starts the FCC server on 127.0.0.1;
 *   3. walks the person through getting free keys one service at a time: it
 *      opens the sign-up page, explains what to click, takes the pasted key,
 *      saves it through FCC's local admin API and tests it;
 *   4. sets the main model plus backups, and makes a "Family History" shortcut.
 *
 * Pure helpers are exported and unit-tested; `runFreeCloud` does the I/O and
 * receives its terminal/process helpers from setup.mjs.
 */
import { writeFileSync, mkdirSync, existsSync, chmodSync, mkdtempSync } from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { installFamilyHistorySkill } from "./family-skill.mjs";

export const FCC_REPO_URL = "https://github.com/KurtLehnardt/free-claude-code-secure.git";
/** Same commit FCC – Secure's own installer pins (scripts/install.sh FCC_COMMIT). */
export const FCC_COMMIT = "ebdfc5e6c9e7c09c32b55c59950b5e3f2b93d72f";
export const FCC_PYTHON = "3.14.0";
export const FCC_URL = "http://127.0.0.1:8082";
/** Versioned (not rolling) uv installer, used only if Hermes' install didn't leave uv behind. */
export const UV_INSTALL_SH = "https://astral.sh/uv/0.11.16/install.sh";
export const UV_INSTALL_PS1 = "https://astral.sh/uv/0.11.16/install.ps1";

// ---------------------------------------------------------------------------
// PURE LOGIC
// ---------------------------------------------------------------------------

/**
 * The free services we walk people through, in the order we suggest them.
 * `id` is FCC's provider id; `envKey` is FCC's Admin UI setting; `models` are
 * preferences tried against the provider's live model list.
 */
export const FREE_PROVIDERS = [
  {
    id: "nvidia_nim",
    envKey: "NVIDIA_NIM_API_KEY",
    name: "NVIDIA",
    url: "https://build.nvidia.com/settings/api-keys",
    why: "Large, capable free models. A good main service.",
    steps: [
      "Sign in, or make a free NVIDIA account (an email address is enough).",
      "Click the button to generate a new API key.",
      "Click Copy next to the long code that appears.",
    ],
    keyPrefix: "nvapi-",
    models: ["nvidia/nemotron-3-super-120b-a12b", /nemotron/],
    fallbackModel: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    name: "Google Gemini",
    url: "https://aistudio.google.com/apikey",
    why: "Good at reading photos of old documents and handwriting.",
    steps: [
      "Sign in with your Google (Gmail) account.",
      "Click \"Create API key\".",
      "Click Copy next to the key it shows you.",
    ],
    keyPrefix: "AIza",
    models: ["models/gemini-3.1-flash-lite", /^models\/gemini-[\d.]+-flash-lite$/, /^models\/gemini-[\d.]+-flash$/],
    fallbackModel: "models/gemini-3.1-flash-lite",
  },
  {
    id: "groq",
    envKey: "GROQ_API_KEY",
    name: "Groq",
    url: "https://console.groq.com/keys",
    why: "Very fast. No credit card needed.",
    steps: [
      "Sign in, or make a free Groq account.",
      "Click \"Create API Key\" and give it any name, like Family History.",
      "Click Copy next to the key. Groq only shows it once.",
    ],
    keyPrefix: "gsk_",
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
    fallbackModel: "llama-3.3-70b-versatile",
  },
  {
    id: "open_router",
    envKey: "OPENROUTER_API_KEY",
    name: "OpenRouter",
    url: "https://openrouter.ai/keys",
    why: "A backup that switches between many free models.",
    steps: [
      "Sign in, or make a free OpenRouter account.",
      "Click \"Create Key\" and give it any name.",
      "Click Copy next to the key. It is only shown once.",
    ],
    keyPrefix: "sk-or-",
    models: ["openrouter/free"],
    fallbackModel: "openrouter/free",
  },
];

/** Tidy whatever got pasted: spaces, line breaks, quotes, or a whole `NAME=key` line. */
export function cleanKey(raw) {
  let k = String(raw ?? "").trim();
  const eq = k.match(/^[A-Z][A-Z0-9_]*\s*=\s*(.+)$/);
  if (eq) k = eq[1];
  return k.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, "");
}

/** Which service a key looks like it came from (catches pasting into the wrong step). */
export function detectKeyProvider(key) {
  const k = cleanKey(key);
  const hit = FREE_PROVIDERS.find((p) => k.startsWith(p.keyPrefix));
  return hit ? hit.id : null;
}

/** "gsk_abc…wxyz" — enough to recognise, not enough to reuse. */
export function maskKey(key) {
  const k = cleanKey(key);
  if (k.length <= 10) return "•".repeat(k.length);
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

/**
 * Choose a model for a provider from its live list. Preferences may be exact
 * ids or regexes; if nothing matches (or the list is empty), use the
 * documented default so setup can still finish.
 */
export function pickProviderModel(provider, liveModels = []) {
  const live = Array.isArray(liveModels) ? liveModels : [];
  for (const pref of provider.models) {
    const hit = typeof pref === "string" ? live.find((m) => m === pref) : live.find((m) => pref.test(m));
    if (hit) return `${provider.id}/${hit}`;
  }
  return `${provider.id}/${provider.fallbackModel}`;
}

/** First working service is the main model; the rest become automatic backups. */
export function buildModelConfig(modelRefs) {
  const refs = [...new Set(modelRefs.filter(Boolean))];
  if (!refs.length) return null;
  return { MODEL: refs[0], MODEL_FALLBACKS: refs.slice(1).join(",") };
}

/** Suggest free online mode when the computer can't run a dependable local model. */
export function recommendMode(tier) {
  return tier && (tier.tooSmall || tier.needGB < 6) ? "cloud" : "local";
}

/** How to open a web page in the person's normal browser. */
export function openUrlCommand(platform, url) {
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", '""', url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] }; // ChromeOS Linux hands this to Chrome
}

/** How to paste into a terminal on this system, in plain words. */
export function pasteHint(platform) {
  if (platform === "win32") return "right-click in this window (or press Ctrl+V)";
  if (platform === "darwin") return "press Command+V";
  return "press Ctrl+Shift+V";
}

/**
 * Steps that install FCC at the pinned commit. `dir` is a fresh temp folder.
 *
 * Current uv releases don't accept `--locked` on `uv tool install`, so relying on
 * it alone lets dependency versions float. We always export the checkout's
 * uv.lock to a constraints file and install against it, which pins the whole
 * dependency closure on any uv; `--locked` is added too when uv supports it.
 */
export function fccInstallSteps(dir, { locked = false, sep = "/" } = {}) {
  const spec = `free-claude-code @ file://${dir.replace(/\\/g, "/")}`;
  const constraints = `${dir}${sep}aa-constraints.txt`;
  return [
    { cmd: "git", args: ["clone", "--quiet", FCC_REPO_URL, dir] },
    { cmd: "git", args: ["-C", dir, "checkout", "--quiet", "--detach", FCC_COMMIT] },
    { verifyHead: true },
    {
      cmd: "uv",
      args: ["export", "--project", dir, "--frozen", "--format", "requirements-txt", "--no-emit-project", "--no-dev", "--quiet", "-o", constraints],
    },
    {
      cmd: "uv",
      args: [
        "tool", "install", "--force", "--refresh-package", "free-claude-code", "--python", FCC_PYTHON,
        "--constraints", constraints, ...(locked ? ["--locked"] : []), spec,
      ],
    },
  ];
}

/** Where `uv tool` puts commands like fcc-server and fcc-hermes. */
export function fccBinDir(platform, home = homedir()) {
  return platform === "win32" ? win32.join(home, ".local", "bin") : join(home, ".local", "bin");
}

/**
 * The "Family History" launcher. Free mode starts the FCC server if it isn't
 * running, then opens Hermes through it; local modes just open the agent.
 */
export function launcherScript(platform, { mode, agent }) {
  const cloud = mode === "cloud";
  const chat = cloud ? "fcc-hermes" : agent === "openclaw" ? "openclaw tui" : "hermes";
  if (platform === "win32") {
    const lines = ["@echo off", "title Family History Assistant", 'set "PATH=%USERPROFILE%\\.local\\bin;%LOCALAPPDATA%\\hermes\\bin;%PATH%"'];
    if (cloud) {
      lines.push(
        `powershell -NoProfile -Command "try { Invoke-RestMethod ${FCC_URL}/health | Out-Null } catch { $env:FCC_OPEN_BROWSER='false'; Start-Process fcc-server -WindowStyle Hidden; foreach ($i in 1..60) { try { Invoke-RestMethod ${FCC_URL}/health | Out-Null; break } catch { Start-Sleep 1 } } }"`,
      );
    }
    lines.push(`${chat} %*`, "pause");
    return lines.join("\r\n") + "\r\n";
  }
  const lines = ["#!/usr/bin/env bash", "# Family History Assistant (AutomatedAncestry)", 'export PATH="$HOME/.local/bin:$HOME/.openclaw/bin:$PATH"'];
  if (cloud) {
    lines.push(
      `if ! curl -fs ${FCC_URL}/health >/dev/null 2>&1; then`,
      "  FCC_OPEN_BROWSER=false nohup fcc-server >/dev/null 2>&1 &",
      `  for _ in $(seq 1 60); do curl -fs ${FCC_URL}/health >/dev/null 2>&1 && break; sleep 1; done`,
      "fi",
    );
  }
  lines.push(`exec ${chat} "$@"`);
  return lines.join("\n") + "\n";
}

/** Desktop/app-menu entry that opens the launcher in a terminal (Linux & ChromeOS). */
export function desktopEntry(launcherPath) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Family History Assistant",
    "Comment=Research your family history with AutomatedAncestry",
    `Exec=${launcherPath}`,
    "Terminal=true",
    "Categories=Education;",
    "",
  ].join("\n");
}

export const PRIVACY_NOTE = [
  "What you type, and any pictures of records you share, are sent to these",
  "companies to be answered. Free services may keep or learn from what you send.",
  "That's fine for researching ancestors who have passed away. Please don't type",
  "passwords, bank or ID numbers, or private details about living relatives.",
];

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

async function fccHealthy() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${FCC_URL}/health`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForFcc(seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (await fccHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** FCC's admin API only answers on this computer (loopback + Host checks). */
async function admin(path, body) {
  const res = await fetch(`${FCC_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
  return json;
}

/** Save settings, wait out FCC's automatic restart, return its reply. */
async function applySettings(values) {
  const result = await admin("/admin/api/config/apply", { values });
  await new Promise((r) => setTimeout(r, 1500));
  await waitForFcc(60);
  return result;
}

export async function runFreeCloud(ctx) {
  const { platform, DRY, YES, c, heading, ask, confirm, run, runInherit, installHermes, childEnv } = ctx;

  heading("Free online mode — before we start");
  for (const line of PRIVACY_NOTE) console.log(`  ${line}`);
  console.log(c.dim("\n  Free services have daily limits. If it stops answering, the allowance resets the next day,"));
  console.log(c.dim("  and each extra service you add gives it a backup to switch to."));
  if (!(await confirm("Is that okay?", true))) {
    console.log("  No problem — nothing was changed.");
    process.exit(0);
  }

  // 1) Hermes, then FCC (Hermes' installer normally leaves uv behind for us).
  await installHermes();
  heading("Free Claude Code – Secure (connects Hermes to the free services)");
  if (run("fcc-server", ["--help"], 15000) && run("fcc-hermes", ["--help"], 15000)) {
    console.log(`  ${c.g("✓")} already installed`);
  } else {
    if (!run("uv", ["--version"])) {
      console.log(c.dim("  Installing uv (a helper that FCC needs)…"));
      const ok =
        platform === "win32"
          ? runInherit("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${UV_INSTALL_PS1} | iex`])
          : runInherit("sh", ["-c", `curl -LsSf ${UV_INSTALL_SH} -o /tmp/uv-install.sh && sh /tmp/uv-install.sh`]);
      if (!ok || (!DRY && !run("uv", ["--version"]))) {
        console.log(c.r("  Couldn't install uv. Open a new terminal window and run this setup again."));
        process.exit(1);
      }
    }
    const dir = DRY ? "<temp folder>" : join(mkdtempSync(join(tmpdir(), "aa-fcc-")), "src");
    const locked = !DRY && (run("uv", ["tool", "install", "--help"]) || "").includes("--locked");
    console.log(c.dim(`  Downloading FCC at pinned commit ${FCC_COMMIT.slice(0, 7)} and checking it…`));
    for (const step of fccInstallSteps(dir, { locked, sep: platform === "win32" ? "\\" : "/" })) {
      if (step.verifyHead) {
        const head = DRY ? FCC_COMMIT : (run("git", ["-C", dir, "rev-parse", "HEAD"]) || "").trim();
        if (head !== FCC_COMMIT) {
          console.log(c.r(`  Security check failed: downloaded code is ${head || "unknown"}, expected ${FCC_COMMIT}. Stopping.`));
          process.exit(1);
        }
        console.log(`  ${c.g("✓")} code matches the pinned commit`);
        continue;
      }
      if (!runInherit(step.cmd, step.args)) {
        console.log(c.r("  FCC install failed — see the messages above."));
        process.exit(1);
      }
    }
    console.log(`  ${c.g("✓")} FCC installed`);
  }

  // 2) Start the FCC server quietly in the background.
  if (!DRY && !(await fccHealthy())) {
    console.log(c.dim("  Starting FCC…"));
    const child = spawn("fcc-server", [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: platform === "win32",
      env: { ...childEnv(), FCC_OPEN_BROWSER: "false" },
    });
    child.on("error", () => {});
    child.unref();
    if (!(await waitForFcc())) {
      console.log(c.r("  FCC didn't start. Try running `fcc-server` in another window, then run this setup again."));
      process.exit(1);
    }
  }
  if (!DRY) console.log(`  ${c.g("✓")} FCC running on this computer only (${FCC_URL})`);

  // 3) Guided keys, one service at a time.
  heading("Free AI services");
  console.log("  A \"key\" is like a password that lets this program use a free service for you.");
  console.log("  We'll get one from each service. Each takes about two minutes. You can skip any of them,");
  console.log("  but you need at least one. Two or more is better: if one is busy, it switches to the next.\n");

  const working = [];
  for (const [i, p] of FREE_PROVIDERS.entries()) {
    heading(`Service ${i + 1} of ${FREE_PROVIDERS.length}: ${p.name}`);
    console.log(`  ${p.why}`);
    if (DRY) {
      console.log(c.dim(`    [dry-run] open ${p.url}, ask for the key, save ${p.envKey}, test ${p.id}`));
      working.push(pickProviderModel(p));
      continue;
    }
    if (YES) {
      console.log(c.dim("  Skipped (unattended run)."));
      continue;
    }
    if (!(await confirm(`Set up ${p.name} now?`, true))) continue;

    const open = openUrlCommand(platform, p.url);
    console.log(c.dim(`\n  Opening ${p.url} in your web browser…`));
    if (!run(open.cmd, open.args, 15000)) console.log(c.y(`  Couldn't open it automatically. Please type this address into your browser:\n  ${p.url}`));
    console.log("\n  In the browser:");
    p.steps.forEach((s, n) => console.log(`    ${n + 1}. ${s}`));
    console.log(`    ${p.steps.length + 1}. Come back to this window and ${pasteHint(platform)}, then press Enter.`);

    let savedButFailing = false;
    for (;;) {
      const raw = await ask(`\n  Paste your ${p.name} key here ${c.dim("(or just press Enter to skip)")}: `);
      const key = cleanKey(raw);
      if (!key) break;
      const looksLike = detectKeyProvider(key);
      if (looksLike && looksLike !== p.id) {
        const other = FREE_PROVIDERS.find((x) => x.id === looksLike);
        console.log(c.y(`  That looks like a ${other.name} key, not a ${p.name} key. Please copy the ${p.name} one.`));
        continue;
      }
      console.log(c.dim(`  Checking ${maskKey(key)} …`));
      try {
        await applySettings({ [p.envKey]: key });
        savedButFailing = true;
        const test = await admin(`/admin/api/providers/${p.id}/test`, {});
        if (test.ok) {
          savedButFailing = false;
          const ref = pickProviderModel(p, test.models);
          working.push(ref);
          console.log(`  ${c.g("✓")} ${p.name} works.`);
          break;
        }
        console.log(c.y(`  ${p.name} didn't accept that key. It may not have copied fully — please copy it again.`));
      } catch (err) {
        console.log(c.y(`  Couldn't check the key (${err.message}). Let's try once more.`));
      }
      if (!(await confirm("Try pasting again?", true))) break;
    }
    if (savedButFailing) {
      // Don't leave a key that didn't work in FCC's settings.
      await applySettings({ [p.envKey]: "" }).catch(() => {});
      console.log(c.dim(`  Skipped ${p.name}. You can add it later.`));
    }
  }

  const modelConfig = buildModelConfig(working);
  if (!modelConfig) {
    console.log(c.r("\n  No services were set up, so there's nothing for Hermes to use yet."));
    console.log("  Run this setup again any time to add a key.");
    process.exit(1);
  }
  if (DRY) console.log(c.dim(`    [dry-run] save MODEL=${modelConfig.MODEL} MODEL_FALLBACKS=${modelConfig.MODEL_FALLBACKS}`));
  else await applySettings(modelConfig);
  console.log(`\n  ${c.g("✓")} Main service: ${modelConfig.MODEL}`);
  if (modelConfig.MODEL_FALLBACKS) console.log(`  ${c.g("✓")} Backups: ${modelConfig.MODEL_FALLBACKS.split(",").join(", ")}`);

  // 4) Shortcut.
  const shortcut = DRY ? "<shortcut>" : writeLauncher(platform, { mode: "cloud", agent: "hermes" });

  if (!DRY && (await confirm("Install the Family History Researcher skill (keeps a cited research log)?", true))) {
    for (const p of installFamilyHistorySkill(["hermes"])) console.log(`  ${c.g("✓")} skill installed: ${p}`);
  }

  heading("All done!");
  console.log(`  To start: open ${c.b("Family History Assistant")} ${c.dim(`(${shortcut})`)}`);
  console.log(`  or type ${c.g("fcc-hermes")} in a terminal.`);
  console.log(c.dim("  To add or change services later: open http://127.0.0.1:8082/admin while it's running,"));
  console.log(c.dim("  or run this setup again.\n"));
  process.exit(0);
}

/** Write the launcher plus a desktop / app-menu shortcut. Returns where to find it. */
export function writeLauncher(platform, opts) {
  const home = homedir();
  if (platform === "win32") {
    const dir = win32.join(process.env.LOCALAPPDATA || home, "AutomatedAncestry");
    mkdirSync(dir, { recursive: true });
    const launcher = win32.join(dir, "Family History Assistant.cmd");
    writeFileSync(launcher, launcherScript(platform, opts));
    const desktop = win32.join(home, "Desktop");
    if (existsSync(desktop)) {
      writeFileSync(win32.join(desktop, "Family History Assistant.cmd"), launcherScript(platform, opts));
      return "on your Desktop";
    }
    return launcher;
  }
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "family-history");
  writeFileSync(launcher, launcherScript(platform, opts));
  chmodSync(launcher, 0o755);
  if (platform === "darwin") {
    const desktop = join(home, "Desktop");
    if (existsSync(desktop)) {
      const cmd = join(desktop, "Family History Assistant.command");
      writeFileSync(cmd, `#!/bin/bash\nexec "${launcher}"\n`);
      chmodSync(cmd, 0o755);
      return "on your Desktop";
    }
    return launcher;
  }
  // Linux & ChromeOS: app menu entry (ChromeOS shows it in the launcher), plus Desktop if there is one.
  const apps = join(home, ".local", "share", "applications");
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, "family-history.desktop"), desktopEntry(launcher));
  const desktop = join(home, "Desktop");
  if (existsSync(desktop)) {
    const d = join(desktop, "family-history.desktop");
    writeFileSync(d, desktopEntry(launcher));
    chmodSync(d, 0o755);
  }
  return "in your apps menu";
}
