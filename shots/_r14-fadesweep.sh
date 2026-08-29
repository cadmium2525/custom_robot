#!/bin/sh
# Sweep the frame line-art fade against the mass curve, live, one browser
# launch per value and NO rebuild — the knob is a uniform published on the
# shell's bag (robot.js:2332), so tools/mass.mjs --u reaches it.
#
# SPELLING: --u frameFade=X. mass.mjs builds the name as 'u'+Capitalise(key),
# so `--u uFrameFade=X` becomes uUFrameFade and is silently ignored while the
# tool still prints a confirmation. Verified with shots/_r14-fadecheck.mjs.
BASE=${BASE:-http://127.0.0.1:4311/custom_robot/}
cd "$(dirname "$0")/.." || exit 1
for A in $ARENAS; do
  for F in $FADES; do
    for I in $REPS; do
      node tools/mass.mjs --base "$BASE" --arena "$A" --u "frameFade=$F" \
        > "shots/_noise-r14f$F-$A-$I.txt" 2>&1
      echo "  fade $F $A run $I done"
    done
  done
done
