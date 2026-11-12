"""Deterministic extraction of numeric ranges from claim text (stdlib only).

    extract(claim_text, vocab, lang="en") -> [{param, comp, lo, hi, loInc, hiInc, unit, approx, q, off, ml}]

`vocab` is data/seed/range_params.json (parameter names, unit spellings, keyword patterns, component words, phrase
lists). Nothing about lipids lives in this file: a parameter or component is added to the vocabulary, not here.

Method (tokeniser plus small rules, no model):
  1. text is normalised one character to one character (unicode dashes -> "-", no-break spaces -> " "), so offsets
     of the normalised text are offsets of the original claim text;
  2. claim references ("claims 1-3"), figure / example / SEQ ID numbers are blanked so that their numbers cannot match;
  3. inline patterns of the vocabulary (e.g. "C12-C18", "PEG2000") are taken and blanked;
  4. numbers (and a:b ratios) become tokens with an optional unit and an "about" lead; neighbouring tokens joined by
     "to" / "-" / "between ... and" form a range, a comparator word before ("less than") or after ("or more") makes an
     open range, a list ("40, 45 or 50 mol %") makes separate single values;
  5. the parameter follows from the unit or from a keyword in the same clause; component = nearest component word.
Rows carry `q` = verbatim quote of at most `quote_max` characters starting `quote_lead` characters before the match,
`off` = offset of the match in the claim and `ml` = length of the match.
"""
import re

_CACHE = {}
_MISSING = object()


def _alt(parts):
    return "|".join("(?:%s)" % p for p in parts if p)


class _Vocab(object):
    """Compiled form of the vocabulary for one language."""

    def __init__(self, vocab, lang):
        L = vocab["lang"][lang]
        self.lang = lang
        self.decimal = L.get("decimal", ".")
        self.win = dict(vocab.get("windows") or {})
        flags = re.I | re.U
        if self.decimal == ",":
            self.N = r"\d+(?:[.,]\d+)?"
        else:
            self.N = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
        self.approx_re = re.compile(r"(?:(?:%s)\s*)+$" % L["approx"], flags)
        self.between_re = re.compile(r"(?<![A-Za-z])(?:%s)\s*$" % L["between"], flags)
        self.sep_re = re.compile(r"^\s*(?:%s)\s*$" % L["sep"], flags)
        self.sep_between_re = re.compile(r"^\s*(?:%s)\s*$" % L["sep_between"], flags)
        self.list_re = re.compile(r"^\s*(?:%s)\s*$" % L["list_gap"], flags)
        self.cmp = {}
        for k in ("hi_ex", "hi_in", "lo_ex", "lo_in"):
            self.cmp[k] = re.compile(r"(?<![A-Za-z<>=≤≥])(?:%s)\s*$" % L[k], flags)
        self.suffix_hi = re.compile(r"^\s*(?:%s)" % L["suffix_hi"], flags)
        self.suffix_lo = re.compile(r"^\s*(?:%s)" % L["suffix_lo"], flags)
        # two-sided range whose upper end carries its own comparator: "from 6 to less than 7", "more than 0.5 mol %
        # and less than 3 mol %", "0.5 mol % or more and 3 mol % or less". Groups: sl = "or more" after the lower end,
        # j = joiner word, hx / hn = exclusive / inclusive comparator before the upper end.
        joiner = L.get("range_join", r"to|through|and|but|-")
        self.cmp_gap = re.compile(r"^\s*(?P<sl>%s)?\s*,?\s*(?P<j>%s)\s+(?:(?P<hn>%s)|(?P<hx>%s))?\s*$"
                                  % (L["suffix_lo"], joiner, L["hi_in"], L["hi_ex"]), flags)
        self.and_word = re.compile(r"^(?:%s)$" % L.get("range_join_and", r"and|but"), flags)
        self.masks = [re.compile(p, flags) for p in L.get("mask", [])]
        self.clause = re.compile(vocab.get("clause_break", r";|\n"))
        self.generic_unit = re.compile(r"(?:%s)$" % vocab["generic_unit"][lang], flags)
        self.bare = vocab.get("bare_percent")
        self.comps = []
        for c in vocab["components"]:
            pat = c.get(lang)
            if not pat:
                self.comps.append({"id": c["id"], "re": None, "fallback": bool(c.get("fallback")), "amb": bool(c.get("ambiguous"))})
                continue
            if lang == "de":
                rx = re.compile(r"(?<![A-Za-zÀ-ÿ])(?:%s)" % pat, flags)
            else:
                rx = re.compile(r"(?<![A-Za-z])(?:%s)(?![A-Za-z])" % pat, flags)
            self.comps.append({"id": c["id"], "re": rx, "fallback": bool(c.get("fallback")), "amb": bool(c.get("ambiguous"))})
        self.comp_idx = dict((c["id"], i) for i, c in enumerate(self.comps))
        self.params = []
        unit_alts = []
        for p in vocab["params"]:
            q = {"id": p["id"], "min": p.get("min"), "max": p.get("max"), "unit": p.get("unit", ""), "comp": p.get("comp", "none"),
                 "ratio": bool(p.get("ratio")), "plain": bool(p.get("plain")), "after": bool(p.get("after")),
                 "needs_kw": bool(p.get("needs_kw")), "needs_unit": bool(p.get("needs_unit")), "generic_pct": bool(p.get("generic_pct")),
                 "requires_comp": p.get("requires_comp"), "kw": None, "units": [], "inline": []}
            kws = (p.get("kw") or {}).get(lang) or []
            if kws:
                q["kw"] = re.compile(_alt(kws), flags)
            for u in (p.get("units") or {}).get(lang) or []:
                q["units"].append({"re": re.compile(r"(?:%s)$" % u["re"], flags), "norm": u["norm"], "scale": u.get("scale", 1)})
                unit_alts.append(u["re"])
            for ip in p.get("inline") or []:
                q["inline"].append({"re": re.compile(ip["re"], flags), "needs_after": re.compile(r"(?:%s)" % ip["needs_after"], flags) if ip.get("needs_after") else None,
                                    "scale": ip.get("scale", 1)})
            self.params.append(q)
        self.by_id = dict((p["id"], p) for p in self.params)
        unit_alts.append(vocab["generic_unit"][lang])
        self.unit_re = re.compile(r"[ ]?(?P<u>%s)" % _alt(unit_alts), flags)
        self.val_re = re.compile(r"(?P<sg>(?<![\w.:)\]])-(?=\d))?(?<![\w.:])(?P<v>(?:%s)(?:\s*:\s*(?:%s))*)" % (self.N, self.N), flags)
        self.ratio_kw = [p for p in self.params if p["ratio"]]
        self.plain_kw = [p for p in self.params if p["plain"]]


def _compiled(vocab, lang):
    key = (id(vocab), lang)
    c = _CACHE.get(key)
    if c is None or c[0] is not vocab:
        c = (vocab, _Vocab(vocab, lang))
        _CACHE[key] = c
    return c[1]


def _norm(text):
    out = []
    for ch in text:
        o = ord(ch)
        if o in (0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xFE63, 0xFF0D):
            out.append("-")
        elif o in (0xA0, 0x2009, 0x202F, 0x2007, 0x2002, 0x2003, 0x200A):
            out.append(" ")
        elif o in (0x200B, 0xAD, 0x2060, 0xFEFF):
            out.append(" ")
        elif 0x2080 <= o <= 0x2089:
            out.append(chr(0x30 + o - 0x2080))      # subscript digits (C\u2081\u2082 -> C12)
        else:
            out.append(ch)
    return "".join(out)


_TOL_RE = re.compile(r"^\s*(?:\u00b1|\+\s*/\s*-?|\+\s*-)\s*$")


def _blank(text, spans):
    if not spans:
        return text
    b = list(text)
    for s, e in spans:
        for i in range(s, min(e, len(b))):
            b[i] = " "
    return "".join(b)


def _num(s, decimal):
    s = s.strip()
    if decimal == ",":
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    return float(s)


def _clean(x):
    if x is None:
        return None
    r = round(x, 6)
    return int(r) if r == int(r) and abs(r) < 1e12 else r


def extract(claim_text, vocab, lang="en"):
    if not claim_text:
        return []
    V = _compiled(vocab, lang)
    text = _norm(claim_text)
    n = len(text)
    # blanked copy for number detection
    spans = []
    for rx in V.masks:
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    mt = _blank(text, spans)
    bounds = [m.start() for m in V.clause.finditer(text)]
    out = []

    def clause_lo(pos):
        lo = 0
        for b in bounds:
            if b < pos:
                lo = b + 1
            else:
                break
        return lo

    def clause_hi(pos):
        for b in bounds:
            if b >= pos:
                return b
        return n

    def emit(param, comp, lo, hi, lo_inc, hi_inc, unit, approx, s, e):
        a = max(0, s - V.win.get("quote_lead", 60))
        b = min(n, a + V.win.get("quote_max", 160))
        if e > b:
            e = b
        out.append({"param": param, "comp": comp, "lo": _clean(lo), "hi": _clean(hi), "loInc": bool(lo_inc), "hiInc": bool(hi_inc), "unit": unit,
                    "approx": bool(approx), "q": claim_text[a:b], "off": s, "ml": e - s})

    # ---- inline patterns (C12-C18, PEG2000)
    taken = []
    for P in V.params:
        for ip in P["inline"]:
            for m in ip["re"].finditer(mt):
                if ip["needs_after"] is not None and not ip["needs_after"].match(mt, m.end()):
                    continue
                gd = m.groupdict()
                lo = float(gd["lo"]) * ip["scale"]
                hi = float(gd["hi"]) * ip["scale"] if gd.get("hi") else lo
                if lo > hi:
                    continue
                if P["min"] is not None and lo < P["min"] or P["max"] is not None and hi > P["max"]:
                    continue
                comp = -1
                if P["comp"].startswith("fixed:"):
                    comp = V.comp_idx.get(P["comp"][6:], -1)
                else:
                    comp = _nearest_comp(V, text, m.start(), m.end(), clause_lo(m.start()), clause_hi(m.end()), set(), -1)[0]
                if comp >= 0 and V.comps[comp]["amb"]:
                    comp = -1
                emit(P["id"], comp, lo, hi, True, True, P["unit"], False, m.start(), m.end())
                taken.append((m.start(), m.end()))
    mt = _blank(mt, taken)

    # ---- tokens
    toks = []
    for m in V.val_re.finditer(mt):
        raw = m.group("v")
        parts = re.split(r"\s*:\s*", raw)
        s0 = m.start()
        e0 = m.end()
        t = {"n_s": m.start("v"), "s": s0, "e": e0, "neg": bool(m.group("sg")), "multi": len(parts) > 2, "ratio": len(parts) == 2, "ap": False, "unit": None, "cmp": None, "ustart": None}
        try:
            if len(parts) == 2:
                d = _num(parts[1], V.decimal)
                t["val"] = _num(parts[0], V.decimal) / d if d else None
            elif len(parts) == 1:
                t["val"] = _num(parts[0], V.decimal)
            else:
                t["val"] = None
        except ValueError:
            t["val"] = None
        if t["neg"] and t["val"] is not None:
            t["val"] = -t["val"]
        toks.append(t)
    # unit and approx lead
    for i, t in enumerate(toks):
        if t["multi"] or t["val"] is None:
            continue
        um = V.unit_re.match(mt, t["e"])
        if um and not t["ratio"]:
            t["unit"] = um.group("u")
            t["ustart"] = um.start("u")
            t["e"] = um.end()
        lead_from = max(0, t["s"] - 40)
        am = V.approx_re.search(mt[lead_from:t["s"]])
        if am:
            t["ap"] = True
            t["s"] = lead_from + am.start()
    # unit propagation inside lists: "40, 45 or 50 mol %"
    for i in range(len(toks) - 2, -1, -1):
        a, b = toks[i], toks[i + 1]
        if a["unit"] is None and b["unit"] is not None and not a["multi"] and not b["multi"] and a["val"] is not None:
            gap = mt[a["e"]:b["s"]]
            if V.list_re.match(gap) and not a["ratio"]:
                a["unit"] = b["unit"]
                a["unit_shared"] = True
    for i in range(len(toks) - 1):      # list links: "40, 45 or 50 mol %" share one component
        a, b = toks[i], toks[i + 1]
        if not a["multi"] and not b["multi"] and a["val"] is not None and b["val"] is not None and not a["ratio"] and not b["ratio"] and V.list_re.match(mt[a["e"]:b["s"]]):
            b["list_prev"] = True
            a["list_next"] = True

    claimed = set()

    def kw_find(Pset, s, e, allow_after, bound_prev, next_start, dist=None):
        """nearest keyword of the given params before s (and, if allowed, after e); returns the param"""
        lo = max(clause_lo(s), bound_prev, s - (dist or V.win.get("kw_before", 120)))
        reg = text[lo:s]
        best = None
        for P in Pset:
            if not P["kw"]:
                continue
            last = None
            for km in P["kw"].finditer(reg):
                last = km
            if last is not None and (best is None or last.end() > best[1]):
                best = (P, last.end())
        if best:
            return best[0]
        if allow_after:
            hi = min(clause_hi(e), e + V.win.get("kw_after", 32), next_start)
            reg2 = text[e:hi]
            for P in Pset:
                if P["kw"] and P["after"]:
                    km = P["kw"].search(reg2)
                    if km and (best is None or km.start() < best[1]):
                        best = (P, km.start())
        return best[0] if best else None

    exprs = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t["multi"] or t["val"] is None:
            i += 1
            continue
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        # tolerance "X +/- d" is the range [X-d, X+d]
        if nxt is not None and not nxt["multi"] and nxt["val"] is not None and not t["ratio"] and not nxt["ratio"] and _TOL_RE.match(mt[t["e"]:nxt["s"]]):
            d = abs(nxt["val"])
            if t["unit"] is None and nxt["unit"] is not None:
                t["unit"] = nxt["unit"]
            exprs.append({"kind": "range", "a": t, "b": nxt, "lo": t["val"] - d, "hi": t["val"] + d, "loInc": True, "hiInc": True, "ap": True,
                          "s": t["s"], "e": nxt["e"], "i": i})
            i += 2
            continue
        # range (a plain number and an a:b ratio as ends, "4 to 6:1", count as a ratio range)
        if nxt is not None and not nxt["multi"] and nxt["val"] is not None and nxt["ratio"] != t["ratio"] and (nxt["unit"] is None and t["unit"] is None):
            gap0 = mt[t["e"]:nxt["s"]]
            if V.sep_re.match(gap0) or (V.sep_between_re.match(gap0) and V.between_re.search(mt[max(0, t["s"] - 16):t["s"]])):
                t["ratio"] = nxt["ratio"] = True
        # range
        if nxt is not None and not nxt["multi"] and nxt["val"] is not None and nxt["ratio"] == t["ratio"]:
            gap = mt[t["e"]:nxt["s"]]
            if t["unit"] and gap[:1] == "." and t["unit"][-1:].isalpha():
                gap = " " + gap[1:]         # "20 deg. C. and 30 deg. C."
            ok = bool(V.sep_re.match(gap))
            if not ok and V.sep_between_re.match(gap):
                ok = bool(V.between_re.search(mt[max(0, t["s"] - 16):t["s"]]))
            ex = None
            if ok:
                ex = {"kind": "range", "a": t, "b": nxt, "lo": t["val"], "hi": nxt["val"], "loInc": True, "hiInc": True, "ap": t["ap"] or nxt["ap"],
                      "s": t["s"], "e": nxt["e"], "i": i}
            elif t["val"] <= nxt["val"]:
                ex = _cmp_range(V, mt, t, nxt, i)
            if ex is not None:
                _lower_cmp(V, mt, ex)
                exprs.append(ex)
                i += 2
                continue
        # comparator before
        before = mt[max(0, t["s"] - 32):t["s"]]
        best = None
        for k, rx in V.cmp.items():
            cm = rx.search(before)
            if cm and (best is None or cm.start() < best[1]):
                best = (k, cm.start())
        ex = {"kind": "single", "a": t, "b": t, "lo": t["val"], "hi": t["val"], "loInc": True, "hiInc": True, "ap": t["ap"], "s": t["s"], "e": t["e"], "i": i}
        if best:
            k = best[0]
            ex["s"] = t["s"] - (len(before) - best[1])
            ex["kind"] = "cmp"
            if k.startswith("hi"):
                ex["lo"], ex["hi"], ex["hiInc"] = None, t["val"], k == "hi_in"
            else:
                ex["lo"], ex["hi"], ex["loInc"] = t["val"], None, k == "lo_in"
        else:
            after = mt[t["e"]:t["e"] + 24]
            sm = V.suffix_hi.match(after)
            if sm:
                ex["kind"] = "cmp"
                ex["lo"], ex["hi"], ex["hiInc"] = None, t["val"], True
                ex["e"] = t["e"] + sm.end()
            else:
                sm = V.suffix_lo.match(after)
                if sm:
                    ex["kind"] = "cmp"
                    ex["lo"], ex["hi"], ex["loInc"] = t["val"], None, True
                    ex["e"] = t["e"] + sm.end()
        exprs.append(ex)
        i += 1

    # ---- classify
    for xi, ex in enumerate(exprs):
        a, b = ex["a"], ex["b"]
        ti = ex["i"]
        prev_tok_end = toks[ti - 1]["e"] if ti > 0 else 0
        last_i = ti + (1 if ex["kind"] == "range" else 0)
        next_start = toks[last_i + 1]["s"] if last_i + 1 < len(toks) else n
        ua = a["unit"]
        ub = b["unit"] if ex["kind"] == "range" else ua
        u_text = ub or ua
        if ex["kind"] == "range" and ua and ub:
            ca, cb = _unit_class(V, ua), _unit_class(V, ub)
            if ca != cb:
                continue
        unit_cls = _unit_class(V, u_text) if u_text else None
        s, e = ex["s"], ex["e"]
        param = None
        scale = 1.0
        norm_unit = None
        if a["ratio"]:
            P = kw_find(V.ratio_kw, s, e, True, prev_tok_end, next_start)
            if P is None:
                continue
            param, norm_unit = P, P["unit"]
        elif unit_cls and unit_cls[0] is not None:
            P, norm_unit, scale = unit_cls
            if P["needs_kw"] and kw_find([P], s, e, True, prev_tok_end, next_start) is None:
                continue
            param = P
        elif unit_cls and unit_cls[0] is None:      # generic percent sign
            P = None
            for Q in V.params:
                if Q["generic_pct"] and Q["kw"] and kw_find([Q], s, e, True, prev_tok_end, next_start) is not None:
                    P = Q
                    break
            if P is not None:
                param, norm_unit = P, P["unit"]
            elif V.bare:
                bp = V.by_id.get(V.bare["param"])
                need = set(V.comp_idx[c] for c in V.bare["needs_comp"] if c in V.comp_idx)
                c, _ = _nearest_comp(V, text, s, e, max(clause_lo(s), prev_tok_end), clause_hi(e), claimed, -1, allowed=need, no_total=True)
                if bp is not None and c in need:
                    param, norm_unit = bp, V.bare["unit"]
            if param is None:
                continue
        else:
            if re.search(r"\(\s*$", text[max(0, s - 3):s]) and re.match(r"\s*\)", text[e:e + 3]):
                continue        # "(1)" enumerator, not a value
            P = kw_find(V.plain_kw, s, e, False, prev_tok_end, next_start, V.win.get("plain_dist", 48))
            if P is None:
                continue
            param, norm_unit = P, P["unit"]
        if param["needs_unit"] and not (unit_cls and unit_cls[0] is not None):
            continue
        lo, hi = ex["lo"], ex["hi"]
        if lo is not None:
            lo = lo * scale
        if hi is not None:
            hi = hi * scale
        if lo is not None and hi is not None and lo > hi:
            continue
        mn, mx = param["min"], param["max"]
        if (lo is not None and ((mn is not None and lo < mn) or (mx is not None and lo > mx))) or (hi is not None and ((mn is not None and hi < mn) or (mx is not None and hi > mx))):
            continue
        # component
        mode = param["comp"]
        comp = -1
        if mode == "nearest":
            comp, wpos = _nearest_comp(V, text, s, e, max(clause_lo(s), prev_tok_end), clause_hi(e), claimed, 1)
        elif mode == "first":
            comp = _first_comp(V, text, s, clause_lo(s), prev_tok_end)
        elif mode.startswith("fixed:"):
            comp = V.comp_idx.get(mode[6:], -1)
        if mode == "nearest" and (toks[ti].get("list_prev") or toks[last_i].get("list_next")):
            # a list "40, 45 or 50 mol %" has one component for all members: resolved once for the whole list span
            h = ti
            while h > 0 and toks[h].get("list_prev"):
                h -= 1
            tl = last_i
            while tl + 1 < len(toks) and toks[tl].get("list_next"):
                tl += 1
            hs = toks[h]["s"]
            hprev = toks[h - 1]["e"] if h > 0 else 0
            comp = _nearest_comp(V, text, hs, toks[tl]["e"], max(clause_lo(hs), hprev), clause_hi(toks[tl]["e"]), claimed, 1)[0]
        if comp >= 0 and V.comps[comp]["amb"]:
            comp = -1
        if param["requires_comp"]:
            need = V.comp_idx.get(param["requires_comp"], -2)
            c2, _ = _nearest_comp(V, text, s, e, max(clause_lo(s), prev_tok_end - 40 if prev_tok_end else 0), clause_hi(e), set(), 1, allowed={need}, no_total=True)
            if c2 != need:
                continue
            comp = need
        emit(param["id"], comp, lo, hi, ex["loInc"], ex["hiInc"], norm_unit if norm_unit is not None else param["unit"], ex["ap"], s, e)
    out.sort(key=lambda r: (r["off"], r["param"]))
    return _merge_open(V, text, claim_text, out, bounds, n)


_GAP_PLAIN = re.compile(r"^[\s,]*(?:(?:and|but|while|with)\b[\s,]*)?$", re.I)
_GAP_BAD = re.compile(r"\d|;|\bor\b|\boder\b|\beither\b", re.I)


def _merge_open(V, text, claim_text, rows, bounds, n):
    """'more than X' and 'less than Y' for the same parameter and component in one clause are one interval: both limits
    hold (a claim row list is otherwise read as alternatives). Joined only when nothing but joiner words, or words
    without another component, stands between them, and never across "or"."""
    out = []
    i = 0
    while i < len(rows):
        r = rows[i]
        q = rows[i + 1] if i + 1 < len(rows) else None
        # the second number of "the PEG lipid ... at least X mol % and ... at most Y mol %" finds no component word of its
        # own (the word is taken by the first number): it inherits the first one's component
        inherit = q is not None and q["comp"] == -1 and r["comp"] >= 0
        if q is not None and q["param"] == r["param"] and (q["comp"] == r["comp"] or inherit) and q["unit"] == r["unit"]:
            a, b = (r, q) if (r["hi"] is None and r["lo"] is not None and q["lo"] is None and q["hi"] is not None) else \
                   (q, r) if (q["hi"] is None and q["lo"] is not None and r["lo"] is None and r["hi"] is not None) else (None, None)
            gs, ge = r["off"] + r["ml"], q["off"]
            gap = text[gs:ge] if ge >= gs else None
            same_clause = gap is not None and not any(gs <= x < ge for x in bounds)
            ok = a is not None and same_clause and a["lo"] <= b["hi"] and len(gap) <= 60 and not _GAP_BAD.search(gap)
            if ok and inherit:
                ok = not [h for h in _comp_hits(V, text, gs, ge) if not V.comps[h[2]]["fallback"]]
            if ok and not _GAP_PLAIN.match(gap):
                ok = r["comp"] >= 0 and all(h[2] == r["comp"] or V.comps[h[2]]["fallback"] for h in _comp_hits(V, text, gs, ge))
            if ok:
                s, e = r["off"], q["off"] + q["ml"]
                lead = max(0, s - V.win.get("quote_lead", 60))
                end = min(n, max(lead + V.win.get("quote_max", 160), e))
                out.append({"param": r["param"], "comp": r["comp"], "lo": a["lo"], "hi": b["hi"], "loInc": a["loInc"], "hiInc": b["hiInc"],
                            "unit": r["unit"], "approx": r["approx"] or q["approx"], "q": claim_text[lead:end], "off": s, "ml": e - s})
                i += 2
                continue
        out.append(r)
        i += 1
    return out


def _lead_cmp(V, mt, t):
    """comparator word right before token t -> (kind, start) | None"""
    before = mt[max(0, t["s"] - 32):t["s"]]
    best = None
    for k, rx in V.cmp.items():
        cm = rx.search(before)
        if cm and (best is None or cm.start() < best[1]):
            best = (k, cm.start())
    if best is None:
        return None
    return best[0], t["s"] - (len(before) - best[1])


def _cmp_range(V, mt, t, nxt, i):
    """two tokens joined by "to less than", "and less than", "or more and ... or less" -> one range expression | None.
    "and" needs a marker of the lower end ("more than X", "X or more", "between X"), so that "X mol % and less than Y mol %"
    of two different statements is not joined by accident."""
    gap = mt[t["e"]:nxt["s"]]
    gm = V.cmp_gap.match(gap)
    if not gm:
        return None
    after = mt[nxt["e"]:nxt["e"] + 24]
    shi = V.suffix_hi.match(after)
    has_hi = bool(gm.group("hn") or gm.group("hx") or shi)
    lead = _lead_cmp(V, mt, t)
    lo_marker = bool(gm.group("sl")) or (lead is not None and lead[0].startswith("lo")) or bool(V.between_re.search(mt[max(0, t["s"] - 16):t["s"]]))
    if lead is not None and lead[0].startswith("hi"):
        return None         # "less than X and less than Y": two upper limits, not a range
    if not has_hi and not gm.group("sl"):
        return None         # plain "X and Y" is a list, handled elsewhere
    if V.and_word.match(gm.group("j")) and not lo_marker:
        return None
    if not has_hi:
        return None         # "X or more and Y": the second number has no comparator, leave it to the other rules
    e = nxt["e"] + (shi.end() if shi and not (gm.group("hn") or gm.group("hx")) else 0)
    return {"kind": "range", "a": t, "b": nxt, "lo": t["val"], "hi": nxt["val"], "loInc": True, "hiInc": not gm.group("hx"),
            "ap": t["ap"] or nxt["ap"], "s": t["s"], "e": e, "i": i}


def _lower_cmp(V, mt, ex):
    """an exclusive comparator before the lower end of a range ("greater than 0.5 to 3") makes the lower bound exclusive"""
    lead = _lead_cmp(V, mt, ex["a"])
    if lead is None or not lead[0].startswith("lo"):
        return
    ex["loInc"] = lead[0] == "lo_in"
    ex["s"] = lead[1]


def _unit_class(V, utext):
    """-> (param, norm, scale) for a unit spelling, (None, None, 1) for a bare percent sign, None when unknown"""
    for P in V.params:
        for u in P["units"]:
            if u["re"].match(utext):
                return (P, u["norm"], u["scale"])
    if V.generic_unit.match(utext):
        return (None, None, 1)
    return None


def _comp_hits(V, text, lo, hi):
    hits = []
    seg = text[lo:hi]
    for ci, c in enumerate(V.comps):
        if c["re"] is None:
            continue
        for m in c["re"].finditer(seg):
            hits.append((lo + m.start(), lo + m.end(), ci))
    hits.sort()
    return hits


def _nearest_comp(V, text, s, e, lo_bound, hi_bound, claimed, mark, allowed=None, no_total=False):
    """component word for a number span: a word right behind the number (no comma between) wins, else the nearest word
    before it in the same clause; `total` only when nothing else is found. -> (component index | -1, word start)"""
    cb, ca = V.win.get("comp_before", 90), V.win.get("comp_after", 40)
    hits_b = [h for h in _comp_hits(V, text, max(lo_bound, s - cb), s) if h[0] not in claimed]
    hits_a = _comp_hits(V, text, e, min(hi_bound, e + ca))

    def usable(ci):
        if allowed is not None and ci not in allowed:
            return False
        if V.comps[ci]["fallback"] and no_total:
            return False
        return True
    for ws, we, ci in hits_a:
        if V.comps[ci]["fallback"] or not usable(ci):
            continue
        between = text[e:ws]
        if re.search(r"[,;:()]|\band\b|\bor\b|\bund\b|\boder\b", between):
            break
        if mark and ws not in claimed:
            claimed.add(ws)
        return ci, ws
    for ws, we, ci in reversed(hits_b):
        if V.comps[ci]["fallback"] or not usable(ci):
            continue
        return ci, ws
    if not no_total:
        for ws, we, ci in hits_a[:1] + hits_b[-1:]:
            if V.comps[ci]["fallback"] and usable(ci):
                return ci, ws
    return -1, -1


def _first_comp(V, text, s, c_lo, prev_end):
    """first component word between the start of the clause (or the previous number) and the number"""
    lo = max(c_lo, prev_end, s - V.win.get("comp_before", 90))
    for ws, we, ci in _comp_hits(V, text, lo, s):
        if not V.comps[ci]["fallback"]:
            return ci
    return -1
