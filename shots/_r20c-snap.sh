#!/bin/sh
# Build, then atomically refresh THE CRITIC'S OWN serving root — round 20.
#
# Same two hazards as shots/_r20-snap.sh, and the same fix, pointed at a root
# and a port nobody else in this round is using: dist-r20c, shots/_r20croot,
# port 4324. The builder holds 4320-4322; tools/ default to 4241. A capture
# under shots/r20c* is of a build THIS script made, and of no other.
#
#   sh shots/_r20c-snap.sh
#   SERVE_ROOT=$PWD/shots/_r20croot SERVE_PORT=4324 node shots/_serve.mjs &
set -e
cd "$(dirname "$0")/.."
npx vite build --outDir dist-r20c --emptyOutDir >/dev/null 2>&1 || {
  echo "BUILD FAILED"; npx vite build --outDir dist-r20c --emptyOutDir; exit 1; }
rm -rf shots/_r20croot.new
cp -r dist-r20c shots/_r20croot.new
rm -rf shots/_r20croot.old
[ -d shots/_r20croot ] && mv shots/_r20croot shots/_r20croot.old
mv shots/_r20croot.new shots/_r20croot
rm -rf shots/_r20croot.old
echo "snapped $(date -u +%H:%M:%S) -> shots/_r20croot"
