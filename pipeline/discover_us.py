#!/usr/bin/env python3
"""Enumerate the LNP field in USPTO ppubs (USPAT grants + US-PGPUB pre-grants).

Writes data/work/us_discovery.parquet. Every search page is cached under data/cache/disc/ppubs/,
so a re-run is offline and resumable.   Usage: python3 pipeline/discover_us.py [--limit-pages N] [--only TAG,...]
"""
import argparse, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
try:
    from config import DATA, CACHE_DISC, WORK  # type: ignore
except Exception:
    DATA = os.environ.get("LNP_DATA", "/home/user/ip/data")
    CACHE_DISC = os.path.join(DATA, "cache", "disc")
    WORK = os.path.join(DATA, "work")
import ppubs
import pyarrow as pa, pyarrow.parquet as pq

CORE_CPC = ["A61K9/5123", "A61K9/1271", "A61K9/1272", "A61K9/1277", "A61K47/6911", "A61K47/6929",
            "A61K47/543", "A61K47/544", "C12N15/88", "A61K48/0033", "A61K48/0041"]
KW = ('("lipid nanoparticle" OR LNP OR "cationic lipid" OR "ionizable lipid" OR "amino lipid" '
      'OR "nucleic acid-lipid particle" OR "nucleic acid lipid particle" OR liposom$)')
DELIV = ('("lipid nanoparticle" OR LNP OR "ionizable lipid" OR "cationic lipid" OR "amino lipid" '
         'OR "nucleic acid-lipid particle" OR liposom$ OR (lipid NEAR3 (delivery OR nanoparticle OR particle)))')
BROAD_CPC = ["A61K9/51$", "A61K9/127$", "A61K47/18", "A61K47/22", "A61K47/24", "A61K47/28",
             "A61K31/7105", "A61K31/7088", "A61K31/713"]
CHEM = ["C07C219", "C07C229", "C07C217", "C07C271", "C07C323", "C07D295", "C07D207", "C07D211", "C07D233", "C07F9/10"]
MANUF = ["B01F33/30", "B01F25/43$", "B01L3/5027"]
MANUF_KW = '("lipid nanoparticle" OR liposom$ OR "nucleic acid" OR "lipid particle")'
DATE0 = ""  # no date floor: the field is post-1990 anyway


def cpcq(c):
    return "%s.cpc." % (c if c.endswith("$") else c)


def build_queries(seed_nums, players):
    Q = []  # (tag, query)
    for c in CORE_CPC:
        Q.append(("core:" + c, cpcq(c)))
    for c in BROAD_CPC:
        Q.append(("broad:" + c, "%s AND %s.clm." % (cpcq(c), KW)))
    Q.append(("broad:A61K39+mRNA-LNP", '%s AND (mRNA NEAR5 "lipid nanoparticle").clm.' % cpcq("A61K39$")))
    Q.append(("broad:C12N15/113+LNP", '%s AND ("lipid nanoparticle" OR "lipid nanoparticles").clm.' % cpcq("C12N15/113$")))
    for c in CHEM:
        # plain-class prefix match: C07C219 alone matches nothing in ppubs, C07C219$ matches the whole class
        Q.append(("chem:" + c, "%s AND %s" % (cpcq(c + "$"), DELIV)))
    for c in MANUF:
        Q.append(("manuf:" + c, "%s AND %s.clm." % (cpcq(c), MANUF_KW)))
    for p in players:
        terms = [t.strip() for t in p["rx"].split("|") if t.strip()]
        terms = ['"%s"' % re.sub(r"[^A-Za-z0-9 .&-]", "", t.replace("\\b", "").replace("\\", "")).strip() for t in terms]
        terms = [t for t in terms if len(t) > 3]
        if not terms:
            continue
        Q.append(("player:" + p["player"], "(%s).as. AND (lipid OR nanoparticle OR liposom$).clm." % " OR ".join(terms)))
    for i in range(0, len(seed_nums), 20):
        chunk = seed_nums[i:i + 20]
        Q.append(("seed", "(%s).pn." % " OR ".join('"%s"' % n for n in chunk)))
    return Q


def seed_us_numbers():
    s = json.load(open(os.path.join(DATA, "seed", "seed_families.json")))
    pns = set()
    for f in s:
        for m in f.get("members", []):
            if m["pn"].startswith("US"):
                pns.add(m["pn"])
        for pn in f.get("representative_us", []):
            pns.add(pn)
    return sorted(pns)


def pn_digits(pn):
    m = re.match(r"US(RE\d+|\d+)([A-Z]\d?)?$", pn)
    return m.group(1) if m else None


def norm_cpc(s):
    return [x.strip() for x in re.split(r"[;,]", s or "") if x.strip()]


def clean(x):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", x)).strip() if isinstance(x, str) else x


def as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def hit_row(h):
    kind = (as_list(h.get("kindCode")) or [""])[0]
    num = h.get("publicationReferenceDocumentNumber") or ""
    cpc = []
    for k in ("cpcInventiveFlattened", "cpcAdditionalFlattened"):
        for c in norm_cpc(h.get(k)):
            if c not in cpc:
                cpc.append(c)
    d = (h.get("datePublished") or "")[:10]
    asg = as_list(h.get("assigneeName")) or as_list(h.get("applicantName"))
    return {"guid": h["guid"], "source": h.get("type"), "pn": ppubs.canon_pn(num, kind), "kind": kind,
            "pub_date": d or None, "app_number": h.get("applicationNumber"),
            "title": clean(h.get("inventionTitle")), "assignee": "; ".join(clean(a) for a in asg if a) or None, "cpc": cpc,
            "family_id_us": h.get("familyIdentifierCur")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit-pages", type=int, default=0, help="debug: max rows per query = N*500")
    ap.add_argument("--only", default="", help="comma list of tag prefixes to run")
    ap.add_argument("--out", default=os.path.join(WORK, "us_discovery.parquet"))
    a = ap.parse_args()
    os.makedirs(WORK, exist_ok=True)
    cache = os.path.join(CACHE_DISC, "ppubs")
    players = []
    for x in json.load(open(os.path.join(DATA, "seed", "assignee_variants.json"))):
        if x["player"].startswith("_"):
            continue
        players.append({"player": x["player"], "rx": x["match_regex_case_insensitive"]})
    seed = seed_us_numbers()
    digs = [pn_digits(p) for p in seed]
    Q = build_queries([d for d in digs if d], players)
    if a.only:
        pre = a.only.split(",")
        Q = [q for q in Q if any(q[0].startswith(p) for p in pre)]
    cl = ppubs.Client(pause=1.0)
    rows = {}
    tags = {}
    counts = []
    for tag, q in Q:
        t0 = time.time()
        n = 0
        newc = 0
        for h in cl.enumerate_query(q, cache_dir=cache, limit=(a.limit_pages * 500 or None)):
            g = h["guid"]
            n += 1
            if g not in rows:
                rows[g] = hit_row(h)
                tags[g] = []
                newc += 1
            if tag not in tags[g]:
                tags[g].append(tag)
        counts.append((tag, n, newc))
        print("%-42s hits=%6d new=%6d union=%6d %.0fs" % (tag[:42], n, newc, len(rows), time.time() - t0), flush=True)
    out = []
    for g, r in rows.items():
        r["query_tags"] = tags[g]
        out.append(r)
    out.sort(key=lambda r: (r["pub_date"] or "", r["guid"]), reverse=True)
    schema = pa.schema([("guid", pa.string()), ("source", pa.string()), ("pn", pa.string()), ("kind", pa.string()),
                        ("pub_date", pa.string()), ("app_number", pa.string()), ("title", pa.string()),
                        ("assignee", pa.string()), ("cpc", pa.list_(pa.string())), ("family_id_us", pa.int64()),
                        ("query_tags", pa.list_(pa.string()))])
    tbl = pa.Table.from_pylist(out, schema=schema)
    tmp = a.out + ".tmp"
    pq.write_table(tbl, tmp)
    os.replace(tmp, a.out)
    n_g = sum(1 for r in out if r["source"] == "USPAT")
    n_p = sum(1 for r in out if r["source"] == "US-PGPUB")
    print("UNION %d  USPAT(grants)=%d  US-PGPUB=%d -> %s" % (len(out), n_g, n_p, a.out))
    have = {r["pn"] for r in out}
    miss = [p for p in seed if p not in have]
    print("seed US numbers: %d, found %d, missing %d: %s" % (len(seed), len(seed) - len(miss), len(miss), miss))
    json.dump({"counts": counts, "union": len(out), "grants": n_g, "pregrants": n_p, "seed_missing": miss},
              open(os.path.join(WORK, "us_discovery_summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
