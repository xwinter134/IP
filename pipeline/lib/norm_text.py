"""Text helpers for pipeline/normalize.py (stage 2). Stdlib only.

  clean_claim(text, auth)            -> (text, [chem image ids])   markup/whitespace/placeholder cleanup
  fix_us_line_numbers(text)          -> text                      removes old-US margin line numbers (conservative)
  select_defs(description, cap)      -> [paragraph, ...]          definition paragraphs, <= cap characters in total
  clean_assignees(names)             -> [name, ...]               de-duplicated, country codes / banks / agents dropped
  PlayerMatcher(variants_json)       .match(names) -> player | None
"""
from __future__ import annotations

import html
import re
import unicodedata

# --------------------------------------------------------------------------- claims
_PLACE = re.compile(r"\[([A-Za-z]+):([^\]\s]*)\]")
_TAGS = re.compile(r"</?(?:b|i|u|sub|sup|br|p|span|div|ul|ol|li|o|claim-text|claim-ref|img|a|font|tt|smallcaps|sc)\b[^>]*>", re.I)
_SPACES = re.compile(r"[\s   -​    　﻿]+")
_IMG_EXT = re.compile(r"\.(?:tif|tiff|png|jpg|jpeg|gif)$", re.I)


def clean_claim(text: str, auth: str):
    """Plain claim text. Formula images -> [chem] (EP; ids returned) or [STR] (US ##STR## placeholders);
    other placeholders keep their kind ([eq], [tbl], [maths] ...)."""
    imgs: list = []

    def rep(m):
        kind, ident = m.group(1).lower(), m.group(2)
        if kind == "chem":
            if auth == "US":
                return "[STR]"
            ident = _IMG_EXT.sub("", ident)
            if ident and ident not in imgs:
                imgs.append(ident)
            return "[chem]"
        return "[%s]" % kind

    t = text or ""
    if "<" in t:
        t = _TAGS.sub(" ", t)
    if "&" in t:
        t = html.unescape(t)
    t = _PLACE.sub(rep, t)
    t = unicodedata.normalize("NFC", t)
    t = _SPACES.sub(" ", t).strip()
    t = re.sub(r"(\[chem\]|\[STR\])(?:\s*\1)+", r"\1", t)         # repeated placeholders collapse to one
    return t, imgs


_LOOSE_REF = re.compile(r"\bclaims?\b[\s.,:]*(?:of|from|nos?\.?)?\s*(\d{1,3})(?:\s*(?:to|-|\u2013|through)\s*(\d{1,3}))?", re.I)
_LOOSE_PREC = re.compile(r"\b(?:any|each|one)\s+(?:one\s+)?(?:of\s+the\s+)?(?:preceding|previous|foregoing)\s+claims?\b", re.I)


def loose_deps(text: str, n: int):
    """Fallback for source typos the strict parsers miss ('according to claim. 4', 'claim of 1',
    'claims from 1 to 5', 'as claimed in any preceding claim'). Only the first 400 characters are read."""
    head = text[:400]
    deps = set()
    for a, b in _LOOSE_REF.findall(head):
        lo = int(a)
        hi = int(b) if b else lo
        if lo <= hi and hi - lo < 200:
            deps.update(range(lo, hi + 1))
    if not deps and _LOOSE_PREC.search(head):
        deps.update(range(1, n))
    return sorted(d for d in deps if 0 < d < n)


_LINENO = re.compile(r"(?<=[a-z,;:\)]) (\d{1,2}) (?=[A-Za-z\(\[])")


def fix_us_line_numbers(text: str) -> str:
    """Old US OCR text carries column line numbers (5, 10, 15 ...) in the middle of sentences.
    Removed only when unambiguous: at least three such numbers, each a multiple of 5, in strictly
    increasing consecutive order starting at 5 (or 10), each between lower-case words."""
    if len(text) < 80 or " 5 " not in text and " 10 " not in text:
        return text
    hits = [m for m in _LINENO.finditer(text) if int(m.group(1)) % 5 == 0]
    if len(hits) < 3:
        return text
    seq = [int(m.group(1)) for m in hits]
    start = seq[0]
    if start not in (5, 10) or any(b - a != 5 for a, b in zip(seq, seq[1:])):
        return text
    out, last = [], 0
    for m in hits:
        out.append(text[last:m.start()])
        out.append(" ")
        last = m.end()
    out.append(text[last:])
    return "".join(out)


# --------------------------------------------------------------------------- definitions
_DEF = re.compile(                      # tier A: the paragraph itself defines a term
    r"as used herein|as used in this|used herein|the terms? [\"'\u201c\u2018\u00ab(]?\w|terms? .{0,40}\bmeans?\b|"
    r"\brefers? to\b|\brefer to\b|\bis defined\b|\bare defined\b|\bdefined as\b|\bdefinitions?\b|\bis understood\b|"
    r"\bunless otherwise\b|im sinne der|im sinne des|\bbezeichnet\b|\bbezeichnen\b|\bbedeutet\b|\bversteht man\b|"
    r"\bverstanden\b", re.I)
_TECH = re.compile(                     # tier B: claim vocabulary of the field
    r"\bpka\b|\bmol ?%|molar ratio|molverh|based on the total lipid|\bn/p\b|cationic lipid|ionizable|ionisable|"
    r"kationisch\w* lipid|ionisierbar", re.I)
_WEAK = re.compile(r"\bmeans\b|\balkyl\b", re.I)
_PARNUM = re.compile(r"^\s*(?:\(\d{1,5}\)|\[\d{1,5}\])\s*")


def _trim(p: str, limit: int) -> str:
    if len(p) <= limit:
        return p
    cut = p.rfind(". ", 0, limit)
    if cut < limit // 2:
        cut = p.rfind(" ", 0, limit)
        return p[:cut].rstrip(",;: ") + " ..."
    return p[:cut + 1]


def select_defs(description: str, cap: int = 8000, max_para: int = 1500, min_para: int = 40):
    """Definition paragraphs of a description (paragraphs = lines; leading paragraph numbers '(31)' / '[0031]'
    removed). A candidate must look like prose (letters >= 55% of characters) and contain a trigger phrase.
    Tier A = defining phrases ('as used herein', 'the term', 'refers to', 'is defined', 'im Sinne der',
    'bezeichnet' ...), tier B = field vocabulary ('pKa', 'mol %', 'molar ratio', 'N/P', 'cationic lipid',
    'ionizable'), tier C = weak words ('means', 'alkyl', short paragraphs only). Tiers are taken in that order,
    shortest first inside a tier, until `cap` characters are reached; paragraphs longer than `max_para` are cut
    at a sentence end. The selection is returned in document order."""
    if not description:
        return []
    tiers = ([], [], [])
    seen = set()
    for i, p in enumerate(description.split("\n")):
        p = _PARNUM.sub("", p).strip()
        n = len(p)
        if n < min_para or n > 6000:
            continue
        if _DEF.search(p):
            t = 0
        elif _TECH.search(p):
            t = 1
        elif n <= 600 and _WEAK.search(p):
            t = 2
        else:
            continue
        letters = sum(c.isalpha() for c in p)
        if letters < 0.55 * n:
            continue
        key = p[:120].lower()
        if key in seen:
            continue
        seen.add(key)
        tiers[t].append((min(n, max_para), i, p))
    chosen, total = [], 0
    for group in tiers:
        for ln, i, p in sorted(group):
            if total + ln > cap:
                continue          # a shorter one may still fit
            chosen.append((i, _trim(p, max_para)))
            total += ln
    chosen.sort()
    return [p for _, p in chosen]


# --------------------------------------------------------------------------- assignees
_COUNTRY_TAIL = re.compile(r"\s*[,;(]\s*\(?([A-Z]{2})\)?\s*$")
_CC = set("AT AU BE BR CA CH CN CZ DE DK ES FI FR GB HK IE IL IN IT JP KR LU MX NL NO NZ PL PT RU SE SG TW US ZA IS HU SI".split())
_NOT_ASSIGNEE = re.compile(
    r"\bbank\b|\bbanque\b|\bas (?:collateral |security |administrative |notes )?(?:agent|trustee)\b|\bcollateral agent\b|"
    r"\bsecurity agent\b|\btrustee\b|\bcapital corp|\bpatentanw\w*|\brechtsanw\w*|\blaw (?:firm|offices?|group)\b|"
    r"\battorneys?\b|\bpatent attorney|\brepresentative\b|\bc/o\b.*\b(?:llp|law)\b", re.I)
_SUFFIX = re.compile(r"\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|lp|llp|gmbh|ag|sa|sas|s a|bv|nv|ab|as|a s|plc|kg|"
                     r"kk|oy|spa|srl|the|of|und|and|&|pharmaceuticals?|therapeutics|usa|us)\b", re.I)


def _strip_country(n: str) -> str:
    for _ in range(2):
        m = _COUNTRY_TAIL.search(n)
        if m and m.group(1) in _CC and len(n) > 6:
            n = n[:m.start()].rstrip(" ,;")
        else:
            break
    return n


def _name_key(n: str) -> str:
    k = _SUFFIX.sub(" ", n.casefold())
    return re.sub(r"[^0-9a-zа-яÀ-ɏ]+", "", k)


def clean_assignees(names, extra_noise=()):
    """Cleaned, de-duplicated assignee list: country-code tails removed, spelling variants of one
    organisation merged (mixed-case spelling preferred over ALL CAPS), banks / security agents / law
    firms dropped unless nothing else is left."""
    noise = {_name_key(x) for x in extra_noise if x}
    best: dict = {}
    order: list = []
    dropped: list = []
    for raw in names or []:
        if not raw:
            continue
        n = _SPACES.sub(" ", str(raw)).strip(" ,;")
        n = _strip_country(n)
        if not n:
            continue
        k = _name_key(n)
        if not k:
            continue
        if _NOT_ASSIGNEE.search(n) or k in noise:
            dropped.append(n)
            continue
        if k not in best:
            best[k] = n
            order.append(k)
        else:
            cur = best[k]
            if cur.isupper() and not n.isupper():
                best[k] = n
    out = [best[k] for k in order]
    if not out and dropped:
        seen, out = set(), []
        for n in dropped:
            if _name_key(n) not in seen:
                seen.add(_name_key(n))
                out.append(n)
    return out


class PlayerMatcher:
    def __init__(self, variants):
        self.items = []
        for v in variants:
            rx = v.get("match_regex_case_insensitive")
            if not rx or v.get("player", "").startswith("_"):
                continue
            # seed regex 'tron\\b' (TRON gGmbH) also hits Vectron, Cenetron, BioElectron: anchor it at a word start
            rx = rx.replace("tron\\b", "(?<![a-z])tron\\b").replace("|tron -", "|(?<![a-z])tron -")
            self.items.append((v["player"], re.compile(rx, re.I)))
        self.noise = []
        for v in variants:
            if v.get("player", "").startswith("_"):
                self.noise += [x for x in v.get("variants_observed_on_fetched_pages", []) if _NOT_ASSIGNEE.search(x)]

    def match(self, names):
        blob = " | ".join(n for n in names or [] if n)
        if not blob:
            return None
        for player, rx in self.items:
            if rx.search(blob):
                return player
        return None
