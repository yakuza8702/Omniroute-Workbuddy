#!/usr/bin/env bash
# WorkBuddy (git-build mode): no upstream artifact is fetched here anymore.
# Dockerfile.workbuddy compiles THIS repo's source directly, which already
# contains the whole WorkBuddy addon. Kept as a fast no-op so the existing
# `.github/workflows/workbuddy-sync-build.yml` step order (`take` → `apply`
# → `prune`) still runs end-to-end without workflow-file changes.
set -euo pipefail

VERSION="${1:?usage: take-upstream.sh <version>}"
mkdir -p build/workbuddy
printf '%s\n' "$VERSION" > build/workbuddy/UPSTREAM_VERSION
echo "[workbuddy] git-build mode: source compiles inside Dockerfile.workbuddy; no npm artifact to fetch (version marker: $VERSION)"
