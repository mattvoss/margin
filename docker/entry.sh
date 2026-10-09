#!/bin/sh
# Seed /data on first boot, then start the Nitro server.
set -eu

mkdir -p /data/workspaces

# First boot: seed the default workspace from the bundled sample so the
# editor opens with demo content instead of an empty volume.
if [ -z "$(ls -A /data/workspaces/default 2>/dev/null || true)" ]; then
  mkdir -p /data/workspaces/default
  cp -r /app/sample-workspace/. /data/workspaces/default/ 2>/dev/null || true
fi

exec node .output/server/index.mjs
