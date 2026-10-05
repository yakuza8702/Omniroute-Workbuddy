/**
 * GET  /api/workbuddy/accounts — what the desktop app has on this machine, and what this
 *                               addon has already imported.
 * POST /api/workbuddy/import   — import one discovered account as a provider connection.
 *
 * Split into two legs for the same reason the Zed keychain import is: the browser picks an
 * account by a sha256 FINGERPRINT, and the server re-reads the auth files when importing.
 * A token never crosses the boundary in either direction, and a tampered import request
 * cannot make the addon store a credential it has never seen on disk.
 *
 * Read-only towards the app: discovery opens its files, and nothing in this subtree
 * writes to them.
 *
 * @module app/api/workbuddy/accounts
 */

import { NextResponse } from "next/server";
import { guardWorkBuddyRequest, workBuddyError } from "../_lib";
import { discoverWorkBuddyCredentials } from "@/lib/workbuddy/credentials";
import { isWorkBuddyConnectionActive, listWorkBuddyConnections } from "@/lib/workbuddy/accounts";
import { WORKBUDDY_EDITIONS, type WorkBuddyEdition } from "@/lib/workbuddy/types";

/** Human-readable explanation of each probe failure. */
const PROBE_REASONS: Record<string, string> = {
  missing: "no auth file at this path",
  unreadable: "the file exists but could not be read",
  "not-json": "the file is not a JSON auth document",
  "no-token": "the document carries no access token",
  encrypted:
    "the document's tokens are encrypted by this app build; the addon does not carry that build's key — sign in through the app, or point WORKBUDDY_APP_EXECUTABLE at the install so the diagnostic can identify it",
};

export async function GET(request: Request): Promise<Response> {
  const denied = await guardWorkBuddyRequest(request);
  if (denied) return denied;

  try {
    const discovery = await discoverWorkBuddyCredentials();
    const connections = await Promise.all(
      WORKBUDDY_EDITIONS.map(async (edition: WorkBuddyEdition) => {
        const rows = await listWorkBuddyConnections(edition.providerId);
        return {
          provider: edition.providerId,
          region: edition.region,
          imported: rows.length,
          accounts: rows.map((row) => ({
            id: row.id ?? null,
            name: row.displayName ?? row.name ?? null,
            active: isWorkBuddyConnectionActive(row),
            createdAt: row.createdAt ?? null,
          })),
        };
      })
    );

    return NextResponse.json({
      ok: true,
      searchedDirectories: discovery.searchedDirs,
      ...(discovery.appExecutablePath === undefined
        ? {}
        : { appExecutablePath: discovery.appExecutablePath }),
      /**
       * Every path that was looked at, with the outcome. Reported even when nothing was
       * found, because "signed in but the app is not installed here" must never be
       * presented as "signed out" — the two need different user actions.
       */
      probes: discovery.probes.map((probe) => ({
        path: probe.path,
        ok: probe.ok,
        ...(probe.ok
          ? {}
          : {
              reason: probe.reason ?? "no-token",
              explanation: PROBE_REASONS[probe.reason ?? "no-token"],
            }),
      })),
      accounts: discovery.credentials.map((entry) => ({
        fingerprint: entry.fingerprint,
        account: entry.accountLabel,
        edition: entry.edition.providerId,
        region: entry.edition.region,
        domain: entry.credential.domain || "(default)",
        hasRefreshToken: Boolean(entry.credential.refreshToken),
        expiresAt:
          entry.credential.expiresAtMs === undefined
            ? null
            : new Date(entry.credential.expiresAtMs).toISOString(),
        sourceFile: entry.credential.filePath ?? null,
      })),
      connections,
    });
  } catch (error) {
    return workBuddyError(error);
  }
}
