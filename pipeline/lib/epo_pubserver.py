#!/usr/bin/env python3
"""
epo_pubserver.py - key-free access to the EPO European Publication Server
(https://data.epo.org/publication-server) + parser for ep-patent-document XML.

Stdlib only (urllib + xml.etree).  All endpoints below were verified 2026-11.

  fetch_document(pn_with_kind, cache_dir)  -> raw XML (str), cached on disk
  list_kinds(ep_number)                    -> [{kind, date, correction_code, id, ...}]
  search_publications(ipc=..., kinds=...)  -> list of publication records (IPC/number search)
  parse_document(xml)                      -> dict (see README in function docstring)

Downloaded XML is untrusted data: it is parsed with expat with no DTD / entity
loading and never executed.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

BASE = "https://data.epo.org/publication-server"
REST = BASE + "/rest/v1.2"
UA = "Mozilla/5.0"
MIN_INTERVAL = 1.1  # seconds between requests to the host
ALL_KINDS = ["A1", "A2", "A3", "A8", "A9", "B1", "B2", "B3", "B8", "B9"]

_last_request = [0.0]
last_headers: dict = {}


class NotFound(Exception):
    pass


class Throttled(Exception):
    pass


def _http(url: str, data: bytes | None = None, headers: dict | None = None,
          timeout: int = 90, retries: int = 3) -> bytes:
    """Polite HTTP(S) request honouring HTTPS_PROXY from the environment."""
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    for attempt in range(retries):
        wait = MIN_INTERVAL - (time.time() - _last_request[0])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                _last_request[0] = time.time()
                last_headers.clear()
                last_headers.update({k.lower(): v for k, v in r.headers.items()})
                return body
        except urllib.error.HTTPError as e:
            _last_request[0] = time.time()
            body = e.read()[:300]
            # The server answers 500 {"code":9000,...} for a non-existing
            # publication id (not 404).  400 = malformed query.
            if e.code in (404, 500) and b'"code":9000' in body or e.code == 404:
                raise NotFound(url)
            if e.code in (403, 429):
                raise Throttled("%s -> HTTP %s (stop, do not hammer)" % (url, e.code))
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            _last_request[0] = time.time()
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("unreachable")


# --------------------------------------------------------------------------
# identifiers
# --------------------------------------------------------------------------
def normalize_id(pn_with_kind: str, correction_code: str | None = None) -> str:
    """'EP3532103B1' | 'EP 3 532 103 B1' | '3532103B1' | 'EP3532103NWB1' -> 'EP3532103NWB1'.

    Publication-server ids are EP + 7-digit number (zero padded) + correction
    code ('NW' normal, 'W1','W2'.. for corrected B8/B9/A8/A9 issues) + kind.
    B8/B9/A8/A9 default to 'W1' (first correction), everything else to 'NW'.
    """
    s = re.sub(r"[\s./,-]", "", pn_with_kind.upper())
    m = re.match(r"^(?:EP)?(\d{1,7})(NW|W\d)?([AB]\d)$", s)
    if not m:
        raise ValueError("cannot parse publication id %r (need number + kind code)" % pn_with_kind)
    num, cc, kind = m.groups()
    if correction_code:
        cc = correction_code
    if not cc:
        cc = "W1" if kind[1] in "89" else "NW"
    return "EP%07d%s%s" % (int(num), cc, kind)


def _num_only(ep_number: str) -> str:
    m = re.match(r"^(?:EP)?0*(\d{1,7})", re.sub(r"[\s./,-]", "", str(ep_number).upper()))
    if not m:
        raise ValueError("bad EP number %r" % ep_number)
    return "%07d" % int(m.group(1))


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------
def fetch_document(pn_with_kind: str, cache_dir: str | None = None, fmt: str = "xml",
                   refresh: bool = False):
    """Fetch one publication.  fmt 'xml' -> str ; 'html' -> str ; 'pdf'/'zip' -> bytes.

    Cached as <cache_dir>/<ID>.<fmt>.  Raises NotFound when that number/kind does
    not exist (server replies HTTP 500 code 9000).
    """
    doc_id = normalize_id(pn_with_kind)
    path = os.path.join(cache_dir, "%s.%s" % (doc_id, fmt)) if cache_dir else None
    if path and os.path.exists(path) and not refresh and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            raw = f.read()
    else:
        raw = _http("%s/patents/%s/document.%s" % (REST, doc_id, fmt))
        if fmt == "xml" and b"<ep-patent-document" not in raw[:2000]:
            raise NotFound("%s: unexpected payload %r" % (doc_id, raw[:120]))
        if path:
            os.makedirs(cache_dir, exist_ok=True)
            tmp = path + ".part"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, path)
    return raw.decode("utf-8") if fmt in ("xml", "html") else raw


def search_publications(publication_number: str | None = None,
                        application_number: str | None = None,
                        ipc: str | None = None,
                        kinds: list | None = None,
                        year_start: int = 1978, week_start: int = 51,
                        year_end: int | None = None, week_end: int = 53,
                        page_size: int = 2000, max_pages: int = 200) -> list:
    """POST {BASE}/publications?page=N&size=M  (the JSON backend of the search UI).

    ipc: IPC symbol without blanks, e.g. 'A61K9/127', 'A61K9/51', 'C12N15/88',
         or a main group prefix 'A61K9'.  No wildcards.  Records come back sorted
         by publication date ascending; size up to 2000 per page was accepted.
    publication_number: digits only ('3532103'); application_number: 8 digits
         without check digit ('17800986').
    """
    if year_end is None:
        year_end = time.gmtime().tm_year
    body = {
        "publicationNumber": publication_number,
        "applicationNumber": application_number,
        "ipcSymbol": ipc,
        "publicationDateRange": {
            "isRange": True, "publicationYear": None, "publicationWeek": None,
            "publicationYearStart": year_start, "publicationWeekStart": week_start,
            "publicationYearEnd": year_end, "publicationWeekEnd": week_end},
        "publicationKinds": kinds or ALL_KINDS,
    }
    out, page = [], 0
    while page < max_pages:
        raw = _http("%s/publications?page=%d&size=%d&lng=en" % (BASE, page, page_size),
                    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        d = json.loads(raw)
        out.extend(d.get("content", []))
        if d.get("last", True) or not d.get("content"):
            break
        page += 1
    return out


def list_kinds(ep_number: str) -> list:
    """All publications (kind codes) of one EP publication number, oldest first.

    -> [{'kind','date','correction_code','id','lang','app_number','app_date',
         'wo_number','xml_size','has_fulltext','xml_path','zip_path'}]
    'id' is directly usable with fetch_document().
    """
    num = _num_only(ep_number)
    recs = search_publications(publication_number=str(int(num)))
    out = []
    for r in recs:
        if "%07d" % int(r["publicationNumber"]) != num:
            continue
        cc = r.get("correctionCode") or "NW"
        out.append({
            "kind": r["publicationKind"],
            "date": (r.get("publicationDate") or "").replace("-", ""),
            "correction_code": cc,
            "original_kind": r.get("originalPublicationKind") or None,
            "id": "EP%s%s%s" % (num, cc, r["publicationKind"]),
            "lang": r.get("lang"),
            "app_number": r.get("applicationNumber"),
            "app_date": (r.get("applicationDate") or "").replace("-", ""),
            "wo_number": r.get("woPublicationNumber"),
            "xml_size": r.get("xmlFileSize"),
            # Euro-PCT A1 stubs are ~5 kB biblio-only (text lives in the WO pamphlet)
            # None = size not reported by the search backend (seen for some records)
            "has_fulltext": ((r["xmlFileSize"] > 20000) if r.get("xmlFileSize") else None),
            "xml_path": r.get("xmlFile"),
            "zip_path": r.get("zipFile"),
        })
    out.sort(key=lambda x: (x["date"], x["kind"]))
    return out


def list_kinds_by_probe(ep_number: str, kinds=("A1", "A2", "A3", "B1", "B2", "B3")) -> list:
    """Fallback without the search backend: try each kind on the REST landing page."""
    num = _num_only(ep_number)
    found = []
    for k in kinds:
        try:
            _http("%s/patents/EP%sNW%s" % (REST, num, k))
            found.append(k)
        except NotFound:
            pass
    return found


def list_publication_dates() -> list:
    """All weekly publication dates (YYYYMMDD) known to the server, newest first."""
    html = _http(REST + "/publication-dates").decode("utf-8", "replace")
    return re.findall(r"publication-dates/(\d{8})/patents", html)


def list_publications_on(date: str) -> list:
    """Ids (e.g. 'EP4832746NWA1') published on a weekly date YYYYMMDD (~7k ids, 0.5 MB)."""
    html = _http("%s/publication-dates/%s/patents" % (REST, date)).decode("utf-8", "replace")
    return re.findall(r'/patents/(EP\d{7}[A-Z0-9]{2}[AB]\d)"', html)


# --------------------------------------------------------------------------
# XML -> text helpers
# --------------------------------------------------------------------------
_WS = re.compile(r"[ \t\r\f\v ]+")
_BLOCK = {"p", "heading", "claim-text", "li", "row", "br", "tables", "table", "ul", "ol",
          "dl", "dt", "dd", "chemistry", "maths", "figure", "claim", "pre"}


def _strip_doctype(xml: str) -> str:
    # expat without the DTD fails on undeclared named entities; EPO files use
    # numeric references, but be defensive for a handful of legacy entities.
    xml = re.sub(r"<!DOCTYPE[^>]*>", "", xml, count=1)
    return re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)", "&amp;", xml)


def _text(el, sub_sup: bool = False) -> str:
    """Flatten an element to plain text. Images -> '[chem: file]' placeholders,
    table rows -> ' | ' separated cells, block elements -> newlines."""
    parts: list = []

    def rec(e):
        tag = e.tag
        if tag is ET.Comment or tag is ET.ProcessingInstruction or not isinstance(tag, str):
            if e.tail:
                parts.append(e.tail)
            return
        if tag == "img":
            kind = e.get("img-content") or "img"
            parts.append("[%s:%s]" % (kind, e.get("file", "")))
        elif tag in ("chemistry", "maths", "tables"):
            parts.append("\n")
        if tag == "entry":
            parts.append(" | ")
        if sub_sup and tag == "sub":
            parts.append("_")
        if sub_sup and tag == "sup":
            parts.append("^")
        if e.text:
            parts.append(e.text)
        for c in e:
            rec(c)
        if tag in _BLOCK:
            parts.append("\n")
        if e.tail:
            parts.append(e.tail)

    if el.text:
        parts.append(el.text)
    for c in el:
        rec(c)
    s = "".join(parts)
    s = _WS.sub(" ", s)
    s = re.sub(r" *\n[ \n]*", "\n", s)
    return s.strip()


def _t(el) -> str | None:
    if el is None:
        return None
    s = _WS.sub(" ", "".join(el.itertext()).replace("\n", " ")).strip()
    return s or None


def _date(el) -> str | None:
    if el is None:
        return None
    d = el.find("date")
    return _t(d) if d is not None else None


def _party(el) -> dict:
    """B711/B721/B731/B741/B781 -> {name, city, country, street}"""
    adr = el.find("adr")
    d = {"name": _t(el.find("snm"))}
    if adr is not None:
        d["street"] = _t(adr.find("str"))
        d["city"] = _t(adr.find("city"))
        d["country"] = _t(adr.find("ctry"))
    return d


def _classif(text: str) -> dict:
    """Fixed-width ST.8 string -> dict.
    IPC: 'A61K   9/127       20250101AFI20180504BHEP'  (A=advanced level, F=first/L=later, I=inventive/N=additional)
    CPC: 'A61K   9/1272      20130101 FI20171219BHEP'  (blank level, F/L, I=inventive/A=additional)
    """
    raw = text or ""
    m = re.match(r"^\s*([A-HY]\d{2}[A-Z])\s*(\d{1,4})\s*/\s*(\d{1,6})\s+(\d{8})(.)(.)(.)", raw)
    if not m:
        m2 = re.match(r"^\s*([A-HY]\d{2}[A-Z])\s*(\d{1,4})\s*/\s*(\d{1,6})", raw)
        sym = "%s%s/%s" % m2.groups() if m2 else _WS.sub("", raw)[:20]
        return {"symbol": sym, "version": None, "first": None, "inventive": None,
                "raw": _WS.sub(" ", raw).strip()}
    sub, grp, sg, ver, lvl, pos, val = m.groups()
    return {"symbol": "%s%s/%s" % (sub, grp, sg), "version": ver,
            "first": pos == "F", "inventive": val == "I",
            "raw": _WS.sub(" ", raw).strip()}


# --------------------------------------------------------------------------
# claim dependency parsing (en / de / fr)
# --------------------------------------------------------------------------
_CLAIM_WORD = (r"(?:clai[mn]s?|cl\.|(?:patent)?anspr(?:u|ü)ch(?:e|en|es|s)?|"
               r"revendicat(?:io|oi|o|i)ns?)")   # tolerant of typos seen in granted texts ("clain", "revendicaton")
# number list: 1 / 1 or 2 / 1 to 5 / 1-5 / 1, 2, and 4 / 1 bis 5 / 1 à 5 / 1 through 5
_NUM = r"\d{1,3}"
_SEP1 = (r"(?:,|;|/|&|and/or|und/oder|et/ou|and|or|und|oder|et|ou|to|bis|à|a|through|thru|"
         r"-|‐|‑|‒|–|—)")
_SEP = r"(?:\s*" + _SEP1 + r"(?:\s*" + _SEP1 + r")?\s*|\s+)"
_FILL = (r"(?:\s*(?:" + _CLAIM_WORD + r"|any\s+of|any\s+one\s+of|one\s+of|einem\s+der|"
         r"l'une\s+(?:quelconque\s+)?des|la|le|les|den|dem)\s*){0,2}")
_REF_RE = re.compile(
    r"\b" + _CLAIM_WORD + r"\s*(?:nos?\.?\s*)?(" + _NUM + r"(?:" + _SEP + _FILL + _NUM + r")*)", re.I)
_RANGE_RE = re.compile(r"(\d{1,3})\s*(?:to|bis|à|a|through|thru|-|‐|‑|‒|–|—)\s*(\d{1,3})", re.I)
_PRECEDING_RE = re.compile(
    r"(?:(?:preceding|previous|foregoing|above|prior|aforementioned)(?:[- ]mentioned)?\s+clai[mn]s?|"
    r"clai[mn]s?\s+(?:above|supra)|"
    r"(?:vorhergehende|vorangehende|vorstehende|vorherige|voranstehende|vorangegangene|vorgenannte|obige|vorigen?)[nrms]?\s+(?:patent)?anspr(?:u|ü)ch\w*|"
    r"revendicat(?:io|oi|o|i)ns?\s+(?:quelconques?\s+)?pr[ée]c[ée]dentes?)(?!\s*\d)", re.I)


def parse_dependencies(text: str, num: int) -> list:
    """Return sorted claim numbers (< num) this claim refers back to.

    Handles 'according to claim 1', 'of any one of claims 1 to 5', 'claims 1-3',
    'claim 1 or 2', 'nach Anspruch 1 oder 2', 'nach einem der Ansprüche 1 bis 4',
    'selon l'une quelconque des revendications 1 à 3', 'any preceding claim'.
    References to claims >= num (forward/self references) are ignored.
    Note: a claim that *refers* to another claim of a different category
    ('A composition comprising the lipid of claim 1') is reported as dependent
    here as well; use `category` heuristics downstream if that matters.
    """
    deps: set = set()
    t = text.replace(" ", " ")
    for m in _REF_RE.finditer(t):
        lst = m.group(1)
        consumed = set()
        for a, b in _RANGE_RE.findall(lst):
            a, b = int(a), int(b)
            if a <= b and b - a < 400:
                deps.update(range(a, b + 1))
            consumed.update((a, b))
        for n in re.findall(r"\d{1,3}", lst):
            deps.add(int(n))
    # "any preceding claim" -> all earlier claims, unless an explicit list was given
    # ("nach einem der vorhergehenden Ansprüche 4 bis 5")
    if not [x for x in deps if 0 < x < num] and _PRECEDING_RE.search(t):
        deps.update(range(1, num))
    return sorted(d for d in deps if 0 < d < num)


_LEAD_NUM = re.compile(r"^\s*(\d{1,3})\s*[.)]\s+")


def _parse_claims(claims_el) -> list:
    out = []
    for i, c in enumerate(claims_el.findall("claim"), 1):
        try:
            num = int(c.get("num") or i)
        except ValueError:
            num = i
        txt = _text(c)
        # legacy files repeat the number inside the text ("1. A method ...")
        m = _LEAD_NUM.match(txt)
        if m and int(m.group(1)) == num:
            txt = txt[m.end():]
        out.append({"num": num, "text": txt, "depends_on": parse_dependencies(txt, num)})
    return out


# --------------------------------------------------------------------------
# main parser
# --------------------------------------------------------------------------
def parse_document(xml: str) -> dict:
    """Parse an ep-patent-document (DTD 1.0 ... 1.7.1) into a plain dict.

    Keys: pn, number, kind, correction_code, status, lang (publication language),
    filing_lang, proc_lang, dtd_version, title{en,de,fr}, applicants[] (B711 on A
    docs / B731 proprietors on B docs; each {name,city,country,street}),
    inventors[], representatives[], opponents[], priorities[{number,date,country}],
    app_number, app_date, pub_date, a_pub_date (B430), grant_date (B450),
    b2_date (B477), correction_date (B480), intention_to_grant_date (B452EP),
    ipc[{symbol,version,first,inventive,raw}], cpc[...], designated_states[],
    extension_states[], validation_states[], lapses[{country,date}] (B472/B475,
    only in B2/B3/B8/B9 or reprinted files), pct{app_number,pub_number,pub_date},
    parent_applications[] (B620), divisional_children[] (B630),
    spec_type (B121 text, e.g. 'NEW EUROPEAN PATENT SPECIFICATION') + spec_note
    (B121EP 'After opposition procedure'), correction{code,parts{lang:text}},
    claims{en:[{num,text,depends_on[]}],de:[..],fr:[..]}, claims_lang_order[],
    amended_claims{lang:[..]} (A-docs: claims amended under Art.19/Rule 137),
    abstract, description_text, citations[{type:'patent'|'npl', text, category?}]
    (B561/B562 = search-report citations), refs_cited_in_description[] ('US6197553B1').
    """
    root = ET.fromstring(_strip_doctype(xml))
    if root.tag != "ep-patent-document":
        raise ValueError("not an ep-patent-document: %s" % root.tag)
    sd = root.find("SDOBI")
    if sd is None:
        raise ValueError("no SDOBI block")

    def f(path):
        return sd.find(path)

    number = root.get("doc-number") or _t(f("B100/B110"))
    kind = root.get("kind") or _t(f("B100/B130"))
    d: dict = {
        "pn": "EP%s%s" % (number, kind),
        "number": number,
        "kind": kind,
        "correction_code": root.get("correction-code") or _t(f("B100/B150/B151")),
        "status": root.get("status"),            # n = new, c = corrected
        "lang": (root.get("lang") or _t(f("B200/B260")) or "").lower() or None,   # publication language
        "filing_lang": (_t(f("B200/B250")) or "").lower() or None,
        "proc_lang": (_t(f("B200/B251EP")) or "").lower() or None,
        "dtd_version": root.get("dtd-version"),
        "file": root.get("file"),
        "spec_type": _t(f("B100/B120/B121")),
        "spec_note": _t(f("B100/B120/B121EP")),
        "original_kind": _t(f("B100/B132EP")),
    }

    # titles: B540 = repeated (B541 lang, B542 title) pairs
    title = {}
    b540 = f("B500/B540")
    if b540 is not None:
        lang = None
        for ch in b540:
            if ch.tag == "B541":
                lang = (_t(ch) or "").lower()
            elif ch.tag == "B542" and lang:
                title[lang] = _t(ch)
    d["title"] = {k: title.get(k) for k in ("en", "de", "fr")}

    d["applicants"] = [_party(e) for e in sd.findall("B700/B710/B711")] or \
                      [_party(e) for e in sd.findall("B700/B730/B731")]
    d["proprietors"] = [_party(e) for e in sd.findall("B700/B730/B731")]
    d["inventors"] = [_party(e) for e in sd.findall("B700/B720/B721")]
    d["representatives"] = [_party(e) for e in sd.findall("B700/B740/B741")]
    d["opponents"] = [_party(e) for e in sd.findall("B700/B780/B781")]

    # priorities: B300 = repeated B310 (number) B320 (date) B330 (ctry)
    prios, cur = [], None
    b300 = f("B300")
    if b300 is not None:
        for ch in b300:
            if ch.tag == "B310":
                cur = {"number": _t(ch), "date": None, "country": None}
                prios.append(cur)
            elif ch.tag == "B320" and cur is not None:
                cur["date"] = _date(ch)
            elif ch.tag == "B330" and cur is not None:
                cur["country"] = _t(ch.find("ctry"))
    d["priorities"] = prios

    d["app_number"] = _t(f("B200/B210"))
    d["app_date"] = _date(f("B200/B220"))
    d["pub_date"] = root.get("date-publ") or _date(f("B100/B140"))
    d["a_pub_date"] = _date(f("B400/B430"))
    d["grant_date"] = _date(f("B400/B450"))
    d["b2_date"] = _date(f("B400/B477"))
    d["correction_date"] = _date(f("B400/B480"))
    d["intention_to_grant_date"] = _date(f("B400/B452EP"))
    d["exam_request_date"] = _date(f("B200/B240/B241"))

    ipc = [_classif(e.text or "") for e in sd.findall("B500/B510EP/classification-ipcr/text")]
    if not ipc:  # legacy IPC1-7: B510/B511 (main) B512 (further) e.g. '7A 61K 9/127 A'
        for e in sd.findall("B500/B510/*"):
            if e.tag in ("B511", "B512", "B513", "B514"):
                raw = _t(e) or ""
                m = re.match(r"^\s*\d?\s*([A-H])\s*(\d{2})\s*([A-Z])\s*(\d{1,4})\s*/\s*(\d{1,6})", raw)
                ipc.append({"symbol": "%s%s%s%s/%s" % m.groups() if m else raw,
                            "version": None, "first": e.tag == "B511", "inventive": None, "raw": raw})
    d["ipc"] = ipc
    d["cpc"] = [_classif(e.text or "") for e in
                sd.findall("B500/B520EP/classifications-cpc/classification-cpc/text")]
    d["cpc_combinations"] = [[_classif(t.text or "")["symbol"] for t in cs.iter("text")]
                             for cs in sd.findall("B500/B520EP/combination-set")]

    d["designated_states"] = [_t(e) for e in sd.findall("B800/B840/ctry")]
    d["extension_states"] = [_t(e) for e in sd.findall("B800/B844EP/B845EP/ctry")]
    d["validation_states"] = [_t(e) for e in sd.findall("B800/B848EP/B849EP/ctry")]

    lapses = []
    for b475 in sd.findall("B400/B472/B475"):
        cur_date = None
        for ch in b475:
            if ch.tag == "date":
                cur_date = _t(ch)
            elif ch.tag == "ctry":
                lapses.append({"country": _t(ch), "date": cur_date})
    d["lapses"] = lapses

    d["pct"] = {
        "app_number": _t(f("B800/B860/B861/dnum/anum")),
        "app_date": _date(f("B800/B860/B861")),
        "pub_number": _t(f("B800/B870/B871/dnum/pnum")),
        "pub_date": _date(f("B800/B870/B871")),
    }
    d["parent_applications"] = [
        {"app_number": _t(e.find("dnum/anum")), "pub_number": _t(e.find("dnum/pnum")), "date": _date(e)}
        for e in sd.findall("B600/B620/parent/pdoc")] or \
        [{"app_number": _t(e.find("dnum/anum")), "pub_number": _t(e.find("dnum/pnum")), "date": _date(e)}
         for e in sd.findall("B600/B620/B621")]
    d["divisional_children"] = [
        {"app_number": _t(e.find("dnum/anum")), "pub_number": _t(e.find("dnum/pnum")), "date": _date(e)}
        for e in sd.findall("B600/B630/B631")]

    corr = f("B100/B150")
    if corr is not None:
        parts, lang = {}, None
        for ch in corr.iter():
            if ch.tag == "B1551":
                lang = _t(ch)
            elif ch.tag == "B1552" and lang:
                parts[lang] = _t(ch)
        d["correction"] = {"code": _t(corr.find("B151")), "parts": parts}
    else:
        d["correction"] = None

    cits = []
    b560 = f("B500/B560")
    if b560 is not None:
        for ch in b560:
            if ch.tag == "B561":
                cits.append({"type": "patent", "text": _t(ch.find("text")) or _t(ch)})
            elif ch.tag == "B562":
                cits.append({"type": "npl", "text": _t(ch.find("text")) or _t(ch)})
    d["citations"] = cits
    d["search_report_date"] = _date(f("B500/B560/B565EP")) or _date(f("B800/B880"))

    refs = []
    for pc in root.findall("ep-reference-list//patcit"):
        dn = pc.get("dnum") or "".join((_t(pc.find("document-id/" + k)) or "") for k in ("country", "doc-number", "kind"))
        if dn and dn not in refs:
            refs.append(dn)
    d["refs_cited_in_description"] = refs

    claims: dict = {"en": [], "de": [], "fr": []}
    order = []
    for cl in root.findall("claims"):
        lang = (cl.get("lang") or "").lower()
        order.append(lang)
        claims.setdefault(lang, [])
        claims[lang].extend(_parse_claims(cl))
    d["claims"] = claims
    d["claims_lang_order"] = order
    amended = {}
    for cl in root.findall("amended-claims"):
        amended.setdefault((cl.get("lang") or "").lower(), []).extend(_parse_claims(cl))
    d["amended_claims"] = amended
    d["amended_claims_statement"] = "\n".join(_text(e) for e in root.findall("amended-claims-statement")) or None

    ab = [a for a in root.findall("abstract")]
    ab_pref = [a for a in ab if (a.get("lang") or "").lower() == "en"] or ab
    d["abstract"] = _text(ab_pref[0]) if ab_pref else None

    desc = root.find("description")
    d["description_lang"] = desc.get("lang") if desc is not None else None
    d["description_text"] = _text(desc) if desc is not None else ""
    d["has_fulltext"] = bool(d["description_text"]) or any(claims.values())
    d["n_claims"] = {k: len(v) for k, v in claims.items()}
    d["independent_claims"] = {k: [c["num"] for c in v if not c["depends_on"]] for k, v in claims.items()}
    # cross-language sanity check: the three claim sets are translations of each
    # other, so depends_on must agree; disagreements (typos such as "clain 7" in
    # the granted text) are listed and a majority vote is stored per claim.
    mism = []
    langs = [l for l in ("en", "de", "fr") if claims.get(l)]
    if len(langs) == 3 and len({len(claims[l]) for l in langs}) == 1:
        for i in range(len(claims["en"])):
            ds = [tuple(claims[l][i]["depends_on"]) for l in langs]
            maj = max(set(ds), key=ds.count)
            if len(set(ds)) > 1:
                mism.append(claims["en"][i]["num"])
            for l in langs:
                claims[l][i]["depends_on_consensus"] = list(maj)
    d["dependency_mismatches"] = mism
    return d


if __name__ == "__main__":
    import sys
    # usage: epo_pubserver.py <cache_dir> EP3532103B1 [...]
    cache = sys.argv[1]
    for arg in sys.argv[2:]:
        doc = parse_document(fetch_document(arg, cache))
        print(json.dumps({k: (v if k not in ("description_text",) else v[:300]) for k, v in doc.items()},
                         ensure_ascii=False, indent=1)[:6000])
