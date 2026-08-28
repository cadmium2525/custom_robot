#!/bin/sh
# Noise floor for tools/mass.mjs — run the SAME build N times per arena and
# keep every line, so the spread between identical runs can be read off before
# any A/B delta is believed.
#
#   sh shots/_noise.sh 4 out-tag           # 4 repeats, all three arenas
#
# Writes shots/_noise-<tag>-<arena>-<i>.txt. Summarise with _noise.mjs.
N=${1:-3}
TAG=${2:-base}
cd "$(dirname "$0")/.." || exit 1
for A in grid foundry orbital; do
  I=1
  while [ "$I" -le "$N" ]; do
    node tools/mass.mjs --arena "$A" > "shots/_noise-$TAG-$A-$I.txt" 2>&1
    echo "  $TAG $A run $I done"
    I=$((I + 1))
  done
done
