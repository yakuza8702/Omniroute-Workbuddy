/**
 * usage/workbuddy.ts — WorkBuddy credits → the quota shape the dashboard renders.
 *
 * WorkBuddy does not meter in tokens: it meters in **credits**, and the model's own
 * rate (`x0.79 credits`) converts a request into a spend. So the honest mapping onto
 * OmniRoute's quota rows is a credit row, not a percentage bar with a made-up ceiling:
 *
 *  - `used`/`total` come from the package sizes the billing endpoint reports for THIS
 *    account, so a bar can be drawn without inventing capacity.
 *  - `remaining` carries the real credit count — the number the user actually cares
 *    about — following the AgentRouter precedent of putting the human-meaningful figure
 *    in `remaining` rather than in a sibling field the dashboard never reads.
 *  - `resetAt` is the nearest REFILL (a recurring package rolling into its next cycle),
 *    because that is the next moment the balance can go up. A one-off package expiring
 *    is not a reset, and reporting it as one would tell the user to wait for a refill
 *    that is never coming.
 *
 * Read-only: this fetcher only reads the billing endpoint. Claiming credits is a
 * separate, explicit action (`POST /api/workbuddy/checkin`).
 *
 * @module open-sse/services/usage/workbuddy
 */

import { fetchWorkBuddyCredits, WorkBuddyUpstreamError } from "@/lib/workbuddy/upstream";
import { WORKBUDDY_CONNECTION_KEYS, type WorkBuddyCredential } from "@/lib/workbuddy/types";
import { type UsageQuota } from "./quota.ts";

interface WorkBuddyUsageResult {
  plan?: string;
  quotas?: Record<string, UsageQuota>;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Credential from the arguments the usage dispatcher supplies. */
function credentialFromUsageArgs(
  accessToken?: string,
  apiKey?: string,
  providerSpecificData?: unknown
): WorkBuddyCredential | null {
  const token = asNonEmptyString(accessToken) ?? asNonEmptyString(apiKey);
  if (!token) return null;
  const psd = asRecord(providerSpecificData);
  const domain = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.domain]) ?? "";
  const uid = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.uid]);
  const enterpriseId = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.enterpriseId]);
  return {
    accessToken: token,
    domain,
    ...(uid === undefined ? {} : { uid }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    source: "connection",
  };
}

/**
 * WorkBuddy credits for the dashboard.
 *
 * Returns `{ message }` (never a throw) when the credential is missing or the upstream
 * refuses, so a single broken account degrades one row instead of the whole quota page.
 * The message is bounded and contains no upstream body: error text here is rendered in
 * the dashboard, and raw upstream HTML must not reach it.
 */
export async function getWorkBuddyUsage(
  accessToken?: string,
  apiKey?: string,
  providerSpecificData?: unknown
): Promise<WorkBuddyUsageResult> {
  const credential = credentialFromUsageArgs(accessToken, apiKey, providerSpecificData);
  if (!credential) {
    return { message: "WorkBuddy credential not available. Import the desktop account first." };
  }

  try {
    const credits = await fetchWorkBuddyCredits(credential);
    if (credits.packages.length === 0) {
      return { message: "WorkBuddy account connected. No credit package found." };
    }

    const total = credits.packages.reduce((sum, entry) => sum + entry.size, 0);
    const remaining = credits.total;
    const used = Math.max(0, total - remaining);
    // A zero-size total (an account whose packages report no capacity) must not produce
    // NaN/Infinity: the bar falls back to "unknown" instead of a fabricated 0%.
    const remainingPercentage =
      total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : undefined;

    // Next refill across recurring packages; one-off expiry is NOT a reset.
    const refills = credits.packages
      .filter((entry) => entry.monthly && entry.refreshAtMs !== undefined)
      .map((entry) => entry.refreshAtMs as number);
    const resetAt = refills.length > 0 ? new Date(Math.min(...refills)).toISOString() : null;

    const expiringSoonPackages = credits.packages.filter(
      (entry) =>
        entry.expiresAtMs !== undefined && entry.expiresAtMs - Date.now() <= 72 * 60 * 60 * 1000
    );

    const quota: UsageQuota = {
      used,
      total,
      remaining,
      ...(remainingPercentage === undefined ? {} : { remainingPercentage }),
      resetAt,
      unlimited: false,
      displayName: credits.total === 1 ? "1 credit" : `${credits.total} credits`,
      details: credits.packages.slice(0, 12).map((entry) => ({
        name: entry.monthly ? `${entry.packageName} (refill)` : entry.packageName,
        used: Math.max(0, entry.size - entry.remain),
      })),
    };

    const quotas: Record<string, UsageQuota> = { credits: quota };
    if (expiringSoonPackages.length > 0) {
      quotas["expiring-72h"] = {
        used: 0,
        total: credits.expiringSoon,
        remaining: credits.expiringSoon,
        resetAt:
          credits.nearestExpiryMs === undefined
            ? null
            : new Date(credits.nearestExpiryMs).toISOString(),
        unlimited: false,
        displayName: `${credits.expiringSoon} credits expiring within 72h`,
      };
    }

    const plan = credits.packages[0]?.monthly ? "WorkBuddy subscription" : "WorkBuddy credits";
    return { plan, quotas };
  } catch (error) {
    // `message` is dashboard-bound: keep it bounded and upstream-body-free.
    if (error instanceof WorkBuddyUpstreamError && error.status === 401) {
      return { message: "WorkBuddy credential rejected. Import the desktop account again." };
    }
    return {
      message: "WorkBuddy credit query failed. See the WorkBuddy addon status for details.",
    };
  }
}

export default getWorkBuddyUsage;
