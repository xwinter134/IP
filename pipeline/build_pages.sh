#!/bin/sh
# Build the plain-website version (GitHub Pages or any static host) into dist-pages/.
# Unlike the Artifact build it uses raw binary data files and has no 240 MB limit.
# The Claude features (FTO analysis, AI search) are not available on a plain website.
set -e
cd "$(dirname "$0")/.."
LNP_HOST_MAX_MB=950 python3 -I pipeline/build_dist.py --enc bin --out dist-pages \
  --build-dir data/work/dist_build_pages --budget-mb 900 --max-files 3000 --img-budget-mb 300 --target pages
python3 -I - <<'PY'
import io
p = "dist-pages/index.html"
body = io.open(p, encoding="utf-8").read()
if not body.lstrip().lower().startswith("<!doctype"):
    head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<meta name="robots" content="noindex,nofollow">'
            '<style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style></head><body>\n')
    io.open(p, "w", encoding="utf-8").write(head + body + "\n</body></html>\n")
io.open("dist-pages/.nojekyll", "w").write("")
io.open("dist-pages/robots.txt", "w").write("User-agent: *\nDisallow: /\n")
PY
rm -f dist-pages/publish_batches.json
du -sh dist-pages
