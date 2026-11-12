/* LNP Patent Desk: numeric ranges in claims (global LnpRanges). Plain script, ASCII only. Also loads in Node
   (module.exports) for tests: LnpRanges.init({json: <parsed rg-1 document>}) or init({file: 'ranges.gz.bin'}).
   Data: xdata "ranges" (pipeline/ranges_build.py, format rg-1, docs/TOOLS_PLAN.md 2.4), read through
   LnpData.manifest.x.ranges; without it available() is false with the reason "not in this build".
   The ranges were found by pattern rules in claim text. Code decides, nothing here is a model output.

   LnpRanges.init(opts?)                      -> Promise<{available, reason, counts, v}>
   LnpRanges.available() / reason() / info()  -> bool / string / {v, built, counts, quotesInFile}
   LnpRanges.params() / comps()               -> [{id, label, unit}] / [{id, label}]
   LnpRanges.forClaim(pn|p, claim, {own})     -> Promise<[row]>   own + inherited ranges of the claim (own: true = only the claim's own)
   LnpRanges.forPatent(pn|p)                  -> Promise<[{claim, indep, deps, params: {param: {comp label: [row]}}}]>
   LnpRanges.check(values, {pns, ps, mode, strict, max})  a value with a component is compared with the ranges attributed to that component; when the claim has none, with the ranges whose
         component is unknown (marked compUnknown, never reported as "no range"). strict: true = only ranges attributed to the component.
         values = [{param, comp?, value, unit?}] -> Promise<{all, partial, matches, counts, values, limits}>
   LnpRanges.checkProfile(form, opts)         -> same, values taken from the LnpFto profile form (+ mapped, skipped)
   LnpRanges.quote(row)                       -> Promise<{text, start, len, source: 'file'|'claim'|'none', verified, cutStart, cutEnd}>
   row = {i, pn, claim, param, paramLabel, comp, compId, compLabel, lo, hi, loInc, hiInc, unit, approx, q, off, ml,
          inherited, fromClaim, text (readable range), lang}
   A claim's effective ranges: its own rows; rows of the parent claims for every (parameter, component) the claim does not
   mention itself (a dependent claim is narrower than its parent, so the nearest mention wins). */
(function (g) {
  'use strict';
  var S = { settled: false, doc: null, reason: 'not in this build', ready: null, cols: null, pnIdx: null, start: null, ctx: null, ctxN: 0, loader: null, info: null };
  var MAX_ROWS = 4000;

  var LIMITS = [
    'Ranges were found by pattern rules in the claim text; ranges that sit only in formula images or tables are not seen.',
    'Units are normalised (mol %, wt %, nm, Da, mg/mL, ratio a:b as a/b); "about" is treated as the stated number, although it can widen the claimed range.',
    'A claim range with a bare "%" does not state whether it is by mol or by weight: it is compared with values of either basis and marked "basis not stated".',
    'The component (ionizable lipid, PEG lipid, ...) is attributed by the nearest component word in the same clause: a heuristic. A value with a component is compared with the ranges attributed to that component; if the claim has none, with ranges whose component could not be identified (marked "component not identified": the range may belong to another component).',
    'A dependent claim takes over the ranges of the claims it refers to unless it states the same parameter itself.',
    'A value inside a stated range is not an infringement finding: other claim features decide. Pre-screening, not legal advice.'
  ];

  function err(code, message) { return { code: code, message: message }; }
  function num(v) { if (v == null || v === '') return null; var x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; }
  function fmt(x) { if (x == null) return ''; var r = Math.round(x * 1e6) / 1e6; return String(r); }

  /* ------------------------------------------------------------------ load */
  function readDoc(d) {
    var R = d.rows, n = R.pi.length, i;
    S.doc = d; S.cols = R; S.pnIdx = new Map(); S.ctx = new Map(); S.ctxN = 0;
    for (i = 0; i < d.pn.length; i++) S.pnIdx.set(d.pn[i], i);
    S.start = new Int32Array(d.pn.length + 1);
    var last = -1;
    for (i = 0; i < n; i++) { if (R.pi[i] !== last) { for (var k = last + 1; k <= R.pi[i]; k++) S.start[k] = i; last = R.pi[i]; } }
    for (i = last + 1; i <= d.pn.length; i++) S.start[i] = n;
    // lookup tables without a prototype: user input such as "__proto__" or "toString" must not hit inherited keys
    S.paramIdx = Object.create(null); d.params.forEach(function (p, j) { S.paramIdx[p.id] = j; });
    S.compIdx = Object.create(null); (d.compIds || []).forEach(function (c, j) { S.compIdx[c] = j; });
    S.compAlias = Object.create(null); Object.keys(d.compAlias || {}).forEach(function (k) { S.compAlias[k] = d.compAlias[k]; });
    // percent parameters with a stated basis (mol %, wt %): a claim row with a bare "%" was filed under one of them by the
    // extractor although the claim does not say which basis; such rows are compared with values of every basis and flagged
    S.pctBasis = Object.create(null); d.params.forEach(function (p, j) { var u = normUnit(p.unit); if (u.length > 1 && u.charAt(u.length - 1) === '%') S.pctBasis[j] = 1; });
    S.compLoose = {}; (d.compFallback || []).forEach(function (i) { S.compLoose[i] = 1; }); S.compLoose[-1] = 1;
    S.compHide = {}; (d.compAmbiguous || []).forEach(function (i) { S.compHide[i] = 1; });
    S.win = d.win || { lead: 40, max: 140 };
    S.hasQ = !!R.q;
    S.info = { v: d.v, rows: n, patents: d.pn.length, params: d.params.length, quotesInFile: !!R.q, compAlias: d.compAlias || {} };
    S.reason = '';
    return S.info;
  }

  function init(o) {
    o = o || {};
    if (S.ready && !o.force) return S.ready;
    S.ready = (function () {
      if (o.json) { readDoc(o.json); return Promise.resolve(status()); }
      if (o.file && typeof require === 'function') {
        try {
          var fs = require('fs'), zlib = require('zlib'), buf = fs.readFileSync(o.file);
          readDoc(JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')));
          if (o.qfile) { var qd = JSON.parse(zlib.gunzipSync(fs.readFileSync(o.qfile)).toString('utf8')); S.cols.q = qd.q; S.hasQ = true; S.info.quotesInFile = true; }
          return Promise.resolve(status());
        } catch (e) { S.reason = 'could not be read: ' + (e && e.message); return Promise.resolve(status()); }
      }
      var D = g.LnpData, man = D && D.manifest, x = man && man.x && man.x.ranges;
      if (!x) { S.reason = 'not in this build'; return Promise.resolve(status()); }
      if (!g.LnpLoader) { S.reason = 'loader missing'; return Promise.resolve(status()); }
      var here = '';
      try { if (document.currentScript && document.currentScript.src) here = document.currentScript.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); } catch (e) { /* ignore */ }
      var base = D.base() + 'x/ranges/';
      var L = g.LnpLoader.create({ base: base, enc: man.enc || 'auto', vendorUrl: new URL('../vendor/fflate.js', here || document.baseURI).href });
      S.loader = L;
      var files = x.files || {};
      return L.get('ranges.gz.bin', { as: 'json' }).then(function (d) {
        readDoc(d);
        if (!d.rows.q && files['ranges-q.gz.bin']) {      // website build: all quotes in a second file
          return L.get('ranges-q.gz.bin', { as: 'json' }).then(function (qd) { S.cols.q = qd.q; S.hasQ = true; S.info.quotesInFile = true; return status(); }, function () { return status(); });
        }
        return status();
      }, function (e) { S.reason = 'the data file could not be read: ' + (e && e.message ? e.message : 'error'); return status(); });
    })();
    S.ready = S.ready.then(function (r) { S.settled = true; return r; }, function (e) { S.settled = true; throw e; });
    return S.ready;
  }
  function has(pn) { return !!S.doc && S.pnIdx.has(pn); }
  function settled() { return S.settled; }
  function compId(x) { if (!S.doc) return ''; var i = compOf(x); return i != null && i >= 0 ? (S.doc.compIds || [])[i] || '' : ''; }
  function status() { return { available: !!S.doc, reason: S.reason, info: S.info }; }
  function available() { return !!S.doc; }
  function reason() { return S.doc ? '' : S.reason; }
  function info() { return S.info; }

  /* ------------------------------------------------------------------ rows */
  function params() { return S.doc ? S.doc.params.slice() : []; }
  function comps() { return S.doc ? S.doc.comps.map(function (l, i) { return { id: (S.doc.compIds || [])[i] || String(i), label: l, i: i }; }).filter(function (c) { return !S.compHide[c.i]; }).map(function (c) { return { id: c.id, label: c.label }; }) : []; }
  function compOf(c) {          // user input (index | id | label | alias) -> index | -1 | null (unspecified)
    if (c == null || c === '' || c === 'any') return null;
    if (typeof c === 'number') return c;
    var s = String(c).toLowerCase();
    if (typeof S.compIdx[s] === 'number') return S.compIdx[s];
    if (typeof S.compAlias[s] === 'string' && typeof S.compIdx[S.compAlias[s]] === 'number') return S.compIdx[S.compAlias[s]];
    var j = S.doc.comps.findIndex(function (l) { return l.toLowerCase() === s; });
    return j >= 0 ? j : null;
  }
  function rangeText(r) {
    var u = r.unit ? ' ' + r.unit : '';
    if (r.lo != null && r.hi != null) return r.lo === r.hi ? fmt(r.lo) + u : fmt(r.lo) + ' to ' + fmt(r.hi) + u + (!r.loInc || !r.hiInc ? ' (' + (r.loInc ? '[' : '(') + (r.hiInc ? ']' : ')') + ')' : '');
    if (r.lo != null) return (r.loInc ? '\u2265 ' : '> ') + fmt(r.lo) + u;
    if (r.hi != null) return (r.hiInc ? '\u2264 ' : '< ') + fmt(r.hi) + u;
    return '';
  }
  function row(i, pi) {
    var R = S.cols, d = S.doc, pj = R.param[i], ci = R.comp[i];
    var r = { i: i, pn: d.pn[pi], lang: (d.lang && d.lang[pi]) || 'en', claim: R.claim[i], param: d.params[pj].id, paramLabel: d.params[pj].label, comp: ci, compId: ci >= 0 ? (d.compIds || [])[ci] || null : null,
      compLabel: ci >= 0 ? d.comps[ci] : '', lo: R.lo[i], hi: R.hi[i], loInc: !!R.loInc[i], hiInc: !!R.hiInc[i], unit: R.unit[i] || '', approx: !!R.approx[i],
      q: R.q ? R.q[i] || '' : '', off: R.off[i], ml: R.ml ? R.ml[i] : 0, inherited: false, fromClaim: R.claim[i] };
    r.text = rangeText(r);
    return r;
  }
  function inside(r, x) {
    var e = 1e-9 * Math.max(1, Math.abs(x));
    if (r.lo != null && (r.loInc ? x < r.lo - e : x <= r.lo + e)) return false;
    if (r.hi != null && (r.hiInc ? x > r.hi + e : x >= r.hi - e)) return false;
    return true;
  }
  function dist(r, x) { if (r.lo != null && x < r.lo) return r.lo - x; if (r.hi != null && x > r.hi) return x - r.hi; return 0; }

  // per-patent structure: own rows by claim, parents, children
  function patCtx(pi) {
    var c = S.ctx.get(pi);
    if (c) return c;
    var d = S.doc, R = S.cols, own = new Map(), parents = new Map(), children = new Map(), i, a = S.start[pi], b = S.start[pi + 1];
    for (i = a; i < b; i++) {
      var cl = R.claim[i];
      if (!own.has(cl)) own.set(cl, []);
      own.get(cl).push(i);
      if (!parents.has(cl) && R.dep[i]) parents.set(cl, R.dep[i].split(',').map(Number));
    }
    var ch = d.chain && d.chain[String(pi)];
    if (ch) ch.split(';').forEach(function (s) { var m = s.split('<'); if (m.length === 2) parents.set(Number(m[0]), m[1].split(',').map(Number)); });
    parents.forEach(function (ps, cl) { ps.forEach(function (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(cl); }); });
    c = { pi: pi, own: own, parents: parents, children: children, eff: new Map() };
    if (S.ctxN > 1200) { S.ctx.clear(); S.ctxN = 0; }
    S.ctx.set(pi, c); S.ctxN++;
    return c;
  }
  function keyOf(i) { return S.cols.param[i] + '/' + S.cols.comp[i]; }
  // effective rows of a claim: [{i, from, inherited}]
  function effective(ctx, claim, depth, seen) {
    var hit = ctx.eff.get(claim);
    if (hit) return hit;
    var out = [], keys = {}, have = {}, mine = ctx.own.get(claim) || [];
    mine.forEach(function (i) { keys[keyOf(i)] = 1; have[i] = 1; out.push({ i: i, from: claim, inherited: false }); });
    var ps = ctx.parents.get(claim) || [];
    if (depth < 12 && ps.length) {
      seen = seen || {};
      seen[claim] = 1;
      ps.forEach(function (p) {
        if (seen[p]) return;
        effective(ctx, p, depth + 1, seen).forEach(function (e) {
          if (keys[keyOf(e.i)] === 1 || have[e.i]) return;
          have[e.i] = 1;
          out.push({ i: e.i, from: e.from, inherited: true });
        });
      });
      // rows from several parents with the same key stay (alternatives); mark none as seen so that all parents count
      delete seen[claim];
    }
    ctx.eff.set(claim, out);
    return out;
  }
  // same as effective() but only rows of the wanted parameters, as {i, from, inherited}; memo per publication (cleared by the caller)
  function effWanted(ctx, claim, want, memo, depth, seen) {
    var hit = memo.get(claim);
    if (hit) return hit;
    var R = S.cols, out = [], keys = {}, have = {}, mine = ctx.own.get(claim) || [], j;
    for (j = 0; j < mine.length; j++) { if (want[R.param[mine[j]]]) { keys[keyOf(mine[j])] = 1; have[mine[j]] = 1; out.push({ i: mine[j], from: claim, inherited: false }); } }
    var ps = ctx.parents.get(claim) || [];
    if (depth < 12 && ps.length) {
      seen = seen || {};
      seen[claim] = 1;
      ps.forEach(function (p) {
        if (seen[p]) return;
        effWanted(ctx, p, want, memo, depth + 1, seen).forEach(function (e) { if (keys[keyOf(e.i)] !== 1 && !have[e.i]) { have[e.i] = 1; out.push({ i: e.i, from: e.from, inherited: true }); } });
      });
      delete seen[claim];
    }
    memo.set(claim, out);
    return out;
  }
  function isIndep(ctx, claim) { var p = ctx.parents.get(claim); return !p || !p.length; }
  function piOf(x) {
    if (typeof x === 'number') {
      var D = g.LnpData;
      if (!D || !D.patent) return Promise.reject(err('no_data', 'a patent index needs LnpData'));
      return D.patent(x).then(function (p) { return S.pnIdx.has(p.pn) ? S.pnIdx.get(p.pn) : -1; });
    }
    var s = String(x || '');
    return Promise.resolve(S.pnIdx.has(s) ? S.pnIdx.get(s) : -1);
  }
  function need() { return init().then(function () { if (!S.doc) throw err('unavailable', 'Range data: ' + S.reason); }); }

  function forClaim(x, claim, o) {
    o = o || {};
    return need().then(function () { return piOf(x); }).then(function (pi) {
      if (pi < 0) return [];
      var ctx = patCtx(pi), res = [];
      var list = o.own ? (ctx.own.get(Number(claim)) || []).map(function (i) { return { i: i, from: Number(claim), inherited: false }; }) : effective(ctx, Number(claim), 0);
      list.forEach(function (e) { var r = row(e.i, pi); r.inherited = e.inherited; r.fromClaim = e.from; res.push(r); });
      return res;
    });
  }
  function forPatent(x) {
    return need().then(function () { return piOf(x); }).then(function (pi) {
      if (pi < 0) return [];
      var ctx = patCtx(pi), claims = new Set();
      ctx.own.forEach(function (v, k) { claims.add(k); });
      var all = Array.from(claims);       // dependents of those claims
      for (var j = 0; j < all.length; j++) { (ctx.children.get(all[j]) || []).forEach(function (c) { if (!claims.has(c)) { claims.add(c); all.push(c); } }); }
      return all.sort(function (a, b) { return a - b; }).map(function (cl) {
        var out = { claim: cl, indep: isIndep(ctx, cl), deps: (ctx.parents.get(cl) || []).slice(), params: {}, n: 0 };
        effective(ctx, cl, 0).forEach(function (e) {
          var r = row(e.i, pi); r.inherited = e.inherited; r.fromClaim = e.from;
          var pm = out.params[r.param] || (out.params[r.param] = {}), ck = r.compLabel || 'unassigned';
          (pm[ck] || (pm[ck] = [])).push(r);
          out.n++;
        });
        return out;
      }).filter(function (c) { return c.n > 0; });
    });
  }

  /* ------------------------------------------------------------------ check */
  function normUnit(u) { return String(u || '').toLowerCase().replace(/\s+/g, '').replace('\u00b5', 'u'); }
  function unitOk(rowUnit, valUnit) {
    if (!valUnit) return true;
    var a = normUnit(rowUnit), b = normUnit(valUnit);
    if (a === b) return true;
    return (a === '%' && (b === 'mol%' || b === 'wt%')) || (b === '%' && (a === 'mol%' || a === 'wt%')) || a === '' || b === '';
  }
  function normValues(values) {
    var out = [], skipped = [];
    (values || []).forEach(function (v, k) {
      if (!v) return;
      var pj = typeof v.param === 'string' ? S.paramIdx[v.param] : undefined, x = num(v.value);
      if (typeof pj !== 'number') { skipped.push({ index: k, reason: 'unknown parameter ' + String(v.param).slice(0, 40) }); return; }
      if (x == null) { skipped.push({ index: k, reason: 'no number for ' + v.param }); return; }
      var ci = compOf(v.comp);
      out.push({ param: v.param, pj: pj, paramLabel: S.doc.params[pj].label, comp: ci, compLabel: ci != null && ci >= 0 ? S.doc.comps[ci] : '', value: x, unit: v.unit || S.doc.params[pj].unit || '' });
    });
    return { values: out, skipped: skipped };
  }
  function judge(eff, v, pi, strict) {
    // eff: [{i, from, inherited}] of the claim (wanted parameters only); returns {status, row}
    var R = S.cols, cand = [], j, e, i, unknown = false;
    for (j = 0; j < eff.length; j++) { e = eff[j]; i = e.i; if ((R.param[i] === v.pj && unitOk(R.unit[i], v.unit)) || basisOpen(i, v)) cand.push(e); }
    if (v.comp != null && v.comp >= 0) {
      // ranges attributed to the component; when there are none, ranges whose component is unknown or "total" (compUnknown), unless strict
      var exact = cand.filter(function (x) { return R.comp[x.i] === v.comp; });
      if (exact.length) cand = exact;
      else if (strict) cand = [];
      else { cand = cand.filter(function (x) { return S.compLoose[R.comp[x.i]]; }); unknown = cand.length > 0; }
    }
    if (!cand.length) return { status: 'no_range_in_claim', row: null };
    var ins = [], dmin = Infinity, near = null;
    cand.forEach(function (x) {
      var r = rawRange(x.i);
      if (inside(r, v.value)) ins.push({ x: x, w: width(r) });
      else { var d = dist(r, v.value); if (d < dmin) { dmin = d; near = x; } }
    });
    if (ins.length) {
      ins.sort(function (a, b) { return (a.x.inherited - b.x.inherited) || (a.w - b.w); });
      return { status: 'inside', row: mkRow(ins[0].x, pi), compUnknown: unknown, basisUnknown: bareBasis(ins[0].x.i, v) };
    }
    var nx = near || cand[0];
    return { status: 'outside', row: mkRow(nx, pi), compUnknown: unknown, basisUnknown: bareBasis(nx.i, v) };
  }
  // a row with a bare "%" under a percent parameter of another basis (claim "10 to 20 %" vs a wt % value)
  function basisOpen(i, v) { var R = S.cols; return R.param[i] !== v.pj && !!S.pctBasis[R.param[i]] && !!S.pctBasis[v.pj] && normUnit(R.unit[i]) === '%'; }
  function bareBasis(i, v) { return !!S.pctBasis[v.pj] && normUnit(S.cols.unit[i]) === '%'; }
  function rawRange(i) { var R = S.cols; return { lo: R.lo[i], hi: R.hi[i], loInc: !!R.loInc[i], hiInc: !!R.hiInc[i] }; }
  function width(r) { return r.lo != null && r.hi != null ? r.hi - r.lo : 1e12; }
  function mkRow(e, pi) { var r = row(e.i, pi); r.inherited = e.inherited; r.fromClaim = e.from; return r; }

  function check(values, o) {
    o = o || {};
    return need().then(function () {
      var nv = normValues(values), V = nv.values, mode = o.mode === 'any' ? 'any' : 'all', strict = !!o.strict || o.loose === false;
      var res = { all: [], partial: [], matches: [], mode: mode, strict: strict, loose: !strict, values: V, skipped: nv.skipped, counts: { patents: 0, claimsAll: 0, claimsPartial: 0, patentsAll: 0, patentsPartial: 0, patentsScanned: 0, patentsWithAllParams: 0 }, truncated: false, limits: LIMITS.slice() };
      if (!V.length) return res;
      var scope = null;
      return Promise.resolve(o.pns ? o.pns : (o.ps ? Promise.all(o.ps.map(function (p) { return typeof p === 'number' ? g.LnpData.patent(p).then(function (x) { return x.pn; }) : p; })) : null)).then(function (pns) {
        if (pns) { scope = []; pns.forEach(function (pn) { if (S.pnIdx.has(pn)) scope.push(S.pnIdx.get(pn)); }); }
        // want: parameters whose rows are read; grp: the value group a row parameter counts for (all basis percent
        // parameters form one group as soon as a value is one of them, because bare "%" rows serve every basis)
        var want = {}, grp = {}, anyPct = V.some(function (v) { return S.pctBasis[v.pj]; });
        V.forEach(function (v) { want[v.pj] = 1; grp[v.pj] = S.pctBasis[v.pj] ? 'pct' : v.pj; });
        if (anyPct) Object.keys(S.pctBasis).forEach(function (j) { want[j] = 1; grp[j] = 'pct'; });
        var nWant = new Set(V.map(function (v) { return grp[v.pj]; })).size, max = o.max || MAX_ROWS;
        var order = scope || (function () { var a = []; for (var i = 0; i < S.doc.pn.length; i++) a.push(i); return a; })();
        var R = S.cols, pAll = new Set(), pPart = new Set();
        for (var oi = 0; oi < order.length; oi++) {
          var pi = order[oi], a = S.start[pi], b = S.start[pi + 1], seenP = {}, k, nSeen = 0;
          for (k = a; k < b; k++) { var pj = R.param[k]; if (want[pj] && !seenP[grp[pj]]) { seenP[grp[pj]] = 1; nSeen++; if (nSeen === nWant) break; } }
          res.counts.patentsScanned++;
          if (nSeen === 0) continue;
          if (nSeen === nWant) res.counts.patentsWithAllParams++;
          if (mode === 'all' && nSeen < nWant) { /* a claim can only be inside everywhere if the patent has every parameter; partial claims still count below */ }
          var ctx = patCtx(pi), cand = new Set(), stack = [], memo = new Map();
          for (k = a; k < b; k++) { if (want[R.param[k]] && !cand.has(R.claim[k])) { cand.add(R.claim[k]); stack.push(R.claim[k]); } }
          while (stack.length) { var cc = stack.pop(); (ctx.children.get(cc) || []).forEach(function (ch) { if (!cand.has(ch)) { cand.add(ch); stack.push(ch); } }); }
          Array.from(cand).sort(function (x, y) { return x - y; }).forEach(function (cl) {
            var eff = effWanted(ctx, cl, want, memo, 0);
            var vs = V.map(function (v) { var j = judge(eff, v, pi, strict); return { param: v.param, paramLabel: v.paramLabel, comp: v.compLabel, value: v.value, unit: v.unit, status: j.status, row: j.row, compUnknown: !!j.compUnknown, basisUnknown: !!j.basisUnknown }; });
            var nIn = vs.filter(function (x) { return x.status === 'inside'; }).length;
            if (!nIn) return;
            var item = { pn: S.doc.pn[pi], pi: pi, claim: cl, indep: isIndep(ctx, cl), nInside: nIn, nValues: V.length, values: vs, inheritedAny: vs.some(function (x) { return x.row && x.row.inherited; }), lang: (S.doc.lang && S.doc.lang[pi]) || 'en' };
            if (nIn === V.length) { item.verdict = 'all'; res.counts.claimsAll++; pAll.add(pi); if (res.all.length < max) res.all.push(item); else res.truncated = true; }
            else { item.verdict = 'partial'; res.counts.claimsPartial++; pPart.add(pi); if (res.partial.length < max) res.partial.push(item); else res.truncated = true; }
          });
        }
        // more values inside first; then claims whose hits rest on identified components and stated units
        function vague(c) { return c.values.filter(function (x) { return x.status === 'inside' && (x.compUnknown || x.basisUnknown); }).length; }
        function srt(a, b) { return (b.nInside - a.nInside) || (vague(a) - vague(b)) || ((b.indep ? 1 : 0) - (a.indep ? 1 : 0)) || (a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0) || (a.claim - b.claim); }
        res.all.sort(srt); res.partial.sort(srt);
        res.counts.patentsAll = pAll.size; res.counts.patentsPartial = pPart.size; res.counts.patents = new Set(Array.from(pAll).concat(Array.from(pPart))).size;
        res.matches = mode === 'all' ? res.all : res.all.concat(res.partial);
        return res;
      });
    });
  }

  // LnpFto profile form -> values (roles: ionizable | helper | sterol | peg | other)
  function profileValues(form) {
    var f = form || {}, vals = [], skipped = [], mol = {}, seen = {};
    var basisW = /^(w|wt|weight|mass|gew)/i.test(String(f.ratioBasis || ''));
    if (basisW) skipped.push('The lipid ratio of the profile is by weight: its percentages are compared with weight fractions (wt %) in the claims.');
    (Array.isArray(f.lipids) ? f.lipids : []).forEach(function (l) {
      l = l || {};
      var role = l.role || 'other', mp = num(l.molPct != null ? l.molPct : l.mol), pka = num(l.pka), pm = num(l.pegMw);
      if (mp != null) { mol[role] = (mol[role] || 0) + mp; seen[role] = 1; }
      if (pka != null) vals.push({ param: 'pka', comp: null, value: pka, unit: '' });      // pKa in claims is that of the ionizable lipid by construction: no component filter
      if (pm != null) vals.push({ param: 'peg_mw', comp: role === 'peg' ? 'peg' : role, value: pm, unit: 'Da' });
    });
    var molVals = [];
    Object.keys(mol).forEach(function (role) {
      if (role === 'other') { skipped.push('Lipids with role "other" (' + fmt(mol[role]) + ' mol %) are not checked: no component to attribute them to.'); return; }
      molVals.push({ param: basisW ? 'wt_pct' : 'mol_pct', comp: role, value: Math.round(mol[role] * 1e6) / 1e6, unit: basisW ? 'wt%' : 'mol%' });
    });
    vals = molVals.concat(vals);
    function add(param, v, unit) { var x = num(v); if (x != null) vals.push({ param: param, comp: null, value: x, unit: unit || '' }); }
    add('np_ratio', f.np);
    var p = f.particle || {}, pr = f.process || {};
    add('size_nm', p.sizeNm, 'nm'); add('pdi', p.pdi); add('encaps_pct', p.encapsulationPct, '%');
    add('ph', pr.ph); add('temp_c', pr.tempC, 'C');
    if (pr.ph != null && pr.ph !== '' || pr.tempC != null && pr.tempC !== '') skipped.push('pH and temperature are the process conditions at mixing; claim ranges for pH or temperature often refer to storage or to the final formulation, so a hit there is only a hint.');
    return { values: vals, skipped: skipped };
  }
  function checkProfile(form, o) {
    return need().then(function () {
      var pv = profileValues(form), r;
      return check(pv.values, o).then(function (res) { res.mapped = pv.values; res.skippedNotes = pv.skipped; res.profile = (form && form.name) || ''; return res; });
    });
  }

  /* ------------------------------------------------------------------ quotes */
  function cut(text, off, ml) {
    var a = Math.max(0, off - S.win.lead), b = Math.min(text.length, a + S.win.max);
    return { text: text.slice(a, b), start: off - a, len: Math.min(ml, b - off) };
  }
  // verbatim quote of a row: from the file, else cut from the claim text (LnpSearch.claims); verified against the claim text when it is there
  function quote(r) {
    var base = { text: '', start: 0, len: 0, source: 'none', verified: null };
    function fromClaim() {
      var D = g.LnpData, Sr = g.LnpSearch;
      if (!D || !Sr || !Sr.claims) return Promise.resolve(null);
      return D.byPn(r.pn, { exact: true }).then(function (p) { return p >= 0 ? Sr.claims(p, r.lang) : []; }).then(function (cs) {
        var c = (cs || []).filter(function (x) { return x.n === r.claim; })[0];
        return c && typeof c.text === 'string' ? c.text : null;
      }).catch(function () { return null; });
    }
    var fileStart = Math.min(r.off, S.win.lead);
    if (r.q) {
      return fromClaim().then(function (t) {
        var v = t == null ? null : t.slice(r.off - fileStart, r.off - fileStart + r.q.length) === r.q;
        return { text: r.q, start: fileStart, len: Math.min(r.ml, r.q.length - fileStart), source: 'file', verified: v, cutStart: r.off > S.win.lead, cutEnd: r.q.length >= S.win.max };
      });
    }
    return fromClaim().then(function (t) {
      if (t == null) return base;
      var c = cut(t, r.off, r.ml);
      return { text: c.text, start: c.start, len: c.len, source: 'claim', verified: true, cutStart: r.off > S.win.lead, cutEnd: c.text.length >= S.win.max && r.off - c.start + c.text.length < t.length + 0 };
    });
  }

  var api = { init: init, has: has, settled: settled, compId: compId, available: available, reason: reason, info: info, params: params, comps: comps, forClaim: forClaim, forPatent: forPatent, check: check, checkProfile: checkProfile,
    profileValues: profileValues, quote: quote, rangeText: rangeText, limits: function () { return LIMITS.slice(); }, _inside: inside };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpRanges = api;
})(typeof window !== 'undefined' ? window : globalThis);
