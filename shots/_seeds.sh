#!/bin/sh
# THE SILHOUETTE METER, ACROSS MORE THAN ONE FRAME.
#
# Every #24 figure this project has ever filed — including "foundry 47% clean
# against grid's 81.5%", the headline the round-17 brief is built on — comes
# from tools/contour.mjs at its DEFAULT seed, 1234567, at tick 420. That is one
# frame per arena, and the frames are not comparable: at that seed grid puts
# 24421 robot pixels on screen with the near machine standing in the open, while
# foundry puts 4895 with the near machine four-fifths hidden behind a block. A
# silhouette meter reads what is in front of the machine, so an occluded machine
# does not measure the arena's art, it measures the block.
#
# So: same tick, same tier, N seeds, all three arenas. `startMatch` seeds the
# demo AI, so a different seed is a different fight and therefore a different
# pose, position and occlusion — which is exactly the axis the single-frame
# figures have no coverage of.
#
#   sh shots/_seeds.sh shots/r17seeds http://127.0.0.1:4300/custom_robot/ "11 22 33 44 55 1234567"
#
# Writes <dir>/<arena>-<seed>.txt. Read them with shots/_seedtab.mjs.
DIR=${1:-shots/r17seeds}
BASE=${2:-http://127.0.0.1:4300/custom_robot/}
SEEDS=${3:-"11 22 33 44 55 1234567"}
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$DIR"
for A in grid foundry orbital; do
  (
    for S in $SEEDS; do
      [ -s "$DIR/$A-$S.txt" ] && continue
      node tools/contour.mjs --base "$BASE" --arena "$A" --seed "$S" \
        > "$DIR/$A-$S.txt" 2>&1 || echo "  $A/$S FAILED"
    done
    echo "  $A done"
  ) &
done
wait
echo "seed sweep -> $DIR"
