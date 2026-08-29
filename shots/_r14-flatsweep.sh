#!/bin/sh
# Sweep the light governor's FLATTEN against the mass curve, live.
#
# materials.js FILL_FRAG:  flatX = mix(uFlatFar, uFlat, sizeGateX())
#                          outX  = mix(lightX, uLightPivot, flatX)
# Both uFlat and uFlatFar ship at 0.0 (robot.js:2227), so outX == lightX and
# the flatten is inert: only the shoulder (uLightCeil) and the specular lid are
# doing anything. This is the knob whose own docstring says "at flatten 1.0
# every arena lights the shell identically, and the 91/129/142 spread would be
# one number" -- i.e. it is aimed exactly at the arena-variance defect.
#
# sizeGateX() is smoothstep(0.09, 0.22, on-screen fraction of frame height), so
# for the NEAR machine (foundry player: 331.7px/900 = 0.369) the gate is 1 and
# only uFlat is read; for the FAR machine (foundry opponent: 102.5px = 0.114)
# the gate is ~0.13 and it is almost entirely uFlatFar. One run reads both.
#
# Spelling: --u flat=X,flatFar=Y  (mass.mjs prefixes 'u' and capitalises).
BASE=${BASE:-http://127.0.0.1:4311/custom_robot/}
cd "$(dirname "$0")/.." || exit 1
for A in $ARENAS; do
  for P in $PAIRS; do
    F=${P%:*}; FF=${P#*:}
    for I in $REPS; do
      node tools/mass.mjs --base "$BASE" --arena "$A" --u "flat=$F,flatFar=$FF" \
        > "shots/_noise-r14L$F-$FF-$A-$I.txt" 2>&1
      echo "  flat $F/$FF $A run $I done"
    done
  done
done
