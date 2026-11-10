#!/usr/bin/env python3
"""Stage 2: normalise all publications into data/work/corpus.jsonl.gz  (record format: docs/ARCHITECTURE.md).

Inputs : data/work/targets.parquet, data/cache/ep/*.xml, data/cache/us/*.json.gz, data/seed/*.json,
         data/probe/surechembl/out/patents_subset.parquet (biblio gap filling),
         data/work/status.jsonl.gz (optional, merged into "status" when present)
Output : data/work/corpus.jsonl.gz, data/work/normalize_summary.json
Cache  : data/work/norm/{ep,us}/<file stem>.json.gz  + data/work/norm/index.json (file name, mtime, size,
         parser version). A rerun parses only files that are new or changed.

  python3 pipeline/normalize.py [--limit N] [--workers 2] [--reparse] [--out PATH]

--limit N parses at most N cache files per source and writes to *.limit.* outputs, never over the real corpus.
Safe to run while the fetchers are still writing: only complete files (atomic renames) are read, files
younger than 3 s are left for the next run, and unparsable files are recorded and retried only when they change.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import multiprocessing as mp
import os
import re
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "lib"))

import config as C                       # noqa: E402
import norm_doc as nd                    # noqa: E402
import norm_text as nt                   # noqa: E402

NORM_DIR = os.path.join(C.WORK, "norm")
INDEX_PATH = os.path.join(NORM_DIR, "index.json")
CORPUS = os.path.join(C.WORK, "corpus.jsonl.gz")
SUMMARY = os.path.join(C.WORK, "normalize_summary.json")
STATUS = os.path.join(C.WORK, "status.jsonl.gz")
MIN_AGE_S = 3


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- parse stage
def _stem(fn):
    for ext in (".json.gz", ".json", ".xml"):
        if fn.endswith(ext):
            return fn[: -len(ext)]
    return fn


def _worker(job):
    src, fn, path = job
    t = time.time()
    try:
        doc = nd.parse_ep_file(path) if src == "ep" else nd.parse_us_file(path)
        out = os.path.join(NORM_DIR, src, _stem(fn) + ".json.gz")
        tmp = out + ".tmp%d" % os.getpid()
        with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=3) as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, out)
        meta = {"pn": doc["pn"], "cpc": doc["cpc"][:8], "app": doc["app_number"], "pct_wo": doc["pct_wo"], "err": None}
    except Exception as e:                                  # one broken file must not stop the run
        meta = {"pn": None, "cpc": [], "app": None, "pct_wo": None, "err": "%s: %s" % (type(e).__name__, str(e)[:200])}
    meta["sec"] = round(time.time() - t, 4)
    return src, fn, meta


def scan_cache():
    """[(src, filename, path, mtime_ns, size)] for complete-looking files."""
    out = []
    now = time.time()
    for src, d, exts in (("ep", C.CACHE_EP, (".xml",)), ("us", C.CACHE_US, (".json.gz", ".json"))):
        if not os.path.isdir(d):
            continue
        with os.scandir(d) as it:
            for e in it:
                if not e.is_file() or e.name.startswith(".") or not e.name.endswith(exts):
                    continue
                st = e.stat()
                if now - st.st_mtime < MIN_AGE_S or st.st_size == 0:
                    continue
                out.append((src, e.name, e.path, st.st_mtime_ns, st.st_size))
    out.sort(key=lambda x: (x[0], x[1]))
    return out


def parse_stage(files, args):
    os.makedirs(os.path.join(NORM_DIR, "ep"), exist_ok=True)
    os.makedirs(os.path.join(NORM_DIR, "us"), exist_ok=True)
    index = {}
    if os.path.exists(INDEX_PATH) and not args.reparse:
        try:
            index = json.load(open(INDEX_PATH))
        except Exception:
            index = {}
    if args.limit:
        keep, cnt = [], collections.Counter()
        for f in files:
            if cnt[f[0]] < args.limit:
                cnt[f[0]] += 1
                keep.append(f)
        files = keep
    todo = []
    for src, fn, path, m, s in files:
        key = src + "/" + fn
        e = index.get(key)
        cache_ok = os.path.exists(os.path.join(NORM_DIR, src, _stem(fn) + ".json.gz"))
        if e and e["m"] == m and e["s"] == s and e["v"] == nd.PARSER_VERSION and (cache_ok or e.get("err")):
            continue
        todo.append((src, fn, path, m, s))
    log("cache files: %d, to parse: %d, already normalised: %d" % (len(files), len(todo), len(files) - len(todo)))
    stats = {"parsed": 0, "errors": 0, "parse_sec": 0.0, "wall_sec": 0.0, "bytes": 0}
    errs = []
    if todo:
        t0 = time.time()
        jobs = [(s, f, p) for s, f, p, m, sz in todo]
        info = {s + "/" + f: (m, sz) for s, f, p, m, sz in todo}
        try:
            with mp.Pool(max(1, min(args.workers, 2))) as pool:
                for i, (src, fn, meta) in enumerate(pool.imap_unordered(_worker, jobs, chunksize=4), 1):
                    key = src + "/" + fn
                    m, sz = info[key]
                    index[key] = {"m": m, "s": sz, "v": nd.PARSER_VERSION, **meta}
                    stats["parsed"] += 1
                    stats["parse_sec"] += meta["sec"]
                    stats["bytes"] += sz
                    if meta["err"]:
                        stats["errors"] += 1
                        errs.append({"file": key, "err": meta["err"]})
                    if i % 100 == 0:
                        el = time.time() - t0
                        log("parsed %d/%d  %.1f docs/s" % (i, len(jobs), i / el))
                    if i % 1000 == 0:
                        _save_index(index)
        finally:
            _save_index(index)
        stats["wall_sec"] = time.time() - t0
        log("parsed %d in %.1fs (%.1f docs/s, %d errors)" % (
            stats["parsed"], stats["wall_sec"], stats["parsed"] / max(stats["wall_sec"], 1e-9), stats["errors"]))
    else:
        _save_index(index)
    present = {src + "/" + fn for src, fn, *_ in files}
    return index, present, stats, errs


def _save_index(index):
    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(index, f, separators=(",", ":"))
    os.replace(tmp, INDEX_PATH)


# --------------------------------------------------------------------------- inputs
def norm_cpc(lst):
    out, seen = [], set()
    for c in lst or []:
        c = "".join(str(c).split())
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def load_targets():
    import duckdb
    con = duckdb.connect()
    cur = con.execute('select pn, auth, kind, cast(pub_date as varchar), family_id, app_number, title, assignees, cpc, '
                      'tier, seed_family, seed_tier, "fetch", fetch_id from read_parquet(?)', [C.TARGETS])
    cols = ["pn", "auth", "kind", "pub_date", "family_id", "app_number", "title", "assignees", "cpc", "tier",
            "seed_family", "seed_tier", "fetch", "fetch_id"]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    sub = {}
    if os.path.exists(C.SURECHEMBL_PATENTS):
        cur = con.execute('select country, patent_number, kind, cast(publication_date as varchar), family_id, title, assignee, cpc '
                          'from read_parquet(?)', [C.SURECHEMBL_PATENTS])
        for cc, num, kind, pd, fam, title, asg, cpc in cur.fetchall():
            parts = (num or "").split("-")           # patent_number looks like 'EP-1902714-B1'
            pn = "".join(parts) if len(parts) >= 3 else (cc or "") + (num or "") + (kind or "")
            sub[pn] = {"pub_date": pd, "family_id": fam, "title": title, "assignees": asg or [], "cpc": cpc or []}
    return rows, sub


def load_seed():
    members = {}
    try:
        for fam in json.load(open(C.SEED_FAMILIES)):
            for m in fam.get("members", []):
                members[m["pn"]] = {"family": fam.get("family_id"), "tier": fam.get("tier"),
                                    "priority_date": m.get("priority_date"), "filing_date": m.get("filing_date"),
                                    "title": m.get("title"), "assignees": m.get("assignees") or [],
                                    "fam_priority": fam.get("earliest_priority_date")}
    except Exception as e:
        log("seed_families.json unreadable:", e)
    return members


def load_status():
    st = {}
    if os.path.exists(STATUS):
        try:
            with gzip.open(STATUS, "rt", encoding="utf-8") as f:
                for line in f:
                    o = json.loads(line)
                    st[o["pn"]] = o
        except Exception as e:
            log("status.jsonl.gz unreadable:", e)
    return st


# --------------------------------------------------------------------------- record building
def synth_family(key):
    return -(zlib.crc32(key.encode()) % 1_000_000_000 + 1)


def norm_app(a, auth):
    """EP application numbers are the 8 digits without the check digit ('17800986.6' -> '17800986')."""
    if not a:
        return None
    a = str(a).strip()
    if auth == "EP":
        m = re.fullmatch(r"(\d{8})(?:\.\d)?", a)
        return m.group(1) if m else a
    return a


def kind_is_grant(auth, kind):
    return (auth == "EP" and kind.startswith("B")) or (auth == "US" and kind[:1] in ("B", "E"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="parse at most N cache files per source (smoke run; writes *.limit.* outputs)")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--reparse", action="store_true", help="ignore the parse cache")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    T0 = time.time()

    out_path = args.out or (CORPUS.replace(".jsonl.gz", ".limit.jsonl.gz") if args.limit else CORPUS)
    sum_path = SUMMARY.replace(".json", ".limit.json") if args.limit else SUMMARY

    files = scan_cache()
    index, present, pstats, perrs = parse_stage(files, args)

    # ---- biblio inputs
    log("loading targets ...")
    rows, sub = load_targets()
    seed = load_seed()
    status = load_status()
    variants = json.load(open(C.SEED_ASSIGNEES))
    matcher = nt.PlayerMatcher(variants)
    noise = [x for v in variants if v.get("player", "").startswith("_") for x in v.get("variants_observed_on_fetched_pages", [])]
    by_pn = {r["pn"]: r for r in rows}
    by_fetch = {r["fetch_id"]: r for r in rows if r["fetch_id"]}

    # ---- documents available (index entries whose source file is still present and parsed)
    docs = {}                 # pn -> (key, entry)
    for key, e in index.items():
        if key not in present or e.get("err") or not e.get("pn"):
            continue
        if args.limit and key not in present:
            continue
        old = docs.get(e["pn"])
        if old is None or e["m"] > old[1]["m"]:
            docs[e["pn"]] = (key, e)
    log("documents with parsed full text: %d (EP %d, US %d)" % (
        len(docs), sum(1 for k, _ in docs.values() if k.startswith("ep/")), sum(1 for k, _ in docs.values() if k.startswith("us/"))))

    # ---- publication list = targets + documents not in targets + seed members not in targets
    pubs = []                  # dicts: {pn, row, doc_key, doc_meta, extra}
    used = set()
    for r in rows:
        d = docs.get(r["pn"])
        pubs.append({"pn": r["pn"], "row": r, "doc": d})
        if d:
            used.add(r["pn"])
    extra_docs = 0
    for pn, d in docs.items():
        if pn in used:
            continue
        stem = _stem(d[0].split("/", 1)[1])
        row = by_fetch.get(stem)
        pubs.append({"pn": pn, "row": None, "inherit": row, "doc": d})
        extra_docs += 1
    seed_extra = 0
    for pn, m in seed.items():
        if pn not in by_pn and pn not in docs:
            pubs.append({"pn": pn, "row": None, "inherit": None, "doc": None, "seed_member": m})
            seed_extra += 1
    log("publications: %d (targets %d, extra documents %d, extra seed members %d)" % (len(pubs), len(rows), extra_docs, seed_extra))

    # ---- families (DOCDB id, else linked through the PCT publication, else synthetic per application)
    fam = {}
    wo_rows = collections.defaultdict(list)     # WO number (no kind) -> [pn]
    for p in pubs:
        pn = p["pn"]
        r = p["row"] or p.get("inherit") or {}
        f = r.get("family_id") if p["row"] else None
        if not f:
            f = (sub.get(pn) or {}).get("family_id")
        fam[pn] = int(f) if f else None
        if pn.startswith("WO"):
            wo_rows[pn[:12]].append(pn)
    pct_of = {}
    for p in pubs:
        if p["doc"] and p["doc"][1].get("pct_wo"):
            pct_of[p["pn"]] = p["doc"][1]["pct_wo"]
    # propagate known family ids across PCT links, both directions
    for pn, wnum in pct_of.items():
        for wpn in wo_rows.get(wnum, []):
            if fam[pn] and not fam[wpn]:
                fam[wpn] = fam[pn]
            elif fam[wpn] and not fam[pn]:
                fam[pn] = fam[wpn]
    for p in pubs:
        pn = p["pn"]
        if fam[pn]:
            continue
        if pn in pct_of:
            fam[pn] = synth_family(pct_of[pn])
        elif pn.startswith("WO"):
            fam[pn] = synth_family(pn[:12])
        else:
            r = p["row"] or p.get("inherit") or {}
            app = r.get("app_number") or (p["doc"][1].get("app") if p["doc"] else None) or pn
            fam[pn] = synth_family(pn[:2] + "|" + str(app))
    # WO member per family (earliest A1/A2 preferred)
    fam_wo = {}
    pub_date_of = {p["pn"]: ((p["row"] or {}).get("pub_date") or "9999") for p in pubs}
    for pn in sorted(fam, key=lambda x: (pub_date_of.get(x, "9999"), x)):
        if pn.startswith("WO") and fam[pn] > 0:
            cur = fam_wo.get(fam[pn])
            if cur is None or (cur.endswith("A3") and not pn.endswith("A3")):
                fam_wo[fam[pn]] = pn

    def wo_for(pn):
        if pn.startswith("WO"):
            return None
        w = pct_of.get(pn)
        if w:
            c = wo_rows.get(w)
            if c:
                return sorted(c)[0]
            return w + "A1"                       # PCT publication not in the table; A1 assumed
        return fam_wo.get(fam[pn])

    # ---- sort keys: (main CPC, family, pn)
    def main_cpc(p):
        r = p["row"] or p.get("inherit") or {}
        c = None
        if p["doc"] and p["doc"][1].get("cpc"):
            c = p["doc"][1]["cpc"]
        cp = norm_cpc(r.get("cpc")) or norm_cpc((sub.get(p["pn"]) or {}).get("cpc")) or norm_cpc(c)
        return cp[0] if cp else "~"

    pubs.sort(key=lambda p: (main_cpc(p), fam[p["pn"]], p["pn"]))

    # ---- write corpus
    stats = collections.Counter()
    by_auth = collections.Counter()
    by_kind = collections.Counter()
    by_tier = collections.Counter()
    by_auth_text = collections.Counter()
    claim_chars = 0
    claims_total = 0
    nochem = 0
    seed_state = {}
    players = collections.Counter()
    out_bytes = 0
    tmp_out = out_path + ".tmp"
    log("writing", out_path)
    with gzip.open(tmp_out, "wt", encoding="utf-8", compresslevel=6) as fo:
        for i, p in enumerate(pubs, 1):
            pn = p["pn"]
            r = p["row"] or p.get("inherit") or {}
            sm = p.get("seed_member") or seed.get(pn) or {}
            sb = sub.get(pn) or {}
            doc = None
            if p["doc"]:
                key, e = p["doc"]
                src, fn = key.split("/", 1)
                try:
                    with gzip.open(os.path.join(NORM_DIR, src, _stem(fn) + ".json.gz"), "rt", encoding="utf-8") as f:
                        doc = json.load(f)
                except Exception as ex:
                    stats["cache_read_errors"] += 1
                    log("cache read failed", key, ex)
            auth = pn[:2]
            m_k = re.search(r"([A-Z]\d?)$", pn)
            kind = (doc or {}).get("kind") or (r.get("kind") if r else None) or (m_k.group(1) if m_k else "")
            # biblio
            title = dict((doc or {}).get("title") or {})
            if not title:
                t = (r.get("title") if p["row"] else None) or sb.get("title") or sm.get("title")
                if t:
                    title = {"en": t}
            raw_asg = (doc or {}).get("assignees") or (r.get("assignees") if p["row"] else None) or sb.get("assignees") or sm.get("assignees") or []
            assignees = nt.clean_assignees(raw_asg, noise)
            player = matcher.match(assignees) or matcher.match(raw_asg) or matcher.match((r.get("assignees") if p["row"] else None) or [])
            cpc = norm_cpc((r.get("cpc") if p["row"] else None) or sb.get("cpc"))
            for c in norm_cpc((doc or {}).get("cpc")):
                if c not in cpc:
                    cpc.append(c)
            pub = (doc or {}).get("pub_date") or (r.get("pub_date") if p["row"] else None) or sb.get("pub_date")
            app_date = (doc or {}).get("app_date") or sm.get("filing_date")
            prio = (doc or {}).get("priority_date") or sm.get("priority_date") or sm.get("fam_priority") or app_date
            grant = (doc or {}).get("grant_date") or (pub if kind_is_grant(auth, kind) else None)
            claims = {"en": [], "de": []}
            has_chem = False
            if doc:
                claims["en"] = doc["claims"].get("en", [])
                claims["de"] = doc["claims"].get("de", [])
                for lang in ("en", "de"):
                    for c in claims[lang]:
                        if not c["dep"] and ("[chem]" in c["t"] or "[STR]" in c["t"]):
                            has_chem = True
                        claim_chars += len(c["t"])
                        claims_total += 1
            rec = {
                "pn": pn, "auth": auth, "kind": kind, "family": fam[pn],
                "app_number": r.get("app_number") or norm_app((doc or {}).get("app_number"), auth),
                "app_date": app_date, "pub_date": pub, "grant_date": grant, "priority_date": prio,
                "title": title, "assignees": assignees, "player": player, "cpc": cpc,
                "tier": r["tier"] if r else (0 if sm else 5),
                "seed_family": r.get("seed_family") or sm.get("family"),
                "seed_tier": r.get("seed_tier") if r.get("seed_tier") is not None else sm.get("tier"),
                "text": bool(doc), "text_src": (doc or {}).get("text_src"),
                "claims": claims, "has_chem_img": has_chem,
                "defs": (doc or {}).get("defs") or [],
                "abstract": (doc or {}).get("abstract"),
                "wo": wo_for(pn),
                "status": status.get(pn),
            }
            line = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
            fo.write(line)
            fo.write("\n")
            out_bytes += len(line) + 1
            by_auth[auth] += 1
            by_kind[auth + "/" + kind] += 1
            by_tier[str(rec["tier"])] += 1
            if doc:
                by_auth_text[auth + ("/claims" if (claims["en"] or claims["de"]) else "/no_claims")] += 1
            if player:
                players[player] += 1
            if rec["seed_family"]:
                seed_state[pn] = {"text": bool(doc), "claims": bool(claims["en"] or claims["de"])}
            if i % 20000 == 0:
                log("written %d/%d" % (i, len(pubs)))
    os.replace(tmp_out, out_path)

    # seed numbers by representative list (members of seed families)
    seed_pns = list(seed.keys())
    def _num(x):
        return re.sub(r"[A-Z]\d?$", "", x)
    doc_by_num = collections.defaultdict(list)
    for dpn in docs:
        doc_by_num[_num(dpn)].append(dpn)
    own = [s_ for s_ in seed_pns if s_ in docs]
    later = {s_: doc_by_num[_num(s_)] for s_ in seed_pns if s_ not in docs and doc_by_num.get(_num(s_))}
    seed_check = {
        "expected": len(seed_pns),
        "present": sum(1 for s_ in seed_pns if s_ in by_pn or s_ in docs),
        "with_text": len(own),
        "with_text_via_other_kind_of_same_number": later,      # e.g. seed B1, cached full text is the B9/B2 of the same patent
        "with_text_but_no_claims": [s_ for s_ in own if not seed_state.get(s_, {}).get("claims")],
        "no_text_yet": [s_ for s_ in seed_pns if s_ not in docs and s_ not in later],
    }
    n_text = sum(by_auth_text.values())
    summary = {
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "limit": args.limit or None,
        "records": len(pubs), "by_auth": dict(by_auth), "by_kind": dict(sorted(by_kind.items())),
        "by_tier": dict(sorted(by_tier.items())),
        "full_text": n_text, "full_text_by_auth": dict(by_auth_text),
        "with_claims": sum(v for k, v in by_auth_text.items() if k.endswith("/claims")),
        "without_claims": sum(v for k, v in by_auth_text.items() if k.endswith("/no_claims")),
        "claims_total": claims_total,
        "mean_claim_chars": round(claim_chars / claims_total, 1) if claims_total else None,
        "players": dict(players.most_common()),
        "extra_documents_not_in_targets": extra_docs, "extra_seed_members_not_in_targets": seed_extra,
        "seed": seed_check,
        "bytes": {"corpus_uncompressed": out_bytes, "corpus_gz": os.path.getsize(out_path),
                  "raw_cache_parsed_this_run": pstats["bytes"]},
        "parse": {"parsed_now": pstats["parsed"], "errors_now": pstats["errors"],
                  "wall_sec": round(pstats["wall_sec"], 1),
                  "docs_per_sec": round(pstats["parsed"] / pstats["wall_sec"], 2) if pstats["wall_sec"] else None,
                  "mean_parse_sec_per_doc_cpu": round(pstats["parse_sec"] / pstats["parsed"], 4) if pstats["parsed"] else None},
        "index_errors": [{"file": k, "err": v["err"]} for k, v in index.items() if v.get("err")][:50],
        "total_sec": round(time.time() - T0, 1), "cache_read_errors": stats["cache_read_errors"],
    }
    with open(sum_path, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    log("done in %.1fs; %d records; %d full text (%d with claims); %s" % (
        summary["total_sec"], len(pubs), n_text, summary["with_claims"], sum_path))


if __name__ == "__main__":
    main()
