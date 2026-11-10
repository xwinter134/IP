"""Per-document parsing for pipeline/normalize.py: raw cache file -> compact, JSON-able dict.

  parse_ep_file(path) -> dict     (EPO publication-server XML)
  parse_us_file(path) -> dict     (ppubs full-text JSON, .json or .json.gz)

Result keys: v, pn, auth, kind, text_src, title{en,de}, assignees[], app_number, app_date, pub_date,
grant_date, priority_date, cpc[], claims{en:[{n,t,dep,img?}],de:[..]}, abstract, defs[], pct_wo,
lang, n_claims_raw, desc_chars.
"""
from __future__ import annotations

import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import epo_pubserver as epo   # noqa: E402
import us_parse as usp        # noqa: E402
import norm_text as nt        # noqa: E402

PARSER_VERSION = 8
_CANCELED = re.compile(r"^\W*\(?\s*(?:canceled|cancelled|deleted|withdrawn and canceled|canceled without prejudice)\s*\)?\W*$", re.I)


def _iso8(s):
    """'20011031' -> '2001-10-31' (already-ISO input passes through)."""
    if not s:
        return None
    s = str(s).strip()
    if re.fullmatch(r"\d{8}", s):
        return "%s-%s-%s" % (s[:4], s[4:6], s[6:8])
    return s[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", s) else None


def _wo_from_pct(num):
    """'WO2002036257' / 'WO2022/221359' / 'WO 02/36257' -> 'WO2002036257' (no kind) or None."""
    if not num:
        return None
    t = re.sub(r"[\s/.\-]", "", str(num).upper())
    m = re.fullmatch(r"WO(\d{4})(\d{6})", t)
    if m:
        return "WO" + m.group(1) + m.group(2)
    m = re.fullmatch(r"WO(\d{2})(\d{6})", t)           # WO02036257 -> WO2002036257 (pre-2004 short form)
    if m:
        yy = int(m.group(1))
        return "WO%s%s%s" % ("19" if yy >= 78 else "20", m.group(1), m.group(2))
    m = re.fullmatch(r"WO(\d{4})(\d{1,5})", t)
    if m:
        return "WO%s%06d" % (m.group(1), int(m.group(2)))
    return None


def _claim_list(raw_claims, auth, deps_key):
    out = []
    for c in raw_claims:
        text, imgs = nt.clean_claim(c["text"] if auth == "EP" else c["t"], auth)
        if auth == "US":
            text = nt.fix_us_line_numbers(text)
        n = c["num"] if auth == "EP" else c["n"]
        dep = list(c.get(deps_key) or [])
        if not dep and n > 1 and "claim" in text.lower():
            dep = nt.loose_deps(text, int(n))
        item = {"n": int(n), "t": text, "dep": dep}
        if imgs:
            item["img"] = imgs
        out.append(item)
    return out


def parse_ep_file(path: str) -> dict:
    with open(path, "rb") as f:
        raw = f.read()
    d = epo.parse_document(raw.decode("utf-8", "replace"))
    claims = {}
    for lang in ("en", "de"):
        src = d["claims"].get(lang) or []
        if src:
            # the three language versions are translations of one another: prefer the cross-language consensus
            key = "depends_on_consensus" if src and "depends_on_consensus" in src[0] else "depends_on"
            claims[lang] = _claim_list(src, "EP", key)
    # an A document with claims in French only keeps nothing (French is dropped by design)
    kind = d["kind"] or ""
    if kind.startswith("B"):
        parties = d["proprietors"] or d["applicants"]
    else:
        parties = d["applicants"] or d["proprietors"]
    prios = [_iso8(p["date"]) for p in d["priorities"] if p.get("date")]
    prios = [p for p in prios if p]
    cpc = []
    for c in d["cpc"]:
        s = c["symbol"]
        if s and s not in cpc:
            cpc.append(s)
    if not cpc:
        for c in d["ipc"]:
            s = c["symbol"]
            if s and s not in cpc:
                cpc.append(s)
    desc = d["description_text"] or ""
    pub = _iso8(d["pub_date"])
    title = {k: v for k, v in d["title"].items() if k in ("en", "de") and v}
    return {
        "v": PARSER_VERSION, "pn": d["pn"], "auth": "EP", "kind": kind, "text_src": "epo-xml",
        "title": title,
        "assignees": [p["name"] for p in parties if p.get("name")],
        "app_number": d["app_number"], "app_date": _iso8(d["app_date"]), "pub_date": pub,
        "grant_date": _iso8(d["grant_date"]) or (pub if kind.startswith("B") else None),
        "priority_date": min(prios) if prios else _iso8(d["app_date"]),
        "cpc": cpc, "claims": claims,
        "abstract": d["abstract"] or None,
        "defs": nt.select_defs(desc),
        "pct_wo": _wo_from_pct(d["pct"].get("pub_number")),
        "lang": d["lang"], "n_claims_raw": {k: len(v) for k, v in d["claims"].items() if v},
        "desc_chars": len(desc),
    }


def parse_us_file(path: str) -> dict:
    d = usp.load(path)
    ch = d.get("claimsHtml")
    if isinstance(ch, str) and "<b>" in ch:
        # newer layouts "<b>1</b>. A ..." / "<b>1</b>: A ..." / "<b>4</b>.-<b>15</b>. (canceled)": rewrite to "1. A ..." / "4-15. (canceled)"
        ch = re.sub(r"<b>\s*(\d{1,3})\s*</b>\s*\.?\s*[-\u2013]\s*<b>\s*(\d{1,3})\s*</b>\s*[.:]", r"\n\1-\2. ", ch)
        ch = re.sub(r"<b>\s*(\d{1,3})\s*</b>\s*[.:]", r"\n\1. ", ch)
        d = dict(d)
        d["claimsHtml"] = ch
    r = usp.parse_us(d)
    n_cancel = 0
    kept = []
    for c in r["claims"]:
        if _CANCELED.match(c["t"] or ""):
            n_cancel += 1
        else:
            kept.append(c)
    r["claims"] = kept
    claims = {}
    if r["claims"]:
        claims["en"] = _claim_list(r["claims"], "US", "dep")
    pct = d.get("pctPubNumber")
    if isinstance(pct, (list, tuple)):
        pct = pct[0] if pct else None
    kind = r["kind"] or ""
    pub = r["pub_date"]
    desc = r["description_text"] or ""
    return {
        "v": PARSER_VERSION, "pn": r["pn"], "auth": "US", "kind": kind, "text_src": "ppubs",
        "title": {"en": r["title"]} if r["title"] else {},
        "assignees": [a for a in r["assignees"] if a],
        "app_number": r["app_number"], "app_date": r["app_date"], "pub_date": pub,
        "grant_date": pub if kind.startswith("B") or kind.startswith("E") else None,
        "priority_date": r["priority_date"],
        "cpc": [c.replace(" ", "") for c in r["cpc"]], "claims": claims,
        "abstract": r["abstract"] or None,
        "defs": nt.select_defs(desc),
        "pct_wo": _wo_from_pct(pct),
        "lang": "en", "n_claims_raw": {"en": len(r["claims"])} if r["claims"] else {},
        "n_claims_declared": r["n_claims_declared"], "n_canceled": n_cancel,
        "desc_chars": len(desc),
    }
