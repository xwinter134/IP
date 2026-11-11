#!/usr/bin/env python3
"""xdata hook of pipeline/build_dist.py: scratch build with --limit 2000 and a fake dataset.

  python3 -I tests/xdata_test.py [--keep] [--limit 2000]

Builds (scratch dirs under the system temp dir, never dist/):
  1. artifact target, enc b64 : "fakeboth" copied as x.gz.b64.txt + y.json, "fakepages" absent, "fakepages" files_pages absent
  2. pages target, enc bin    : both datasets, .gz.bin unchanged, files_pages included
  3. a baseline artifact build without xdata, to check the budget accounting (text budget shrinks by the xdata size)
"""
import base64
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIMIT = "2000"
if "--limit" in sys.argv:
    LIMIT = sys.argv[sys.argv.index("--limit") + 1]
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def build(out, bdir, xdir, enc, target, extra=()):
    cmd = [sys.executable, "-I", os.path.join(ROOT, "pipeline", "build_dist.py"), "--out", out, "--build-dir", bdir,
           "--limit", LIMIT, "--enc", enc, "--xdata-dir", xdir, "--target", target, "--budget-mb", "215", "--no-chem"] + list(extra)
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return r


def fixed_line(stderr):
    for ln in stderr.splitlines():
        if "fixed parts:" in ln:
            return ln
    return ""


def main():
    if "--tmp" in sys.argv:                 # scratch dirs go under --tmp <dir> (or $TMPDIR)
        tempfile.tempdir = sys.argv[sys.argv.index("--tmp") + 1]
    tmp = tempfile.mkdtemp(prefix="xdata_test_")
    try:
        xd = os.path.join(tmp, "xdata")
        payload = gzip.compress(os.urandom(400000), mtime=0)
        big_pages = gzip.compress(os.urandom(120000), mtime=0)
        for name, target, files, extra in (("fakeboth", "both", ["x.gz.bin", "y.json"], []), ("fakepages", "pages", ["p.gz.bin"], [])):
            d = os.path.join(xd, name)
            os.makedirs(d)
            with open(os.path.join(d, files[0]), "wb") as f:
                f.write(payload if name == "fakeboth" else big_pages)
            if len(files) > 1:
                with open(os.path.join(d, files[1]), "w") as f:
                    json.dump({"hello": "world"}, f)
            meta = {"name": name, "v": "fk-1", "built": "2026-01-01T00:00:00Z", "target": target, "files": files, "counts": {"n": 7}}
            if name == "fakeboth":
                meta["files_pages"] = ["z.gz.bin"]
                with open(os.path.join(d, "z.gz.bin"), "wb") as f:
                    f.write(gzip.compress(b"pages only", mtime=0))
            with open(os.path.join(d, "xdata.json"), "w") as f:
                json.dump(meta, f)
        # 1 artifact, b64
        o1, b1 = os.path.join(tmp, "d_art"), os.path.join(tmp, "b_art")
        r = build(o1, b1, xd, "b64", "artifact")
        check(r.returncode == 0, "artifact build ok" + ("" if r.returncode == 0 else ": " + r.stderr[-400:] + r.stdout[-400:]))
        m = json.load(open(os.path.join(o1, "data", "manifest.json")))
        check(sorted(m.get("x", {})) == ["fakeboth"], "artifact: manifest.x has only fakeboth: %s" % sorted(m.get("x", {})))
        xb = m["x"]["fakeboth"]
        check(xb["v"] == "fk-1" and xb["built"] == "2026-01-01T00:00:00Z" and xb["counts"] == {"n": 7}, "manifest.x entry v/built/counts")
        p64 = os.path.join(o1, "data", "x", "fakeboth", "x.gz.b64.txt")
        check(os.path.isfile(p64) and base64.b64decode(open(p64, "rb").read()) == payload, "x.gz.bin -> x.gz.b64.txt, decodes to the payload")
        check(not os.path.exists(os.path.join(o1, "data", "x", "fakeboth", "x.gz.bin")), "no raw .bin in the b64 build")
        check(json.load(open(os.path.join(o1, "data", "x", "fakeboth", "y.json"))) == {"hello": "world"}, "y.json copied as is")
        check(xb["files"] == {"x.gz.bin": os.path.getsize(p64), "y.json": os.path.getsize(os.path.join(o1, "data", "x", "fakeboth", "y.json"))},
              "manifest.x files = logical name -> bytes on disk: %s" % xb["files"])
        check(not os.path.exists(os.path.join(o1, "data", "x", "fakepages")), "pages dataset absent from the artifact target")
        check(not os.path.exists(os.path.join(o1, "data", "x", "fakeboth", "z.gz.b64.txt")), "files_pages absent from the artifact target")
        for f in ("data/x/fakeboth/x.gz.b64.txt", "data/x/fakeboth/y.json"):
            check(f in m["files"] and m["files"][f][0] == os.path.getsize(os.path.join(o1, f)), "manifest.files lists " + f)
        batches = json.load(open(os.path.join(o1, "publish_batches.json")))
        listed = {f for b in batches for f in b["files"]}
        check("data/x/fakeboth/x.gz.b64.txt" in listed and "data/x/fakeboth/y.json" in listed, "publish batches contain the xdata files")
        check(m["sizes"].get("xdata") == xb["files"]["x.gz.bin"] + xb["files"]["y.json"], "sizes.xdata = bytes of the datasets (%s)" % m["sizes"].get("xdata"))
        check(m["totalBytes"] >= sum(v[0] for v in m["files"].values()), "totalBytes covers the files")
        # 2 pages, bin
        o2, b2 = os.path.join(tmp, "d_pg"), os.path.join(tmp, "b_pg")
        r2 = build(o2, b2, xd, "bin", "pages")
        check(r2.returncode == 0, "pages build ok" + ("" if r2.returncode == 0 else ": " + r2.stderr[-400:] + r2.stdout[-400:]))
        m2 = json.load(open(os.path.join(o2, "data", "manifest.json")))
        check(sorted(m2.get("x", {})) == ["fakeboth", "fakepages"], "pages: manifest.x has both datasets")
        check(open(os.path.join(o2, "data", "x", "fakeboth", "x.gz.bin"), "rb").read() == payload, "pages/bin: .gz.bin unchanged")
        check(os.path.isfile(os.path.join(o2, "data", "x", "fakeboth", "z.gz.bin")) and "z.gz.bin" in m2["x"]["fakeboth"]["files"], "pages: files_pages included")
        check(os.path.isfile(os.path.join(o2, "data", "x", "fakepages", "p.gz.bin")), "pages: pages-only dataset copied")
        # 3 no xdata: key absent, budget accounting
        o3, b3 = os.path.join(tmp, "d_none"), os.path.join(tmp, "b_none")
        r3 = build(o3, b3, os.path.join(tmp, "empty"), "b64", "artifact")
        check(r3.returncode == 0, "build without xdata ok")
        m3 = json.load(open(os.path.join(o3, "data", "manifest.json")))
        check("x" not in m3 and "xdata" not in m3["sizes"], "no datasets: manifest.x absent, no sizes.xdata")
        import re
        def fixed_mb(text):
            mm = re.search(r"-> ([0-9.]+) MB of", fixed_line(text))
            return float(mm.group(1)) if mm else None
        f1, f3 = fixed_mb(r.stdout + r.stderr), fixed_mb(r3.stdout + r3.stderr)
        diff = (f1 - f3) if f1 is not None and f3 is not None else None
        want = xb["files"]["x.gz.bin"] + xb["files"]["y.json"]
        check(diff is not None and abs(diff * 1e6 - want) < 20000 and diff > 0.3, "fixed parts grow by the xdata bytes (%s MB vs %s bytes)" % (diff, want))
        check("xdata" in fixed_line(r.stdout + r.stderr), "log line reports xdata in the fixed parts")
        # broken dataset fails loudly
        d = os.path.join(xd, "broken")
        os.makedirs(d)
        json.dump({"name": "broken", "v": 1, "files": ["nope.json"]}, open(os.path.join(d, "xdata.json"), "w"))
        r4 = build(os.path.join(tmp, "d4"), os.path.join(tmp, "b4"), xd, "b64", "artifact")
        check(r4.returncode != 0 and "missing" in (r4.stdout + r4.stderr), "missing listed file stops the build")
    finally:
        if "--keep" in sys.argv:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print("%d failed" % len(fails) if fails else "all ok")
    sys.exit(1 if fails else 0)


main()
