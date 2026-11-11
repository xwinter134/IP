#!/usr/bin/env python3
"""Build data/work/targets.parquet (one row per publication known to the tool) -- see docs/ARCHITECTURE.md.

Inputs
  a) SureChEMBL subset (config.SURECHEMBL_PATENTS)                       source `surechembl`
  b) EPO Linked Open EP Data SPARQL, every core CPC code                 source `epo_sparql`
     EPO Publication Server IPC search, field IPC symbols, B kinds       source `epo_ipc`
  c) data/work/us_discovery.parquet if present (pipeline/discover_us.py) source `ppubs`
  d) seed families (data/seed/seed_families.json)                        source `seed`

Every network response is cached under data/cache/disc/epo/, so a re-run is offline and takes
seconds.  `--refresh` re-downloads the discovery responses; `--limit N` is a smoke run (at most N
requests per network stage, output goes to targets_smoke.parquet).

Usage: python3 pipeline/discover.py [--limit N] [--refresh] [--offline]
"""
from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import config as C  # noqa: E402
import util as U  # noqa: E402

import duckdb  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

PACER = U.Pacer(C.MIN_INTERVAL_S)          # one sequential stream for data.epo.org
STATS = collections.Counter()              # requests made / cache hits per stage
ARGS = None

P = ("PREFIX patent: <http://data.epo.org/linked-data/def/patent/>\n"
     "PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>\n")
EP_AUTH = "<http://data.epo.org/linked-data/id/st3/EP>"


class Budget(Exception):
    """--limit reached / --offline and the response is not cached."""


# ============================================================================= cached network access
def _cached(path: str, stage: str, fetch):
    """Return the parsed JSON at `path`, downloading it with fetch() -> bytes when missing."""
    if os.path.exists(path) and os.path.getsize(path) > 0 and not (ARGS.refresh and stage in ARGS.refresh_stages):
        STATS[stage + "_cached"] += 1
        with open(path, "rb") as f:
            return json.loads(f.read())
    if ARGS.offline:
        raise Budget("offline: %s not cached" % path)
    if ARGS.limit and STATS[stage + "_requests"] >= ARGS.limit:
        raise Budget("limit reached for stage %s" % stage)
    STATS[stage + "_requests"] += 1
    raw = fetch()
    obj = json.loads(raw)                   # validate before caching
    U.atomic_write(path, raw)
    return obj


def sparql(query: str, name: str, stage: str = "sparql"):
    path = os.path.join(C.CACHE_DISC_EPO, "sparql", name + ".json")
    url = C.EPO_SPARQL + "?" + urllib.parse.urlencode({"query": P + query})

    def fetch():
        body, _ = U.http_request(url, headers={"Accept": "application/sparql-results+json"},
                                 pacer=PACER, timeout=240)
        return body
    d = _cached(path, stage, fetch)
    return [{k: v["value"] for k, v in b.items()} for b in d["results"]["bindings"]]


def pubsearch(name: str, stage: str, publication_number=None, ipc=None, kinds=None,
              year_start=1978, week_start=51):
    """Publication Server search backend (POST .../publications), all pages, each page cached."""
    body = {"publicationNumber": publication_number, "applicationNumber": None, "ipcSymbol": ipc,
            "publicationDateRange": {"isRange": True, "publicationYear": None, "publicationWeek": None,
                                     "publicationYearStart": year_start, "publicationWeekStart": week_start,
                                     "publicationYearEnd": time.gmtime().tm_year, "publicationWeekEnd": 53},
            "publicationKinds": kinds or (C.EPO_A_KINDS + ["A3"] + C.EPO_B_KINDS)}
    out, page = [], 0
    while True:
        path = os.path.join(C.CACHE_DISC_EPO, "search", "%s_p%03d.json" % (name, page))
        url = "%s/publications?page=%d&size=%d&lng=en" % (C.EPO_PUBSERVER, page, C.EPO_SEARCH_PAGE_SIZE)

        def fetch():
            raw, _ = U.http_request(url, data=json.dumps(body).encode(),
                                    headers={"Content-Type": "application/json"}, pacer=PACER, timeout=180)
            return raw
        d = _cached(path, stage, fetch)
        out.extend(d.get("content") or [])
        if d.get("last", True) or not d.get("content"):
            break
        page += 1
    return out


def number_search(num7: str):
    """All publications of one EP publication number (cached per number)."""
    path = os.path.join(C.CACHE_DISC_EPO, "num", num7 + ".json")
    body = {"publicationNumber": str(int(num7)), "applicationNumber": None, "ipcSymbol": None,
            "publicationDateRange": {"isRange": True, "publicationYear": None, "publicationWeek": None,
                                     "publicationYearStart": 1978, "publicationWeekStart": 51,
                                     "publicationYearEnd": time.gmtime().tm_year, "publicationWeekEnd": 53},
            "publicationKinds": C.EPO_A_KINDS + ["A3"] + C.EPO_B_KINDS}
    url = "%s/publications?page=0&size=100&lng=en" % C.EPO_PUBSERVER

    def fetch():
        raw, _ = U.http_request(url, data=json.dumps(body).encode(),
                                headers={"Content-Type": "application/json"}, pacer=PACER, timeout=120)
        return raw
    d = _cached(path, "numsearch", fetch)
    return [r for r in (d.get("content") or []) if "%07d" % int(r["publicationNumber"]) == num7]


# ============================================================================= model
class App:
    """One EP application: everything known about its publications."""
    __slots__ = ("appno", "filing", "grant", "fam", "pubs", "cpc", "title", "applicants", "disc_codes",
                 "from_ipc", "sparql_pubs")

    def __init__(self, appno):
        self.appno = appno
        self.filing = None
        self.grant = None
        self.fam = None
        self.pubs = {}            # (num7, kind) -> date
        self.cpc = set()
        self.title = None
        self.applicants = []
        self.disc_codes = set()   # core CPC codes that found it (SPARQL)
        self.from_ipc = set()     # IPC symbols that found it (Publication Server)
        self.sparql_pubs = set()  # (num7, kind) listed by the linked data


APPS: dict = {}                   # appno -> App
NUM2APP: dict = {}                # num7 -> appno
IDX: dict = {}                    # (num7, kind) -> best search record (latest date)
ROWS: dict = {}                   # pn -> row dict


def app_of(appno: str) -> App:
    a = APPS.get(appno)
    if a is None:
        a = APPS[appno] = App(appno)
    return a


def add_pub(a: App, num7: str, kind: str, date):
    d = U.to_date(date)
    if (num7, kind) not in a.pubs or (d and not a.pubs[(num7, kind)]):
        a.pubs[(num7, kind)] = d
    NUM2APP.setdefault(num7, a.appno)


def index_records(recs):
    for r in recs:
        try:
            key = ("%07d" % int(r["publicationNumber"]), r["publicationKind"])
        except (KeyError, ValueError, TypeError):
            continue
        old = IDX.get(key)
        if old is None or (r.get("publicationDate") or "") >= (old.get("publicationDate") or ""):
            IDX[key] = r


def new_row(pn, auth, kind, **kw):
    r = {"pn": pn, "auth": auth, "kind": kind, "pub_date": None, "family_id": None, "app_number": None,
         "title": None, "assignees": [], "cpc": [], "tier": None, "sources": set(), "seed_family": None,
         "seed_tier": None, "fetch": False, "fetch_id": None, "fetch_source": None, "priority": 0.0}
    r.update(kw)
    ROWS[pn] = r
    return r


# ============================================================================= a) SureChEMBL
def load_surechembl():
    con = duckdb.connect()
    cur = con.execute("select patent_number, country, kind, publication_date, family_id, tier, cpc, assignee, title "
                      "from read_parquet(?)", [C.SURECHEMBL_PATENTS])
    n = bad = 0
    for pn_raw, country, kind, pd_, fam, tier, cpc, assg, title in cur.fetchall():
        p = U.split_pn(pn_raw)
        if not p or p[0] != country:
            bad += 1
            continue
        pn = "".join(p)
        new_row(pn, p[0], p[2] or kind, pub_date=pd_, family_id=fam, title=title,
                assignees=list(dict.fromkeys(assg or [])), cpc=[U.norm_cpc(c) for c in (cpc or [])],
                tier=int(tier) if tier is not None else None, sources={"surechembl"})
        n += 1
    U.log("surechembl: %d rows (%d unparseable numbers)" % (n, bad))
    return n, bad


# ============================================================================= b) EPO SPARQL by core CPC
def _cpc_uri(code: str) -> str:
    return "<http://data.epo.org/linked-data/def/cpc/%s>" % code.replace("/", "-")


def _kind(uri: str) -> str:
    return uri.rsplit("_", 1)[-1]


def _fam(uri):
    try:
        return int(uri.rstrip("/").rsplit("/", 1)[-1]) if uri else None
    except ValueError:
        return None


def _take_pub_rows(rows, code=None):
    for b in rows:
        a = app_of(b["appno"])
        if code:
            a.disc_codes.add(code)
        a.filing = a.filing or U.to_date(b.get("fd"))
        a.grant = a.grant or U.to_date(b.get("gd"))
        a.fam = a.fam or _fam(b.get("fam"))
        try:
            key = ("%07d" % int(b["pubno"]), _kind(b["kind"]))
        except ValueError:
            continue
        add_pub(a, key[0], key[1], b.get("pd"))
        a.sparql_pubs.add(key)


def _take_meta(titles, applicants, cpcs):
    for b in titles:
        a = APPS.get(b["appno"])
        if a is not None and not a.title:
            a.title = " ".join(b["t"].split())
    for b in applicants:
        a = APPS.get(b["appno"])
        if a is not None:
            fn = " ".join(b["fn"].split())
            if fn and fn not in a.applicants:
                a.applicants.append(fn)
    for b in cpcs:
        a = APPS.get(b["appno"])
        if a is not None:
            a.cpc.add(b["c"].rsplit("/", 1)[-1].replace("-", "/"))


def epo_sparql_discovery():
    codes = C.CPC_CORE
    done = 0
    for code in codes:
        u = _cpc_uri(code)
        match = "{ ?app patent:classificationCPCInventive %s } UNION { ?app patent:classificationCPCAdditional %s }" % (u, u)
        nm = "cpc_" + code.replace("/", "-")
        try:
            pubs = sparql("SELECT ?appno ?fd ?gd ?fam ?pubno ?kind ?pd WHERE { %s "
                          "?app patent:applicationNumber ?appno ; patent:publication ?pub . "
                          "?pub patent:publicationNumber ?pubno ; patent:publicationKind ?kind ; patent:publicationDate ?pd . "
                          "OPTIONAL { ?app patent:filingDate ?fd } OPTIONAL { ?app patent:grantDate ?gd } "
                          "OPTIONAL { ?app patent:familyMemberOf ?fam } }" % match, nm + "_pubs")
            titles = sparql("SELECT DISTINCT ?appno ?t WHERE { %s ?app patent:applicationNumber ?appno ; patent:publication ?pub . "
                            "?pub patent:titleOfInvention ?t FILTER(lang(?t)='en') }" % match, nm + "_title")
            appl = sparql("SELECT DISTINCT ?appno ?fn WHERE { %s ?app patent:applicationNumber ?appno ; patent:publication ?pub . "
                          "?pub patent:applicantVC ?vc . ?vc vcard:fn ?fn }" % match, nm + "_applicant")
            cpcs = sparql("SELECT ?appno ?c WHERE { %s ?app patent:applicationNumber ?appno . "
                          "{ ?app patent:classificationCPCInventive ?c } UNION { ?app patent:classificationCPCAdditional ?c } }" % match,
                          nm + "_cpc")
        except Budget as e:
            U.log("sparql discovery stopped: %s" % e)
            break
        _take_pub_rows(pubs, code)
        _take_meta(titles, appl, cpcs)
        done += 1
        U.log("sparql %-12s %5d applications  (%d/%d codes, %d applications so far)" % (
            code, len({b["appno"] for b in pubs}), done, len(codes), len(APPS)))
    return done


def _batches(nums, n):
    nums = sorted(nums)
    for i in range(0, len(nums), n):
        yield nums[i:i + n]


def sparql_lookup(nums, with_meta: set):
    """Resolve EP publication numbers to their application + all sibling publications (batched VALUES)."""
    nums = sorted(set(nums))
    if not nums:
        return 0
    prog = U.Progress(len(nums), every=C.EPO_SPARQL_BATCH * 10, label="sparql lookup")
    resolved_before = len(NUM2APP)
    for batch in _batches(nums, C.EPO_SPARQL_BATCH):
        h = hashlib.sha1(" ".join(batch).encode()).hexdigest()[:16]
        vals = " ".join('"%s"' % n for n in batch)
        head = ("VALUES ?n { %s } ?p0 patent:publicationNumber ?n ; patent:publicationAuthority %s ; "
                "patent:application ?app . ?app patent:applicationNumber ?appno . " % (vals, EP_AUTH))
        try:
            pubs = sparql("SELECT ?appno ?fd ?gd ?fam ?pubno ?kind ?pd WHERE { %s ?app patent:publication ?pub . "
                          "?pub patent:publicationNumber ?pubno ; patent:publicationKind ?kind ; patent:publicationDate ?pd . "
                          "OPTIONAL { ?app patent:filingDate ?fd } OPTIONAL { ?app patent:grantDate ?gd } "
                          "OPTIONAL { ?app patent:familyMemberOf ?fam } }" % head, "num_%s_pubs" % h, "sparql_lookup")
            _take_pub_rows(pubs)
            if with_meta.intersection(batch):
                titles = sparql("SELECT DISTINCT ?appno ?t WHERE { %s ?app patent:publication ?pub . "
                                "?pub patent:titleOfInvention ?t FILTER(lang(?t)='en') }" % head,
                                "num_%s_title" % h, "sparql_lookup")
                appl = sparql("SELECT DISTINCT ?appno ?fn WHERE { %s ?app patent:publication ?pub . "
                              "?pub patent:applicantVC ?vc . ?vc vcard:fn ?fn }" % head,
                              "num_%s_applicant" % h, "sparql_lookup")
                cpcs = sparql("SELECT ?appno ?c WHERE { %s { ?app patent:classificationCPCInventive ?c } UNION "
                              "{ ?app patent:classificationCPCAdditional ?c } }" % head,
                              "num_%s_cpc" % h, "sparql_lookup")
                _take_meta(titles, appl, cpcs)
        except Budget as e:
            U.log("sparql lookup stopped: %s" % e)
            break
        for _ in batch:
            prog.tick()
    return len(NUM2APP) - resolved_before


# ============================================================================= b) Publication Server IPC search
def epo_ipc_discovery():
    """Exact field IPC symbols, B kinds: adds applications (source epo_ipc)."""
    found = {}                                  # num7 -> set(ipc symbols)
    for sym in C.EPO_IPC_DISCOVERY:
        try:
            recs = pubsearch("ipc_%s_B" % sym.replace("/", "-"), "ipc_discovery", ipc=sym, kinds=C.EPO_B_KINDS)
        except Budget as e:
            U.log("ipc discovery stopped: %s" % e)
            break
        index_records(recs)
        for r in recs:
            found.setdefault("%07d" % int(r["publicationNumber"]), set()).add(sym)
        U.log("ipc discovery %-10s %5d B records, %d numbers so far" % (sym, len(recs), len(found)))
    return found


def epo_ipc_index():
    """IPC main groups as a lookup index: kinds, correction codes and file sizes without per-number calls."""
    n = 0
    for grp in C.EPO_IPC_INDEX_GROUPS:
        try:
            b = pubsearch("idx_%s_B" % grp, "ipc_index", ipc=grp, kinds=C.EPO_B_KINDS)
            a = pubsearch("idx_%s_A%d" % (grp, C.FETCH_EP_A_MIN_FILING_YEAR), "ipc_index", ipc=grp,
                          kinds=C.EPO_A_KINDS, year_start=C.FETCH_EP_A_MIN_FILING_YEAR, week_start=1)
        except Budget as e:
            U.log("ipc index stopped: %s" % e)
            break
        index_records(b)
        index_records(a)
        n += len(a) + len(b)
        U.log("ipc index %-8s %6d B + %6d A records, index size %d" % (grp, len(b), len(a), len(IDX)))
    return n


# ============================================================================= c) US discovery
def load_us_discovery():
    if not os.path.exists(C.US_DISCOVERY):
        U.log("us_discovery.parquet not present -> continuing without it (re-run discover.py when it exists)")
        return None
    con = duckdb.connect()
    cols = [c[0] for c in con.execute("describe select * from read_parquet(?)", [C.US_DISCOVERY]).fetchall()]
    need = ["guid", "source", "pn", "kind", "pub_date", "app_number", "title", "assignee", "cpc", "family_id_us"]
    missing = [c for c in need if c not in cols]
    if missing:
        U.log("us_discovery.parquet lacks columns %s -> ignored" % missing)
        return None
    n = new = 0
    for guid, source, pn, kind, pd_, appno, title, assg, cpc, fam in con.execute(
            "select %s from read_parquet(?)" % ", ".join(need), [C.US_DISCOVERY]).fetchall():
        pn = pn or U.canon_pn(guid)
        if not pn:
            continue
        n += 1
        r = ROWS.get(pn)
        if r is None:
            r = new_row(pn, "US", kind or (U.split_pn(pn) or ("", "", ""))[2])
            new += 1
        r["sources"].add("ppubs")
        r["pub_date"] = r["pub_date"] or U.to_date(pd_)
        r["app_number"] = r["app_number"] or appno
        r["title"] = r["title"] or title
        if not r["assignees"] and assg:
            r["assignees"] = [assg] if isinstance(assg, str) else list(assg)
        r["cpc"] = list(dict.fromkeys(list(r["cpc"]) + [U.norm_cpc(c) for c in (cpc or [])]))
        if r["family_id"] is None and fam is not None:
            r["family_id"] = int(fam)        # ppubs family id = DOCDB simple family (99.8 % agreement measured)
        r["_guid"], r["_src"] = guid, source
    U.log("us_discovery: %d rows, %d new publications" % (n, new))
    return {"rows": n, "new_publications": new}


# ============================================================================= d) seed
def load_seed():
    fams = U.read_json(C.SEED_FAMILIES, [])
    seeds = []
    for f in fams:
        for m in f.get("members", []):
            p = U.split_pn(m.get("pn"))
            if not p:
                seeds.append({"pn": m.get("pn"), "family": f["family_id"], "tier": f.get("tier"), "bad": True})
                continue
            seeds.append({"pn": "".join(p), "auth": p[0], "num": p[1], "kind": p[2], "family": f["family_id"],
                          "tier": f.get("tier"), "title": m.get("title"),
                          "assignees": m.get("assignee_current") or m.get("assignees") or [],
                          "cpc": [U.norm_cpc(c) for c in list(f.get("cpc_leaf_codes") or []) if isinstance(c, str)]})
    return seeds


# ============================================================================= EP fetch rules
_KRANK = {"B1": 1, "B2": 2, "B3": 3, "B9": 4, "A1": 1, "A2": 2, "A9": 4}


def a_fulltext(rec):
    """Search record of an A publication -> (True/False/None, basis). No download needed."""
    if rec is None:
        return None, "no_search_record"
    x = rec.get("xmlFileSize")
    if x:
        return x > C.EP_A_FULLTEXT_MIN_XML_BYTES, "xml_size"
    pg = rec.get("pdfFilePageNumber")
    if pg:
        return pg >= C.EP_A_FULLTEXT_MIN_PDF_PAGES, "pdf_pages"
    if rec.get("publishedByEpo") is False:
        return False, "not_published_by_epo"
    t = rec.get("totalSize") or rec.get("epDocumentSize")
    if t:
        return t > 3 * C.EP_A_FULLTEXT_MIN_XML_BYTES, "total_size"
    return None, "no_size_in_record"


def _ensure_number_record(num7, a: App | None):
    """Per-number search (cached); folds the answer into the index and the application."""
    try:
        recs = number_search(num7)
    except Budget:
        return None
    except U.HttpFailure as e:
        U.log("number search %s failed: %s" % (num7, e))
        STATS["numsearch_failed"] += 1
        return False
    index_records(recs)
    for r in recs:
        appno = r.get("applicationNumber")
        if a is None and appno:
            a = app_of(appno)
        if a is not None:
            add_pub(a, num7, r["publicationKind"], r.get("publicationDate"))
            a.filing = a.filing or U.to_date(r.get("applicationDate"))
    return bool(recs)


def resolve_ep(seed_ep):
    """Decide the publication to fetch per EP application. Returns statistics."""
    st = collections.Counter()
    plan = {}                                   # appno -> (num7, kind, fetch_id, rule)
    # which numbers need a per-number search?  B9 as latest B without a record; A candidates without a record
    need = []
    for a in APPS.values():
        bs = [(d or datetime.date.min, _KRANK[k[1]], k) for k, d in a.pubs.items() if k[1] in C.FETCH_EP_B_KINDS]
        if bs:
            k = max(bs)[2]
            if k[1] == "B9" and k not in IDX:
                need.append((k[0], a))
            continue
        fy = (a.filing or min([d for d in a.pubs.values() if d] or [datetime.date.min])).year
        if fy < C.FETCH_EP_A_MIN_FILING_YEAR:
            continue
        ak = [k for k in a.pubs if k[1] in C.FETCH_EP_A_KINDS]
        if ak and not any(k in IDX for k in ak):
            need.append((ak[0][0], a))
    need = list({n: a for n, a in need}.items())
    U.log("EP resolution: %d applications; per-number search needed for %d numbers (%d already cached)" % (
        len(APPS), len(need), sum(1 for n, _ in need if os.path.exists(os.path.join(C.CACHE_DISC_EPO, "num", n + ".json")))))
    prog = U.Progress(len(need), every=C.PROGRESS_EVERY, label="number search")
    for n, a in need:
        if _ensure_number_record(n, a) is None:
            U.log("number search stopped (--limit / --offline); remaining numbers stay unresolved")
            break
        prog.tick()

    for a in APPS.values():
        bs = [(d or datetime.date.min, _KRANK[k[1]], k) for k, d in a.pubs.items() if k[1] in C.FETCH_EP_B_KINDS]
        if bs:
            k = max(bs)[2]
            rec = IDX.get(k)
            cc = (rec or {}).get("correctionCode") or None
            if k[1] == "B9" and rec is None:
                st["b9_without_record_default_W1"] += 1
            plan[a.appno] = (k[0], k[1], U.ep_fetch_id(k[0], k[1], cc), "latest_B")
            st["app_with_B"] += 1
            continue
        fy = (a.filing or min([d for d in a.pubs.values() if d] or [datetime.date.min])).year
        if fy < C.FETCH_EP_A_MIN_FILING_YEAR:
            st["app_no_B_filed_before_%d" % C.FETCH_EP_A_MIN_FILING_YEAR] += 1
            continue
        cands = sorted([(d or datetime.date.min, _KRANK[k[1]], k) for k, d in a.pubs.items()
                        if k[1] in C.FETCH_EP_A_KINDS], reverse=True)
        if not cands:
            st["app_no_B_no_A_publication"] += 1
            continue
        decided = None
        for _, _, k in cands:
            ft, basis = a_fulltext(IDX.get(k))
            if ft:
                rec = IDX[k]
                plan[a.appno] = (k[0], k[1], U.ep_fetch_id(k[0], k[1], rec.get("correctionCode") or None), "A_fulltext")
                decided = "A_fulltext(%s)" % basis
                break
            decided = decided or ("A_stub(%s)" % basis if ft is False else "A_unknown(%s)" % basis)
        st["app_no_B_" + decided] += 1
    return plan, st


# ============================================================================= main assembly
def band_of(seed_tier, cpcs) -> int:
    if seed_tier == 1:
        return C.BAND_SEED_T1
    if seed_tier == 2:
        return C.BAND_SEED_T2
    s = set(cpcs)
    if s.intersection(C.CPC_LIPID_SPECIFIC):
        return C.BAND_LIPID
    if s.intersection(C.CPC_CORE):
        return C.BAND_CORE
    return C.BAND_CONTEXT


def priority(band: int, d) -> float:
    days = (d - datetime.date(1970, 1, 1)).days if d else 0
    return round(band + max(0, min(days, 39999)) / 40000.0, 6)


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0, help="smoke run: at most N requests per network stage")
    ap.add_argument("--refresh", action="store_true", help="re-download discovery responses (not per-number lookups)")
    ap.add_argument("--offline", action="store_true", help="use cached responses only")
    ARGS = ap.parse_args()
    ARGS.refresh_stages = {"sparql", "ipc_discovery", "ipc_index"}
    C.ensure_dirs()
    t0 = time.time()
    smoke = bool(ARGS.limit)
    out_targets = C.TARGETS.replace(".parquet", "_smoke.parquet") if smoke else C.TARGETS
    out_summary = C.DISCOVER_SUMMARY.replace(".json", "_smoke.json") if smoke else C.DISCOVER_SUMMARY

    # ---- a) SureChEMBL
    n_sc, n_sc_bad = load_surechembl()

    # ---- b) EPO discovery
    n_codes = epo_sparql_discovery()
    sparql_apps = set(APPS)
    ipc_found = epo_ipc_discovery()
    epo_ipc_index()

    # ---- c) US discovery
    us_info = load_us_discovery()

    # ---- d) seed
    seeds = load_seed()
    seed_ep = [s for s in seeds if not s.get("bad") and s["auth"] == "EP"]

    # ---- resolve every known EP number to its application
    sc_ep_nums = {U.split_pn(pn)[1] for pn, r in ROWS.items() if r["auth"] == "EP"}
    all_nums = sc_ep_nums | set(ipc_found) | {s["num"] for s in seed_ep}
    todo = {n for n in all_nums if n not in NUM2APP}
    U.log("EP numbers: %d from SureChEMBL, %d from IPC discovery, %d seed; %d not yet resolved by CPC discovery" % (
        len(sc_ep_nums), len(ipc_found), len(seed_ep), len(todo)))
    sparql_lookup(todo, with_meta=todo - sc_ep_nums)
    # numbers unknown to the linked data: fall back to the search index / per-number search / a stand-alone app
    unresolved = sorted(n for n in all_nums if n not in NUM2APP)
    by_num = collections.defaultdict(list)
    for (num, _), r in IDX.items():
        by_num[num].append(r)
    for n in unresolved:
        recs = by_num.get(n, [])
        appno = next((r.get("applicationNumber") for r in recs if r.get("applicationNumber")), None)
        if appno:
            a = app_of(appno)
            for r in recs:
                add_pub(a, n, r["publicationKind"], r.get("publicationDate"))
                a.filing = a.filing or U.to_date(r.get("applicationDate"))
            STATS["ep_numbers_resolved_by_search_index"] += 1
    # seed EP numbers: always ask the search backend (authoritative for kinds / correction codes)
    for s in seed_ep:
        _ensure_number_record(s["num"], APPS.get(NUM2APP.get(s["num"])))
    for n in [n for n in unresolved if n not in NUM2APP]:
        a = app_of("?" + n)                       # no application number known
        for pn, r in ROWS.items():
            if r["auth"] == "EP" and pn[2:9] == n:
                add_pub(a, n, r["kind"], r["pub_date"])
        STATS["ep_numbers_without_application"] += 1
    # publications that SureChEMBL knows but the linked data does not list for the application
    for pn, r in ROWS.items():
        if r["auth"] == "EP":
            n = pn[2:9]
            a = APPS.get(NUM2APP.get(n))
            if a is not None and (n, r["kind"]) not in a.pubs:
                add_pub(a, n, r["kind"], r["pub_date"])
    for n, syms in ipc_found.items():
        a = APPS.get(NUM2APP.get(n))
        if a is not None:
            a.from_ipc |= syms

    # ---- EP: fetch plan per application
    plan, ep_stats = resolve_ep(seed_ep)

    # ---- EP rows: one per publication of every known application
    for a in APPS.values():
        sib = [ROWS.get("EP%s%s" % k) for k in a.pubs]
        tiers = [r["tier"] for r in sib if r and r["tier"]]
        tier = min(tiers) if tiers else None
        fam = next((r["family_id"] for r in sib if r and r["family_id"] is not None), None) or a.fam
        cpc_union = set(a.cpc)
        for r in sib:
            if r:
                cpc_union.update(r["cpc"])
        title = a.title or next((r["title"] for r in sib if r and r["title"]), None)
        assg = a.applicants or next((r["assignees"] for r in sib if r and r["assignees"]), [])
        appno = None if a.appno.startswith("?") else a.appno
        for (n, kind), d in a.pubs.items():
            pn = "EP%s%s" % (n, kind)
            r = ROWS.get(pn)
            if r is None:
                r = new_row(pn, "EP", kind, pub_date=d, tier=tier)
            r["pub_date"] = r["pub_date"] or d
            r["app_number"] = appno
            r["family_id"] = r["family_id"] if r["family_id"] is not None else fam
            r["title"] = r["title"] or title
            r["assignees"] = r["assignees"] or list(assg)
            r["cpc"] = sorted(set(r["cpc"]) | a.cpc)
            if r["tier"] is None:
                r["tier"] = tier
            if a.from_ipc and kind.startswith("B"):
                r["sources"].add("epo_ipc")
            if (n, kind) in a.sparql_pubs and (a.appno in sparql_apps or not r["sources"]):
                r["sources"].add("epo_sparql")   # by core CPC, or a sibling publication resolved via the linked data
            if not r["sources"]:
                r["sources"].add("epo_ipc")      # known from the publication server search only
            r["_cpc_app"] = cpc_union
        p = plan.get(a.appno)
        if p:
            r = ROWS["EP%s%s" % (p[0], p[1])]
            r["fetch"], r["fetch_id"], r["fetch_source"], r["_rule"] = True, p[2], "epo", p[3]

    # ---- US fetch rules
    us_stats = collections.Counter()
    grants_by_app = set()
    pre_by_app = {}
    for r in ROWS.values():
        if r["auth"] != "US":
            continue
        src = r.get("_src") or U.us_source(r["pn"])
        r["_is_grant"] = (src == "USPAT")
        if r["_is_grant"] and r["app_number"]:
            grants_by_app.add(r["app_number"])
    for r in ROWS.values():
        if r["auth"] != "US":
            continue
        guid = r.get("_guid") or U.us_guid(r["pn"])
        src = r.get("_src") or U.us_source(r["pn"])
        if r["_is_grant"]:
            r["fetch"], r["fetch_id"], r["fetch_source"], r["_rule"] = True, guid, src, "grant"
            us_stats["grant"] += 1
            continue
        if not r["pub_date"] or r["pub_date"].year < C.FETCH_US_PREGRANT_MIN_PUB_YEAR:
            us_stats["pregrant_before_%d" % C.FETCH_US_PREGRANT_MIN_PUB_YEAR] += 1
            continue
        if r["app_number"]:
            if r["app_number"] in grants_by_app:
                us_stats["pregrant_application_granted"] += 1
                continue
            old = pre_by_app.get(r["app_number"])
            if old is None or (r["pub_date"], r["pn"]) > (old["pub_date"], old["pn"]):
                pre_by_app[r["app_number"]] = r
        else:   # application unknown (SureChEMBL only): cannot prove a grant exists -> fetch (conservative)
            r["fetch"], r["fetch_id"], r["fetch_source"], r["_rule"] = True, guid, src, "pregrant_app_unknown"
            us_stats["pregrant_app_unknown_fetched"] += 1
    for r in pre_by_app.values():
        r["fetch"], r["fetch_id"], r["fetch_source"] = True, r.get("_guid") or U.us_guid(r["pn"]), r.get("_src") or U.us_source(r["pn"])
        r["_rule"] = "pregrant_no_grant"
        us_stats["pregrant_no_grant_latest"] += 1

    # ---- seed: mark, add, force fetch
    seed_report = []
    for s in seeds:
        if s.get("bad"):
            seed_report.append({"pn": s["pn"], "seed_family": s["family"], "matched": False, "fetch": False,
                                "why": "unparseable publication number"})
            continue
        pn = s["pn"]
        r = ROWS.get(pn)
        rep = {"pn": pn, "seed_family": s["family"], "seed_tier": s["tier"], "matched": r is not None,
               "found_in": sorted(r["sources"]) if r else []}
        if r is None:
            r = new_row(pn, s["auth"], s["kind"], title=s.get("title"), assignees=list(s.get("assignees") or []),
                        cpc=list(s.get("cpc") or []))
        r["sources"].add("seed")
        r["seed_family"], r["seed_tier"] = s["family"], s["tier"]
        if s["auth"] == "US":
            r["fetch"], r["fetch_id"], r["fetch_source"] = True, r.get("_guid") or U.us_guid(pn), r.get("_src") or U.us_source(pn)
            r["_rule"] = r.get("_rule") or "seed"
            rep.update(fetch=True, fetch_id=r["fetch_id"])
            if not rep["matched"]:
                rep["why"] = "not in SureChEMBL subset or US discovery; guid derived from the number (ppubs fetch will verify)"
        elif s["auth"] == "EP":
            a = APPS.get(NUM2APP.get(s["num"]))
            recs = {k[1]: rec for k, rec in IDX.items() if k[0] == s["num"]}
            if not recs:
                rep.update(fetch=False, why="publication server search returned no record for this number")
            elif s["kind"].startswith("B"):
                p = plan.get(a.appno) if a else None
                if p and p[3] == "latest_B":
                    r["fetch"], r["fetch_id"], r["fetch_source"], r["_rule"] = True, p[2], "epo", "seed_latest_B"
                    tgt = ROWS["EP%s%s" % (p[0], p[1])]
                    tgt["seed_family"], tgt["seed_tier"] = tgt["seed_family"] or s["family"], tgt["seed_tier"] or s["tier"]
                    rep.update(fetch=True, fetch_id=p[2], latest_B="EP%s%s" % (p[0], p[1]),
                               kinds_on_server=sorted(recs))
                else:
                    rep.update(fetch=False, why="no B publication found on the publication server",
                               kinds_on_server=sorted(recs))
            else:   # A publication: as it is
                rec = recs.get(s["kind"])
                ft, basis = a_fulltext(rec)
                if ft:
                    r["fetch"], r["fetch_source"], r["_rule"] = True, "epo", "seed_A"
                    r["fetch_id"] = U.ep_fetch_id(s["num"], s["kind"], rec.get("correctionCode") or None)
                    rep.update(fetch=True, fetch_id=r["fetch_id"])
                else:
                    p = plan.get(a.appno) if a else None
                    rep.update(fetch=False, why="A publication is %s (%s)" % (
                        "a Euro-PCT stub without full text" if ft is False else "of unknown size", basis),
                        application_fetch_id=p[2] if p else None, kinds_on_server=sorted(recs))
                    if p:   # the same application has a fetchable document: carry the seed mark to it
                        tgt = ROWS["EP%s%s" % (p[0], p[1])]
                        tgt["seed_family"], tgt["seed_tier"] = tgt["seed_family"] or s["family"], tgt["seed_tier"] or s["tier"]
        else:
            rep.update(fetch=False, why="WO publications are never fetched")
        seed_report.append(rep)

    # ---- tier, priority, WO
    for r in ROWS.values():
        if r["tier"] is None:
            r["tier"] = 0 if r["sources"] == {"seed"} else 5
        if r["auth"] == "WO":
            r["fetch"], r["fetch_id"], r["fetch_source"] = False, None, None
        cp = r.get("_cpc_app") or r["cpc"]
        r["_band"] = band_of(r["seed_tier"], cp)
        r["priority"] = priority(r["_band"], r["pub_date"])

    # ---- write
    rows = sorted(ROWS.values(), key=lambda r: r["pn"])
    schema = pa.schema([
        ("pn", pa.string()), ("auth", pa.string()), ("kind", pa.string()), ("pub_date", pa.date32()),
        ("family_id", pa.int64()), ("app_number", pa.string()), ("title", pa.string()),
        ("assignees", pa.list_(pa.string())), ("cpc", pa.list_(pa.string())), ("tier", pa.int32()),
        ("sources", pa.list_(pa.string())), ("seed_family", pa.string()), ("seed_tier", pa.int32()),
        ("fetch", pa.bool_()), ("fetch_id", pa.string()), ("fetch_source", pa.string()), ("priority", pa.float64())])
    cols = {f.name: [] for f in schema}
    for r in rows:
        for name in cols:
            v = r[name]
            if name == "sources":
                v = sorted(v)
            elif name in ("assignees", "cpc"):
                v = [x for x in v if x]
            elif name == "pub_date":
                v = U.to_date(v)
            cols[name].append(v)
    tbl = pa.table({n: pa.array(cols[n], type=schema.field(n).type) for n in cols}, schema=schema)
    tmp = out_targets + ".part"
    pq.write_table(tbl, tmp, compression="zstd")
    os.replace(tmp, out_targets)

    # ---- summary
    def cnt(key, pred=lambda r: True):
        c = collections.Counter()
        for r in rows:
            if pred(r):
                k = key(r)
                for kk in (k if isinstance(k, (list, set, tuple)) else [k]):
                    c[kk] += 1
        return dict(sorted(c.items(), key=lambda x: str(x[0])))

    fetch_ep = [r for r in rows if r["auth"] == "EP" and r["fetch"]]
    ep_ids = {}
    for r in fetch_ep:
        ep_ids.setdefault(r["fetch_id"], r)
    ep_b = sum(1 for i in ep_ids if i[-2] == "B")
    ep_a = sum(1 for i in ep_ids if i[-2] == "A")
    us_ids = {r["fetch_id"]: r for r in rows if r["auth"] == "US" and r["fetch"]}
    summary = {
        "generated": U.now_iso(), "smoke_run": smoke, "runtime_s": round(time.time() - t0, 1),
        "surechembl_snapshot": C.SURECHEMBL_SNAPSHOT,
        "inputs": {"surechembl_rows": n_sc, "surechembl_unparseable": n_sc_bad,
                   "epo_sparql_core_codes_done": n_codes, "epo_sparql_core_codes_total": len(C.CPC_CORE),
                   "epo_sparql_applications_by_core_cpc": len(sparql_apps),
                   "epo_ipc_discovery_numbers": len(ipc_found), "epo_search_index_records": len(IDX),
                   "us_discovery": us_info if us_info else "absent (continued without it)",
                   "seed_numbers": len(seeds)},
        "requests": dict(STATS),
        "rows": len(rows),
        "by_authority": cnt(lambda r: r["auth"]),
        "by_authority_kind": cnt(lambda r: "%s %s" % (r["auth"], r["kind"])),
        "by_tier": cnt(lambda r: r["tier"]),
        "by_source": cnt(lambda r: sorted(r["sources"])),
        "by_source_combination": cnt(lambda r: "+".join(sorted(r["sources"]))),
        "ep_applications": len(APPS),
        "ep_resolution": dict(ep_stats),
        "us_rules": dict(us_stats),
        "fetch_true_rows": cnt(lambda r: r["auth"], lambda r: r["fetch"]),
        "fetch_true_by_authority_kind": cnt(lambda r: "%s %s" % (r["auth"], r["kind"]), lambda r: r["fetch"]),
        "fetch_true_by_rule": cnt(lambda r: "%s %s" % (r["auth"], r.get("_rule")), lambda r: r["fetch"]),
        "fetch_true_by_band": cnt(lambda r: "%s band %d" % (r["auth"], r["_band"]), lambda r: r["fetch"]),
        "ep_fetch_documents": {"distinct_fetch_ids": len(ep_ids), "B": ep_b, "A": ep_a,
                               "by_kind": dict(collections.Counter(i[-2:] for i in ep_ids)),
                               "already_cached": sum(1 for i in ep_ids if os.path.exists(os.path.join(C.CACHE_EP, i + ".xml"))),
                               "estimated_full_run_hours_at_1.3s_per_document": round(len(ep_ids) * 1.3 / 3600, 1)},
        "us_fetch_documents": {"distinct_fetch_ids": len(us_ids),
                               "by_source": dict(collections.Counter(r["fetch_source"] for r in us_ids.values()))},
        "seed": {"numbers": len(seeds), "fetch_true": sum(1 for s in seed_report if s.get("fetch")),
                 "matched_existing_row": sum(1 for s in seed_report if s.get("matched")),
                 "not_fetchable": [s for s in seed_report if not s.get("fetch")],
                 "not_matched_before_seed": [{"pn": s["pn"], "why": s.get("why", "added from the seed file")}
                                             for s in seed_report if not s.get("matched")],
                 "ep_resolved": [{"pn": s["pn"], "latest_B": s.get("latest_B"), "fetch_id": s.get("fetch_id")}
                                 for s in seed_report if s["pn"].startswith("EP")]},
    }
    U.write_json(out_summary, summary)
    U.log("wrote %s (%d rows) and %s in %s" % (out_targets, len(rows), out_summary, U.fmt_dur(time.time() - t0)))
    U.log("by authority %s | fetch=true rows %s | EP documents to fetch: %d (B %d, A %d) | seed fetch=true %d/%d" % (
        summary["by_authority"], summary["fetch_true_rows"], len(ep_ids), ep_b, ep_a,
        summary["seed"]["fetch_true"], len(seeds)))


if __name__ == "__main__":
    main()
