#!/usr/bin/env bash
# WorkBuddy: take ONLY the already-compiled upstream OmniRoute artifact.
# No repo-wide compile: the author's published npm package ships compiled
# output (dist/, dist/.build/next/...), which is what the Docker image runs.
# We fetch it, extract it, and layer the WorkBuddy overlay on top (apply.mjs)
# — the "take the latest release files only" strategy for free runners.
set -euo pipefail

VERSION="${1:?usage: take-upstream.sh <version>}"
OUT_DIR="build/workbuddy/upstream"

mkdir -p "$OUT_DIR"
echo "[workbuddy] fetching omniroute@$VERSION from registry.npmjs.org"
npm pack "omniroute@$VERSION" --pack-destination . >/dev/null

tar -xzf "omniroute-$VERSION.tgz" -C "$OUT_DIR" --strip-components=1
rm -f "omniroute-$VERSION.tgz"

printf '%s\n' "$VERSION" > build/workbuddy/UPSTREAM_VERSION
echo "[workbuddy] extracted upstream $VERSION to $OUT_DIR ($(find "$OUT_DIR" -type f | wc -l) files)"
