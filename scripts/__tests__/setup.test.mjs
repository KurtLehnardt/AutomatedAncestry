import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_TIERS, recommendModel, usableGB, nodeVersionOk, parseMacosMajor,
  bytesToGB, kbToGB, mibToGB, parseSysctlMemsize, parseNvidiaSmi, parseProcMeminfo,
  parseDfFreeGB, parseWinBytes, parseOllamaList, hasToolSupport, isChromeOSContainer,
  pickAutoInstallCommand, pickOpenClawInstall, openclawConfigCommands,
  ollamaWindowsDir, withOllamaOnPath, waitForDaemon, installGuidance, launchOllamaDaemon,
  OLLAMA_MIN_MACOS, parseNvidiaSmiTotal, AGENTS, AGENT_CHOICES, parseAgentChoice,
  pickHermesInstall, contextModelName, contextModelfile, hermesConfigCommands, agentBinDirs, HERMES_CONTEXT,
  MODES, parseModeChoice,
} from "../setup.mjs";

// Pure logic only: no TTY, no Ollama, no OpenClaw, no network.

describe("usableGB: raw memory → budget a model can use", () => {
  test("NVIDIA uses VRAM as-is", () => assert.equal(usableGB({ gb: 12, kind: "nvidia" }), 12));
  test("Apple Silicon keeps 35% headroom", () => assert.equal(usableGB({ gb: 16, kind: "apple" }), 10));
  test("CPU-only reserves 4GB for OS + gateway", () => assert.equal(usableGB({ gb: 16, kind: "cpu" }), 12));
  test("never negative", () => assert.equal(usableGB({ gb: 3, kind: "cpu" }), 0));
  test("unknown → NaN", () => assert.ok(Number.isNaN(usableGB({ gb: NaN, kind: "cpu" }))));
});

describe("recommendModel", () => {
  const gpu = [[128, "qwen3.5:122b"], [96, "qwen3.5:122b"], [90, "qwen3.5:122b"], [89, "qwen3.5:35b"], [30, "qwen3.5:35b"],
    [29, "qwen3.5:27b"], [22, "qwen3.5:27b"], [21, "qwen3.5:9b"], [10, "qwen3.5:9b"], [9, "qwen3.5:4b"], [6, "qwen3.5:4b"],
    [5, "qwen3.5:2b"], [4, "qwen3.5:2b"], [3, "qwen3.5:0.8b"], [0, "qwen3.5:0.8b"]];
  for (const [gb, model] of gpu) test(`GPU ${gb}GB → ${model}`, () => assert.equal(recommendModel(gb).model, model));
  test("CPU-only never gets a dense GPU-only model", () => {
    assert.equal(recommendModel(28, "cpu").model, "qwen3.5:9b"); // would be 27b on a GPU
    assert.equal(recommendModel(200, "cpu").model, "qwen3.5:35b"); // never the 122b
  });
  test("CPU-only can get the MoE 35b with enough RAM", () => assert.equal(recommendModel(60, "cpu").model, "qwen3.5:35b"));
  test("NaN never over-recommends", () => assert.equal(recommendModel(NaN).model, "qwen3.5:0.8b"));
  test("only the bottom tier is flagged too small", () =>
    assert.deepEqual(MODEL_TIERS.filter((t) => t.tooSmall).map((t) => t.model), ["qwen3.5:0.8b"]));
  test("tiers are ordered high → low", () => {
    for (let i = 1; i < MODEL_TIERS.length; i++) assert.ok(MODEL_TIERS[i - 1].needGB > MODEL_TIERS[i].needGB);
  });
  test("real machines", () => {
    const pick = (gb, kind) => recommendModel(usableGB({ gb, kind }), kind === "cpu" ? "cpu" : "gpu");
    assert.equal(pick(2, "cpu").tooSmall, true); // 4GB Chromebook
    assert.equal(pick(32, "cpu").model, "qwen3.5:9b"); // 32GB desktop, no GPU
    assert.equal(pick(64, "cpu").model, "qwen3.5:35b"); // 64GB desktop, no GPU
    assert.equal(pick(16, "apple").model, "qwen3.5:9b"); // 16GB M-series
    assert.equal(pick(96, "nvidia").model, "qwen3.5:122b"); // 96GB VRAM
    assert.equal(pick(24, "nvidia").model, "qwen3.5:27b"); // single 24GB card
  });
});

describe("parseNvidiaSmiTotal (multi-GPU)", () => {
  test("adds cards together", () => assert.deepEqual(parseNvidiaSmiTotal("24576\n24576\n24576\n24576\n"), { totalGB: 96, count: 4 }));
  test("single card", () => assert.deepEqual(parseNvidiaSmiTotal("12288\n"), { totalGB: 12, count: 1 }));
  test("no GPU", () => assert.deepEqual(parseNvidiaSmiTotal(""), { totalGB: 0, count: 0 }));
});

describe("agent picker", () => {
  test("both agents run natively on every OS", () => {
    for (const a of Object.values(AGENTS)) for (const os of ["win32", "darwin", "linux"]) assert.match(a.os[os], /^native/);
  });
  test("each agent states a purpose and reasons", () => {
    for (const a of Object.values(AGENTS)) {
      assert.ok(a.purpose.length > 0);
      assert.ok(a.blurb.length >= 2);
    }
  });
  const cases = [["1", ["openclaw"]], ["openclaw", ["openclaw"]], ["2", ["hermes"]], [" Hermes ", ["hermes"]],
    ["hermes-agent", ["hermes"]], ["3", ["openclaw", "hermes"]], ["both", ["openclaw", "hermes"]], ["4", null], ["", null]];
  for (const [input, want] of cases) test(`"${input}" → ${JSON.stringify(want)}`, () => assert.deepEqual(parseAgentChoice(input), want));
  test("every advertised choice parses", () => { for (const c of AGENT_CHOICES) assert.ok(parseAgentChoice(c)); });
});

describe("Hermes install + config", () => {
  test("unix installer runs from a file and skips its wizard", () =>
    assert.deepEqual(pickHermesInstall("linux", "/tmp/h.sh").args, ["/tmp/h.sh", "--skip-setup"]));
  test("windows installer is non-interactive", () => assert.match(pickHermesInstall("win32").args.at(-1), /-NonInteractive$/));
  test("Hermes gets at least the 64K it requires", () => assert.ok(HERMES_CONTEXT >= 64000));
  test("context copy naming", () => assert.equal(contextModelName("qwen3.5:9b"), "qwen3.5:9b-ctx64k"));
  test("Modelfile bakes in the Hermes context", () =>
    assert.equal(contextModelfile("qwen3.5:9b"), "FROM qwen3.5:9b\nPARAMETER num_ctx 65536\n"));
  test("points Hermes at Ollama's OpenAI-compatible endpoint", () =>
    assert.deepEqual(hermesConfigCommands("qwen3.5:9b-ctx64k"), [
      ["config", "set", "model.provider", "custom"],
      ["config", "set", "model.base_url", "http://localhost:11434/v1"],
      ["config", "set", "model.default", "qwen3.5:9b-ctx64k"],
      ["config", "set", "model.context_length", "65536"],
    ]));
  test("finds agent commands before a new shell", () => {
    assert.deepEqual(agentBinDirs("win32", { localAppData: "C:\\L", home: "C:\\U" }), ["C:\\L\\hermes\\bin", "C:\\U\\.local\\bin"]);
    assert.deepEqual(agentBinDirs("linux", { home: "/home/k" }), ["/home/k/.local/bin", "/home/k/.openclaw/bin"]);
  });
});

describe("nodeVersionOk (OpenClaw needs 24.16+)", () => {
  for (const [v, ok] of [["v22.22.2", false], ["v24.15.9", false], ["v24.16.0", true], ["24.20.1", true], ["v26.1.0", true], ["garbage", false], ["", false]])
    test(`${v || "(empty)"} → ${ok}`, () => assert.equal(nodeVersionOk(v), ok));
});

describe("parsers", () => {
  test("parseMacosMajor", () => {
    assert.equal(parseMacosMajor("12.7.6"), 12);
    assert.equal(parseMacosMajor("26.4\n"), 26);
    assert.equal(parseMacosMajor(""), null);
  });
  test("unit conversions", () => {
    assert.equal(bytesToGB(17179869184), 16);
    assert.equal(kbToGB(16384000), 15);
    assert.equal(mibToGB(24576), 24);
    assert.ok(Number.isNaN(bytesToGB("")));
  });
  test("sysctl / meminfo", () => {
    assert.equal(parseSysctlMemsize("34359738368\n"), 32);
    assert.equal(parseProcMeminfo("MemTotal:        3936288 kB\nMemFree: 1 kB"), 3);
  });
  test("nvidia-smi picks the largest GPU", () => assert.equal(parseNvidiaSmi("8192\n24576\n"), 24));
  test("nvidia-smi empty → NaN", () => assert.ok(Number.isNaN(parseNvidiaSmi(""))));
  test("df -Pk", () => assert.equal(parseDfFreeGB("Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 100 50 52428800 50% /\n"), 50));
  test("windows bytes ignore noise", () => assert.equal(parseWinBytes("junk\r\n17179869184\r\n"), 16));
  test("ollama list", () =>
    assert.deepEqual(parseOllamaList("NAME  ID  SIZE\nqwen3.5:4b  abc  3.4 GB\nnomic-embed-text:latest x 1 GB\n"), ["qwen3.5:4b", "nomic-embed-text:latest"]));
});

describe("hasToolSupport", () => {
  test("true when capabilities includes tools", () => assert.equal(hasToolSupport({ capabilities: ["completion", "tools", "vision"] }), true));
  test("false without tools", () => assert.equal(hasToolSupport({ capabilities: ["completion"] }), false));
  test("false on null / missing", () => {
    assert.equal(hasToolSupport(null), false);
    assert.equal(hasToolSupport({}), false);
  });
});

test("isChromeOSContainer", () => {
  assert.equal(isChromeOSContainer((p) => p === "/opt/google/cros-containers"), true);
  assert.equal(isChromeOSContainer(() => false), false);
});

describe("pickAutoInstallCommand", () => {
  test("winget on Windows", () => assert.equal(pickAutoInstallCommand("win32", { hasWinget: true }).cmd, "winget"));
  test("brew on macOS 14+", () => assert.equal(pickAutoInstallCommand("darwin", { hasBrew: true, macosMajor: 15 }).cmd, "brew"));
  test(`not brew below macOS ${OLLAMA_MIN_MACOS}`, () => assert.equal(pickAutoInstallCommand("darwin", { hasBrew: true, macosMajor: 12 }), null));
  test("Linux downloads the script to a file instead of piping it", () => {
    const c = pickAutoInstallCommand("linux", { hasCurl: true });
    assert.match(c.args.join(" "), /-o \/tmp\/ollama-install\.sh && sh/);
    assert.doesNotMatch(c.args.join(" "), /\|\s*sh/);
  });
  test("nothing available → null", () => assert.equal(pickAutoInstallCommand("linux"), null));
});

describe("OpenClaw install + config", () => {
  test("unix installer runs from a file with --no-onboard", () =>
    assert.deepEqual(pickOpenClawInstall("linux", "/tmp/x/install.sh").args, ["/tmp/x/install.sh", "--no-onboard"]));
  test("windows installer passes -NoOnboard", () => assert.match(pickOpenClawInstall("win32").args.at(-1), /-NoOnboard$/));
  test("config commands set the ollama key and default model", () =>
    assert.deepEqual(openclawConfigCommands("qwen3.5:9b"), [
      ["config", "set", "models.providers.ollama.apiKey", "ollama-local"],
      ["models", "set", "ollama/qwen3.5:9b"],
    ]));
});

describe("carried over from granted", () => {
  test("ollamaWindowsDir", () => assert.equal(ollamaWindowsDir("C:\\Users\\k\\AppData\\Local"), "C:\\Users\\k\\AppData\\Local\\Programs\\Ollama"));
  test("withOllamaOnPath appends once, only on win32", () => {
    const env = withOllamaOnPath({ Path: "C:\\x" }, "win32", "C:\\L");
    assert.equal(env.Path, "C:\\x;C:\\L\\Programs\\Ollama");
    assert.equal(withOllamaOnPath(env, "win32", "C:\\L").Path, env.Path);
    const unix = { PATH: "/bin" };
    assert.equal(withOllamaOnPath(unix, "linux", "x"), unix);
  });
  test("waitForDaemon succeeds and times out", async () => {
    let n = 0;
    assert.equal(await waitForDaemon(async () => ++n >= 3, { sleepFn: async () => {} }), true);
    assert.equal(await waitForDaemon(async () => false, { timeoutMs: 0, sleepFn: async () => {} }), false);
  });
  test("installGuidance mentions the CLI tarball on old macOS", () => assert.match(installGuidance("darwin", 12), /ollama-darwin\.tgz/));
  test("launchOllamaDaemon never inherits stdio", () => {
    const calls = [];
    const fake = (cmd, args, opts) => { calls.push({ cmd, opts }); return { on() {}, unref() {} }; };
    launchOllamaDaemon("win32", { localAppData: "C:\\L", spawnFn: fake });
    launchOllamaDaemon("linux", { spawnFn: fake });
    assert.ok(calls.every((c) => c.opts.stdio === "ignore" && c.opts.detached));
  });
});

describe("mode picker", () => {
  test("two modes, each explained", () => {
    assert.deepEqual(Object.keys(MODES), ["local", "cloud"]);
    for (const m of Object.values(MODES)) assert.ok(m.lines.length >= 2);
  });
  for (const [input, want] of [["1", "local"], ["local", "local"], ["2", "cloud"], ["online", "cloud"], ["Free", "cloud"], ["3", null], ["", null]])
    test(`"${input}" → ${want}`, () => assert.equal(parseModeChoice(input), want));
});
