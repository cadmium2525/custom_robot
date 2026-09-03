#!/bin/sh
# Build, then atomically refresh THIS agent's own serving root — round 20.
#
# Two separate hazards, and this script exists because both have cost a round:
#
#   1. `shots/_root` on :4300 is shared. A sweep that reads it can photograph
#      another agent's half-landed edit and there is no way to tell from the
#      PNG. So round 20 gets its own root (shots/_r20root) and its own port
#      (4320); every capture under shots/r20* is of a build this script made.
#   2. `npm run build` writes dist/, and another agent running the same command
#      replaces dist/ under this one. So this builds into dist-r20 instead —
#      the outDir is ours alone, and vite's own emptyOutDir cannot then delete
#      somebody else's tree.
#
#   sh shots/_r20-snap.sh                 # build -> shots/_r20root
#   SERVE_ROOT=$PWD/shots/_r20root SERVE_PORT=4320 node shots/_serve.mjs &
set -e
cd "$(dirname "$0")/.."
npx vite build --outDir dist-r20 --emptyOutDir >/dev/null 2>&1 || {
  echo "BUILD FAILED"; npx vite build --outDir dist-r20 --emptyOutDir; exit 1; }
rm -rf shots/_r20root.new
cp -r dist-r20 shots/_r20root.new
rm -rf shots/_r20root.old
[ -d shots/_r20root ] && mv shots/_r20root shots/_r20root.old
mv shots/_r20root.new shots/_r20root
rm -rf shots/_r20root.old
echo "snapped $(date -u +%H:%M:%S) -> shots/_r20root"
