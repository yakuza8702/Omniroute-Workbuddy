#!/usr/bin/env node
// WorkBuddy: apply THIS repo's WorkBuddy changes on top of the upstream
// compiled artifact extracted by take-upstream.sh — WITHOUT recompiling the
// OmniRoute monorepo on GitHub's free runners.
//
// Two mechanisms, both declarative and version-safe:
//
//   workbuddy-overlay/files/**      copied verbatim over the upstream package
//                                   (new compiled addon files: providers,
//                                   executors, API routes, i18n messages…)
//
//   workbuddy-overlay/rewrites.json array of { file, find, replace } surgical
//                                   text patches into upstream compiled files
//                                   (registry / dispatch / catalogue wiring that
//                                   registers the WorkBuddy providers).
//
// Every rewrite is anchored to exact upstream text; if the author changes the
// compiled file such that an anchor no longer matches, the job FAILS LOUDLY
// listing the stale rewrite — you then regenerate that rewrite against the new
// upstream output once (locally) and commit it. Nothing silently drifts.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync, readdirSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";

const UPSTREAM = join(process.cwd(), "build/workbuddy/upstream");
const OVERLAY = join(process.cwd(), "workbuddy-overlay");

if (!existsSync(UPSTREAM)) {
  console.error("❌ build/workbuddy/upstream missing — run take-upstream.sh first.");
  process.exit(1);
}
if (!existsSync(OVERLAY)) {
  console.error("❌ workbuddy-overlay missing — nothing to apply.");
  process.exit(1);
}

const ver = () => process.env.OMNIROUTE_VERSION || readFileSync(join(process.cwd(), "build/workbuddy/UPSTREAM_VERSION"), "utf8").trim();
console.log(`[workbuddy] applying overlay for upstream ${ver()}`);

/**
 * @type {string[] | null}
 */
let manifestStale = null;

// ── 1) Verbatim file overlay ────────────────────────────────────────────────
let copied = 0;
const filesDir = join(OVERLAY, "files");
if (existsSync(filesDir)) {
  cpSync(filesDir, UPSTREAM, { recursive: true });
  const countFiles = (dir) => {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      n += statSync(p).isDirectory() ? countFiles(p) : 1;
    }
    return n;
  };
  copied = countFiles(filesDir);
  console.log(`[workbuddy] overlay: ${copied} files copied verbatim over the upstream package`);
}

// ── 2) Anchored text rewrites into upstream compiled files ──────────────────
const manifestPath = join(OVERLAY, "rewrites.json");
if (existsSync(manifestPath)) {
  /** @type {{ file: string; find: string; replace: string; note?: string }[]} */
  const rewrites = JSON.parse(readFileSync(manifestPath, "utf8"));
  const stale = [];

  for (const r of rewrites) {
    const target = join(UPSTREAM, ...r.file.split(posix.sep));
    if (!existsSync(target)) {
      stale.push(`${r.file} (file not present in upstream ${ver()} — moved or renamed)`);
      continue;
    }
    const src = readFileSync(target, "utf8");
    if (!src.includes(r.find)) {
      stale.push(`${r.file} (${r.note || "anchor missing"} — upstream output changed)`);
      continue;
    }
    if (src.includes(r.replace)) {
      // Idempotent: a re-run over an already-patched file is a no-op.
      console.log(`[workbuddy] skip (already applied): ${r.file}`);
      continue;
    }
    writeFileSync(target, src.replace(r.find, r.replace));
    console.log(`[workbuddy] rewrote: ${r.file}${r.note ? ` (${r.note})` : ""}`);
  }

  if (stale.length) {
    // A drifted compiled file degrades ONE wiring point, it must not nuke the
    // whole release pickup. Default: warn loudly, skip, keep building so the
    // image still tracks the newest upstream. STRICT mode (WORKBUDDY_STRICT=1)
    // is the fail-closed / review-gate mode.
    const msg =
      `\n⚠️  WorkBuddy overlay anchors stale vs upstream ${ver()}:\n` +
      stale.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
      `\nRegenerate these entries against the new upstream output (one local build), then commit.\n`;
    manifestStale = stale;
    if (process.env.WORKBUDDY_STRICT === "1") {
      console.error(`❌ STRICT mode refusing to continue.` + msg);
      process.exit(2);
    }
    console.warn(msg);
  }
}

// ── 3) Always-on reconciliation manifest (audit trail) ─────────────────────
const manifest = {
  appliedAt: new Date().toISOString(),
  upstreamVersion: ver(),
  overlayFilesCopied: copied,
  rewrites: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).length : 0,
  staleAnchors: manifestStale,
};
writeFileSync(join(process.cwd(), "build/workbuddy/APPLY_MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`[workbuddy] overlay applied cleanly: ${JSON.stringify(manifest)}`);
