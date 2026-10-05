/**
 * GET /api/workbuddy/models — the live model directory, per edition.
 *
 * This is the "fetch models" half of the addon, and it is deliberately the same call the
 * catalogue sync uses (`fetchWorkBuddyModels`), so what the dashboard previews and what
 * the provider advertises cannot disagree. Each model is returned with its credit rate
 * and a `free` flag, because on WorkBuddy the rate — not the name — is what decides
 * whether a request costs anything.
 *
 * Query: `?provider=workbuddy|workbuddy-global|cn|global` (omit for both editions).
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
import { describeWorkBuddyFreeModel, listWorkBuddyFreeModels } from "@/lib/workbuddy/freeModel";

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
        const models = await fetchWorkBuddyModels(context.credential.credential);
        results.push({
          provider: context.edition.providerId,
          region: context.edition.region,
          connected: true,
          ok: true,
          connectionId: context.credential.connection.id ?? null,
          count: models.length,
          freeModels: listWorkBuddyFreeModels(models).map((entry) => entry.model.id),
          freeModelSummary: describeWorkBuddyFreeModel(models),
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            contextLength: model.contextLength,
            maxOutputTokens: model.maxOutputTokens,
            ...(model.creditMultiplier === undefined
              ? {}
              : { creditMultiplier: model.creditMultiplier, free: model.creditMultiplier === 0 }),
            ...(model.supportsVision === undefined ? {} : { supportsVision: model.supportsVision }),
            ...(model.supportsToolCall === undefined
              ? {}
              : { supportsToolCall: model.supportsToolCall }),
            ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
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
