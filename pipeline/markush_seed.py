#!/usr/bin/env python3
"""Curated Markush records -> xdata "markush" (docs/TOOLS_PLAN.md 2.2 and 2.3, docs/MARKUSH.md).

Reads data/seed/markush/*.json (hand-written records of format mk-1, origin "curated", reviewed true), checks their
shape with the standard library only, verifies every definition quote verbatim (whitespace-normalised) against the
claim text stored in the record, and writes

    data/work/xdata/markush/curated.json   array of records (quoteStatus and source.textHash filled in)
    data/work/xdata/markush/xdata.json     {name, v, built, target, files, counts, notes}

The chemistry (SMILES parsing, core matching) is checked by tests/markush_test.cjs with OpenChemLib; this script
only checks what Python can check without a chemistry toolkit: keys, kinds, ranges, attachment map numbers and
quotes. With --corpus the stored claim text is compared with data/work/corpus.jsonl.gz as well.

usage: python3 -I pipeline/markush_seed.py [--seed-dir DIR] [--out DIR] [--corpus [FILE]] [--quiet]
Exit code 1 when a record has errors (nothing is written then).
"""
import argparse
import datetime
import glob
import gzip
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALT_TYPES = {"H", "halogen", "alkyl", "alkenyl", "alkynyl", "acyl", "alkoxy", "cycloalkyl", "aryl", "heteroaryl",
             "heterocyclyl", "smiles", "smarts", "any"}
KINDS = {"substituent", "divalent", "repeat"}
MAP_RE = re.compile(r"\[\*:(\d+)\]")
UNMAPPED_RE = re.compile(r"\[\*\]|\*(?!:)")


def norm_ws(s):
    s = re.sub("[\u200b\u200c\u200d\ufeff\u00ad]", "", s or "")
    return re.sub(r"\s+", " ", s).strip()


def fnv_hash(s):
    """FNV-1a over UTF-16 code units, as hash() in web/engine/x-markush.js"""
    h = 0x811c9dc5
    data = (s or "").encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xffffffff
    return "%08x" % h


def unmapped_count(smiles):
    # dummies without map number: "*" outside brackets or "[*]"
    s = MAP_RE.sub("", smiles or "")
    return len(UNMAPPED_RE.findall(s))


def check_record(rec, name):
    errs = []

    def err(msg):
        errs.append("%s: %s" % (name, msg))

    if not isinstance(rec, dict):
        return ["%s: not an object" % name]
    if rec.get("v") != "mk-1":
        err('v must be "mk-1"')
    for k in ("pn", "claim", "core", "vars", "source"):
        if k not in rec:
            err("missing key " + k)
    if rec.get("origin") != "curated":
        err('origin must be "curated"')
    if rec.get("reviewed") is not True:
        err("reviewed must be true")
    src = rec.get("source") or {}
    text = src.get("claimText") or ""
    if not text:
        err("source.claimText is empty")
    core = (rec.get("core") or {}).get("smiles") or ""
    if not core:
        err("core.smiles is empty")
    if unmapped_count(core):
        err("core has attachment points without a map number")
    present = {}

    def collect(smiles, where):
        for n in MAP_RE.findall(smiles or ""):
            n = int(n)
            if n in present and present[n] == where and where != "unit":
                err("[*:%d] occurs twice in %s" % (n, where))
            present.setdefault(n, where)

    collect(core, "core")
    referenced = {}
    names = set()
    for i, v in enumerate(rec.get("vars") or []):
        label = "vars[%d] %s" % (i, v.get("name"))
        if not v.get("name"):
            err(label + ": name missing")
        if v.get("name") in names:
            err(label + ": duplicate name")
        names.add(v.get("name"))
        if v.get("kind") not in KINDS:
            err(label + ": unknown kind %r" % v.get("kind"))
        att = v.get("attach")
        if not isinstance(att, list) or not att or not all(isinstance(a, int) and a > 0 for a in att):
            err(label + ": attach must be a list of positive integers")
            att = []
        for a in att:
            if a in referenced:
                err(label + ": [*:%d] is also referenced by %s" % (a, referenced[a]))
            referenced[a] = v.get("name")
        if not str(v.get("quote") or "").strip():
            err(label + ": quote missing")
        elif norm_ws(v["quote"]) not in norm_ws(text):
            err(label + ": quote not found verbatim in the claim text")
        for j, a in enumerate(v.get("alts") or []):
            al = "%s alts[%d]" % (label, j)
            if not isinstance(a, dict) or a.get("type") not in ALT_TYPES:
                err(al + ": unknown type %r" % (a.get("type") if isinstance(a, dict) else a))
                continue
            for k in ("cMin", "cMax", "dblMin", "dblMax", "tripleMax"):
                if a.get(k) is not None and (not isinstance(a[k], int) or a[k] < 0):
                    err(al + ": %s must be a non-negative integer" % k)
            if isinstance(a.get("cMin"), int) and isinstance(a.get("cMax"), int) and a["cMin"] > a["cMax"]:
                err(al + ": cMin > cMax")
            if a["type"] == "smiles":
                if not a.get("smiles"):
                    err(al + ": smiles missing")
                else:
                    collect(a["smiles"], label + " alt %d" % j)
                    ends = unmapped_count(a["smiles"])
                    if v.get("kind") == "substituent" and ends != 1:
                        err(al + ": a substituent SMILES needs exactly one '*'")
                    if v.get("kind") == "divalent" and ends not in (1, 2):
                        err(al + ": a divalent SMILES needs one or two '*'")
            if a["type"] == "smarts" and not a.get("smarts"):
                err(al + ": smarts missing")
        if v.get("kind") == "repeat":
            r = v.get("range") or {}
            if not isinstance(r.get("min"), int) or not isinstance(r.get("max"), int) or not 0 <= r["min"] <= r["max"] <= 400:
                err(label + ": repeat range must be integers 0 <= min <= max <= 400")
            if not v.get("unit"):
                err(label + ": repeat unit missing")
            else:
                collect(v["unit"], "unit")
                if unmapped_count(v["unit"]) not in (0, 2):
                    err(label + ": unit needs two '*' or none")
        elif not v.get("alts"):
            err(label + ": no alternatives")
    for n in present:
        if n not in referenced:
            err("[*:%d] is not referenced by any variable" % n)
    for n, vn in referenced.items():
        if n not in present:
            err("variable %s refers to [*:%d], which occurs nowhere" % (vn, n))
    for i, p in enumerate(rec.get("provisos") or []):
        if p.get("effect", "exclude") != "exclude":
            err("provisos[%d]: effect must be exclude" % i)
        if not str(p.get("quote") or "").strip() or norm_ws(p["quote"]) not in norm_ws(text):
            err("provisos[%d]: quote missing or not found verbatim" % i)
        for w in p.get("when") or []:
            if w.get("var") not in names:
                err("provisos[%d]: when refers to unknown variable %r" % (i, w.get("var")))
        if not (p.get("smiles") or p.get("smarts") or p.get("when")):
            err("provisos[%d]: needs smiles, smarts or when" % i)
    for i, u in enumerate(rec.get("unsupported") or []):
        if not (isinstance(u, str) or (isinstance(u, dict) and u.get("text"))):
            err("unsupported[%d]: must be a string or {text, vars, effect}" % i)
    ref = rec.get("ref")
    if not (isinstance(ref, dict) and ref.get("smiles")):
        err("ref.smiles (reference compound for the tests) missing")
    return errs


def corpus_texts(path, keys):
    out = {}
    pns = {k[0] for k in keys}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            head = line[:80]
            if not any(p in head for p in pns):
                continue
            d = json.loads(line)
            if d.get("pn") in pns:
                for c in ((d.get("claims") or {}).get("en") or []) + ((d.get("claims") or {}).get("de") or []):
                    out.setdefault((d["pn"], c.get("n")), c.get("t") or "")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed-dir", default=os.path.join(ROOT, "data", "seed", "markush"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "work", "xdata", "markush"))
    ap.add_argument("--corpus", nargs="?", const=os.path.join(ROOT, "data", "work", "corpus.jsonl.gz"), default=None,
                    help="also compare the stored claim text with the corpus (slow: reads the whole file)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    files = sorted(glob.glob(os.path.join(a.seed_dir, "*.json")))
    recs, errs = [], []
    for fn in files:
        name = os.path.basename(fn)
        try:
            with open(fn, encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError) as e:
            errs.append("%s: cannot read: %s" % (name, e))
            continue
        e = check_record(rec, name)
        expect = "%s-c%s.json" % (rec.get("pn"), rec.get("claim"))
        if name != expect:
            e.append("%s: file name should be %s" % (name, expect))
        errs.extend(e)
        recs.append(rec)
    if a.corpus and recs:
        texts = corpus_texts(a.corpus, [(r["pn"], r["claim"]) for r in recs])
        for r in recs:
            t = texts.get((r["pn"], r["claim"]))
            if t is None:
                errs.append("%s claim %s: not in the corpus" % (r["pn"], r["claim"]))
            elif norm_ws(t[:4000]) != norm_ws(r["source"]["claimText"]):
                errs.append("%s claim %s: stored claim text differs from the corpus" % (r["pn"], r["claim"]))
    if errs:
        for e in errs:
            print("ERROR " + e, file=sys.stderr)
        return 1
    for r in recs:
        r["source"]["textHash"] = fnv_hash(r["source"]["claimText"])
        for v in r["vars"]:
            v["quoteStatus"] = "ok"
        for p in r.get("provisos") or []:
            p["quoteStatus"] = "ok"
        r.setdefault("provisos", [])
        r.setdefault("unsupported", [])
    os.makedirs(a.out, exist_ok=True)
    body = json.dumps(recs, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
    with open(os.path.join(a.out, "curated.json"), "w", encoding="ascii") as f:
        f.write(body)
    meta = {
        "name": "markush", "v": 1,
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target": "both", "files": ["curated.json"],
        "counts": {"records": len(recs), "patents": len({r["pn"] for r in recs}), "vars": sum(len(r["vars"]) for r in recs),
                   "bytes": len(body)},
        "notes": "hand-curated Markush records (mk-1, origin curated, reviewed); quotes verified verbatim against the stored claim text",
    }
    with open(os.path.join(a.out, "xdata.json"), "w", encoding="ascii") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    if not a.quiet:
        print("markush xdata: %d records, %d bytes -> %s" % (len(recs), len(body), a.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
