#!/usr/bin/env python3
"""USPTO Patent Public Search (ppubs.uspto.gov) anonymous JSON API - no key, stdlib only.

Client keeps one anonymous session, re-opens it when the token expires (HTTP 401/403 or an
'invalid/expired token' style body) and retries once; 429/5xx back off exponentially.
Query language = PPUBS/BRS, e.g.  A61K9/5123.cpc. AND @pd>=20050101  |  "8058069".pn.
"""
import hashlib, json, os, sys, time, urllib.request, urllib.error

B = "https://ppubs.uspto.gov/api"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
H = {"User-Agent": UA, "Content-Type": "application/json", "Referer": "https://ppubs.uspto.gov/pubwebapp/",
     "Origin": "https://ppubs.uspto.gov"}
DBS = ("USPAT", "US-PGPUB")


class PpubsError(RuntimeError):
    def __init__(self, status, msg=""):
        super().__init__("HTTP %s %s" % (status, msg))
        self.status = status


def _req(method, path, body=None, token=None, extra=None, timeout=120):
    h = dict(H)
    h["X-Access-Token"] = token or "null"
    if extra:
        h.update(extra)
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(B + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        return 599, {}, str(e).encode()


def open_session():
    for i in range(4):
        st, hd, body = _req("POST", "/users/me/session", b"-1")
        if st == 200:
            tok = hd.get("x-access-token")
            return tok, json.loads(body)["userCase"]["caseId"]
        time.sleep(2 ** (i + 1))
    raise PpubsError(st, body[:200].decode("utf8", "replace"))


def _auth_failure(st, raw):
    if st in (401, 403):
        return True
    if st >= 400 and raw:
        t = raw[:400].lower()
        return b"token" in t or b"session" in t or b"expired" in t
    return False


class Client:
    """Stateful client: .search(), .fulltext(); transparent session renewal + backoff."""

    def __init__(self, pause=1.0, max_retries=5, log=None):
        self.pause = pause
        self.max_retries = max_retries
        self.log = log or (lambda m: print(m, file=sys.stderr, flush=True))
        self.token = self.case_id = None
        self.last = 0.0
        self.sessions_opened = 0

    def reopen(self):
        self.token, self.case_id = open_session()
        self.sessions_opened += 1
        time.sleep(1)

    def _throttle(self):
        d = self.pause - (time.time() - self.last)
        if d > 0:
            time.sleep(d)
        self.last = time.time()

    def _call(self, method, path, body=None, extra=None):
        """Returns raw bytes. Re-opens the session once on auth failure; backs off on 429/5xx."""
        if not self.token:
            self.reopen()
        reopened = False
        delay = 4.0
        for attempt in range(self.max_retries + 1):
            self._throttle()
            b = body() if callable(body) else body
            st, hd, raw = _req(method, path, b, self.token, extra)
            if st == 200:
                return raw
            if _auth_failure(st, raw) and not reopened:
                self.log("ppubs: auth failure %s, re-opening session" % st)
                self.reopen()
                reopened = True
                continue
            if st in (429, 403, 599) or st >= 500:
                if attempt >= self.max_retries:
                    break
                ra = hd.get("retry-after")
                w = float(ra) if ra and ra.replace(".", "").isdigit() else delay
                self.log("ppubs: HTTP %s on %s, sleeping %.0fs (attempt %d)" % (st, path[:40], w, attempt + 1))
                time.sleep(w)
                delay = min(delay * 2, 300)
                if st == 403 and not reopened:
                    pass
                continue
            break
        raise PpubsError(st, raw[:300].decode("utf8", "replace"))

    # -- search -------------------------------------------------------------------------
    def _search_body(self, q, start, page_count, dbs, sort):
        return {"start": start, "pageCount": page_count, "sort": sort,
                "docFamilyFiltering": "noFiltering", "searchType": 1,
                "familyIdEnglishOnly": True, "familyIdFirstPreferred": "US-PGPUB", "familyIdSecondPreferred": "USPAT",
                "familyIdThirdPreferred": "FPRS", "showDocPerFamilyPref": "showEnglish", "queryId": 0, "tagDocSearch": False,
                "query": {"caseId": self.case_id, "hl_snippets": "2", "op": "OR", "q": q, "queryName": q, "highlights": "0",
                          "qt": "brs", "spellCheck": False, "viewName": "tile", "plurals": True, "britishEquivalents": True,
                          "databaseFilters": [{"databaseName": d, "countryCodes": []} for d in dbs],
                          "searchType": 1, "ignorePersist": True, "userEnteredQuery": q}}

    def search(self, q, start=0, page_count=500, dbs=DBS, sort="date_publ desc"):
        if not self.token:
            self.reopen()
        raw = self._call("POST", "/searches/searchWithBeFamily",
                         lambda: json.dumps(self._search_body(q, start, page_count, dbs, sort)).encode())
        r = json.loads(raw)
        if r.get("error"):
            raise PpubsError(200, "search error: %s" % (r["error"],))
        return r

    def _call_cb(self, *a, **k):
        return self._call(*a, **k)

    def fulltext_raw(self, guid, source):
        """Bytes of the full-text JSON (claimsHtml, descriptionHtml, abstractHtml, ...)."""
        path = "/patents/highlight/%s?queryId=1&source=%s&includeSections=true" % (guid, source)
        return self._call("GET", path, None, {"Content-Type": "application/json"})

    def fulltext(self, guid, source):
        return json.loads(self.fulltext_raw(guid, source))

    def enumerate_query(self, q, dbs=DBS, page=500, cache_dir=None, limit=None):
        """Yield every hit dict for a query. Pages cached under cache_dir (one JSON per page)."""
        start = 0
        while True:
            r = None
            cp = None
            if cache_dir:
                key = hashlib.sha1(("%s|%s|%d|%d" % (q, ",".join(dbs), start, page)).encode()).hexdigest()[:20]
                cp = os.path.join(cache_dir, key + ".json")
                if os.path.exists(cp):
                    try:
                        r = json.load(open(cp))
                    except Exception:
                        r = None
            if r is None:
                r = self.search(q, start, page, dbs)
                if cp:
                    os.makedirs(cache_dir, exist_ok=True)
                    tmp = cp + ".tmp%d" % os.getpid()
                    with open(tmp, "w") as f:
                        json.dump({"q": q, "dbs": list(dbs), "start": start, "page": page,
                                   "numFound": r.get("numFound"), "patents": r.get("patents")}, f)
                    os.replace(tmp, cp)
            hits = r.get("patents") or []
            for h in hits:
                yield h
            start += len(hits)
            if not hits or start >= (r.get("numFound") or 0) or (limit and start >= limit):
                return


# -- helpers --------------------------------------------------------------------------
def canon_pn(num, kind):
    """('8058069','B2') -> 'US8058069B2'; ('20170210697','A1') -> 'US20170210697A1'."""
    num = str(num or "").strip()
    return "US%s%s" % (num, kind or "")


if __name__ == "__main__":
    c = Client()
    q = sys.argv[1]
    r = c.search(q, int(sys.argv[2]) if len(sys.argv) > 2 else 0, int(sys.argv[3]) if len(sys.argv) > 3 else 10)
    print(r["numFound"])
    for p in r["patents"][:10]:
        print(p["guid"], p.get("datePublished"), (p.get("inventionTitle") or "")[:60], p.get("type"))
