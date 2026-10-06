// A provider with no OAUTH_TEST_CONFIG entry has NO generic probe — that says
// nothing about its credential. The OAuth branch used to return
// `{ valid: false, error: "Provider test not supported", diagnosis: unsupported }`
// WITHOUT `skipped`, so callers took the failure path and persisted
// `testStatus: "error"` + `lastError: "Provider test not supported"` +
// `errorCode: "unsupported"` + a 30s cooldown.
//
// WorkBuddy's accounts are provisioned out-of-band (the addon imports the desktop
// app's session), so the credential-health sweep re-marked all three accounts
// errored every interval and routing skipped them while they were perfectly
// usable — the providers card read "3 Error (ERR)" on working accounts.
//
// The API-key branch already returned `skipped: true` for the same situation; this
// test pins the OAuth branch to the same contract. It also guards the four other
// oauth-catalog providers that have no test config (qoder, zed, trae).
import test from "node:test";
import assert from "node:assert/strict";

import { testOAuthConnection } from "../../src/app/api/providers/[id]/test/route";

test("an oauth provider without a generic probe reports skipped, not failure", async () => {
  const connection = {
    id: "c-workbuddy-global",
    provider: "workbuddy-global",
    authType: "oauth",
    accessToken: "session-token",
    refreshToken: "refresh-token",
  };

  const result = (await testOAuthConnection(connection)) as {
    valid: boolean;
    skipped?: boolean;
    error?: string;
    diagnosis?: { code?: string; type?: string };
  };

  assert.equal(result.valid, false, "no probe ran, so nothing can be declared valid");
  assert.equal(
    result.skipped,
    true,
    "skipped must be set so callers leave persisted credential health untouched"
  );
  assert.equal(result.error, "Provider test not supported");
  assert.equal(result.diagnosis?.code, "unsupported");
});

test("providers that DO have a probe are unaffected by the skipped contract", async (t) => {
  // github has an OAUTH_TEST_CONFIG entry; drive it with a fetch that fails fast so
  // the assertion is about the branch taken, not about upstream behaviour.
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "nope" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  const result = (await testOAuthConnection({
    id: "c-github",
    provider: "github",
    authType: "oauth",
    accessToken: "token",
  })) as { skipped?: boolean };

  assert.notEqual(result.skipped, true, "a real probe failure must stay a failure");
});
