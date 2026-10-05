#!/usr/bin/env node
// WorkBuddy (git-build mode): the WorkBuddy changes are part of THIS repo's
// source tree (providers, executors, /api/workbuddy routes, i18n), so there is
// no separate overlay to paste — Dockerfile.workbuddy compiles everything
// directly. This keeps the "apply" step of the existing workflow as a no-op
// that instead VALIDATES the tree it is about to build.
import { existsSync } from "node:fs";

const required = [
  "package.json",
  "package-lock.json",
  "open-sse/package.json",
  "open-sse/executors/workbuddy.ts",
  "open-sse/config/providers/registry/workbuddy/index.ts",
  "open-sse/config/providers/registry/workbuddy-global/index.ts",
  "src/app/api/workbuddy/info/route.ts",
  "src/shared/constants/providers/oauth.ts",
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`❌ workbuddy git-build: missing source files:\n  ${missing.join("\n  ")}`);
  process.exit(2);
}
console.log(
  "[workbuddy] git-build mode: source tree validated —",
  `${required.length} workbuddy source files present; nothing to paste over.`,
);
