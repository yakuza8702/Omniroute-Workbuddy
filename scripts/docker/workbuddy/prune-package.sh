#!/usr/bin/env bash
# WorkBuddy image: drop the bits of the upstream npm package we do not ship.
# Keeps the final image small on the free CI budget (the desktop/electron
# payloads and dev tooling never run inside the server container).
set -euo pipefail

P="build/workbuddy/upstream"
for path in \
  "$P/electron" \
  "$P/dist/.build/electron" \
  "$P/docs" \
  "$P/docs.i18n" \
  "$P/tests" \
  "$P/.github" \
  "$P/scripts" ; do
  if [ -e "$path" ]; then
    rm -rf "$path"
    echo "[workbuddy] pruned $path"
  fi
done
