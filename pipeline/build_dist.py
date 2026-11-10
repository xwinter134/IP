#!/usr/bin/env python3
"""Stage 3: assemble dist/ (layout and formats: docs/ARCHITECTURE.md, "Stage 3").

  python3 pipeline/build_dist.py [--out dist] [--budget-mb 215] [--enc bin|b64] [--max-files 500]
                                 [--limit N] [--img-budget-mb 25] [--no-chem] [--no-web] [--force]

Input  : data/work/corpus.jsonl.gz (pipeline/normalize.py), optional data/work/status.jsonl.gz,
         data/work/chem/ (files named in chem.json "publish"), optional data/work/img/, data/seed/, web/
Output : dist/  = page + engines + data files, dist/data/manifest.json, dist/publish_batches.json
         data/work/dist_build/  = work files (corpus snapshot link, text index, keep list, cut list, size model)

Size budget: everything in dist/ must stay below --budget-mb (host limit 240 MB, 500 files, 15 MB per file).
When the full text does not fit, full text is kept by priority and the rest is degraded, in this order:
  1. seed-family publications keep claims and definition paragraphs,
  2. claims of all other publications by priority (seed tier, then tier 1..5 (0 = seed only first), newest first),
  3. definition paragraphs in the same priority order with what is left.
A publication that loses its claims stays in the patent table (biblio, title/abstract/assignee search, status,
compounds) and gets flag bit5; one that only loses its definitions gets flag bit6. The cut is logged, written to
data/work/dist_build/cut.jsonl and summarised in manifest.json "cut".

Safe to re-run at any time, also while the downloads and normalize.py are running: the corpus is read through a
hard link taken at start (normalize.py replaces the file atomically), the text index is rebuilt only when the
corpus, the keep list or the builder changed, and files in dist/ are rewritten only when their content changed.
"""
import argparse
import array
import base64
import datetime
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as C  # noqa: E402

HOST_MAX_FILE = 15 * 1000 * 1000
HOST_MAX_TOTAL_MB = 240
BATCH_FILES = 240
BATCH_BYTES = 60 * 1000 * 1000
PAT_CHUNK = 4000
ST_CODES = ["", "granted", "pending", "lapsed", "revoked", "withdrawn", "refused", "expired", "unknown"]
AUTHS = ["EP", "US", "WO"]
NAME_OK = re.compile(r"^[a-z0-9._/-]+$")
T0 = time.time()


def log(*a):
    print("[build_dist %6.1fs]" % (time.time() - T0), *a, flush=True)


def gz(data, level=9):
    """Deterministic gzip (no mtime, no file name)."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=level, mtime=0) as f:
        f.write(data)
    return buf.getvalue()


def jdump(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def ymd(s):
    """'2017-10-26' -> 20171026, anything else -> 0"""
    if not s or len(s) < 10:
        return 0
    try:
        return int(s[0:4]) * 10000 + int(s[5:7]) * 100 + int(s[8:10])
    except ValueError:
        return 0


def b64len(n):
    return (n + 2) // 3 * 4


class Dist:
    """Collects the files of dist/, converts binaries for --enc b64, writes only what changed."""

    def __init__(self, out, enc):
        self.out, self.enc = out, enc
        self.files = {}          # rel path -> (bytes, sha256)
        self.comp = {}           # component -> bytes
        self.written = self.unchanged = 0

    def phys(self, rel):
        return re.sub(r"\.bin$", ".b64.txt", rel) if self.enc == "b64" and rel.endswith(".bin") else rel

    def put(self, rel, data, comp):
        if isinstance(data, str):
            with open(data, "rb") as f:
                data = f.read()
        if self.enc == "b64" and rel.endswith(".bin"):
            data = base64.b64encode(data)
        rel = self.phys(rel)
        if not NAME_OK.match(rel):
            raise SystemExit("file name not allowed on the host (only [a-z0-9._/-]): " + rel)
        if len(data) > HOST_MAX_FILE:
            raise SystemExit("%s is %.1f MB, the host accepts at most 15 MB per file" % (rel, len(data) / 1e6))
        sha = hashlib.sha256(data).hexdigest()
        path = os.path.join(self.out, rel)
        same = False
        if os.path.exists(path) and os.path.getsize(path) == len(data):
            with open(path, "rb") as f:
                same = hashlib.sha256(f.read()).hexdigest() == sha
        if same:
            self.unchanged += 1
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            self.written += 1
        self.files[rel] = (len(data), sha)
        self.comp[comp] = self.comp.get(comp, 0) + len(data)
        return len(data)

    def total(self):
        return sum(v[0] for v in self.files.values())

    def prune(self):
        """Remove files of an earlier build that are not part of this one."""
        gone = 0
        for root, dirs, names in os.walk(self.out):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), self.out).replace(os.sep, "/")
                if rel not in self.files and rel != "publish_batches.json":
                    os.remove(os.path.join(root, n))
                    gone += 1
        for root, dirs, names in os.walk(self.out, topdown=False):
            if root != self.out and not os.listdir(root):
                os.rmdir(root)
        return gone


def snapshot_corpus(src, build_dir):
    """Hard link (or copy) so that both passes and the Node builder read the same version."""
    dst = os.path.join(build_dir, "corpus.snap.jsonl.gz")
    st = os.stat(src)
    if os.path.exists(dst):
        d = os.stat(dst)
        if d.st_ino == st.st_ino or (d.st_size == st.st_size and int(d.st_mtime) == int(st.st_mtime)):
            return dst, st
        os.remove(dst)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)
    return dst, os.stat(dst)


def load_status_file(path):
    """Optional status.jsonl.gz -> {pn: json line}; tolerant of a file that is being written."""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                    out[o["pn"]] = line.strip()
                except (ValueError, KeyError):
                    continue
    except (OSError, EOFError) as e:
        log("status file only partly readable (%s); using %d entries" % (e, len(out)))
    return out


def read_corpus(path, limit, players, status_extra, st_sink):
    """One pass over the corpus -> light rows (no claim text). Status detail goes straight to st_sink."""
    rows = []
    pidx = {n: i for i, n in enumerate(players)}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            if limit and len(rows) >= limit:
                break
            r = json.loads(line)
            st = r.get("status")
            if st is None and r["pn"] in status_extra:
                st = json.loads(status_extra[r["pn"]])
            cl = r.get("claims") or {}
            ncl = len(cl.get("en") or []) + len(cl.get("de") or [])
            cchars = sum(len(c["t"]) for c in (cl.get("en") or [])) + sum(len(c["t"]) for c in (cl.get("de") or []))
            player = r.get("player")
            if player and player not in pidx:
                pidx[player] = len(players)
                players.append(player)
            ti = r.get("title") or {}
            de_in = 2
            if st is not None and st.get("in_force_de") is not None:
                de_in = 1 if st["in_force_de"] else 0
            code = (st or {}).get("code") or ""
            rows.append({
                "pn": r["pn"], "auth": r["auth"], "kind": r.get("kind") or "",
                "pub": ymd(r.get("pub_date")), "app": ymd(r.get("app_date")), "prio": ymd(r.get("priority_date")),
                "grant": ymd(r.get("grant_date")), "appNo": r.get("app_number") or "",
                "fam": int(r["family"]) if r.get("family") is not None else 0,
                "title": ti.get("en") or ti.get("de") or "",
                "asg": "; ".join(r.get("assignees") or []),
                "player": pidx[player] if player else -1,
                "cpc": r.get("cpc") or [], "tier": int(r.get("tier") or 0), "seedTier": int(r.get("seed_tier") or 0),
                "seedFam": r.get("seed_family") or "",
                "text": bool(r.get("text")) and ncl > 0, "ncl": ncl, "cchars": cchars + len(r.get("abstract") or ""),
                "dchars": sum(len(d) for d in (r.get("defs") or [])),
                "img": bool(r.get("has_chem_img")), "wo": r.get("wo") or "",
                "st": ST_CODES.index(code) if code in ST_CODES else ST_CODES.index("unknown"),
                "hasSt": st is not None, "exp": ymd((st or {}).get("expiry_est")), "deIn": de_in,
                "asof": (st or {}).get("asof") if (st or {}).get("src") == "ep-register" else None,
            })
            st_sink(st)
            if len(rows) % 20000 == 0:
                log("corpus: %d records" % len(rows))
    return rows


def priority_key(r):
    """Smaller = kept first: seed tier 1, seed tier 2, then tier 0 (seed only), 1..5, newest first."""
    return (r["seedTier"] if r["seedTier"] else 9, r["tier"], -r["pub"], r["pn"])


def build_patent_files(rows, levels, has_comp, players):
    """-> dict rel -> bytes (gz payloads) for pat-NNN, meta, pn, cpc."""
    out = {}
    P = len(rows)
    kinds = sorted({r["kind"] for r in rows})
    kidx = {k: i for i, k in enumerate(kinds)}
    flags = []
    for i, r in enumerate(rows):
        lv = levels[i]
        fl = 0
        if r["text"] and lv >= 1:
            fl |= 1
        if r["dchars"] and lv >= 2:
            fl |= 2
        if r["img"] and (fl & 1):
            fl |= 4
        if r["pn"] in has_comp:
            fl |= 8
        if r["hasSt"]:
            fl |= 16
        if r["text"] and lv < 1:
            fl |= 32
        if r["dchars"] and lv < 2:
            fl |= 64
        flags.append(fl)
    # patent table chunks (columnar JSON)
    pat_files = []
    for ci in range(0, P, PAT_CHUNK):
        ch = rows[ci:ci + PAT_CHUNK]
        names, nidx, asg = [], {}, []
        for r in ch:
            j = nidx.get(r["asg"])
            if j is None:
                j = nidx[r["asg"]] = len(names)
                names.append(r["asg"])
            asg.append(j)
        col = {
            "pn": [r["pn"] for r in ch], "auth": [r["auth"] for r in ch], "kind": [r["kind"] for r in ch],
            "pub": [r["pub"] for r in ch], "app": [r["app"] for r in ch], "prio": [r["prio"] for r in ch],
            "grant": [r["grant"] for r in ch], "appNo": [r["appNo"] for r in ch],
            "fam": [r["fam"] for r in ch], "title": [r["title"] for r in ch], "asg": asg, "asgNames": names,
            "player": [r["player"] for r in ch], "cpc": ["|".join(r["cpc"]) for r in ch],
            "tier": [r["tier"] for r in ch], "seedTier": [r["seedTier"] for r in ch], "seedFam": [r["seedFam"] for r in ch],
            "flags": flags[ci:ci + PAT_CHUNK], "st": [r["st"] if r["hasSt"] else 0 for r in ch],
            "exp": [r["exp"] for r in ch], "deIn": [r["deIn"] for r in ch], "wo": [r["wo"] for r in ch],
        }
        name = "data/pat-%03d.gz.bin" % (ci // PAT_CHUNK)
        out[name] = gz(jdump(col))
        pat_files.append(os.path.basename(name))
    # meta: binary columns for filters and facets
    c4names = sorted({c[:4] for r in rows for c in r["cpc"]})
    c4i = {n: i for i, n in enumerate(c4names)}
    c4off, c4ent = array.array("I", [0]), array.array("H")
    for r in rows:
        seen = []
        for c in r["cpc"]:
            j = c4i[c[:4]]
            if j not in seen:
                seen.append(j)
        c4ent.extend(seen)
        c4off.append(len(c4ent))
    cols = [
        ("fam", "i32", array.array("i", [max(-2**31, min(2**31 - 1, r["fam"])) for r in rows])),
        ("pub", "u32", array.array("I", [r["pub"] for r in rows])),
        ("prio", "u32", array.array("I", [r["prio"] for r in rows])),
        ("exp", "u32", array.array("I", [r["exp"] for r in rows])),
        ("c4off", "u32", c4off),
        ("c4", "u16", c4ent),
        ("auth", "u8", bytes(AUTHS.index(r["auth"]) if r["auth"] in AUTHS else 255 for r in rows)),
        ("kind", "u8", bytes(kidx[r["kind"]] for r in rows)),
        ("player", "u8", bytes(r["player"] if r["player"] >= 0 else 255 for r in rows)),
        ("tier", "u8", bytes(min(255, r["tier"]) for r in rows)),
        ("seedTier", "u8", bytes(min(255, r["seedTier"]) for r in rows)),
        ("flags", "u8", bytes(flags)),
        ("st", "u8", bytes(r["st"] if r["hasSt"] else 0 for r in rows)),
        ("deIn", "u8", bytes(r["deIn"] for r in rows)),
    ]
    body, desc = bytearray(), []
    for name, typ, arr in cols:
        if sys.byteorder != "little" and not isinstance(arr, bytes):
            arr = array.array(arr.typecode, arr)
            arr.byteswap()
        raw = arr if isinstance(arr, bytes) else arr.tobytes()
        while len(body) % 4:
            body.append(0)
        desc.append({"name": name, "type": typ, "off": len(body), "n": len(arr)})
        body.extend(raw)
    head = jdump({"v": 1, "P": P, "cols": desc, "auth": AUTHS, "kinds": kinds, "st": ST_CODES, "c4": c4names})
    pad = b"\0" * ((4 - (4 + len(head)) % 4) % 4)
    out["data/meta.gz.bin"] = gz(struct.pack("<I", len(head)) + head + pad + bytes(body))
    out["data/pn.gz.bin"] = gz("\n".join(r["pn"] for r in rows).encode("ascii"))
    # full CPC codes for the cpc: filter
    codes = sorted({c for r in rows for c in r["cpc"]})
    ci_ = {c: i for i, c in enumerate(codes)}
    width = 2 if len(codes) < 65536 else 4
    off, ent = array.array("I", [0]), array.array("H" if width == 2 else "I")
    for r in rows:
        ent.extend(sorted({ci_[c] for c in r["cpc"]}))
        off.append(len(ent))
    if sys.byteorder != "little":
        off.byteswap()
        ent.byteswap()
    head = jdump({"v": 1, "codes": codes, "n": len(ent), "width": width})
    pad = b"\0" * ((4 - (4 + len(head)) % 4) % 4)
    out["data/cpc.gz.bin"] = gz(struct.pack("<I", len(head)) + head + pad + off.tobytes() + ent.tobytes())
    return out, pat_files, flags, kinds


def build_images(img_dir, pn_to_p, rows, budget_bytes, enc):
    """Claim formula images -> packs. Returns (files dict, index object, stats). Tolerates a growing directory."""
    idx_path = os.path.join(img_dir, "index.jsonl")
    if not os.path.exists(idx_path):
        return {}, None, None
    per = {}
    with open(idx_path, encoding="utf-8") as f:
        for line in f:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = pn_to_p.get(o.get("pn"))
            if p is None:
                continue
            per.setdefault(p, {})[o["img"]] = o
    order = sorted(per, key=lambda p: priority_key(rows[p]))
    files, ip, ie = {}, [], []
    pack, pack_no, used, cut, n_img = bytearray(), 0, 0, 0, 0
    PACK = 3 * 1000 * 1000
    fac = 4 / 3 if enc == "b64" else 1

    def flush():
        nonlocal pack, pack_no
        if pack:
            files["data/img-%03d.bin" % pack_no] = bytes(pack)
            pack_no += 1
            pack = bytearray()

    kept = {}
    for p in order:
        ents = []
        for iid, o in sorted(per[p].items(), key=lambda kv: (kv[1].get("claim", 0), kv[0])):
            path = os.path.join(img_dir, rows[p]["pn"], iid + ".png")
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if not data.startswith(b"\x89PNG"):
                continue
            if (used + len(data)) * fac > budget_bytes:
                cut += 1
                continue
            if len(pack) + len(data) > PACK:
                flush()
            ents.append([int(o.get("claim") or 0), iid, int(o.get("w") or 0), int(o.get("h") or 0), pack_no, len(pack), len(data)])
            pack.extend(data)
            used += len(data)
            n_img += 1
        if ents:
            kept[p] = ents
    flush()
    for p in sorted(kept):
        ip.append(p)
        ie.append(kept[p])
    index = {"v": 1, "p": ip, "e": ie}
    packs = ["img-%03d.bin" % i for i in range(pack_no)]
    return files, index, {"images": n_img, "patents": len(ip), "cut": cut, "packs": packs}


def choose_levels(rows, text_budget, model):
    """Greedy by priority. Returns (levels bytearray, estimate bytes)."""
    P = len(rows)
    levels = bytearray(P)
    a, d, base = model["a"], model["d"], model["base"] * P
    left = text_budget - base
    order = sorted((i for i in range(P) if r_has(rows[i])), key=lambda i: priority_key(rows[i]))
    est = base
    # 1. seed families: claims + definitions
    rest = []
    for i in order:
        r = rows[i]
        if r["seedTier"]:
            need = a * r["cchars"] + d * r["dchars"]
            if need <= left:
                levels[i] = 2
                left -= need
                est += need
                continue
        rest.append(i)
    # 2. claims by priority (prefix: stop at the first one that does not fit)
    full = False
    for i in rest:
        need = a * rows[i]["cchars"]
        if not full and need <= left:
            levels[i] = 1
            left -= need
            est += need
        else:
            full = True
    # 3. definitions by priority
    if not full:
        for i in rest:
            need = d * rows[i]["dchars"]
            if need > left:
                break
            levels[i] = 2
            left -= need
            est += need
    for i in range(P):                      # biblio-only records have nothing to cut: mark as complete
        if not r_has(rows[i]):
            levels[i] = 2
    return levels, est


def r_has(r):
    return r["text"] or r["dchars"] > 0


def run_index(snap, snap_stat, levels, idx_dir, max_files, limit, force, build_dir):
    keep_path = os.path.join(build_dir, "keep.bin")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_index.mjs"), "rb") as f:
        code_sha = hashlib.sha256(f.read()).hexdigest()
    with open(os.path.join(C.ROOT, "web", "engine", "tok.js"), "rb") as f:
        code_sha += hashlib.sha256(f.read()).hexdigest()
    key = hashlib.sha256(("%d:%d:%s:%d:%s:%s" % (snap_stat.st_size, snap_stat.st_mtime_ns, hashlib.sha256(bytes(levels)).hexdigest(),
                                                 max_files, limit, code_sha)).encode()).hexdigest()
    key_path = os.path.join(idx_dir, "cache.key")
    if not force and os.path.exists(key_path) and os.path.exists(os.path.join(idx_dir, "index.json")):
        with open(key_path) as f:
            if f.read().strip() == key:
                log("text index is up to date (cache hit), not rebuilt")
                with open(os.path.join(idx_dir, "index.json")) as g:
                    return json.load(g)
    with open(keep_path, "wb") as f:
        f.write(bytes(levels))
    cmd = ["node", "--max-old-space-size=6000", os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_index.mjs"),
           "--corpus", snap, "--out", idx_dir, "--keep", keep_path, "--max-files", str(max_files)]
    if limit:
        cmd += ["--limit", str(limit)]
    log("running", " ".join(cmd[1:]))
    subprocess.run(cmd, check=True)
    with open(key_path, "w") as f:
        f.write(key)
    with open(os.path.join(idx_dir, "index.json")) as g:
        return json.load(g)


def newest_date(d):
    best = 0
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    m = e.stat().st_mtime
                except OSError:
                    continue
                if m > best:
                    best = m
    except OSError:
        return None
    return datetime.datetime.fromtimestamp(best, datetime.timezone.utc).strftime("%Y-%m-%d") if best else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=C.DIST)
    ap.add_argument("--corpus", default=os.path.join(C.WORK, "corpus.jsonl.gz"))
    ap.add_argument("--work", default=C.WORK)
    ap.add_argument("--web", default=os.path.join(C.ROOT, "web"))
    ap.add_argument("--build-dir", default=None, help="work files (default <work>/dist_build)")
    ap.add_argument("--budget-mb", type=float, default=215.0)
    ap.add_argument("--enc", choices=["bin", "b64"], default="bin")
    ap.add_argument("--max-files", type=int, default=500)
    ap.add_argument("--reserve-files", type=int, default=12, help="files kept free for parts that are added later (page, app scripts)")
    ap.add_argument("--img-budget-mb", type=float, default=25.0)
    ap.add_argument("--img-dir", default=None)
    ap.add_argument("--limit", type=int, default=0, help="only the first N corpus records (smoke run)")
    ap.add_argument("--no-chem", action="store_true")
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--force", action="store_true", help="rebuild the text index even when nothing changed")
    a = ap.parse_args()
    if a.budget_mb > HOST_MAX_TOTAL_MB:
        raise SystemExit("--budget-mb must not exceed the host limit of %d MB" % HOST_MAX_TOTAL_MB)
    budget = int(a.budget_mb * 1e6)
    build_dir = a.build_dir or os.path.join(a.work, "dist_build")
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    if not os.path.exists(a.corpus):
        raise SystemExit("corpus not found: %s (run pipeline/normalize.py first)" % a.corpus)
    snap, snap_stat = snapshot_corpus(a.corpus, build_dir)
    dist = Dist(a.out, a.enc)
    fac = (lambda n: b64len(n)) if a.enc == "b64" else (lambda n: n)

    # ------------------------------------------------------------------ seed, players
    def seed_json(name):
        try:
            with open(os.path.join(C.SEED, name), encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            log("seed file missing:", name)
            return []
    seed_fam, seed_asg, seed_cpc, seed_lip = (seed_json(n) for n in
                                              ("seed_families.json", "assignee_variants.json", "cpc_field.json", "ref_lipids_pubchem.json"))
    players = [x["player"] for x in seed_asg if isinstance(x, dict) and x.get("player")]

    # ------------------------------------------------------------------ corpus pass (status chunks are streamed out)
    st_chunks, st_cur = [], []

    def st_sink(st):
        st_cur.append(st)
        if len(st_cur) == PAT_CHUNK:
            st_chunks.append(gz(jdump(st_cur)))
            st_cur.clear()
    status_extra = load_status_file(os.path.join(a.work, "status.jsonl.gz"))
    rows = read_corpus(snap, a.limit, players, status_extra, st_sink)
    if st_cur:
        st_chunks.append(gz(jdump(st_cur)))
    P = len(rows)
    if len(players) > 250:
        raise SystemExit("more than 250 players: the meta column is one byte")
    pn_to_p = {r["pn"]: i for i, r in enumerate(rows)}
    avail_text = sum(1 for r in rows if r["text"])
    avail_defs = sum(1 for r in rows if r["dchars"])
    log("corpus: %d publications, %d with claims (%d claims, %.1f MB claim text), %d with definitions (%.1f MB), %d with status"
        % (P, avail_text, sum(r["ncl"] for r in rows if r["text"]), sum(r["cchars"] for r in rows) / 1e6, avail_defs,
           sum(r["dchars"] for r in rows) / 1e6, sum(1 for r in rows if r["hasSt"])))

    # ------------------------------------------------------------------ fixed components
    # web
    web_files = []
    if not a.no_web and os.path.isdir(a.web):
        for root, dirs, names in os.walk(a.web):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules")
            for n in sorted(names):
                if n.startswith(".") or n.endswith((".map", ".md", ".tmp")):
                    continue
                rel = os.path.relpath(os.path.join(root, n), a.web).replace(os.sep, "/")
                web_files.append((rel, os.path.join(root, n)))
        if not os.path.exists(os.path.join(a.web, "index.html")):
            log("WARNING: web/index.html does not exist yet; dist/ has engines and data but no page")
    web_bytes = sum(os.path.getsize(p) for _, p in web_files)
    # chem
    chem_files, chem_meta, has_comp = [], None, set()
    chem_dir = os.path.join(a.work, "chem")
    if not a.no_chem and os.path.exists(os.path.join(chem_dir, "chem.json")):
        with open(os.path.join(chem_dir, "chem.json"), encoding="utf-8") as f:
            chem_meta = json.load(f)
        for n in chem_meta.get("publish") or []:
            p = os.path.join(chem_dir, n)
            if os.path.exists(p):
                chem_files.append((n, p))
            else:
                log("WARNING: chem file listed in chem.json is missing:", n)
        try:
            with gzip.open(os.path.join(chem_dir, "pat.gz.bin"), "rb") as f:
                has_comp = set(json.loads(f.read())["pn"])
        except (OSError, ValueError, KeyError) as e:
            log("WARNING: chem/pat.gz.bin not readable (%s); flag bit3 (has compounds) not set" % e)
    elif not a.no_chem:
        log("no data/work/chem/chem.json: dist is built without the chemistry set")
    chem_bytes = sum(fac(os.path.getsize(p)) if n.endswith(".bin") else os.path.getsize(p) for n, p in chem_files)
    # images
    img_dir = a.img_dir or os.path.join(a.work, "img")
    img_files, img_index, img_stats = build_images(img_dir, pn_to_p, rows, a.img_budget_mb * 1e6, a.enc) if os.path.isdir(img_dir) else ({}, None, None)
    img_bytes = sum(fac(len(v)) for v in img_files.values()) + (len(jdump(img_index)) if img_index else 0)
    # seed.json
    seed_obj = {"v": 1, "families": seed_fam, "players": [{"name": n} for n in players], "assignees": seed_asg, "cpc": seed_cpc, "lipids": seed_lip}
    seed_bytes = jdump(seed_obj)
    # patent files with provisional flags (sizes do not depend on the flags in any relevant way)
    pfiles, pat_names, _, _ = build_patent_files(rows, bytearray([2]) * P, has_comp, players)
    pat_bytes = sum(fac(len(v)) for v in pfiles.values())
    st_bytes = sum(fac(len(v)) for v in st_chunks)
    reserve = 400 * 1000                       # manifest.json, publish_batches.json, rounding
    fixed = web_bytes + chem_bytes + img_bytes + len(seed_bytes) + pat_bytes + st_bytes + reserve
    n_other = len(web_files) + len(chem_files) + len(img_files) + (1 if img_index else 0) + 1 + len(pfiles) + len(st_chunks) + 2
    idx_max_files = min(400, a.max_files - n_other - a.reserve_files)
    if idx_max_files < 12:
        raise SystemExit("file limit: %d files are needed outside the text index, --max-files is %d" % (n_other, a.max_files))
    text_budget = budget - fixed
    log("fixed parts: web %.2f MB, chem %.2f, images %.2f, patent table %.2f, status %.2f, seed %.2f -> %.2f MB of %.1f MB; %.2f MB left for the text index; %d files, %d left for the index"
        % (web_bytes / 1e6, chem_bytes / 1e6, img_bytes / 1e6, pat_bytes / 1e6, st_bytes / 1e6, len(seed_bytes) / 1e6, fixed / 1e6, a.budget_mb, text_budget / 1e6, n_other, idx_max_files))
    if text_budget <= 0:
        raise SystemExit("the fixed parts alone exceed the budget")

    # ------------------------------------------------------------------ text index within the budget
    model_path = os.path.join(build_dir, "model.json")
    model = {"a": 0.42, "d": 0.25, "base": 30.0}     # bytes per claim character / definition character / publication (bin)
    try:
        with open(model_path) as f:
            m = json.load(f)
            if all(isinstance(m.get(k), (int, float)) and m[k] > 0 for k in ("a", "d", "base")):
                model = {k: float(m[k]) for k in ("a", "d", "base")}
    except (OSError, ValueError):
        pass
    idx_dir = os.path.join(build_dir, "idx_%s" % a.enc if a.limit == 0 else "idx_%s_limit" % a.enc)
    info, levels, tries = None, None, []
    scale = 4 / 3 if a.enc == "b64" else 1.0
    for attempt in range(1, 8):
        eff = {"a": model["a"] * scale, "d": model["d"] * scale, "base": model["base"] * scale}
        levels, est = choose_levels(rows, text_budget, eff)
        info = run_index(snap, snap_stat, levels, idx_dir, idx_max_files, a.limit, a.force, build_dir)
        if info["stats"]["patents"] != P:
            raise SystemExit("text index has %d publications, the patent table %d" % (info["stats"]["patents"], P))
        comp = info["stats"]["components"]
        actual = sum(fac(b) for b in info["files"].values())
        kept_c = sum(rows[i]["cchars"] for i in range(P) if levels[i] >= 1 and (rows[i]["text"] or rows[i]["cchars"]))
        all_c = sum(r["cchars"] for r in rows)
        kept_d = sum(rows[i]["dchars"] for i in range(P) if levels[i] >= 2)
        n_cut_t = sum(1 for i in range(P) if rows[i]["text"] and levels[i] < 1)
        n_cut_d = sum(1 for i in range(P) if rows[i]["dchars"] and levels[i] < 2)
        tries.append({"attempt": attempt, "estimateMb": round(est / 1e6, 2), "actualMb": round(actual / 1e6, 2), "cutText": n_cut_t, "cutDefs": n_cut_d})
        log("attempt %d: index %.2f MB (estimate %.2f MB, budget %.2f MB); claims cut for %d publications, definitions cut for %d"
            % (attempt, actual / 1e6, est / 1e6, text_budget / 1e6, n_cut_t, n_cut_d))
        # refit the model on what was measured (bin sizes)
        if kept_d:
            model["d"] = comp["defs"]["bytes"] / kept_d
        non_defs = info["stats"]["totalBytes"] - comp["defs"]["bytes"]
        if kept_c:
            a_new = (non_defs - model["base"] * P) / kept_c
            if a_new <= 0.05:                       # small corpora: the per-publication part dominates
                model["base"] = max(1.0, 0.5 * non_defs / P)
                a_new = (non_defs - model["base"] * P) / kept_c
            model["a"] = a_new
        elif P:
            model["base"] = non_defs / P
        over = actual > text_budget
        slack = text_budget - actual
        if not over and (n_cut_t + n_cut_d == 0 or slack < 0.03 * text_budget or attempt >= 5):
            break
        if over and attempt >= 3:                    # converge from below: add a safety margin that grows
            model["a"] *= 1.0 + 0.02 * (attempt - 2)
            model["d"] *= 1.0 + 0.02 * (attempt - 2)
    else:
        raise SystemExit("could not fit the text index into the budget after 7 attempts: %s" % tries)
    if sum(fac(b) for b in info["files"].values()) > text_budget:
        raise SystemExit("text index is over budget: %s" % tries)
    with open(model_path, "w") as f:
        json.dump(model, f)

    # ------------------------------------------------------------------ cut report
    cut_rows = []
    by_tier = {}
    for i, r in enumerate(rows):
        lost_t = r["text"] and levels[i] < 1
        lost_d = r["dchars"] and levels[i] < 2
        if lost_t or lost_d:
            cut_rows.append({"pn": r["pn"], "lost": "claims+defs" if lost_t else "defs", "tier": r["tier"], "seedTier": r["seedTier"],
                             "pub": r["pub"], "claims": r["ncl"] if lost_t else 0, "claimChars": r["cchars"] if lost_t else 0, "defChars": r["dchars"]})
            k = "seed%d" % r["seedTier"] if r["seedTier"] else "tier%d" % r["tier"]
            e = by_tier.setdefault(k, {"claims": 0, "defs": 0})
            e["claims" if lost_t else "defs"] += 1
    with open(os.path.join(build_dir, "cut.jsonl"), "w", encoding="utf-8") as f:
        for c in cut_rows:
            f.write(json.dumps(c) + "\n")
    n_cut_t = sum(1 for c in cut_rows if c["lost"] != "defs")
    n_cut_d = len(cut_rows) - n_cut_t
    kept_text = [rows[i] for i in range(P) if rows[i]["text"] and levels[i] >= 1]
    cut_text = [rows[i] for i in range(P) if rows[i]["text"] and levels[i] < 1]
    cut = {
        "applied": bool(cut_rows), "budgetMb": a.budget_mb, "attempts": tries,
        "text": {"available": avail_text, "kept": avail_text - n_cut_t, "cut": n_cut_t,
                 "claimsCut": sum(c["claims"] for c in cut_rows), "claimCharsCut": sum(c["claimChars"] for c in cut_rows)},
        "defs": {"available": avail_defs, "kept": avail_defs - sum(1 for c in cut_rows if c["defChars"]), "cut": sum(1 for c in cut_rows if c["defChars"]), "cutDefsOnly": n_cut_d},
        "byTier": by_tier,
        "rule": "seed families keep claims and definitions; then claims by seed tier, tier 0..5, newest first; then definitions in the same order",
        "lastKept": ({"pn": max(kept_text, key=priority_key)["pn"], "tier": max(kept_text, key=priority_key)["tier"], "pub": max(kept_text, key=priority_key)["pub"]} if kept_text and cut_text else None),
        "firstCut": ({"pn": min(cut_text, key=priority_key)["pn"], "tier": min(cut_text, key=priority_key)["tier"], "pub": min(cut_text, key=priority_key)["pub"]} if cut_text else None),
        "examples": [c["pn"] for c in sorted(cut_rows, key=lambda c: (c["lost"] == "defs", c["seedTier"] or 9, c["tier"], -c["pub"]))[:25]],
    }
    if cut_rows:
        log("BUDGET CUT: %d of %d publications lose their claims (%d claims, %.1f MB text) and are biblio-only; %d more lose only their definition paragraphs"
            % (n_cut_t, avail_text, cut["text"]["claimsCut"], cut["text"]["claimCharsCut"] / 1e6, n_cut_d))
        for k in sorted(by_tier):
            log("   cut in %-6s: claims %6d   definitions only %6d" % (k, by_tier[k]["claims"], by_tier[k]["defs"]))
        if cut["firstCut"]:
            log("   first publication without claims: %s (tier %d, published %d); full list: %s"
                % (cut["firstCut"]["pn"], cut["firstCut"]["tier"], cut["firstCut"]["pub"], os.path.join(build_dir, "cut.jsonl")))
    else:
        log("no budget cut: every available full text and definition paragraph is included")

    # ------------------------------------------------------------------ write dist
    for rel, src in web_files:
        dist.put(rel, src, "web")
    pfiles, pat_names, flags, kinds = build_patent_files(rows, levels, has_comp, players)
    for rel in sorted(pfiles):
        dist.put(rel, pfiles[rel], "patent table" if "/pat-" in rel else "meta")
    st_names = []
    for i, data in enumerate(st_chunks):
        st_names.append("st-%03d.gz.bin" % i)
        dist.put("data/" + st_names[-1], data, "status")
    for rel in sorted(info["files"]):
        comp_name = ("definitions" if rel.startswith("df-") else "postings" if "/p-" in rel else "positions" if "/q-" in rel
                     else "claim text" if "/t-" in rel else "index other")
        dist.put("data/" + rel, os.path.join(idx_dir, rel), comp_name)
    for rel in sorted(img_files):
        dist.put(rel, img_files[rel], "images")
    if img_index:
        dist.put("data/img.json", jdump(img_index), "images")
    for n, p in chem_files:
        dist.put("data/chem/" + n, p, "chemistry")
    dist.put("data/seed.json", seed_bytes, "seed")

    # ------------------------------------------------------------------ manifest
    seed_expected = sorted({m for fam in seed_fam if isinstance(fam, dict) for k in ("representative_us", "representative_ep") for m in (fam.get(k) or [])})
    asofs = sorted({r["asof"] for r in rows if r["asof"]})
    counts = {
        "patents": P, "fulltext": sum(1 for f in flags if f & 1), "fulltextAvailable": avail_text, "claims": info["idx"]["counts"]["claims"],
        "compounds": (chem_meta or {}).get("n", 0),
        "ep": sum(1 for r in rows if r["auth"] == "EP"), "us": sum(1 for r in rows if r["auth"] == "US"), "wo": sum(1 for r in rows if r["auth"] == "WO"),
        "families": len({r["fam"] for r in rows}), "withStatus": sum(1 for r in rows if r["hasSt"]), "withDefs": sum(1 for f in flags if f & 2),
        "seed_expected": len(seed_expected), "seed_present": sum(1 for m in seed_expected if m in pn_to_p),
        "seed_fulltext": sum(1 for i, r in enumerate(rows) if r["seedTier"] and flags[i] & 1),
    }
    manifest = {
        "v": 1, "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "enc": a.enc,
        "snapshots": {"surechembl": (chem_meta or {}).get("snapshot") or C.SURECHEMBL_SNAPSHOT, "ep_register": asofs[-1] if asofs else None,
                      "ep_text": newest_date(C.CACHE_EP), "us_text": newest_date(C.CACHE_US),
                      "corpus": datetime.datetime.fromtimestamp(snap_stat.st_mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "counts": counts, "players": players, "statusCodes": ST_CODES, "kinds": kinds,
        "pat": {"chunk": PAT_CHUNK, "files": pat_names},
        "st": {"chunk": PAT_CHUNK, "files": st_names},
        "meta": {"file": "meta.gz.bin"}, "pn": {"file": "pn.gz.bin"}, "cpc": {"file": "cpc.gz.bin"},
        "idx": info["idx"], "df": info["df"],
        "img": ({"index": "img.json", "packs": img_stats["packs"], "images": img_stats["images"], "patents": img_stats["patents"], "cut": img_stats["cut"]} if img_index else None),
        "chem": ({"dir": "chem/", "files": [n for n, _ in chem_files], "n": chem_meta.get("n"), "nPat": chem_meta.get("nPat"), "snapshot": chem_meta.get("snapshot")} if chem_meta else None),
        "seed": "seed.json",
        "cut": cut,
        "flagBits": {"text": 1, "defs": 2, "chemImg": 4, "compounds": 8, "status": 16, "textCut": 32, "defsCut": 64},
        "limit": a.limit or None,
    }
    sizes = dict(sorted(dist.comp.items(), key=lambda kv: -kv[1]))
    manifest["sizes"] = sizes
    manifest["bytesPerClaim"] = info["stats"]["bytesPerClaim"]
    manifest["files"] = {rel: [v[0], v[1]] for rel, v in sorted(dist.files.items())}
    manifest["nFiles"] = len(dist.files) + 2
    mbytes = jdump(manifest)
    manifest["totalBytes"] = dist.total() + len(mbytes) + 40
    dist.put("data/manifest.json", jdump(manifest), "manifest")

    # ------------------------------------------------------------------ publish batches
    def rank(rel):
        if rel == "index.html":
            return 0
        if not rel.startswith("data/"):
            return 1
        if rel.startswith("data/idx/"):
            return 4
        if rel.startswith("data/chem/"):
            return 5
        if rel.startswith("data/df-") or rel.startswith("data/img"):
            return 6
        return 2
    order = sorted(dist.files, key=lambda rel: (rank(rel), rel))
    batches, cur, cur_b = [], [], 0
    for rel in order:
        size = dist.files[rel][0]
        if cur and (len(cur) >= BATCH_FILES or cur_b + size > BATCH_BYTES):
            batches.append({"files": cur, "bytes": cur_b})
            cur, cur_b = [], 0
        cur.append(rel)
        cur_b += size
    if cur:
        batches.append({"files": cur, "bytes": cur_b})
    with open(os.path.join(a.out, "publish_batches.json"), "w", encoding="utf-8") as f:
        json.dump(batches, f, indent=0)
    gone = dist.prune()

    # ------------------------------------------------------------------ final checks + report
    total = dist.total() + os.path.getsize(os.path.join(a.out, "publish_batches.json"))
    n_files = len(dist.files) + 1
    biggest = max(dist.files.items(), key=lambda kv: kv[1][0])
    log("dist: %d files, %.2f MB (budget %.1f MB, host limit %d MB / 500 files); largest file %s %.2f MB; %d batches; %d files written, %d unchanged, %d stale removed"
        % (n_files, total / 1e6, a.budget_mb, HOST_MAX_TOTAL_MB, biggest[0], biggest[1][0] / 1e6, len(batches), dist.written, dist.unchanged, gone))
    for k, v in sizes.items():
        log("   %-14s %8.2f MB" % (k, v / 1e6))
    log("   claims %d in %d publications, %.1f bytes per claim (postings + positions + text + docs)"
        % (counts["claims"], counts["fulltext"], info["stats"]["bytesPerClaim"] or 0))
    report = {"files": n_files, "bytes": total, "sizes": sizes, "counts": counts, "cut": cut, "batches": [{"files": len(b["files"]), "bytes": b["bytes"]} for b in batches],
              "index": info["stats"], "enc": a.enc}
    with open(os.path.join(build_dir, "dist_report_%s.json" % a.enc), "w") as f:
        json.dump(report, f, indent=1)
    if total > budget:
        raise SystemExit("dist is %.2f MB, over the budget of %.1f MB" % (total / 1e6, a.budget_mb))
    if n_files > a.max_files:
        raise SystemExit("dist has %d files, the limit is %d" % (n_files, a.max_files))
    for b in batches:
        if len(b["files"]) > BATCH_FILES or (b["bytes"] > BATCH_BYTES and len(b["files"]) > 1):
            raise SystemExit("internal error: publish batch too large")


if __name__ == "__main__":
    main()
