#!/bin/sh
# The pinned dump pair, per arena, which every OFFLINE meter in this project
# reads: `<dir>/<arena>-n.png` (the settled frame, VFX off, DOM hidden) and
# `<dir>/<arena>-mask.png` (the machines' white-on-black stencil).
#
#   sh shots/_dump.sh shots/r12dump http://127.0.0.1:4220/custom_robot/
#
# This exists because it has been re-derived by hand in at least rounds 7, 8
# and 12 — `contour.mjs --keep` writes to two FIXED filenames, so capturing
# three arenas means three runs and six renames, and the renames are where the
# arenas get crossed. Doing it in a script means the pair is always named after
# the arena it came from.
DIR=${1:-shots/dump}
BASE=${2:-http://127.0.0.1:4220/custom_robot/}
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$DIR"
for A in grid foundry orbital; do
  node tools/contour.mjs --base "$BASE" --arena "$A" --keep > "$DIR/$A-contour.txt" 2>&1 || {
    echo "  $A FAILED — see $DIR/$A-contour.txt"; continue; }
  mv shots/contour-n.png "$DIR/$A-n.png"
  mv shots/contour-mask.png "$DIR/$A-mask.png"
  echo "  $A -> $DIR/$A-n.png + $DIR/$A-mask.png"
done
