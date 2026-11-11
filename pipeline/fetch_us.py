#!/usr/bin/env python3
"""Download ppubs full-text JSON for US targets into data/cache/us/<guid>.json.gz (atomic, resumable).

Input: data/work/targets.parquet (auth US, fetch=true; fetch_id=guid, fetch_source) when present,
       else, or with --from-discovery, data/work/us_discovery.parquet (all grants + pre-grants from 2018 on
       whose application has no grant; order: seed, core-CPC hits, newest first).
Log: data/work/fetch_us.jsonl {id, ok, bytes, ts, err}.   ~1 request/s, stops after 20 consecutive failures.
Usage: python3 pipeline/fetch_us.py [--from-discovery] [--limit N] [--max-hours H] [--pause 1.0]
"""
import argparse, gzip, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
try:
    from config import DATA, CACHE_US, WORK  # type: ignore
except Exception:
    DATA = os.environ.get("LNP_DATA", "/home/user/ip/data")
    CACHE_US = os.path.join(DATA, "cache", "us")
    WORK = os.path.join(DATA, "work")
import ppubs
import pyarrow.parquet as pq

# bulky and useless: none observed in the live payload (page-image location lists are null); kept generic.
DROP = ("dwImageDoctypeList", "dwImageLocList", "dwPageCountList", "dwImageDocidList")


def seed_pns():
    s = json.load(open(os.path.join(DATA, "seed", "seed_families.json")))
    out = set()
    for f in s:
        for m in f.get("members", []):
            out.add(m["pn"])
        out.update(f.get("representative_us", []))
    return out


def app_key(a):
    return re.sub(r"\D", "", a or "")


def from_discovery():
    t = pq.read_table(os.path.join(WORK, "us_discovery.parquet")).to_pylist()
    seeds = seed_pns()
    granted = {app_key(r["app_number"]) for r in t if r["source"] == "USPAT" and r["app_number"]}
    sel = []
    for r in t:
        if r["source"] == "USPAT":
            pass
        else:
            if (r["pub_date"] or "") < "2018-01-01" or app_key(r["app_number"]) in granted:
                continue
        is_seed = r["pn"] in seeds or "seed" in (r["query_tags"] or [])
        is_core = any(x.startswith("core:") for x in (r["query_tags"] or []))
        r["_rank"] = (0 if is_seed else 1 if is_core else 2)
        sel.append(r)
    # newest first inside each band: sort by date desc then rank (stable)
    sel.sort(key=lambda r: r["pub_date"] or "", reverse=True)
    sel.sort(key=lambda r: r["_rank"])
    return [(r["guid"], r["source"]) for r in sel]


def from_targets():
    t = pq.read_table(os.path.join(WORK, "targets.parquet")).to_pylist()
    rows = [r for r in t if r.get("auth") == "US" and r.get("fetch") and r.get("fetch_id")]
    rows.sort(key=lambda r: -(r.get("priority") or 0))
    return [(r["fetch_id"], r["fetch_source"]) for r in rows]


def have(guid):
    return os.path.exists(os.path.join(CACHE_US, guid + ".json.gz")) or os.path.exists(os.path.join(CACHE_US, guid + ".json"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-discovery", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="max NEW downloads this run")
    ap.add_argument("--max-hours", type=float, default=0)
    ap.add_argument("--pause", type=float, default=1.0)
    a = ap.parse_args()
    os.makedirs(CACHE_US, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    tp = os.path.join(WORK, "targets.parquet")
    if a.from_discovery or not os.path.exists(tp):
        queue = from_discovery()
        mode = "discovery"
    else:
        queue = from_targets()
        mode = "targets"
    todo = [(g, s) for g, s in queue if not have(g)]
    print("mode=%s queue=%d already_cached=%d todo=%d" % (mode, len(queue), len(queue) - len(todo), len(todo)), flush=True)
    if a.limit:
        todo = todo[:a.limit]
    cl = ppubs.Client(pause=a.pause)
    log = open(os.path.join(WORK, "fetch_us.jsonl"), "a")
    t0 = time.time()
    deadline = t0 + a.max_hours * 3600 if a.max_hours else None
    fails = n_ok = n_bytes = n_gz = 0
    for i, (g, src) in enumerate(todo, 1):
        if deadline and time.time() > deadline:
            print("max-hours reached", flush=True)
            break
        rec = {"id": g, "ok": False, "bytes": 0, "ts": int(time.time()), "err": None}
        try:
            raw = cl.fulltext_raw(g, src)
            d = json.loads(raw)
            if not isinstance(d, dict) or not (d.get("claimsHtml") or d.get("descriptionHtml") or d.get("abstractHtml")):
                raise ValueError("empty document")
            for k in DROP:
                d.pop(k, None)
            body = gzip.compress(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf8"), 6)
            path = os.path.join(CACHE_US, g + ".json.gz")
            tmp = path + ".tmp%d" % os.getpid()
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, path)
            rec.update(ok=True, bytes=len(raw))
            n_ok += 1
            n_bytes += len(raw)
            n_gz += len(body)
            fails = 0
        except ppubs.PpubsError as e:
            rec["err"] = str(e)[:200]
            if e.status in (404, 400) and e.status != 599:
                rec["err"] = "notfound " + rec["err"]  # a missing document is not a systemic failure
            else:
                fails += 1
        except Exception as e:
            rec["err"] = "%s: %s" % (type(e).__name__, str(e)[:200])
            fails += 1
        log.write(json.dumps(rec) + "\n")
        log.flush()
        if i % 100 == 0 or i == len(todo):
            el = time.time() - t0
            rate = i / el
            print("%d/%d ok=%d rate=%.2f/s ETA=%.1fh avg_raw=%dKB avg_gz=%dKB" % (
                i, len(todo), n_ok, rate, (len(todo) - i) / rate / 3600, n_bytes / max(n_ok, 1) / 1024,
                n_gz / max(n_ok, 1) / 1024), flush=True)
        if fails >= 20:
            print("STOP: 20 consecutive failures", flush=True)
            sys.exit(2)
    print("done: ok=%d  raw=%.1fMB gz=%.1fMB elapsed=%.0fs" % (n_ok, n_bytes / 1e6, n_gz / 1e6, time.time() - t0))


if __name__ == "__main__":
    main()
