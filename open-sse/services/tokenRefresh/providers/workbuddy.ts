// WorkBuddy (Tencent) token refresh — POST /v2/plugin/auth/token/refresh with the
// refresh token in the `X-Refresh-Token` header (the gateway has no form-body variant).
// The gateway is chosen from the account's own login domain: an international token is
// rejected by the domestic host and vice versa, so a fixed base URL would silently
// break one of the two editions.
import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import type { RefreshLogger } from "../shared.ts";
import { buildWorkBuddyRefreshHeaders } from "@/lib/workbuddy/upstream";
import {
  WORKBUDDY_CONNECTION_KEYS,
  workBuddyChatBase,
  type WorkBuddyCredential,
} from "@/lib/workbuddy/types";

const REFRESH_PATH = "/v2/plugin/auth/token/refresh";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Refresh a WorkBuddy access token.
 *
 * Returns `null` on any failure (matching every other provider refresher here): callers
 * treat "no new token" as "keep using the existing one until it actually expires",
 * which is the right behaviour for an account whose desktop app is also refreshing.
 */
export async function refreshWorkBuddyToken(
  refreshToken: string,
  providerSpecificData: unknown,
  log: RefreshLogger,
  proxyConfig: unknown = null
) {
  if (!refreshToken) return null;
  const psd = asRecord(providerSpecificData);
  const domain = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.domain]) ?? "";
  const enterpriseId = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.enterpriseId]);
  const credential: WorkBuddyCredential = {
    accessToken: "",
    refreshToken,
    domain,
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
  };
  const url = `${workBuddyChatBase(domain)}${REFRESH_PATH}`;

  try {
    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(url, {
        method: "POST",
        headers: buildWorkBuddyRefreshHeaders(credential),
      })
    );

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", "Failed to refresh WorkBuddy token", {
        status: response.status,
      });
      return null;
    }

    const data = await response.json();
    if (data?.code !== 0 || !data?.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "WorkBuddy token refresh returned no token", {
        code: data?.code,
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed WorkBuddy token", {
      hasNewAccessToken: true,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
      // A refresh response can hand back a different domain; persisting it keeps the
      // next request on the gateway that actually issued the token.
      ...(asNonEmptyString(data.data.domain) === undefined
        ? {}
        : {
            providerSpecificData: {
              [WORKBUDDY_CONNECTION_KEYS.domain]: asNonEmptyString(data.data.domain),
            },
          }),
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Network error refreshing WorkBuddy token", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

export default refreshWorkBuddyToken;
