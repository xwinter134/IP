"""Locate and download single chunks of the EP Register ST.36 snapshot (BDDS product 16) by HTTP Range.

The snapshot is one 14.8 GB ZIP whose members are chunk ZIPs `DOC/<from>-<to>/epregister_st36_<from>-<to>.zip`
(~20 MB each, ~10k application numbers per chunk).  The central directory (763 entries, ~0.8 MB) is read once and
cached as <cache>/index.json; afterwards a chunk is one plain Range request for its raw deflate stream.
"""
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bdds_zip as B  # noqa: E402

PRODUCT = 16


def latest_delivery():
    d = B.product_listing(PRODUCT)
    dl = max(d["deliveries"], key=lambda x: x["deliveryPublicationDatetime"])
    item = dl["items"][0]
    return {"deliveryId": dl["deliveryId"], "itemId": item["itemId"], "itemName": item["itemName"],
            "size": item.get("fileSize"), "published": dl["deliveryPublicationDatetime"]}


def load_index(cache_dir, refresh=False):
    """Return {"deliveryId", "itemId", "chunks": [{name, lo, hi, offset, csize, size, ctype}]}; reads the
    remote central directory when no (matching) cached index exists."""
    path = os.path.join(cache_dir, "index.json")
    if not refresh and os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    dv = latest_delivery()
    url = B.download_url(PRODUCT, dv["deliveryId"], dv["itemId"])
    f = B.HttpRangeFile(url)
    z = zipfile.ZipFile(f)
    chunks = []
    for m in z.infolist():
        mm = re.search(r"_(\d+)-(\d+)\.zip$", m.filename)
        if mm:
            chunks.append({"name": m.filename.rsplit("/", 1)[-1], "lo": int(mm.group(1)), "hi": int(mm.group(2)),
                           "offset": m.header_offset, "csize": m.compress_size, "size": m.file_size, "ctype": m.compress_type})
    chunks.sort(key=lambda c: c["lo"])
    idx = {"deliveryId": dv["deliveryId"], "itemId": dv["itemId"], "published": dv["published"], "url": url,
           "total": f.size, "chunks": chunks}
    os.makedirs(cache_dir, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(idx, fh)
    os.replace(tmp, path)
    return idx


def _range(url, a, b, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": B.UA, "Range": "bytes=%d-%d" % (a, b)})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if len(data) != b - a + 1:
        raise IOError("short read %d/%d" % (len(data), b - a + 1))
    return data


def fetch_chunk(idx, chunk, pause=1.0, piece=4 << 20):
    """Return (chunk zip bytes, stats).  Resumes a piece on failure (5 tries per piece)."""
    url = idx["url"]
    # local file header: 30 bytes + name + extra (lengths at offset 26/28)
    time.sleep(pause)
    hdr = _range(url, chunk["offset"], chunk["offset"] + 29)
    nlen, elen = int.from_bytes(hdr[26:28], "little"), int.from_bytes(hdr[28:30], "little")
    start = chunk["offset"] + 30 + nlen + elen
    end = start + chunk["csize"] - 1
    d = zlib.decompressobj(-15) if chunk["ctype"] == 8 else None
    out = bytearray()
    nreq, nbytes = 1, 30
    pos = start
    while pos <= end:
        b = min(end, pos + piece - 1)
        last = None
        for attempt in range(5):
            time.sleep(pause + 5 * attempt)
            try:
                data = _range(url, pos, b)
                break
            except Exception as e:
                last = e
                print("range retry %d: %s" % (attempt, repr(e)[:100]), file=sys.stderr, flush=True)
        else:
            raise last
        nreq += 1
        nbytes += len(data)
        out += d.decompress(data) if d else data
        pos = b + 1
    if d:
        out += d.flush()
    if len(out) != chunk["size"]:
        raise IOError("chunk size mismatch %d != %d" % (len(out), chunk["size"]))
    return bytes(out), {"requests": nreq, "bytes": nbytes}
