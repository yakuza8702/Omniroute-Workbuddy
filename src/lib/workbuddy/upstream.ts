/**
 * WorkBuddy addon — upstream client.
 *
 * One module owns every call the addon makes to WorkBuddy: the model directory,
 * the credit meter, the daily check-in, and token refresh. Chat traffic does not go
 * through here — the executor builds that request — but the header set is shared
 * ({@link buildWorkBuddyChatHeaders}) so a request path and a metadata path can never
 * disagree about how this gateway wants to be addressed.
 *
 * Failure contract: every function throws {@link WorkBuddyUpstreamError} carrying only
 * a status, the upstream business code and a bounded, sanitized message — the raw
 * response body never escapes this module, so a route can pass `error.message`
 * straight through `sanitizeErrorMessage()` without leaking an upstream HTML page or a
 * request id into a client response.
 *
 * @module lib/workbuddy/upstream
 */

import {
  WORKBUDDY_CHAT_PATH,
  WORKBUDDY_CHECKIN_CLAIM_PATH,
  WORKBUDDY_CHECKIN_STATUS_PATH,
  WORKBUDDY_CLIENT_USER_AGENT,
  WORKBUDDY_CONNECTION_KEYS,
  WORKBUDDY_CREDIT_PRODUCT_CODE,
  WORKBUDDY_CREDITS_PATH,
  WORKBUDDY_DESKTOP_USER_AGENT,
  WORKBUDDY_GLOBAL_CONFIG_PATH,
  WORKBUDDY_JSON_TIMEOUT_MS,
  WORKBUDDY_MODELS_PATH,
  WORKBUDDY_REFRESH_PATH,
  resolveWorkBuddyRegion,
  resolveWorkBuddyGlobalBase,
  workBuddyBillingBase,
  workBuddyChatBase,
  type WorkBuddyCheckinClaim,
  type WorkBuddyCheckinStatus,
  type WorkBuddyCredential,
  type WorkBuddyCreditPackage,
  type WorkBuddyCredits,
  type WorkBuddyModel,
  type WorkBuddyModelReasoning,
} from "./types";

/** Bounded slice of an upstream error body kept for classification, never re-served. */
const ERROR_BODY_LIMIT = 4096;

/** Upstream answered something the addon cannot use. */
export class WorkBuddyUpstreamError extends Error {
  readonly status: number;
  readonly upstreamCode: number | null;

  constructor(message: string, status: number, upstreamCode: number | null = null) {
    super(message);
    this.name = "WorkBuddyUpstreamError";
    this.status = status;
    this.upstreamCode = upstreamCode;
  }
}

/** Envelope every WorkBuddy endpoint answers with. */
interface WorkBuddyEnvelope {
  code: number;
  msg: string;
  data: unknown;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read the `{ code, msg, data }` envelope. A body that is not JSON (an openresty HTML
 * 401, an empty 204) becomes a synthetic non-zero envelope rather than an exception, so
 * every caller classifies failures on one path.
 */
export async function readWorkBuddyEnvelope(response: Response): Promise<WorkBuddyEnvelope> {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: response.ok ? 0 : response.status, msg: "", data: undefined };
  }
  const record = asRecord(parsed);
  return {
    code: typeof record.code === "number" ? record.code : response.ok ? 0 : response.status,
    msg: typeof record.msg === "string" ? record.msg : "",
    data: record.data,
  };
}

/** Turn a non-zero envelope into a bounded, sanitized error. */
function envelopeError(response: Response, envelope: WorkBuddyEnvelope, what: string): never {
  const detail = envelope.msg.slice(0, 160);
  const suffix = detail ? `: ${detail}` : "";
  throw new WorkBuddyUpstreamError(
    `${what} failed (http ${response.status}${envelope.code ? `, code ${envelope.code}` : ""})${suffix}`,
    response.status,
    envelope.code || null
  );
}

/* ------------------------------------------------------------------ *
 * Header sets
 * ------------------------------------------------------------------ */

/** Headers every upstream request shares. */
export function buildWorkBuddyCommonHeaders(credential: WorkBuddyCredential): JsonRecord {
  const origin = workBuddyBillingBase(credential.domain);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": WORKBUDDY_CLIENT_USER_AGENT,
  };
}

/**
 * Chat headers, including the `X-No-*` conventions the official client uses to say
 * "this account has no such attribute" (an absent user id is not the same as an empty
 * one to this gateway).
 */
export function buildWorkBuddyChatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...(buildWorkBuddyCommonHeaders(credential) as Record<string, string>),
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "X-Product": "SaaS",
  };
  if (credential.uid) headers["X-User-Id"] = credential.uid;
  else headers["X-No-User-Id"] = "1";
  if (credential.enterpriseId) headers["X-Enterprise-Id"] = credential.enterpriseId;
  else headers["X-No-Enterprise-Id"] = "1";
  if (credential.domain) headers["X-Domain"] = credential.domain;
  else headers["X-No-Department-Info"] = "1";
  return headers;
}

/** Billing headers: bearer token, plus the account/tenant identity when known. */
export function buildWorkBuddyBillingHeaders(
  credential: WorkBuddyCredential
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.uid) headers["X-User-Id"] = credential.uid;
  if (credential.enterpriseId) {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }
  if (credential.domain) headers["X-Domain"] = credential.domain;
  return headers;
}

/** Refresh headers — `X-Refresh-Token` appears here and nowhere else. */
export function buildWorkBuddyRefreshHeaders(
  credential: WorkBuddyCredential
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(buildWorkBuddyCommonHeaders(credential) as Record<string, string>),
    "X-Refresh-Token": credential.refreshToken ?? "",
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (credential.enterpriseId) headers["X-Enterprise-Id"] = credential.enterpriseId;
  return headers;
}

/**
 * Build a WorkBuddy credential from the request-scoped credentials the executor gets.
 *
 * The account identity travels in `providerSpecificData` (see
 * `WORKBUDDY_CONNECTION_KEYS`), because the gateway needs `X-Domain`/`X-User-Id` on the
 * wire and those are per-connection, not per-provider — a static header table could not
 * carry them. A `null` return means "no token at all", which the executor reports as a
 * configuration error rather than sending an anonymous request the upstream would
 * answer with an HTML 401.
 */
export function credentialFromWorkBuddyRequest(source: unknown): WorkBuddyCredential | null {
  if (!source || typeof source !== "object") return null;
  const record = source as JsonRecord;
  const accessToken =
    (typeof record.accessToken === "string" && record.accessToken !== ""
      ? record.accessToken
      : undefined) ??
    (typeof record.apiKey === "string" && record.apiKey !== "" ? record.apiKey : undefined);
  if (!accessToken) return null;

  const psd = asRecord(record.providerSpecificData);
  const domain =
    typeof psd[WORKBUDDY_CONNECTION_KEYS.domain] === "string"
      ? (psd[WORKBUDDY_CONNECTION_KEYS.domain] as string)
      : "";
  const uid = asString(psd[WORKBUDDY_CONNECTION_KEYS.uid]);
  const enterpriseId = asString(psd[WORKBUDDY_CONNECTION_KEYS.enterpriseId]);
  return {
    accessToken,
    refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : "",
    domain,
    ...(uid === undefined ? {} : { uid }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    source: "connection",
  };
}

/* ------------------------------------------------------------------ *
 * Parsers (pure — exported for tests and reused by the catalogue sync)
 * ------------------------------------------------------------------ */

/**
 * Parse the upstream's `credits` string into a multiplier.
 *
 * Observed forms: `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`, or absent. An
 * unparsable value yields `undefined` rather than a guess, so the UI omits the rate
 * instead of displaying a fabricated one.
 */
export function parseWorkBuddyCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Effort levels the upstream declares across both gateways. */
const SINGULAR_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The singular spelling of reasoning metadata: `effort` plus none of the plural-form
 * fields. Both gateways also accept the whole ladder on these models, so the declared
 * value is a DEFAULT, never the model's only level.
 */
export function isSingularWorkBuddyEffortForm(raw: JsonRecord): boolean {
  return (
    typeof raw.effort === "string" &&
    !Array.isArray(raw.supportedEfforts) &&
    typeof raw.defaultEffort !== "string" &&
    typeof raw.canDisableThinking !== "boolean"
  );
}

/** Parse the upstream `reasoning` object; unknown shapes degrade to `undefined`. */
export function parseWorkBuddyReasoning(value: unknown): WorkBuddyModelReasoning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as JsonRecord;
  const effort = asString(raw.effort);
  const declared = Array.isArray(raw.supportedEfforts)
    ? raw.supportedEfforts.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const supportedEfforts =
    declared && declared.length > 0
      ? declared
      : effort === undefined
        ? undefined
        : SINGULAR_EFFORT_LADDER.includes(effort as (typeof SINGULAR_EFFORT_LADDER)[number])
          ? [...SINGULAR_EFFORT_LADDER]
          : [effort];
  const defaultEffort = asString(raw.defaultEffort) ?? effort;
  const canDisableThinking =
    typeof raw.canDisableThinking === "boolean"
      ? raw.canDisableThinking
      : isSingularWorkBuddyEffortForm(raw)
        ? true
        : undefined;
  if (!supportedEfforts && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined;
  }
  return {
    ...(supportedEfforts ? { supportedEfforts } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(canDisableThinking === undefined ? {} : { canDisableThinking }),
  };
}

/**
 * Parse one catalogue entry. Entries without usable token limits — or explicitly
 * disabled server-side — are dropped rather than served with a fabricated window.
 */
export function parseWorkBuddyModel(value: unknown): WorkBuddyModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as JsonRecord;
  const id = asString(raw.id);
  if (!id || raw.disabled === true) return undefined;

  const contextLength = asNumber(raw.maxInputTokens) ?? 0;
  const maxOutputTokens = asNumber(raw.maxOutputTokens) ?? 0;
  if (contextLength <= 0 || maxOutputTokens <= 0) return undefined;

  const creditMultiplier = parseWorkBuddyCreditMultiplier(raw.credits);
  const reasoning = parseWorkBuddyReasoning(raw.reasoning);
  const supportsToolCall =
    typeof raw.supportsToolCall === "boolean" ? raw.supportsToolCall : undefined;
  const supportsVision =
    raw.disabledMultimodal === true
      ? false
      : typeof raw.supportsImages === "boolean"
        ? raw.supportsImages
        : undefined;

  return {
    id,
    name: asString(raw.name) ?? id,
    contextLength,
    maxOutputTokens,
    ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(supportsToolCall === undefined ? {} : { supportsToolCall }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(asString(raw.descriptionZh) === undefined
      ? {}
      : { descriptionZh: asString(raw.descriptionZh) }),
    ...(asString(raw.descriptionEn) === undefined
      ? {}
      : { descriptionEn: asString(raw.descriptionEn) }),
  };
}

/**
 * Select the chat-capable models from a catalogue-shaped document.
 *
 * Both the domestic personal-models document and the global `/v3/config` document
 * carry `models` plus an `agents` roster with the same entry shape, so one selector
 * serves both. The `cli` roster's order is preserved when present; without a usable
 * roster the whole parsed catalogue is exposed instead of nothing, because the roster
 * is an upstream detail that may change and an empty answer would silently disarm the
 * provider.
 */
export function selectWorkBuddyCatalogModels(
  rawModels: unknown,
  agents: unknown
): WorkBuddyModel[] {
  const byId = new Map<string, WorkBuddyModel>();
  const list = Array.isArray(rawModels) ? rawModels : [];
  for (const entry of list) {
    const parsed = parseWorkBuddyModel(entry);
    if (parsed) byId.set(parsed.id, parsed);
  }

  let cliIds: string[] | undefined;
  for (const agent of Array.isArray(agents) ? agents : []) {
    const record = asRecord(agent);
    if (record.name === "cli" && Array.isArray(record.models)) {
      cliIds = record.models.filter((id): id is string => typeof id === "string");
      break;
    }
  }

  const order = cliIds && cliIds.length > 0 ? cliIds : [...byId.keys()];
  return order
    .map((id) => byId.get(id))
    .filter((model): model is WorkBuddyModel => model !== undefined);
}

/** Timestamp from either an ISO string or a seconds/milliseconds epoch number. */
function parseWorkBuddyTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && value > 1e12) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** Format one `YYYY-MM-DD HH:mm:ss` local stamp, the shape the billing filter wants. */
function formatWorkBuddyStamp(date: Date): string {
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time}`;
}

/** Credits expiring within this window are reported as "worth spending first". */
const EXPIRING_SOON_MS = 72 * 60 * 60 * 1000;

/**
 * Fold the billing document into a per-package overview.
 *
 * Packages are kept separate on purpose: the dashboard groups recurring packages
 * itself and lists the nearest-expiring one-off packages, so aggregating here would
 * lose the dates it needs. `CapacityType === 4` marks a recurring (cycle) package —
 * its live numbers live in the `Cycle*` fields and its cycle end is a refresh, not an
 * expiry; every other package is a one-off whose remaining balance is authoritative.
 */
export function foldWorkBuddyCreditPackages(rawAccounts: unknown): WorkBuddyCredits {
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
  const packages: WorkBuddyCreditPackage[] = [];
  let total = 0;
  let expiringSoon = 0;
  let nearestExpiryMs: number | undefined;

  for (const raw of accounts) {
    const account = asRecord(raw);
    if (Object.keys(account).length === 0) continue;
    const numberField = (key: string) => asNumber(account[key]) ?? 0;

    const monthly = numberField("CapacityType") === 4;
    const size = monthly ? numberField("CycleCapacitySize") : numberField("CapacitySize");
    const remain = monthly ? numberField("CycleCapacityRemain") : numberField("CapacityRemain");
    const cappedRemain = remain < 0 ? 0 : remain;

    const cycleEndMs = parseWorkBuddyTimestamp(account.CycleEndTime);
    const expiresAtMs = monthly
      ? undefined
      : (parseWorkBuddyTimestamp(account.ExpiredTime) ?? cycleEndMs);
    const refreshAtMs = monthly && cycleEndMs !== undefined ? cycleEndMs + 1000 : undefined;

    // A spent or expired one-off package contributes nothing; a recurring one always
    // reports its current cycle's remaining balance.
    if (
      !monthly &&
      (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))
    ) {
      continue;
    }

    total += cappedRemain;
    if (expiresAtMs !== undefined) {
      if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs)
        nearestExpiryMs = expiresAtMs;
      if (expiresAtMs - Date.now() <= EXPIRING_SOON_MS) expiringSoon += cappedRemain;
    }

    packages.push({
      packageName: asString(account.PackageName) ?? "(unnamed)",
      remain: cappedRemain,
      size,
      monthly,
      ...(refreshAtMs === undefined ? {} : { refreshAtMs }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    });
  }

  return {
    total,
    packages,
    expiringSoon,
    ...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }),
  };
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Read the model directory for a credential's edition.
 *
 * Both editions answer the same entry shape but through different documents, and the
 * global gateway additionally needs the desktop channel's user agent to list the
 * account's real chat roster (see `WORKBUDDY_DESKTOP_USER_AGENT`).
 */
export async function fetchWorkBuddyModels(
  credential: WorkBuddyCredential,
  options: { signal?: AbortSignal } = {}
): Promise<WorkBuddyModel[]> {
  const global = resolveWorkBuddyRegion(credential.domain) === "global";
  const url = global
    ? `${resolveWorkBuddyGlobalBase(credential.domain)}${WORKBUDDY_GLOBAL_CONFIG_PATH}`
    : `${workBuddyChatBase(credential.domain)}${WORKBUDDY_MODELS_PATH}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
  };
  if (global) {
    if (credential.uid) headers["X-User-Id"] = credential.uid;
    if (credential.domain) headers["X-Domain"] = credential.domain;
    headers["X-Product"] = "SaaS";
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers.Connection = "close";
    headers["User-Agent"] = WORKBUDDY_DESKTOP_USER_AGENT;
  } else {
    const origin = workBuddyBillingBase(credential.domain);
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
    headers["User-Agent"] = WORKBUDDY_CLIENT_USER_AGENT;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: options.signal ?? AbortSignal.timeout(WORKBUDDY_JSON_TIMEOUT_MS),
  });
  const envelope = await readWorkBuddyEnvelope(response);
  if (!response.ok || envelope.code !== 0)
    envelopeError(response, envelope, "WorkBuddy model directory");

  const data = asRecord(envelope.data);
  const models = selectWorkBuddyCatalogModels(data.models, data.agents);
  if (models.length === 0) {
    throw new WorkBuddyUpstreamError(
      "WorkBuddy model directory resolved to an empty list",
      response.status,
      envelope.code || null
    );
  }
  return models;
}

/** Read every credit package for a credential, keeping packages separate. */
export async function fetchWorkBuddyCredits(
  credential: WorkBuddyCredential
): Promise<WorkBuddyCredits> {
  const now = new Date();
  const response = await fetch(
    `${workBuddyBillingBase(credential.domain)}${WORKBUDDY_CREDITS_PATH}`,
    {
      method: "POST",
      headers: buildWorkBuddyBillingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: WORKBUDDY_CREDIT_PRODUCT_CODE,
        Status: [0, 3],
        PackageEndTimeRangeBegin: formatWorkBuddyStamp(now),
        // The upstream wants a bounded window; the reference client asks for 100 years.
        PackageEndTimeRangeEnd: formatWorkBuddyStamp(new Date(now.getTime() + 3_185_136_000_000)),
      }),
      signal: AbortSignal.timeout(WORKBUDDY_JSON_TIMEOUT_MS),
    }
  );
  const envelope = await readWorkBuddyEnvelope(response);
  if (!response.ok || envelope.code !== 0)
    envelopeError(response, envelope, "WorkBuddy credit query");

  const wrapper = asRecord(envelope.data);
  const inner = asRecord(asRecord(wrapper.Response).Data);
  return foldWorkBuddyCreditPackages(inner.Accounts);
}

/** Read today's check-in state without mutating the account. */
export async function fetchWorkBuddyCheckinStatus(
  credential: WorkBuddyCredential
): Promise<WorkBuddyCheckinStatus> {
  const response = await fetch(
    `${workBuddyBillingBase(credential.domain)}${WORKBUDDY_CHECKIN_STATUS_PATH}`,
    {
      method: "POST",
      headers: buildWorkBuddyBillingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(WORKBUDDY_JSON_TIMEOUT_MS),
    }
  );
  const envelope = await readWorkBuddyEnvelope(response);
  if (!response.ok || envelope.code !== 0)
    envelopeError(response, envelope, "WorkBuddy check-in status");

  const data = asRecord(envelope.data);
  const numberField = (key: string) => asNumber(data[key]) ?? 0;
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: numberField("streak_days"),
    dailyCredit: numberField("daily_credit"),
    todayCredit: numberField("today_credit"),
    isStreakDay: data.is_streak_day === true,
    nextStreakDay: numberField("next_streak_day"),
    streakBonusDays: numberField("streak_bonus_days"),
    streakBonusCredit: numberField("streak_bonus_credit"),
    ...(asString(data.claim_button_text) === undefined
      ? {}
      : { claimButtonText: asString(data.claim_button_text) }),
  };
}

/**
 * Claim today's check-in reward.
 *
 * The mutation is issued only after {@link fetchWorkBuddyCheckinStatus} reported the day
 * as unclaimed — the caller owns that guard, because a blind POST would re-claim (and
 * the upstream's own idempotency is not something this addon should bet credits on).
 */
export async function claimWorkBuddyDailyCheckin(
  credential: WorkBuddyCredential
): Promise<WorkBuddyCheckinClaim> {
  const response = await fetch(
    `${workBuddyBillingBase(credential.domain)}${WORKBUDDY_CHECKIN_CLAIM_PATH}`,
    {
      method: "POST",
      headers: buildWorkBuddyBillingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(WORKBUDDY_JSON_TIMEOUT_MS),
    }
  );
  const envelope = await readWorkBuddyEnvelope(response);
  if (!response.ok || envelope.code !== 0)
    envelopeError(response, envelope, "WorkBuddy check-in claim");

  const data = asRecord(envelope.data);
  return {
    credit: asNumber(data.credit) ?? 0,
    streakDays: asNumber(data.streak_days) ?? 0,
    isStreakDay: data.is_streak_day === true,
  };
}

/** Token-refresh outcome; the caller merges it into the stored connection. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}

/** Exchange a refresh token for a new access token (`X-Refresh-Token` header). */
export async function refreshWorkBuddyAccessToken(
  credential: WorkBuddyCredential
): Promise<WorkBuddyRefreshOutcome> {
  const response = await fetch(`${workBuddyChatBase(credential.domain)}${WORKBUDDY_REFRESH_PATH}`, {
    method: "POST",
    headers: buildWorkBuddyRefreshHeaders(credential),
    signal: AbortSignal.timeout(WORKBUDDY_JSON_TIMEOUT_MS),
  });
  const envelope = await readWorkBuddyEnvelope(response);
  if (!response.ok || envelope.code !== 0)
    envelopeError(response, envelope, "WorkBuddy token refresh");

  const data = asRecord(envelope.data);
  const accessToken = asString(data.accessToken);
  if (!accessToken) {
    throw new WorkBuddyUpstreamError(
      "WorkBuddy token refresh returned no access token; sign in again in the WorkBuddy app",
      response.status,
      envelope.code || null
    );
  }
  return {
    accessToken,
    ...(asString(data.refreshToken) === undefined
      ? {}
      : { refreshToken: asString(data.refreshToken) }),
    ...(asNumber(data.expiresIn) === undefined ? {} : { expiresInSec: asNumber(data.expiresIn) }),
    ...(asString(data.domain) === undefined ? {} : { domain: asString(data.domain) }),
  };
}

/**
 * Stand-in system message for a chat body that reached the wire carrying none.
 *
 * Both gateways want the conversation to OPEN with a system message, and the
 * international one enforces it: a user-first body is refused with business code 11128
 * ("first message is not system prompt"), which the gateway surfaces as "blocked by
 * security policy" — the domestic gateway tolerates the same body, so the fault only
 * shows up on the global route. The placeholder is deliberately tiny: inventing a
 * longer persona would quietly change model behaviour on every affected request.
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * Ensure a chat body opens with a `system` message, in place on a copy.
 *
 * Handles both shapes the translator can emit: a `messages` array (OpenAI) and a
 * top-level `system` field (Anthropic, folded back by the translator).
 */
export function ensureWorkBuddySystemHead(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = { ...(body as JsonRecord) };

  if (typeof out.system === "string" && out.system !== "") {
    const { system, ...rest } = out;
    return {
      ...rest,
      messages: [
        { role: "system", content: system },
        ...(Array.isArray(out.messages) ? out.messages : []),
      ],
    };
  }

  const messages = Array.isArray(out.messages) ? out.messages : null;
  if (!messages) return body;
  const first = messages[0];
  const firstRole =
    first && typeof first === "object" && !Array.isArray(first)
      ? (first as JsonRecord).role
      : undefined;
  if (firstRole === "system") return body;
  return {
    ...out,
    messages: [{ role: "system", content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT }, ...messages],
  };
}

/** The chat URL for a credential (used by the executor and by probe helpers). */
export function workBuddyChatUrl(domain: string | undefined | null): string {
  return `${workBuddyChatBase(domain)}${WORKBUDDY_CHAT_PATH}`;
}

/**
 * Rewrite `tool_choice` into the string spelling the gateway accepts.
 *
 * Mirrors the reference client (`dsh-connect-workbuddy`, `normalizeToolChoice`): the
 * upstream's field is a STRING, so OpenAI object forms reach it as a 400 —
 * `{type:"auto"}` must become `"auto"`, a pinned function must become the bare name, and
 * `"none"` must drop `tool_choice` AND the declarations it negates (`tools`/`functions`),
 * because this gateway rejects the `"none"` spelling outright rather than ignoring it.
 * Anything unrecognised is deleted: forwarding an unknown shape can only 400.
 */
function normalizeWorkBuddyToolChoice(out: JsonRecord): JsonRecord {
  if (!("tool_choice" in out)) return out;
  const withoutTools = (): JsonRecord => {
    const { tools: _tools, functions: _functions, tool_choice: _choice, ...rest } = out;
    return rest;
  };
  const choice = out.tool_choice;

  if (typeof choice === "string") {
    return choice.trim().toLowerCase() === "none" ? withoutTools() : out;
  }
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const wrapped = choice as JsonRecord;
    const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : "";
    if (type === "none") return withoutTools();
    if (type === "auto" || type === "required") return { ...out, tool_choice: type };
    if (type === "function" || type === "tool") {
      const fn =
        wrapped.function && typeof wrapped.function === "object" && !Array.isArray(wrapped.function)
          ? (wrapped.function as JsonRecord)
          : undefined;
      const rawName =
        typeof fn?.name === "string"
          ? fn.name
          : typeof wrapped.name === "string"
            ? wrapped.name
            : "";
      const name = rawName.trim();
      return { ...out, tool_choice: name === "" ? "auto" : name };
    }
    const { tool_choice: _dropped, ...rest } = out;
    return rest;
  }
  const { tool_choice: _invalid, ...rest } = out;
  return rest;
}

/**
 * Everything the WorkBuddy gateways require of a chat body, in one place.
 *
 * The reference client (`dsh-connect-workbuddy`, `prepareChatBody`) is the contract here,
 * and each rule exists because the gateway enforces it:
 *
 *  1. `stream: true` — the upstream rejects a non-streaming request; the platform
 *     re-aggregates the SSE it gets back, so a JSON-asking client still works.
 *  2. `developer` → `system` — the OpenAI-format route preserves `developer` by default,
 *     and this gateway does not know the role.
 *  3. a leading `system` message (see {@link ensureWorkBuddySystemHead}).
 *  4. `tool_choice` flattened to its string form (see {@link normalizeWorkBuddyToolChoice}).
 *
 * Applied AFTER translation, so it sees the body that actually goes on the wire.
 */
export function prepareWorkBuddyChatBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const withStream: JsonRecord = { ...(body as JsonRecord), stream: true };

  if (Array.isArray(withStream.messages)) {
    withStream.messages = withStream.messages.map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return message;
      const entry = message as JsonRecord;
      if (typeof entry.role !== "string" || entry.role.trim().toLowerCase() !== "developer") {
        return message;
      }
      return { ...entry, role: "system" };
    });
  }

  const withHead = ensureWorkBuddySystemHead(withStream);
  if (!withHead || typeof withHead !== "object" || Array.isArray(withHead)) return withHead;
  return normalizeWorkBuddyToolChoice(withHead as JsonRecord);
}

/**
 * Reset instant carried in WorkBuddy's throttle message, as an ISO string.
 *
 * The gateway answers HTTP 429 with a business body and NO `Retry-After` header:
 *
 *   {"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，…"}
 *
 * The offset in that sentence is part of the timestamp — parsing it as local time would
 * shift the reported recovery instant by the host's own zone, so the offset is applied
 * explicitly through `Date.UTC`. Unparsable messages yield `null`: a fabricated
 * countdown is worse than admitting the upstream did not say.
 */
export function parseWorkBuddyRateLimitReset(body: string): string | null {
  const match =
    /将在?\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\s*([+-])(\d{1,2})(?::?(\d{2}))?[\s\S]*?重置/u.exec(
      body
    );
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  const offsetSign = sign === "-" ? -1 : 1;
  const offset = offsetSign * (Number(offsetHours) * 60 + Number(offsetMinutes ?? "0"));
  const utcMs =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ) -
    offset * 60_000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** How an upstream failure should be treated by callers. */
export type WorkBuddyFailureKind =
  | "hard_credit"
  | "session_dead"
  | "policy_reject"
  | "soft_rate"
  | "not_found"
  | "server"
  | "client";

/** Markers that mean the account has no credits left (ASCII + the original Chinese). */
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
];

/** Markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];

/** Content-policy refusals; the quoted-key form avoids id-substring false positives. */
const POLICY_REJECT_MARKERS = ["request illegal", '"code":11140'];

/**
 * Classify an upstream failure from its status and body excerpt.
 *
 * The distinction is what the caller acts on: `hard_credit` should stop retrying this
 * account, `session_dead` should tell the user to sign in again rather than to top up,
 * and `soft_rate` is worth a later retry. Collapsing them into "failed" would make the
 * addon advise the wrong fix.
 */
export function classifyWorkBuddyFailure(status: number, body: string): WorkBuddyFailureKind {
  if (status === 402) return "hard_credit";
  const lower = body.toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
  }
  for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
  for (const marker of POLICY_REJECT_MARKERS) if (body.includes(marker)) return "policy_reject";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}

export const __testing = {
  asRecord,
  asString,
  asNumber,
  parseWorkBuddyTimestamp,
  formatWorkBuddyStamp,
  ERROR_BODY_LIMIT,
  EXPIRING_SOON_MS,
  HARD_CREDIT_MARKERS,
  SESSION_DEAD_MARKERS,
  POLICY_REJECT_MARKERS,
};
