import type { RegistryEntry } from "../../shared.ts";

/**
 * WorkBuddy International — www.workbuddy.ai (or www.codebuddy.ai).
 *
 * The international edition of the WorkBuddy desktop app. Two brand domains serve the
 * same international stack, and a token minted at one is rejected by the other, so the
 * gateway follows the credential's own `domain` rather than a fixed host. The executor
 * resolves that per request; the `baseUrl` here is the desktop app's own gateway, used
 * when an account's domain is unknown.
 *
 * The global model roster is read from `/v3/config` with the DESKTOP channel's user
 * agent: that document differs per client channel, and the CLI channel omits free
 * chat-usable models entirely (including `deepseek-v4.1-flash`), so a CLI-shaped request
 * would publish an incomplete picker. See `src/lib/workbuddy/upstream.ts`.
 *
 * The international edition has NO daily check-in; the addon reports that as a property
 * of the edition instead of offering a button that always 404s.
 *
 * Short alias "wbg" (paired with the domestic edition's "wb").
 */
export const workbuddyGlobalProvider: RegistryEntry = {
  id: "workbuddy-global",
  alias: "wbg",
  format: "openai",
  executor: "workbuddy-global",
  baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
  authType: "oauth",
  authHeader: "bearer",
  forceStream: true,
  passthroughModels: true,
  liveCatalogAuthoritative: true,
  models: [
    // Fallback roster captured from the international desktop-channel product config.
    // Credit rates live upstream (x0.00 marks the free entries) and are refreshed into
    // the synced catalogue, so they are deliberately absent from this seed.
    {
      id: "default-model",
      name: "Auto",
      contextLength: 176000,
      maxOutputTokens: 24000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "fast-model",
      name: "Fast",
      contextLength: 200000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "balanced-model",
      name: "Balanced",
      contextLength: 256000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "primary-model",
      name: "Primary",
      contextLength: 272000,
      maxOutputTokens: 72000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "deep-model",
      name: "Deep",
      contextLength: 176000,
      maxOutputTokens: 24000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek-V4.1-Flash",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "hy4-preview",
      name: "Hy4 preview",
      contextLength: 1000000,
      maxOutputTokens: 64000,
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
      id: "gpt-6-astra",
      name: "GPT-6-Astra",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6-Terra",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6-Luna",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextLength: 272000,
      maxOutputTokens: 72000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3-Codex",
      contextLength: 272000,
      maxOutputTokens: 72000,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "gemini-3.5-flash",
      name: "Gemini-3.5-Flash",
      contextLength: 1000000,
      maxOutputTokens: 65536,
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
      id: "kimi-k3",
      name: "Kimi-K3",
      contextLength: 1000000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
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
  ],
};

export default workbuddyGlobalProvider;
