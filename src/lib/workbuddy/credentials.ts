/**
 * WorkBuddy addon — desktop-app credential integration (read-only).
 *
 * WorkBuddy's models are not sold as bare API keys: the account lives in the WorkBuddy
 * desktop app, which keeps its login in an auth file under the user's profile. This
 * module integrates that application WITHOUT taking it over — the app's files are only
 * ever read, never rewritten, and nothing is refreshed in place. The addon copies what
 * it needs into its own connection, where OmniRoute's normal token lifecycle owns it.
 *
 * Two details from the reference implementation are load-bearing here:
 *
 *  1. The app leaves a TIMESTAMPED BACKUP per sign-in (`workbuddy-desktop.<stamp>.info`)
 *     next to the live file, and different backups can hold different accounts. Scanning
 *     the directory (instead of only the live file) is what makes account selection
 *     possible at all, so every candidate is fingerprinted and offered.
 *  2. Recent Windows builds store `accessToken`/`refreshToken` as an AES-GCM envelope
 *     (`{"$wbEncrypted":1,"envelope":"…"}`) whose key is baked into that build. The addon
 *     does not carry a copy of that key and does not shell out to the app to obtain it:
 *     such a file is reported as "present but encrypted" with the one action that helps
 *     (sign in / point `WORKBUDDY_APP_EXECUTABLE` at the install), never as "signed out".
 *
 * @module lib/workbuddy/credentials
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

import { editionForDomain, type WorkBuddyCredential, type WorkBuddyEdition } from "./types";

/** Live auth file the desktop app refreshes in place (domestic build). */
export const WORKBUDDY_LIVE_AUTH_FILENAME = "workbuddy-desktop.info";
/**
 * Edition-suffixed document names, live and timestamped backup.
 *
 * The desktop app names its documents per edition: the domestic build writes
 * `workbuddy-desktop.info` / `workbuddy-desktop.<stamp>.<pid>.<uuid>.info`,
 * while the international build writes `workbuddy-desktop-ai.info` and
 * `workbuddy-desktop-ai.<stamp>.<pid>.<uuid>.info` (verified on a real Linux
 * install under `~/.local/share/CodeBuddyExtension/Data/Public/auth/`).
 * Matching only the domestic names made discovery answer `accounts: []` with
 * `probes: []` for an international sign-in — no error, just silence.
 */
const WORKBUDDY_LIVE_FILENAME_PATTERN = /^workbuddy-desktop(?:-[a-z0-9]+)?\.info$/i;
const WORKBUDDY_BACKUP_FILENAME_PATTERN = /^workbuddy-desktop(?:-[a-z0-9]+)?\..+\.info$/i;

/**
 * Environment overrides, read with LITERAL member access (`env.WORKBUDDY_AUTH_FILE`)
 * rather than through a computed key.
 *
 * That is not style: the docs audit (`scripts/check/check-fabricated-docs.mjs`) indexes
 * env vars by their literal read, so an override read through a constant would let the
 * documentation name a variable nothing appears to read. The env object is injectable so
 * every branch stays testable without touching a real machine.
 *
 *   - `WORKBUDDY_AUTH_FILE`        — one explicit auth file (highest precedence)
 *   - `WORKBUDDY_AUTH_DIR`         — an auth directory outside the platform default
 *   - `WORKBUDDY_APP_EXECUTABLE`   — the desktop app's path, reported in diagnostics
 */
type NodeEnv = Record<string, string | undefined>;

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Platform-default directories holding the desktop app's auth folder.
 *
 * Windows and Linux prefer the OS-issued env location and fall back to the
 * home-derived convention when it is unset, so a redirected profile (OneDrive backup,
 * enterprise policy) still resolves. macOS has no equivalent variable.
 *
 * `platform`, `home` and `env` are injectable so every branch is testable on any host
 * without touching a real machine.
 */
export function workBuddyDesktopAuthDirs(
  platform: string = process.platform,
  home: string = homedir(),
  env: NodeEnv = process.env
): string[] {
  const override = nonEmptyEnv(env.WORKBUDDY_AUTH_DIR);
  if (override) return [override];
  if (platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  if (platform === "win32") {
    const local = nonEmptyEnv(env.LOCALAPPDATA) ?? join(home, "AppData", "Local");
    const roaming = nonEmptyEnv(env.APPDATA) ?? join(home, "AppData", "Roaming");
    return [
      join(local, "CodeBuddyExtension", "Data", "Public", "auth"),
      join(roaming, "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  if (platform === "linux") {
    const config = nonEmptyEnv(env.XDG_CONFIG_HOME) ?? join(home, ".config");
    return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  return [];
}

/** Whether a filename is one of the app's auth documents (live or timestamped backup). */
export function isWorkBuddyAuthFilename(name: string): boolean {
  return WORKBUDDY_LIVE_FILENAME_PATTERN.test(name) || WORKBUDDY_BACKUP_FILENAME_PATTERN.test(name);
}

/**
 * Whether a filename is a LIVE auth document (no timestamp segment) — the
 * account the app is currently signed in as, in either edition's naming.
 */
export function isWorkBuddyLiveAuthFilename(name: string): boolean {
  return WORKBUDDY_LIVE_FILENAME_PATTERN.test(name);
}

/** A field wrapper the desktop app uses for encrypted credential values. */
interface EncryptedFieldWrapper {
  $wbEncrypted: 1;
  envelope: string;
}

function isEncryptedFieldWrapper(value: unknown): value is EncryptedFieldWrapper {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).$wbEncrypted === 1 &&
    typeof (value as Record<string, unknown>).envelope === "string"
  );
}

/** Why a probed auth file produced no usable credential. */
export type WorkBuddyProbeFailure =
  "missing" | "unreadable" | "not-json" | "no-token" | "encrypted";

export interface WorkBuddyProbeResult {
  path: string;
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: WorkBuddyProbeFailure;
}

/** A discovered credential plus the identity the dashboard may show. */
export interface WorkBuddyDiscoveredCredential {
  credential: WorkBuddyCredential;
  edition: WorkBuddyEdition;
  /** Stable, non-secret handle: sha256(domain|account|token) truncated to 16 hex. */
  fingerprint: string;
  /** Masked account label (nickname, or a masked `uin`), for display only. */
  accountLabel: string;
}

export interface WorkBuddyDiscovery {
  credentials: WorkBuddyDiscoveredCredential[];
  /** Every candidate path that was looked at, with the outcome — "already signed in
   *  but the app is not installed" must never be reported as "signed out". */
  probes: WorkBuddyProbeResult[];
  /** Directories scanned, for the status surface. */
  searchedDirs: string[];
  /**
   * The desktop app path from `WORKBUDDY_APP_EXECUTABLE`, when set. Reported (never used
   * to launch anything) because it is the only lever a user has when the app lives in a
   * non-default location and a credential file turns out to be encrypted.
   */
  appExecutablePath?: string;
}

/**
 * Stable handle for a credential, safe to hand to a browser.
 *
 * The token itself never leaves the server: the dashboard picks accounts by
 * fingerprint and the server re-reads the files when importing, so a tampered client
 * cannot ask the addon to import an unrelated credential.
 */
export function fingerprintWorkBuddyCredential(credential: WorkBuddyCredential): string {
  const seed = [
    credential.domain ?? "",
    credential.uin ?? credential.uid ?? "",
    credential.accessToken,
  ].join("|");
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/** Display label that never reveals the full account number. */
export function workBuddyAccountLabel(credential: WorkBuddyCredential): string {
  if (credential.nickname) return credential.nickname;
  const uin = credential.uin ?? credential.uid ?? "";
  if (uin.length <= 4) return uin || "(unknown account)";
  return `${uin.slice(0, 3)}****${uin.slice(-2)}`;
}

function expiryToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || value <= 0) return undefined;
  return value > 1e12 ? value : value * 1000;
}

/**
 * Parse an auth document. Both on-disk shapes are accepted: the OAuth nested form
 * `{"auth":{…},"account":{…}}` and the flat panel form.
 *
 * Returns a reason instead of a credential when none can be read, so the caller can
 * distinguish "no login" from "login present but unreadable".
 */
export function parseWorkBuddyAuthDocument(
  text: string,
  filePath: string
): { credential?: WorkBuddyCredential; reason?: WorkBuddyProbeFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "not-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: "not-json" };
  const document = parsed as Record<string, unknown>;
  const nested =
    document.auth && typeof document.auth === "object" && !Array.isArray(document.auth);
  const auth = (nested ? document.auth : document) as Record<string, unknown>;
  const identity = (
    nested &&
    document.account &&
    typeof document.account === "object" &&
    !Array.isArray(document.account)
      ? document.account
      : document
  ) as Record<string, unknown>;

  const encrypted =
    isEncryptedFieldWrapper(auth.accessToken) || isEncryptedFieldWrapper(auth.refreshToken);
  if (encrypted) return { reason: "encrypted" };
  if (typeof auth.accessToken !== "string" || auth.accessToken === "") {
    return { reason: "no-token" };
  }

  const optionalString = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;

  return {
    credential: {
      accessToken: auth.accessToken,
      refreshToken: optionalString(auth.refreshToken) ?? "",
      domain: optionalString(auth.domain) ?? "",
      ...(optionalString(identity.uid) === undefined ? {} : { uid: optionalString(identity.uid) }),
      ...(optionalString(identity.enterpriseId) === undefined
        ? {}
        : { enterpriseId: optionalString(identity.enterpriseId) }),
      ...(optionalString(identity.nickname) === undefined
        ? {}
        : { nickname: optionalString(identity.nickname) }),
      ...(optionalString(identity.uin) === undefined ? {} : { uin: optionalString(identity.uin) }),
      ...(expiryToMs(auth.expiresAt) === undefined
        ? {}
        : { expiresAtMs: expiryToMs(auth.expiresAt) }),
      source: "desktop",
      filePath,
    },
  };
}

/**
 * Every auth-file candidate, live file first.
 *
 * Order matters: the live file is the account the app is currently signed in as, and
 * ties between two files holding the same account are resolved in favour of the
 * earlier candidate (see {@link discoverWorkBuddyCredentials}), so backups never
 * shadow the live sign-in.
 */
export async function listWorkBuddyAuthFiles(
  platform: string = process.platform,
  home: string = homedir(),
  env: NodeEnv = process.env
): Promise<{ files: string[]; dirs: string[] }> {
  const explicitFile = nonEmptyEnv(env.WORKBUDDY_AUTH_FILE);
  const dirs = workBuddyDesktopAuthDirs(platform, home, env);
  const files: string[] = [];
  if (explicitFile) files.push(explicitFile);

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const live = entries.filter((name) => isWorkBuddyLiveAuthFilename(name));
    const backups = entries
      .filter((name) => !isWorkBuddyLiveAuthFilename(name) && isWorkBuddyAuthFilename(name))
      .sort();
    for (const name of [...live, ...backups.slice().reverse()]) {
      const path = join(dir, name);
      if (!files.includes(path)) files.push(path);
    }
  }
  return { files, dirs };
}

/**
 * Read every auth file and return the usable credentials.
 *
 * De-duplication is by account (uin/uid) and keeps the FIRST sighting, which — because
 * the live file is listed first — is the account the app is signed in as right now.
 */
export async function discoverWorkBuddyCredentials(
  options: { platform?: string; home?: string; env?: NodeEnv } = {}
): Promise<WorkBuddyDiscovery> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const { files, dirs } = await listWorkBuddyAuthFiles(platform, home, env);

  const probes: WorkBuddyProbeResult[] = [];
  const credentials: WorkBuddyDiscoveredCredential[] = [];
  const seenAccounts = new Set<string>();

  for (const path of files) {
    let text: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        probes.push({ path, ok: false, reason: "missing" });
        continue;
      }
      text = await readFile(path, "utf8");
    } catch {
      probes.push({ path, ok: false, reason: "unreadable" });
      continue;
    }

    const parsed = parseWorkBuddyAuthDocument(text, path);
    if (!parsed.credential) {
      probes.push({ path, ok: false, reason: parsed.reason ?? "no-token" });
      continue;
    }
    const accountKey = [
      parsed.credential.domain,
      parsed.credential.uin ?? parsed.credential.uid ?? parsed.credential.accessToken.slice(-12),
    ].join("|");
    if (seenAccounts.has(accountKey)) {
      probes.push({ path, ok: true });
      continue;
    }
    seenAccounts.add(accountKey);
    probes.push({ path, ok: true });
    credentials.push({
      credential: parsed.credential,
      edition: editionForDomain(parsed.credential.domain),
      fingerprint: fingerprintWorkBuddyCredential(parsed.credential),
      accountLabel: workBuddyAccountLabel(parsed.credential),
    });
  }

  return {
    credentials,
    probes,
    searchedDirs: dirs,
    ...(nonEmptyEnv(env.WORKBUDDY_APP_EXECUTABLE) === undefined
      ? {}
      : { appExecutablePath: nonEmptyEnv(env.WORKBUDDY_APP_EXECUTABLE) }),
  };
}

/**
 * Re-read the files and return the credential matching `fingerprint`.
 *
 * The import route calls this instead of trusting anything the client sent: the
 * fingerprint is a CHECKSUM of what is on disk right now, so a tampered import request
 * cannot make the addon store a credential it never saw.
 */
export async function readWorkBuddyCredentialByFingerprint(
  fingerprint: string,
  options: { platform?: string; home?: string; env?: NodeEnv } = {}
): Promise<WorkBuddyDiscoveredCredential | null> {
  const normalized = fingerprint.trim().toLowerCase();
  if (!normalized) return null;
  const discovery = await discoverWorkBuddyCredentials(options);
  return discovery.credentials.find((entry) => entry.fingerprint === normalized) ?? null;
}
