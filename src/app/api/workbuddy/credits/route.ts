/**
 * GET /api/workbuddy/credits — remaining credits, per edition.
 *
 * The credit meter is the reason this addon exists rather than a plain gateway entry:
 * WorkBuddy spends CREDITS, and a model's rate converts a request into a spend, so
 * "how much is left, and what expires first" is the question an operator actually has.
 *
 * Packages are returned unmerged (recurring refills and one-off bonuses side by side,
 * with their own dates) because collapsing them loses exactly the dates a decision needs.
 *
 * Read-only: nothing here spends or claims. Claiming is `POST /api/workbuddy/checkin`.
 * Query: `?provider=workbuddy|workbuddy-global|cn|global`.
 */

import { NextResponse } from "next/server";
import {
  collectEditionContexts,
  connectionNotFound,
  editionError,
  guardWorkBuddyRequest,
  notConnectedBody,
  parseWorkBuddyTargetQuery,
  workBuddyError,
} from "../_lib";
import { fetchWorkBuddyCredits } from "@/lib/workbuddy/upstream";

export async function GET(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const { editions, connectionId } = parseWorkBuddyTargetQuery(url);
  if (!editions) {
    return workBuddyError("Unknown provider. Use workbuddy (cn) or workbuddy-global.", 400);
  }

  try {
    const contexts = await collectEditionContexts(editions, connectionId);
    if (connectionId && contexts.length === 0) return connectionNotFound();
    const results = [];
    for (const context of contexts) {
      if (!context.credential) {
        results.push(notConnectedBody(context.edition));
        continue;
      }
      try {
        const credits = await fetchWorkBuddyCredits(context.credential.credential);
        results.push({
          provider: context.edition.providerId,
          region: context.edition.region,
          connected: true,
          ok: true,
          connectionId: context.credential.connection.id ?? null,
          account: context.credential.connection.displayName ?? null,
          total: credits.total,
          expiringSoon: credits.expiringSoon,
          nearestExpiry:
            credits.nearestExpiryMs === undefined
              ? null
              : new Date(credits.nearestExpiryMs).toISOString(),
          packages: credits.packages.map((entry) => ({
            name: entry.packageName,
            remaining: entry.remain,
            size: entry.size,
            kind: entry.monthly ? "refill" : "one-off",
            refreshAt:
              entry.refreshAtMs === undefined ? null : new Date(entry.refreshAtMs).toISOString(),
            expiresAt:
              entry.expiresAtMs === undefined ? null : new Date(entry.expiresAtMs).toISOString(),
          })),
        });
      } catch (error) {
        results.push(editionError(context.edition, error));
      }
    }
    return NextResponse.json({ ok: true, editions: results });
  } catch (error) {
    return workBuddyError(error);
  }
}
