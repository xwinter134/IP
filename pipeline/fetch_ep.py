#!/usr/bin/env python3
"""Download EP full text (document.xml) from the EPO Publication Server into data/cache/ep/.

Reads data/work/targets.parquet (auth EP, fetch=true), highest priority first, one request per
~1.1 s, sequential.  Resumable: files already in the cache are skipped, permanent misses
(the server's "500 / code 9000 = no such publication") are logged once and never retried.
Appends one line per attempt to data/work/fetch_ep.jsonl: {id, ok, bytes, ts, err}.

Usage: python3 pipeline/fetch_ep.py [--limit N] [--max-hours H] [--retry-missing]
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import config as C  # noqa: E402
import util as U  # noqa: E402

import duckdb  # noqa: E402


def not_found(status, body) -> bool:
    """The Publication Server answers HTTP 500 {"code":9000,...} for a non-existing id (not 404)."""
    return status == 404 or (status in (400, 500) and b'"code":9000' in body.replace(b" ", b""))


def load_targets(path):
    con = duckdb.connect()
    rows = con.execute(
        "select fetch_id, max(priority) p, min(pn) pn, cast(min(pub_date) as varchar) pd from read_parquet(?) "
        "where auth = 'EP' and \"fetch\" and fetch_id is not null group by fetch_id order by p desc, fetch_id",
        [path]).fetchall()
    return [(r[0], r[1], r[2], r[3] or "") for r in rows]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0, help="stop after N download attempts (smoke run)")
    ap.add_argument("--max-hours", type=float, default=0, help="stop after H hours")
    ap.add_argument("--retry-missing", action="store_true", help="retry ids logged as permanent misses")
    ap.add_argument("--targets", default=C.TARGETS)
    a = ap.parse_args()
    C.ensure_dirs()

    targets = load_targets(a.targets)
    missing = {}                                 # id -> date of the last "not_found" answer
    if not a.retry_missing:
        for r in U.read_jsonl(C.FETCH_EP_LOG):
            if r.get("err") == "not_found":
                missing[r["id"]] = (r.get("ts") or "")[:10]
    today = time.strftime("%Y-%m-%d", time.gmtime())
    todo = []
    cached = skipped_missing = future = 0
    for fid, prio, pn, pd in targets:
        path = os.path.join(C.CACHE_EP, fid + ".xml")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            cached += 1
        elif pd > today:
            future += 1                          # announced by the linked data, not on the server yet
        elif missing.get(fid, "") > pd:
            skipped_missing += 1                 # asked after its publication date: permanent miss
        else:
            todo.append((fid, prio, pn))
    if a.limit:
        todo = todo[:a.limit]
    U.log("fetch_ep: %d EP documents wanted, %d cached, %d known permanent misses, %d not yet published, "
          "%d to fetch%s" % (len(targets), cached, skipped_missing, future, len(todo), " (--limit)" if a.limit else ""))
    if not todo:
        return 0

    pacer = U.Pacer(C.MIN_INTERVAL_S)
    prog = U.Progress(len(todo), every=C.PROGRESS_EVERY, label="fetch_ep")
    t0 = time.time()
    ok = miss = fail = consecutive = 0
    nbytes = 0
    quota = "?"
    stop = None
    for fid, prio, pn in todo:
        if a.max_hours and time.time() - t0 > a.max_hours * 3600:
            stop = "--max-hours reached"
            break
        url = "%s/patents/%s/document.xml" % (C.EPO_PUBSERVER_REST, fid)
        rec = {"id": fid, "ok": False, "bytes": 0, "ts": U.now_iso(), "err": None}
        try:
            body, hdr = U.http_request(url, pacer=pacer, permanent=not_found)
            quota = "used %s / remaining %s" % (hdr.get("x-quotaperweek-used", "?"),
                                                hdr.get("x-quotaperweek-remaining", "?"))
            if b"<ep-patent-document" not in body[:3000]:
                rec["err"] = "unexpected_payload"
                rec["bytes"] = len(body)
                fail += 1
                consecutive += 1
            else:
                U.atomic_write(os.path.join(C.CACHE_EP, fid + ".xml"), body)   # raw bytes, cached before parsing
                rec["ok"], rec["bytes"] = True, len(body)
                ok += 1
                nbytes += len(body)
                consecutive = 0
        except U.HttpFailure as e:
            if not_found(e.status, e.body):
                rec["err"] = "not_found"            # permanent miss: logged, not retried, not a failure streak
                miss += 1
                consecutive = 0
            else:
                rec["err"] = "http_%s" % e.status if e.status else "network: %s" % e.body[:150].decode("utf-8", "replace")
                fail += 1
                consecutive += 1
        U.append_jsonl(C.FETCH_EP_LOG, rec)
        prog.tick("ok %d  not_found %d  failed %d  %.1f MB  weekly quota %s" % (ok, miss, fail, nbytes / 1e6, quota))
        if consecutive >= C.MAX_CONSECUTIVE_FAILURES:
            stop = "%d consecutive failures" % consecutive
            break
    el = time.time() - t0
    U.log("fetch_ep done%s: ok %d, not_found %d, failed %d, %.1f MB in %s (%.2f s/document); weekly quota %s" % (
        " (stopped: %s)" % stop if stop else "", ok, miss, fail, nbytes / 1e6, U.fmt_dur(el),
        el / max(1, ok + miss + fail), quota))
    return 2 if stop and stop.endswith("failures") else 0


if __name__ == "__main__":
    sys.exit(main())
