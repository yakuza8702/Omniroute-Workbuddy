/**
 * GET /api/workbuddy/free-model — the current free model, per edition.
 *
 * "Current" is the point: WorkBuddy moves models in and out of the zero-rate tier
 * between releases, so the answer is derived from the LIVE catalogue's own credit rates
 * on every call. A missing rate is not treated as free — only an explicit `x0.00` is —
 * because recommending a model that silently bills is worse than answering "none".
 *
 * Query: `?provider=…` for one edition, `?model=<id>` to check a specific model.
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
import { fetchWorkBuddyModels } from "@/lib/workbuddy/upstream";
import {
  describeWorkBuddyFreeModel,
  listWorkBuddyFreeModels,
  rankWorkBuddyModelsByCost,
  selectWorkBuddyFreeModel,
} from "@/lib/workbuddy/freeModel";

export async function GET(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const { editions, connectionId } = parseWorkBuddyTargetQuery(url);
  if (!editions) {
    return workBuddyError("Unknown provider. Use workbuddy (cn) or workbuddy-global.", 400);
  }
  const requestedModel = url.searchParams.get("model") ?? undefined;

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
        const models = await fetchWorkBuddyModels(context.credential.credential);
        const pick = selectWorkBuddyFreeModel(models);
        const cheapest = rankWorkBuddyModelsByCost(models)[0];
        results.push({
          provider: context.edition.providerId,
          region: context.edition.region,
          connected: true,
          ok: true,
          connectionId: context.credential.connection.id ?? null,
          summary: describeWorkBuddyFreeModel(models, requestedModel),
          freeModel:
            pick === null
              ? null
              : {
                  id: pick.model.id,
                  name: pick.model.name,
                  contextLength: pick.model.contextLength,
                },
          freeModels: listWorkBuddyFreeModels(models).map((entry) => ({
            id: entry.model.id,
            name: entry.model.name,
            contextLength: entry.model.contextLength,
          })),
          cheapestPaidModel:
            cheapest?.creditMultiplier === undefined || cheapest?.creditMultiplier === 0
              ? null
              : {
                  id: cheapest?.id ?? null,
                  name: cheapest?.name ?? null,
                  creditMultiplier: cheapest?.creditMultiplier ?? null,
                },
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
