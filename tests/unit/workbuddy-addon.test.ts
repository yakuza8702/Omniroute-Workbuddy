/**
 * WorkBuddy addon — unit tests.
 *
 * Covers the pure contract the whole addon rests on: which gateway an account belongs to,
 * how an upstream catalogue becomes models, how credit packages fold into a balance, which
 * model counts as free, how a throttle message's reset time is read, and what discovery
 * reports when a machine has no WorkBuddy login (or only an encrypted one).
 *
 * Anything that touches the DB is exercised through an injected temp DATA_DIR, matching the
 * convention used by the other provider tests here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-workbuddy-"));
process.env.DATA_DIR = DATA_DIR;

const {
  resolveWorkBuddyRegion,
  workBuddyChatBase,
  workBuddyBillingBase,
  resolveWorkBuddyEdition,
  editionForDomain,
  WORKBUDDY_EDITIONS,
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_CN_BILLING_BASE,
  WORKBUDDY_GLOBAL_BASE,
  WORKBUDDY_GLOBAL_ALT_BASE,
} = await import("../../src/lib/workbuddy/types.ts");

const {
  parseWorkBuddyCreditMultiplier,
  parseWorkBuddyModel,
  selectWorkBuddyCatalogModels,
  parseWorkBuddyReasoning,
  foldWorkBuddyCreditPackages,
  ensureWorkBuddySystemHead,
  parseWorkBuddyRateLimitReset,
  classifyWorkBuddyFailure,
  buildWorkBuddyChatHeaders,
  buildWorkBuddyBillingHeaders,
  credentialFromWorkBuddyRequest,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
} = await import("../../src/lib/workbuddy/upstream.ts");

const { selectWorkBuddyFreeModel, listWorkBuddyFreeModels, rankWorkBuddyModelsByCost } =
  await import("../../src/lib/workbuddy/freeModel.ts");

const {
  workBuddyDesktopAuthDirs,
  isWorkBuddyAuthFilename,
  parseWorkBuddyAuthDocument,
  discoverWorkBuddyCredentials,
  fingerprintWorkBuddyCredential,
  workBuddyAccountLabel,
} = await import("../../src/lib/workbuddy/credentials.ts");

const { describeWorkBuddyAddon } = await import("../../src/lib/workbuddy/addonInfo.ts");

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Region / edition resolution
 * ------------------------------------------------------------------ */

test("a WorkBuddy credential's own domain decides its region", () => {
  assert.equal(resolveWorkBuddyRegion("workbuddy.ai"), "global");
  assert.equal(resolveWorkBuddyRegion("WWW.WorkBuddy.ai"), "global");
  assert.equal(resolveWorkBuddyRegion("codebuddy.ai"), "global");
  assert.equal(resolveWorkBuddyRegion("copilot.tencent.com"), "cn");
  assert.equal(resolveWorkBuddyRegion(""), "cn");
  assert.equal(resolveWorkBuddyRegion(undefined), "cn");
});

test("each edition keeps its own gateway set", () => {
  assert.equal(workBuddyChatBase(""), WORKBUDDY_CN_CHAT_BASE);
  assert.equal(workBuddyBillingBase(""), WORKBUDDY_CN_BILLING_BASE);
  assert.equal(workBuddyChatBase("workbuddy.ai"), WORKBUDDY_GLOBAL_BASE);
  // The two international brand hosts are not interchangeable: a token issued at
  // codebuddy.ai is rejected by the workbuddy.ai gateway, so the base must follow it.
  assert.equal(workBuddyChatBase("codebuddy.ai"), WORKBUDDY_GLOBAL_ALT_BASE);
  assert.equal(workBuddyBillingBase("codebuddy.ai"), WORKBUDDY_GLOBAL_ALT_BASE);
});

test("edition lookup accepts provider ids, aliases and regions", () => {
  for (const key of ["workbuddy", "wb", "cn"]) {
    assert.equal(resolveWorkBuddyEdition(key)?.region, "cn");
  }
  for (const key of ["workbuddy-global", "wbg", "global"]) {
    assert.equal(resolveWorkBuddyEdition(key)?.region, "global");
  }
  assert.equal(resolveWorkBuddyEdition("codebuddy-cn"), null);
  assert.equal(resolveWorkBuddyEdition(""), null);
});

test("only the domestic edition has a daily check-in", () => {
  assert.equal(editionForDomain("").supportsCheckin, true);
  assert.equal(editionForDomain("workbuddy.ai").supportsCheckin, false);
  assert.equal(WORKBUDDY_EDITIONS.length, 2);
});

/* ------------------------------------------------------------------ *
 * Catalogue parsing
 * ------------------------------------------------------------------ */

test("credit rates parse from the upstream's credits string; junk stays undefined", () => {
  assert.equal(parseWorkBuddyCreditMultiplier("x0.79 credits"), 0.79);
  assert.equal(parseWorkBuddyCreditMultiplier("x0.00 credits"), 0);
  assert.equal(parseWorkBuddyCreditMultiplier("x0.05"), 0.05);
  assert.equal(parseWorkBuddyCreditMultiplier("free"), undefined);
  assert.equal(parseWorkBuddyCreditMultiplier(undefined), undefined);
});

test("a model entry without usable token limits is dropped, not guessed", () => {
  const parsed = parseWorkBuddyModel({
    id: "glm-5.3",
    name: "GLM-5.3",
    maxInputTokens: 1000000,
    maxOutputTokens: 48000,
    credits: "x0.79 credits",
    supportsImages: true,
    supportsToolCall: true,
  });
  assert.equal(parsed?.contextLength, 1000000);
  assert.equal(parsed?.maxOutputTokens, 48000);
  assert.equal(parsed?.creditMultiplier, 0.79);
  assert.equal(parsed?.supportsVision, true);

  assert.equal(parseWorkBuddyModel({ id: "no-limits" }), undefined);
  assert.equal(
    parseWorkBuddyModel({ id: "disabled", disabled: true, maxInputTokens: 1, maxOutputTokens: 1 }),
    undefined
  );
  // disabledMultimodal wins over a supportsImages claim: the upstream has explicitly
  // withdrawn image input for this model.
  assert.equal(
    parseWorkBuddyModel({
      id: "text-only",
      maxInputTokens: 10,
      maxOutputTokens: 10,
      supportsImages: true,
      disabledMultimodal: true,
    })?.supportsVision,
    false
  );
});

test("the singular effort form folds into the plural ladder", () => {
  const reasoning = parseWorkBuddyReasoning({ effort: "medium" });
  assert.deepEqual(reasoning?.supportedEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(reasoning?.defaultEffort, "medium");
  assert.equal(reasoning?.canDisableThinking, true);

  // An unknown effort is carried through alone rather than silently widened.
  assert.deepEqual(parseWorkBuddyReasoning({ effort: "turbo" })?.supportedEfforts, ["turbo"]);
  assert.equal(parseWorkBuddyReasoning("nonsense"), undefined);
});

test("the cli agent roster orders the catalogue and unknown ids are skipped", () => {
  const models = selectWorkBuddyCatalogModels(
    [
      { id: "b", name: "B", maxInputTokens: 100, maxOutputTokens: 10 },
      { id: "a", name: "A", maxInputTokens: 200, maxOutputTokens: 20 },
      { id: "c", name: "C", maxInputTokens: 300, maxOutputTokens: 30 },
    ],
    [{ name: "cli", models: ["a", "missing", "b"] }]
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["a", "b"]
  );
});

test("without a cli roster the whole parsed catalogue is exposed", () => {
  const models = selectWorkBuddyCatalogModels(
    [{ id: "a", name: "A", maxInputTokens: 100, maxOutputTokens: 10 }],
    [{ name: "other", models: ["a"] }]
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["a"]
  );
});

/* ------------------------------------------------------------------ *
 * Credits
 * ------------------------------------------------------------------ */

test("credit packages stay separate, spent one-offs drop out, refills reset", () => {
  const now = Date.now();
  const folded = foldWorkBuddyCreditPackages([
    {
      PackageName: "Monthly",
      CapacityType: 4,
      CycleCapacitySize: 1000,
      CycleCapacityRemain: 250,
      CycleEndTime: new Date(now + 86_400_000).toISOString(),
    },
    {
      PackageName: "Bonus",
      CapacitySize: 100,
      CapacityRemain: 40,
      ExpiredTime: new Date(now + 2 * 86_400_000).toISOString(),
    },
    {
      // Spent one-off: contributes nothing.
      PackageName: "Spent",
      CapacitySize: 50,
      CapacityRemain: 0,
      ExpiredTime: new Date(now + 86_400_000).toISOString(),
    },
    {
      // Expired one-off: also contributes nothing.
      PackageName: "Expired",
      CapacitySize: 50,
      CapacityRemain: 25,
      ExpiredTime: new Date(now - 86_400_000).toISOString(),
    },
  ]);

  assert.equal(folded.total, 290);
  assert.deepEqual(
    folded.packages.map((entry) => entry.packageName),
    ["Monthly", "Bonus"]
  );
  // 40 of the 290 expire inside 72h, so "worth spending first" is a real number.
  assert.equal(folded.expiringSoon, 40);
  assert.ok(folded.nearestExpiryMs !== undefined);
  // A recurring package reports a REFILL instant a second after its cycle end.
  const monthly = folded.packages[0];
  assert.equal(monthly.monthly, true);
  assert.equal(monthly.expiresAtMs, undefined);
  assert.ok((monthly.refreshAtMs ?? 0) > now);
});

test("a negative remaining balance clamps to zero instead of going negative", () => {
  const folded = foldWorkBuddyCreditPackages([
    { PackageName: "Overdrawn", CapacityType: 4, CycleCapacitySize: 100, CycleCapacityRemain: -5 },
  ]);
  assert.equal(folded.total, 0);
  assert.equal(folded.packages[0].remain, 0);
});

/* ------------------------------------------------------------------ *
 * Free model
 * ------------------------------------------------------------------ */

test("only an explicit x0.00 counts as free, and the largest window wins", () => {
  const models = [
    {
      id: "paid",
      name: "Paid",
      contextLength: 1_000_000,
      maxOutputTokens: 1000,
      creditMultiplier: 0.5,
    },
    {
      id: "free-small",
      name: "Free Small",
      contextLength: 192_000,
      maxOutputTokens: 1000,
      creditMultiplier: 0,
    },
    {
      id: "free-large",
      name: "Free Large",
      contextLength: 1_000_000,
      maxOutputTokens: 1000,
      creditMultiplier: 0,
    },
    { id: "unknown", name: "Unknown", contextLength: 2_000_000, maxOutputTokens: 1000 },
  ];
  assert.equal(selectWorkBuddyFreeModel(models)?.model.id, "free-large");
  assert.deepEqual(
    listWorkBuddyFreeModels(models).map((entry) => entry.model.id),
    ["free-small", "free-large"]
  );
  // A model with no declared rate is NOT free — it must not be recommended.
  assert.equal(selectWorkBuddyFreeModel([models[3]]), null);
});

test("cost ranking puts undeclared rates last, never first", () => {
  const ranked = rankWorkBuddyModelsByCost([
    { id: "unknown", name: "U", contextLength: 1, maxOutputTokens: 1 },
    { id: "cheap", name: "C", contextLength: 1, maxOutputTokens: 1, creditMultiplier: 0.1 },
    { id: "pricey", name: "P", contextLength: 1, maxOutputTokens: 1, creditMultiplier: 3 },
  ]);
  assert.deepEqual(
    ranked.map((model) => model.id),
    ["cheap", "pricey", "unknown"]
  );
});

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

test("the throttle reset time is read with its own UTC offset", () => {
  const iso = parseWorkBuddyRateLimitReset(
    '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，您也可以切换其他模型继续使用。"}'
  );
  // 02:30:30 at UTC+8 is 18:30:30 the previous day in UTC.
  assert.equal(iso, "2026-09-29T18:30:30.000Z");
  assert.equal(parseWorkBuddyRateLimitReset("no reset time here"), null);
});

test("failures are classified so the advice matches the cause", () => {
  assert.equal(classifyWorkBuddyFailure(402, ""), "hard_credit");
  assert.equal(classifyWorkBuddyFailure(400, "积分不足"), "hard_credit");
  assert.equal(classifyWorkBuddyFailure(401, "Offline user session not found"), "session_dead");
  assert.equal(classifyWorkBuddyFailure(400, '{"code":11140}'), "policy_reject");
  assert.equal(classifyWorkBuddyFailure(429, ""), "soft_rate");
  assert.equal(classifyWorkBuddyFailure(503, ""), "server");
});

/* ------------------------------------------------------------------ *
 * Request shape
 * ------------------------------------------------------------------ */

test("absent identity attributes use the X-No-* spelling", () => {
  const headers = buildWorkBuddyChatHeaders({ accessToken: "t", domain: "" });
  assert.equal(headers["X-No-User-Id"], "1");
  assert.equal(headers["X-No-Enterprise-Id"], "1");
  assert.equal(headers["X-No-Department-Info"], "1");
  assert.equal(headers["X-User-Id"], undefined);
  assert.equal(headers["X-Product"], "SaaS");
  // The CN chat call carries the billing origin, not the chat host.
  assert.equal(headers.Origin, WORKBUDDY_CN_BILLING_BASE);

  const identified = buildWorkBuddyChatHeaders({
    accessToken: "t",
    domain: "workbuddy.ai",
    uid: "u1",
    enterpriseId: "e1",
  });
  assert.equal(identified["X-User-Id"], "u1");
  assert.equal(identified["X-Enterprise-Id"], "e1");
  assert.equal(identified["X-Domain"], "workbuddy.ai");
  assert.equal(identified.Origin, WORKBUDDY_GLOBAL_BASE);
});

test("billing sends the tenant identity in both spellings", () => {
  const headers = buildWorkBuddyBillingHeaders({
    accessToken: "tok",
    domain: "codebuddy.ai",
    uid: "u9",
    enterpriseId: "ent9",
  });
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["X-Tenant-Id"], "ent9");
  assert.equal(headers["X-Enterprise-Id"], "ent9");
});

test("a body without a leading system message gets a minimal one", () => {
  const patched = ensureWorkBuddySystemHead({
    model: "glm-5.3",
    messages: [{ role: "user", content: "hi" }],
  }) as { messages: Array<{ role: string; content: string }> };
  assert.equal(patched.messages[0].role, "system");
  assert.equal(patched.messages[0].content, WORKBUDDY_FALLBACK_SYSTEM_PROMPT);
  assert.equal(patched.messages.length, 2);

  // An existing system head is left exactly as it was.
  const untouched = {
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  };
  assert.equal(ensureWorkBuddySystemHead(untouched), untouched);

  // A top-level system field (Anthropic shape) is folded into the messages array.
  const folded = ensureWorkBuddySystemHead({
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  }) as {
    messages: Array<{ role: string; content: string }>;
    system?: string;
  };
  assert.equal(folded.system, undefined);
  assert.equal(folded.messages[0].content, "sys");
});

test("a credential is built from the connection's own identity keys", () => {
  const credential = credentialFromWorkBuddyRequest({
    accessToken: "tok",
    refreshToken: "ref",
    providerSpecificData: {
      workbuddyDomain: "workbuddy.ai",
      workbuddyUid: "u1",
      workbuddyEnterpriseId: "e1",
    },
  });
  assert.equal(credential?.domain, "workbuddy.ai");
  assert.equal(credential?.uid, "u1");
  assert.equal(credential?.enterpriseId, "e1");
  // No token at all must be reported as missing, not sent as an anonymous request.
  assert.equal(credentialFromWorkBuddyRequest({ providerSpecificData: {} }), null);
});

/* ------------------------------------------------------------------ *
 * Desktop credential discovery
 * ------------------------------------------------------------------ */

test("auth directories follow the platform conventions", () => {
  const mac = workBuddyDesktopAuthDirs("darwin", "/Users/x", {});
  assert.deepEqual(mac, [
    "/Users/x/Library/Application Support/CodeBuddyExtension/Data/Public/auth",
  ]);
  const win = workBuddyDesktopAuthDirs("win32", "C:\\Users\\x", {
    LOCALAPPDATA: "L",
    APPDATA: "R",
  });
  assert.deepEqual(win, [
    path.join("L", "CodeBuddyExtension", "Data", "Public", "auth"),
    path.join("R", "CodeBuddyExtension", "Data", "Public", "auth"),
  ]);
  const linux = workBuddyDesktopAuthDirs("linux", "/home/x", {});
  assert.deepEqual(linux, ["/home/x/.config/CodeBuddyExtension/Data/Public/auth"]);
  // An explicit override wins over every platform default.
  assert.deepEqual(
    workBuddyDesktopAuthDirs("linux", "/home/x", { WORKBUDDY_AUTH_DIR: "/custom" }),
    ["/custom"]
  );
});

test("both the live auth file and its timestamped backups are recognised", () => {
  assert.equal(isWorkBuddyAuthFilename("workbuddy-desktop.info"), true);
  assert.equal(isWorkBuddyAuthFilename("workbuddy-desktop.1750000000000.info"), true);
  assert.equal(isWorkBuddyAuthFilename("workbuddy-desktop.json"), false);
  assert.equal(isWorkBuddyAuthFilename("config.json"), false);
});

test("both on-disk auth shapes parse, and encrypted tokens are named as such", () => {
  const nested = parseWorkBuddyAuthDocument(
    JSON.stringify({
      auth: {
        accessToken: "a",
        refreshToken: "r",
        domain: "workbuddy.ai",
        expiresAt: 1_800_000_000,
      },
      account: { uid: "u", uin: "1234567890", nickname: "Ada", enterpriseId: "e" },
    }),
    "/tmp/f"
  );
  assert.equal(nested.credential?.accessToken, "a");
  assert.equal(nested.credential?.domain, "workbuddy.ai");
  assert.equal(nested.credential?.uin, "1234567890");
  // Seconds-since-epoch is normalized to ms.
  assert.equal(nested.credential?.expiresAtMs, 1_800_000_000_000);

  const flat = parseWorkBuddyAuthDocument(JSON.stringify({ accessToken: "b" }), "/tmp/f");
  assert.equal(flat.credential?.accessToken, "b");

  // A Windows-style encrypted wrapper is reported as encrypted — never as "signed out",
  // because the user action that fixes it is different.
  const encrypted = parseWorkBuddyAuthDocument(
    JSON.stringify({ accessToken: { $wbEncrypted: 1, envelope: "AAAA" } }),
    "/tmp/f"
  );
  assert.equal(encrypted.credential, undefined);
  assert.equal(encrypted.reason, "encrypted");

  assert.equal(parseWorkBuddyAuthDocument("not json", "/tmp/f").reason, "not-json");
  assert.equal(parseWorkBuddyAuthDocument("{}", "/tmp/f").reason, "no-token");
});

test("discovery keeps the live sign-in first and de-duplicates accounts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-workbuddy-home-"));
  const authDir = path.join(
    home,
    "Library",
    "Application Support",
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth"
  );
  fs.mkdirSync(authDir, { recursive: true });

  const live = {
    auth: { accessToken: "live-token", refreshToken: "r1", domain: "" },
    account: { uid: "u1", uin: "1000000001", nickname: "Live" },
  };
  const backupSameAccount = {
    auth: { accessToken: "older-token", refreshToken: "r0", domain: "" },
    account: { uid: "u1", uin: "1000000001", nickname: "Live" },
  };
  const backupOtherAccount = {
    auth: { accessToken: "global-token", refreshToken: "r2", domain: "workbuddy.ai" },
    account: { uid: "u2", uin: "2000000002" },
  };
  fs.writeFileSync(path.join(authDir, "workbuddy-desktop.info"), JSON.stringify(live));
  fs.writeFileSync(
    path.join(authDir, "workbuddy-desktop.1700000000000.info"),
    JSON.stringify(backupSameAccount)
  );
  fs.writeFileSync(
    path.join(authDir, "workbuddy-desktop.1800000000000.info"),
    JSON.stringify(backupOtherAccount)
  );
  fs.writeFileSync(path.join(authDir, "unrelated.json"), "{}");

  const discovery = await discoverWorkBuddyCredentials({ platform: "darwin", home, env: {} });

  // Two accounts: the duplicate uin is reported once (the live file wins).
  assert.equal(discovery.credentials.length, 2);
  const cn = discovery.credentials.find((entry) => entry.edition.region === "cn");
  assert.equal(cn?.credential.accessToken, "live-token");
  assert.equal(cn?.accountLabel, "Live");
  const global = discovery.credentials.find((entry) => entry.edition.region === "global");
  assert.equal(global?.edition.providerId, "workbuddy-global");
  // No nickname → the account number is masked, never printed whole.
  assert.equal(global?.accountLabel, "200****02");
  assert.ok(
    !JSON.stringify(discovery.credentials.map((entry) => entry.accountLabel)).includes("2000000002")
  );

  const skipped = discovery.probes.find((probe) => probe.path.endsWith("unrelated.json"));
  assert.equal(skipped, undefined, "unrelated files are not probed at all");

  fs.rmSync(home, { recursive: true, force: true });
});

test("discovery reports an unreadable encrypted file instead of an empty machine", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-workbuddy-enc-"));
  const authDir = path.join(home, ".config", "CodeBuddyExtension", "Data", "Public", "auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, "workbuddy-desktop.info"),
    JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: "x" } } })
  );

  const discovery = await discoverWorkBuddyCredentials({ platform: "linux", home, env: {} });
  assert.equal(discovery.credentials.length, 0);
  assert.equal(discovery.probes.length, 1);
  assert.equal(discovery.probes[0].reason, "encrypted");
  assert.equal(discovery.probes[0].ok, false);

  fs.rmSync(home, { recursive: true, force: true });
});

test("a fingerprint is stable per account and changes with the token", () => {
  const base = { accessToken: "t1", domain: "", uin: "42" };
  assert.equal(fingerprintWorkBuddyCredential(base), fingerprintWorkBuddyCredential({ ...base }));
  assert.notEqual(
    fingerprintWorkBuddyCredential(base),
    fingerprintWorkBuddyCredential({ ...base, accessToken: "t2" })
  );
  assert.match(fingerprintWorkBuddyCredential(base), /^[0-9a-f]{16}$/);
  assert.equal(workBuddyAccountLabel(base), "42");
});

/* ------------------------------------------------------------------ *
 * Self-description
 * ------------------------------------------------------------------ */

test("the addon describes its capabilities, editions and limits", () => {
  const info = describeWorkBuddyAddon();
  assert.equal(info.providers.length, 2);
  const ids = info.capabilities.map((capability) => capability.id);
  for (const expected of [
    "models",
    "credits",
    "checkin",
    "free-model",
    "accounts",
    "chat",
    "info",
  ]) {
    assert.ok(ids.includes(expected), `capability ${expected} missing`);
  }
  // The claim is the only capability that changes upstream state; anything else marked as
  // mutating would be a lie the UI would repeat.
  const mutating = info.capabilities
    .filter((capability) => capability.mutates)
    .map((capability) => capability.id);
  assert.deepEqual(mutating, ["checkin"]);
  assert.ok(info.guarantees.some((line) => line.includes("read-only")));
  // The no-auto-check-in promise and the "cannot decrypt" refusal are the two limits an
  // operator is most likely to assume away, so both must be stated explicitly.
  assert.ok(info.guarantees.some((line) => line.includes("No automatic check-in")));
  assert.ok(info.nonGoals.some((line) => line.includes("Decrypting")));
});
