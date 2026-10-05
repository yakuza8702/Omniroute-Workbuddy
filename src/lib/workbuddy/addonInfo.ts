/**
 * WorkBuddy addon — self-description.
 *
 * The addon answers "how do you work?" as data, not as a doc link: every capability the
 * dashboard can offer, the endpoints behind it and the safety rules it holds itself to
 * are described here and served by `GET /api/workbuddy/info`. A UI that reads this can
 * render the feature set (and explain an unavailable action) without hardcoding a second
 * copy of the truth that drifts from the code.
 *
 * @module lib/workbuddy/addonInfo
 */

import {
  WORKBUDDY_CHECKIN_CLAIM_PATH,
  WORKBUDDY_CHECKIN_STATUS_PATH,
  WORKBUDDY_CLIENT_USER_AGENT,
  WORKBUDDY_CN_BILLING_BASE,
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_CREDITS_PATH,
  WORKBUDDY_DESKTOP_USER_AGENT,
  WORKBUDDY_EDITIONS,
  WORKBUDDY_GLOBAL_BASE,
  WORKBUDDY_GLOBAL_CONFIG_PATH,
  WORKBUDDY_GLOBAL_ALT_BASE,
  WORKBUDDY_MODELS_PATH,
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_GLOBAL_PROVIDER_ID,
  WORKBUDDY_REFRESH_PATH,
  WORKBUDDY_CHAT_PATH,
} from "./types";

/** Where the addon reads credentials from, and what it refuses to do with them. */
export interface WorkBuddyCredentialSource {
  kind: "desktop-app" | "manual";
  description: string;
  /** Platform-default locations, for the "why is nothing detected" surface. */
  locations: string[];
  /** Environment variables that override discovery. */
  environment: Array<{ name: string; purpose: string }>;
  /** Whether the source is read-only. */
  readOnly: boolean;
}

/** One capability the addon exposes, with the endpoints behind it. */
export interface WorkBuddyAddonCapability {
  id: string;
  name: string;
  description: string;
  /** HTTP method + path, when the capability is backed by an upstream call. */
  upstream?: string[];
  /** Addon route that exposes it. */
  route?: string;
  /** True when the action changes upstream state. */
  mutates: boolean;
}

/** Full description of the addon. */
export interface WorkBuddyAddonInfo {
  id: string;
  name: string;
  version: string;
  summary: string;
  /** The narrative "how it works", in order. */
  howItWorks: string[];
  providers: Array<{
    providerId: string;
    region: string;
    label: string;
    chatBase: string;
    billingBase: string;
    modelDirectory: string;
    catalogUserAgent: string;
    supportsCheckin: boolean;
  }>;
  capabilities: WorkBuddyAddonCapability[];
  credentialSources: WorkBuddyCredentialSource[];
  /** Rules the addon holds itself to; a UI can render these as the safety contract. */
  guarantees: string[];
  /** Things the addon deliberately does NOT do, so absence is not read as a bug. */
  nonGoals: string[];
}

/** Version of this addon's contract; bump when the shape of this payload changes. */
export const WORKBUDDY_ADDON_CONTRACT_VERSION = "1.0.0";

/**
 * Describe the addon.
 *
 * Kept as one function (rather than a static JSON import) so the edition table it
 * publishes is the same constant the request path uses — an endpoint renamed in
 * `types.ts` cannot leave this description advertising the old one.
 */
export function describeWorkBuddyAddon(): WorkBuddyAddonInfo {
  return {
    id: "workbuddy-addon",
    name: "WorkBuddy addon",
    version: WORKBUDDY_ADDON_CONTRACT_VERSION,
    summary:
      "Connects the WorkBuddy desktop app's two editions (国内版 / International) to OmniRoute as " +
      "ordinary providers — model catalogue, chat routing and token refresh — and adds the " +
      "account surfaces a plain gateway integration cannot show: credit balance, credit claim " +
      "(daily check-in), the current free model, and this description.",
    howItWorks: [
      "The desktop app is read, never driven: the addon scans the app's auth directory, keeps the live sign-in first and timestamped backups after it, and imports the account you pick. The app's own files are never written.",
      "The imported account becomes a normal provider connection for one of the two editions, so requests, retries, cooldowns and token refresh are the platform's usual machinery rather than a parallel stack.",
      "The model catalogue is read from the edition's own directory: the domestic edition answers /v2/enterprises/personal/models, the international one answers /v3/config (read with the desktop channel's user agent, because the CLI channel omits free chat models there).",
      "Chat traffic goes to the edition's gateway at /v2/chat/completions with the account's bearer token; the conversation is expected to open with a system message, which the executor guarantees.",
      "Credits are read from the billing endpoint on every request for the overview, and the daily check-in is a two-step action: read today's status, then claim only if the day is still unclaimed.",
      "The current free model is derived from the live catalogue's own credit rates — an explicit x0.00 is free; a missing rate is not.",
    ],
    providers: WORKBUDDY_EDITIONS.map((edition) => ({
      providerId: edition.providerId,
      region: edition.region,
      label: edition.label,
      chatBase: edition.chatBase,
      billingBase: edition.billingBase,
      modelDirectory: edition.modelsPath,
      catalogUserAgent: edition.catalogUserAgent,
      supportsCheckin: edition.supportsCheckin,
    })),
    capabilities: [
      {
        id: "models",
        name: "Model catalogue",
        description:
          "Fetch the account's real model list from the edition's directory, including each model's context window, output ceiling, vision/tool support and credit rate.",
        upstream: [
          `GET {chatBase}${WORKBUDDY_MODELS_PATH}`,
          `GET {globalBase}${WORKBUDDY_GLOBAL_CONFIG_PATH}`,
        ],
        route: "GET /api/workbuddy/models",
        mutates: false,
      },
      {
        id: "credits",
        name: "Credit balance",
        description:
          "Remaining credits per package, keeping recurring packages and one-off packages separate, plus the nearest expiry and how much is about to expire.",
        upstream: [`POST {billingBase}${WORKBUDDY_CREDITS_PATH}`],
        route: "GET /api/workbuddy/credits",
        mutates: false,
      },
      {
        id: "checkin",
        name: "Credit claim (daily check-in)",
        description:
          "Claim today's check-in reward. The status endpoint is consulted first and an already-claimed day is reported instead of re-claimed. Domestic edition only.",
        upstream: [
          `POST {billingBase}${WORKBUDDY_CHECKIN_STATUS_PATH}`,
          `POST {billingBase}${WORKBUDDY_CHECKIN_CLAIM_PATH}`,
        ],
        route: "GET|POST /api/workbuddy/checkin",
        mutates: true,
      },
      {
        id: "free-model",
        name: "Current free model",
        description:
          "The zero-rate model with the largest context window in the live catalogue — selected from declared rates, never from a hardcoded name list.",
        route: "GET /api/workbuddy/free-model",
        mutates: false,
      },
      {
        id: "accounts",
        name: "Account discovery and import",
        description:
          "List the accounts the desktop app has left on this machine (fingerprints only, never tokens) and import the chosen one as a provider connection.",
        route: "GET /api/workbuddy/accounts, POST /api/workbuddy/import",
        mutates: false,
      },
      {
        id: "chat",
        name: "Chat routing",
        description:
          "Route completions through the registered provider, with the conversation head normalised and token refresh handled by the platform when the session expires.",
        upstream: [
          `POST {chatBase}${WORKBUDDY_CHAT_PATH}`,
          `POST {chatBase}${WORKBUDDY_REFRESH_PATH}`,
        ],
        mutates: false,
      },
      {
        id: "info",
        name: "How the addon works",
        description: "This description, served as data so a UI never has to hardcode it.",
        route: "GET /api/workbuddy/info",
        mutates: false,
      },
    ],
    credentialSources: [
      {
        kind: "desktop-app",
        description:
          "The WorkBuddy desktop app's auth files. The live sign-in is preferred; timestamped backups are offered as additional accounts.",
        locations: [
          "macOS: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info",
          "Windows: %LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info (and %APPDATA%)",
          "Linux: $XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info (default ~/.config)",
        ],
        environment: [
          { name: "WORKBUDDY_AUTH_FILE", purpose: "Point at one explicit auth file." },
          {
            name: "WORKBUDDY_AUTH_DIR",
            purpose: "Point at an auth directory outside the platform default.",
          },
          {
            name: "WORKBUDDY_APP_EXECUTABLE",
            purpose:
              "Path of the desktop app, reported in diagnostics when credentials are encrypted.",
          },
        ],
        readOnly: true,
      },
      {
        kind: "manual",
        description:
          "A token pasted into the provider's connection form, for accounts whose auth file cannot be read (for example builds that encrypt the fields).",
        locations: [],
        environment: [],
        readOnly: false,
      },
    ],
    guarantees: [
      "The desktop app's files are opened read-only; the addon never refreshes or rewrites them.",
      "Access tokens never reach the browser: account pickers exchange a sha256 fingerprint, and the server re-reads the file before importing it.",
      "The account number is shown masked; the phone number in the auth file is never read.",
      "Credit queries are read-only and cost nothing.",
      "No automatic check-in: the claim runs only when a caller asks for it, and only after the status call says the day is unclaimed.",
    ],
    nonGoals: [
      "Bypassing the app's login: the addon reuses an existing sign-in, it does not create one.",
      "Decrypting auth files whose fields are encrypted by the app build — the addon reports the condition instead of guessing.",
      "Merging the two editions: accounts, catalogues and credit balances stay separate because the gateways do.",
      "Inventing a credit rate, reset time or model window the upstream did not report.",
    ],
  };
}

/** Provider ids this addon registers, exported for manifests and tests. */
export const WORKBUDDY_ADDON_PROVIDER_IDS = {
  cn: WORKBUDDY_PROVIDER_ID,
  global: WORKBUDDY_GLOBAL_PROVIDER_ID,
} as const;

/** Hosts the addon talks to; used by diagnostics and by the info route. */
export const WORKBUDDY_ADDON_HOSTS = {
  cnChat: WORKBUDDY_CN_CHAT_BASE,
  cnBilling: WORKBUDDY_CN_BILLING_BASE,
  global: WORKBUDDY_GLOBAL_BASE,
  globalAlt: WORKBUDDY_GLOBAL_ALT_BASE,
  clientUserAgent: WORKBUDDY_CLIENT_USER_AGENT,
  desktopUserAgent: WORKBUDDY_DESKTOP_USER_AGENT,
} as const;
