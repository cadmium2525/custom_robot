#!/usr/bin/env bash
# Build + serve + capture on a private port, so several people can iterate on
# the same working tree at once without fighting over dist/ or port 4173.
#
#   tools/devshot.sh <name> <port> <scenario>[,<scenario>...] [screenshot flags]
#
# Example:
#   tools/devshot.sh robot 4201 hero --tier 3
#   tools/devshot.sh ui 4204 title,garage,settings --tier 3
#
# A comma-separated list captures every scenario from one build and one browser
# launch, which is most of the wall clock on a review pass.
#
# Writes shots/<name>-<scenario>.png and prints the in-page perf stats.
set -euo pipefail

NAME="${1:?usage: devshot.sh <name> <port> <scenario> [flags...]}"
PORT="${2:?port}"
SCENE="${3:?scenario}"
shift 3

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="/tmp/devshot-$NAME"

cd "$ROOT"

# Root base path so the bundle resolves when served from the directory root.
BASE_PATH=/ npx vite build --outDir "$OUT" >/tmp/devshot-$NAME.build.log 2>&1 || {
  echo "BUILD FAILED — tail of /tmp/devshot-$NAME.build.log:" >&2
  tail -25 "/tmp/devshot-$NAME.build.log" >&2
  exit 1
}

# Reuse the server if it's already up on this port.
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  (cd "$OUT" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 1
  done
fi

mkdir -p "$ROOT/shots"
if [[ "$SCENE" == *,* ]]; then
  node tools/screenshot.mjs \
    --base "http://127.0.0.1:$PORT/" \
    --shots "$SCENE" \
    --outdir "$ROOT/shots" \
    --prefix "$NAME-" \
    "$@"
else
  node tools/screenshot.mjs \
    --base "http://127.0.0.1:$PORT/" \
    --shot "$SCENE" \
    --out "$ROOT/shots/$NAME-$SCENE.png" \
    "$@"
fi
