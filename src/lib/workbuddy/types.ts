/**
 * WorkBuddy addon — editions, regions and the shared upstream contract.
 *
 * WorkBuddy (Tencent) ships as TWO independent products behind one addon:
 *
 *   - `workbuddy`        — 国内版, hosted on the Tencent CodeBuddy stack
 *                          (`copilot.tencent.com` chat, `www.codebuddy.cn` billing).
 *   - `workbuddy-global` — 国际版, hosted on the WorkBuddy stack
 *                          (`www.workbuddy.ai`, with `www.codebuddy.ai` serving the
 *                          same international accounts signed in through the CodeBuddy CLI).
 *
 * The two editions are NOT interchangeable: an account signed in on one gateway is
 * rejected by the other, their model rosters differ, and only the domestic edition
 * has a daily check-in. Everything edition-specific therefore lives behind
 * {@link resolveWorkBuddyEdition} rather than in call sites.
 *
 * Endpoints, header names and payload shapes below are the ones the first-party
 * clients use (cross-checked against the `dsh-connect-workbuddy` reference
 * integration's bundled upstream client, whose endpoints were verified against
 * live accounts). This module is pure data + pure functions: no I/O, no DB, so it
 * can be imported from routes, executors and tests without side effects.
 *
 * @module lib/workbuddy/types
 */

/** The two WorkBuddy products. Region is derived from the credential's own domain. */
export type WorkBuddyRegion = "cn" | "global";

/** OmniRoute provider id for each edition. */
export const WORKBUDDY_PROVIDER_ID = "workbuddy";
export const WORKBUDDY_GLOBAL_PROVIDER_ID = "workbuddy-global";

/** Chat gateway of the domestic edition. */
export const WORKBUDDY_CN_CHAT_BASE = "https://copilot.tencent.com";
/** Billing/credit gateway of the domestic edition. */
export const WORKBUDDY_CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Chat + billing gateway of the international edition (desktop sign-in). */
export const WORKBUDDY_GLOBAL_BASE = "https://www.workbuddy.ai";
/**
 * Second international brand domain. An account signed in through the CodeBuddy CLI
 * lives here, and its token is rejected by `www.workbuddy.ai` (and vice versa), so
 * the gateway must follow the credential's own domain instead of a fixed host.
 */
export const WORKBUDDY_GLOBAL_ALT_BASE = "https://www.codebuddy.ai";

/** Chat path shared by both gateways. */
export const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";
/** Token-refresh path (refresh token travels in the `X-Refresh-Token` header). */
export const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** Domestic model directory (the legacy `/console/...` alias answers the same bytes). */
export const WORKBUDDY_MODELS_PATH = "/v2/enterprises/personal/models";
/**
 * International model directory. The `/v2/enterprises/personal/models` path returns
 * HTTP 500 on the global gateway, and the CLI-channel product config omits chat-usable
 * models, so the global edition reads the desktop channel's config document instead
 * (see {@link WORKBUDDY_DESKTOP_USER_AGENT}).
 */
export const WORKBUDDY_GLOBAL_CONFIG_PATH = "/v3/config";

/** Billing paths (differ by HTTP verb only). */
export const WORKBUDDY_CREDITS_PATH = "/v2/billing/meter/get-user-resource";
export const WORKBUDDY_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
export const WORKBUDDY_CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";

/** The product code the billing endpoint filters credit packages by. */
export const WORKBUDDY_CREDIT_PRODUCT_CODE = "p_tcaca";

/** User agent of the official client (CLI channel). */
export const WORKBUDDY_CLIENT_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
 * User agent of the WorkBuddy desktop app.
 *
 * The product-config service serves a DIFFERENT document per client channel, selected
 * by this product token (the version suffix is ignored). On the international gateway
 * that split decides which models exist at all: the CLI channel omits free chat models
 * that the desktop channel lists, so the global catalogue is read as the desktop app.
 */
export const WORKBUDDY_DESKTOP_USER_AGENT = "WorkBuddy/5.5.2";

/** Network ceilings. Metadata calls are short; the chat path is not bounded here. */
export const WORKBUDDY_JSON_TIMEOUT_MS = 30_000;

/** One WorkBuddy credential, region-agnostic. */
export interface WorkBuddyCredential {
  accessToken: string;
  refreshToken?: string;
  /** Login domain as recorded by the client; decides the region and the gateway. */
  domain: string;
  /** Account user id (`uid`), sent as `X-User-Id`. */
  uid?: string;
  /** Enterprise/tenant id, sent as `X-Enterprise-Id` + `X-Tenant-Id` on billing. */
  enterpriseId?: string;
  /** Display name, when the auth document carries one. */
  nickname?: string;
  /** Account number (`uin`), used for de-duplication and masked display. */
  uin?: string;
  /** Access-token expiry (ms since epoch), 0 when the document does not say. */
  expiresAtMs?: number;
  /** Where the credential came from, for the addon's status surface. */
  source?: "desktop" | "connection" | "manual";
  /** Auth file the credential was read from, when it came from the desktop app. */
  filePath?: string;
}

/** Reasoning metadata declared per model by the upstream catalogue. */
export interface WorkBuddyModelReasoning {
  supportedEfforts?: string[];
  defaultEffort?: string;
  canDisableThinking?: boolean;
}

/** One entry of the upstream model directory. */
export interface WorkBuddyModel {
  id: string;
  name: string;
  /** Upstream `maxInputTokens`. */
  contextLength: number;
  /** Upstream `maxOutputTokens`. */
  maxOutputTokens: number;
  /**
   * Credit rate of the model, parsed from the upstream `credits` string
   * (`"x0.79 credits"` → 0.79). `0` is the upstream's own "free" rate and is what
   * {@link import("./freeModel").selectWorkBuddyFreeModel} looks for. `undefined`
   * means the upstream did not declare one — never a guessed value.
   */
  creditMultiplier?: number;
  supportsVision?: boolean;
  supportsToolCall?: boolean;
  reasoning?: WorkBuddyModelReasoning;
  descriptionZh?: string;
  descriptionEn?: string;
}

/** One credit package as the billing endpoint reports it. */
export interface WorkBuddyCreditPackage {
  packageName: string;
  /** Remaining credits, clamped at 0. */
  remain: number;
  size: number;
  /** Refill package (recurring cycle) vs one-off bonus package. */
  monthly: boolean;
  /** Next cycle refresh (refill packages only). */
  refreshAtMs?: number;
  /** Hard expiry (one-off packages; falls back to the cycle end). */
  expiresAtMs?: number;
}

/** Credit overview for one credential. */
export interface WorkBuddyCredits {
  total: number;
  packages: WorkBuddyCreditPackage[];
  /** Credits expiring within 72h — the ones worth spending first. */
  expiringSoon: number;
  /** Nearest expiry across all packages. */
  nearestExpiryMs?: number;
}

/** Daily check-in state (read-only view). */
export interface WorkBuddyCheckinStatus {
  /** Whether the check-in programme is open for this account at all. */
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  /** Base reward of one check-in. */
  dailyCredit: number;
  /** Reward already earned today. */
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  /** Upstream button caption, when it sends one. */
  claimButtonText?: string;
}

/** Result of claiming today's check-in. */
export interface WorkBuddyCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}

/** Static description of one edition: ids, hosts and the flags callers branch on. */
export interface WorkBuddyEdition {
  /** OmniRoute provider id (`workbuddy` / `workbuddy-global`). */
  providerId: string;
  region: WorkBuddyRegion;
  /** Dashboard-facing name. */
  name: string;
  /** Short label used in status payloads. */
  label: string;
  chatBase: string;
  billingBase: string;
  /**
   * Whether this edition exposes a daily check-in. Only the domestic edition does;
   * the international one has no such endpoint, so the addon must not offer the
   * action there rather than surface a guaranteed 404.
   */
  supportsCheckin: boolean;
  /** Model-directory path for this edition. */
  modelsPath: string;
  /** User agent the model directory is read with (channel selector). */
  catalogUserAgent: string;
}

/** The two editions, in display order. */
export const WORKBUDDY_EDITIONS: readonly WorkBuddyEdition[] = [
  {
    providerId: WORKBUDDY_PROVIDER_ID,
    region: "cn",
    name: "WorkBuddy (国内版)",
    label: "国内版",
    chatBase: WORKBUDDY_CN_CHAT_BASE,
    billingBase: WORKBUDDY_CN_BILLING_BASE,
    supportsCheckin: true,
    modelsPath: WORKBUDDY_MODELS_PATH,
    catalogUserAgent: WORKBUDDY_CLIENT_USER_AGENT,
  },
  {
    providerId: WORKBUDDY_GLOBAL_PROVIDER_ID,
    region: "global",
    name: "WorkBuddy (International)",
    label: "International",
    chatBase: WORKBUDDY_GLOBAL_BASE,
    billingBase: WORKBUDDY_GLOBAL_BASE,
    supportsCheckin: false,
    modelsPath: WORKBUDDY_GLOBAL_CONFIG_PATH,
    catalogUserAgent: WORKBUDDY_DESKTOP_USER_AGENT,
  },
];

/** Region of a login domain. An empty/unknown domain means the domestic edition. */
export function resolveWorkBuddyRegion(domain: string | undefined | null): WorkBuddyRegion {
  const lowered = (domain ?? "").trim().toLowerCase();
  if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
  return "cn";
}

/**
 * Gateway for an international credential.
 *
 * Both brand domains serve the same international stack, but a token minted at one is
 * rejected at the other, so the base follows the credential's own domain. Anything
 * unrecognised falls back to the desktop app's gateway.
 */
export function resolveWorkBuddyGlobalBase(domain: string | undefined | null): string {
  const lowered = (domain ?? "").trim().toLowerCase();
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) {
    return WORKBUDDY_GLOBAL_ALT_BASE;
  }
  return WORKBUDDY_GLOBAL_BASE;
}

/** Chat gateway for a credential. */
export function workBuddyChatBase(domain: string | undefined | null): string {
  return resolveWorkBuddyRegion(domain) === "global"
    ? resolveWorkBuddyGlobalBase(domain)
    : WORKBUDDY_CN_CHAT_BASE;
}

/** Billing/credit gateway for a credential. */
export function workBuddyBillingBase(domain: string | undefined | null): string {
  return resolveWorkBuddyRegion(domain) === "global"
    ? resolveWorkBuddyGlobalBase(domain)
    : WORKBUDDY_CN_BILLING_BASE;
}

/**
 * Edition descriptor for a provider id, alias or region name.
 *
 * Aliases are accepted because a connection can be created under either spelling and a
 * resolver that recognised only the canonical id would make the addon's own routes answer
 * "not connected" for an account that is plainly there.
 */
export function resolveWorkBuddyEdition(
  providerIdOrRegion: string | undefined | null
): WorkBuddyEdition | null {
  const key = (providerIdOrRegion ?? "").trim().toLowerCase();
  if (!key) return null;
  if (key === "cn" || key === WORKBUDDY_PROVIDER_ID || key === "wb") return WORKBUDDY_EDITIONS[0];
  if (key === "global" || key === WORKBUDDY_GLOBAL_PROVIDER_ID || key === "wbg") {
    return WORKBUDDY_EDITIONS[1];
  }
  return null;
}

/** Edition owning a credential, decided by the credential's own domain. */
export function editionForDomain(domain: string | undefined | null): WorkBuddyEdition {
  return resolveWorkBuddyRegion(domain) === "global"
    ? WORKBUDDY_EDITIONS[1]
    : WORKBUDDY_EDITIONS[0];
}

/** Whether a provider id belongs to this addon. */
export function isWorkBuddyProvider(providerId: unknown): boolean {
  return resolveWorkBuddyEdition(typeof providerId === "string" ? providerId : null) !== null;
}

/**
 * Keys this addon owns inside a connection's `providerSpecificData`.
 *
 * Declared here (and not next to the DB helpers) because the executor needs the same
 * names: the request path reads the account identity out of these keys on every call,
 * and a rename that reached only one of the two sides would send requests with no
 * `X-Domain`/`X-User-Id` — which this gateway answers with an HTML 401 rather than a
 * helpful error.
 */
export const WORKBUDDY_CONNECTION_KEYS = {
  domain: "workbuddyDomain",
  uid: "workbuddyUid",
  enterpriseId: "workbuddyEnterpriseId",
  region: "workbuddyRegion",
  source: "workbuddySource",
  sourceFilePath: "workbuddySourceFilePath",
  accountLabel: "workbuddyAccountLabel",
  expiresAtMs: "workbuddyExpiresAtMs",
} as const;
