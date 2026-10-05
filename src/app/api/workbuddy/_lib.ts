/**
 * Shared helpers for the WorkBuddy addon routes.
 *
 * Every route in this subtree is loopback-only (see `LOCAL_ONLY_API_PREFIXES`) because
 * they read this machine's desktop-app auth files or mutate an upstream account. On top
 * of that they authenticate like any management route via `requireManagementAuth`.
 *
 * Nothing here returns a token: routes expose fingerprints, masked account labels and
 * credit numbers, and the server re-reads the file before importing it.
 *
 * @module app/api/workbuddy/_lib
 */

import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  resolveWorkBuddyConnection,
  resolveWorkBuddyConnectionById,
} from "@/lib/workbuddy/accounts";
import {
  resolveWorkBuddyEdition,
  WORKBUDDY_EDITIONS,
  type WorkBuddyEdition,
} from "@/lib/workbuddy/types";

/** Provider ids this addon owns, as a union for query validation. */
export const WORKBUDDY_ROUTE_PROVIDER_IDS = WORKBUDDY_EDITIONS.map((edition) => edition.providerId);

/** One edition's resolved account, when it has an imported connection. */
export interface WorkBuddyEditionContext {
  edition: WorkBuddyEdition;
  connected: boolean;
  /** Present only when a usable connection exists. */
  credential?: Awaited<ReturnType<typeof resolveWorkBuddyConnection>>;
}

/**
 * Auth gate + JSON error envelope for this subtree.
 *
 * Returns a `Response` when the request must be rejected, `null` when it may proceed —
 * the same contract `requireManagementAuth` uses, so a route reads as
 * `const denied = await guard(request); if (denied) return denied;`.
 */
export async function guardWorkBuddyRequest(request: Request): Promise<Response | null> {
  return requireManagementAuth(request);
}

/** Error body with the upstream/exception text sanitized (never a raw stack or body). */
export function workBuddyError(message: unknown, status = 500): NextResponse {
  const safe = sanitizeErrorMessage(message instanceof Error ? message.message : String(message));
  return NextResponse.json(
    { ok: false, error: safe || "WorkBuddy addon request failed." },
    { status }
  );
}

/** Editions to act on: the requested one, or both when the query omits it. */
export function resolveRequestedEditions(providerParam: string | null): WorkBuddyEdition[] | null {
  if (providerParam === null || providerParam.trim() === "") return [...WORKBUDDY_EDITIONS];
  const edition = resolveWorkBuddyEdition(providerParam);
  return edition ? [edition] : null;
}

/**
 * Resolve the accounts an overview route should answer for.
 *
 * Without `connectionId`: one entry per requested edition, using that edition's
 * active/newest connection — the single-account case, unchanged.
 *
 * With `connectionId`: exactly that connection, and its OWN edition wins over the
 * `provider` filter, because a caller that named an account has already answered the
 * question "which account" and re-filtering by edition could only produce an empty answer
 * for a connection that plainly exists. An empty array means "no such WorkBuddy
 * connection", which the caller reports as 404 rather than as "not connected".
 */
export async function collectEditionContexts(
  editions: readonly WorkBuddyEdition[],
  connectionId?: string | null
): Promise<WorkBuddyEditionContext[]> {
  if (connectionId && connectionId.trim() !== "") {
    const resolved = await resolveWorkBuddyConnectionById(connectionId);
    return resolved === null
      ? []
      : [{ edition: resolved.edition, connected: true, credential: resolved }];
  }

  const contexts: WorkBuddyEditionContext[] = [];
  for (const edition of editions) {
    const credential = await resolveWorkBuddyConnection(edition.providerId);
    contexts.push({
      edition,
      connected: credential !== null,
      ...(credential === null ? {} : { credential }),
    });
  }
  return contexts;
}

/** 404 for a `connectionId` that does not name a WorkBuddy connection. */
export function connectionNotFound(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: "connection_not_found",
      error: "No WorkBuddy connection with that id. List them with GET /api/workbuddy/accounts.",
    },
    { status: 404 }
  );
}

/**
 * Read the shared targeting parameters off a query string.
 *
 * `provider` selects an edition; `connectionId` selects ONE imported account (see
 * `collectEditionContexts`). Callers pass both through unchanged so every overview route
 * accepts the same targeting, including the multi-account case where several accounts of
 * the same edition are imported.
 */
export function parseWorkBuddyTargetQuery(url: URL): {
  editions: WorkBuddyEdition[] | null;
  connectionId: string | null;
} {
  return {
    editions: resolveRequestedEditions(url.searchParams.get("provider")),
    connectionId: url.searchParams.get("connectionId"),
  };
}

/** Standard "no account imported yet" body for one edition. */
export function notConnectedBody(edition: WorkBuddyEdition) {
  return {
    provider: edition.providerId,
    region: edition.region,
    connected: false,
    message: `No ${edition.name} account is connected. Import one from the WorkBuddy desktop app (GET /api/workbuddy/accounts).`,
  };
}

/** Shape one error for a single edition without failing the whole response. */
export function editionError(edition: WorkBuddyEdition, error: unknown) {
  return {
    provider: edition.providerId,
    region: edition.region,
    connected: true,
    ok: false,
    error:
      sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) ||
      "Request failed.",
  };
}
