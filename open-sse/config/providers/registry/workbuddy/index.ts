import type { RegistryEntry } from "../../shared.ts";

/**
 * WorkBuddy 国内版 (Tencent) — copilot.tencent.com.
 *
 * The domestic edition of the WorkBuddy desktop app. Chat is OpenAI-compatible on the
 * same Tencent gateway the CodeBuddy CN integration uses; the account's real model
 * roster comes from `/v2/enterprises/personal/models`, which the addon refreshes through
 * the model-sync path (`src/lib/workbuddy/upstream.ts::fetchWorkBuddyModels`).
 *
 * `passthroughModels` is on because that directory — not this list — is the truth: the
 * static entries below are the offline fallback so the provider can answer a
 * `/v1/models` call before the first sync lands, and they carry no credit rate (rates
 * are read from the live directory, where the free model is whichever entry declares
 * `x0.00`).
 *
 * `forceStream` mirrors the reference client, which always asks this gateway for a
 * stream: the sibling CodeBuddy CN entry on the same host rejects non-stream chat with
 * business code 11101, and OmniRoute re-aggregates the SSE for non-streaming clients.
 *
 * Short alias "wb" (国内版); the international edition is `workbuddy-global` / "wbg".
 */
export const workbuddyProvider: RegistryEntry = {
  id: "workbuddy",
  alias: "wb",
  format: "openai",
  executor: "workbuddy",
  baseUrl: "https://copilot.tencent.com/v2/chat/completions",
  authType: "oauth",
  authHeader: "bearer",
  forceStream: true,
  passthroughModels: true,
  // The catalogue is discovered live; a non-empty synced list is the account's real
  // roster, so static fallback rows must not survive it.
  liveCatalogAuthoritative: true,
  models: [
    // Fallback roster captured from the domestic directory. Replaced by the live
    // refresh; kept so an offline instance still shows a usable picker.
    {
      id: "auto",
      name: "Auto",
      contextLength: 168000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "hy3",
      name: "Hy3",
      contextLength: 192000,
      maxOutputTokens: 64000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5v-Turbo",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      contextLength: 1000000,
      maxOutputTokens: 48000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      contextLength: 1000000,
      maxOutputTokens: 48000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      contextLength: 200000,
      maxOutputTokens: 48000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "minimax-m3",
      name: "MiniMax-M3",
      contextLength: 512000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "kimi-k3-1",
      name: "Kimi-K3",
      contextLength: 1000000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "kimi-k2.7",
      name: "Kimi-K2.7-Code",
      contextLength: 256000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "kimi-k2.6",
      name: "Kimi-K2.6",
      contextLength: 256000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek-V4-Flash",
      contextLength: 1000000,
      maxOutputTokens: 50000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      contextLength: 1000000,
      maxOutputTokens: 50000,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
  ],
};

export default workbuddyProvider;
