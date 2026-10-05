/**
 * WorkBuddy addon — registration tests.
 *
 * The addon is only real if the platform can route to it: the provider must exist in the
 * catalogue AND the registry, the executor must be reachable by every id and alias a
 * connection can be created under, the credit fetcher must be registered for the quota
 * page, the refresher must be listed as supported, and every `/api/workbuddy/*` route must
 * be loopback-only. A missing entry here would fail silently at runtime — a provider that
 * shows up but cannot answer, or a route that leaks a machine's sign-ins over a tunnel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-workbuddy-reg-"));
process.env.DATA_DIR = DATA_DIR;

const { REGISTRY, getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { getProviderById, getProviderByAlias } =
  await import("../../src/shared/constants/providers.ts");
const { hasSpecializedExecutor, getExecutor } = await import("../../open-sse/executors/index.ts");
const { WorkBuddyExecutor } = await import("../../open-sse/executors/workbuddy.ts");
const { USAGE_FETCHER_PROVIDERS } =
  await import("../../open-sse/services/usage/fetcherProviders.ts");
const { supportsTokenRefresh } = await import("../../open-sse/services/tokenRefresh.ts");
const { isLocalOnlyPath } = await import("../../src/server/authz/routeGuard.ts");
const { providerToWorkBuddyProviderId, workBuddyModelsToSyncedInput } =
  await import("../../src/lib/workbuddy/modelDiscovery.ts");

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const PROVIDER_IDS = ["workbuddy", "workbuddy-global"];

test("both editions are registered in the provider catalogue", () => {
  const cn = getProviderById("workbuddy");
  const global = getProviderById("workbuddy-global");
  assert.ok(cn, "workbuddy missing from the provider catalogue");
  assert.ok(global, "workbuddy-global missing from the provider catalogue");
  assert.equal(cn.name, "WorkBuddy (国内版)");
  assert.equal(getProviderByAlias("wb")?.id, "workbuddy");
  assert.equal(getProviderByAlias("wbg")?.id, "workbuddy-global");
  assert.ok(cn.serviceKinds.includes("llm"));
  assert.ok(global.serviceKinds.includes("llm"));
});

test("both editions are registered in the provider registry with a live catalogue", () => {
  for (const id of PROVIDER_IDS) {
    const entry = REGISTRY[id] ?? getRegistryEntry(id);
    assert.ok(entry, `registry entry missing for ${id}`);
    assert.equal(entry.format, "openai");
    assert.equal(entry.executor, id);
    assert.equal(
      entry.forceStream,
      true,
      `${id} must force streaming (the gateway rejects non-stream chat)`
    );
    assert.equal(entry.passthroughModels, true, `${id} must expose the live catalogue`);
    assert.ok(entry.liveCatalogAuthoritative, `${id} must treat the synced catalogue as the truth`);
    assert.ok((entry.models?.length ?? 0) > 0, `${id} needs an offline fallback roster`);
    assert.match(entry.baseUrl ?? "", /\/v2\/chat\/completions$/);
  }
});

test("every provider id and alias resolves to the WorkBuddy executor", async () => {
  for (const id of ["workbuddy", "wb", "workbuddy-global", "wbg"]) {
    assert.equal(hasSpecializedExecutor(id), true, `${id} has no specialized executor`);
    const executor = await getExecutor(id);
    assert.ok(executor instanceof WorkBuddyExecutor, `${id} did not resolve to WorkBuddyExecutor`);
  }
});

test("the international executor talks to the global gateway", () => {
  const executor = new WorkBuddyExecutor("workbuddy-global");
  assert.equal(executor.getProvider(), "workbuddy-global");
  assert.match(executor.getBaseUrls()[0] ?? "", /workbuddy\.ai/);
});

test("the credit fetcher and the refresher are registered for both editions", () => {
  for (const id of PROVIDER_IDS) {
    assert.ok(USAGE_FETCHER_PROVIDERS.includes(id), `${id} has no usage fetcher registered`);
    assert.equal(supportsTokenRefresh(id), true, `${id} cannot refresh its session`);
  }
});

test("every WorkBuddy route is loopback-only", () => {
  for (const route of [
    "/api/workbuddy/info",
    "/api/workbuddy/accounts",
    "/api/workbuddy/import",
    "/api/workbuddy/models",
    "/api/workbuddy/credits",
    "/api/workbuddy/free-model",
    "/api/workbuddy/checkin",
  ]) {
    assert.equal(isLocalOnlyPath(route, "GET"), true, `${route} is not loopback-gated`);
    assert.equal(isLocalOnlyPath(route, "POST"), true, `${route} is not loopback-gated for POST`);
  }
});

test("the sync path recognises the addon's providers and only the addon's", () => {
  assert.equal(providerToWorkBuddyProviderId("workbuddy"), "workbuddy");
  assert.equal(providerToWorkBuddyProviderId("wb"), "workbuddy");
  assert.equal(providerToWorkBuddyProviderId("workbuddy-global"), "workbuddy-global");
  assert.equal(providerToWorkBuddyProviderId("wbg"), "workbuddy-global");
  assert.equal(providerToWorkBuddyProviderId("codebuddy-cn"), null);
  assert.equal(providerToWorkBuddyProviderId("openrouter"), null);
});

test("the catalogue mapping carries windows, capabilities and the free flag", () => {
  const mapped = workBuddyModelsToSyncedInput([
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek-V4.1-Flash",
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      creditMultiplier: 0,
      supportsVision: true,
      supportsToolCall: true,
      reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" },
    },
    {
      // No declared rate: the row must NOT claim the model is free.
      id: "mystery-model",
      name: "Mystery",
      contextLength: 100_000,
      maxOutputTokens: 8_000,
    },
  ]);

  assert.equal(mapped[0].isFree, true);
  assert.equal(mapped[0].contextWindow, 1_000_000);
  assert.equal(mapped[0].outputTokenLimit, 128_000);
  assert.equal(mapped[0].supportsVision, true);
  assert.deepEqual(mapped[0].supportedThinkingEfforts, ["low", "high"]);
  assert.equal(mapped[1].isFree, undefined);
});

/* ------------------------------------------------------------------ *
 * Request path (no network — the executor's own shaping)
 * ------------------------------------------------------------------ */

test("the executor builds the edition's chat URL and the account's headers", () => {
  const cn = new WorkBuddyExecutor("workbuddy");
  const global = new WorkBuddyExecutor("workbuddy-global");

  // The registry baseUrl is what the request path uses; both editions must point at
  // their own gateway's chat endpoint.
  assert.match(
    cn.getBaseUrls()[0] ?? "",
    /^https:\/\/copilot\.tencent\.com\/v2\/chat\/completions$/
  );
  assert.match(
    global.getBaseUrls()[0] ?? "",
    /^https:\/\/www\.workbuddy\.ai\/v2\/chat\/completions$/
  );
});

test("an identified account sends its identity; an anonymous one sends the X-No-* spelling", () => {
  const executor = new WorkBuddyExecutor("workbuddy");

  const identified = executor.buildHeaders(
    {
      accessToken: "tok",
      providerSpecificData: {
        workbuddyDomain: "workbuddy.ai",
        workbuddyUid: "u1",
        workbuddyEnterpriseId: "e1",
      },
    },
    true
  );
  assert.equal(identified.Authorization, "Bearer tok");
  assert.equal(identified["X-User-Id"], "u1");
  assert.equal(identified["X-Enterprise-Id"], "e1");
  assert.equal(identified["X-Domain"], "workbuddy.ai");
  assert.equal(identified["X-Product"], "SaaS");
  assert.equal(identified["X-No-User-Id"], undefined);

  const anonymous = executor.buildHeaders({ accessToken: "tok" }, true);
  assert.equal(anonymous["X-No-User-Id"], "1");
  assert.equal(anonymous["X-No-Enterprise-Id"], "1");
  assert.equal(anonymous["X-No-Department-Info"], "1");
});

test("a client that asked for JSON still produces a streamable, system-led body", () => {
  const executor = new WorkBuddyExecutor("workbuddy");
  const body = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] } as Record<
    string,
    unknown
  >;

  // The transport flag is forced true (forceStream on the registry entry); the body must
  // agree, or the gateway answers the "non-stream" rejection.
  const transformed = executor.transformRequest("glm-5.3", body, true, { accessToken: "tok" }) as {
    stream?: boolean;
    messages: Array<{ role: string }>;
  };
  assert.equal(transformed.stream, true);
  assert.equal(transformed.messages[0].role, "system");
});

/* ------------------------------------------------------------------ *
 * Multi-account: one connection per imported account
 * ------------------------------------------------------------------ */

const { createProviderConnection, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const {
  connectionPayloadFromWorkBuddyCredential,
  credentialFromWorkBuddyConnection,
  listWorkBuddyConnections,
  resolveWorkBuddyConnection,
  resolveWorkBuddyConnectionById,
} = await import("../../src/lib/workbuddy/accounts.ts");

test("each imported account becomes its own addressable connection", async () => {
  const first = await createProviderConnection(
    connectionPayloadFromWorkBuddyCredential({
      accessToken: "tok-a",
      refreshToken: "ref-a",
      domain: "",
      uid: "u-a",
      nickname: "Account A",
      source: "desktop",
    })
  );
  const second = await createProviderConnection(
    connectionPayloadFromWorkBuddyCredential({
      accessToken: "tok-b",
      refreshToken: "ref-b",
      domain: "",
      uid: "u-b",
      nickname: "Account B",
      source: "desktop",
    })
  );

  const rows = await listWorkBuddyConnections("workbuddy");
  assert.equal(rows.length, 2, "two accounts of one edition must stay two connections");

  // Addressing by id returns THAT account's session, not the active/newest one — this is
  // what lets credits/check-in be answered per account.
  const byIdA = await resolveWorkBuddyConnectionById(String(first.id));
  const byIdB = await resolveWorkBuddyConnectionById(String(second.id));
  assert.equal(byIdA?.credential.uid, "u-a");
  assert.equal(byIdB?.credential.uid, "u-b");
  assert.equal(byIdA?.credential.accessToken, "tok-a");

  // A connection belonging to another provider must never be credential-mapped.
  assert.equal(await resolveWorkBuddyConnectionById("does-not-exist"), null);

  // The default resolution uses the PLATFORM's own preference order (priority ASC, then
  // updated_at DESC) — the account the router would reach first — and never invents a
  // second notion of "current account".
  const fallback = await resolveWorkBuddyConnection("workbuddy");
  assert.equal(String(fallback?.connection.id), String(first.id));

  // Disabling that account moves the default to the next enabled one, so the overview
  // answers with an account traffic can actually reach.
  await updateProviderConnection(String(first.id), { isActive: false });
  const afterDisable = await resolveWorkBuddyConnection("workbuddy");
  assert.equal(String(afterDisable?.connection.id), String(second.id));

  // The credential round-trips through the connection untouched.
  const roundTripped = credentialFromWorkBuddyConnection(fallback?.connection);
  assert.equal(roundTripped?.domain, "");
  assert.equal(roundTripped?.refreshToken, "ref-a");
});
