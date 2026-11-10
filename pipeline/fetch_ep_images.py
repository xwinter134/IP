#!/usr/bin/env python3
"""Claim formula images of EP publications: Publication Server document.zip -> trimmed PNG.

EP claims hold structure formulae only as TIFF images (placeholder `[chem]`, ids such as imgb0374).
For every candidate publication this script reads, by HTTP range requests, only the central directory
of document.zip and the TIFF members that are referenced from claims (not the PDF, not description
images), converts them to small PNGs and records them.

  python3 -I pipeline/fetch_ep_images.py [--limit N] [--max-hours H] [--budget-mb 25]
                                         [--interval 3] [--pn EP3986866B1 ...] [--retry-failed] [--dry-run]

Outputs (under data/work/img/):
  <pn>/<imgid>.png     e.g. EP3986866B1/imgb0374.png
  index.jsonl          one line per image: {"pn","img","claim","w","h","bytes"}   (claim = first claim citing it)
  done.jsonl           one line per processed document: {"pn","id","ok","n","zip_bytes","fetched_bytes","reqs","err","ts"}

Candidates (priority order): corpus rows (data/work/corpus.jsonl.gz) of auth EP with has_chem_img and a
cached data/cache/ep/<id>.xml; seed families first (seed_tier 1, 2, ...), then tier 1, 2, ... newest first.
Resumable and incremental: documents in done.jsonl are skipped (failures only with --retry-failed),
and the order is recomputed from the corpus on every run.  Strictly sequential, one request per --interval
seconds (default 3), generic User-Agent, stops on 403/429 after the backoff of util.http_request and after
5 consecutive failures.  Stdlib + Pillow.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import struct
import sys
import time
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as C  # noqa: E402
import util as U  # noqa: E402
import epo_pubserver as EPO  # noqa: E402

IMG_DIR = os.path.join(C.WORK, "img")
INDEX = os.path.join(IMG_DIR, "index.jsonl")
DONE = os.path.join(IMG_DIR, "done.jsonl")
CORPUS = os.path.join(C.WORK, "corpus.jsonl.gz")
MAX_W = 900
TAIL = 65536
MAX_SPAN = 8 * 1000 * 1000     # one contiguous range read at most this big, else member by member


# ----------------------------------------------------------------------------- candidates
def load_candidates():
    """-> list of dict(pn, id, imgs{imgid: first claim n}, key) sorted by priority."""
    out = []
    if not os.path.exists(CORPUS):
        U.log("no corpus at", CORPUS, "- run pipeline/normalize.py")
        return out
    with gzip.open(CORPUS, "rt", encoding="utf-8") as f:
        for line in f:
            if '"has_chem_img": true' not in line and '"has_chem_img":true' not in line:
                continue
            r = json.loads(line)
            if r.get("auth") != "EP" or not r.get("has_chem_img"):
                continue
            try:
                fid = EPO.normalize_id(r["pn"])
            except ValueError:
                continue
            if not os.path.exists(os.path.join(C.CACHE_EP, fid + ".xml")):
                continue
            imgs = {}
            for lang in ("en", "de"):
                for c in (r.get("claims") or {}).get(lang, []):
                    for iid in c.get("img") or []:
                        imgs.setdefault(iid, c["n"])
            if not imgs:
                continue
            key = (r["seed_tier"] if r.get("seed_family") and r.get("seed_tier") else (0 if r.get("seed_family") else 9),
                   r.get("tier") or 9, "".join(chr(255 - ord(ch)) for ch in (r.get("pub_date") or "0000")), r["pn"])
            out.append({"pn": r["pn"], "id": fid, "imgs": imgs, "key": key})
    out.sort(key=lambda d: d["key"])
    return out


# ----------------------------------------------------------------------------- zip by range
class Remote:
    """Range reader. If the server ignores Range and answers 200 with the whole file, that body is kept and
    later reads are served from it (no further requests)."""

    def __init__(self, url, pacer):
        self.url, self.pacer, self.reqs, self.bytes, self.full = url, pacer, 0, 0, None

    def get(self, rng):
        """rng 'bytes=a-b' -> (body, content-range total or None)"""
        if self.full is not None:
            a, b = rng[6:].split("-")
            return self.full[int(a):int(b) + 1], len(self.full)
        body, hd = U.http_request(self.url, headers={"Range": rng}, pacer=self.pacer,
                                  permanent=lambda s, b: s in (404, 500) and (b'"code":9000' in b or s == 404))
        self.reqs += 1
        self.bytes += len(body)
        cr = hd.get("content-range", "")
        if "/" in cr:
            return body, int(cr.split("/")[-1])
        self.full = body                       # 200: whole file
        a, b = rng[6:].split("-")
        return body[int(a):int(b) + 1], len(body)


def central_directory(rem):
    """-> (entries{name: (method, csize, usize, lho)}, total_size)"""
    _, total = rem.get("bytes=0-0")
    base = max(0, total - TAIL)
    tail, _ = rem.get("bytes=%d-%d" % (base, total - 1))
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise ValueError("no end-of-central-directory record")
    _, _, _, n_this, n_all, cd_size, cd_off, _ = struct.unpack("<4sHHHHIIH", tail[i:i + 22])
    if cd_off == 0xFFFFFFFF or n_all == 0xFFFF:
        raise ValueError("zip64 not supported")
    if cd_off >= base:
        cd = tail[cd_off - base: cd_off - base + cd_size]
    else:
        cd, _ = rem.get("bytes=%d-%d" % (cd_off, cd_off + cd_size - 1))
    ents, p = {}, 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        (_, _, _, _, method, _, _, _, csize, usize, nl, el, cl, _, _, _, lho) = struct.unpack("<4s6H3I5H2I", cd[p:p + 46])
        name = cd[p + 46:p + 46 + nl].decode("utf-8", "replace")
        ents[name] = (method, csize, usize, lho)
        p += 46 + nl + el + cl
    return ents, total


def read_members(rem, ents, names, total):
    """Fetch the named members (few ranged reads) -> {name: bytes}."""
    sel = sorted(((ents[n][3], n) for n in names))
    if not sel:
        return {}
    ends = {n: ents[n][3] + 30 + 512 + ents[n][1] for n in names}   # header + generous name/extra slack
    groups, cur = [], [sel[0]]
    for o, n in sel[1:]:
        # join into the running group while the whole span stays small and no big foreign gap is read
        if max(ends[m] for _, m in cur) + 200_000 >= o and ends[n] - cur[0][0] <= MAX_SPAN:
            cur.append((o, n))
        else:
            groups.append(cur)
            cur = [(o, n)]
    groups.append(cur)
    out = {}
    for g in groups:
        lo = g[0][0]
        hi = min(total, max(ends[n] for _, n in g)) - 1
        blob, _ = rem.get("bytes=%d-%d" % (lo, hi))
        for o, n in g:
            method, csize, usize, _ = ents[n]
            q = o - lo
            if blob[q:q + 4] != b"PK\x03\x04":
                raise ValueError("bad local header for " + n)
            nl, el = struct.unpack("<HH", blob[q + 26:q + 30])
            s = q + 30 + nl + el
            raw = blob[s:s + csize]
            if len(raw) != csize:
                raise ValueError("short read for " + n)
            out[n] = raw if method == 0 else zlib.decompress(raw, -15)
    return out


# ----------------------------------------------------------------------------- image conversion
def to_png(data: bytes):
    """TIFF bytes -> (png bytes, w, h). Trimmed, longest side <= MAX_W wide, 1-bit when possible else 4 grey levels."""
    from PIL import Image, ImageChops
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im).convert("L")
    else:
        im = im.convert("L")
    # trim white margins (keep a small pad)
    bw = im.point(lambda v: 255 if v < 200 else 0)
    box = bw.getbbox()
    if box:
        pad = 6
        box = (max(0, box[0] - pad), max(0, box[1] - pad), min(im.width, box[2] + pad), min(im.height, box[3] + pad))
        im = im.crop(box)
    if im.width > MAX_W:
        h = max(1, round(im.height * MAX_W / im.width))
        im = im.resize((MAX_W, h), Image.LANCZOS)
        # re-darken thin lines lost by averaging, then reduce to 4 grey levels
        im = im.point(lambda v: 0 if v < 110 else (85 if v < 170 else (170 if v < 235 else 255)))
        im = im.point(lambda v: 0 if v < 43 else (1 if v < 128 else (2 if v < 200 else 3)))
        im.putpalette([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255])
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True, bits=2)
    else:
        im = im.point(lambda v: 255 if v >= 160 else 0).convert("1")
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
    return buf.getvalue(), im.width, im.height


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--limit", type=int, default=150, help="max documents (zips) to fetch in this run")
    ap.add_argument("--max-hours", type=float, default=None)
    ap.add_argument("--budget-mb", type=float, default=25.0, help="stop when the PNG files in data/work/img reach this size")
    ap.add_argument("--interval", type=float, default=3.0, help="seconds between requests")
    ap.add_argument("--pn", nargs="*", help="only these publication numbers (e.g. EP3986866B1)")
    ap.add_argument("--max-per-doc", type=int, default=60, help="at most this many images per publication (lowest claim numbers first)")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="list the next candidates and exit")
    a = ap.parse_args()

    os.makedirs(IMG_DIR, exist_ok=True)
    done = {}
    for r in U.read_jsonl(DONE):
        done[r["pn"]] = r
    indexed = {(o["pn"], o["img"]) for o in U.read_jsonl(INDEX)}
    used = sum(o.get("bytes", 0) for o in U.read_jsonl(INDEX))

    cands = load_candidates()
    if a.pn:
        want = set(a.pn)
        cands = [c for c in cands if c["pn"] in want]
    todo = [c for c in cands if c["pn"] not in done or (a.retry_failed and not done[c["pn"]].get("ok"))]
    U.log("candidates %d, done %d, todo %d, used %.2f MB of %.1f MB" % (len(cands), len(done), len(todo), used / 1e6, a.budget_mb))
    if a.dry_run:
        for c in todo[:30]:
            print(c["pn"], c["key"][:2], len(c["imgs"]), "images")
        return 0

    pacer = U.Pacer(a.interval)
    t0 = time.time()
    n_doc = n_img = fails = 0
    fetched = 0
    for c in todo:
        if n_doc >= a.limit:
            break
        if a.max_hours and time.time() - t0 > a.max_hours * 3600:
            U.log("max-hours reached")
            break
        if used >= a.budget_mb * 1e6:
            U.log("budget reached (%.2f MB)" % (used / 1e6))
            break
        if fails >= 5:
            U.log("5 consecutive failures - stopping")
            break
        rem = Remote("%s/patents/%s/document.zip" % (EPO.REST, c["id"]), pacer)
        rec = {"pn": c["pn"], "id": c["id"], "ok": False, "n": 0, "zip_bytes": None, "fetched_bytes": 0, "reqs": 0, "err": None, "ts": U.now_iso()}
        try:
            ents, total = central_directory(rem)
            rec["zip_bytes"] = total
            by_stem = {}
            for name in ents:
                stem = os.path.splitext(os.path.basename(name))[0].lower()
                if name.lower().endswith((".tif", ".tiff", ".png", ".jpg", ".gif")):
                    by_stem[stem] = name
            ordered = sorted(c["imgs"], key=lambda i: (c["imgs"][i], i))
            need = {iid: by_stem[iid.lower()] for iid in ordered if iid.lower() in by_stem}
            missing = [i for i in ordered if i not in need]
            if len(need) > a.max_per_doc:
                rec["capped"] = len(need)
                need = dict(list(need.items())[:a.max_per_doc])
            members = read_members(rem, ents, list(need.values()), total)
            d = os.path.join(IMG_DIR, c["pn"])
            os.makedirs(d, exist_ok=True)
            for iid, name in need.items():
                try:
                    png, w, h = to_png(members[name])
                except Exception as e:      # undecodable image: skip it, keep the rest
                    U.log("  convert failed", c["pn"], iid, repr(e)[:100])
                    continue
                U.atomic_write(os.path.join(d, iid + ".png"), png)
                if (c["pn"], iid) not in indexed:
                    U.append_jsonl(INDEX, {"pn": c["pn"], "img": iid, "claim": c["imgs"][iid], "w": w, "h": h, "bytes": len(png)})
                    indexed.add((c["pn"], iid))
                used += len(png)
                n_img += 1
                rec["n"] += 1
            rec["ok"] = True
            if missing:
                rec["missing"] = missing[:20]
            fails = 0
        except EPO.NotFound:
            rec["err"] = "not found"
        except U.HttpFailure as e:
            rec["err"] = "http %s" % e.status
            if e.status in (403, 429):
                U.log("throttled (%s) - stopping" % e.status)
                rec["reqs"], rec["fetched_bytes"] = rem.reqs, rem.bytes
                U.append_jsonl(DONE, rec)
                break
            fails += 1
        except Exception as e:
            rec["err"] = repr(e)[:200]
            fails += 1
        rec["reqs"], rec["fetched_bytes"] = rem.reqs, rem.bytes
        fetched += rem.bytes
        U.append_jsonl(DONE, rec)
        n_doc += 1
        el = time.time() - t0
        U.log("%s ok=%s images=%d/%d zip=%s got=%d kB reqs=%d %s  [%d docs, %.1f s/doc]" % (
            c["pn"], rec["ok"], rec["n"], len(c["imgs"]), rec["zip_bytes"], rem.bytes // 1000, rem.reqs, rec["err"] or "",
            n_doc, el / n_doc))
    el = time.time() - t0
    U.log("run: %d docs, %d images, %.1f MB transferred, %.0f s; PNG total %.2f MB" % (n_doc, n_img, fetched / 1e6, el, used / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
