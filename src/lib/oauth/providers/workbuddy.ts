import { WORKBUDDY_PROVIDER_ID, WORKBUDDY_GLOBAL_PROVIDER_ID } from "@/lib/workbuddy/types";

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
 * A plain pasted token goes through POST /api/oauth/<edition>/import-token
 * (the same raw-token path the devin/grok-cli entries use).
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

export const workbuddy = {
  config: WORKBUDDY_CONFIG,
  flowType: "import_token" as const,

  validateImportToken(token: string): { valid: boolean; reason?: string } {
    const trimmed = (token ?? "").trim();
    if (!trimmed) return { valid: false, reason: "Token is empty" };
    if (trimmed.length < 12) return { valid: false, reason: "Token is too short" };
    return { valid: true };
  },

  mapTokens(tokens: { accessToken: string }) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: null as string | null,
      expiresIn: null as number | null,
    };
  },
};

export const workbuddyGlobal = {
  config: WORKBUDDY_GLOBAL_CONFIG,
  flowType: "import_token" as const,

  validateImportToken(token: string): { valid: boolean; reason?: string } {
    const trimmed = (token ?? "").trim();
    if (!trimmed) return { valid: false, reason: "Token is empty" };
    if (trimmed.length < 12) return { valid: false, reason: "Token is too short" };
    return { valid: true };
  },

  mapTokens(tokens: { accessToken: string }) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: null as string | null,
      expiresIn: null as number | null,
    };
  },
};
