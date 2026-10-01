import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FS_ENVIRONMENTS, DEFAULT_ENVIRONMENT, isWriteEnvironment, redirectUri, randomState, authorizationUrl,
  parseCallbackQuery, tokenEndpoint, tokenRequestBody, parseTokenResponse, apiBase, maskToken, FACT_TYPES,
  validateFactWrite, buildFactWriteRequest, getPersonRequest, tokenPath,
} from "../familysearch.mjs";

describe("environments", () => {
  test("default is sandbox, not production", () => assert.equal(DEFAULT_ENVIRONMENT, "sandbox"));
  test("only production and beta count as writing to shared data", () => {
    assert.equal(isWriteEnvironment("sandbox"), false);
    assert.equal(isWriteEnvironment("beta"), true);
    assert.equal(isWriteEnvironment("production"), true);
  });
  test("every environment has distinct ident/api hosts", () => {
    const idents = Object.values(FS_ENVIRONMENTS).map((e) => e.identHost);
    const apis = Object.values(FS_ENVIRONMENTS).map((e) => e.apiHost);
    assert.equal(new Set(idents).size, idents.length);
    assert.equal(new Set(apis).size, apis.length);
  });
});

describe("redirectUri", () => {
  test("matches FamilySearch's own documented example shape", () => assert.equal(redirectUri(4567), "http://localhost:4567/auth/familysearch/callback"));
});

test("randomState produces a non-trivial, non-repeating value", () => {
  const a = randomState();
  const b = randomState();
  assert.ok(a.length >= 16);
  assert.notEqual(a, b);
});

describe("authorizationUrl", () => {
  test("carries client_id, redirect_uri, response_type=code, and state", () => {
    const url = new URL(authorizationUrl({ clientId: "abc123", env: "sandbox", state: "xyz" }));
    assert.equal(url.hostname, FS_ENVIRONMENTS.sandbox.identHost);
    assert.equal(url.searchParams.get("client_id"), "abc123");
    assert.equal(url.searchParams.get("redirect_uri"), redirectUri());
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "xyz");
  });
  test("rejects an unknown environment rather than silently defaulting", () => assert.throws(() => authorizationUrl({ clientId: "a", env: "nope", state: "s" }), /unknown FamilySearch environment/));
});

describe("parseCallbackQuery", () => {
  test("extracts code and state on success", () => assert.deepEqual(parseCallbackQuery("?code=abc&state=xyz"), { code: "abc", state: "xyz" }));
  test("surfaces an explicit FamilySearch error", () => assert.deepEqual(parseCallbackQuery("?error=access_denied&error_description=user+said+no"), { error: "access_denied", errorDescription: "user said no" }));
  test("treats a missing code as an error rather than crashing", () => assert.deepEqual(parseCallbackQuery(""), { error: "missing_code", errorDescription: "no authorization code in the callback" }));
});

test("tokenEndpoint uses the environment's ident host", () => assert.equal(tokenEndpoint("beta"), `https://${FS_ENVIRONMENTS.beta.identHost}/cis-web/oauth2/v3/token`));

test("tokenRequestBody is form-encoded per FamilySearch's documented grant", () => {
  const body = tokenRequestBody({ clientId: "abc", code: "the-code", port: 4567 });
  const params = new URLSearchParams(body);
  assert.equal(params.get("client_id"), "abc");
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "the-code");
  assert.equal(params.get("redirect_uri"), redirectUri(4567));
});

describe("parseTokenResponse", () => {
  test("reads the confirmed fields", () => {
    const t = parseTokenResponse({ access_token: "tok", token_type: "Bearer", id_token: "idt" });
    assert.equal(t.accessToken, "tok");
    assert.equal(t.tokenType, "Bearer");
    assert.equal(t.idToken, "idt");
    assert.equal(t.refreshToken, null);
    assert.ok(t.obtainedAt);
  });
  test("throws rather than silently storing an empty token", () => assert.throws(() => parseTokenResponse({}), /missing access_token/));
});

test("apiBase uses the environment's api host under /platform", () => assert.equal(apiBase("production"), `https://${FS_ENVIRONMENTS.production.apiHost}/platform`));

describe("maskToken", () => {
  test("hides a long token down to a recognizable fragment", () => assert.equal(maskToken("abcdefghijklmnop"), "abcde…mnop"));
  test("fully masks anything too short to safely show a fragment of", () => assert.equal(maskToken("short"), "•••••"));
});

describe("validateFactWrite", () => {
  test("requires personId, a known type, a changeMessage citing the source, and a date or place", () =>
    assert.deepEqual(validateFactWrite({}), [
      "missing personId",
      `unknown fact type (known: ${Object.keys(FACT_TYPES).join(", ")})`,
      "missing changeMessage (must cite the source — this becomes FamilySearch's own tracked edit reason)",
      "fact needs at least a date or a place",
    ]));
  test("a complete fact passes", () =>
    assert.deepEqual(validateFactWrite({ personId: "L1", type: "birth", changeMessage: "1850 parish register, p. 12", dateOriginal: "3 Apr 1850" }), []));
});

describe("buildFactWriteRequest", () => {
  const fact = { personId: "L1", type: "birth", changeMessage: "1850 parish register, p. 12", dateOriginal: "3 Apr 1850", placeOriginal: "Breslau, Germany" };

  test("matches FamilySearch's documented Create Person Conclusion shape", () => {
    const req = buildFactWriteRequest(fact, "sandbox");
    assert.equal(req.method, "POST");
    assert.equal(req.url, `${apiBase("sandbox")}/tree/persons/L1`);
    assert.equal(req.headers["Content-Type"], "application/x-fs-v1+json");
    const sentFact = req.body.persons[0].facts[0];
    assert.equal(req.body.persons[0].id, "L1");
    assert.equal(sentFact.type, FACT_TYPES.birth);
    assert.equal(sentFact.attribution.changeMessage, fact.changeMessage);
    assert.equal(sentFact.date.original, "3 Apr 1850");
    assert.equal(sentFact.place.original, "Breslau, Germany");
  });
  test("flags sandbox vs. a write that touches shared data", () => {
    assert.equal(buildFactWriteRequest(fact, "sandbox").isProductionWrite, false);
    assert.equal(buildFactWriteRequest(fact, "production").isProductionWrite, true);
    assert.equal(buildFactWriteRequest(fact, "beta").isProductionWrite, true);
  });
  test("refuses to build a request for an invalid fact rather than sending something broken", () => assert.throws(() => buildFactWriteRequest({}), /invalid fact write/));
});

test("getPersonRequest is a plain GET with no body", () => {
  const req = getPersonRequest("L1", "sandbox");
  assert.equal(req.method, "GET");
  assert.equal(req.url, `${apiBase("sandbox")}/tree/persons/L1`);
  assert.equal(req.body, undefined);
});

test("tokenPath lives under the fixed home-relative dir, outside the repo and outside git", () => assert.equal(tokenPath("/home/test"), "/home/test/.family-history/familysearch-token.json"));
