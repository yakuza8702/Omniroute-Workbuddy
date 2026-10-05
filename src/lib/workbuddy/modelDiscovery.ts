/**
 * WorkBuddy addon — live model discovery for the provider sync path.
 *
 * WorkBuddy has no OpenAI-shaped `/v1/models` endpoint, so the generic `modelsUrl`
 * discovery cannot serve it: the roster lives in a product-config document whose shape is
 * WorkBuddy's own (`models` + an `agents` roster, per-model credit rates). This module is
 * the adapter between that document and the platform's synced-catalogue rows, and it is
 * the single place the mapping lives — the dashboard preview route and the sync route read
 * the same models, so they cannot disagree.
 *
 * The credit rate survives the mapping as `isFree`: on WorkBuddy a zero rate is a property
 * of the model that changes between releases, and dropping it here would leave every
 * consumer to guess which entries cost nothing.
 *
 * @module lib/workbuddy/modelDiscovery
 */

import { credentialFromWorkBuddyConnection } from "./accounts";
import { fetchWorkBuddyModels } from "./upstream";
import { WORKBUDDY_PROVIDER_ID, WORKBUDDY_GLOBAL_PROVIDER_ID, type WorkBuddyModel } from "./types";
import type { SyncedAvailableModelInput } from "@/lib/db/models/synced";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/**
 * Provider id → the model this addon should sync, or `null` for any other provider.
 *
 * Both the canonical ids and the short aliases are accepted, because a connection can be
 * created under either and a sync that silently did nothing would look like an empty
 * catalogue rather than a routing mistake.
 */
export function providerToWorkBuddyProviderId(providerId: string): string | null {
  const id = providerId.trim().toLowerCase();
  if (id === WORKBUDDY_PROVIDER_ID || id === "wb" || id === "cn") return WORKBUDDY_PROVIDER_ID;
  if (id === WORKBUDDY_GLOBAL_PROVIDER_ID || id === "wbg" || id === "global") {
    return WORKBUDDY_GLOBAL_PROVIDER_ID;
  }
  return null;
}

/** Map a WorkBuddy catalogue onto synced-catalogue rows. */
export function workBuddyModelsToSyncedInput(
  models: readonly WorkBuddyModel[]
): SyncedAvailableModelInput[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    source: "api-sync",
    apiFormat: "chat-completions",
    contextWindow: model.contextLength,
    outputTokenLimit: model.maxOutputTokens,
    inputTokenLimit: model.contextLength,
    ...(model.supportsVision === undefined ? {} : { supportsVision: model.supportsVision }),
    ...(model.supportsToolCall === undefined ? {} : { supportsTools: model.supportsToolCall }),
    ...(model.reasoning?.supportedEfforts === undefined
      ? {}
      : { supportedThinkingEfforts: model.reasoning.supportedEfforts }),
    ...(model.reasoning?.defaultEffort === undefined
      ? {}
      : { defaultThinkingEffort: model.reasoning.defaultEffort }),
    // A declared x0.00 rate is the upstream's own statement that the model bills nothing;
    // an absent rate stays absent (undefined → the field is omitted, never `false`, which
    // would assert a paid model where the upstream simply said nothing).
    ...(model.creditMultiplier === undefined ? {} : { isFree: model.creditMultiplier === 0 }),
    ...(model.descriptionEn === undefined && model.descriptionZh === undefined
      ? {}
      : { description: model.descriptionEn ?? model.descriptionZh }),
  }));
}

/**
 * Fetch the live catalogue for a connection, ready for the synced-catalogue write.
 *
 * Throws with a bounded message when the credential is missing or the upstream refuses —
 * the caller (`sync-models`) turns that into a 401/502 without echoing the upstream body.
 */
export async function fetchWorkBuddySyncModels(
  providerId: string,
  connection: unknown
): Promise<SyncedAvailableModelInput[]> {
  const resolvedProviderId = providerToWorkBuddyProviderId(providerId);
  if (!resolvedProviderId) throw new Error(`Not a WorkBuddy provider: ${providerId}`);

  const credential = credentialFromWorkBuddyConnection(asRecord(connection));
  if (!credential) {
    throw new Error("WorkBuddy connection has no access token — import the desktop account again");
  }

  const models = await fetchWorkBuddyModels(credential);
  return workBuddyModelsToSyncedInput(models);
}
