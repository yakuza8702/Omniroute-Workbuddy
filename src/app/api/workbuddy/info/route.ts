/**
 * GET /api/workbuddy/info — how this addon works, as data.
 *
 * Serves the description from `src/lib/workbuddy/addonInfo.ts` plus a cheap, network-free
 * status: which editions have an imported account. Nothing here calls the upstream, so a
 * settings page can render the whole feature set (and explain a disabled action) on load
 * without spending a credit query or tripping a rate limit.
 */

import { NextResponse } from "next/server";
import { guardWorkBuddyRequest, workBuddyError } from "../_lib";
import { describeWorkBuddyAddon } from "@/lib/workbuddy/addonInfo";
import { listWorkBuddyConnections } from "@/lib/workbuddy/accounts";
import { WORKBUDDY_EDITIONS } from "@/lib/workbuddy/types";

export async function GET(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  try {
    const editions = await Promise.all(
      WORKBUDDY_EDITIONS.map(async (edition) => {
        const rows = await listWorkBuddyConnections(edition.providerId);
        return {
          provider: edition.providerId,
          region: edition.region,
          label: edition.label,
          connected: rows.length > 0,
          connections: rows.length,
          supportsCheckin: edition.supportsCheckin,
        };
      })
    );

    return NextResponse.json({
      ok: true,
      ...describeWorkBuddyAddon(),
      status: {
        editions,
        routes: {
          info: "GET /api/workbuddy/info",
          accounts: "GET /api/workbuddy/accounts",
          import: "POST /api/workbuddy/import",
          models: "GET /api/workbuddy/models",
          credits: "GET /api/workbuddy/credits",
          freeModel: "GET /api/workbuddy/free-model",
          checkin: "GET|POST /api/workbuddy/checkin",
        },
        loopbackOnly: true,
      },
    });
  } catch (error) {
    return workBuddyError(error);
  }
}
