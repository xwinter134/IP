#!/usr/bin/env bash
# Rebuild dist/ from the current caches. Every stage is incremental and safe to run while the downloads
# (pipeline/fetch_ep.py, pipeline/fetch_us.py, pipeline/status.py --fetch-only) are still running; this script never
# starts or stops a download.
#
#   pipeline/run_all.sh                 normalize -> status (cache only) -> chemistry (if stale) -> dist (base64)
#   pipeline/run_all.sh batches [-v]    list the publish batches of dist/ (-v: with file names)
#   pipeline/run_all.sh check           the engine tests and the end-to-end test against dist/
# Environment: ENC=bin builds the raw-binary variant into data/dist-bin/ for local tests (the Artifact host refuses *.bin).
set -euo pipefail
cd "$(dirname "$0")/.."
PY="python3 -I"

stage() {   # stage <name> <command...>: run and report the wall time
  local name=$1; shift
  local t0=$SECONDS
  echo "== $name: $*"
  "$@"
  echo "== $name done in $((SECONDS - t0)) s"
}

batches() {
  $PY - "$@" <<'PYEOF'
import json, os, sys
v = "-v" in sys.argv[1:]
b = json.load(open("dist/publish_batches.json"))
m = json.load(open("dist/data/manifest.json"))
tot = sum(x["bytes"] for x in b); n = sum(len(x["files"]) for x in b)
print("dist: %d files, %.1f MB, enc %s, built %s (host limits: 500 files, 240 MB, 15 MB per file)" % (n, tot / 1e6, m.get("enc"), m.get("built")))
for i, x in enumerate(b, 1):
    big = max(x["files"], key=lambda f: os.path.getsize(os.path.join("dist", f)))
    print("batch %d: %3d files, %6.2f MB   first %s   largest %s (%.1f MB)" % (i, len(x["files"]), x["bytes"] / 1e6, x["files"][0], big, os.path.getsize(os.path.join("dist", big)) / 1e6))
    if v:
        for f in x["files"]:
            print("   " + f)
bad = [f for x in b for f in x["files"] if f.endswith(".bin")]
if bad:
    print("WARNING: %d *.bin files; the Artifact host refuses them (rebuild without --enc bin)" % len(bad))
PYEOF
}

case "${1:-build}" in
  batches) shift; batches "$@" ;;
  check)
    stage "search engine test" node tests/search_test.mjs --no-browser
    stage "chemistry test" node tests/chem_test.cjs
    stage "FTO engine test" node tests/fto_test.mjs
    stage "end-to-end test" node tests/e2e.cjs
    ;;
  build)
    T0=$SECONDS
    stage "normalize" $PY pipeline/normalize.py
    stage "status" $PY pipeline/status.py --no-fetch
    # chemistry: only when an input is newer than the last build (cached run: about 10 s, cold: about 6 min)
    if [ ! -f data/work/chem/chem.json ] || [ -n "$(find data/work/targets.parquet data/seed/ref_lipids_pubchem.json pipeline/chem_build.cjs pipeline/chem_export.py pipeline/chem_names.cjs web/engine/chemfp.js -newer data/work/chem/chem.json 2>/dev/null)" ]; then
      stage "chemistry" node pipeline/chem_build.cjs
    else
      echo "== chemistry: data/work/chem is up to date"
    fi
    # extra datasets (xdata): each step is skipped when its script does not exist (yet)
    for step in ranges_build tags_build markush_seed; do
      if [ -f "pipeline/$step.py" ]; then stage "$step" $PY "pipeline/$step.py"; fi
    done
    if [ "${ENC:-b64}" = "bin" ]; then
      stage "dist (raw binary, local only)" $PY pipeline/build_dist.py --enc bin --out data/dist-bin
    else
      stage "dist" $PY pipeline/build_dist.py
      batches
    fi
    echo "== all stages: $((SECONDS - T0)) s"
    ;;
  *) echo "usage: pipeline/run_all.sh [build|batches [-v]|check]" >&2; exit 2 ;;
esac
