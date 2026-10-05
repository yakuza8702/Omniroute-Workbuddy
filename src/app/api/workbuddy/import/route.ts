/**
 * POST /api/workbuddy/import — import a discovered desktop account.
 *
 * Two properties make this safe to expose at all:
 *
 *  1. **The client sends a fingerprint, not a token.** The server re-reads the auth files
 *     and imports whatever that fingerprint matches right now; a tampered request can only
 *     ask for an account that genuinely exists on this machine.
 *  2. **Re-importing updates instead of duplicating.** A desktop sign-in refreshes its own
 *     token over time, so the same account is imported repeatedly in practice; each import
 *     refreshes the stored session in place (matched by login domain + account id) rather
 *     than leaving a pile of stale connections behind.
 *
 * Body: `{ "fingerprint": "<16 hex chars from GET /api/workbuddy/accounts>" }`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { guardWorkBuddyRequest, workBuddyError } from "../_lib";
import { readWorkBuddyCredentialByFingerprint } from "@/lib/workbuddy/credentials";
import {
  connectionPayloadFromWorkBuddyCredential,
  listWorkBuddyConnections,
} from "@/lib/workbuddy/accounts";
import { createProviderConnection, updateProviderConnection } from "@/lib/db/providers";

const ImportBodySchema = z
  .object({
    fingerprint: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(/^[0-9a-fA-F]+$/, "fingerprint must be hex"),
  })
  .strict();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Matches an existing connection for the same account (login domain + account id). */
function findExistingConnection(
  rows: readonly JsonRecord[],
  providerSpecificData: JsonRecord
): JsonRecord | null {
  const domain =
    typeof providerSpecificData.workbuddyDomain === "string"
      ? providerSpecificData.workbuddyDomain
      : "";
  const uid =
    typeof providerSpecificData.workbuddyUid === "string" ? providerSpecificData.workbuddyUid : "";
  for (const row of rows) {
    const psd = asRecord(row.providerSpecificData);
    if (String(psd.workbuddyDomain ?? "") !== domain) continue;
    // Without an account id the domain alone is not an identity: two accounts can share a
    // gateway, and merging them would silently point one login at the other's session.
    if (!uid || String(psd.workbuddyUid ?? "") !== uid) continue;
    return row;
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  const raw = await request.json().catch(() => ({}));
  const parsed = ImportBodySchema.safeParse(raw);
  if (!parsed.success) {
    return workBuddyError(
      "Invalid body. Expected { fingerprint } from GET /api/workbuddy/accounts.",
      400
    );
  }

  try {
    const discovered = await readWorkBuddyCredentialByFingerprint(parsed.data.fingerprint);
    if (!discovered) {
      return NextResponse.json(
        {
          ok: false,
          code: "credential_not_found",
          error:
            "No auth file on this machine currently matches that fingerprint. Re-run discovery — the desktop app may have rotated the sign-in.",
        },
        { status: 404 }
      );
    }

    const payload = connectionPayloadFromWorkBuddyCredential(discovered.credential);
    const providerSpecificData = asRecord(payload.providerSpecificData);
    const providerId = String(payload.provider);
    const existingRows = await listWorkBuddyConnections(providerId);
    const existing = findExistingConnection(existingRows, providerSpecificData);

    const connectionId = existing
      ? String(existing.id)
      : await createProviderConnection(payload).then((created) =>
          String(asRecord(created).id ?? "")
        );
    if (existing) {
      await updateProviderConnection(connectionId, payload);
    }

    return NextResponse.json({
      ok: true,
      provider: providerId,
      region: discovered.edition.region,
      connectionId,
      updated: existing !== null,
      account: discovered.accountLabel,
      domain: discovered.credential.domain || "(default)",
      hasRefreshToken: Boolean(discovered.credential.refreshToken),
      sourceFile: discovered.credential.filePath ?? null,
      note: "The desktop app's files were only read. The imported session now lives in this connection and is refreshed by OmniRoute's token service.",
    });
  } catch (error) {
    return workBuddyError(error);
  }
}
