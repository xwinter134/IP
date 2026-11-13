#!/usr/bin/env python3
"""Fetch the missing US full texts on your own computer (no data/ folder, no extra packages).

Reads pipeline/us_todo.tsv (guid <TAB> source; written from the session's targets), downloads each document from
USPTO ppubs into us_cache/<guid>.json.gz (same format as data/cache/us/), skips files that are already there, and can
be stopped and restarted at any time. When it is done, zip the folder and attach it to a GitHub release:

    python3 pipeline/fetch_us_local.py            # about 1 document per 2 s, several hours
    zip -r us_cache.zip us_cache

Only public patent documents are fetched; nothing is sent anywhere else.
"""
import argparse, gzip, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import ppubs  # noqa: E402  (standard library only)

HERE = os.path.dirname(os.path.abspath(__file__))
DROP = ("dwImageDoctypeList", "dwImageLocList", "dwPageCountList", "dwImageDocidList")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--todo", default=os.path.join(HERE, "us_todo.tsv"))
    ap.add_argument("--out", default="us_cache")
    ap.add_argument("--pause", type=float, default=1.5)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    todo = [ln.rstrip("\n").split("\t") for ln in open(a.todo, encoding="utf8") if ln.strip()]
    todo = [(g, s) for g, s in todo if not os.path.exists(os.path.join(a.out, g + ".json.gz"))]
    print("to fetch: %d" % len(todo), flush=True)
    cl = ppubs.Client(pause=a.pause)
    ok = fails = 0
    t0 = time.time()
    for i, (g, src) in enumerate(todo, 1):
        try:
            d = json.loads(cl.fulltext_raw(g, src))
            if not isinstance(d, dict) or not (d.get("claimsHtml") or d.get("descriptionHtml") or d.get("abstractHtml")):
                raise ValueError("empty document")
            for k in DROP:
                d.pop(k, None)
            path = os.path.join(a.out, g + ".json.gz")
            with open(path + ".tmp", "wb") as f:
                f.write(gzip.compress(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf8"), 6))
            os.replace(path + ".tmp", path)
            ok += 1
            fails = 0
        except Exception as e:  # one bad document does not stop the run
            fails += 1
            print("skip %s: %s" % (g, str(e)[:120]), flush=True)
        if i % 50 == 0 or i == len(todo):
            rate = i / (time.time() - t0)
            print("%d/%d ok=%d  ETA %.1f h" % (i, len(todo), ok, (len(todo) - i) / rate / 3600), flush=True)
        if fails >= 20:
            print("STOP: 20 failures in a row (network or USPTO blocking); wait a while and start again", flush=True)
            sys.exit(2)
    print("done: %d new files in %s" % (ok, a.out), flush=True)


if __name__ == "__main__":
    main()
