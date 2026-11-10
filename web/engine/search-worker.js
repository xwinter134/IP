/* LNP-FTO text search core (global LnpSearchCore). Plain script, ASCII only, no eval, no wasm.
   Runs (a) as a dedicated Worker from this file, (b) inside a blob: Worker (tok.js + loader.js + this file
   concatenated) and (c) on the main thread. Needs LnpTok (tok.js) and LnpLoader (loader.js).
   Worker protocol: {id, op, a: [args]} -> {id, ok: true, r} | {id, ok: false, error: {code, message}};
   progress events of the loader are posted as {ev: 'progress', ...}.
   Index format: pipeline/build_index.mjs; patent metadata (meta.gz.bin, cpc.gz.bin, pn.gz.bin): pipeline/build_dist.py.

   Query language (see docs/ARCHITECTURE.md): implicit AND, OR, NOT / -x, parentheses, "exact phrase", prefix*,
   a NEAR/n b, text fields claims: indep: dep: title: abstract: asg: (also as groups, e.g. title:(a OR b)),
   same:(...) = all conditions inside one claim, metadata cpc: auth: kind: year: prio: exp: player: pn: tier: seed:
   status: text: fam:, unit switches lang:de|en and indep:1.
   Boolean operators combine on the level of the PATENT by default (terms may sit in different claims);
   phrases and NEAR always match inside one claim / title / abstract. opts.scope = "claim" combines per claim. */
(function (g) {
  'use strict';
  var isWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
  if (isWorker && self.name === 'lnp-search' && !(g.LnpTok && g.LnpLoader)) {
    // classic worker started from this file: the two helper files sit next to it
    self.importScripts('tok.js', 'loader.js');
  }
  var MAX_PREFIX = 3000;
  function mkErr(code, message) { return { code: code, message: message }; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // field -> predicate on the 4 flag bits (bit0 independent, bit1 German, bits 2-3 kind: 0 claim 1 title 2 abstract 3 assignee)
  var FIELDS = { claims: 'claims', claim: 'claims', clm: 'claims', indep: 'indep', dep: 'dep', title: 'title', ti: 'title',
    abstract: 'abstract', ab: 'abstract', abs: 'abstract', asg: 'asg', assignee: 'asg', pa: 'asg', applicant: 'asg', all: 'all', same: 'same' };
  var METAS = { cpc: 1, auth: 1, kind: 1, year: 1, prio: 1, exp: 1, player: 1, pn: 1, tier: 1, seed: 1, seedtier: 1, status: 1, text: 1, fam: 1, family: 1, inforce: 1, compounds: 1 };
  function fieldPred(f, fl) {
    var k = (fl >> 2) & 3, ind = fl & 1;
    switch (f) {
      case 'claims': return k === 0;
      case 'indep': return k === 0 && ind === 1;
      case 'dep': return k === 0 && ind === 0;
      case 'title': return k === 1;
      case 'abstract': return k === 2;
      case 'asg': return k === 3;
      default: return k !== 3;                 // all text: claims, title, abstract
    }
  }

  // ------------------------------------------------------------------------------------------------ query parser
  function lex(q) {
    var out = [], re = /\s*(\(|\)|-?[A-Za-z_]+:(?=[("])|"[^"]*"?|[^\s()"]+)/g, m;
    while ((m = re.exec(q))) out.push(m[1]);
    return out;
  }
  function parseQuery(q, TOK) {
    var tk = lex(String(q || '')), i = 0, warnings = [], unit = {};
    function warn(code, message) { warnings.push({ code: code, message: message }); }
    function wordNode(w) {              // bare word, may contain several tokens ("C12-200", "A61K9/51") -> phrase
      var star = /\*$/.test(w), t = TOK.tokenize(w, true), ts = [], off = [], k;
      if (!t.length) return null;
      if (star) {
        if (t.length === 2) {
          if (t[0].length < 2) { warn('short_prefix', 'prefix "' + t[0] + '*" is too short (2 characters at least); ignored'); return null; }
          return { op: 'prefix', t: t[0] };
        }
        warn('prefix_in_phrase', '"' + w + '": the * is only supported on a single word; searched as a phrase');
      }
      for (k = 0; k < t.length; k += 2) if (!TOK.STOP.has(t[k])) { ts.push(t[k]); off.push(t[k + 1]); }
      if (!ts.length) { warn('stop_word', '"' + w + '" is a stop word and was ignored'); return null; }
      if (ts.length === 1) return { op: 'term', t: ts[0] };
      for (k = off.length - 1; k >= 0; k--) off[k] -= off[0];
      return { op: 'phrase', ts: ts, off: off };
    }
    function phraseNode(s) {
      var t = TOK.tokenize(s.replace(/\*/g, ' '), true), ts = [], off = [], k;
      for (k = 0; k < t.length; k += 2) if (!TOK.STOP.has(t[k])) { ts.push(t[k]); off.push(t[k + 1]); }
      if (!ts.length) { if (t.length) warn('stop_word', 'phrase "' + s + '" has only stop words and was ignored'); return null; }
      if (ts.length === 1) return { op: 'term', t: ts[0] };
      for (k = off.length - 1; k >= 0; k--) off[k] -= off[0];
      return { op: 'phrase', ts: ts, off: off };
    }
    function metaOrField(name, valueTok) {   // name is lower case, valueTok the text after the colon (may be quoted)
      var val = valueTok.charAt(0) === '"' ? valueTok.replace(/^"|"$/g, '') : valueTok;
      if (name === 'lang') { var l = val.toLowerCase(); if (l === 'de' || l === 'en') unit.lang = l; else warn('bad_value', 'lang: expects de or en'); return null; }
      if (name === 'indep' && /^(1|0|true|false|yes|no)$/i.test(val)) { if (/^(1|true|yes)$/i.test(val)) unit.indep = true; return null; }
      if (name === 'scope') { if (/^(claim|patent)$/i.test(val)) unit.scope = val.toLowerCase(); return null; }
      if (METAS[name]) return { op: 'meta', k: name === 'family' ? 'fam' : name, v: val };
      var f = FIELDS[name], inner = valueTok.charAt(0) === '"' ? phraseNode(val) : wordNode(val);
      if (!inner) return null;
      // names: a bare word in asg: matches the beginning of a name token (asg:moderna finds "ModernaTX")
      if (f === 'asg' && inner.op === 'term' && inner.t.length >= 3 && valueTok.charAt(0) !== '"') inner = { op: 'prefix', t: inner.t };
      return f === 'same' ? inner : { op: 'field', f: f, a: inner };
    }
    function primary() {
      var t = tk[i++], m, e;
      if (t === undefined) return null;
      if (t === '(') { e = orExpr(); if (tk[i] === ')') i++; else warn('paren', 'missing closing parenthesis'); return e; }
      if (t === ')') { warn('paren', 'unexpected closing parenthesis'); return null; }
      if (t.charAt(0) === '"') return phraseNode(t.replace(/^"|"$/g, ''));
      if ((m = /^([A-Za-z_]+):$/.exec(t)) && (FIELDS[m[1].toLowerCase()] || METAS[m[1].toLowerCase()] || /^(lang|scope)$/i.test(m[1]))) {
        var name = m[1].toLowerCase(), nx = tk[i];
        if (nx === '(') {
          i++; e = orExpr(); if (tk[i] === ')') i++; else warn('paren', 'missing closing parenthesis');
          if (!e) return null;
          if (METAS[name]) { warn('bad_value', name + ': does not take a group'); return null; }
          return FIELDS[name] === 'same' ? { op: 'same', a: e } : { op: 'field', f: FIELDS[name], a: e };
        }
        if (nx !== undefined && nx.charAt(0) === '"') { i++; return metaOrField(name, nx); }
        return null;
      }
      if ((m = /^([A-Za-z_]+):(.+)$/.exec(t))) {
        var nm = m[1].toLowerCase();
        if (FIELDS[nm] || METAS[nm] || nm === 'lang' || nm === 'scope') return metaOrField(nm, m[2]);
      }
      return wordNode(t);
    }
    function nearable(n) { return n && (n.op === 'term' || n.op === 'prefix' || n.op === 'phrase' || n.op === 'near' || (n.op === 'or' && n.xs.every(nearable))); }
    function nearExpr() {
      var a = primary(), m;
      while (i < tk.length && (m = /^NEAR(?:\/(\d+))?$/.exec(tk[i]))) {
        i++; var b = primary(), n = m[1] ? +m[1] : 5;
        if (!a || !b) { a = a || b; continue; }
        if (!nearable(a) || !nearable(b)) { warn('near', 'NEAR needs words, phrases, prefixes or OR groups of them on both sides; used AND instead'); a = { op: 'and', xs: [a, b] }; continue; }
        a = { op: 'near', a: a, b: b, n: Math.max(1, Math.min(n, 1000)) };
      }
      return a;
    }
    function unary() {
      var t = tk[i];
      if (t === 'NOT' || t === '-') { i++; var a = unary(); return a ? { op: 'not', a: a } : null; }
      if (t && t.length > 1 && t.charAt(0) === '-' && !/^-?\d/.test(t.slice(1))) { tk[i] = t.slice(1); var b = nearExpr(); return b ? { op: 'not', a: b } : null; }
      return nearExpr();
    }
    function andExpr() {
      var xs = [];
      while (i < tk.length && tk[i] !== ')' && tk[i] !== 'OR') {
        if (tk[i] === 'AND') { i++; continue; }
        var a = unary(); if (a) xs.push(a);
      }
      return xs.length === 1 ? xs[0] : xs.length ? { op: 'and', xs: xs } : null;
    }
    function orExpr() {
      var xs = [], a = andExpr(); if (a) xs.push(a);
      while (tk[i] === 'OR') { i++; a = andExpr(); if (a) xs.push(a); }
      return xs.length === 1 ? xs[0] : xs.length ? { op: 'or', xs: xs } : null;
    }
    var ast = orExpr();
    while (i < tk.length) {             // stray ")" etc.: keep going, AND the rest
      if (tk[i] === ')') { i++; warn('paren', 'unexpected closing parenthesis'); continue; }
      var rest = orExpr(); if (rest) ast = ast ? { op: 'and', xs: [ast, rest] } : rest;
    }
    return { query: String(q || ''), ast: ast, unit: unit, warnings: warnings };
  }

  // ------------------------------------------------------------------------------------------------ highlight
  // Occurrences of the positive parts of a query inside one text -> sorted token indexes
  function matchTokens(sp, ast) {
    var nTok = sp.length / 4, byTerm = new Map(), i;
    for (i = 0; i < nTok; i++) { var t = sp[i * 4]; var a = byTerm.get(t); if (a) a.push(i); else byTerm.set(t, [i]); }
    var mark = new Uint8Array(nTok);
    function occ(n) {                   // -> array of occurrences [start, end] (token indexes, inclusive)
      var out = [], k, x;
      if (!n) return out;
      if (n.op === 'term') { (byTerm.get(n.t) || []).forEach(function (p) { out.push([p, p]); }); return out; }
      if (n.op === 'prefix') { for (k = 0; k < nTok; k++) { x = sp[k * 4]; if (x.length <= 40 && x.lastIndexOf(n.t, 0) === 0) out.push([k, k]); } return out; }
      if (n.op === 'phrase') {
        (byTerm.get(n.ts[0]) || []).forEach(function (p) {
          for (var j = 1; j < n.ts.length; j++) if (sp[(p + n.off[j]) * 4] !== n.ts[j]) return;
          out.push([p, p + n.off[n.ts.length - 1]]);
        });
        return out;
      }
      if (n.op === 'or') { n.xs.forEach(function (c) { out = out.concat(occ(c)); }); out.sort(function (p, q) { return p[0] - q[0]; }); return out; }
      if (n.op === 'near') {
        var A = occ(n.a), B = occ(n.b);
        A.forEach(function (pa) { if (B.some(function (pb) { return pa[0] !== pb[0] && Math.abs(pa[0] - pb[0]) <= n.n; })) out.push(pa); });
        B.forEach(function (pb) { if (A.some(function (pa) { return pa[0] !== pb[0] && Math.abs(pa[0] - pb[0]) <= n.n; })) out.push(pb); });
        out.sort(function (p, q) { return p[0] - q[0]; });
        return out;
      }
      return out;
    }
    function walk(n) {
      if (!n) return;
      if (n.op === 'and' || n.op === 'or' && !n.xs.every(function (c) { return c.op === 'term' || c.op === 'prefix' || c.op === 'phrase' || c.op === 'near'; })) { n.xs.forEach(walk); return; }
      if (n.op === 'field' || n.op === 'same') { walk(n.a); return; }
      if (n.op === 'not' || n.op === 'meta') return;
      occ(n).forEach(function (o) { for (var k = o[0]; k <= o[1]; k++) mark[k] = 1; });
    }
    walk(ast);
    return mark;
  }
  // -> [[text, isMatch], ...]; the pieces concatenate to the input text
  function highlightText(text, ast, TOK) {
    text = String(text == null ? '' : text);
    if (!ast || !text) return text ? [[text, false]] : [];
    var sp = TOK.spans(text), mark = matchTokens(sp, ast), out = [], pos = 0, n = sp.length / 4, i = 0;
    while (i < n) {
      if (!mark[i]) { i++; continue; }
      var j = i; while (j + 1 < n && mark[j + 1]) j++;
      var s = sp[i * 4 + 2], e = sp[j * 4 + 3];
      if (s > pos) out.push([text.slice(pos, s), false]);
      out.push([text.slice(s, e), true]); pos = e; i = j + 1;
    }
    if (pos < text.length) out.push([text.slice(pos), false]);
    return out;
  }
  function snippetOf(text, ast, TOK, maxLen) {
    maxLen = maxLen || 280;
    var segs = highlightText(text, ast, TOK);
    if (text.length <= maxLen) return segs;
    var firstM = -1, off = 0, k;
    for (k = 0; k < segs.length; k++) { if (segs[k][1]) { firstM = off; break; } off += segs[k][0].length; }
    var start = firstM < 0 ? 0 : Math.max(0, firstM - 70);
    if (start > 0) { var sp = text.indexOf(' ', start); if (sp >= 0 && sp < start + 30) start = sp + 1; }
    var end = Math.min(text.length, start + maxLen);
    if (end < text.length) { var sp2 = text.lastIndexOf(' ', end); if (sp2 > end - 30) end = sp2; }
    var out = [], pos = 0;
    if (start > 0) out.push(['... ', false]);
    for (k = 0; k < segs.length; k++) {
      var s = pos, e = pos + segs[k][0].length; pos = e;
      if (e <= start || s >= end) continue;
      out.push([segs[k][0].slice(Math.max(0, start - s), Math.min(e, end) - s), segs[k][1]]);
    }
    if (end < text.length) out.push([' ...', false]);
    return out;
  }

  // ------------------------------------------------------------------------------------------------ engine
  function create(env) {
    env = env || {};
    var TOK = env.TOK || g.LnpTok, LD = env.Loader || g.LnpLoader;
    if (!TOK || !LD) throw mkErr('missing_dep', 'LnpSearchCore needs tok.js and loader.js');
    var loader = null, M = null, IX = null, D = 0, P = 0, ready = null;
    var uFirst, uLen, uNo, uFlag, uPat, uNorm, avgArr;
    var meta = null, cpcIdx = null, pnList = null, pnMap = null, lexicon = null, imgIndex = null;
    var postShards, posShards, textShards, defShards, postCache, prefixCache, entryCache, utf8 = new TextDecoder('utf-8');
    var W = new Float32Array(16);
    (function () { for (var f = 0; f < 16; f++) { var k = (f >> 2) & 3; W[f] = k === 1 ? 1.6 : k === 2 ? 0.9 : k === 3 ? 1.0 : (f & 1) ? 1.3 : 1.0; } })();

    function init(o) {
      if (ready) return ready;
      o = o || {};
      loader = env.loader || LD.create({ base: o.base == null ? 'data/' : o.base, enc: o.enc || 'auto', fetch: o.fetch || env.fetch, gzip: o.gzip, vendorUrl: o.vendorUrl, cacheBytes: 24e6, onProgress: env.onProgress });
      postShards = new LD.LRU(o.postCacheBytes || 40e6); posShards = new LD.LRU(o.posCacheBytes || 32e6);
      textShards = new LD.LRU(o.textCacheBytes || 96e6); defShards = new LD.LRU(24e6); entryCache = new LD.LRU(24e6);
      postCache = new LD.LRU(o.postingsCacheBytes || 36e6); prefixCache = new LD.LRU(12e6);
      var t0 = now();
      ready = Promise.resolve(o.manifest || loader.get('manifest.json', { as: 'json', cache: false })).then(function (man) {
        M = man; IX = man.idx;
        if (!IX) throw mkErr('no_index', 'manifest.json has no text index section');
        if (IX.tok !== TOK.VERSION) throw mkErr('tok_version', 'the index was built with tokenizer version ' + IX.tok + ', this page has ' + TOK.VERSION);
        if (man.enc && !o.enc) loader.setEnc(man.enc);
        if (man.files) { var sz = {}; for (var k in man.files) sz[k.replace(/^data\//, '')] = man.files[k][0]; loader.setSizes(sz); }
        return Promise.all([loader.get('idx/' + IX.docs, { as: 'bin', cache: false }), loader.get(man.meta.file, { as: 'bin', cache: false })]);
      }).then(function (r) {
        var b = r[0], dv = new DataView(b); D = dv.getUint32(0, true); P = dv.getUint32(4, true);
        var o2 = 8;
        uFirst = new Uint32Array(b.slice(o2, o2 + 4 * (P + 1))); o2 += 4 * (P + 1);
        uLen = new Uint16Array(b.slice(o2, o2 + 2 * D)); o2 += 2 * D;
        uNo = new Uint16Array(b.slice(o2, o2 + 2 * D)); o2 += 2 * D;
        uFlag = new Uint8Array(b.slice(o2, o2 + D));
        uPat = new Uint32Array(D);
        for (var p = 0; p < P; p++) for (var d = uFirst[p], e = uFirst[p + 1]; d < e; d++) uPat[d] = p;
        avgArr = [IX.avg.claim || 1, IX.avg.title || 1, IX.avg.abstract || 1, IX.avg.asg || 1];
        uNorm = new Float32Array(D);
        var k1 = IX.k1, bb = IX.b;
        for (var u = 0; u < D; u++) uNorm[u] = k1 * (1 - bb + bb * uLen[u] / avgArr[(uFlag[u] >> 2) & 3]);
        meta = parseMeta(r[1]);
        if (meta.P !== P) throw mkErr('mismatch', 'patent table (' + meta.P + ') and text index (' + P + ') have different sizes');
        return { D: D, P: P, terms: IX.nTerms, claims: IX.counts.claims, ms: Math.round(now() - t0), gzip: loader.diag().gzip, enc: loader.diag().enc };
      });
      ready.catch(function () { ready = null; });
      return ready;
    }
    function parseMeta(buf) {
      var dv = new DataView(buf), jl = dv.getUint32(0, true);
      var h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl))), base = (4 + jl + 3) & ~3, m = { P: h.P, h: h };
      var T = { i32: Int32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };
      h.cols.forEach(function (c) { var A = T[c.type]; m[c.name] = new A(buf.slice(base + c.off, base + c.off + c.n * A.BYTES_PER_ELEMENT)); });
      m.year = new Uint16Array(h.P); m.prioYear = new Uint16Array(h.P); m.expYear = new Uint16Array(h.P);
      for (var i = 0; i < h.P; i++) { m.year[i] = (m.pub[i] / 10000) | 0; m.prioYear[i] = (m.prio[i] / 10000) | 0; m.expYear[i] = (m.exp[i] / 10000) | 0; }
      return m;
    }
    function need() { if (!ready) return Promise.reject(mkErr('not_ready', 'call init() first')); return ready; }

    // ---------------------------------------------------------------- shards
    function shardFor(list, term) { var lo = 0, hi = list.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (list[mid][1] <= term) lo = mid; else hi = mid - 1; } return lo; }
    function getShard(kind, i) {
      var lru = kind === 'post' ? postShards : posShards, s = lru.get(i);
      if (s) return s;
      var f = IX[kind][i];
      s = loader.get('idx/' + f[0], { as: 'bin', cache: false }).then(function (buf) {
        var dl = new DataView(buf).getUint32(0, true), dict = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, dl)));
        var idx = new Map(); for (var j = 0; j < dict.t.length; j++) idx.set(dict.t[j], j);
        return { dict: dict, idx: idx, data: new Uint8Array(buf, 4 + dl) };
      });
      lru.set(i, s, f[2] * 4 + 200000);
      s.catch(function () { lru.delete(i); });
      return s;
    }
    // postings of one term -> {docs: Uint32Array, tfs: Uint16Array, df, term} | null
    function termPost(term) {
      var c = postCache.get(term);
      if (c !== undefined) return Promise.resolve(c);
      var pr = getShard('post', shardFor(IX.post, term)).then(function (s) {
        var j = s.idx.get(term); if (j === undefined) return null;
        var df = s.dict.d[j], docs = new Uint32Array(df), tfs = new Uint16Array(df), a = s.data, p = s.dict.o[j], d = -1, v, sh, b;
        for (var i = 0; i < df; i++) {
          v = 0; sh = 0; do { b = a[p++]; v |= (b & 127) << sh; sh += 7; } while (b & 128); d += v + 1; docs[i] = d;
          v = 0; sh = 0; do { b = a[p++]; v |= (b & 127) << sh; sh += 7; } while (b & 128); tfs[i] = v;
        }
        var r = { docs: docs, tfs: tfs, df: df, term: term };
        postCache.set(term, r, df * 6 + 200);        // replace the promise by the value
        return r;
      });
      postCache.set(term, pr, 200);
      pr.catch(function () { postCache.delete(term); });
      return pr;
    }
    // Position lists are flat: {docs: sorted unit ids, off: Uint32Array(n + 1), pos: Int32Array}; positions of
    // docs[i] are pos[off[i] .. off[i+1]-1], ascending.
    var EMPTY_PL = { docs: new Uint32Array(0), off: new Uint32Array(1), pos: new Int32Array(0) };
    // positions of `term` in the units of cand (sorted Uint32Array)
    function positionsFor(term, post, cand) {
      if (!post || !cand.length) return Promise.resolve(EMPTY_PL);
      return getShard('pos', shardFor(IX.pos, term)).then(function (s) {
        var j = s.idx.get(term); if (j === undefined) return EMPTY_PL;
        var docs = post.docs, tfs = post.tfs, n = post.df, nc = cand.length, ci = 0, m = 0, tot = 0, i, d, tf, t;
        for (i = 0; i < n && ci < nc; i++) { d = docs[i]; while (ci < nc && cand[ci] < d) ci++; if (ci < nc && cand[ci] === d) { m++; tot += tfs[i]; ci++; } }
        var od = new Uint32Array(m), off = new Uint32Array(m + 1), pos = new Int32Array(tot), a = s.data, p = s.dict.o[j], w = 0, k = 0, v, sh, b, x;
        ci = 0;
        for (i = 0; i < n && k < m; i++) {
          d = docs[i]; tf = tfs[i];
          while (ci < nc && cand[ci] < d) ci++;
          if (ci < nc && cand[ci] === d) {
            od[k] = d; off[k] = w; x = 0;
            for (t = 0; t < tf; t++) { v = 0; sh = 0; do { b = a[p++]; v |= (b & 127) << sh; sh += 7; } while (b & 128); x += v; pos[w++] = x; }
            k++; ci++;
          } else for (t = 0; t < tf; t++) { while (a[p++] & 128) { /* skip */ } }
        }
        off[m] = w;
        return { docs: od, off: off, pos: pos };
      });
    }
    function prefixTerms(prefix) {
      var out = [], i = shardFor(IX.post, prefix), truncated = false;
      function step() {
        if (i >= IX.post.length || truncated) return out;
        if (IX.post[i][1] > prefix && IX.post[i][1].lastIndexOf(prefix, 0) !== 0) return out;
        return getShard('post', i).then(function (s) {
          var t = s.dict.t, lo = 0, hi = t.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (t[mid] < prefix) lo = mid + 1; else hi = mid; }
          for (; lo < t.length && t[lo].lastIndexOf(prefix, 0) === 0; lo++) { if (out.length >= MAX_PREFIX) { truncated = true; break; } out.push(t[lo]); }
          if (lo < t.length) return out;       // the range ended inside this shard
          i++; return step();
        });
      }
      return Promise.resolve(step()).then(function () { return { terms: out, truncated: truncated }; });
    }
    // merged postings of all expansions of a prefix (one pseudo term)
    function prefixPost(prefix, ctx) {
      var c = prefixCache.get(prefix);
      if (c !== undefined) return Promise.resolve(c).then(function (r) { if (r.truncated && ctx) ctx.warn('prefix_truncated', prefix + '*: more than ' + MAX_PREFIX + ' index terms, only the first ' + MAX_PREFIX + ' were used'); return r; });
      var pr = prefixTerms(prefix).then(function (x) {
        return Promise.all(x.terms.map(termPost)).then(function (ps) {
          var tmp = new Uint16Array(D), i, k, n = 0;
          for (k = 0; k < ps.length; k++) { var p = ps[k]; if (!p) continue; for (i = 0; i < p.df; i++) { var d = p.docs[i]; if (!tmp[d]) n++; var s = tmp[d] + p.tfs[i]; tmp[d] = s > 65535 ? 65535 : s; } }
          var docs = new Uint32Array(n), tfs = new Uint16Array(n), j = 0;
          if (n) for (i = 0; i < D; i++) if (tmp[i]) { docs[j] = i; tfs[j++] = tmp[i]; }
          var r = { docs: docs, tfs: tfs, df: n, terms: x.terms, truncated: x.truncated, prefix: prefix };
          prefixCache.set(prefix, r, n * 6 + x.terms.length * 20 + 200);
          return r;
        });
      });
      prefixCache.set(prefix, pr, 200);
      pr.catch(function () { prefixCache.delete(prefix); });
      return pr.then(function (r) { if (r.truncated && ctx) ctx.warn('prefix_truncated', prefix + '*: more than ' + MAX_PREFIX + ' index terms, only the first ' + MAX_PREFIX + ' were used'); return r; });
    }

    // ---------------------------------------------------------------- unit level leaves
    // Every leaf returns {docs: sorted unit ids that pass the field table, tfs, df, boost}.
    function filterPost(post, tbl) {
      if (!post) return { docs: new Uint32Array(0), tfs: new Uint16Array(0), df: 0, boost: 1 };
      var n = post.df, docs = post.docs, c = 0, i;
      for (i = 0; i < n; i++) if (tbl[uFlag[docs[i]]]) c++;
      if (c === n) return { docs: docs, tfs: post.tfs, df: post.df, boost: 1 };
      var od = new Uint32Array(c), ot = new Uint16Array(c), j = 0;
      for (i = 0; i < n; i++) if (tbl[uFlag[docs[i]]]) { od[j] = docs[i]; ot[j++] = post.tfs[i]; }
      return { docs: od, tfs: ot, df: post.df, boost: 1 };
    }
    function markOf(docs) { var m = new Uint8Array(D); for (var i = 0; i < docs.length; i++) m[docs[i]] = 1; return m; }
    function intersect(A, B) {            // two sorted Uint32Arrays
      var out = new Uint32Array(Math.min(A.length, B.length)), i = 0, j = 0, k = 0, na = A.length, nb = B.length;
      while (i < na && j < nb) { var x = A[i], y = B[j]; if (x === y) { out[k++] = x; i++; j++; } else if (x < y) i++; else j++; }
      return out.subarray(0, k);
    }
    function merge2(A, B) {               // union of two position lists
      var na = A.docs.length, nb = B.docs.length, docs = new Uint32Array(na + nb), off = new Uint32Array(na + nb + 1), pos = new Int32Array(A.pos.length + B.pos.length);
      var i = 0, j = 0, k = 0, w = 0, x, e, y, f;
      while (i < na || j < nb) {
        var da = i < na ? A.docs[i] : 4294967295, db = j < nb ? B.docs[j] : 4294967295;
        off[k] = w;
        if (da < db) { docs[k] = da; for (x = A.off[i], e = A.off[i + 1]; x < e; x++) pos[w++] = A.pos[x]; i++; }
        else if (db < da) { docs[k] = db; for (y = B.off[j], f = B.off[j + 1]; y < f; y++) pos[w++] = B.pos[y]; j++; }
        else {
          docs[k] = da; x = A.off[i]; e = A.off[i + 1]; y = B.off[j]; f = B.off[j + 1];
          while (x < e || y < f) {
            var pa = x < e ? A.pos[x] : 2147483647, pb = y < f ? B.pos[y] : 2147483647;
            if (pa < pb) { pos[w++] = pa; x++; } else if (pb < pa) { pos[w++] = pb; y++; } else { pos[w++] = pa; x++; y++; }
          }
          i++; j++;
        }
        k++;
      }
      off[k] = w;
      return { docs: docs.subarray(0, k), off: off.subarray(0, k + 1), pos: pos.subarray(0, w) };
    }
    function mergePos(lists) {
      lists = lists.filter(function (l) { return l.docs.length > 0; });
      if (!lists.length) return EMPTY_PL;
      while (lists.length > 1) {          // balanced rounds
        var next = [];
        for (var i = 0; i < lists.length; i += 2) next.push(i + 1 < lists.length ? merge2(lists[i], lists[i + 1]) : lists[i]);
        lists = next;
      }
      return lists[0];
    }
    // start positions of every occurrence of a NEAR operand in the units of cand -> position list
    function occPositions(n, tbl, cand, ctx) {
      if (n.op === 'term') return termPost(n.t).then(function (p) { return positionsFor(n.t, p, cand); });
      if (n.op === 'prefix') {
        return prefixPost(n.t, ctx).then(function (pp) {
          return Promise.all(pp.terms.map(function (t) { return termPost(t).then(function (p) { return positionsFor(t, p, cand); }); })).then(mergePos);
        });
      }
      if (n.op === 'phrase') return phraseMatch(n, tbl, cand).then(function (r) { return r.pl; });
      if (n.op === 'near') return nearMatch(n, tbl, cand, ctx).then(function (r) { return r.pl; });
      if (n.op === 'or') return Promise.all(n.xs.map(function (c) { return occPositions(c, tbl, cand, ctx); })).then(mergePos);
      return Promise.resolve(EMPTY_PL);
    }
    function noHits(boost) { return { docs: new Uint32Array(0), tfs: new Uint16Array(0), df: 0, boost: boost, pl: EMPTY_PL }; }
    // exact phrase; candIn (sorted unit ids) optionally restricts the units -> {docs, tfs, df, boost, pl: start positions}
    function phraseMatch(n, tbl, candIn) {
      return Promise.all(n.ts.map(termPost)).then(function (ps) {
        var K = ps.length, k, i;
        for (k = 0; k < K; k++) if (!ps[k]) return noHits(K);
        var cnt = new Uint8Array(D), small = 0;
        for (k = 0; k < K; k++) { var p = ps[k], pd = p.docs; if (p.df < ps[small].df) small = k; for (i = 0; i < p.df; i++) cnt[pd[i]]++; }
        var sd = ps[small].docs, cand = new Uint32Array(sd.length), nc = 0, ci = 0, ncin = candIn ? candIn.length : 0;
        for (i = 0; i < sd.length; i++) {
          var d = sd[i];
          if (cnt[d] < K || !tbl[uFlag[d]]) continue;
          if (candIn) { while (ci < ncin && candIn[ci] < d) ci++; if (ci >= ncin) break; if (candIn[ci] !== d) continue; }
          cand[nc++] = d;
        }
        if (!nc) return noHits(K);
        cand = cand.subarray(0, nc);
        return Promise.all(ps.map(function (p2, k2) { return positionsFor(n.ts[k2], p2, cand); })).then(function (PL) {
          var P0 = PL[0], docs = new Uint32Array(nc), tfs = new Uint16Array(nc), off = new Uint32Array(nc + 1), pos = new Int32Array(P0.pos.length), m = 0, w = 0;
          for (i = 0; i < nc; i++) {
            var w0 = w;
            for (var x = P0.off[i], e = P0.off[i + 1]; x < e; x++) {
              var base = P0.pos[x], ok = true;
              for (var k3 = 1; k3 < K && ok; k3++) {
                var Pk = PL[k3], lo = Pk.off[i], hi = Pk.off[i + 1] - 1, tgt = base + n.off[k3], pk = Pk.pos; ok = false;
                while (lo <= hi) { var mid = (lo + hi) >> 1, v = pk[mid]; if (v === tgt) { ok = true; break; } if (v < tgt) lo = mid + 1; else hi = mid - 1; }
              }
              if (ok) pos[w++] = base;
            }
            if (w > w0) { docs[m] = cand[i]; tfs[m] = w - w0 > 65535 ? 65535 : w - w0; off[m] = w0; m++; }
          }
          off[m] = w;
          return { docs: docs.subarray(0, m), tfs: tfs.subarray(0, m), df: m, boost: K, pl: { docs: docs.subarray(0, m), off: off.subarray(0, m + 1), pos: pos.subarray(0, w) } };
        });
      });
    }
    function unitDocs(n, tbl, ctx) {      // sorted unit ids of a NEAR operand
      if (n.op === 'term') return termPost(n.t).then(function (p) { return filterPost(p, tbl).docs; });
      if (n.op === 'prefix') return prefixPost(n.t, ctx).then(function (p) { return filterPost(p, tbl).docs; });
      if (n.op === 'phrase') return phraseMatch(n, tbl, null).then(function (r) { return r.docs; });
      if (n.op === 'near') return nearMatch(n, tbl, null, ctx).then(function (r) { return r.docs; });
      if (n.op === 'or') {
        return Promise.all(n.xs.map(function (c) { return unitDocs(c, tbl, ctx); })).then(function (ls) {
          var m = new Uint8Array(D), c = 0, i, k;
          for (k = 0; k < ls.length; k++) for (i = 0; i < ls[k].length; i++) { if (!m[ls[k][i]]) { m[ls[k][i]] = 1; c++; } }
          var out = new Uint32Array(c), j = 0; for (i = 0; i < D && j < c; i++) if (m[i]) out[j++] = i;
          return out;
        });
      }
      return Promise.resolve(new Uint32Array(0));
    }
    // a NEAR/n b: an occurrence of a and one of b in the same unit, start positions at most n apart (either order)
    function nearMatch(n, tbl, candIn, ctx) {
      return Promise.all([unitDocs(n.a, tbl, ctx), unitDocs(n.b, tbl, ctx)]).then(function (dl) {
        var cand = intersect(dl[0], dl[1]);
        if (candIn) cand = intersect(cand, candIn);
        if (!cand.length) return noHits(2);
        return Promise.all([occPositions(n.a, tbl, cand, ctx), occPositions(n.b, tbl, cand, ctx)]).then(function (pp) {
          var A = pp[0], B = pp[1], na = A.docs.length, nb = B.docs.length, i = 0, j = 0, m = 0, w = 0, dist = n.n;
          var docs = new Uint32Array(Math.min(na, nb)), tfs = new Uint16Array(Math.min(na, nb)), off = new Uint32Array(Math.min(na, nb) + 1), pos = new Int32Array(A.pos.length + B.pos.length);
          while (i < na && j < nb) {
            var da = A.docs[i], db = B.docs[j];
            if (da < db) { i++; continue; }
            if (db < da) { j++; continue; }
            // mark matching positions of both sides, then write them merged and de-duplicated
            var a0 = A.off[i], a1 = A.off[i + 1], b0 = B.off[j], b1 = B.off[j + 1], x, y, lo = b0, w0 = w, hit = [];
            for (x = a0; x < a1; x++) {
              var pa = A.pos[x];
              while (lo < b1 && B.pos[lo] < pa - dist) lo++;
              for (y = lo; y < b1 && B.pos[y] <= pa + dist; y++) if (B.pos[y] !== pa) { hit.push(pa, B.pos[y]); }
            }
            if (hit.length) {
              hit.sort(function (p, q) { return p - q; });
              for (x = 0; x < hit.length; x++) if (x === 0 || hit[x] !== hit[x - 1]) pos[w++] = hit[x];
              docs[m] = da; var c = (w - w0) >> 1; tfs[m] = c < 1 ? 1 : c > 65535 ? 65535 : c; off[m] = w0; m++;
            }
            i++; j++;
          }
          off[m] = w;
          return { docs: docs.subarray(0, m), tfs: tfs.subarray(0, m), df: m, boost: 2, pl: { docs: docs.subarray(0, m), off: off.subarray(0, m + 1), pos: pos.subarray(0, w) } };
        });
      });
    }
    function leafHits(n, tbl, ctx) {
      if (n.op === 'term') return termPost(n.t).then(function (p) { return filterPost(p, tbl); });
      if (n.op === 'prefix') return prefixPost(n.t, ctx).then(function (p) { return filterPost(p, tbl); });
      if (n.op === 'phrase') return phraseMatch(n, tbl, null);
      return nearMatch(n, tbl, null, ctx);
    }
    function isLeaf(n) { return n.op === 'term' || n.op === 'prefix' || n.op === 'phrase' || n.op === 'near'; }

    // ---------------------------------------------------------------- metadata conditions -> patent bitmap
    function range(v) {
      var s = String(v).trim(), m;
      if ((m = /^(\d{4})$/.exec(s))) return [+m[1], +m[1]];
      if ((m = /^(\d{4})?\s*(?:-|\.\.|:)\s*(\d{4})?$/.exec(s))) return [m[1] ? +m[1] : 0, m[2] ? +m[2] : 9999];
      if ((m = /^>=?\s*(\d{4})$/.exec(s))) return [+m[1], 9999];
      if ((m = /^<=?\s*(\d{4})$/.exec(s))) return [0, +m[1]];
      return null;
    }
    function listOf(v) { return (Array.isArray(v) ? v : String(v).split(/[|,;]/)).map(function (x) { return String(x).trim(); }).filter(Boolean); }
    function loadCpc() {
      if (cpcIdx) return Promise.resolve(cpcIdx);
      return loader.get(M.cpc.file, { as: 'bin', cache: false }).then(function (buf) {
        var dv = new DataView(buf), jl = dv.getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
        var base = (4 + jl + 3) & ~3, off = new Uint32Array(buf.slice(base, base + 4 * (P + 1)));
        var A = h.width === 4 ? Uint32Array : Uint16Array, ent = new A(buf.slice(base + 4 * (P + 1), base + 4 * (P + 1) + h.n * h.width));
        cpcIdx = { codes: h.codes, off: off, ent: ent };
        return cpcIdx;
      });
    }
    function loadPn() {
      if (pnMap) return Promise.resolve(pnMap);
      return loader.get(M.pn.file, { as: 'text', cache: false }).then(function (t) {
        pnList = t.split('\n'); pnMap = new Map();
        for (var i = 0; i < pnList.length; i++) {
          pnMap.set(pnList[i], i);
          var b = '#' + TOK.pnBase(pnList[i]), a = pnMap.get(b); if (a) a.push(i); else pnMap.set(b, [i]);
        }
        return pnMap;
      });
    }
    function resolvePn(input) {          // -> patent indexes (all kinds of the number when no kind is given)
      var q = TOK.pn(input), out = [], i;
      if (!q) return out;
      for (i = 0; i < q.full.length; i++) { var p = pnMap.get(q.full[i]); if (p !== undefined) return [p]; }
      for (i = 0; i < q.bases.length; i++) { var l = pnMap.get('#' + q.bases[i]); if (l) return l.slice(); }
      return out;
    }
    function metaBitmap(k, v, ctx) {
      var bm = new Uint8Array(P), i, r, set;
      function byCol(col, names) {
        var want = new Uint8Array(256), any = false;
        listOf(v).forEach(function (x) { var u = x.toUpperCase(); names.forEach(function (nm, j) { if (nm && String(nm).toUpperCase().lastIndexOf(u, 0) === 0) { want[j] = 1; any = true; } }); });
        if (!any) ctx.warn('no_value', k + ':' + v + ' matches nothing');
        for (i = 0; i < P; i++) bm[i] = want[col[i]];
      }
      switch (k) {
        case 'auth': byCol(meta.auth, meta.h.auth); return Promise.resolve(bm);
        case 'kind': byCol(meta.kind, meta.h.kinds); return Promise.resolve(bm);
        case 'status': byCol(meta.st, meta.h.st); return Promise.resolve(bm);
        case 'year': case 'prio': case 'exp':
          r = range(v); if (!r) { ctx.warn('bad_value', k + ': expects a year or a range such as 2015-2022'); return Promise.resolve(bm); }
          var col = k === 'year' ? meta.year : k === 'prio' ? meta.prioYear : meta.expYear;
          for (i = 0; i < P; i++) { var y = col[i]; bm[i] = (y >= r[0] && y <= r[1] && y > 0) ? 1 : 0; }
          return Promise.resolve(bm);
        case 'tier': set = new Uint8Array(256); listOf(v).forEach(function (x) { set[+x & 255] = 1; }); for (i = 0; i < P; i++) bm[i] = set[meta.tier[i]]; return Promise.resolve(bm);
        case 'seedtier': set = new Uint8Array(256); listOf(v).forEach(function (x) { set[+x & 255] = 1; }); for (i = 0; i < P; i++) bm[i] = meta.seedTier[i] ? set[meta.seedTier[i]] : 0; return Promise.resolve(bm);
        case 'seed': var on = !/^(0|false|no)$/i.test(String(v)); for (i = 0; i < P; i++) bm[i] = ((meta.seedTier[i] > 0) === on) ? 1 : 0; return Promise.resolve(bm);
        case 'text': var on2 = !/^(0|false|no)$/i.test(String(v)); for (i = 0; i < P; i++) bm[i] = (((meta.flags[i] & 1) === 1) === on2) ? 1 : 0; return Promise.resolve(bm);
        case 'compounds': var on3 = !/^(0|false|no)$/i.test(String(v)); for (i = 0; i < P; i++) bm[i] = (((meta.flags[i] & 8) === 8) === on3) ? 1 : 0; return Promise.resolve(bm);
        case 'inforce': for (i = 0; i < P; i++) bm[i] = meta.deIn[i] === 1 ? 1 : 0; return Promise.resolve(bm);
        case 'fam': set = new Set(listOf(v).map(Number)); for (i = 0; i < P; i++) bm[i] = set.has(meta.fam[i]) ? 1 : 0; return Promise.resolve(bm);
        case 'player':
          var names = (M.players || []).map(function (x) { return TOK.fold(x); }), wantP = new Uint8Array(256), anyP = false;
          listOf(v).forEach(function (x) { var f = TOK.fold(x); names.forEach(function (nm, j) { if (nm.indexOf(f) >= 0) { wantP[j] = 1; anyP = true; } }); });
          if (!anyP) ctx.warn('no_value', 'player:' + v + ' matches no player name');
          for (i = 0; i < P; i++) bm[i] = meta.player[i] === 255 ? 0 : wantP[meta.player[i]];
          return Promise.resolve(bm);
        case 'cpc':
          return loadCpc().then(function (c) {
            var want = new Uint8Array(c.codes.length), anyC = false;
            listOf(v).forEach(function (x) {
              var pre = x.toUpperCase().replace(/\s+/g, '').replace(/\*$/, ''), lo = 0, hi = c.codes.length;
              while (lo < hi) { var mid = (lo + hi) >> 1; if (c.codes[mid] < pre) lo = mid + 1; else hi = mid; }
              for (; lo < c.codes.length && c.codes[lo].lastIndexOf(pre, 0) === 0; lo++) { want[lo] = 1; anyC = true; }
            });
            if (!anyC) { ctx.warn('no_value', 'cpc:' + v + ' matches no classification in the corpus'); return bm; }
            for (i = 0; i < P; i++) for (var e = c.off[i], e2 = c.off[i + 1]; e < e2; e++) if (want[c.ent[e]]) { bm[i] = 1; break; }
            return bm;
          });
        case 'pn':
          return loadPn().then(function () {
            listOf(v).forEach(function (x) { var ps = resolvePn(x); if (!ps.length) ctx.warn('no_value', 'pn:' + x + ' is not in the corpus'); ps.forEach(function (p) { bm[p] = 1; }); });
            return bm;
          });
      }
      ctx.warn('bad_field', 'unknown field ' + k);
      return Promise.resolve(bm);
    }

    // ---------------------------------------------------------------- boolean evaluation
    function tableFor(f, base, ctx) {
      var t = new Uint8Array(16);
      for (var fl = 0; fl < 16; fl++) {
        var ok = fieldPred(f, fl) && (base ? (f === 'all' ? base[fl] : true) : true), k = (fl >> 2) & 3;
        if (ok && k !== 3) {
          // "independent claims only": claims must be independent; bare terms then search claims only,
          // an explicit title:/abstract: field still works
          if (ctx.indepOnly && (k === 0 ? !(fl & 1) : f === 'all')) ok = false;
          if (ctx.lang === 'de' && !(fl & 2)) ok = false;
          if (ctx.lang === 'en' && (fl & 2)) ok = false;
        }
        t[fl] = ok ? 1 : 0;
      }
      return t;
    }
    // patent level: -> Uint8Array(P)
    function evalPat(n, tbl, ctx, neg) {
      var bm, i;
      if (isLeaf(n)) {
        return leafHits(n, tbl, ctx).then(function (h) {
          bm = new Uint8Array(P); for (i = 0; i < h.docs.length; i++) bm[uPat[h.docs[i]]] = 1;
          if (!neg && h.docs.length) ctx.scorers.push(h);
          return bm;
        });
      }
      if (n.op === 'meta') return metaBitmap(n.k, n.v, ctx);
      if (n.op === 'field') return evalPat(n.a, tableFor(n.f, tbl, ctx), ctx, neg);
      if (n.op === 'not') return evalPat(n.a, tbl, ctx, !neg).then(function (a) { bm = new Uint8Array(P); for (i = 0; i < P; i++) bm[i] = a[i] ^ 1; return bm; });
      if (n.op === 'same') {
        var sub = { scorers: [], warn: ctx.warn, indepOnly: ctx.indepOnly, lang: ctx.lang };
        return evalUnit(n.a, tbl, sub, neg).then(function (ub) {
          bm = new Uint8Array(P); for (i = 0; i < D; i++) if (ub[i]) bm[uPat[i]] = 1;
          sub.scorers.forEach(function (s) { s.ub = s.ub ? andBits(s.ub, ub) : ub; ctx.scorers.push(s); });
          return bm;
        });
      }
      return seq(n.xs, function (x) { return evalPat(x, tbl, ctx, neg); }).then(function (parts) {
        bm = parts[0];
        var k, b;
        if (n.op === 'and') for (k = 1; k < parts.length; k++) { b = parts[k]; for (i = 0; i < P; i++) bm[i] &= b[i]; }
        else for (k = 1; k < parts.length; k++) { b = parts[k]; for (i = 0; i < P; i++) bm[i] |= b[i]; }
        return bm;
      });
    }
    // unit level (inside same:( ) or with scope "claim"): -> Uint8Array(D)
    function evalUnit(n, tbl, ctx, neg) {
      var bm, i;
      if (isLeaf(n)) {
        return leafHits(n, tbl, ctx).then(function (h) {
          bm = markOf(h.docs);
          if (!neg && h.docs.length) ctx.scorers.push(h);
          return bm;
        });
      }
      if (n.op === 'meta') return metaBitmap(n.k, n.v, ctx).then(function (pb) { bm = new Uint8Array(D); for (i = 0; i < D; i++) bm[i] = pb[uPat[i]]; return bm; });
      if (n.op === 'field') return evalUnit(n.a, tableFor(n.f, tbl, ctx), ctx, neg);
      if (n.op === 'same') return evalUnit(n.a, tbl, ctx, neg);
      if (n.op === 'not') return evalUnit(n.a, tbl, ctx, !neg).then(function (a) { bm = new Uint8Array(D); for (i = 0; i < D; i++) bm[i] = (a[i] ^ 1) & tbl[uFlag[i]]; return bm; });
      return seq(n.xs, function (x) { return evalUnit(x, tbl, ctx, neg); }).then(function (parts) {
        bm = parts[0];
        var k, b;
        if (n.op === 'and') for (k = 1; k < parts.length; k++) { b = parts[k]; for (i = 0; i < D; i++) bm[i] &= b[i]; }
        else for (k = 1; k < parts.length; k++) { b = parts[k]; for (i = 0; i < D; i++) bm[i] |= b[i]; }
        return bm;
      });
    }
    function andBits(a, b) { var o = new Uint8Array(a.length); for (var i = 0; i < a.length; i++) o[i] = a[i] & b[i]; return o; }
    function seq(xs, fn) { var out = [], p = Promise.resolve(); xs.forEach(function (x) { p = p.then(function () { return fn(x); }).then(function (r) { out.push(r); }); }); return p.then(function () { return out; }); }

    // ---------------------------------------------------------------- filters object -> patent bitmap (or null)
    function applyFilters(f, ok, ctx) {
      var i, tasks = [];
      function and(bm) { for (var j = 0; j < P; j++) ok[j] &= bm[j]; }
      function viaMeta(k, v) { tasks.push(metaBitmap(k, v, ctx).then(and)); }
      if (!f) return Promise.resolve();
      if (f.auth && f.auth.length) viaMeta('auth', f.auth);
      if (f.kinds && f.kinds.length) viaMeta('kind', f.kinds);
      if (f.status && f.status.length) viaMeta('status', f.status);
      if (f.tiers && f.tiers.length) viaMeta('tier', f.tiers);
      if (f.seedTiers && f.seedTiers.length) viaMeta('seedtier', f.seedTiers);
      if (f.cpc && f.cpc.length) viaMeta('cpc', f.cpc);
      if (f.pn && f.pn.length) viaMeta('pn', f.pn);
      if (f.fam != null) viaMeta('fam', Array.isArray(f.fam) ? f.fam : [f.fam]);
      if (f.yearFrom || f.yearTo) viaMeta('year', (f.yearFrom || '') + '-' + (f.yearTo || ''));
      if (f.prioFrom || f.prioTo) viaMeta('prio', (f.prioFrom || '') + '-' + (f.prioTo || ''));
      if (f.players && f.players.length) {
        var want = new Uint8Array(256), names = M.players || [];
        f.players.forEach(function (x) { if (typeof x === 'number') want[x] = 1; else { var j = names.indexOf(x); if (j >= 0) want[j] = 1; else { var fx = TOK.fold(String(x)); names.forEach(function (nm, q) { if (TOK.fold(nm).indexOf(fx) >= 0) want[q] = 1; }); } } });
        for (i = 0; i < P; i++) if (meta.player[i] === 255 || !want[meta.player[i]]) ok[i] = 0;
      }
      if (f.textOnly) for (i = 0; i < P; i++) if (!(meta.flags[i] & 1)) ok[i] = 0;
      if (f.hasCompounds) for (i = 0; i < P; i++) if (!(meta.flags[i] & 8)) ok[i] = 0;
      if (f.hasImg) for (i = 0; i < P; i++) if (!(meta.flags[i] & 4)) ok[i] = 0;
      if (f.seedOnly) for (i = 0; i < P; i++) if (!meta.seedTier[i]) ok[i] = 0;
      if (f.deInForce) for (i = 0; i < P; i++) if (meta.deIn[i] !== 1) ok[i] = 0;
      if (f.expAfter) for (i = 0; i < P; i++) if (!(meta.exp[i] > f.expAfter)) ok[i] = 0;
      if (f.ps) { var m = new Uint8Array(P); for (i = 0; i < f.ps.length; i++) if (f.ps[i] >= 0 && f.ps[i] < P) m[f.ps[i]] = 1; and(m); }
      return Promise.all(tasks);
    }

    // ---------------------------------------------------------------- top-k without sorting everything
    function topK(ids, keyOf, need, cmp) {
      if (ids.length > 4000 && need < ids.length / 4) {
        var keys = new Float64Array(ids.length), i;
        for (i = 0; i < ids.length; i++) keys[i] = keyOf(ids[i]);
        var sorted = keys.slice().sort(), thr = sorted[sorted.length - need], out = [];
        for (i = 0; i < ids.length; i++) if (keys[i] >= thr) out.push(ids[i]);
        ids = out;
      }
      return Array.prototype.slice.call(ids).sort(cmp);
    }

    // ---------------------------------------------------------------- texts
    function shardIndex(start, p) { var lo = 0, hi = start.length - 1; if (hi < 0 || p < start[0]) return -1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (start[mid] <= p) lo = mid; else hi = mid - 1; } return lo; }
    // block container [u32 n][u32 p[n]][u32 off[n+1]][blocks]: the inflated bytes are kept, one block is parsed on demand
    function blockShard(lru, name, i, gzBytes) {
      var s = lru.get(i); if (s) return s;
      s = loader.get(name, { as: 'bin', cache: false }).then(function (buf) {
        var n = new DataView(buf).getUint32(0, true);
        var sh = { n: n, p: new Uint32Array(buf.slice(4, 4 + 4 * n)), off: new Uint32Array(buf.slice(4 + 4 * n, 8 + 8 * n)), data: new Uint8Array(buf, 8 + 8 * n) };
        lru.set(i, Promise.resolve(sh), buf.byteLength + 4096);
        return sh;
      });
      lru.set(i, s, gzBytes * 4.5 + 4096); s.catch(function () { lru.delete(i); });
      return s;
    }
    function blockOf(sh, p) {
      var lo = 0, hi = sh.n - 1;
      while (lo <= hi) { var mid = (lo + hi) >> 1, v = sh.p[mid]; if (v === p) return JSON.parse(utf8.decode(sh.data.subarray(sh.off[mid], sh.off[mid + 1]))); if (v < p) lo = mid + 1; else hi = mid - 1; }
      return null;
    }
    function textEntry(p) {              // -> {c: rows, a: abstract|0, td: German title|0} | null
      var c = entryCache.get(p); if (c !== undefined) return Promise.resolve(c);
      var i = shardIndex(IX.text.start, p); if (i < 0) return Promise.resolve(null);
      return blockShard(textShards, 'idx/' + IX.text.files[i][0], i, IX.text.files[i][1]).then(function (sh) {
        var e = blockOf(sh, p); if (e) entryCache.set(p, e, (sh.off[1] ? 2 : 1) * 20000);
        return e;
      });
    }
    function patChunk(p) {
      var size = M.pat.chunk, ci = (p / size) | 0;
      return loader.get(M.pat.files[ci], { as: 'json', size: 3e6 }).then(function (c) { return { c: c, i: p - ci * size }; });
    }
    function unitText(d) {               // text of one unit (claim, title, abstract, assignee)
      var p = uPat[d], fl = uFlag[d], k = (fl >> 2) & 3;
      if (k === 1 && !(fl & 2)) return patChunk(p).then(function (x) { return x.c.title[x.i] || ''; });
      if (k === 3) return patChunk(p).then(function (x) { return x.c.asgNames[x.c.asg[x.i]] || ''; });
      return textEntry(p).then(function (e) {
        if (!e) return patChunk(p).then(function (x) { return k === 1 ? (x.c.title[x.i] || '') : ''; });
        if (k === 1) return e.td || patChunk(p).then(function (x) { return x.c.title[x.i] || ''; });
        if (k === 2) return e.a || '';
        var no = uNo[d], want = fl & 3;
        for (var j = 0; j < e.c.length; j++) if (e.c[j][0] === no && (e.c[j][1] & 3) === want) return e.c[j][3];
        for (j = 0; j < e.c.length; j++) if (e.c[j][0] === no && (e.c[j][1] & 2) === (fl & 2)) return e.c[j][3];
        return '';
      });
    }
    var KIND = ['claim', 'title', 'abstract', 'assignee'];
    function unitInfo(d, score) { var fl = uFlag[d]; return { n: uNo[d], lang: fl & 2 ? 'de' : 'en', indep: (fl & 1) === 1, field: KIND[(fl >> 2) & 3], score: +score.toFixed(3) }; }

    // ---------------------------------------------------------------- search
    function search(query, opts) {
      return need().then(function () {
        opts = opts || {};
        var t0 = now(), f = opts.filters || {}, parsed = typeof query === 'object' && query && query.ast !== undefined ? query : parseQuery(query, TOK);
        var warnings = parsed.warnings.slice();
        var ctx = { scorers: [], warn: function (c, m) { if (!warnings.some(function (w) { return w.message === m; })) warnings.push({ code: c, message: m }); },
          indepOnly: !!(f.indepOnly || parsed.unit.indep), lang: f.lang || parsed.unit.lang || null };
        var scope = opts.scope || parsed.unit.scope || 'patent';
        var base = tableFor('all', null, ctx), ast = parsed.ast, ub = null;
        if (f.asg) { var an = parseQuery(String(f.asg), TOK).ast; if (an) ast = ast ? { op: 'and', xs: [ast, { op: 'field', f: 'asg', a: an }] } : { op: 'field', f: 'asg', a: an }; }
        var ev;
        if (!ast) ev = Promise.resolve(new Uint8Array(P).fill(1));
        else if (scope === 'claim') ev = evalUnit(ast, base, ctx, false).then(function (u) { ub = u; var bm = new Uint8Array(P); for (var i = 0; i < D; i++) if (u[i]) bm[uPat[i]] = 1; return bm; });
        else ev = evalPat(ast, base, ctx, false);
        return ev.then(function (ok) { return applyFilters(f, ok, ctx).then(function () { return ok; }); }).then(function (ok) {
          var tEval = now(), i, d, p, sc = ctx.scorers, hasScore = sc.length > 0;
          var acc = hasScore ? new Float32Array(D) : null, k1p = IX.k1 + 1;
          for (var s = 0; s < sc.length; s++) {
            var h = sc[s], idf = Math.log(1 + (D - h.df + 0.5) / (h.df + 0.5)) * (h.boost || 1), docs = h.docs, tfs = h.tfs, hub = h.ub || null;
            for (i = 0; i < docs.length; i++) {
              d = docs[i]; if (!ok[uPat[d]]) continue; if (hub && !hub[d]) continue; if (ub && !ub[d]) continue;
              var tf = tfs[i]; acc[d] += W[uFlag[d]] * idf * tf * k1p / (tf + uNorm[d]);
            }
          }
          // per patent: best unit, number of matching claims, score
          var res = [], score = new Float32Array(P), nMatch = new Uint16Array(P), bestD = new Int32Array(P);
          for (p = 0; p < P; p++) {
            if (!ok[p]) continue;
            res.push(p);
            if (!hasScore) { bestD[p] = -1; continue; }
            var best = 0, bd = -1, sum = 0, nm = 0;
            for (d = uFirst[p]; d < uFirst[p + 1]; d++) { var a = acc[d]; if (a > 0) { sum += a; if (((uFlag[d] >> 2) & 3) === 0) nm++; if (a > best) { best = a; bd = d; } } }
            var rest = sum - best; score[p] = best + 0.1 * (rest > 2 * best ? 2 * best : rest); nMatch[p] = nm > 65535 ? 65535 : nm; bestD[p] = bd;
          }
          var total = res.length, sort = opts.sort || (hasScore ? 'score' : 'date');
          var limit = opts.limit == null ? 25 : opts.limit, offset = opts.offset || 0, need2 = offset + limit;
          var keyOf = sort === 'date' ? function (q) { return meta.pub[q]; } : sort === 'expiry' ? function (q) { return meta.exp[q] ? -meta.exp[q] : -99999999; } : function (q) { return score[q]; };
          var cmp = function (x, y) { return keyOf(y) - keyOf(x) || score[y] - score[x] || x - y; };
          var out = { total: total, hits: [], facets: null, parsed: { query: parsed.query, ast: parsed.ast, unit: parsed.unit, warnings: warnings }, ms: 0 };
          var pageP, groups = null;
          if (opts.group === 'family') {
            var byFam = new Map(), list = [];
            for (i = 0; i < res.length; i++) {
              p = res[i]; var fam = meta.fam[p], gq = byFam.get(fam);
              if (!gq) { gq = { rep: p, members: [p] }; byFam.set(fam, gq); list.push(gq); }
              else { gq.members.push(p); if (cmp(p, gq.rep) < 0) gq.rep = p; }
            }
            out.totalFamilies = list.length;
            var reps = list.map(function (x) { return x.rep; }), top = topK(reps, keyOf, need2, cmp).slice(offset, offset + limit);
            pageP = top; groups = new Map(); list.forEach(function (x) { groups.set(x.rep, x.members); });
          } else pageP = topK(res, keyOf, need2, cmp).slice(offset, offset + limit);
          if (opts.facets !== false) out.facets = facetsOf(res);
          if (opts.all) out.all = Uint32Array.from(res);
          var perHit = opts.perHit == null ? 3 : opts.perHit, wantSnip = opts.snippets !== false;
          var tRank = now();
          return Promise.all(pageP.map(function (q) {
            var hit = { p: q, score: +score[q].toFixed(3), n: nMatch[q], fam: meta.fam[q], best: null, top: [] };
            if (groups) { var mem = groups.get(q).slice().sort(cmp); hit.members = mem; hit.nMembers = mem.length; }
            if (!hasScore || bestD[q] < 0) return hit;
            var us = [];
            for (var dd = uFirst[q]; dd < uFirst[q + 1]; dd++) if (acc[dd] > 0) us.push(dd);
            us.sort(function (x, y) { return acc[y] - acc[x] || x - y; });
            us = us.slice(0, Math.max(1, perHit));
            return Promise.all(us.map(function (dd) {
              var info = unitInfo(dd, acc[dd]);
              if (!wantSnip) return info;
              return unitText(dd).then(function (t) { info.snippet = snippetOf(t, parsed.ast, TOK, opts.snippetLength); return info; }, function (e) { info.snippet = []; info.error = e; return info; });
            })).then(function (infos) { hit.best = infos[0]; hit.top = infos; return hit; });
          })).then(function (hits) {
            out.hits = hits; out.ms = +(now() - t0).toFixed(1);
            out.timing = { eval: +(tEval - t0).toFixed(1), rank: +(tRank - tEval).toFixed(1), snippets: +(now() - tRank).toFixed(1) };
            return out;
          });
        });
      });
    }
    function facetsOf(res) {
      var h = meta.h, auth = new Uint32Array(8), year = new Uint32Array(300), player = new Uint32Array(256), st = new Uint32Array(256), tier = new Uint32Array(16), seed = new Uint32Array(8), kind = new Uint32Array(256);
      var c4 = new Uint32Array(h.c4.length), text = 0, de = 0, i, e;
      for (i = 0; i < res.length; i++) {
        var p = res[i], y = meta.year[p];
        auth[meta.auth[p]]++; if (y >= 1800 && y < 2100) year[y - 1800]++; player[meta.player[p]]++; st[meta.st[p]]++; tier[meta.tier[p] & 15]++; seed[meta.seedTier[p] & 7]++; kind[meta.kind[p]]++;
        if (meta.flags[p] & 1) text++; if (meta.deIn[p] === 1) de++;
        for (e = meta.c4off[p]; e < meta.c4off[p + 1]; e++) c4[meta.c4[e]]++;
      }
      function named(arr, names) { var o = {}; for (var j = 0; j < arr.length; j++) if (arr[j] && names[j] != null && names[j] !== '') o[names[j]] = arr[j]; return o; }
      var yo = {}; for (i = 0; i < 300; i++) if (year[i]) yo[i + 1800] = year[i];
      var to = {}; for (i = 0; i < 16; i++) if (tier[i]) to[i] = tier[i];
      var so = {}; for (i = 1; i < 8; i++) if (seed[i]) so[i] = seed[i];
      return { auth: named(auth, h.auth), year: yo, player: named(player, M.players || []), status: named(st, h.st), tier: to, seedTier: so, kind: named(kind, h.kinds), cpc4: named(c4, h.c4), text: text, deInForce: de };
    }

    // ---------------------------------------------------------------- other calls
    function claims(p, lang) {
      return need().then(function () { return textEntry(p); }).then(function (e) {
        if (!e) return [];
        var out = [], byKey = new Map();
        e.c.forEach(function (r) {
          var l = r[1] & 2 ? 'de' : 'en'; if (lang && lang !== l) return;
          var c = { n: r[0], lang: l, indep: (r[1] & 1) === 1, dep: r[2] || [], text: r[3], children: [], roots: [] };
          if (r[4]) c.img = r[4];
          out.push(c); byKey.set(l + r[0], c);
        });
        out.forEach(function (c) { c.dep.forEach(function (x) { var par = byKey.get(c.lang + x); if (par && par.children.indexOf(c.n) < 0) par.children.push(c.n); }); });
        function roots(c, seen) {
          if (!c.dep.length) return [c.n];
          var r = [];
          c.dep.forEach(function (x) { var par = byKey.get(c.lang + x); if (!par || seen[x]) return; seen[x] = 1; roots(par, seen).forEach(function (y) { if (r.indexOf(y) < 0) r.push(y); }); });
          return r;
        }
        out.forEach(function (c) { c.roots = roots(c, {}).sort(function (a, b) { return a - b; }); });
        return out;
      });
    }
    function abstractOf(p) { return need().then(function () { return textEntry(p); }).then(function (e) { return e && e.a ? e.a : null; }); }
    function defs(p) {
      return need().then(function () {
        var df = M.df, i = df && df.files.length ? shardIndex(df.start, p) : -1;
        if (i < 0 || !df.files[i]) return [];
        return blockShard(defShards, df.files[i][0], i, df.files[i][1]).then(function (sh) { return blockOf(sh, p) || []; });
      });
    }
    function claimImages(p) {
      return need().then(function () {
        if (!M.img || !M.img.index) return [];
        if (!imgIndex) imgIndex = loader.get(M.img.index, { as: 'json', cache: false }).then(function (j) { var m = new Map(); for (var k = 0; k < j.p.length; k++) m.set(j.p[k], j.e[k]); return m; });
        return imgIndex.then(function (m) {
          var es = m.get(p) || [];
          return Promise.all(es.map(function (e) {
            return loader.get(M.img.packs[e[4]], { as: 'bin', size: 4e6 }).then(function (buf) {
              var bytes = new Uint8Array(buf, e[5], e[6]);
              return { claim: e[0], id: e[1], w: e[2], h: e[3], blob: new Blob([bytes], { type: 'image/png' }) };
            });
          }));
        });
      });
    }
    function suggest(prefix, k) {
      return need().then(function () {
        if (!lexicon) lexicon = loader.get('idx/' + IX.lex, { as: 'json', cache: false });
        return lexicon;
      }).then(function (lx) {
        var t = TOK.tokenize(String(prefix || ''), true), pre = t.length ? t[t.length - 2] : '';
        if (!pre) return [];
        var lo = 0, hi = lx.t.length, out = [];
        while (lo < hi) { var mid = (lo + hi) >> 1; if (lx.t[mid] < pre) lo = mid + 1; else hi = mid; }
        for (; lo < lx.t.length && lx.t[lo].lastIndexOf(pre, 0) === 0; lo++) out.push({ term: lx.t[lo], df: lx.d[lo] });
        out.sort(function (a, b) { return b.df - a.df || (a.term < b.term ? -1 : 1); });
        return out.slice(0, k || 10);
      });
    }
    function highlight(text, parsed) {
      var ast = parsed && parsed.ast !== undefined ? parsed.ast : parseQuery(String(parsed || ''), TOK).ast;
      return Promise.resolve(highlightText(text, ast, TOK));
    }
    function snippets(ps, parsed, o) {    // best matching claim texts for patents outside the current page
      return search(parsed, { filters: { ps: ps }, limit: ps.length, facets: false, perHit: (o && o.perHit) || 3 }).then(function (r) { return r.hits; });
    }
    function diag() {
      return Promise.resolve({ ready: !!M, D: D, P: P, loader: loader ? loader.diag() : null, cache: M ? { postShards: postShards.m.size, posShards: posShards.m.size, textShards: textShards.m.size, postings: postCache.m.size, bytes: postShards.bytes + posShards.bytes + textShards.bytes + postCache.bytes } : null });
    }
    return {
      init: init, search: search, claims: claims, abstract: abstractOf, defs: defs, claimImages: claimImages, suggest: suggest,
      highlight: highlight, snippets: snippets, diag: diag,
      parse: function (q) { return Promise.resolve(parseQuery(q, TOK)); }
    };
  }

  var api = { create: create, parse: parseQuery, highlightText: highlightText, snippetOf: snippetOf, VERSION: 1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpSearchCore = api;

  // ------------------------------------------------------------------------------------------------ worker service
  if (isWorker && self.name === 'lnp-search') {
    var core = create({ onProgress: function (e) { var c = { ev: 'progress', type: e.type, name: e.name, loaded: e.loaded, total: e.total, active: e.active }; if (e.error) c.error = e.error; self.postMessage(c); } });
    self.onmessage = function (ev) {
      var m = ev.data || {}, id = m.id;
      function fail(e) { self.postMessage({ id: id, ok: false, error: (e && e.code) ? { code: e.code, message: e.message, name: e.name, url: e.url, status: e.status } : { code: 'error', message: String(e && e.stack || e) } }); }
      try {
        if (m.op === 'ping') { self.postMessage({ id: id, ok: true, r: 'pong' }); return; }
        var fn = core[m.op];
        if (!fn) return fail(mkErr('bad_op', 'unknown op ' + m.op));
        Promise.resolve(fn.apply(core, m.a || [])).then(function (r) {
          var tr = []; if (r && r.all && r.all.buffer) tr.push(r.all.buffer);
          self.postMessage({ id: id, ok: true, r: r }, tr);
        }, fail);
      } catch (e) { fail(e); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
