/**
 * WorkBuddy addon — connections.
 *
 * A WorkBuddy login is an OmniRoute provider connection like any other: the access
 * token lives in `accessToken`, the refresh token in `refreshToken`, and the
 * WorkBuddy-specific identity (login domain, uid, enterprise/tenant id) rides in
 * `providerSpecificData`. That is deliberate — it means the addon inherits the
 * platform's credential encryption at rest, its token-refresh lifecycle and its
 * account rotation instead of maintaining a second credential store.
 *
 * The token itself is never returned to a browser by any route that imports these
 * helpers; callers that need to show WHICH account is connected use the non-secret
 * fields (domain, masked account, source file).
 *
 * @module lib/workbuddy/accounts
 */

import { getProviderConnectionById, getProviderConnections } from "@/lib/db/providers";
import {
  WORKBUDDY_CONNECTION_KEYS,
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_GLOBAL_PROVIDER_ID,
  editionForDomain,
  resolveWorkBuddyEdition,
  type WorkBuddyCredential,
  type WorkBuddyEdition,
} from "./types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Credential read back out of a stored connection, or `null` when it carries no token. */
export function credentialFromWorkBuddyConnection(connection: unknown): WorkBuddyCredential | null {
  const row = asRecord(connection);
  const accessToken = asNonEmptyString(row.accessToken) ?? asNonEmptyString(row.apiKey);
  if (!accessToken) return null;
  const psd = asRecord(row.providerSpecificData);
  const domain = asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.domain]) ?? "";
  return {
    accessToken,
    refreshToken: asNonEmptyString(row.refreshToken) ?? "",
    domain,
    ...(asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.uid]) === undefined
      ? {}
      : { uid: asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.uid]) }),
    ...(asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.enterpriseId]) === undefined
      ? {}
      : { enterpriseId: asNonEmptyString(psd[WORKBUDDY_CONNECTION_KEYS.enterpriseId]) }),
    ...(asNonEmptyString(row.displayName) === undefined
      ? {}
      : { nickname: asNonEmptyString(row.displayName) }),
    source: "connection",
  };
}

/**
 * Connection payload for a discovered desktop credential.
 *
 * The access token goes into `accessToken` (not `apiKey`): this is a bearer session the
 * platform refreshes, not a long-lived API key, and putting it in the API-key column
 * would make the key-management surfaces treat a rotating session as a static secret.
 */
export function connectionPayloadFromWorkBuddyCredential(
  credential: WorkBuddyCredential
): JsonRecord {
  const edition: WorkBuddyEdition = editionForDomain(credential.domain);
  const payload: JsonRecord = {
    provider: edition.providerId,
    // "oauth", not "bearer": the catalog already files both editions under the
    // OAuth category (src/shared/constants/providers/oauth.ts), the connection
    // carries a refresh token, and the refresher is dispatched by provider id —
    // while NOTHING in the codebase reads `authType === "bearer"`. Tagging the
    // row "bearer" hid every imported account from the surfaces that gate on
    // `authType === "oauth" || "apikey"`: the providers overview card rendered
    // "No connections" and Provider Quota said "No Providers Connected" with
    // three working accounts behind it.
    authType: "oauth",
    accessToken: credential.accessToken,
    name: credential.nickname ?? `WorkBuddy ${edition.label}`,
    displayName: credential.nickname ?? credential.uin ?? `WorkBuddy ${edition.label}`,
    // The credential comes from the app's own live sign-in, so the row starts as a
    // usable connection. Without an explicit status the dashboard paints the row as
    // a red "error": ConnectionRow's presentation falls through to
    // `effectiveStatus || t("statusError")` when `testStatus` is undefined, which
    // made a healthy account (credits OK, chat OK, isActive true) look broken.
    testStatus: "active",
    isActive: true,
    providerSpecificData: {
      [WORKBUDDY_CONNECTION_KEYS.domain]: credential.domain,
      [WORKBUDDY_CONNECTION_KEYS.region]: edition.region,
      [WORKBUDDY_CONNECTION_KEYS.source]: credential.source ?? "desktop",
      ...(credential.uid === undefined ? {} : { [WORKBUDDY_CONNECTION_KEYS.uid]: credential.uid }),
      ...(credential.enterpriseId === undefined
        ? {}
        : { [WORKBUDDY_CONNECTION_KEYS.enterpriseId]: credential.enterpriseId }),
      ...(credential.filePath === undefined
        ? {}
        : { [WORKBUDDY_CONNECTION_KEYS.sourceFilePath]: credential.filePath }),
      ...(credential.expiresAtMs === undefined
        ? {}
        : { [WORKBUDDY_CONNECTION_KEYS.expiresAtMs]: credential.expiresAtMs }),
    },
  };
  if (credential.refreshToken) payload.refreshToken = credential.refreshToken;
  if (credential.expiresAtMs) payload.expiresAt = new Date(credential.expiresAtMs).toISOString();
  return payload;
}

/**
 * Every connection of one edition, in the PLATFORM's preference order.
 *
 * The order is preserved, not re-sorted: `getProviderConnections` already returns provider
 * rows as `priority ASC, updated_at DESC`, which is the order the routing layer itself uses
 * to choose between accounts. Sorting here (say, newest first) would give the addon's
 * overview a different notion of "the current account" than the one actually serving
 * traffic — exactly the mismatch an operator would have to debug.
 */
export async function listWorkBuddyConnections(providerId: string): Promise<JsonRecord[]> {
  const edition = resolveWorkBuddyEdition(providerId);
  if (!edition) return [];
  const rows = (await getProviderConnections({ provider: edition.providerId })) as unknown[];
  return rows.map(asRecord);
}

/**
 * Whether a connection row is ENABLED.
 *
 * `is_active` is not "the chosen account": every connection is created with it set, so
 * several accounts of one provider are all active and the router picks between them by
 * priority. It is read loosely because the column is an SQLite INTEGER — a boolean-only
 * comparison (`=== true`) would never match a stored `1`, and the addon would silently
 * ignore an account the operator had disabled.
 */
export function isWorkBuddyConnectionActive(row: unknown): boolean {
  const record = asRecord(row);
  return (
    record.isActive === true ||
    record.isActive === 1 ||
    record.is_active === true ||
    record.is_active === 1
  );
}

/**
 * The account the addon answers for by default.
 *
 * The first ENABLED connection in the platform's preference order — i.e. the account the
 * router reaches first. Disabled connections are skipped rather than reported, because an
 * overview answering with an account nothing can route to is worse than one that admits
 * which account it moved on to; the raw list is the fallback, so an edition whose accounts
 * are all disabled still reports "connected" instead of claiming no account exists.
 *
 * Address a specific account with {@link resolveWorkBuddyConnectionById}.
 */
export async function resolveWorkBuddyConnection(providerId: string): Promise<{
  connection: JsonRecord;
  credential: WorkBuddyCredential;
  edition: WorkBuddyEdition;
} | null> {
  const edition = resolveWorkBuddyEdition(providerId);
  if (!edition) return null;
  const rows = await listWorkBuddyConnections(edition.providerId);
  const chosen = rows.find(isWorkBuddyConnectionActive) ?? rows[0];
  if (!chosen) return null;
  const credential = credentialFromWorkBuddyConnection(chosen);
  if (!credential) return null;
  return { connection: chosen, credential, edition };
}

/**
 * Resolve ONE named connection, for the multi-account case.
 *
 * A machine can hold several WorkBuddy accounts (the desktop app keeps a backup auth file
 * per sign-in, and both editions can be signed in at once), and each import becomes its own
 * connection — which is what lets the platform rotate between them. The overview surfaces
 * (credits, check-in, free model) then have to say WHICH account they are answering for:
 * without this they could only report the default one, and claiming the daily credit for a
 * second account would mean reordering the others out of the way first.
 *
 * The provider must belong to this addon: an id pointing at any other provider is rejected
 * rather than silently credential-mapped.
 */
export async function resolveWorkBuddyConnectionById(connectionId: string): Promise<{
  connection: JsonRecord;
  credential: WorkBuddyCredential;
  edition: WorkBuddyEdition;
} | null> {
  const id = connectionId.trim();
  if (!id) return null;
  const row = (await getProviderConnectionById(id)) as unknown;
  if (!row) return null;
  const record = asRecord(row);
  const edition = resolveWorkBuddyEdition(asNonEmptyString(record.provider) ?? null);
  if (!edition) return null;
  const credential = credentialFromWorkBuddyConnection(record);
  if (!credential) return null;
  return { connection: record, credential, edition };
}

/** Non-secret identity of a resolved connection, for response payloads. */
export function describeWorkBuddyConnection(connection: unknown): JsonRecord {
  const row = asRecord(connection);
  return {
    connectionId: asNonEmptyString(row.id) ?? null,
    name: asNonEmptyString(row.displayName) ?? asNonEmptyString(row.name) ?? null,
    active: isWorkBuddyConnectionActive(row),
  };
}

/** Both edition provider ids, for callers that iterate the whole addon. */
export const WORKBUDDY_PROVIDER_IDS: readonly string[] = [
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_GLOBAL_PROVIDER_ID,
];
