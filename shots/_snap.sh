#!/bin/sh
# Build, then atomically refresh the serving root that _serve.mjs reads.
# Never point a server at dist/ itself — see the header of _serve.mjs.
set -e
cd "$(dirname "$0")/.."
npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; npm run build; exit 1; }
rm -rf shots/_root.new
cp -r dist shots/_root.new
rm -rf shots/_root.old
[ -d shots/_root ] && mv shots/_root shots/_root.old
mv shots/_root.new shots/_root
rm -rf shots/_root.old
echo "snapped $(date -u +%H:%M:%S) -> shots/_root"
