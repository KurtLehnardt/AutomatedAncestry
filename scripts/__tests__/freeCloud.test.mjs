import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_PROVIDERS, FCC_COMMIT, FCC_REPO_URL, cleanKey, detectKeyProvider, maskKey, pickProviderModel,
  buildModelConfig, recommendMode, openUrlCommand, pasteHint, fccInstallSteps, fccBinDir,
  launcherScript, desktopEntry, PRIVACY_NOTE,
} from "../free-cloud.mjs";

describe("free providers", () => {
  test("each has a sign-up page, plain steps, and an FCC setting", () => {
    for (const p of FREE_PROVIDERS) {
      assert.match(p.url, /^https:\/\//);
      assert.ok(p.steps.length >= 2 && p.steps.length <= 4, `${p.name}: keep it short`);
      assert.match(p.envKey, /^[A-Z_]+$/);
      assert.ok(p.why.length > 0);
    }
  });
  test("FCC provider ids match FCC's catalog", () =>
    assert.deepEqual(FREE_PROVIDERS.map((p) => p.id), ["nvidia_nim", "gemini", "groq", "open_router"]));
  test("key prefixes are distinct", () =>
    assert.equal(new Set(FREE_PROVIDERS.map((p) => p.keyPrefix)).size, FREE_PROVIDERS.length));
});

describe("cleanKey: forgiving of messy pastes", () => {
  for (const [raw, want] of [
    ["  gsk_abc123  ", "gsk_abc123"],
    ['"gsk_abc123"', "gsk_abc123"],
    ["gsk_abc\n123", "gsk_abc123"],
    ["GROQ_API_KEY=gsk_abc123", "gsk_abc123"],
    ["GROQ_API_KEY = 'gsk_abc123'", "gsk_abc123"],
    ["", ""],
    [null, ""],
  ]) test(JSON.stringify(raw), () => assert.equal(cleanKey(raw), want));
});

describe("detectKeyProvider: catches a key pasted into the wrong step", () => {
  for (const [key, want] of [["nvapi-xyz", "nvidia_nim"], ["AIzaSyXYZ", "gemini"], ["gsk_xyz", "groq"], ["sk-or-v1-xyz", "open_router"], ["something-else", null]])
    test(`${key} → ${want}`, () => assert.equal(detectKeyProvider(key), want));
});

test("maskKey never shows the whole key", () => {
  assert.equal(maskKey("gsk_abcdefghijklmnop1234"), "gsk_a…1234");
  assert.equal(maskKey("short"), "•••••");
});

describe("pickProviderModel", () => {
  const byId = Object.fromEntries(FREE_PROVIDERS.map((p) => [p.id, p]));
  test("exact preference when available", () =>
    assert.equal(pickProviderModel(byId.groq, ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]), "groq/openai/gpt-oss-120b"));
  test("falls through preferences in order", () =>
    assert.equal(pickProviderModel(byId.groq, ["llama-3.3-70b-versatile"]), "groq/llama-3.3-70b-versatile"));
  test("regex preference for newer Gemini versions", () =>
    assert.equal(pickProviderModel(byId.gemini, ["models/gemini-3.9-pro", "models/gemini-3.9-flash-lite"]), "gemini/models/gemini-3.9-flash-lite"));
  test("documented default when the list is empty", () =>
    assert.equal(pickProviderModel(byId.open_router, []), "open_router/openrouter/free"));
});

describe("buildModelConfig", () => {
  test("first is main, the rest are backups", () =>
    assert.deepEqual(buildModelConfig(["a/x", "b/y", "c/z"]), { MODEL: "a/x", MODEL_FALLBACKS: "b/y,c/z" }));
  test("one service, no backups", () => assert.deepEqual(buildModelConfig(["a/x"]), { MODEL: "a/x", MODEL_FALLBACKS: "" }));
  test("no duplicates (FCC rejects them)", () => assert.deepEqual(buildModelConfig(["a/x", "a/x"]), { MODEL: "a/x", MODEL_FALLBACKS: "" }));
  test("nothing → null", () => assert.equal(buildModelConfig([]), null));
});

describe("recommendMode", () => {
  test("small machines get free online", () => {
    assert.equal(recommendMode({ needGB: 0, tooSmall: true }), "cloud");
    assert.equal(recommendMode({ needGB: 4 }), "cloud");
  });
  test("capable machines stay local", () => assert.equal(recommendMode({ needGB: 10 }), "local"));
});

test("opens pages with each OS's own browser command", () => {
  assert.equal(openUrlCommand("darwin", "https://x").cmd, "open");
  assert.equal(openUrlCommand("linux", "https://x").cmd, "xdg-open");
  assert.deepEqual(openUrlCommand("win32", "https://x").args.slice(0, 2), ["/c", "start"]);
  assert.match(pasteHint("win32"), /right-click/);
  assert.match(pasteHint("linux"), /Ctrl\+Shift\+V/);
});

describe("FCC install is pinned", () => {
  const steps = fccInstallSteps("/tmp/fcc");
  test("clones the secure fork", () => assert.deepEqual(steps[0].args.slice(0, 3), ["clone", "--quiet", FCC_REPO_URL]));
  test("checks out the full pinned SHA", () => {
    assert.match(FCC_COMMIT, /^[0-9a-f]{40}$/);
    assert.ok(steps[1].args.includes(FCC_COMMIT));
  });
  test("verifies HEAD before running anything from the checkout", () => assert.equal(steps[2].verifyHead, true));
  test("exports uv.lock to constraints (frozen, no dev deps)", () => {
    assert.deepEqual(steps[3].args.slice(0, 4), ["export", "--project", "/tmp/fcc", "--frozen"]);
    assert.equal(steps[3].args.at(-1), "/tmp/fcc/aa-constraints.txt");
  });
  test("installs against those constraints on any uv", () => {
    const a = steps[4].args;
    assert.equal(a[a.indexOf("--constraints") + 1], "/tmp/fcc/aa-constraints.txt");
    assert.ok(!a.includes("--locked"));
    assert.equal(a.at(-1), "free-claude-code @ file:///tmp/fcc");
  });
  test("adds --locked too when uv supports it", () => assert.ok(fccInstallSteps("/tmp/fcc", { locked: true })[4].args.includes("--locked")));
  test("windows paths", () => {
    const w = fccInstallSteps("C:\\T\\src", { sep: "\\" });
    assert.equal(w[3].args.at(-1), "C:\\T\\src\\aa-constraints.txt");
    assert.match(w[4].args.at(-1), /file:\/\/C:\/T\/src$/);
  });
  test("uv tool bin dir", () => assert.equal(fccBinDir("linux", "/home/k"), "/home/k/.local/bin"));
});

describe("launcher", () => {
  test("free mode starts FCC quietly, then Hermes through it", () => {
    const sh = launcherScript("linux", { mode: "cloud" });
    assert.match(sh, /FCC_OPEN_BROWSER=false nohup fcc-server/);
    assert.match(sh, /exec fcc-hermes "\$@"\n$/);
  });
  test("local mode opens the chosen agent", () => {
    assert.match(launcherScript("darwin", { mode: "local", agent: "openclaw" }), /exec openclaw tui/);
    assert.match(launcherScript("linux", { mode: "local", agent: "hermes" }), /exec hermes "\$@"/);
    assert.doesNotMatch(launcherScript("linux", { mode: "local", agent: "hermes" }), /fcc-server/);
  });
  test("windows launcher uses CRLF and pauses so errors stay visible", () => {
    const cmd = launcherScript("win32", { mode: "cloud" });
    assert.match(cmd, /\r\n/);
    assert.match(cmd, /fcc-hermes %\*\r\npause\r\n$/);
  });
  test("desktop entry opens in a terminal", () => assert.match(desktopEntry("/x/family-history"), /Terminal=true/));
});

test("privacy note says plainly what leaves the computer", () => {
  const text = PRIVACY_NOTE.join(" ");
  assert.match(text, /sent to these/);
  assert.match(text, /living relatives/);
});
