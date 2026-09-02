#!/bin/sh
# Build, then atomically refresh THIS agent's own serving root.
#
# `shots/_root` on :4300 is shared and four agents commit concurrently; a sweep
# that reads it can photograph somebody else's half-landed edit and there is no
# way to tell from the PNG. So the phone work gets its own root and its own
# port, and every capture in shots/_r17/ is of a build this script made.
set -e
cd "$(dirname "$0")/.."
npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; npm run build; exit 1; }
rm -rf shots/_r17root.new
cp -r dist shots/_r17root.new
rm -rf shots/_r17root.old
[ -d shots/_r17root ] && mv shots/_r17root shots/_r17root.old
mv shots/_r17root.new shots/_r17root
rm -rf shots/_r17root.old
echo "snapped $(date -u +%H:%M:%S) -> shots/_r17root"
