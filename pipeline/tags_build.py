#!/usr/bin/env python3
"""Tags, legal bits and canonical assignees -> data/work/xdata/tags/ (format tg-1, docs/TOOLS_PLAN.md 2.5).

  python3 -I pipeline/tags_build.py [--corpus data/work/corpus.jsonl.gz] [--out data/work/xdata/tags] [--limit N]
                                    [--rules data/seed/tag_rules.json] [--aliases data/seed/assignee_aliases.json]
                                    [--chem data/work/chem] [--status data/work/status.jsonl.gz] [--no-chem]
                                    [--spot-check 30] [--per-tag 0] [--seed 1] [--force]

Rules are data: data/seed/tag_rules.json (tags with regexes EN / DE, CPC prefixes, compound-descriptor conditions, legal bits)
and data/seed/assignee_aliases.json (pipeline/lib/asg_norm.py). Nothing in this file knows about lipids.

Output
  xdata.json   {name, v: "tg-1", built, target: "both", files, counts, notes, src: {corpus_bytes, corpus_mtime, corpus_snapshot, P, ...}}
  tags.gz.bin  gzip of  [u32 jsonLen][JSON {v, P, W, tags: [{bit, group, id, label}], groups, legal: [{bit, id, label}], asg: [names]}]
               [pad to 4][u32 tagBits[W][P]][u32 tagFromClaims[W][P]][u8 legal[P]][pad to 4][u32 asgId[P]]   (little endian)
               W = number of u32 words per patent (tag bit b lives in word b >> 5, bit b & 31; planar: word w starts at w * P);
               asgId = index into asg, 0xffffffff = none; legal bit = the `bit` of the legal entry.
  The patent index p is the row order of the corpus file (non-blank lines, the order build_dist.py uses). xdata.json keeps the
  corpus size and modification time (corpus_snapshot is formatted like manifest.snapshots.corpus) and P so that the engine can
  warn when the dist was built from another corpus snapshot.

Sources of a tag: claims (English; German when there are no English claims), title, abstract, CPC codes, and the compounds that
the chemistry build links to the patent (data/work/chem: chem.json cols, desc.gz.bin, map.gz.bin, pat.gz.bin). A tag that hits in
the claims (text or claim compound) also sets its "from claims" bit. Legal bits come from data/work/status.jsonl.gz (the
corpus copy of the status when the file lacks a publication).
Safe to re-run: the output is rewritten only when an input changed (--force overrides).
"""
import argparse
import array
import datetime
import gzip
import hashlib
import io
import json
import os
import random
import re
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline", "lib"))
from asg_norm import Normalizer, nice  # noqa: E402

T0 = time.time()
VERSION = "tg-1"
BUILDER = 1


def log(*a):
    print("[tags_build %6.1fs]" % (time.time() - T0), *a, flush=True)


def sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else str(p).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()[:16]


def file_sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except OSError:
        return "none"


# ---------------------------------------------------------------------------------------------- rules
class Rules:
    """Compiled tag rules."""

    def __init__(self, doc):
        self.doc = doc
        self.groups = doc["groups"]
        self.tags = doc["tags"]
        self.legal = doc.get("legal") or []
        ids = set()
        gids = {g["id"] for g in self.groups}
        for i, t in enumerate(self.tags):
            if t["id"] in ids:
                raise SystemExit("tag_rules: duplicate tag id %s" % t["id"])
            ids.add(t["id"])
            if t["group"] not in gids:
                raise SystemExit("tag_rules: tag %s has unknown group %s" % (t["id"], t["group"]))
            t["bit"] = i
            t["rx_en"] = self._compile(t, "en")
            t["rx_de"] = self._compile(t, "de")
            t["cpc_t"] = tuple(t.get("cpc") or ())
            t["claims_only"] = bool(t.get("claimsOnly"))
        self.W = max(1, (len(self.tags) + 31) // 32)
        if len(self.legal) > 8:
            raise SystemExit("tag_rules: at most 8 legal bits (u8)")
        for l in self.legal:
            if not 0 <= l["bit"] < 8:
                raise SystemExit("tag_rules: legal bit out of range: %s" % l["id"])

    @staticmethod
    def _compile(t, lang):
        pats = t.get(lang) or []
        for p in pats:
            try:
                re.compile(p)
            except re.error as e:
                raise SystemExit("tag_rules: tag %s has a bad regex %r (%s)" % (t["id"], p, e))
        return re.compile("|".join("(?:%s)" % p for p in pats)) if pats else None


def legal_byte(legal, st):
    """status object -> bit mask. when = {path: 'opposition.filed', eq: value | nonempty: true}"""
    if not st:
        return 0
    b = 0
    for l in legal:
        w = l["when"]
        v = st
        for part in w["path"].split("."):
            v = v.get(part) if isinstance(v, dict) else None
            if v is None:
                break
        ok = False
        if "eq" in w:
            ok = v == w["eq"]
        elif w.get("nonempty"):
            ok = bool(v)
        if ok:
            b |= 1 << l["bit"]
    return b


# ---------------------------------------------------------------------------------------------- chemistry
def compound_hits(rules, chem_dir, pn_to_p, P, log=log):
    """-> {tag_id: (array('B') count per patent of satisfying compounds, link mask)} and evidence helper.
    For each tag with a `compound` rule: the satisfying compounds are found from the descriptor columns, then every link
    compound -> publication whose `where` bits intersect the rule is counted for that publication."""
    tags = [t for t in rules.tags if t.get("compound")]
    if not tags:
        return {}, None
    cj = os.path.join(chem_dir, "chem.json")
    if not os.path.exists(cj):
        log("no chemistry build (%s): compound conditions skipped" % cj)
        return {}, None
    with open(cj, encoding="utf-8") as f:
        meta = json.load(f)
    N = meta["n"]
    types = {"u8": ("B", 1), "u16": ("H", 2), "i16": ("h", 2), "u32": ("I", 4), "f32": ("f", 4)}
    with gzip.open(os.path.join(chem_dir, "desc.gz.bin"), "rb") as f:
        raw = f.read()
    cols = {}
    spec = {c["name"]: c for c in meta["cols"]}

    def col(name):
        if name not in cols:
            if name not in spec:
                raise SystemExit("tag_rules: unknown chemistry column %r (chem.json cols)" % name)
            tc, sz = types[spec[name]["type"]]
            a = array.array(tc)
            a.frombytes(raw[spec[name]["off"]:spec[name]["off"] + N * sz])
            if sys.byteorder != "little":
                a.byteswap()
            cols[name] = a
        return cols[name]
    heads = meta.get("heads") or []
    head_ix = {h: i for i, h in enumerate(heads)}
    where_bits = meta.get("where") or {"clm": 1}
    with gzip.open(os.path.join(chem_dir, "map.gz.bin"), "rb") as f:
        m = f.read()
    n, links = struct.unpack("<II", m[:8])
    if n != N:
        raise SystemExit("chemistry build is inconsistent: map has %d compounds, chem.json %d" % (n, N))
    off = array.array("I")
    off.frombytes(m[8:8 + 4 * (n + 1)])
    ent = array.array("I")
    ent.frombytes(m[8 + 4 * (n + 1):8 + 4 * (n + 1) + 4 * links])
    if sys.byteorder != "little":
        off.byteswap()
        ent.byteswap()
    with gzip.open(os.path.join(chem_dir, "pat.gz.bin"), "rb") as f:
        cpn = json.loads(f.read())["pn"]
    c2p = array.array("i", [pn_to_p.get(x, -1) for x in cpn])
    out = {}
    first = {}      # (tag id) -> {p: compound index} of the first claim compound, for the spot check
    for t in tags:
        r = t["compound"]
        wmask = 0
        for w in r.get("where") or ["clm"]:
            wmask |= where_bits[w]
        clm_bit = where_bits.get("clm", 1)
        hs = None
        if r.get("head"):
            hs = {head_ix[h] for h in r["head"] if h in head_ix}
            unknown = [h for h in r["head"] if h not in head_ix]
            if unknown:
                raise SystemExit("tag_rules: tag %s: unknown head class %s (chem.json heads)" % (t["id"], unknown))
        conds = []
        for cn, lim in (r.get("cols") or {}).items():
            conds.append((col(cn), lim.get("min"), lim.get("max")))
        anyc = [col(c) for c in (r.get("anyCols") or [])]
        hc = col("head") if hs is not None else None
        cnt = array.array("B", bytes(P))
        clmc = array.array("B", bytes(P))
        ev = {}
        nsat = 0
        for c in range(N):
            if hc is not None and hc[c] not in hs:
                continue
            ok = True
            for a, lo, hi in conds:
                v = a[c]
                if (lo is not None and v < lo) or (hi is not None and v > hi):
                    ok = False
                    break
            if not ok or (anyc and not any(a[c] >= 1 for a in anyc)):
                continue
            nsat += 1
            for k in range(off[c], off[c + 1]):
                e = ent[k]
                if not e & wmask:
                    continue
                p = c2p[e >> 8]
                if p < 0:
                    continue
                if cnt[p] < 255:
                    cnt[p] += 1
                if e & clm_bit and clmc[p] < 255:
                    clmc[p] += 1
                if p not in ev:
                    ev[p] = c
        out[t["id"]] = (cnt, clmc, int(r.get("min") or 1))
        first[t["id"]] = ev
        log("compound rule %-10s: %d satisfying compounds, %d patents" % (t["id"], nsat, sum(1 for p in range(P) if cnt[p] >= int(r.get("min") or 1))))

    def describe(c):
        d = {k: (cols[k][c] if k in cols else col(k)[c]) for k in ("nTails", "nBranched", "tailC", "ester")}
        return "compound #%d head=%s nTails=%d tailC=%d nBranched=%d ester=%d" % (c, heads[col("head")[c]] if heads else "?", d["nTails"], d["tailC"], d["nBranched"], d["ester"])
    return out, (first, describe)


# ---------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--corpus", default=os.path.join(ROOT, "data", "work", "corpus.jsonl.gz"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "work", "xdata", "tags"))
    ap.add_argument("--rules", default=os.path.join(ROOT, "data", "seed", "tag_rules.json"))
    ap.add_argument("--aliases", default=os.path.join(ROOT, "data", "seed", "assignee_aliases.json"))
    ap.add_argument("--chem", default=os.path.join(ROOT, "data", "work", "chem"))
    ap.add_argument("--status", default=os.path.join(ROOT, "data", "work", "status.jsonl.gz"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--no-chem", action="store_true")
    ap.add_argument("--spot-check", type=int, default=30, help="print N random tagged patents with the evidence of each tag")
    ap.add_argument("--per-tag", type=int, default=0, help="also print N evidence snippets per tag (precision tuning)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--evidence-mod", type=int, default=8, help="evidence snippets are kept for every Nth patent")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    with open(a.rules, encoding="utf-8") as f:
        rules = Rules(json.load(f))
    norm = Normalizer.load(a.aliases)
    if not os.path.exists(a.corpus):
        raise SystemExit("corpus not found: %s (run pipeline/normalize.py first)" % a.corpus)
    cj = os.path.join(a.chem, "chem.json")
    use_chem = not a.no_chem and os.path.exists(cj)
    cf = open(a.corpus, "rb")                       # the open handle pins the version (normalize.py replaces the file atomically)
    cst = os.fstat(cf.fileno())
    sig = sha(VERSION, BUILDER, cst.st_size, cst.st_mtime_ns, file_sha(a.rules), file_sha(a.aliases), a.limit, use_chem,
              file_sha(cj) if use_chem else "", file_sha(os.path.join(a.chem, "map.gz.bin")) if use_chem else "",
              os.path.getsize(a.status) if os.path.exists(a.status) else 0, int(os.path.getmtime(a.status)) if os.path.exists(a.status) else 0,
              file_sha(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib", "asg_norm.py")), file_sha(os.path.abspath(__file__)))
    xj = os.path.join(a.out, "xdata.json")
    if not a.force and os.path.exists(xj) and os.path.exists(os.path.join(a.out, "tags.gz.bin")):
        try:
            with open(xj) as f:
                if json.load(f).get("src", {}).get("sig") == sig:
                    log("up to date (inputs unchanged), nothing written; --force rebuilds")
                    return
        except (OSError, ValueError):
            pass

    # ------------------------------------------------------------------ legal bits from the status file
    legal_by_pn = {}
    if os.path.exists(a.status):
        try:
            with gzip.open(a.status, "rt", encoding="utf-8") as f:
                for line in f:
                    try:
                        o = json.loads(line)
                        legal_by_pn[o["pn"]] = legal_byte(rules.legal, o)
                    except (ValueError, KeyError):
                        continue
        except (OSError, EOFError) as e:
            log("status file only partly readable (%s); %d entries" % (e, len(legal_by_pn)))
    log("status: %d publications with legal bits source" % len(legal_by_pn))

    # ------------------------------------------------------------------ corpus pass
    W = rules.W
    tags = rules.tags
    nt = len(tags)
    bits, fromc, legal, pns = [], [], [], []
    first_owner = []            # raw name or None
    ev_mod = max(1, a.evidence_mod)
    evid = {}                   # p -> {tag id: (source, snippet)}
    de_only_hits = 0
    with gzip.open(cf, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            if a.limit and len(pns) >= a.limit:
                break
            r = json.loads(line)
            p = len(pns)
            pns.append(r["pn"])
            cl = r.get("claims") or {}
            ccl = cl.get("en") or []
            cl_lang = "en"
            if not ccl and cl.get("de"):
                ccl, cl_lang = cl["de"], "de"
            claims = ("\n".join(c["t"] for c in ccl)).lower() if ccl else ""
            ti = r.get("title") or {}
            title, t_lang = (ti.get("en"), "en") if ti.get("en") else (ti.get("de"), "de")
            title = (title or "").lower()
            ab = (r.get("abstract") or "").lower()
            ab_lang = "en" if ti.get("en") or not ti.get("de") else "de"
            cpcs = [c.replace(" ", "") for c in (r.get("cpc") or [])]
            srcs = [("claims", claims, cl_lang), ("title", title, t_lang), ("abstract", ab, ab_lang)]
            b = [0] * W
            fc = [0] * W
            keep_ev = p % ev_mod == 0
            for t in tags:
                hit = None
                from_claims = False
                for name, text, lang in srcs:
                    if not text or (t["claims_only"] and name != "claims"):
                        continue
                    m = t["rx_en"].search(text) if t["rx_en"] else None
                    if not m and lang == "de" and t["rx_de"]:
                        m = t["rx_de"].search(text)
                    if m:
                        hit = (name, text, m)
                        from_claims = name == "claims"
                        break
                if hit is None and t["cpc_t"]:
                    for c in cpcs:
                        if c.startswith(t["cpc_t"]):
                            hit = ("cpc", c, None)
                            break
                if hit:
                    b[t["bit"] >> 5] |= 1 << (t["bit"] & 31)
                    if from_claims:
                        fc[t["bit"] >> 5] |= 1 << (t["bit"] & 31)
                    if keep_ev:
                        if hit[2] is None:
                            snip = hit[1]
                        else:
                            s, e = hit[2].span()
                            snip = hit[1][max(0, s - 50):e + 50].replace("\n", " ")
                        evid.setdefault(p, {})[t["id"]] = (hit[0], snip)
            bits.append(b)
            fromc.append(fc)
            st = r["pn"] in legal_by_pn
            legal.append(legal_by_pn[r["pn"]] if st else legal_byte(rules.legal, r.get("status")))
            first_owner.append(norm.first_owner_party(r.get("assignees")))
            if len(pns) % 20000 == 0:
                log("corpus: %d records" % len(pns))
    cf.close()
    P = len(pns)
    log("corpus: %d publications tagged by text and CPC" % P)

    # ------------------------------------------------------------------ compounds
    pn_to_p = {x: i for i, x in enumerate(pns)}
    comp, chem_ev = ({}, None)
    if use_chem:
        comp, chem_ev = compound_hits(rules, a.chem, pn_to_p, P)
    for t in tags:
        if t["id"] in comp:
            cnt, clmc, mn = comp[t["id"]]
            w, m = t["bit"] >> 5, 1 << (t["bit"] & 31)
            for p in range(P):
                if cnt[p] >= mn:
                    bits[p][w] |= m
                if clmc[p] >= mn:
                    fromc[p][w] |= m
                    bits[p][w] |= m
                if cnt[p] >= mn and p % ev_mod == 0 and t["id"] not in evid.get(p, {}):
                    c = chem_ev[0][t["id"]].get(p)
                    evid.setdefault(p, {})[t["id"]] = ("compound", chem_ev[1](c) if c is not None else "")

    # ------------------------------------------------------------------ assignees
    raw_count = {}
    for n_ in first_owner:
        if n_:
            raw_count[n_] = raw_count.get(n_, 0) + 1
    by_key = {}
    for n_, c in raw_count.items():
        by_key.setdefault((norm.key(n_), norm.raw_alias(n_) or ""), []).append((c, n_))      # raw_regex aliases split a key
    display = {}                    # key -> display name
    for k, lst in by_key.items():
        al = norm.alias(k[0]) or k[1]
        if al:
            display[k] = al
            continue
        lst.sort(key=lambda x: (-x[0], x[1]))
        mixed = [x for x in lst if any(ch.islower() for ch in x[1])]
        pick = (mixed or lst)[0][1]
        display[k] = nice(norm.clean(pick))
    name_count = {}
    shown = {}                      # raw string -> display name (raw_regex aliases win over the display of the key)
    for n_, c in raw_count.items():
        d = shown[n_] = display[(norm.key(n_), norm.raw_alias(n_) or "")]
        name_count[d] = name_count.get(d, 0) + c
    asg_names = sorted(name_count, key=lambda d: (-name_count[d], d))
    asg_ix = {d: i for i, d in enumerate(asg_names)}
    asg_id = array.array("I", [0xffffffff] * P)
    for p, n_ in enumerate(first_owner):
        if n_:
            asg_id[p] = asg_ix[shown[n_]]
    log("assignees: %d raw strings -> %d keys -> %d canonical names; %d of %d publications have an owner" %
        (len(raw_count), len(by_key), len(asg_names), sum(1 for x in asg_id if x != 0xffffffff), P))

    # ------------------------------------------------------------------ write
    tag_arr = [array.array("I") for _ in range(W)]
    from_arr = [array.array("I") for _ in range(W)]
    for w in range(W):
        tag_arr[w].extend(bits[p][w] for p in range(P))
        from_arr[w].extend(fromc[p][w] for p in range(P))
    head = {"v": VERSION, "P": P, "W": W,
            "groups": [{"id": g["id"], "label": g["label"]} for g in rules.groups],
            "tags": [{"bit": t["bit"], "group": t["group"], "id": t["id"], "label": t["label"]} for t in tags],
            "legal": [{"bit": l["bit"], "id": l["id"], "label": l["label"]} for l in rules.legal],
            "asg": asg_names}
    hb = json.dumps(head, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body = bytearray(struct.pack("<I", len(hb)) + hb)
    while len(body) % 4:
        body.append(0)
    for arr in tag_arr + from_arr:
        if sys.byteorder != "little":
            arr.byteswap()
        body += arr.tobytes()
    body += bytes(legal)
    while len(body) % 4:
        body.append(0)
    if sys.byteorder != "little":
        asg_id.byteswap()
    body += asg_id.tobytes()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as g:
        g.write(bytes(body))
    data = buf.getvalue()
    per_tag = {}
    for t in tags:
        w, m = t["bit"] >> 5, 1 << (t["bit"] & 31)
        per_tag[t["id"]] = {"n": sum(1 for p in range(P) if bits[p][w] & m), "claims": sum(1 for p in range(P) if fromc[p][w] & m)}
    per_legal = {l["id"]: sum(1 for x in legal if x >> l["bit"] & 1) for l in rules.legal}
    tagged = sum(1 for p in range(P) if any(bits[p]))
    counts = {"patents": P, "tagged": tagged, "perTag": {k: v["n"] for k, v in per_tag.items()}, "perTagClaims": {k: v["claims"] for k, v in per_tag.items()},
              "legal": per_legal, "asgNames": len(asg_names), "withAsg": sum(1 for x in asg_id if x != 0xffffffff), "bytesGzip": len(data), "bytesRaw": len(body),
              "snapshot": datetime.datetime.fromtimestamp(cst.st_mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    os.makedirs(a.out, exist_ok=True)
    tmp = os.path.join(a.out, "tags.gz.bin.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, os.path.join(a.out, "tags.gz.bin"))
    now = datetime.datetime.now(datetime.timezone.utc)
    meta = {"name": "tags", "v": VERSION, "built": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "target": "both", "files": ["tags.gz.bin"], "counts": counts,
            "notes": "Rule-based tags (payload, route, lipid class, use, process), legal bits and canonical assignee per patent index p (row order of corpus.jsonl.gz); "
                     "rules data/seed/tag_rules.json, aliases data/seed/assignee_aliases.json. Text tags come from claims, title, abstract, CPC and the compounds of the claims; a tag is a search aid, not a legal statement.",
            "src": {"sig": sig, "corpus_bytes": cst.st_size, "corpus_mtime": int(cst.st_mtime),
                    "corpus_snapshot": datetime.datetime.fromtimestamp(cst.st_mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "P": P, "limit": a.limit, "rules": file_sha(a.rules), "aliases": file_sha(a.aliases), "chem": bool(comp), "builder": BUILDER}}
    with open(xj + ".tmp", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    os.replace(xj + ".tmp", xj)
    log("wrote %s: %d bytes gzip (%d raw), %d patents, %d tagged" % (os.path.join(a.out, "tags.gz.bin"), len(data), len(body), P, tagged))
    log("per tag (patents / from claims):")
    for g in rules.groups:
        for t in tags:
            if t["group"] == g["id"]:
                log("   %-9s %-12s %7d %7d" % (g["id"], t["id"], per_tag[t["id"]]["n"], per_tag[t["id"]]["claims"]))
    log("legal: " + ", ".join("%s %d" % (k, v) for k, v in per_legal.items()))
    top = [(asg_names[i], name_count[asg_names[i]]) for i in range(min(15, len(asg_names)))]
    log("top assignees: " + "; ".join("%s %d" % x for x in top))

    # ------------------------------------------------------------------ spot check
    label = {t["id"]: t["label"] for t in tags}
    cand = sorted(p for p in evid if evid[p])
    rnd = random.Random(a.seed)
    if a.spot_check and cand:
        log("precision spot check: %d random tagged patents (every %dth patent keeps evidence)" % (min(a.spot_check, len(cand)), ev_mod))
        for p in sorted(rnd.sample(cand, min(a.spot_check, len(cand)))):
            print("%s (p=%d) assignee: %s" % (pns[p], p, asg_names[asg_id[p]] if asg_id[p] != 0xffffffff else "-"))
            for tid, (src, snip) in sorted(evid[p].items()):
                print("    [%s] %-24s <%s> ...%s..." % (src, label[tid], tid, snip[:130]))
    if a.per_tag:
        for t in tags:
            ps = [p for p in cand if t["id"] in evid[p]]
            print("== %s (%s): %d with evidence" % (t["id"], t["label"], len(ps)))
            for p in rnd.sample(ps, min(a.per_tag, len(ps))):
                src, snip = evid[p][t["id"]]
                print("   %s [%s] ...%s..." % (pns[p], src, snip[:130]))


if __name__ == "__main__":
    main()
