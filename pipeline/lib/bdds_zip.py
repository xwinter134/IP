"""Read ZIP archives on the EPO BDDS public download API through HTTP Range requests (stdlib only).

Key-free public endpoint (not the Publication Server, so it does not share its rate limit):
  https://publication-bdds.apps.epo.org/bdds/bdds-bff-service/prod/api/public/products/<id>            listing (JSON)
  .../products/<id>/delivery/<deliveryId>/item/<itemId>/download                                        file, Accept-Ranges: bytes
Copied from the probe (bdds_remote_zip.py) and hardened: generic user agent, retries with back-off,
a pacing pause before every request, byte/request counters.
"""
import io
import json
import sys
import time
import urllib.request

API = "https://publication-bdds.apps.epo.org/bdds/bdds-bff-service/prod/api/public/products"
UA = "Mozilla/5.0 (compatible; patent-research-client)"


def product_listing(product_id, timeout=60):
    req = urllib.request.Request("%s/%s" % (API, product_id), headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def download_url(product_id, delivery_id, item_id):
    return "%s/%s/delivery/%s/item/%s/download" % (API, product_id, delivery_id, item_id)


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP Range requests with an 8-block read-ahead cache."""

    def __init__(self, url, block=1 << 20, pause=1.0, timeout=120):
        self.url, self.pos, self.block, self.pause, self.timeout = url, 0, block, pause, timeout
        self.nreq = self.nbytes = 0
        self._cache = {}
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            self.size = int(r.headers["Content-Range"].split("/")[1])
            r.read()

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _get(self, a, b):
        last = None
        for attempt in range(5):
            time.sleep(self.pause + 5 * attempt)
            req = urllib.request.Request(self.url, headers={"User-Agent": UA, "Range": "bytes=%d-%d" % (a, b)})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = r.read()
                if len(data) != b - a + 1:
                    raise IOError("short read %d/%d" % (len(data), b - a + 1))
                self.nreq += 1
                self.nbytes += len(data)
                return data
            except Exception as e:  # IncompleteRead / resets were observed on multi-GB items
                last = e
                print("range retry %d: %s" % (attempt, repr(e)[:120]), file=sys.stderr, flush=True)
        raise last

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        out = bytearray()
        while len(out) < n:
            bi = (self.pos + len(out)) // self.block
            if bi not in self._cache:
                a = bi * self.block
                b = min(self.size, a + 8 * self.block) - 1
                data = self._get(a, b)
                for k in range(0, len(data), self.block):
                    self._cache[bi + k // self.block] = data[k:k + self.block]
                if len(self._cache) > 64:
                    for key in sorted(self._cache)[:-32]:
                        del self._cache[key]
            blk = self._cache[bi]
            o = (self.pos + len(out)) - bi * self.block
            out += blk[o:o + n - len(out)]
        self.pos += n
        return bytes(out[:n])
