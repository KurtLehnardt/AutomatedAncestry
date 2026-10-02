/**
 * AutomatedAncestry — familyFinder.net credential storage.
 *
 * familyFinder.net (Kurt's own upcoming site) isn't live yet and will use
 * plain username/password login -- no API, no OAuth. Kurt explicitly chose
 * raw credential storage over building an API/OAuth scheme first (his own
 * site, his call), so this module's whole job is getting those credentials
 * into each agent's own secure, purpose-built credential store -- NOT
 * automating a login form that doesn't exist yet to verify against.
 *
 * Hermes: `hermes vault add --kind login` (confirmed via
 * ~/.hermes/hermes-agent/hermes_cli/vault.py) is fully interactive --
 * label, site origin, identifier type/value, then a `getpass`-hidden
 * password that's never passed as argv and never echoed. There is no flag
 * to pre-fill these, so this hands off the whole terminal to Hermes's own
 * prompts (we print what to type at each one first) rather than scripting
 * around them -- our code never touches the password at all.
 *
 * OpenClaw: `openclaw secrets store set <name> --kind secret --value-file -
 * --allow-host <host>` (confirmed via `openclaw secrets store set --help`)
 * stores a host-scoped, write-only secret -- once stored this way, the
 * literal value can never be read back out, by us or by the agent. The
 * username (not secret) goes in as `--kind env` so it stays inspectable.
 * NOTE: exactly how a `--allow-host`-scoped secret gets substituted into a
 * real login form during `openclaw browser fill`/`type` was NOT confirmed
 * from OpenClaw's docs or installed source (no `{{secret:NAME}}`-style
 * placeholder usage was found tied to the browser tools specifically) --
 * flagged here and in HANDOFF.md rather than assumed; it needs verifying
 * against the real site once familyFinder.net is live.
 */
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// PURE LOGIC
// ---------------------------------------------------------------------------

export const FAMILYFINDER_HOST = "familyfinder.net";
export const FAMILYFINDER_ORIGIN = `https://${FAMILYFINDER_HOST}`;
export const FAMILYFINDER_USERNAME_SECRET_NAME = "familyfinder_username";
export const FAMILYFINDER_PASSWORD_SECRET_NAME = "familyfinder_password";

/** Fully interactive on Hermes's side (see module doc) -- this is the whole command. */
export function hermesVaultAddCommand() {
  return { cmd: "hermes", args: ["vault", "add", "--kind", "login"] };
}

/** Username is not secret -- stored as an inspectable `env`-kind entry. */
export function openclawUsernameCommand(username) {
  return {
    cmd: "openclaw",
    args: ["secrets", "store", "set", FAMILYFINDER_USERNAME_SECRET_NAME, "--kind", "env", "--value", String(username ?? "")],
  };
}

/**
 * Password goes via stdin (`--value-file -`), never a CLI arg, so it never
 * appears in shell history or a process listing. Caller must pipe the
 * password (plus a trailing newline) as this command's `input`.
 */
export function openclawPasswordCommand() {
  return {
    cmd: "openclaw",
    args: ["secrets", "store", "set", FAMILYFINDER_PASSWORD_SECRET_NAME, "--kind", "secret", "--value-file", "-", "--allow-host", FAMILYFINDER_HOST],
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * One-time guided setup for whichever agent(s) were installed. Mirrors the
 * setupFamilySearch UX (heading/ask/confirm from the same ctx shape
 * setup.mjs already builds) but hands off real terminal control for Hermes
 * rather than scripting prompts we can't pre-fill.
 */
export async function setupFamilyFinder(ctx) {
  const { c, heading, ask, confirm, runInherit, runWithInput, agentIds, home = homedir() } = ctx;

  heading("familyFinder.net");
  console.log("  familyFinder.net isn't live yet. This stores your login now so the Family History");
  console.log("  Researcher skill can use it once the site is up -- it does NOT log in or change");
  console.log("  anything today, since there's no real site yet to verify that against.");
  if (!(await confirm("Store your familyFinder.net login now?", true))) return null;

  const results = {};

  if (agentIds.includes("hermes")) {
    heading("Hermes vault");
    console.log(c.dim("  Hermes will ask a few questions, then hide your password as you type it."));
    console.log(c.dim(`  When it asks:`));
    console.log(c.dim(`    Label:            familyFinder.net`));
    console.log(c.dim(`    Site origin:      ${FAMILYFINDER_ORIGIN}`));
    console.log(c.dim(`    Identifier type:  username (or email, whichever you log in with)`));
    console.log(c.dim(`    Authenticator key: press Enter to skip, unless familyFinder.net has 2FA`));
    const cmd = hermesVaultAddCommand();
    results.hermes = runInherit(cmd.cmd, cmd.args);
    console.log(results.hermes ? `  ${c.g("✓")} saved to Hermes's encrypted vault` : c.r("  Hermes vault add didn't complete."));
  }

  if (agentIds.includes("openclaw")) {
    heading("OpenClaw secrets store");
    const username = (await ask("  familyFinder.net username or email: ")).trim();
    if (!username) {
      console.log("  No username entered -- skipping OpenClaw secrets setup.");
    } else {
      const u = openclawUsernameCommand(username);
      const uOk = runInherit(u.cmd, u.args);
      console.log(c.y("  Your password will be visible as you type it (OpenClaw has no hidden-input prompt here) --"));
      console.log(c.y("  make sure no one's watching your screen."));
      const password = await ask("  familyFinder.net password: ");
      const p = openclawPasswordCommand();
      const pOk = password ? runWithInput(p.cmd, p.args, `${password}\n`) : false;
      results.openclaw = uOk && pOk;
      console.log(results.openclaw ? `  ${c.g("✓")} username and password stored (password write-only, never retrievable as plaintext)` : c.r("  OpenClaw secrets store didn't complete."));
    }
  }

  return results;
}
