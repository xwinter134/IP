"""Parse a ppubs full-text JSON (as stored by fetch_us.py) into a flat dict. stdlib only.

parse_us(json_dict) -> {pn, guid, kind, title, assignees, inventors, app_number, app_date, pub_date,
  priority_date, cpc, claims:[{n, t, dep}], n_claims_declared, exemplary_claim, pta_days, continuity,
  abstract, description_text, has_chem_img}
Chemistry: '##STR00027##' -> '[chem:STR00027]'; '.sub.' -> plain (R.sub.1 -> R1), '.sup.' -> '^' (R.sup.2 -> R^2).
"""
import gzip, html, json, re

_TAG = re.compile(r"<[^>]+>")
_BR = re.compile(r"<\s*br\s*/?\s*>", re.I)
_PLACE = re.compile(r"##([A-Z]+)(\d+)##")


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rb") as f:
        return json.loads(f.read())


def _scripts(s):
    """sub/sup markup (both '.sub.' text style and real tags) -> plain inline text."""
    s = re.sub(r"<\s*sub\s*>", "", s, flags=re.I)
    s = re.sub(r"<\s*/\s*sub\s*>", "", s, flags=re.I)
    s = re.sub(r"<\s*sup\s*>", "^", s, flags=re.I)
    s = re.sub(r"<\s*/\s*sup\s*>", "", s, flags=re.I)
    s = s.replace(".sub.", "").replace(".SUB.", "")
    s = s.replace(".sup.", "^").replace(".SUP.", "^")
    return s


def _place(m):
    k = m.group(1)
    return "[chem:%s%s]" % (k, m.group(2)) if k == "STR" else "[%s:%s%s]" % ("eq" if k.startswith("EQU") else "tbl" if k.startswith("TBL") else k.lower(), k, m.group(2))


def to_text(h, keep_breaks=True):
    if not h:
        return ""
    s = _BR.sub("\n", h)
    s = re.sub(r"</(p|div|tr|li|h\d)\s*>", "\n", s, flags=re.I)
    s = _scripts(s)
    s = _TAG.sub("", s)
    s = html.unescape(s)
    s = s.replace("\xa0", " ")
    s = _PLACE.sub(_place, s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r" ?\n ?", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    if not keep_breaks:
        s = re.sub(r"\s+", " ", s)
    return s


# ---- claims -------------------------------------------------------------------------
def split_claims(claims_html):
    """Return [(n, text)] splitting on sequential claim numbers (robust against numbers inside the text).
    Handles '1-15. (canceled)' ranges (expanded to one '(canceled)' claim per number) and claim lists that
    do not start at 1 (pre-grant publications after amendment)."""
    txt = to_text(claims_html)
    if not txt:
        return []
    line_rx = re.compile(r"(?m)^[ \t]*(\d{1,3})(?:[ \t]*[-\u2013][ \t]*(\d{1,3}))?[ \t]*\.[ \t]*(?=\S)")
    starts = []  # (first, last, start, end)
    pos = 0
    expected = None
    while True:
        m = None
        for cand in line_rx.finditer(txt, pos):
            a = int(cand.group(1))
            if (expected is None and a >= 1) or a == expected:
                m = cand
                break
            if expected is None:
                break
        if m is None and expected is not None:
            m = re.compile(r"(?<=[\.\;\)\s])%d[ \t]*\.[ \t]+(?=[A-Z\[\(])" % expected).search(txt, pos)
            if m:
                starts.append((expected, expected, m.start(), m.end()))
                pos, expected = m.end(), expected + 1
                continue
        if m is None:
            break
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else a
        if b < a:
            break
        starts.append((a, b, m.start(), m.end()))
        pos, expected = m.end(), b + 1
    out = []
    for i, (a, b, st, e) in enumerate(starts):
        end = starts[i + 1][2] if i + 1 < len(starts) else len(txt)
        body = re.sub(r"\s+", " ", txt[e:end]).strip()
        for n in range(a, b + 1):
            out.append((n, body if a == b else "(canceled)" if "cancel" in body.lower() else body))
    return out


_NUM = r"\d{1,3}"
_RANGE = r"%s(?:\s*(?:-|–|—|to|through|thru)\s*%s)?" % (_NUM, _NUM)
_SEP = r"(?:\s*,\s*(?:or|and|and/or)?\s*|\s+(?:or|and|and/or)\s+|\s*,?\s*(?:or|and|and/or)\s+)"
_CLAIMREF = re.compile(r"\bclaims?\s+(%s(?:%s%s)*)" % (_RANGE, _SEP, _RANGE), re.I)
_PRECEDING = re.compile(r"\b(?:any|each|one)\s+(?:one\s+)?of\s+the\s+(?:preceding|previous|foregoing|above)\s+claims|\bpreceding claims\b|\bprevious claims\b", re.I)


def parse_deps(text, n, total=None):
    deps = set()
    for m in _CLAIMREF.finditer(text):
        for part in re.split(_SEP, m.group(1)):
            part = part.strip()
            if not part:
                continue
            r = re.split(r"\s*(?:-|–|—|to|through|thru)\s*", part)
            try:
                a = int(r[0])
                b = int(r[-1])
            except ValueError:
                continue
            if b < a:
                a, b = b, a
            if b - a > 200:
                continue
            deps.update(x for x in range(a, b + 1) if 1 <= x < n)
    if not deps and _PRECEDING.search(text) and n > 1:
        deps.update(range(1, n))
    return sorted(deps)


# ---- continuity ---------------------------------------------------------------------
_DATE8 = r"(\d{8})"


def _d(s):
    return "%s-%s-%s" % (s[:4], s[4:6], s[6:8]) if s and len(s) == 8 else None


def parse_continuity(raw):
    """raw: list[str] (continuityData). Returns list of {relation, app_number, date, status, direction, raw}."""
    out = []
    for blk in raw or []:
        for part in re.split(r"<\s*br\s*/?\s*>", blk or ""):
            part = part.strip()
            if not part:
                continue
            lines = [l.strip() for l in part.split("\n") if l.strip()]
            if not lines:
                continue
            first = lines[0]
            m = re.match(r"(?i)(parent|child)\s+(\w{2})\s+(?:(\S+?)\s+)?((?:PCT/\S+)|(?:[\w/\-]*\d[\w/\-]*))\s*(?:" + _DATE8 + r")?\s*(\w+)?\s*$", first)
            if m:
                direction, cc, rel, num, dt, st = m.groups()
                if rel and re.fullmatch(r"\d{8}", rel):
                    rel, dt = None, rel
                out.append({"direction": direction.lower(), "relation": rel, "app_number": num, "date": _d(dt),
                            "status": st, "raw": " | ".join(lines)})
                continue
            m = re.match(r"(?i)(us-provisional-application|[\w-]*application)\s+(\w{2})\s+(\S+)\s+(?:" + _DATE8 + r")?", first)
            if m:
                out.append({"direction": "parent", "relation": m.group(1).lower(), "app_number": m.group(3),
                            "date": _d(m.group(4)), "status": None, "raw": " | ".join(lines)})
                continue
            out.append({"direction": None, "relation": None, "app_number": None, "date": None, "status": None,
                        "raw": " | ".join(lines)})
    return out


def _iso(x):
    return (x or "")[:10] or None


def _l(x):
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


def parse_us(d):
    kind = (_l(d.get("kindCode")) or [""])[0]
    num = d.get("publicationReferenceDocumentNumber") or ""
    pn = "US%s%s" % (num, kind)
    app_date = _iso((_l(d.get("applicationFilingDate")) or [None])[0])
    asg = [a for a in (_l(d.get("assigneeName")) or _l(d.get("applicantName"))) if a]
    cont_raw = _l(d.get("continuityData"))
    cont = parse_continuity(cont_raw)
    dates = [x for x in (c["date"] for c in cont) if x]
    for x in _l(d.get("relatedApplFilingDate")) + _l(d.get("priorityClaimsDate")):
        if x:
            dates.append(_iso(x))
    dates = [x for x in dates if x and x[:4].isdigit() and "1900" < x]
    # earliest of continuity / priority data, else filing date (a child can never precede its own parents)
    if dates:
        prio = min(dates)
        if app_date and app_date < prio:
            prio = app_date
    else:
        prio = app_date
    cpc = []
    for k in ("cpcInventiveFlattened", "cpcAdditionalFlattened"):
        for c in re.split(r"[;,]", d.get(k) or ""):
            c = c.strip()
            if c and c not in cpc:
                cpc.append(c)
    parts = split_claims(d.get("claimsHtml"))
    claims = [{"n": n, "t": t, "dep": parse_deps(t, n, len(parts))} for n, t in parts]
    try:
        declared = int(d.get("numberOfClaims")) if d.get("numberOfClaims") not in (None, "") else None
    except (TypeError, ValueError):
        declared = None
    ex = None
    try:
        ex = int((_l(d.get("exemplaryClaimNumber")) or [None])[0])
    except (TypeError, ValueError):
        pass
    pta = None
    toe = d.get("termOfExtension")
    if toe not in (None, ""):
        mm = re.search(r"\d+", str(toe))
        pta = int(mm.group()) if mm else None
    brief = to_text(d.get("briefHtml"))
    desc = to_text(d.get("descriptionHtml"))
    description = (brief + "\n\n" + desc).strip() if brief else desc
    abstract = to_text(d.get("abstractHtml"), keep_breaks=False)
    chem = any("##STR" in (d.get(k) or "") for k in ("claimsHtml", "descriptionHtml", "abstractHtml", "briefHtml"))
    return {"pn": pn, "guid": d.get("guid"), "kind": kind, "title": re.sub(r"<[^>]+>", "", d.get("inventionTitle") or "") or None, "assignees": asg,
            "inventors": _l(d.get("inventorsName")), "app_number": d.get("applicationNumber"), "app_date": app_date,
            "pub_date": _iso(d.get("datePublished")), "priority_date": prio, "cpc": cpc, "claims": claims,
            "n_claims_declared": declared, "exemplary_claim": ex, "pta_days": pta,
            "continuity": {"raw": cont_raw, "parsed": cont,
                           "parents": [c["app_number"] for c in cont if c["app_number"]]},
            "abstract": abstract, "description_text": description, "has_chem_img": chem}


if __name__ == "__main__":
    import sys
    r = parse_us(load(sys.argv[1]))
    r["description_text"] = r["description_text"][:300]
    print(json.dumps(r, indent=1)[:6000])
