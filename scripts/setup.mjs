#!/usr/bin/env node
/**
 * AutomatedAncestry — guided setup (Ollama + OpenClaw and/or Hermes Agent).
 *
 *   node scripts/setup.mjs                    (interactive)
 *   node scripts/setup.mjs --yes              (non-interactive; sane defaults)
 *   node scripts/setup.mjs --dry-run          (detect + recommend, change nothing)
 *   node scripts/setup.mjs --model qwen3.5:4b
 *   node scripts/setup.mjs --agent hermes     (openclaw | hermes | both)
 *   node scripts/setup.mjs --mode cloud       (local | cloud — free online services)
 *   node scripts/setup.mjs --familysearch-setup  (one-time: connect the Family History
 *                                                 Researcher skill to your FamilySearch.org account)
 *   node scripts/setup.mjs --familyfinder-setup  (one-time: store your familyFinder.net login
 *                                                 for whichever agent(s) are installed)
 *
 * Forked from granted's scaffold/scripts/setup-local.mjs (same author, MIT).
 * The detection, daemon-launch and parser logic is carried over unchanged; what
 * differs is what we install on top:
 *   1. Detects OS + memory/GPU and turns it into a USABLE budget (an agent needs
 *      headroom for a 32K context plus the OpenClaw gateway itself).
 *   2. Ensures Ollama is installed (winget / Homebrew 14+ / official Linux script)
 *      and its daemon is reachable.
 *   3. Picks a TOOL-CAPABLE model — OpenClaw only discovers Ollama models that
 *      report tool support — or reuses an existing one that does.
 *   4. Asks which agent to install — OpenClaw, Hermes Agent, or both — and
 *      installs it with its official installer, skipping its own wizard.
 *   5. Points the chosen agent(s) at Ollama with the chosen model.
 *
 * The pure logic is exported and unit-tested in scripts/__tests__/; none of the
 * tests need a TTY, a live Ollama, or OpenClaw.
 */
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join, win32 } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { runFreeCloud, recommendMode, writeLauncher, openUrlCommand } from "./free-cloud.mjs";
import { installFamilyHistorySkill, installFamilyHistorySoul } from "./family-skill.mjs";
import { setupFamilySearch } from "./familysearch.mjs";
import { setupFamilyFinder } from "./familyfinder.mjs";

const OLLAMA_API = "http://localhost:11434/api";
const OPENCLAW_INSTALL_SH = "https://openclaw.ai/install.sh";
const OPENCLAW_INSTALL_PS1 = "https://openclaw.ai/install.ps1";
const HERMES_INSTALL_SH = "https://hermes-agent.nousresearch.com/install.sh";
const HERMES_INSTALL_PS1 = "https://hermes-agent.nousresearch.com/install.ps1";
const OLLAMA_OPENAI_URL = "http://localhost:11434/v1";
/** Context OpenClaw asks for per request. */
export const AGENT_CONTEXT = 32768;
/** Hermes refuses local models with less than 64K context, so its model copy is built with this. */
export const HERMES_CONTEXT = 65536;

// ---------------------------------------------------------------------------
// PURE LOGIC (exported + unit-tested — no I/O, no child processes)
// ---------------------------------------------------------------------------

/** Lowest macOS major Ollama's .app and Homebrew formula support. Keep in sync with install-macos.sh. */
export const OLLAMA_MIN_MACOS = 14;

/** Lowest Node OpenClaw supports (24.16+). Keep in sync with the install-* scripts. */
export const NODE_MIN = { major: 24, minor: 16 };

/** `sw_vers -productVersion` → major, or null when unparseable. */
export function parseMacosMajor(text) {
  const m = String(text ?? "").trim().match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "v24.16.1" → true if it meets NODE_MIN (any higher major also passes). */
export function nodeVersionOk(version, min = NODE_MIN) {
  const m = String(version ?? "").trim().match(/^v?(\d+)\.(\d+)/);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min.major || (major === min.major && minor >= min.minor);
}

/**
 * Usable memory (GB) → model. Every tag here supports tools (required by both
 * agents) and image input (useful for scanned records). `needGB` is the usable
 * budget to run it with a 32K context, not the download size.
 *
 * `gpuOnly`: dense models that are painfully slow on a CPU alone. The 35b and
 * 122b are mixture-of-experts — only a few billion parameters are active per
 * token — so a big-RAM CPU-only box can still run the 35b at a usable speed.
 */
export const MODEL_TIERS = [
  { needGB: 90, model: "qwen3.5:122b", downloadGB: 81, gpuOnly: true, note: "Best local quality; 96GB of VRAM or a 192GB Mac." },
  { needGB: 30, model: "qwen3.5:35b", downloadGB: 24, note: "Excellent; mixture-of-experts, so it's quick for its size." },
  { needGB: 22, model: "qwen3.5:27b", downloadGB: 17, gpuOnly: true, note: "Strong local agent; needs a 24GB GPU or a 36GB+ Mac." },
  { needGB: 10, model: "qwen3.5:9b", downloadGB: 6.6, note: "Good everyday agent for 16GB machines / 12GB GPUs." },
  { needGB: 6, model: "qwen3.5:4b", downloadGB: 3.4, note: "Workable; expect some missteps on long tasks." },
  { needGB: 4, model: "qwen3.5:2b", downloadGB: 2.7, note: "Light tasks only; multi-step tool use is unreliable." },
  { needGB: 0, model: "qwen3.5:0.8b", downloadGB: 1.0, note: "Too small to be a dependable agent.", tooSmall: true },
];

/**
 * Turn raw detection into the budget a model can actually use.
 *   nvidia → the GPU's VRAM (system RAM still holds OpenClaw).
 *   apple  → 65% of unified memory (macOS caps GPU-wired memory below total).
 *   cpu    → RAM minus 4GB for the OS, the browser, and the OpenClaw gateway.
 */
export function usableGB({ gb, kind }) {
  if (!Number.isFinite(gb) || gb <= 0) return NaN;
  if (kind === "nvidia") return Math.floor(gb);
  if (kind === "apple") return Math.floor(gb * 0.65);
  return Math.max(0, Math.floor(gb - 4));
}

/**
 * Pick the first tier the budget clears. CPU-only machines skip dense GPU-only
 * tiers. Unknown/invalid → smallest (never over-recommend).
 */
export function recommendModel(budgetGB, kind = "gpu") {
  const smallest = MODEL_TIERS[MODEL_TIERS.length - 1];
  if (!Number.isFinite(budgetGB) || budgetGB < 0) return smallest;
  return MODEL_TIERS.find((t) => budgetGB >= t.needGB && !(kind === "cpu" && t.gpuOnly)) ?? smallest;
}

/** Coerce to number; null/blank → NaN (Number("") is 0). */
function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  return Number(v);
}
export function bytesToGB(bytes) {
  const n = toNum(bytes);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n / 1024 ** 3) : NaN;
}
export function kbToGB(kb) {
  const n = toNum(kb);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n / (1024 * 1024)) : NaN;
}
export function mibToGB(mib) {
  const n = toNum(mib);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n / 1024) : NaN;
}
export function parseSysctlMemsize(stdout) {
  return bytesToGB(String(stdout ?? "").trim());
}
/** nvidia-smi memory.total (MiB per line) → largest GPU in GB, or NaN. */
export function parseNvidiaSmi(stdout) {
  const gbs = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(mibToGB)
    .filter(Number.isFinite);
  return gbs.length ? Math.max(...gbs) : NaN;
}
/** nvidia-smi memory.total → { totalGB, count }. Ollama splits a model across cards, so VRAM adds up. */
export function parseNvidiaSmiTotal(stdout) {
  const gbs = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(mibToGB)
    .filter(Number.isFinite);
  return { totalGB: gbs.reduce((a, b) => a + b, 0), count: gbs.length };
}
export function parseProcMeminfo(text) {
  const m = String(text ?? "").match(/^MemTotal:\s+(\d+)\s*kB/im);
  return m ? kbToGB(m[1]) : NaN;
}
/** `df -Pk <dir>` → free GB on that filesystem, or NaN. */
export function parseDfFreeGB(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/)[1];
  const avail = line?.trim().split(/\s+/)[3];
  return kbToGB(avail);
}
export function parseWinBytes(stdout) {
  const nums = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(bytesToGB)
    .filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : NaN;
}
export function parseOllamaList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^NAME\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

/** Ollama `/api/show` JSON → true if the model advertises tool calling. */
export function hasToolSupport(showJson) {
  const caps = showJson?.capabilities;
  return Array.isArray(caps) && caps.includes("tools");
}

/** True on a Chromebook's Linux container (Crostini). */
export function isChromeOSContainer(existsFn) {
  return existsFn("/opt/google/cros-containers");
}

/**
 * Automatic Ollama install for this platform, or null → manual guidance.
 * Linux uses Ollama's official script (it installs a systemd service).
 */
export function pickAutoInstallCommand(platform, { hasWinget = false, hasBrew = false, macosMajor = null, hasCurl = false } = {}) {
  if (platform === "win32" && hasWinget) {
    return {
      cmd: "winget",
      args: ["install", "-e", "--id", "Ollama.Ollama", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      label: "winget install -e --id Ollama.Ollama",
    };
  }
  const macTooOld = macosMajor !== null && macosMajor < OLLAMA_MIN_MACOS;
  if (platform === "darwin" && hasBrew && !macTooOld) {
    return { cmd: "brew", args: ["install", "ollama"], label: "brew install ollama" };
  }
  if (platform === "linux" && hasCurl) {
    // Downloaded first, then run from a file — never piped, so nothing it
    // spawns can steal bytes from a script arriving on stdin (see granted #255).
    return { cmd: "sh", args: ["-c", "curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh && sh /tmp/ollama-install.sh"], label: "Ollama's official Linux installer" };
  }
  return null;
}

/** Command that installs OpenClaw without starting its onboarding wizard. */
export function pickOpenClawInstall(platform, scriptPath) {
  if (platform === "win32") {
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ([scriptblock]::Create((iwr -useb ${OPENCLAW_INSTALL_PS1}))) -NoOnboard`],
      label: "OpenClaw's official Windows installer (-NoOnboard)",
    };
  }
  return { cmd: "bash", args: [scriptPath, "--no-onboard"], label: "OpenClaw's official installer (--no-onboard)" };
}

/** The `openclaw` commands that wire it to local Ollama with `model` as the default. */
export function openclawConfigCommands(model) {
  return [
    ["config", "set", "models.providers.ollama.apiKey", "ollama-local"],
    ["models", "set", `ollama/${model}`],
  ];
}

/**
 * `config set models.providers.ollama.apiKey` above writes to OpenClaw's global
 * config, but OpenClaw actually reads provider credentials from a separate
 * per-agent auth store that only `models auth paste-api-key` populates — without
 * this, OpenClaw fails at chat time with `No API key found for provider "ollama"`
 * even though config/model selection both succeeded. Ollama needs no real key,
 * so the same placeholder value already used above is piped in on stdin (this
 * subcommand takes no --key/--value flag; confirmed via --help and a real run).
 */
export function openclawOllamaAuthCommand() {
  return { cmd: "openclaw", args: ["models", "auth", "paste-api-key", "--provider", "ollama"], input: "ollama-local\n" };
}

/** How the AI runs: on this computer, or on free online services through FCC. */
export const MODES = {
  local: {
    title: "On this computer",
    lines: ["Private: nothing you type leaves your computer.", "Needs a reasonably powerful computer; works offline."],
  },
  cloud: {
    title: "Free online services",
    lines: [
      "Works on any computer, even a small Chromebook. Needs internet.",
      "You'll make a few free accounts; this setup opens each page and walks you through it.",
      "What you type is sent to those companies (fine for ancestors who have passed away).",
    ],
  },
};
export function parseModeChoice(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "1" || v === "local") return "local";
  if (v === "2" || v === "cloud" || v === "online" || v === "free") return "cloud";
  return null;
}

/**
 * The two agents, as shown in the picker. Both run natively on Windows, macOS,
 * Linux and a Chromebook's Linux container; they differ in purpose.
 */
export const AGENTS = {
  openclaw: {
    name: "OpenClaw",
    purpose: "Reach it from anywhere",
    blurb: [
      "Chat with it from WhatsApp, Telegram, Signal, Slack, Discord and more.",
      "Skills are files you install and review, so it behaves predictably.",
      "Run by a nonprofit foundation; no paid tiers.",
    ],
    os: { win32: "native", darwin: "native", linux: "native" },
  },
  hermes: {
    name: "Hermes Agent",
    purpose: "Long research projects",
    blurb: [
      "Remembers across sessions and writes its own skills as it works.",
      "Gets more useful the longer you research the same family.",
      "Made by Nous Research; free and open source, with optional paid services.",
      "The one used by free online mode (it connects through Free Claude Code).",
    ],
    os: { win32: "native (newer)", darwin: "native", linux: "native" },
  },
};
export const AGENT_CHOICES = ["openclaw", "hermes", "both"];

/** "--agent hermes" / picker answer → ["hermes"]; anything unknown → null. */
export function parseAgentChoice(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "1" || v === "openclaw") return ["openclaw"];
  if (v === "2" || v === "hermes" || v === "hermes-agent") return ["hermes"];
  if (v === "3" || v === "both") return ["openclaw", "hermes"];
  return null;
}

/** Command that installs Hermes Agent without starting its setup wizard. */
export function pickHermesInstall(platform, scriptPath) {
  if (platform === "win32") {
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ([scriptblock]::Create((irm ${HERMES_INSTALL_PS1}))) -NonInteractive`],
      label: "Hermes Agent's official Windows installer (-NonInteractive)",
    };
  }
  return { cmd: "bash", args: [scriptPath, "--skip-setup"], label: "Hermes Agent's official installer (--skip-setup)" };
}

/**
 * Hermes talks to Ollama through its OpenAI-compatible endpoint, where Ollama
 * falls back to a small default context, and Hermes rejects anything under 64K.
 * So we build a local copy with the context baked in: "qwen3.5:9b" → "qwen3.5:9b-ctx64k".
 */
export function contextModelName(model, ctx = HERMES_CONTEXT) {
  return `${model}-ctx${Math.round(ctx / 1024)}k`;
}
export function contextModelfile(model, ctx = HERMES_CONTEXT) {
  return `FROM ${model}\nPARAMETER num_ctx ${ctx}\n`;
}

/** The `hermes` commands that point it at local Ollama with `model` as the default. */
export function hermesConfigCommands(model) {
  return [
    ["config", "set", "model.provider", "custom"],
    ["config", "set", "model.base_url", OLLAMA_OPENAI_URL],
    ["config", "set", "model.default", model],
    ["config", "set", "model.context_length", String(HERMES_CONTEXT)],
  ];
}

/** Where the agents' installers put their commands, so we can find them before a new shell. */
export function agentBinDirs(platform, { home = "", localAppData = "" } = {}) {
  if (platform === "win32") {
    return [localAppData && win32.join(localAppData, "hermes", "bin"), home && win32.join(home, ".local", "bin")].filter(Boolean);
  }
  return home ? [join(home, ".local", "bin"), join(home, ".openclaw", "bin")] : [];
}

export function ollamaWindowsDir(localAppData) {
  return win32.join(String(localAppData ?? ""), "Programs", "Ollama");
}

export function withOllamaOnPath(env, platform, localAppData) {
  if (platform !== "win32" || !localAppData) return env;
  const dir = ollamaWindowsDir(localAppData);
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const existing = env[key] || "";
  if (existing.split(";").includes(dir)) return env;
  return { ...env, [key]: existing ? `${existing};${dir}` : dir };
}

export async function waitForDaemon(fetchTags, { timeoutMs = 120000, intervalMs = 2000, sleepFn } = {}) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (;;) {
    if (await fetchTags()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

export function installGuidance(platform, macosMajor = null) {
  if (platform === "darwin") {
    if (macosMajor !== null && macosMajor < OLLAMA_MIN_MACOS) {
      return [
        `  Your macOS (${macosMajor}) is older than Ollama's app requires (${OLLAMA_MIN_MACOS}+). Use the CLI build:`,
        "    curl -fsSL -o ollama-darwin.tgz https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz",
        "    mkdir -p ~/.local/ollama && tar xzf ollama-darwin.tgz -C ~/.local/ollama",
        "    ln -sf ~/.local/ollama/ollama /usr/local/bin/ollama",
        "  Then start it with `ollama serve` (again after each reboot).",
      ].join("\n");
    }
    return "  Install Ollama from https://ollama.com/download (or: brew install ollama), then open the app.";
  }
  if (platform === "win32") return "  Install Ollama from https://ollama.com/download, then launch the Ollama app.";
  return "  Install Ollama:  curl -fsSL https://ollama.com/install.sh | sh\n  Then start it:   ollama serve";
}

export function launchOllamaDaemon(platform, opts = {}) {
  const { localAppData = "", env, spawnFn = spawn } = opts;
  const child =
    platform === "win32"
      ? spawnFn("cmd", ["/c", "start", "", join(ollamaWindowsDir(localAppData), "ollama app.exe")], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
          env,
        })
      : spawnFn("ollama", ["serve"], { detached: true, stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const heading = (s) => console.log(`\n${c.b(s)}`);

const ARGS = process.argv.slice(2);
const YES = ARGS.includes("--yes") || ARGS.includes("-y");
const DRY = ARGS.includes("--dry-run");
const argValue = (flag) => {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : null;
};
const FORCED_MODEL = argValue("--model");
const FORCED_AGENT = argValue("--agent");
const FORCED_MODE = argValue("--mode");
const FAMILYSEARCH_SETUP = ARGS.includes("--familysearch-setup");
const FAMILYFINDER_SETUP = ARGS.includes("--familyfinder-setup");

function ask(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}
async function confirm(query, dflt = true) {
  if (YES || DRY) return dflt;
  const a = (await ask(`  ${query} ${c.dim(dflt ? "[Y/n]" : "[y/N]")} `)).toLowerCase();
  return a === "" ? dflt : a === "y" || a === "yes";
}
function childEnv() {
  const env = withOllamaOnPath(process.env, process.platform, process.env.LOCALAPPDATA);
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const have = (env[key] || "").split(sep);
  const extra = agentBinDirs(process.platform, { home: process.env.HOME || process.env.USERPROFILE, localAppData: process.env.LOCALAPPDATA }).filter((d) => !have.includes(d));
  return extra.length ? { ...env, [key]: [env[key], ...extra].filter(Boolean).join(sep) } : env;
}
function run(cmd, args, timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: childEnv(), shell: process.platform === "win32" });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  } catch {
    return null;
  }
}
function runInherit(cmd, args) {
  if (DRY) {
    console.log(c.dim(`    [dry-run] ${cmd} ${args.join(" ")}`));
    return true;
  }
  try {
    return spawnSync(cmd, args, { stdio: "inherit", env: childEnv(), shell: process.platform === "win32" }).status === 0;
  } catch {
    return false;
  }
}
/** Like runInherit, but feeds `input` on stdin instead of inheriting the terminal's (for prompts that only read stdin, e.g. OpenClaw's paste-api-key). */
function runWithInput(cmd, args, input) {
  if (DRY) {
    console.log(c.dim(`    [dry-run] ${cmd} ${args.join(" ")} <<< (piped input)`));
    return true;
  }
  try {
    return spawnSync(cmd, args, { input, encoding: "utf8", env: childEnv(), shell: process.platform === "win32" }).status === 0;
  } catch {
    return false;
  }
}
async function ollamaUp() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${OLLAMA_API}/tags`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
async function ollamaShow(model) {
  try {
    const res = await fetch(`${OLLAMA_API}/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Raw memory + what kind it is, so usableGB() can apply the right headroom. */
function detectMemory() {
  const p = process.platform;
  const smi = run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
  const { totalGB, count } = parseNvidiaSmiTotal(smi);
  if (p !== "darwin" && totalGB > 0) {
    const source = count > 1 ? `${count} NVIDIA GPUs, VRAM combined (nvidia-smi)` : "NVIDIA GPU VRAM (nvidia-smi)";
    return { gb: totalGB, kind: "nvidia", source };
  }
  if (p === "darwin") {
    const gb = parseSysctlMemsize(run("sysctl", ["-n", "hw.memsize"]));
    const apple = (run("uname", ["-m"]) || "").trim() === "arm64";
    return { gb, kind: apple ? "apple" : "cpu", source: apple ? "Apple Silicon unified memory" : "system RAM (Intel Mac)" };
  }
  if (p === "linux") {
    try {
      return { gb: parseProcMeminfo(readFileSync("/proc/meminfo", "utf8")), kind: "cpu", source: "system RAM (/proc/meminfo)" };
    } catch {
      return { gb: NaN, kind: "cpu", source: "unknown" };
    }
  }
  if (p === "win32") {
    const out = run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"]);
    return { gb: parseWinBytes(out), kind: "cpu", source: "system RAM (Win32_ComputerSystem)" };
  }
  return { gb: NaN, kind: "cpu", source: `unsupported platform ${p}` };
}

function freeDiskGB() {
  if (process.platform === "win32") {
    const drive = (process.env.USERPROFILE || "C").slice(0, 1);
    return parseWinBytes(run("powershell", ["-NoProfile", "-Command", `(Get-PSDrive ${drive}).Free`]));
  }
  return parseDfFreeGB(run("df", ["-Pk", process.env.HOME || "/"]));
}

async function tryAutoInstallOllama(platform, macosMajor) {
  const choice = pickAutoInstallCommand(platform, {
    hasWinget: platform === "win32" && Boolean(run("winget", ["--version"])),
    hasBrew: platform === "darwin" && Boolean(run("brew", ["--version"])),
    hasCurl: platform === "linux" && Boolean(run("curl", ["--version"])),
    macosMajor,
  });
  if (!choice) return false;
  if (!(await confirm(`Install Ollama now (${choice.label})?`, true))) return false;
  if (!runInherit(choice.cmd, choice.args)) {
    console.log(c.y("  Automatic install failed."));
    return false;
  }
  console.log(`  ${c.g("✓")} Ollama installed`);
  return true;
}

async function ensureDaemon(platform) {
  if (DRY || (await ollamaUp())) return true;
  try {
    launchOllamaDaemon(platform, { localAppData: process.env.LOCALAPPDATA || "", env: childEnv() });
  } catch {
    /* best effort */
  }
  console.log(c.dim("  Waiting for the Ollama daemon (first start can take over a minute)…"));
  return waitForDaemon(ollamaUp);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log(c.b("\nAutomatedAncestry — guided setup\n") + c.dim("Ollama + a model sized for this computer + OpenClaw and/or Hermes Agent, wired together.\n"));
  if (DRY) console.log(c.y("  Dry run: nothing will be installed or changed.\n"));
  const platform = process.platform;
  if (platform !== "win32" && process.getuid?.() === 0) {
    console.log(c.r("  Please run this as your normal user, not root — OpenClaw should never run as root."));
    process.exit(1);
  }

  if (FAMILYSEARCH_SETUP) {
    await setupFamilySearch({ c, heading, ask, confirm, run, openUrlCommand, platform, home: homedir() });
    process.exit(0);
  }

  if (FAMILYFINDER_SETUP) {
    const agentIds = ["hermes", "openclaw"].filter((bin) => run(bin, ["--version"], 15000));
    if (!agentIds.length) {
      console.log(c.r("  Neither Hermes nor OpenClaw is installed yet. Run this setup first, then retry."));
      process.exit(1);
    }
    await setupFamilyFinder({ c, heading, ask, confirm, runInherit, runWithInput, agentIds, home: homedir() });
    process.exit(0);
  }

  // 1) Hardware → budget → model.
  heading("Your computer");
  const macosMajor = platform === "darwin" ? parseMacosMajor(run("sw_vers", ["-productVersion"])) : null;
  const { existsSync } = await import("node:fs");
  const chromebook = platform === "linux" && isChromeOSContainer(existsSync);
  const mem = detectMemory();
  const budget = usableGB(mem);
  const disk = freeDiskGB();
  console.log(`  ${c.dim("System:")}  ${chromebook ? "ChromeOS (Linux container)" : platform}${macosMajor ? ` — macOS ${macosMajor}` : ""}`);
  console.log(`  ${c.dim("Memory:")}  ${Number.isFinite(mem.gb) ? `${mem.gb} GB` : "unknown"} ${c.dim(`— ${mem.source}`)}`);
  console.log(`  ${c.dim("Usable for a model:")} ${Number.isFinite(budget) ? `${budget} GB` : "unknown"}`);
  if (Number.isFinite(disk)) console.log(`  ${c.dim("Free disk:")} ${disk} GB`);
  if (chromebook) console.log(c.dim("  (Chromebooks give Linux only part of their RAM, so the budget is tight.)"));

  const tier = recommendModel(budget, mem.kind === "cpu" ? "cpu" : "gpu");

  const mode = await chooseMode(tier);
  if (mode === "cloud") {
    await runFreeCloud({
      platform, DRY, YES, c, heading, ask, confirm, run, runInherit, childEnv,
      installHermes: () => {
        heading("Hermes Agent");
        return installAgent({ bin: "hermes", url: HERMES_INSTALL_SH, name: "hermes-install.sh", pick: pickHermesInstall, platform });
      },
    });
    return;
  }

  heading("Choose a model");
  let model = FORCED_MODEL || tier.model;
  if (FORCED_MODEL) {
    console.log(`  Using the model you asked for: ${c.b(model)}`);
  } else {
    console.log(`  ${c.b("Recommended:")} ${c.g(model)} ${c.dim(`(~${tier.downloadGB} GB) — ${tier.note}`)}`);
    if (tier.tooSmall) {
      console.log(c.y("\n  This machine is too small for a reliable local agent."));
      console.log(c.y("  You'll get much better results by running setup again and choosing free online services."));
      if (!(await confirm("Install the small local model anyway?", false))) model = null;
    } else if (!YES && !DRY) {
      model = (await ask(`  Model tag ${c.dim(`[Enter for ${model}]`)}: `)) || model;
    }
  }
  if (model && Number.isFinite(disk) && !FORCED_MODEL && disk < tier.downloadGB + 3) {
    console.log(c.r(`  Not enough disk: need ~${Math.ceil(tier.downloadGB + 3)} GB free, have ${disk} GB.`));
    process.exit(1);
  }

  // 2) Ollama.
  if (model) {
    heading("Ollama");
    let version = run("ollama", ["--version"]);
    if (!version && !DRY) {
      await tryAutoInstallOllama(platform, macosMajor);
      version = run("ollama", ["--version"]);
      if (!version) {
        console.log(installGuidance(platform, macosMajor) + c.dim("\n\n  Then re-run this setup."));
        process.exit(1);
      }
    }
    if (version) console.log(`  ${c.g("✓")} ${version.trim().split(/\r?\n/).pop()}`);
    if (!(await ensureDaemon(platform))) {
      console.log(c.y("  Ollama is installed but not answering on localhost:11434.\n") + installGuidance(platform, macosMajor));
      process.exit(1);
    }
    console.log(`  ${c.g("✓")} daemon reachable`);

    // Prefer an already-installed tool-capable model if the user wants one.
    const existing = parseOllamaList(run("ollama", ["list"]) ?? "").filter((m) => !/embed/i.test(m) && !/-ctx\d+k$/.test(m));
    const toolCapable = [];
    for (const m of existing) if (hasToolSupport(await ollamaShow(m))) toolCapable.push(m);
    if (!FORCED_MODEL && toolCapable.length && !toolCapable.includes(model)) {
      console.log(c.dim(`  Already installed and tool-capable: ${toolCapable.join(", ")}`));
      if (await confirm(`Use ${toolCapable[0]} instead of downloading ${model}?`, false)) model = toolCapable[0];
    }

    if (!toolCapable.includes(model)) {
      console.log(c.dim(`  Pulling ${model} … (first download can take a while)`));
      if (!runInherit("ollama", ["pull", model])) {
        console.log(c.r(`  Couldn't pull "${model}". Check the tag at https://ollama.com/library and re-run.`));
        process.exit(1);
      }
      if (!DRY && !hasToolSupport(await ollamaShow(model))) {
        console.log(c.y(`  ! ${model} doesn't report tool support — the agent won't be able to use tools with it.`));
      }
    }
    console.log(`  ${c.g("✓")} model ready: ${c.b(model)}`);
  }

  // 3) Which agent(s)?
  const agents = await chooseAgents(platform);

  // 4) Install + connect each one.
  for (const id of agents) {
    if (id === "openclaw") await setupOpenClaw(platform, model);
    if (id === "hermes") await setupHermes(platform, model);
  }

  if (!DRY && (await confirm("Install the Family History Researcher skill + persona (keeps a cited research log)?", true))) {
    for (const p of installFamilyHistorySkill(agents)) console.log(`  ${c.g("✓")} skill installed: ${p}`);
    const soulWritten = installFamilyHistorySoul(agents, { createHermesProfile: (cmd) => runInherit(cmd.cmd, cmd.args) });
    for (const p of soulWritten) console.log(`  ${c.g("✓")} persona installed: ${p}`);
  }

  heading("Done");
  const names = agents.map((a) => AGENTS[a].name).join(" and ");
  if (model) console.log(`  ${names} ${agents.length > 1 ? "are" : "is"} using ${c.b(model)}, running privately on this computer.`);
  if (agents.includes("openclaw")) {
    console.log(`  ${c.dim("OpenClaw — chat:")}           ${c.g("openclaw tui")}`);
    console.log(`  ${c.dim("OpenClaw — phone apps:")}     ${c.g("openclaw onboard")}`);
  }
  if (agents.includes("hermes")) {
    console.log(`  ${c.dim("Hermes — chat:")}             ${c.g("hermes")}`);
    console.log(`  ${c.dim("Hermes — phone apps:")}       ${c.g("hermes gateway setup")}`);
  }
  if (!model) console.log(c.y("  No local model installed — run this setup again and choose free online services."));
  if (!DRY) {
    try {
      const where = writeLauncher(platform, { mode: "local", agent: agents[0] });
      console.log(`  ${c.dim("Shortcut:")}                  ${c.b("Family History Assistant")} ${c.dim(`(${where})`)}`);
    } catch {
      /* the shortcut is a convenience */
    }
  }
  if (platform === "win32" || agents.includes("hermes")) {
    console.log(c.dim("  If a command isn't found, open a new terminal window first."));
  }
  console.log("");
  process.exit(0);
}

async function chooseMode(tier) {
  heading("How should the AI run?");
  if (FORCED_MODE) {
    const m = parseModeChoice(FORCED_MODE);
    if (!m) {
      console.log(c.r(`  Unknown --mode "${FORCED_MODE}". Use local or cloud.`));
      process.exit(1);
    }
    console.log(`  Using: ${MODES[m].title}`);
    return m;
  }
  const suggested = recommendMode(tier);
  Object.entries(MODES).forEach(([key, m], i) => {
    const tag = key === suggested ? c.g("  ← suggested for this computer") : "";
    console.log(`\n  ${c.b(`${i + 1}. ${m.title}`)}${tag}`);
    for (const line of m.lines) console.log(c.dim(`     • ${line}`));
  });
  if (YES || DRY) {
    console.log(c.dim(`\n  Non-interactive: using "${MODES[suggested].title}" (pass --mode local or --mode cloud to change).`));
    return suggested;
  }
  const dflt = suggested === "cloud" ? "2" : "1";
  for (;;) {
    const m = parseModeChoice((await ask(`\n  Which one? ${c.dim(`[1-2, Enter for ${dflt}]`)} `)) || dflt);
    if (m) return m;
    console.log(c.y("  Please type 1 or 2."));
  }
}

async function chooseAgents(platform) {
  heading("Choose your agent");
  if (FORCED_AGENT) {
    const picked = parseAgentChoice(FORCED_AGENT);
    if (!picked) {
      console.log(c.r(`  Unknown --agent "${FORCED_AGENT}". Use one of: ${AGENT_CHOICES.join(", ")}.`));
      process.exit(1);
    }
    console.log(`  Using: ${picked.map((a) => AGENTS[a].name).join(" + ")}`);
    return picked;
  }
  const osKey = platform === "win32" || platform === "darwin" ? platform : "linux";
  Object.values(AGENTS).forEach((a, i) => {
    console.log(`\n  ${c.b(`${i + 1}. ${a.name}`)} — ${a.purpose} ${c.dim(`(this computer: ${a.os[osKey]})`)}`);
    for (const line of a.blurb) console.log(c.dim(`     • ${line}`));
  });
  console.log(`\n  ${c.b("3. Both")} ${c.dim("— they share the same downloaded model, so it costs little extra disk.")}`);
  if (YES || DRY) {
    console.log(c.dim("\n  Non-interactive: defaulting to OpenClaw (pass --agent hermes or --agent both to change)."));
    return ["openclaw"];
  }
  for (;;) {
    const picked = parseAgentChoice(await ask(`\n  Which one? ${c.dim("[1-3, Enter for 1]")} `) || "1");
    if (picked) return picked;
    console.log(c.y("  Please type 1, 2 or 3."));
  }
}

async function downloadScript(url, name) {
  const path = join(mkdtempSync(join(tmpdir(), "aa-")), name);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(c.r(`  Couldn't download ${url} (HTTP ${res.status}).`));
    process.exit(1);
  }
  writeFileSync(path, await res.text(), { mode: 0o755 });
  return path;
}

async function installAgent({ bin, url, name, pick, platform }) {
  if (run(bin, ["--version"], 15000)) {
    console.log(`  ${c.g("✓")} already installed`);
    return;
  }
  // Download to a file, then run it — not curl|bash (see granted #255).
  const scriptPath = platform !== "win32" && !DRY ? await downloadScript(url, name) : `<downloaded ${name}>`;
  const inst = pick(platform, scriptPath);
  console.log(c.dim(`  Running ${inst.label}`));
  if (!runInherit(inst.cmd, inst.args)) {
    console.log(c.r("  Install failed — see the output above."));
    process.exit(1);
  }
  if (!DRY && !run(bin, ["--version"], 15000)) {
    console.log(c.y(`  Installed, but \`${bin}\` isn't on PATH in this window yet. Open a new terminal and re-run this setup to finish.`));
    process.exit(1);
  }
  console.log(`  ${c.g("✓")} installed`);
}

async function setupOpenClaw(platform, model) {
  heading("OpenClaw");
  await installAgent({ bin: "openclaw", url: OPENCLAW_INSTALL_SH, name: "openclaw-install.sh", pick: pickOpenClawInstall, platform });
  if (!model) return;
  for (const args of openclawConfigCommands(model)) {
    if (!runInherit("openclaw", args)) {
      console.log(c.r(`  \`openclaw ${args.join(" ")}\` failed. Run \`openclaw onboard\` and pick Ollama → Local only.`));
      process.exit(1);
    }
  }
  const auth = openclawOllamaAuthCommand();
  if (!runWithInput(auth.cmd, auth.args, auth.input)) {
    console.log(c.r(`  \`openclaw ${auth.args.join(" ")}\` failed. Run it yourself (any value works for Ollama) or chat will fail with "No API key found".`));
    process.exit(1);
  }
  console.log(`  ${c.g("✓")} connected to Ollama — default model ollama/${model}`);
  if (await confirm("Install OpenClaw's background service so it starts with your computer?", true)) {
    runInherit("openclaw", ["gateway", "install"]) || console.log(c.y("  Service install failed; retry later with `openclaw gateway install`."));
  }
}

async function setupHermes(platform, model) {
  heading("Hermes Agent");
  await installAgent({ bin: "hermes", url: HERMES_INSTALL_SH, name: "hermes-install.sh", pick: pickHermesInstall, platform });
  if (!model) return;
  const ctxModel = contextModelName(model);
  console.log(c.dim(`  Building ${ctxModel} (same weights, ${HERMES_CONTEXT / 1024}K context — Hermes needs at least 64K; no extra download)`));
  let modelfile = "<Modelfile>";
  if (!DRY) {
    modelfile = join(mkdtempSync(join(tmpdir(), "aa-")), "Modelfile");
    writeFileSync(modelfile, contextModelfile(model));
  }
  if (!runInherit("ollama", ["create", ctxModel, "-f", modelfile])) {
    console.log(c.r(`  Couldn't create ${ctxModel}. Hermes would get a too-small context, so stopping here.`));
    process.exit(1);
  }
  for (const args of hermesConfigCommands(ctxModel)) {
    if (!runInherit("hermes", args)) {
      console.log(c.r(`  \`hermes ${args.join(" ")}\` failed. Run \`hermes model\` → Custom endpoint → ${OLLAMA_OPENAI_URL}.`));
      process.exit(1);
    }
  }
  console.log(`  ${c.g("✓")} connected to Ollama — default model ${ctxModel}`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    console.error(c.r(`\nUnexpected error: ${err?.message || err}`));
    process.exit(1);
  });
}
