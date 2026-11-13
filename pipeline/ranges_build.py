#!/usr/bin/env python3
"""Numeric ranges in claims -> data/work/xdata/ranges/ (format rg-1, docs/TOOLS_PLAN.md 2.4).

  python3 -I pipeline/ranges_build.py [--corpus data/work/corpus.jsonl.gz] [--out data/work/xdata/ranges] [--limit N]
                                      [--max-mb 3] [--force]

Reads the corpus streaming (the file is replaced atomically by normalize.py, so reading it is safe), extracts ranges
with pipeline/lib/ranges_extract.py and the vocabulary data/seed/range_params.json, and writes
  xdata.json      {name, v, built, target, files, counts, notes, ...}
  ranges.gz.bin   gzip JSON {v: "rg-1", params, comps, pn, lang, chain, rows: columnar}
  ranges-q.gz.bin only when ranges.gz.bin with all quotes would exceed --max-mb: all quotes (aligned with rows); the
                  main file then keeps quotes of the rarer parameters and has q = "" for the most numerous ones, whose
                  quote the engine cuts from the claim text at `off`.
rg-1 as written here: {v, params: [{id, label, unit}], comps: [labels], compIds, compAlias {alias: compId}, compFallback [comp
index used only when nothing better], win {lead, max} (quote window: quote = claim text from max(0, off - lead), at most max
characters), pn [], lang [] (claim language per pn), chain {pi: "claim<parents;..."} (dependency graph of the claims of a
publication, so a parent without own ranges still passes its parents' ranges on), rows: columnar {pi, claim, dep, param
(index into params), comp (index into comps | -1), lo, hi (null = open), loInc, hiInc, unit, approx, q, off, ml (match length)}}.
English claims are used; German claims only for a publication without English claims. Safe to re-run: the output is
rewritten only when corpus, vocabulary or extractor changed (--force overrides).
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "lib"))
import ranges_extract as RX  # noqa: E402

T0 = time.time()
EXTRACTOR_V = 2


def log(*a):
    print("[ranges_build %6.1fs]" % (time.time() - T0), *a, flush=True)


def sha(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()[:16]


def dep_str(dep):
    return ",".join(str(int(x)) for x in dep or [] if isinstance(x, int) or str(x).isdigit())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=os.path.join(ROOT, "data/work/corpus.jsonl.gz"))
    ap.add_argument("--vocab", default=os.path.join(ROOT, "data/seed/range_params.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/work/xdata/ranges"))
    ap.add_argument("--limit", type=int, default=0, help="stop after N publications that have claims")
    ap.add_argument("--max-mb", type=float, default=2.25, help="gzip size (MB) of ranges.gz.bin; 2.25 MB = 3.0 MB after base64. Above it quotes move to ranges-q.gz.bin")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    vocab = json.load(open(a.vocab, encoding="utf-8"))
    st = os.stat(a.corpus)
    src = {"corpus_bytes": st.st_size, "corpus_mtime": int(st.st_mtime), "vocab": sha(a.vocab), "extractor": sha(os.path.join(HERE, "lib", "ranges_extract.py")),
           "builder": EXTRACTOR_V, "limit": a.limit, "max_mb": a.max_mb}
    xj = os.path.join(a.out, "xdata.json")
    if not a.force and os.path.exists(xj):
        try:
            old = json.load(open(xj, encoding="utf-8"))
            if old.get("src") == src and all(os.path.exists(os.path.join(a.out, f)) for f in old.get("files", [])):
                log("up to date (%s); use --force to rebuild" % xj)
                return 0
        except Exception:
            pass

    pidx = {p["id"]: i for i, p in enumerate(vocab["params"])}
    cols = {k: [] for k in ("pi", "claim", "dep", "param", "comp", "lo", "hi", "loInc", "hiInc", "unit", "approx", "q", "off", "ml")}
    pns, langs, chain = [], [], {}
    counts = {"records": 0, "with_claims": 0, "claims": 0, "claims_with_rows": 0, "patents_with_rows": 0, "rows": 0, "de_patents": 0}
    per_param = {p["id"]: 0 for p in vocab["params"]}
    per_comp = {}
    n_seen = 0
    with gzip.open(a.corpus, "rt", encoding="utf-8") as f:
        for line in f:
            counts["records"] += 1
            if not line.strip():
                continue
            rec = json.loads(line)
            cl = rec.get("claims") or {}
            lang = "en" if cl.get("en") else ("de" if cl.get("de") else None)
            if not lang:
                continue
            counts["with_claims"] += 1
            n_seen += 1
            claims, seen_n = [], set()
            for c in cl[lang]:          # EP documents with several claim sets repeat the numbers (1..6, 1..6): keep the first set only
                n = int(c.get("n") or 0)
                if n in seen_n:
                    counts["repeated_claim_numbers_skipped"] = counts.get("repeated_claim_numbers_skipped", 0) + 1
                    continue
                seen_n.add(n)
                claims.append(c)
            counts["claims"] += len(claims)
            rows = []
            for c in claims:
                try:
                    found = RX.extract(c.get("t") or "", vocab, lang)
                except Exception as e:  # never let one claim stop the run
                    log("extract failed", rec.get("pn"), c.get("n"), repr(e)[:80])
                    continue
                if found:
                    counts["claims_with_rows"] += 1
                for r in found:
                    rows.append((int(c.get("n") or 0), dep_str(c.get("dep")), r))
            if rows:
                pi = len(pns)
                pns.append(rec["pn"])
                langs.append(lang)
                if lang == "de":
                    counts["de_patents"] += 1
                counts["patents_with_rows"] += 1
                ch = []
                for c in claims:
                    d = dep_str(c.get("dep"))
                    if d:
                        ch.append("%d<%s" % (int(c.get("n") or 0), d))
                if ch:
                    chain[str(pi)] = ";".join(ch)
                rows.sort(key=lambda x: (x[0], x[2]["off"], x[2]["param"]))
                for n, d, r in rows:
                    cols["pi"].append(pi)
                    cols["claim"].append(n)
                    cols["dep"].append(d)
                    cols["param"].append(pidx[r["param"]])
                    cols["comp"].append(r["comp"])
                    cols["lo"].append(r["lo"])
                    cols["hi"].append(r["hi"])
                    cols["loInc"].append(1 if r["loInc"] else 0)
                    cols["hiInc"].append(1 if r["hiInc"] else 0)
                    cols["unit"].append(r["unit"])
                    cols["approx"].append(1 if r["approx"] else 0)
                    cols["q"].append(r["q"])
                    cols["off"].append(r["off"])
                    cols["ml"].append(r["ml"])
                    per_param[r["param"]] += 1
                    cn = vocab["components"][r["comp"]]["id"] if r["comp"] >= 0 else "none"
                    per_comp[cn] = per_comp.get(cn, 0) + 1
                    counts["rows"] += 1
            if n_seen % 100 == 0:
                log("%d publications with claims, %d with rows, %d rows" % (n_seen, counts["patents_with_rows"], counts["rows"]))
            if a.limit and n_seen >= a.limit:
                break

    doc = {"v": "rg-1", "params": [{"id": p["id"], "label": p["label"], "unit": p.get("unit", "")} for p in vocab["params"]],
           "comps": [c["label"] for c in vocab["components"]], "compIds": [c["id"] for c in vocab["components"]],
           "compFallback": [i for i, c in enumerate(vocab["components"]) if c.get("fallback")],
           "compAmbiguous": [i for i, c in enumerate(vocab["components"]) if c.get("ambiguous")],
           "compAlias": dict((al.lower(), c["id"]) for c in vocab["components"] for al in c.get("aliases", [])),
           "win": {"lead": vocab["windows"]["quote_lead"], "max": vocab["windows"]["quote_max"]},
           "pn": pns, "lang": langs, "chain": chain, "rows": cols}

    def pack(obj):
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as g:
            g.write(raw)
        return buf.getvalue(), len(raw)

    blob, raw_n = pack(doc)
    limit = int(a.max_mb * 1000 * 1000)
    files, pages_files, notes = ["ranges.gz.bin"], [], []
    qblob = None
    dropped = []
    if len(blob) > limit:
        # quotes do not fit: keep them for the rarer parameters, drop them (empty string) for the most numerous ones
        # until the main file fits; the engine cuts a dropped quote from the claim text at `off` (LnpRanges.quote).
        quotes = list(cols["q"])
        qblob, _ = pack({"v": "rg-1q", "q": quotes})
        qd = dict((p["id"], p.get("q_drop", 99)) for p in vocab["params"])
        order = sorted(per_param, key=lambda k: (qd[k], -per_param[k]))      # first = quotes dropped first (vocabulary q_drop)
        cols["q"] = ["" for _ in quotes]
        base, _ = pack(doc)                     # main file without any quote
        pid_of = dict((p["id"], i) for i, p in enumerate(vocab["params"]))
        est = {}
        for k in order:
            sel = [q for q, pp in zip(quotes, cols["param"]) if pp == pid_of[k]]
            est[k] = len(pack({"q": sel})[0]) if sel else 0
        keep = list(order)
        tot = len(base) + sum(est.values())
        while keep and tot > limit * 0.985:
            k = keep.pop(0)
            dropped.append(k)
            tot -= est[k]
        while True:
            kset = set(pid_of[k] for k in keep)
            cols["q"] = [q if pp in kset else "" for q, pp in zip(quotes, cols["param"])]
            blob, raw_n = pack(doc)
            if len(blob) <= limit or not keep:
                break
            dropped.append(keep.pop(0))
        notes.append("Quotes of %s are not in the main file (empty q): the engine cuts them from the claim text at off (LnpRanges.quote). "
                     "ranges-q.gz.bin (%d bytes gzip, all quotes aligned with the rows) is for target pages only; the xdata hook copies it only to the website build (files_pages)."
                     % (", ".join(dropped) or "no parameter", len(qblob)))
        pages_files.append("ranges-q.gz.bin")
        log("base (no quotes) %d bytes; with all quotes the file would be larger than %d bytes: quotes dropped for %s; main file %d bytes, ranges-q.gz.bin %d bytes" % (len(base), limit, dropped, len(blob), len(qblob)))
    os.makedirs(a.out, exist_ok=True)

    def write(name, data):
        tmp = os.path.join(a.out, name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(a.out, name))

    write("ranges.gz.bin", blob)
    if qblob is not None:
        write("ranges-q.gz.bin", qblob)
    else:
        p = os.path.join(a.out, "ranges-q.gz.bin")
        if os.path.exists(p):
            os.remove(p)
    meta = {"name": "ranges", "v": "rg-1", "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "target": "both",
            "files": files, "files_pages": pages_files,
            "counts": dict(counts, perParam=per_param, perComp=per_comp, bytesGzip=len(blob), bytesRaw=raw_n, bytesQuotes=len(qblob) if qblob else 0, quotesInMain=qblob is None, quotesDroppedFor=dropped),
            "notes": " ".join(["Numeric ranges found by pattern rules in claim text (EN, DE only without EN); vocabulary data/seed/range_params.json."] + notes),
            "src": src}
    with open(xj, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log("done: %d publications with claims, %d with rows, %d claims with rows of %d, %d rows (counts are written to xdata.json)" % (counts["with_claims"], counts["patents_with_rows"], counts["claims_with_rows"], counts["claims"], counts["rows"]))
    for k, v in sorted(per_param.items(), key=lambda kv: -kv[1]):
        log("  %-12s %7d" % (k, v))
    log("components:", json.dumps(per_comp, sort_keys=True))
    log("ranges.gz.bin %.2f MB gzip (%.1f MB raw)%s" % (len(blob) / 1e6, raw_n / 1e6, "; ranges-q.gz.bin %.2f MB" % (len(qblob) / 1e6) if qblob else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
