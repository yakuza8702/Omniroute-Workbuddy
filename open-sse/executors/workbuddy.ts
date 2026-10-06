import { DefaultExecutor } from "./default.ts";
import type { ProviderCredentials } from "./base.ts";
import {
  buildWorkBuddyChatHeaders,
  credentialFromWorkBuddyRequest,
  prepareWorkBuddyChatBody,
} from "@/lib/workbuddy/upstream";
import { WORKBUDDY_PROVIDER_ID } from "@/lib/workbuddy/types";

/**
 * WorkBuddyExecutor — talks to the WorkBuddy gateways
 * (`copilot.tencent.com` for 国内版, `www.workbuddy.ai` / `www.codebuddy.ai` for the
 * international edition).
 *
 * Both editions speak OpenAI chat-completions, so translation and streaming need no
 * special handling; what they DO need is a header set that cannot be expressed
 * statically, and a conversation head the international gateway accepts:
 *
 *  - **Identity headers.** The gateway wants `X-User-Id` / `X-Enterprise-Id` / `X-Domain`
 *    per ACCOUNT, and the `X-No-*` spelling for the attributes an account does not have
 *    ("absent" and "empty" are different answers to this gateway). Those values live in
 *    the connection's `providerSpecificData`, so they are applied here, per request,
 *    rather than in the registry's static header table.
 *  - **Leading system message.** The international gateway refuses a user-first body with
 *    business code 11128 ("first message is not system prompt"), which it surfaces as
 *    "blocked by security policy"; the domestic gateway tolerates the same body, so the
 *    fault only ever appears on the global route. See `ensureWorkBuddySystemHead`.
 *  - **Streaming.** `forceStream` on the registry entry keeps the upstream request
 *    streaming even when the client asked for JSON (OmniRoute re-aggregates it), matching
 *    how the first-party clients always call this gateway.
 *
 * One class serves both editions (the alias constructs it with the other provider id), so
 * the two routes can never drift apart in header or body handling.
 */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor(provider: string = WORKBUDDY_PROVIDER_ID) {
    super(provider);
  }

  buildHeaders(
    credentials: ProviderCredentials,
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string,
    health?: Record<string, unknown>,
    body?: unknown
  ): Record<string, string> {
    const headers = super.buildHeaders(credentials, stream, clientHeaders, model, health, body);
    const credential = credentialFromWorkBuddyRequest(credentials);
    if (!credential) return headers;

    const workBuddyHeaders = buildWorkBuddyChatHeaders(credential);
    for (const [name, value] of Object.entries(workBuddyHeaders)) {
      // Authorization/Content-Type are already correct from the base class; only the
      // gateway-specific identity and origin headers are added here.
      if (name === "Authorization" || name === "Content-Type") continue;
      headers[name] = value;
    }
    return headers;
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const transformed = super.transformRequest(model, body, stream, credentials);
    // `forceStream` already keeps the transport streaming; `prepareWorkBuddyChatBody`
    // sets the body flag too (a client that explicitly asked for JSON still produces an
    // SSE request the gateway accepts), maps `developer`→`system`, guarantees the
    // leading system message, and flattens `tool_choice` into the string form — each
    // rule taken from the reference client, which encodes what this gateway enforces.
    void stream;
    return prepareWorkBuddyChatBody(transformed);
  }
}

export default WorkBuddyExecutor;
