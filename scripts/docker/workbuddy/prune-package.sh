#!/usr/bin/env bash
# WorkBuddy (git-build mode): nothing pruned here anymore — the upstream
# package tree (build/workbuddy/upstream) is no longer materialized; the
# image's runtime footprint comes straight from .build/next/standalone.
set -euo pipefail
echo "[workbuddy] git-build mode: no package to prune"
