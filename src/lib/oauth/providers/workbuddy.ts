import { WORKBUDDY_PROVIDER_ID, WORKBUDDY_GLOBAL_PROVIDER_ID } from "@/lib/workbuddy/types";
import { connectionPayloadFromWorkBuddyCredential } from "@/lib/workbuddy/accounts";
import { parseWorkBuddyAuthDocument } from "@/lib/workbuddy/credentials";

/**
 * WorkBuddy (国内版 / International) — import_token flow only.
 *
 * WorkBuddy accounts live inside the desktop app's auth files, not as browser
 * OAuth (copilot.tencent.com / workbuddy.ai do not offer a public OAuth code
 * exchange). Registering the two editions here with flowType "import_token"
 * prevents getProvider() from throwing "Unknown provider: workbuddy" (and
 * "workbuddy-global") when the OAuth capability endpoint is probed — the
 * same error the provider wizard hit when adding WorkBuddy as a provider.
 *
 * Provisioning paths flow through the WorkBuddy addon routes:
 *   - GET /api/workbuddy/accounts — credentials in this machine's auth files
 *   - POST /api/workbuddy/import  — desktop-app manifest import via sha256 fingerprint
 * A pasted credential goes through POST /api/oauth/<edition>/import-token
 * (the same raw-token path the devin/grok-cli entries use).
 *
 * ── Why the whole auth document matters ────────────────────────────────────
 * WorkBuddy's gateway is not a plain bearer API: chat completions accept the
 * access token alone, but the catalogue (`/v3/config` · `/v2/enterprises/
 * personal/models`) and billing (`/v2/billing/meter/…`) endpoints additionally
 * require the account identity headers `X-User-Id` / `X-Domain` /
 * `X-Enterprise-Id`. Those live in the auth file (`account.uid`,
 * `auth.domain`, …), not in the token — so a bare-token paste produces a
 * connection where chat works and credits/model-discovery answer HTTP 401
 * (verified: `wbg/default-model` completed, `/api/workbuddy/credits` → 401).
 *
 * `mapTokens` therefore accepts EITHER the full auth document (the file
 * contents, or its `auth`/`account` sub-object) OR a bare token string, and
 * routes the document through the addon's own parser + payload builder so the
 * connection ends up with the same `providerSpecificData` the desktop import
 * writes (see WORKBUDDY_CONNECTION_KEYS).
 *
 * @module lib/oauth/providers/workbuddy
 */

export const WORKBUDDY_CONFIG = {
  importUrl: "/api/workbuddy/accounts",
  manualImportUrl: "/api/workbuddy/import",
};

export const WORKBUDDY_GLOBAL_CONFIG = {
  importUrl: "/api/workbuddy/accounts",
  manualImportUrl: "/api/workbuddy/import",
};

/** Marker used as the pseudo-path for a pasted document (never a real file). */
const PASTED_SOURCE = "(pasted)";

type TokenMapping = Record<string, unknown>;

/** Seconds until the credential's own expiry, for the route's expiresAt math. */
function expiresInFromMs(expiresAtMs: number | undefined): number | null {
  if (!expiresAtMs || !Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
}

/**
 * Normalize whatever was pasted into a connection payload.
 *
 * Returns `null` when the input carries no usable credential, which the route
 * turns into a 400 instead of silently storing an empty connection.
 */
function mapPastedCredential(input: unknown): TokenMapping | null {
  // Bare token: chat works, identity-dependent endpoints stay unauthenticated.
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return null;
    // The dashboard's paste box hands us the textarea contents verbatim, so a
    // pasted document arrives as a JSON *string*. Parse it before treating the
    // value as a token — otherwise a 4 KB document would be stored as the
    // access token and every upstream call would 401.
    if (raw.startsWith("{")) {
      try {
        const parsedJson = JSON.parse(raw);
        if (parsedJson && typeof parsedJson === "object") {
          return mapPastedCredential(parsedJson);
        }
      } catch {
        /* not JSON after all — fall through to the bare-token path */
      }
    }
    return { accessToken: raw, refreshToken: null, expiresIn: null };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;

  // Full auth document (or the nested `auth`/`account` objects) → reuse the
  // addon's parser, so a document shape that the desktop import understands is
  // understood here too (nested auth/account, epoch expiry, encrypted fields).
  const parsed = parseWorkBuddyAuthDocument(JSON.stringify(record), PASTED_SOURCE);
  if (parsed.credential) {
    const payload = connectionPayloadFromWorkBuddyCredential(parsed.credential);
    return {
      ...payload,
      // The route derives expiresAt from expiresIn and applies it AFTER
      // spreading this object, so expiry must be expressed as expiresIn.
      expiresIn: expiresInFromMs(parsed.credential.expiresAtMs),
    };
  }

  // Flat {accessToken, refreshToken?, domain?, uid?} object: still accept it —
  // a caller that assembled the fields itself should not be rejected.
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : null,
    expiresIn: null,
    ...(typeof record.domain === "string" && record.domain
      ? { providerSpecificData: { workbuddyDomain: record.domain } }
      : {}),
  };
}

/** Both editions share one mapping — the document's domain decides the edition. */
function makeWorkBuddyHandler(config: typeof WORKBUDDY_CONFIG) {
  return {
    config,
    flowType: "import_token" as const,

    validateImportToken(token: unknown): { valid: boolean; reason?: string } {
      const mapped = mapPastedCredential(token);
      if (!mapped) {
        return {
          valid: false,
          reason:
            "Paste the WorkBuddy auth document (the contents of workbuddy-desktop*.info) or its accessToken value.",
        };
      }
      const accessToken = typeof mapped.accessToken === "string" ? mapped.accessToken : "";
      if (accessToken.length < 12) return { valid: false, reason: "Token is too short" };
      return { valid: true };
    },

    /**
     * `tokens.accessToken` is whatever the caller posted as `token` — a bare
     * string or the full document (the route validates with a string-or-record
     * union and passes it through unchanged).
     */
    mapTokens(tokens: { accessToken: unknown }) {
      const mapped = mapPastedCredential(tokens.accessToken);
      if (!mapped) {
        throw new Error(
          "No usable WorkBuddy credential in that paste — expected the auth document or an accessToken.",
        );
      }
      return mapped;
    },
  };
}

export const workbuddy = makeWorkBuddyHandler(WORKBUDDY_CONFIG);
export const workbuddyGlobal = makeWorkBuddyHandler(WORKBUDDY_GLOBAL_CONFIG);

/** Re-exported so manifests/tests can assert the ids this module serves. */
export { WORKBUDDY_PROVIDER_ID, WORKBUDDY_GLOBAL_PROVIDER_ID };
