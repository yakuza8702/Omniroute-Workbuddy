/**
 * WorkBuddy addon — free-model resolution.
 *
 * "Free" here is not a marketing label: WorkBuddy publishes a per-model credit rate
 * (`"x0.00 credits"`), and a rate of exactly 0 means the request is billed nothing.
 * The rate is read from the live catalogue on every refresh, never hardcoded — the
 * reference integration documents upstream moving a model from 0 to a non-zero rate
 * between releases, which is precisely why a name list would rot.
 *
 * @module lib/workbuddy/freeModel
 */

import type { WorkBuddyModel } from "./types";

/** The zero-rate model an account can use without spending credits. */
export interface WorkBuddyFreeModel {
  model: WorkBuddyModel;
  /** Always 0; kept explicit so callers never re-derive it. */
  creditMultiplier: number;
}

/**
 * Pick the free model of a catalogue.
 *
 * When a catalogue declares several zero-rate models the one with the LARGEST context
 * window wins — the same tie-break the reference integration uses, so "the free model"
 * means the same thing in both places. A tie keeps upstream roster order, which is the
 * desktop picker's own order.
 *
 * Note the strictness: `undefined` (no rate declared) is NOT free. Only an explicit
 * `x0.00` counts, or the addon would recommend a model that silently bills.
 */
export function selectWorkBuddyFreeModel(
  models: readonly WorkBuddyModel[]
): WorkBuddyFreeModel | null {
  let best: WorkBuddyModel | null = null;
  for (const model of models) {
    if (model.creditMultiplier !== 0) continue;
    if (best === null || model.contextLength > best.contextLength) best = model;
  }
  return best === null ? null : { model: best, creditMultiplier: 0 };
}

/** Every zero-rate model of a catalogue, in upstream order. */
export function listWorkBuddyFreeModels(models: readonly WorkBuddyModel[]): WorkBuddyFreeModel[] {
  return models
    .filter((model) => model.creditMultiplier === 0)
    .map((model) => ({ model, creditMultiplier: 0 }));
}

/**
 * Models ordered by credit rate, cheapest first.
 *
 * Models whose rate the upstream did not declare sort last: an unknown rate is not a
 * cheap rate, and putting it first would recommend spending blind.
 */
export function rankWorkBuddyModelsByCost(models: readonly WorkBuddyModel[]): WorkBuddyModel[] {
  return [...models].sort((a, b) => {
    const left = a.creditMultiplier ?? Number.POSITIVE_INFINITY;
    const right = b.creditMultiplier ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return 0;
  });
}

/** One-line explanation of the pick, for the status surface. */
export function describeWorkBuddyFreeModel(
  models: readonly WorkBuddyModel[],
  modelId?: string
): string {
  if (modelId) {
    const requested = models.find((model) => model.id === modelId);
    if (!requested) return `Model "${modelId}" is not in the current WorkBuddy catalogue.`;
    if (requested.creditMultiplier === undefined) {
      return `${requested.name} does not declare a credit rate; the addon cannot tell whether it is free.`;
    }
    return requested.creditMultiplier === 0
      ? `${requested.name} is free (x0.00 credits).`
      : `${requested.name} costs x${requested.creditMultiplier.toFixed(2)} credits.`;
  }
  const free = listWorkBuddyFreeModels(models);
  if (free.length === 0) {
    return "No zero-rate model is currently published for this account.";
  }
  const pick = selectWorkBuddyFreeModel(models);
  return `${free.length} free model${free.length === 1 ? "" : "s"} available; ${pick?.model.name ?? free[0].model.name} has the largest context window (${
    pick?.model.contextLength ?? free[0].model.contextLength
  } tokens) and is the recommended free choice.`;
}
