"""Shared helpers: publication-number normalisation, polite HTTP, atomic files, JSONL logs, progress.

Stdlib only.  Import with pipeline/ and pipeline/lib/ on sys.path:  `import util`.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import config as _cfg
    _UA, _MIN_INTERVAL = _cfg.USER_AGENT, _cfg.MIN_INTERVAL_S
    _TIMEOUT, _RETRIES = _cfg.HTTP_TIMEOUT_S, _cfg.HTTP_RETRIES
    _BACKOFF, _BACKOFF_MAX = _cfg.BACKOFF_BASE_S, _cfg.BACKOFF_MAX_S
except Exception:  # usable without config on the path
    _UA, _MIN_INTERVAL, _TIMEOUT, _RETRIES, _BACKOFF, _BACKOFF_MAX = "Mozilla/5.0", 1.1, 120, 4, 5, 300


# ----------------------------------------------------------------------------- numbers
_PN_RE = re.compile(r"^(EP|US|WO)([A-Z]{0,2}\d+)([A-Z]\d?)?$")


def split_pn(s: str):
    """Any common spelling -> (auth, number, kind) with the canonical number width, or None.

    'EP-1902714-B1' | 'EP 1 902 714 B1' | 'EP3532103NWB1'   -> ('EP', '1902714', 'B1')   (7 digits, zero padded)
    'US-8058069-B2' | 'US8,058,069 B2'                       -> ('US', '8058069', 'B2')   (grants: as given)
    'US-20170210697-A1' | 'US2017/0210697A1' | 'US2017210697A1' -> ('US', '20170210697', 'A1') (yyyy + 7 digits)
    'US-RE38912-E1'                                          -> ('US', 'RE38912', 'E1')
    'WO-2017075531-A1' | 'WO2017/075531A1' | 'WO17075531'    -> ('WO', '2017075531', 'A1') (yyyy + 6 digits)
    The kind is '' when the input carries none.
    """
    if not s:
        return None
    t = re.sub(r"[\s./,\-]", "", str(s).upper())
    m = re.match(r"^EP(\d{1,7})(?:NW|W\d)([AB]\d)$", t)      # publication-server id
    if m:
        return "EP", "%07d" % int(m.group(1)), m.group(2)
    m = _PN_RE.match(t)
    if not m:
        return None
    auth, num, kind = m.group(1), m.group(2), m.group(3) or ""
    if auth == "EP":
        if not num.isdigit() or len(num) > 7:
            return None
        num = "%07d" % int(num)
    elif auth == "US":
        if num.isdigit():
            if len(num) == 10 and num[:2] in ("19", "20"):      # yyyy + 6 digits (Espacenet style)
                num = num[:4] + "0" + num[4:]
            elif len(num) > 11:
                return None
            elif len(num) < 9:
                num = str(int(num))                             # grants: no leading zeros
        elif not re.match(r"^(RE|PP|D|H|T)\d+$", num):
            return None
    else:  # WO
        if not num.isdigit():
            return None
        if len(num) == 8:                                       # yy + 6 digits
            yy = int(num[:2])
            num = ("19" if yy >= 78 else "20") + num
        elif len(num) == 9:                                     # yyyy + 5 digits (before 2004 style)
            num = num[:4] + "0" + num[4:]
        elif len(num) != 10:
            return None
    return auth, num, kind


def canon_pn(s: str):
    """-> 'EP3532103B1' | 'US8058069B2' | 'US20170210697A1' | 'WO2017075531A1' (None if unparseable)."""
    p = split_pn(s)
    return "".join(p) if p else None


def us_guid(pn: str):
    """Canonical US pn -> ppubs guid 'US-8058069-B2' / 'US-20170210697-A1'."""
    p = split_pn(pn)
    if not p or p[0] != "US" or not p[2]:
        return None
    return "US-%s-%s" % (p[1], p[2])


def us_source(pn: str):
    """ppubs database of a US publication: 11-digit numbers are pre-grant publications."""
    p = split_pn(pn)
    if not p or p[0] != "US":
        return None
    return "US-PGPUB" if (p[1].isdigit() and len(p[1]) == 11) else "USPAT"


def ep_fetch_id(number: str, kind: str, correction_code: str | None = None) -> str:
    """('3532103', 'B1') -> 'EP3532103NWB1' (publication-server id; B9/A9 default to W1)."""
    cc = correction_code or ("W1" if kind[1:] in ("8", "9") else "NW")
    return "EP%07d%s%s" % (int(number), cc, kind)


def norm_cpc(s: str) -> str:
    """'A61K 9/5123' | 'A61K9-5123' | 'A61K   9/5123' -> 'A61K9/5123'."""
    return re.sub(r"\s+", "", str(s)).replace("-", "/")


def to_date(v):
    """'2021-07-21' | '20210721' | date | datetime -> datetime.date (None if empty/unparseable)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    s = str(v).strip()[:10]
    try:
        if re.match(r"^\d{8}$", s[:8]) and "-" not in s:
            return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


# ----------------------------------------------------------------------------- files
def atomic_write(path: str, data, mode: str = "wb"):
    """Write via <path>.part + rename so a killed run never leaves a truncated file."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".part"
    if isinstance(data, str):
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
    else:
        with open(tmp, mode) as f:
            f.write(data)
    os.replace(tmp, path)


def write_json(path: str, obj, indent=1):
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=indent, default=str))


def read_json(path: str, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def append_jsonl(path: str, rec: dict):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def read_jsonl(path: str):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass          # a torn last line of an interrupted run
    except OSError:
        pass
    return out


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ----------------------------------------------------------------------------- polite HTTP
class Pacer:
    """Guarantees a minimum interval between requests of one sequential stream (one per host)."""

    def __init__(self, min_interval: float = _MIN_INTERVAL):
        self.min_interval = min_interval
        self.last = 0.0

    def wait(self):
        d = self.min_interval - (time.time() - self.last)
        if d > 0:
            time.sleep(d)

    def mark(self):
        self.last = time.time()


class HttpFailure(Exception):
    """Final failure of a request. .status is the HTTP status (None for network errors)."""

    def __init__(self, url, status, body=b"", headers=None):
        super().__init__("%s -> %s %r" % (url, status, body[:120]))
        self.url, self.status, self.body, self.headers = url, status, body, headers or {}


def http_request(url: str, data: bytes | None = None, headers: dict | None = None, pacer: Pacer | None = None,
                 timeout: int = _TIMEOUT, retries: int = _RETRIES, permanent=None):
    """GET (or POST when data is given) -> (body bytes, lower-cased response headers).

    Honours HTTPS_PROXY / SSL_CERT_FILE from the environment (urllib default).  Exponential backoff
    (5, 10, 20, ... s) on 429/403/5xx and network errors; other 4xx fail at once.
    `permanent(status, body) -> bool` marks answers that must not be retried (e.g. the EPO
    "500 code 9000" not-found reply).  Raises HttpFailure after the last attempt.
    """
    h = {"User-Agent": _UA}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        if pacer:
            pacer.wait()
        req = urllib.request.Request(url, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if pacer:
                    pacer.mark()
                return body, {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            if pacer:
                pacer.mark()
            body = e.read()[:2000]
            hd = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
            last = HttpFailure(url, e.code, body, hd)
            if permanent and permanent(e.code, body):
                raise last
            if e.code not in (403, 429) and e.code < 500:
                raise last
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if pacer:
                pacer.mark()
            last = HttpFailure(url, None, repr(e).encode())
        if attempt < retries:
            time.sleep(min(_BACKOFF * (2 ** attempt), _BACKOFF_MAX))
    raise last


# ----------------------------------------------------------------------------- progress
class Progress:
    """p = Progress(total, every=100); p.tick(extra='...') prints rate and ETA every `every` items."""

    def __init__(self, total: int, every: int = 100, label: str = ""):
        self.total, self.every, self.label = total, every, label
        self.n = 0
        self.t0 = time.time()

    def tick(self, extra: str = "", force: bool = False):
        self.n += 1
        if force or self.n % self.every == 0 or self.n == self.total:
            el = time.time() - self.t0
            rate = self.n / el if el > 0 else 0.0
            eta = (self.total - self.n) / rate if rate > 0 else 0.0
            log("%s %d/%d  %.2f/s  elapsed %s  ETA %s  %s" % (
                self.label, self.n, self.total, rate, fmt_dur(el), fmt_dur(eta), extra))


def fmt_dur(s: float) -> str:
    s = int(s)
    return "%dh%02dm%02ds" % (s // 3600, s % 3600 // 60, s % 60) if s >= 3600 else "%dm%02ds" % (s // 60, s % 60)


if __name__ == "__main__":
    for x in sys.argv[1:]:
        print(x, "->", canon_pn(x))
