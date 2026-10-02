import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILYFINDER_HOST, FAMILYFINDER_ORIGIN, FAMILYFINDER_USERNAME_SECRET_NAME, FAMILYFINDER_PASSWORD_SECRET_NAME,
  hermesVaultAddCommand, openclawUsernameCommand, openclawPasswordCommand,
} from "../familyfinder.mjs";

// Pure logic only: no TTY, no Hermes, no OpenClaw, no network.

describe("familyFinder.net constants", () => {
  test("origin matches host", () => assert.equal(FAMILYFINDER_ORIGIN, `https://${FAMILYFINDER_HOST}`));
  test("secret names are distinct", () => assert.notEqual(FAMILYFINDER_USERNAME_SECRET_NAME, FAMILYFINDER_PASSWORD_SECRET_NAME));
});

describe("hermesVaultAddCommand", () => {
  test("whole command is interactive -- no site/username/password in argv", () => {
    const cmd = hermesVaultAddCommand();
    assert.deepEqual(cmd, { cmd: "hermes", args: ["vault", "add", "--kind", "login"] });
  });
});

describe("openclawUsernameCommand", () => {
  test("stores username as an inspectable env-kind entry", () => {
    const cmd = openclawUsernameCommand("alice@example.com");
    assert.equal(cmd.cmd, "openclaw");
    assert.deepEqual(cmd.args, ["secrets", "store", "set", "familyfinder_username", "--kind", "env", "--value", "alice@example.com"]);
  });
  test("coerces a missing username to an empty string rather than the literal word undefined", () =>
    assert.ok(openclawUsernameCommand(undefined).args.at(-1) === ""));
});

describe("openclawPasswordCommand", () => {
  test("no --value flag -- password must go via stdin (--value-file -), never argv", () => {
    const cmd = openclawPasswordCommand();
    assert.equal(cmd.cmd, "openclaw");
    assert.deepEqual(cmd.args, [
      "secrets", "store", "set", "familyfinder_password",
      "--kind", "secret", "--value-file", "-", "--allow-host", "familyfinder.net",
    ]);
    assert.ok(!cmd.args.includes("--value"));
  });
});
