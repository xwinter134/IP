"""Parse EP Register ST.36 <register-document> elements (BDDS product 16) into compact dicts. stdlib only.

parse_register_doc(xml_text) -> dict   (None when the document has no EP application number)
The record keeps what status.py needs; mapping to status codes lives in status.py so it can change
without refetching the (large) snapshot.
"""
import re
import xml.etree.ElementTree as ET

_APP_RX = re.compile(r'<bibliographic-data[^>]*\bid="EP(\d{8})[A-Z]?"')
NOISE = re.compile(r"^(New entry|Deletion|Change)\b", re.I)


def app_number_of(fragment):
    m = _APP_RX.search(fragment)
    return m.group(1) if m else None


def _d(s):
    s = (s or "").strip()
    return "%s-%s-%s" % (s[:4], s[4:6], s[6:8]) if re.fullmatch(r"\d{8}", s) else None


def _txt(el, path):
    x = el.find(path)
    return (x.text or "").strip() if x is not None and x.text else ""


def _date(el, path):
    x = el.find(path)
    return _d(x.text) if x is not None else None


def parse_register_doc(xml):
    root = ET.fromstring(xml)
    bib = root.find("bibliographic-data")
    if bib is None:
        return None
    m = re.match(r"EP(\d{8})", bib.get("id", ""))
    rec = {"app": m.group(1) if m else None, "produced": _d(root.get("date-produced")),
           "status_text": (root.get("status") or "").strip()}
    # status history, newest first as delivered
    hist = []
    for s in root.findall("ep-patent-statuses/ep-patent-status"):
        try:
            code = int(s.get("status-code"))
        except (TypeError, ValueError):
            code = None
        hist.append({"date": _d(s.get("change-date")), "code": code, "text": (s.text or "").strip()})
    rec["status_hist"] = hist[:8]
    rec["status_code_num"] = hist[0]["code"] if hist else None
    # filing date and publications
    for ar in bib.findall("application-reference"):
        di = ar.find("document-id")
        if di is not None and _txt(di, "country") == "EP":
            rec["filing"] = _date(di, "date")
            break
    pubs = []
    for pr in bib.findall("publication-reference"):
        di = pr.find("document-id")
        if di is not None:
            pubs.append({"cc": _txt(di, "country"), "num": _txt(di, "doc-number"), "kind": _txt(di, "kind"), "date": _date(di, "date")})
    rec["pubs"] = pubs
    gd = [p["date"] for p in pubs if p["cc"] == "EP" and p["kind"].startswith("B") and p["date"]]
    rec["grant"] = min(gd) if gd else None
    wo = [p for p in pubs if p["cc"] == "WO"]
    rec["wo"] = (wo[0]["cc"] + wo[0]["num"] + wo[0]["kind"]) if wo else None
    # designated states
    des = []
    dos = bib.find("designation-of-states")
    if dos is not None:
        for c in dos.iter("country"):
            if (c.text or "").strip() and c.text.strip() != "EP":
                des.append(c.text.strip())
    rec["designated"] = sorted(set(des))
    # applicants / title
    ap = bib.find("parties/applicants/applicant/addressbook/name")
    rec["applicant"] = (ap.text or "").strip() if ap is not None else None
    # lapses: take the term-of-grant block with the newest change-date
    tog = bib.findall("term-of-grant")
    if tog:
        best = max(tog, key=lambda t: t.get("change-date") or "")
        rec["lapsed"] = sorted(({"cc": _txt(l, "country"), "date": _date(l, "date")} for l in best.findall("lapsed-in-country")),
                               key=lambda x: (x["date"] or "", x["cc"]))
    else:
        rec["lapsed"] = []
    # dates-rights-effective
    dre = bib.find("dates-rights-effective")
    rec["maintained_date"] = _date(dre, "patent-maintained-as-amended/date") if dre is not None else None
    rec["revocation_date"] = _date(bib, "date-of-revocation/date")
    rec["rejected_date"] = None
    for tag in ("date-rejected", "opposition-rejected"):
        x = root.find(".//" + tag)
        if x is not None:
            rec["rejected_date"] = _date(x, "date") or "yes"
    for tag in ("date-application-deemed-withdrawn", "date-application-refused", "date-application-withdrawn-by-applicant"):
        x = root.find(".//" + tag)
        if x is not None:
            rec[tag.replace("date-application-", "").replace("-", "_")] = _date(x, "date") or "yes"
    # related (divisional) documents
    kids = []
    for rel in bib.findall("related-documents/division/relation"):
        for di in rel.findall("child-doc/document-id"):
            if di.get("document-id-type") == "application number" and _txt(di, "doc-number"):
                kids.append(_txt(di, "doc-number"))
        par = rel.find("parent-doc/document-id/doc-number")
        if par is not None and (par.text or "").strip():
            rec["parent"] = par.text.strip()
    rec["children"] = kids
    # opposition
    opp = {"filed": None, "opponents": [], "not_filed_date": None, "withdrawn": 0, "statuses": []}
    for od in root.iter("opposition-data"):
        nf = od.find("opposition-not-filed")
        if nf is not None:
            opp["filed"] = opp["filed"] or False
            opp["not_filed_date"] = _date(nf, "date")
        for o in od.findall("opponent"):
            opp["filed"] = True
            nm = _txt(o, "addressbook/name")
            if nm and nm not in [x["name"] for x in opp["opponents"]]:
                opp["opponents"].append({"name": nm, "filed": _date(o, "date-opposition-filed/date"),
                                         "status": (o.find("opponent-status").get("status") if o.find("opponent-status") is not None else None)})
    rec["opposition"] = opp if opp["filed"] is not None else None
    # opposition procedural steps (interlocutory decision / revocation / rejection)
    steps = set()
    for ps in root.iter("procedural-step"):
        if ps.get("procedure-step-phase") == "opposition":
            steps.add(_txt(ps, "procedural-step-code"))
    rec["opp_steps"] = sorted(steps)
    # appeals
    ap_list = []
    for a in root.iter("ep-appeal-data"):
        ar = a.find("ep-appeal-result")
        ap_list.append({"num": a.get("appeal-num"), "phase": a.get("appeal-phase"), "date": _date(a, "date"),
                        "result": (ar.text or "").strip() if ar is not None else None,
                        "result_date": _d(ar.get("date")) if ar is not None else None})
    rec["appeals"] = ap_list
    # unitary effect (tags seen in the snapshot: unitary-patent, unitary-patent-statuses)
    up = []
    for el in root.iter():
        if el.tag.startswith("unitary-patent"):
            t = " ".join((x or "").strip() for x in [el.get("status"), el.text] + [e.text for e in el.iter() if e is not el]).strip()
            up.append({"tag": el.tag, "attrs": dict(el.attrib), "text": t[:200]})
    rec["unitary_raw"] = up[:6]
    # renewal fees and other procedural steps
    fees = {}
    for ps in root.iter("procedural-step"):
        if _txt(ps, "procedural-step-code") == "RFEE":
            yr = None
            pd = None
            for t in ps.findall("procedural-step-text"):
                if t.get("step-text-type") == "YEAR":
                    yr = (t.text or "").strip()
            for dt in ps.findall("procedural-step-date"):
                if dt.get("step-date-type") == "DATE_OF_PAYMENT":
                    pd = _date(dt, "date")
            if yr and yr.isdigit():
                fees[int(yr)] = pd
    rec["fees"] = [[y, fees[y]] for y in sorted(fees)]
    # events: newest first, substantive ones
    ev = []
    for e in root.iter("dossier-event"):
        t = _txt(e, "event-text")
        ev.append({"date": _date(e, "event-date/date"), "text": t, "code": _txt(e, "event-code")})
    ev.sort(key=lambda x: x["date"] or "", reverse=True)
    sub = [x for x in ev if not NOISE.match(x["text"])]
    rec["events"] = (sub or ev)[:24]
    rec["n_events"] = len(ev)
    return rec
