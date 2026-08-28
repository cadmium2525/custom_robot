#!/bin/sh
# Round 12. The noise floor of the mass meter in BOTH settle modes, interleaved.
#
#   sh shots/_settle-ab.sh 4 http://127.0.0.1:4220/custom_robot/
#
# Why interleaved. The fault under test is that the unpinned meter's machine
# pose is a function of wall-clock load between boot and the shutter. A noise
# floor taken for mode A at 19:00 and mode B at 19:40 would therefore be
# comparing two different ambient loads as well as two settle modes, and this
# box has had a second agent's capture running on another port throughout. So
# the loop takes run i of BOTH modes back to back before moving to run i+1:
# whatever the machine is doing, it is doing it to both sides.
#
#   drive0  = the meter as shipped at c0202d1 — g.view.update(0, 1, t), so the
#             240-step settle drives the camera and leaves every damper in the
#             machine untouched.
#   drive60 = round 11's prescribed one-line fix — g.view.update(1/60, 1, t),
#             so the machines are settled at the same dt as the camera.
#
# Writes shots/_noise-r12drive0-<arena>-<i>.txt and _noise-r12pin-<arena>-<i>.txt,
# which shots/_noise.mjs reads back as min/max/spread per field.
N=${1:-4}
BASE=${2:-http://127.0.0.1:4220/custom_robot/}
cd "$(dirname "$0")/.." || exit 1
I=1
while [ "$I" -le "$N" ]; do
  for A in grid foundry orbital; do
    node tools/mass.mjs --base "$BASE" --arena "$A" --drive 0 \
      > "shots/_noise-r12drive0-$A-$I.txt" 2>&1
    echo "  drive0  $A run $I done"
    node tools/mass.mjs --base "$BASE" --arena "$A" \
      > "shots/_noise-r12pin-$A-$I.txt" 2>&1
    echo "  pin     $A run $I done"
  done
  I=$((I + 1))
done
echo "SETTLE AB COMPLETE"
