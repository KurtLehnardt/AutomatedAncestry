/**
 * AutomatedAncestry — FamilySearch.org integration.
 *
 * Reads and writes the FamilySearch Family Tree through FamilySearch's own
 * OAuth2 Developer API (https://developers.familysearch.org/) — never a
 * stored password, never scraping. Endpoints and the native-app/localhost
 * redirect flow are taken from FamilySearch's current official docs
 * (authentication, getting-started, initiate-authorization,
 * obtain-access-token pages, fetched 2026-10-01).
 *
 * FamilySearch Family Tree is a single shared, collaborative tree — a write
 * here is visible to every other researcher on that ancestor, with full
 * history. So:
 *   - Every write requires a `changeMessage`, which we build FROM the
 *     skill's own citation requirement (scripts/family-skill.mjs) — no
 *     changeMessage, no write. This doubles as FamilySearch's own
 *     best-practice for tracked edits and our "every fact needs a source" rule.
 *   - `addFact` never calls the network itself; it returns the exact request
 *     it would send so the caller can show the user "write THIS fact to
 *     THIS person" and get explicit confirmation immediately before sending
 *     it — not a one-time blanket permission at setup.
 *   - Default environment is "sandbox" (see ENVIRONMENT NOTE below), not
 *     production.
 *
 * ENVIRONMENT NOTE (read before changing the default): FamilySearch's docs
 * are inconsistent about what a freshly-registered external developer app
 * gets by default. One official page says a new app key is "automatically
 * enabled to access integration (formally called 'sandbox')" — implying
 * Integration IS the safe external-developer default. A different page
 * describes "Integration" as "an internal testing environment for
 * FamilySearch developers and CI/CD pipelines, not intended for external
 * developer use." These can't both be the whole story, and nothing we could
 * fetch resolves it. FS_ENVIRONMENTS.sandbox below uses the hostnames
 * confirmed for "Integration" (identint.familysearch.org /
 * api-integ.familysearch.org); CONFIRM against your own Application Details
 * page (or FamilySearch Developer Support) which environment your app key
 * actually has, and correct DEFAULT_ENVIRONMENT below if it's wrong before
 * relying on this for anything.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// PURE LOGIC
// ---------------------------------------------------------------------------

/** Confirmed hostnames per environment. See the ENVIRONMENT NOTE above about "sandbox". */
export const FS_ENVIRONMENTS = {
  sandbox: { identHost: "identint.familysearch.org", apiHost: "api-integ.familysearch.org", label: "Sandbox/Integration (test data — safe default)" },
  beta: { identHost: "identbeta.familysearch.org", apiHost: "apibeta.familysearch.org", label: "Beta (a snapshot of real production data, used for testing)" },
  production: { identHost: "ident.familysearch.org", apiHost: "api.familysearch.org", label: "Production (the real, public, shared Family Tree)" },
};

/** Sandbox only. Writes to "production" or "beta" must be an explicit, separate opt-in — never the default. */
export const DEFAULT_ENVIRONMENT = "sandbox";

export function isWriteEnvironment(env) {
  return env === "production" || env === "beta";
}

/** Default local callback port. Matches the shape of FamilySearch's own documented example redirect URI. */
export const DEFAULT_CALLBACK_PORT = 4567;
export const CALLBACK_PATH = "/auth/familysearch/callback";

export function redirectUri(port = DEFAULT_CALLBACK_PORT) {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

/** A CSRF-resistant random state value for the authorization request. */
export function randomState() {
  return randomBytes(16).toString("hex");
}

export function authorizationUrl({ clientId, env = DEFAULT_ENVIRONMENT, port = DEFAULT_CALLBACK_PORT, state, scope = "" }) {
  const host = FS_ENVIRONMENTS[env]?.identHost;
  if (!host) throw new Error(`unknown FamilySearch environment: ${env}`);
  const url = new URL(`https://${host}/cis-web/oauth2/v3/authorization`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(port));
  url.searchParams.set("response_type", "code");
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Parses the query string FamilySearch appends to the local redirect URI after login. */
export function parseCallbackQuery(query) {
  const params = new URLSearchParams(query);
  if (params.get("error")) return { error: params.get("error"), errorDescription: params.get("error_description") || "" };
  const code = params.get("code");
  if (!code) return { error: "missing_code", errorDescription: "no authorization code in the callback" };
  return { code, state: params.get("state") || "" };
}

export function tokenEndpoint(env = DEFAULT_ENVIRONMENT) {
  const host = FS_ENVIRONMENTS[env]?.identHost;
  if (!host) throw new Error(`unknown FamilySearch environment: ${env}`);
  return `https://${host}/cis-web/oauth2/v3/token`;
}

export function tokenRequestBody({ clientId, code, port = DEFAULT_CALLBACK_PORT }) {
  return new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(port),
    code,
  }).toString();
}

/**
 * FamilySearch's token response has confirmed access_token/id_token/token_type;
 * a refresh_token is NOT confirmed in the docs we could reach, so callers
 * must not assume one exists — re-run the OAuth flow when the access token
 * expires rather than relying on silent refresh.
 */
export function parseTokenResponse(json) {
  if (!json?.access_token) throw new Error(`token response missing access_token: ${JSON.stringify(json)}`);
  return {
    accessToken: json.access_token,
    tokenType: json.token_type || "Bearer",
    idToken: json.id_token || null,
    refreshToken: json.refresh_token || null,
    obtainedAt: new Date().toISOString(),
  };
}

export function apiBase(env = DEFAULT_ENVIRONMENT) {
  const host = FS_ENVIRONMENTS[env]?.apiHost;
  if (!host) throw new Error(`unknown FamilySearch environment: ${env}`);
  return `https://${host}/platform`;
}

/** "gsk_abc…wxyz" style masking, same convention as scripts/free-cloud.mjs maskKey. */
export function maskToken(token) {
  const t = String(token ?? "");
  if (t.length <= 10) return "•".repeat(t.length);
  return `${t.slice(0, 5)}…${t.slice(-4)}`;
}

/**
 * Common vital fact types, by the plain name the skill/user would say, mapped
 * to FamilySearch's GEDCOM X fact type URIs. Not exhaustive — see
 * https://developers.familysearch.org for the full FactType list.
 */
export const FACT_TYPES = {
  birth: "http://gedcomx.org/Birth",
  christening: "http://gedcomx.org/Christening",
  death: "http://gedcomx.org/Death",
  burial: "http://gedcomx.org/Burial",
  marriage: "http://gedcomx.org/Marriage",
  residence: "http://gedcomx.org/Residence",
  immigration: "http://gedcomx.org/Immigration",
  occupation: "http://gedcomx.org/Occupation",
};

/** A fact write is refused without a person, a known type, and a changeMessage carrying the source. */
export function validateFactWrite(fact) {
  const errors = [];
  if (!fact?.personId) errors.push("missing personId");
  if (!fact?.type || !FACT_TYPES[fact.type]) errors.push(`unknown fact type (known: ${Object.keys(FACT_TYPES).join(", ")})`);
  if (!fact?.changeMessage) errors.push("missing changeMessage (must cite the source — this becomes FamilySearch's own tracked edit reason)");
  if (!fact?.dateOriginal && !fact?.placeOriginal) errors.push("fact needs at least a date or a place");
  return errors;
}

/**
 * Builds the exact request `addFact` would send — callers show this to the
 * user and get explicit confirmation before calling `sendFactWrite`. Matches
 * FamilySearch's documented Create Person Conclusion shape.
 */
export function buildFactWriteRequest(fact, env = DEFAULT_ENVIRONMENT) {
  const errors = validateFactWrite(fact);
  if (errors.length) throw new Error(`invalid fact write: ${errors.join("; ")}`);
  const body = {
    persons: [
      {
        id: fact.personId,
        facts: [
          {
            type: FACT_TYPES[fact.type],
            attribution: { changeMessage: fact.changeMessage },
            ...(fact.dateOriginal ? { date: { original: fact.dateOriginal, ...(fact.dateFormal ? { formal: fact.dateFormal } : {}) } } : {}),
            ...(fact.placeOriginal ? { place: { original: fact.placeOriginal } } : {}),
          },
        ],
      },
    ],
  };
  return {
    method: "POST",
    url: `${apiBase(env)}/tree/persons/${fact.personId}`,
    headers: { "Content-Type": "application/x-fs-v1+json", Accept: "application/x-fs-v1+json" },
    body,
    environment: env,
    isProductionWrite: isWriteEnvironment(env),
  };
}

export function getPersonRequest(personId, env = DEFAULT_ENVIRONMENT) {
  return { method: "GET", url: `${apiBase(env)}/tree/persons/${personId}`, headers: { Accept: "application/x-fs-v1+json" }, environment: env };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function tokenPath(home = homedir()) {
  return join(home, ".family-history", "familysearch-token.json");
}

/** Stored outside the repo (home-relative), 0600 — same care this repo gives FCC provider keys. */
export function saveToken(token, home = homedir()) {
  const path = tokenPath(home);
  mkdirSync(join(home, ".family-history"), { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2));
  chmodSync(path, 0o600);
  return path;
}

export function loadToken(home = homedir()) {
  const path = tokenPath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Listens for FamilySearch's redirect, resolves with the parsed callback query, then closes itself. */
function waitForCallback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Signed in. You can close this window and return to the terminal.</p>");
      server.close();
      resolve(parseCallbackQuery(url.search));
    });
    server.on("error", reject);
    server.listen(port);
  });
}

async function exchangeCodeForToken(clientId, code, env, port) {
  const res = await fetch(tokenEndpoint(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({ clientId, code, port }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return parseTokenResponse(json);
}

/**
 * One-time guided setup: walks the user through registering their own
 * FamilySearch developer app (we cannot do this for them — it's tied to
 * their FamilySearch account), then runs the OAuth flow and stores the
 * token. Mirrors the provider-key UX in scripts/free-cloud.mjs's
 * runFreeCloud: heading/ask/confirm/openUrlCommand come from the same ctx
 * shape setup.mjs already builds.
 */
export async function setupFamilySearch(ctx) {
  const { c, heading, ask, confirm, run, openUrlCommand, platform, home } = ctx;

  heading("FamilySearch.org integration");
  console.log("  This lets the skill read and (with your confirmation, fact by fact) update your family tree on FamilySearch.");
  console.log("  It uses FamilySearch's own sign-in page (OAuth) — this program never sees or stores your password.");
  console.log(c.dim("\n  One-time setup: you register a free developer app under your own FamilySearch account."));
  console.log(c.dim("  Open https://developers.familysearch.org , sign in, create an app (type: Desktop/Native),"));
  console.log(c.dim(`  and set its redirect URI to exactly: ${redirectUri()}`));
  if (!(await confirm("Ready to continue?", true))) return null;

  const clientId = (await ask("\n  Paste your FamilySearch app's Client ID (App Key): ")).trim();
  if (!clientId) {
    console.log("  No Client ID entered — skipping FamilySearch setup. Run this again any time.");
    return null;
  }

  let env = DEFAULT_ENVIRONMENT;
  console.log(c.dim(`\n  Using ${FS_ENVIRONMENTS[env].label}.`));
  console.log(c.y("  Confirm with FamilySearch Developer Support (or your Application Details page) which"));
  console.log(c.y("  environment your app key actually has access to before relying on this for real research —"));
  console.log(c.y("  FamilySearch's own docs are inconsistent about what a new app gets by default."));
  if (await confirm("  Switch to Production (the real, public, shared Family Tree) instead of Sandbox?", false)) {
    console.log(c.y("\n  Production writes are visible to every other FamilySearch researcher on that ancestor."));
    if (await confirm("  Are you sure?", false)) env = "production";
  }

  const state = randomState();
  const authUrl = authorizationUrl({ clientId, env, state });
  console.log(c.dim(`\n  Opening ${authUrl.split("?")[0]} in your browser…`));
  const open = openUrlCommand(platform, authUrl);
  if (!run(open.cmd, open.args, 15000)) console.log(c.y(`  Couldn't open it automatically. Please open this address:\n  ${authUrl}`));

  console.log(c.dim("  Waiting for you to sign in and approve access…"));
  const callback = await waitForCallback(DEFAULT_CALLBACK_PORT);
  if (callback.error) {
    console.log(c.r(`  FamilySearch sign-in failed: ${callback.error} ${callback.errorDescription}`));
    return null;
  }
  if (callback.state !== state) {
    console.log(c.r("  Security check failed: the callback's state didn't match. Stopping rather than trusting it."));
    return null;
  }

  const token = await exchangeCodeForToken(clientId, callback.code, env, DEFAULT_CALLBACK_PORT);
  const path = saveToken({ ...token, clientId, environment: env }, home);
  console.log(`  ${c.g("✓")} Signed in. Token saved to ${path} (not in the project, not in git).`);
  return { path, environment: env };
}

async function apiRequest(request, token) {
  const res = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers, Authorization: `Bearer ${token.accessToken}` },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`FamilySearch API ${request.method} ${request.url} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function getPerson(personId, { home = homedir(), env } = {}) {
  const token = loadToken(home);
  if (!token) throw new Error("no FamilySearch token saved — run FamilySearch setup first");
  return apiRequest(getPersonRequest(personId, env || token.environment), token);
}

/**
 * Sends a fact write. Callers MUST show `buildFactWriteRequest(fact, env)` to
 * the user and get explicit confirmation for that specific write immediately
 * before calling this — there is no bulk/unattended write path on purpose.
 */
export async function sendFactWrite(request, { home = homedir() } = {}) {
  const token = loadToken(home);
  if (!token) throw new Error("no FamilySearch token saved — run FamilySearch setup first");
  return apiRequest(request, token);
}
