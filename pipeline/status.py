#!/usr/bin/env python3
"""Legal-status pre-screen -> data/work/status.jsonl.gz  (contract: docs/ARCHITECTURE.md, "status.jsonl.gz").

EP  : public EP Register ST.36 snapshot (BDDS product 16, ~14.8 GB ZIP, 763 chunk ZIPs of ~20-35 MB each) read by
      HTTP Range requests, one chunk at a time, sequentially, 1 s pause between requests.  Only chunks that contain
      EP application numbers of targets.parquet are fetched.  Extracted records (not the raw chunks) are cached in
      data/cache/register/rec/<chunk>.jsonl.gz; data/cache/register/manifest.json remembers which application
      numbers were looked up per chunk, so re-runs fetch only new applications (resumable, incremental).
      EP publications without a register record fall back to the cached Publication Server XML (src "ep-xml").
US  : no key-free status API.  Computed from data/cache/us/*.json.gz: term base = earliest effective non-provisional
      filing date along the continuation/division chain (provisionals excluded), + 20 years + PTA days.  Estimate only.
WO  : "PCT publication (no rights; see national/regional members)".
Seed: family notes / Google-Patents status of data/seed/seed_families.json are attached (src "seed" when nothing else).

Usage:
  python3 pipeline/status.py                       # fetch missing register chunks (no limit) + build
  python3 pipeline/status.py --max-minutes 80      # stop fetching after 80 minutes, then build from what exists
  python3 pipeline/status.py --tiers 0,1           # fetch only chunks holding seed/tier-1 applications
  python3 pipeline/status.py --no-fetch            # build only (offline)
  python3 pipeline/status.py --report              # coverage report of the last build
"""
from __future__ import annotations

import argparse
import bisect
import collections
import datetime
import fcntl
import glob
import gzip
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "lib"))

import config as C  # noqa: E402
import util as U  # noqa: E402
import register_fetch as RF  # noqa: E402
import register_parse as RP  # noqa: E402

REG_DIR = os.path.join(C.CACHE, "register")
REC_DIR = os.path.join(REG_DIR, "rec")
MANIFEST = os.path.join(REG_DIR, "manifest.json")
CHUNK_LOG = os.path.join(C.WORK, "status_register.jsonl")
OUT = os.path.join(C.WORK, "status.jsonl.gz")
SUMMARY = os.path.join(C.WORK, "status_summary.json")
US_META = os.path.join(C.CACHE, "status", "us_meta.json")
TODAY = datetime.date.today().isoformat()


# ============================================================================= dates
def add_years(iso, years):
    """ISO date + N years; 29 Feb -> 28 Feb (last day of the month, EPC R.134)."""
    y, m, d = int(iso[:4]), int(iso[5:7]), int(iso[8:10])
    y += years
    try:
        return datetime.date(y, m, d).isoformat()
    except ValueError:
        return datetime.date(y, m, 28).isoformat()


def iso8(s):
    s = (s or "").strip()
    if re.fullmatch(r"\d{8}", s):
        return "%s-%s-%s" % (s[:4], s[4:6], s[6:8])
    return s[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", s) else None


def add_days(iso, days):
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=days)).isoformat()


# ============================================================================= EP register: fetching
def read_gz_jsonl(path):
    out = []
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except (OSError, EOFError):
        pass
    return out


def load_manifest():
    try:
        with open(MANIFEST) as f:
            return json.load(f)
    except Exception:
        return {"deliveryId": None, "chunks": {}}


def save_manifest(m):
    U.atomic_write(MANIFEST, json.dumps(m), "w")


def ep_targets():
    """-> {app(int): {"tier": min tier (seed=0), "prio": max priority}} for EP rows with an app_number."""
    import pandas as pd
    d = pd.read_parquet(C.TARGETS, columns=["pn", "auth", "app_number", "tier", "priority", "seed_family"])
    d = d[(d.auth == "EP") & d.app_number.notna()]
    out = {}
    for app, tier, pr, sf in zip(d.app_number, d.tier, d.priority, d.seed_family):
        if not str(app).isdigit():
            continue
        a = int(app)
        t = 0 if isinstance(sf, str) and sf else int(tier)
        o = out.setdefault(a, {"tier": t, "prio": float(pr or 0)})
        o["tier"] = min(o["tier"], t)
        o["prio"] = max(o["prio"], float(pr or 0))
    return out


def plan_chunks(idx, targets, manifest, tiers=None):
    """-> list of (chunk, [apps still to look up]) ordered by importance (best tier, then priority)."""
    los = [c["lo"] for c in idx["chunks"]]
    per = collections.defaultdict(list)
    outside = 0
    for a, info in targets.items():
        i = bisect.bisect_right(los, a) - 1
        if i < 0 or a > idx["chunks"][i]["hi"]:
            outside += 1
            continue
        per[i].append(a)
    todo = []
    for i, apps in per.items():
        ch = idx["chunks"][i]
        looked = set(manifest["chunks"].get(ch["name"], {}).get("looked", []))
        if tiers is not None:
            apps = [a for a in apps if targets[a]["tier"] in tiers]
        new = [a for a in apps if a not in looked]
        if new:
            best = min(targets[a]["tier"] for a in new)
            pr = max(targets[a]["prio"] for a in new)
            todo.append((best, -pr, ch, sorted(new)))
    todo.sort(key=lambda x: (x[0], x[1], x[2]["lo"]))
    return [(t[2], t[3]) for t in todo], outside


def extract_chunk(data, wanted):
    """data: chunk ZIP bytes; wanted: set of 8-digit strings -> (records, n_docs_scanned)."""
    import io
    import zipfile
    recs, scanned = [], 0
    z = zipfile.ZipFile(io.BytesIO(data))
    rx = re.compile(r"<register-document .*?</register-document>", re.S)
    for m in z.infolist():
        if not m.filename.lower().endswith(".xml"):
            continue
        txt = z.read(m).decode("utf-8", "replace")
        for frag in rx.findall(txt):
            scanned += 1
            app = RP.app_number_of(frag)
            if app and app in wanted:
                try:
                    r = RP.parse_register_doc(frag)
                except Exception as e:  # keep going, report
                    U.log("parse error", app, repr(e)[:100])
                    continue
                if r and r.get("app"):
                    recs.append(r)
    return recs, scanned


def fetch_register(args):
    os.makedirs(REC_DIR, exist_ok=True)
    lock = open(os.path.join(REG_DIR, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        U.log("another status.py fetch is running; skipping the fetch stage")
        return
    targets = ep_targets()
    idx = RF.load_index(REG_DIR, refresh=args.refresh_index)
    man = load_manifest()
    if man.get("deliveryId") != idx["deliveryId"]:
        if man.get("deliveryId") is not None:
            U.log("new snapshot delivery %s (was %s): discarding old register cache" % (idx["deliveryId"], man["deliveryId"]))
            for f in glob.glob(os.path.join(REC_DIR, "*.jsonl.gz")):
                os.remove(f)
        man = {"deliveryId": idx["deliveryId"], "published": idx.get("published"), "chunks": {}}
    tiers = set(int(x) for x in args.tiers.split(",")) if args.tiers else None
    plan, outside = plan_chunks(idx, targets, man, tiers)
    U.log("register: %d target applications, %d chunks to fetch (%d apps outside any chunk range), delivery %s"
          % (len(targets), len(plan), outside, idx["deliveryId"]))
    t_start = time.time()
    done = nbytes = 0
    for ch, apps in plan:
        if args.max_chunks and done >= args.max_chunks:
            break
        if args.max_minutes and (time.time() - t_start) > args.max_minutes * 60:
            U.log("time budget reached")
            break
        t0 = time.time()
        try:
            data, st = RF.fetch_chunk(idx, ch, pause=args.pause)
            wanted = set("%08d" % a for a in apps)
            recs, scanned = extract_chunk(data, wanted)
        except Exception as e:
            U.log("chunk %s failed: %r (will be retried on the next run)" % (ch["name"], e))
            time.sleep(10)
            continue
        del data
        path = os.path.join(REC_DIR, ch["name"].replace(".zip", ".jsonl.gz"))
        old = {}
        if os.path.exists(path):
            for r in read_gz_jsonl(path):
                old[r["app"]] = r
        for r in recs:
            old[r["app"]] = r
        buf = ("\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in old.values()) + "\n").encode()
        U.atomic_write(path, gzip.compress(buf, 6))
        ent = man["chunks"].setdefault(ch["name"], {"looked": []})
        ent["looked"] = sorted(set(ent["looked"]) | set(apps))
        ent["found"] = len(old)
        save_manifest(man)
        done += 1
        nbytes += st["bytes"]
        U.append_jsonl(CHUNK_LOG, {"chunk": ch["name"], "secs": round(time.time() - t0, 1), "bytes": st["bytes"],
                                   "requests": st["requests"], "wanted": len(apps), "found": len(recs), "scanned": scanned,
                                   "ts": U.now_iso()})
        U.log("%s: %d/%d apps found (%d docs scanned) %.1fs %.1f MB  [%d/%d chunks, %.1f GB]" % (
            ch["name"], len(recs), len(apps), scanned, time.time() - t0, st["bytes"] / 1e6, done, len(plan), nbytes / 1e9))


def load_register_records():
    recs = {}
    for f in sorted(glob.glob(os.path.join(REC_DIR, "*.jsonl.gz"))):
        for r in read_gz_jsonl(f):
            recs[r["app"]] = r
    return recs


# ============================================================================= EP register: record -> status object
GRANTED_WORDS = ("granted", "no opposition filed", "maintained", "opposition rejected", "opposition procedure",
                 "time limit for opposition", "opposition filed", "patent has been limited", "appeal", "limitation")
PENDING_WORDS = ("examination", "grant of patent is intended", "published", "publication has been made", "search report",
                 "request for", "application is", "proceedings", "amendments", "intention to grant")


def ep_code(rec, expiry, asof):
    t = (rec.get("status_text") or "").lower()
    code = "unknown"
    if "revoked" in t or "revocation" in t:
        code = "revoked"
    elif "refused" in t:
        code = "refused"
    elif "withdrawn" in t:
        code = "withdrawn"
    elif "ceased" in t or "lapse" in t or "surrender" in t:
        code = "lapsed"
    elif any(w in t for w in GRANTED_WORDS):
        code = "granted"
    elif any(w in t for w in PENDING_WORDS):
        code = "pending"
    elif rec.get("grant"):
        code = "granted"
    base = code
    if code == "granted":
        des = set(rec.get("designated") or [])
        lap = set(x["cc"] for x in rec.get("lapsed") or [])
        if des and des <= lap:
            code = "lapsed"
        elif expiry and expiry < asof:
            code = "expired"
    return code, base


def unitary_state(rec):
    raw = rec.get("unitary_raw") or []
    if not raw:
        return None
    sts = [r for r in raw if r.get("tag") == "unitary-patent-status"]
    if sts:
        latest = max(sts, key=lambda r: (r.get("attrs") or {}).get("change-date") or "")
        t = (latest.get("text") or "").lower()
        if "registered" in t:
            return "registered"
        if "request" in t:
            return "requested"
        return None
    txt = " ".join(r.get("text", "") for r in raw).lower()
    if "unitary effect registered" in txt:
        return "registered"
    if "request" in txt:
        return "requested"
    return None


def opposition_of(rec, code):
    o = rec.get("opposition")
    if not o:
        return None
    if not o.get("filed"):
        return {"filed": False, "opponents": [], "outcome": None}
    t = (rec.get("status_text") or "").lower()
    steps = set(rec.get("opp_steps") or [])
    opps = o.get("opponents") or []
    out = None
    if rec.get("revocation_date") or "revoked" in t or "REVO" in steps:
        out = "revoked"
    elif rec.get("maintained_date") or "maintained as amended" in t or "PMAP" in steps:
        out = "maintained_amended"
    elif rec.get("rejected_date") or "opposition rejected" in t:
        out = "rejected"
    elif "IDOP" in steps:
        out = "maintained_amended"
    elif opps and all((x.get("status") or "").upper() == "WITHDRAWN" for x in opps):
        out = None
    else:
        out = "pending"
    d = {"filed": True, "opponents": [x["name"] for x in opps][:30], "outcome": out,
         "date_first_filed": min([x["filed"] for x in opps if x.get("filed")] or [None]) if opps else None}
    if opps and all((x.get("status") or "").upper() == "WITHDRAWN" for x in opps):
        d["note"] = "all opponents withdrawn"
    elif out in ("revoked", "maintained_amended") and any(a.get("result") is None for a in rec.get("appeals") or []):
        d["note"] = "decision of the opposition division; appeal pending (suspensive effect), see appeal_detail"
    return d


def ep_status_from_register(rec):
    asof = rec.get("produced") or TODAY
    filing = rec.get("filing")
    expiry = add_years(filing, 20) if filing else None
    code, base = ep_code(rec, expiry, asof)
    lapsed = rec.get("lapsed") or []
    lap_cc = set(x["cc"] for x in lapsed)
    unitary = unitary_state(rec)
    des = rec.get("designated") or []
    grantedish = base == "granted"
    if code in ("revoked", "refused", "withdrawn", "unknown") or not grantedish:
        in_de = False if code != "unknown" else None
    else:
        in_de = bool((unitary == "registered" or ("DE" in des or not des) and "DE" not in lap_cc)
                     and not (expiry and expiry < asof) and code != "lapsed")
    fees = rec.get("fees") or []
    appeals = rec.get("appeals") or []
    s = {"src": "ep-register", "asof": asof, "code": code, "text": rec.get("status_text") or None,
         "expiry_est": expiry, "pta_days": None, "lapsed_in": lapsed, "in_force_de": in_de,
         "opposition": opposition_of(rec, code), "appeal": bool(appeals),
         "unitary": unitary,
         "fees_paid_years": [y for y, _ in fees], "last_fee_date": max([d for _, d in fees if d] or [None]) if fees else None,
         "events": [{"date": e["date"], "text": e["text"]} for e in (rec.get("events") or [])[:12]],
         "note": None,
         # extras (not in the contract, all optional for readers)
         "filing": filing, "grant": rec.get("grant"), "app": rec.get("app"), "wo": rec.get("wo"),
         "applicant": rec.get("applicant"), "status_code_num": rec.get("status_code_num"),
         "children": rec.get("children") or [], "designated_n": len(des),
         "appeal_detail": [{"num": a["num"], "result": a["result"], "result_date": a["result_date"]} for a in appeals][:6] or None,
         "estimate": "expiry_est = filing date + 20 years (EPC Art. 63). Register snapshot only: later events are not seen, and after grant renewal fees go to the national offices, whose lapses reach the Register only when notified, so in_force_de can be true for a patent that has lapsed in DE for unpaid fees"}
    return s


# ============================================================================= EP fallback from cached publication-server XML
def ep_status_from_xml(path, kind):
    import epo_pubserver as EP
    with open(path, encoding="utf-8", errors="replace") as f:
        d = EP.parse_document(f.read())
    filing = iso8(d.get("app_date"))
    expiry = add_years(filing, 20) if filing else None
    granted = kind.startswith("B")
    lap = [{"cc": x.get("country"), "date": x.get("date")} for x in d.get("lapses") or []]
    asof = iso8(d.get("pub_date")) or TODAY
    des = set(d.get("designated_states") or [])
    code = "granted" if granted else "pending"
    if granted and expiry and expiry < TODAY:
        code = "expired"
    lcc = set(x["cc"] for x in lap)
    in_de = None
    if granted:
        in_de = bool(code == "granted" and ("DE" in des or not des) and "DE" not in lcc)
    return {"src": "ep-xml", "asof": asof, "code": code,
            "text": "granted (publication %s); no register record in the snapshot" % kind if granted else "published application (%s); no register record in the snapshot" % kind,
            "expiry_est": expiry, "pta_days": None, "lapsed_in": lap, "in_force_de": in_de, "opposition": None, "appeal": None,
            "unitary": None, "fees_paid_years": [], "last_fee_date": None, "events": [], "note": None,
            "filing": filing, "grant": iso8(d.get("grant_date")),
            "estimate": "from the publication-server document only (no legal-status data); expiry_est = filing + 20 years"}


# ============================================================================= US: computed
def _norm_app(s):
    return re.sub(r"\D", "", s or "")


_TOK = re.compile(r"\b(US|WO|EP)\s+(?:[a-z\-]+\s+)?(PCT/[A-Z]{2}\d{2,4}/\d+|\d{6,8})(?:\s+(\d{8})\b)?")


def _d8(s):
    return "%s-%s-%s" % (s[:4], s[4:6], s[6:8]) if s else None


def parse_edges(raw):
    """continuityData (list of strings) -> [{child, parents:[{app, date, pct}], rel}] ; provisionals skipped."""
    edges = []
    for blk in raw or []:
        for part in re.split(r"<\s*br\s*/?\s*>", blk or ""):
            part = part.strip()
            if not part or part.startswith("us-provisional"):
                continue
            if part.startswith("parent "):                       # new style, one relation per block with \n lines
                lines = [l.strip() for l in part.split("\n") if l.strip()]
                par_line = lines[0]
                m_rel = re.match(r"parent (?:US|WO|EP) ([a-z\-]+)", par_line)
                rel = m_rel.group(1) if m_rel else None
                child = None
                for l in lines:
                    mc = re.match(r"child (?:US|WO|EP) (\S+)", l)
                    if mc:
                        child = mc.group(1)
                parents = []
                for cc, num, dt in _TOK.findall(par_line):
                    parents.append({"app": num, "date": _d8(dt), "pct": num.startswith("PCT")})
                edges.append({"child": child, "parents": parents, "rel": rel})
            elif "parent-doc" in part:                            # old style, single line
                rel = part.split(" ", 1)[0]
                body, _, ch = part.partition("child-doc")
                mc = re.search(r"(?:US|WO|EP)\s+(\S+)", ch)
                child = mc.group(1) if mc else None
                body = body.split("parent-doc", 1)[1]
                toks = _TOK.findall(body)
                parents = []
                for i, (cc, num, dt) in enumerate(toks):
                    pct = num.startswith("PCT")
                    if i > 0 and not pct:
                        continue                                  # second US number = patent number + grant date
                    parents.append({"app": num, "date": _d8(dt), "pct": pct})
                edges.append({"child": child, "parents": parents, "rel": rel})
    return edges


def us_meta_of(path):
    d = None
    with gzip.open(path, "rb") as f:
        d = json.loads(f.read())

    def first(k):
        v = d.get(k)
        return (v[0] if isinstance(v, list) and v else v) or None
    kind = first("kindCode") or ""
    num = d.get("publicationReferenceDocumentNumber") or ""
    pn = "US%s%s" % (num, kind)
    app = d.get("applicationNumber")
    app = app[0] if isinstance(app, list) and app else app
    filing = (first("applicationFilingDate") or "")[:10] or None
    pub = (first("datePublished") or "")[:10] or None
    pta = None
    toe = d.get("termOfExtension")
    if toe not in (None, ""):
        mm = re.search(r"\d+", str(toe))
        pta = int(mm.group()) if mm else None
    raw = d.get("continuityData")
    raw = raw if isinstance(raw, list) else ([raw] if raw else [])
    edges = parse_edges(raw)
    prov = []
    for blk in raw:
        for part in re.split(r"<\s*br\s*/?\s*>", blk or ""):
            m = re.match(r"\s*us-provisional-application\s+\w+\s+(\S+)\s+(\d{8})", part)
            if m:
                prov.append({"app": m.group(1), "date": _d8(m.group(2))})
    td = bool(re.search(r"terminal\s+disclaimer", (d.get("claimsHtml") or "") + str(d.get("tags") or ""), re.I))
    return {"pn": pn, "kind": kind, "app": _norm_app(app), "app_raw": app, "filing": filing, "pub": pub, "pta": pta,
            "edges": edges, "prov": prov, "td_seen": td, "title": None}


def load_us_meta(paths):
    os.makedirs(os.path.dirname(US_META), exist_ok=True)
    try:
        with open(US_META) as f:
            cache = json.load(f)
    except Exception:
        cache = {}
    out, new, bad = {}, 0, 0
    for p in paths:
        try:
            st = os.stat(p)
        except OSError:
            continue
        key = os.path.basename(p)
        e = cache.get(key)
        if e and e[0] == st.st_mtime_ns and e[1] == st.st_size:
            out[key] = e[2]
            continue
        try:
            m = us_meta_of(p)
        except Exception:
            bad += 1
            continue
        cache[key] = [st.st_mtime_ns, st.st_size, m]
        out[key] = m
        new += 1
    if new:
        U.atomic_write(US_META, json.dumps(cache), "w")
    return out, new, bad


def us_status(m, app2filing, app2grant):
    kind = m["kind"]
    filing = m["filing"]
    granted = kind.startswith("B") or kind.startswith("E") or kind.startswith("C")
    # --- term base: earliest effective non-provisional filing date along the ancestor chain
    edges = m["edges"]
    by_child = collections.defaultdict(list)
    for e in edges:
        if e["child"]:
            by_child[_norm_app(e["child"]) if not e["child"].startswith("PCT") else e["child"]].append(e)
    dates, unresolved, chain = [], [], []
    seen = set()
    stack = [m["app"]]
    while stack:
        a = stack.pop()
        if a in seen:
            continue
        seen.add(a)
        for e in by_child.get(a, []):
            for p in e["parents"]:
                key = p["app"] if p["pct"] else _norm_app(p["app"])
                dt = p["date"] or app2filing.get(key)
                chain.append({"app": p["app"], "date": dt, "rel": e["rel"]})
                if dt:
                    dates.append(dt)
                else:
                    unresolved.append(p["app"])
                stack.append(key)
    base = filing
    dates = [x for x in dates if filing and x < filing] if filing else dates
    if dates:
        base = min(dates + ([filing] if filing else []))
    est = None
    pta = m["pta"] if granted else None
    if base:
        est = add_years(base, 20)
        if granted and pta:
            est = add_days(est, pta)
        if granted and base < "1995-06-08" and m["pub"]:     # old regime: greater of 20 y from filing / 17 y from grant
            alt = add_years(m["pub"], 17)
            est = max(est, alt)
    asof = TODAY
    note_bits = ["maintenance fees, terminal disclaimers, post-grant PTA corrections, re-exam/IPR/PTAB outcomes and assignments are not checked"]
    if unresolved:
        note_bits.append("filing date of parent application(s) %s not in data: term may end earlier" % ", ".join(sorted(set(unresolved))[:4]))
    # --- status
    granted_as = app2grant.get(m["app"]) if not granted else None
    if granted:
        code = "granted"
        text = "granted (maintenance fees not checked)"
        if est and est < asof:
            code = "expired"
            text = "granted; estimated 20-year term has ended (maintenance fees not checked)"
    elif granted_as:
        code = "granted"
        text = "published application, granted as %s (see that record; maintenance fees not checked)" % granted_as
        if est and est < asof:
            code, text = "expired", "published application, granted as %s; estimated term has ended" % granted_as
    else:
        code = "pending"
        text = "pending/published (publication only; grant status not checked)"
    return {"src": "us-calc", "asof": asof, "code": code, "text": text, "expiry_est": est if (granted or granted_as) else (est or None),
            "pta_days": pta, "lapsed_in": [], "in_force_de": None, "opposition": None, "appeal": None, "unitary": None,
            "fees_paid_years": [], "last_fee_date": None, "events": [], "note": None,
            "filing": filing, "term_base": base, "term_base_from_chain": bool(dates),
            "terminal_disclaimer": True if m["td_seen"] else None,
            "chain": chain[:8] or None,
            "not_checked": "; ".join(note_bits),
            "estimate": "expiry_est = earliest non-provisional effective filing date + 20 years + PTA days; an estimate, not a legal determination"}


# ============================================================================= seed
SEED_CODE = {"Active": "granted", "Pending": "pending", "Expired - Lifetime": "expired", "Expired - Fee Related": "lapsed",
             "Revoked": "revoked", "Not-in-force": "lapsed", "Abandoned": "withdrawn"}


def load_seed():
    try:
        with open(C.SEED_FAMILIES, encoding="utf-8") as f:
            fams = json.load(f)
    except OSError:
        return {}
    out = {}
    for fam in fams:
        for m in fam.get("members", []):
            mm = re.search(r"(\d{4}-\d{2}-\d{2})", m.get("gp_expiry_event") or "")
            out[m["pn"]] = {"family": fam["family_id"], "note": fam.get("litigation_opposition_note"),
                            "gp_status": m.get("gp_status"), "gp_expiry": mm.group(1) if mm else None,
                            "gp_expiry_event": m.get("gp_expiry_event"), "gp_litigation": m.get("gp_litigation_events") or [],
                            "gp_legal_events": (m.get("gp_key_legal_events") or [])[:6],
                            "fetched": (fam.get("verification") or {}).get("fetch_date")}
    return out


# ============================================================================= build
def build(args):
    import pandas as pd
    t0 = time.time()
    tg = pd.read_parquet(C.TARGETS, columns=["pn", "auth", "kind", "app_number", "fetch_id"])
    seed = load_seed()
    regs = load_register_records()
    U.log("register records: %d applications" % len(regs))
    # US cache
    us_files = sorted(glob.glob(os.path.join(C.CACHE_US, "*.json.gz")) + glob.glob(os.path.join(C.CACHE_US, "*.json")))
    us_files = [p for p in us_files if p.endswith(".json.gz")]
    meta, new, bad = load_us_meta(us_files)
    U.log("US cache: %d docs (%d newly read, %d unreadable)" % (len(meta), new, bad))
    app2filing, app2grant = {}, {}
    for m in meta.values():
        if m["app"] and m["filing"]:
            app2filing[m["app"]] = m["filing"]
        if m["app"] and m["kind"].startswith("B"):
            app2grant[m["app"]] = m["pn"]
    for pn, kind, app in zip(tg.pn, tg.kind, tg.app_number):       # granted siblings known from targets only
        if isinstance(pn, str) and pn.startswith("US") and str(kind).startswith("B") and isinstance(app, str):
            app2grant.setdefault(_norm_app(app), pn)
    us_by_pn = {m["pn"]: m for m in meta.values()}

    out_rows, counts = [], collections.Counter()
    mism = []
    seen_pn = set()
    ep_xml_failed = 0

    def finish(pn, s):
        s = dict(s)
        sd = seed.get(pn)
        if sd:
            s["note"] = sd["note"]
            s["seed"] = {k: sd[k] for k in ("family", "gp_status", "gp_expiry_event", "gp_litigation", "gp_legal_events", "fetched")}
        s["pn"] = pn
        return s

    for pn, auth, kind, app, fid in zip(tg.pn, tg.auth, tg.kind, tg.app_number, tg.fetch_id):
        seen_pn.add(pn)
        s = None
        if auth == "EP":
            r = regs.get(app) if isinstance(app, str) else None
            if r:
                s = ep_status_from_register(r)
            elif isinstance(fid, str):
                p = os.path.join(C.CACHE_EP, fid + ".xml")
                if os.path.exists(p):
                    try:
                        s = ep_status_from_xml(p, kind)
                    except Exception:
                        ep_xml_failed += 1
        elif auth == "US":
            m = us_by_pn.get(pn)
            if m:
                s = us_status(m, app2filing, app2grant)
        elif auth == "WO":
            s = {"src": "seed" if pn in seed else "ep-xml", "asof": TODAY, "code": "unknown",
                 "text": "PCT publication (no rights; see national/regional members)", "expiry_est": None, "pta_days": None,
                 "lapsed_in": [], "in_force_de": False, "opposition": None, "appeal": None, "unitary": None,
                 "fees_paid_years": [], "last_fee_date": None, "events": [], "note": None, "pct_publication": True}
            s["src"] = "pct"
        sd = seed.get(pn)
        if sd and sd["gp_status"]:
            gp = SEED_CODE.get(sd["gp_status"])
            if s is None:                                    # nothing computed: seed is the only information
                s = {"src": "seed", "asof": sd["fetched"] or TODAY, "code": gp or "unknown",
                     "text": "Google Patents page status: %s" % sd["gp_status"], "expiry_est": sd["gp_expiry"], "pta_days": None,
                     "lapsed_in": [], "in_force_de": None, "opposition": None, "appeal": None, "unitary": None,
                     "fees_paid_years": [], "last_fee_date": None, "events": [], "note": None,
                     "estimate": "copied from the Google Patents page fetched for the seed file; not independently checked"}
            else:
                if s["src"] == "us-calc" and gp in ("lapsed", "expired", "revoked", "withdrawn") and s["code"] in ("granted", "pending"):
                    s["text"] = "%s; Google Patents page (%s) shows '%s'" % (s["text"], sd["fetched"], sd["gp_status"])
                    s["code"] = gp
                    s["src"] = "seed"
                if s["src"] == "ep-register" and gp in ("lapsed", "expired", "revoked", "withdrawn") and s["code"] == "granted":
                    s["in_force_de"] = None
                    s["text"] = "%s; Google Patents page (%s) shows '%s' (a national lapse the register does not show): DE status unknown" % (
                        s["text"], sd["fetched"], sd["gp_status"])
                ended = ("expired", "lapsed")
                if s["src"] in ("us-calc", "ep-register") and gp and gp != s["code"] and not (
                        gp in ended and s["code"] in ended):
                    mism.append({"pn": pn, "computed": s["code"], "seed_gp_status": sd["gp_status"], "src": s["src"],
                                 "computed_expiry": s.get("expiry_est"), "seed_expiry": sd["gp_expiry"]})
        if s is not None:
            counts[(auth, s["src"], s["code"])] += 1
            out_rows.append(finish(pn, s))
    # cached US documents that are not in targets
    extra_us = 0
    for pn, m in us_by_pn.items():
        if pn not in seen_pn:
            out_rows.append(finish(pn, us_status(m, app2filing, app2grant)))
            extra_us += 1
    tmp = OUT + ".part"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        for s in out_rows:
            f.write(json.dumps(s, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, OUT)
    summ = summarize(out_rows, tg, regs)
    summ.update({"build_seconds": round(time.time() - t0, 1), "extra_us_not_in_targets": extra_us,
                 "ep_xml_failed": ep_xml_failed, "seed_status_mismatches": mism[:60], "n_seed_status_mismatches": len(mism)})
    U.atomic_write(SUMMARY, json.dumps(summ, indent=1, ensure_ascii=False), "w")
    U.log("wrote %s: %d records (%.1f MB) in %.0fs" % (OUT, len(out_rows), os.path.getsize(OUT) / 1e6, time.time() - t0))
    print(json.dumps({k: summ[k] for k in ("records", "by_auth_src", "ep_register_codes", "ep_in_force_de", "ep_apps_total", "ep_apps_with_register")}, indent=1))


def summarize(rows, tg, regs):
    by = collections.Counter()
    codes = collections.Counter()
    de = collections.Counter()
    nums = collections.Counter()
    opp = collections.Counter()
    seen_apps = set()
    for s in rows:
        pn = s["pn"]
        by["%s/%s" % (pn[:2], s["src"])] += 1
        if s["src"] == "ep-register":
            codes[s["code"]] += 1
            de[str(s["in_force_de"])] += 1
            nums["%s|%s" % (s.get("status_code_num"), s["text"])] += 1
            seen_apps.add(s.get("app"))
            if s.get("opposition") and s["opposition"].get("filed"):
                opp[s["opposition"]["outcome"]] += 1
    ep = tg[tg.auth == "EP"]
    return {"records": len(rows), "by_auth_src": dict(by), "ep_register_codes": dict(codes), "ep_in_force_de": dict(de),
            "ep_status_texts": dict(nums.most_common(40)), "ep_opposition_outcomes_among_opposed": {str(k): v for k, v in opp.items()},
            "ep_apps_total": int(ep.app_number.nunique()), "ep_apps_with_register": len(seen_apps),
            "ep_pns_total": int(len(ep)), "snapshot_asof": max([r.get("produced") or "" for r in regs.values()] or [""]),
            "generated": U.now_iso()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-fetch", action="store_true", help="do not contact BDDS; build from cached records")
    ap.add_argument("--max-chunks", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--tiers", default="", help="comma list, e.g. 0,1 (0 = seed families)")
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--refresh-index", action="store_true")
    ap.add_argument("--fetch-only", action="store_true")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()
    C.ensure_dirs()
    os.makedirs(REG_DIR, exist_ok=True)
    if args.report:
        print(open(SUMMARY).read())
        return
    if not args.no_fetch:
        fetch_register(args)
    if not args.fetch_only:
        build(args)


if __name__ == "__main__":
    main()
