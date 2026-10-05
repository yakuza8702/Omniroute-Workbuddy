/**
 * GET  /api/workbuddy/checkin — today's check-in state (read-only).
 * POST /api/workbuddy/checkin — claim today's check-in reward.
 *
 * The claim is a REAL credit grant, so it is guarded twice:
 *
 *  1. The status endpoint is read first and an already-claimed day is reported as such
 *     instead of being re-posted. The addon does not bet credits on the upstream being
 *     idempotent when it can simply ask.
 *  2. The action only ever runs because a caller asked for it. There is no scheduler
 *     here, no "auto check-in" flag, and no retry loop — a background job that spends
 *     credits is exactly the kind of thing an operator must be able to point at.
 *
 * The international edition has no check-in endpoint at all, so it is reported as
 * unsupported (with that reason) rather than surfaced as a button that always 404s.
 *
 * Body (POST): `{ "provider": "workbuddy" | "workbuddy-global" }` — optional, defaults to
 * the domestic edition.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  collectEditionContexts,
  connectionNotFound,
  editionError,
  guardWorkBuddyRequest,
  parseWorkBuddyTargetQuery,
  workBuddyError,
} from "../_lib";
import { claimWorkBuddyDailyCheckin, fetchWorkBuddyCheckinStatus } from "@/lib/workbuddy/upstream";
import { resolveWorkBuddyConnectionById } from "@/lib/workbuddy/accounts";
import { WORKBUDDY_EDITIONS } from "@/lib/workbuddy/types";

const CheckinBodySchema = z
  .object({
    provider: z.string().trim().min(1).max(64).optional(),
    /**
     * Target one imported account. Needed when several accounts of the same edition are
     * imported: without it the claim would always go to the active/newest one, and a
     * second account could only be checked in after being made active.
     */
    connectionId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

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
        results.push({
          ...notConnected(context.edition.providerId, context.edition.region),
          supported: context.edition.supportsCheckin,
        });
        continue;
      }
      if (!context.edition.supportsCheckin) {
        results.push({
          provider: context.edition.providerId,
          region: context.edition.region,
          connected: true,
          supported: false,
          message: "The international edition has no daily check-in.",
        });
        continue;
      }
      try {
        const status = await fetchWorkBuddyCheckinStatus(context.credential.credential);
        results.push({
          provider: context.edition.providerId,
          region: context.edition.region,
          connected: true,
          connectionId: context.credential.connection.id ?? null,
          supported: true,
          ok: true,
          claimable: status.active && !status.todayCheckedIn,
          status,
        });
      } catch (error) {
        results.push({ ...editionError(context.edition, error), supported: true });
      }
    }
    return NextResponse.json({ ok: true, editions: results });
  } catch (error) {
    return workBuddyError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  const raw = await request.json().catch(() => ({}));
  const parsed = CheckinBodySchema.safeParse(raw);
  if (!parsed.success) {
    return workBuddyError(
      'Invalid request body. Expected {"provider": "workbuddy"} and optionally {"connectionId": "..."}.',
      400
    );
  }

  const requestedId = parsed.data.connectionId ?? null;
  // A named account decides its own edition; the `provider` field is only consulted when
  // the caller did not name one.
  const named = requestedId === null ? null : await resolveWorkBuddyConnectionById(requestedId);
  if (requestedId !== null && named === null) return connectionNotFound();

  const requested = parsed.data.provider ?? WORKBUDDY_EDITIONS[0].providerId;
  const editions = named === null ? resolveRequestedEditions(requested) : [named.edition];
  if (!editions) {
    return workBuddyError("Unknown provider. Use workbuddy (cn) or workbuddy-global.", 400);
  }
  const edition = editions[0];
  if (!edition.supportsCheckin) {
    return NextResponse.json(
      {
        ok: false,
        provider: edition.providerId,
        region: edition.region,
        code: "checkin_unsupported",
        error: "The international edition has no daily check-in.",
      },
      { status: 409 }
    );
  }

  try {
    const contexts = await collectEditionContexts([edition], requestedId);
    const context = contexts[0];
    if (!context?.credential) {
      return NextResponse.json(
        {
          ok: false,
          provider: edition.providerId,
          region: edition.region,
          code: "not_connected",
          error: `No ${edition.name} account is connected.`,
        },
        { status: 404 }
      );
    }

    const connectionId = context.credential.connection.id ?? null;
    const status = await fetchWorkBuddyCheckinStatus(context.credential.credential);
    if (!status.active) {
      return NextResponse.json({
        ok: true,
        provider: edition.providerId,
        region: edition.region,
        connectionId,
        claimed: false,
        alreadyCheckedIn: false,
        code: "checkin_inactive",
        message: "Check-in is not active for this account.",
        status,
      });
    }
    if (status.todayCheckedIn) {
      return NextResponse.json({
        ok: true,
        provider: edition.providerId,
        region: edition.region,
        connectionId,
        claimed: false,
        alreadyCheckedIn: true,
        message: `Already checked in today (${status.todayCredit} credits, ${status.streakDays}-day streak). Nothing was claimed.`,
        status,
      });
    }

    const claim = await claimWorkBuddyDailyCheckin(context.credential.credential);
    return NextResponse.json({
      ok: true,
      provider: edition.providerId,
      region: edition.region,
      connectionId,
      claimed: true,
      alreadyCheckedIn: false,
      credit: claim.credit,
      streakDays: claim.streakDays,
      isStreakDay: claim.isStreakDay,
      message: `Claimed ${claim.credit} credits (${claim.streakDays}-day streak).`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        provider: edition.providerId,
        region: edition.region,
        ...editionError(edition, error),
      },
      { status: 502 }
    );
  }
}

function notConnected(provider: string, region: string) {
  return {
    provider,
    region,
    connected: false,
    message: `No ${provider} account is connected. Import one from the WorkBuddy desktop app.`,
  };
}
