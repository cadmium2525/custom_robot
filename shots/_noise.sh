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
# The FULL base path, not the bare root. `vite preview` answers `/` with a 302
# to `/custom_robot/` and playwright reports that as
# ERR_HTTP_RESPONSE_CODE_FAILURE, which is how round 12 lost eleven of twelve
# captures. Two further cautions, both bought the hard way:
#   - do not `npm run build` while `vite preview` is serving the sweep. The
#     build replaces dist/ underneath it, the server exits, and every remaining
#     capture records ERR_CONNECTION_REFUSED. Serve a COPY of dist that the
#     build never touches.
#   - read `node shots/_noise.mjs <tag>` before believing a summary. It now
#     names failed captures instead of calling them absent.
BASE=${3:-http://127.0.0.1:4211/custom_robot/}
cd "$(dirname "$0")/.." || exit 1
for A in grid foundry orbital; do
  I=1
  while [ "$I" -le "$N" ]; do
    node tools/mass.mjs --base "$BASE" --arena "$A" > "shots/_noise-$TAG-$A-$I.txt" 2>&1
    echo "  $TAG $A run $I done"
    I=$((I + 1))
  done
done
