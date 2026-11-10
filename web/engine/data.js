/* LNP-FTO patent table (global LnpData). Plain script, ASCII only. Needs loader.js and tok.js next to it
   (both are loaded on demand). File formats: pipeline/build_dist.py, API: docs/ARCHITECTURE.md.
   Files are fetched and inflated in the first mode that works: "worker" (engine/loader.js as a dedicated Worker),
   "blob" (the same source from a blob: URL) or "main" (on the main thread). Parsed chunks are cached (LRU). */
(function (g) {
  'use strict';
  var here = '';
  try { if (document.currentScript && document.currentScript.src) here = document.currentScript.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); } catch (e) { /* ignore */ }
  function mkErr(code, message) { return { code: code, message: message }; }
  function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
  var S = { ready: null, mode: null, tried: [], get: null, gzip: null, enc: null, meta: null, metaP: null, pn: null, pnP: null, allP: null, chunks: null, st: null, famMap: null, listeners: [] };
  var D = { manifest: null, seed: null };
  function emit(ev) { for (var i = 0; i < S.listeners.length; i++) { try { S.listeners[i](ev); } catch (e) { /* ignore */ } } }
  function loadScript(url) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = url; s.onload = function () { res(); }; s.onerror = function () { rej(mkErr('script', 'could not load ' + url)); }; document.head.appendChild(s); }); }
  function need(name, url) { return g[name] ? Promise.resolve() : loadScript(url); }

  function init(o) {
    if (S.ready) return S.ready;
    if (typeof o === 'string') o = { base: o };
    o = o || {};
    var eb = abs(o.engineBase || here || 'engine/'), base = abs(o.base || 'data/'), vendorUrl = abs(o.vendorUrl || eb + '../vendor/fflate.js');
    var want = o.mode && o.mode !== 'auto' ? [o.mode] : ['worker', 'blob', 'main'];
    var lopts = { base: base, enc: o.enc || 'auto', vendorUrl: vendorUrl, gzip: o.gzip };
    S.base = base;
    S.tried = [];
    S.ready = need('LnpLoader', eb + 'loader.js').then(function () { return need('LnpTok', eb + 'tok.js'); }).then(function () {
      var L = g.LnpLoader;
      S.chunks = new L.LRU(o.cacheBytes || 60e6); S.st = new L.LRU(12e6);
      function viaWorker(mode) {
        var srcs = [eb + 'loader.js'];
        if (typeof DecompressionStream === 'undefined' || o.gzip === 'fflate') srcs.unshift(vendorUrl);
        return L.spawn({ name: 'lnp-loader', file: eb + 'loader.js', sources: srcs, timeoutMs: o.timeoutMs || 6000, modes: [mode] }).then(function (h) {
          h.onEvent = function (m) { if (m.ev === 'progress') emit(m); };
          return h.call('init', [lopts]).then(function (info) {
            var dec = new TextDecoder('utf-8');
            var get = function (name, as) {
              return h.call('get', [name, 'bin']).then(function (buf) {
                if (as === 'bin') return buf;
                var t = dec.decode(new Uint8Array(buf));
                if (as === 'text') return t;
                try { return JSON.parse(t); } catch (e) { throw mkErr('parse', name + ': invalid JSON'); }
              });
            };
            // the first real request decides whether this mode works (a worker may be unable to fetch)
            return get('manifest.json', 'json').then(function (man) {
              var t = { get: get, man: man, gzip: info.gzip, h: h, diag: function () { return h.call('diag'); } };
              // the manifest says how binaries are encoded: no probing of x.bin before x.b64.txt
              return (man.enc && !o.enc) ? h.call('enc', [man.enc]).then(function () { return t; }) : t;
            }, function (e) { h.terminate(); throw e; });
          }, function (e) { h.terminate(); throw e; });
        }, function (e) { throw (e && e.tried && e.tried[0]) ? mkErr('no_worker', e.tried[0].error) : e; });
      }
      function viaMain() {
        lopts.onProgress = emit;
        var ld = L.create(lopts);
        var get = function (name, as) { return ld.get(name, { as: as, cache: false }); };
        return get('manifest.json', 'json').then(function (man) { if (man.enc && !o.enc) ld.setEnc(man.enc); return { get: get, man: man, gzip: ld.diag().gzip, diag: function () { return Promise.resolve(ld.diag()); } }; });
      }
      var chain = Promise.reject(mkErr('no_mode', 'no mode'));
      want.forEach(function (mode) {
        chain = chain.catch(function () {
          return (mode === 'main' ? viaMain() : viaWorker(mode)).then(function (t) { S.tried.push({ mode: mode, ok: true }); S.mode = mode; return t; },
            function (e) { S.tried.push({ mode: mode, ok: false, error: (e && e.message) || String(e), code: e && e.code }); throw e; });
        });
      });
      return chain;
    }).then(function (t) {
      S.get = t.get; S.gzip = t.gzip; S.ldiag = t.diag; S.h = t.h || null; D.manifest = t.man; S.enc = t.man.enc || 'bin';
      // every chunk of the table fits the cache (all() and the FTO candidate search touch all of them): no reloads
      if (!o.cacheBytes && t.man.pat && t.man.pat.files) S.chunks.max = Math.max(S.chunks.max, (t.man.pat.files.length + 2) * 3e6);
      return S.get(t.man.seed || 'seed.json', 'json').then(function (seed) { D.seed = seed; return t.man; }, function () { D.seed = null; return t.man; });
    });
    S.ready.catch(function () { S.ready = null; });
    return S.ready;
  }
  function ready() { return S.ready || init(); }

  // ---------------------------------------------------------------- chunks
  function chunk(ci) {
    var c = S.chunks.get(ci); if (c) return c;
    var M = D.manifest;
    if (ci < 0 || ci >= M.pat.files.length) return Promise.reject(mkErr('range', 'patent index out of range'));
    c = S.get(M.pat.files[ci], 'json');
    S.chunks.set(ci, c, 3e6); c.catch(function () { S.chunks.delete(ci); });
    return c;
  }
  function row(c, i, p) {
    var M = D.manifest, fl = c.flags[i], pl = c.player[i];
    return {
      p: p, pn: c.pn[i], auth: c.auth[i], kind: c.kind[i], pub: c.pub[i], app: c.app[i], prio: c.prio[i], grant: c.grant ? c.grant[i] : 0, appNo: c.appNo ? c.appNo[i] : '',
      fam: c.fam[i], title: c.title[i], assignee: c.asgNames[c.asg[i]] || '', player: pl >= 0 ? (M.players[pl] || null) : null, playerIdx: pl,
      cpc: c.cpc[i] ? c.cpc[i].split('|') : [], tier: c.tier[i], seedTier: c.seedTier[i], seedFam: c.seedFam ? c.seedFam[i] : '',
      text: (fl & 1) === 1, hasDefs: (fl & 2) === 2, hasImg: (fl & 4) === 4, hasCompounds: (fl & 8) === 8, hasStatus: (fl & 16) === 16,
      textCut: (fl & 32) === 32, defsCut: (fl & 64) === 64,
      status: M.statusCodes[c.st[i]] || '', exp: c.exp[i], deIn: c.deIn[i], wo: c.wo[i] || null
    };
  }
  function patent(p) {
    return ready().then(function (M) {
      if (!(p >= 0 && p < M.counts.patents)) throw mkErr('range', 'patent index out of range: ' + p);
      var ci = (p / M.pat.chunk) | 0;
      return chunk(ci).then(function (c) { return row(c, p - ci * M.pat.chunk, p); });
    });
  }
  function patents(ps) { return Promise.all(Array.prototype.map.call(ps || [], patent)); }
  function status(p) {
    return ready().then(function (M) {
      var ci = (p / M.st.chunk) | 0;
      if (ci < 0 || ci >= M.st.files.length) return null;
      var c = S.st.get(ci);
      if (!c) { c = S.get(M.st.files[ci], 'json'); S.st.set(ci, c, 2e6); c.catch(function () { S.st.delete(ci); }); }
      return c.then(function (a) { return a[p - ci * M.st.chunk] || null; });
    });
  }

  // ---------------------------------------------------------------- meta (binary columns) and numbers
  // the inflated meta file itself (kept: LnpSearch takes it from here instead of downloading it again)
  function metaBuffer() {
    if (S.metaBufP) return S.metaBufP;
    S.metaBufP = ready().then(function (M) { return S.get(M.meta.file, 'bin'); });
    S.metaBufP.catch(function () { S.metaBufP = null; });
    return S.metaBufP;
  }
  function meta() {
    if (S.metaP) return S.metaP;
    S.metaP = metaBuffer().then(function (buf) {
      var dv = new DataView(buf), jl = dv.getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
      var base = (4 + jl + 3) & ~3, m = { P: h.P, h: h }, T = { i32: Int32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };
      h.cols.forEach(function (c) { var A = T[c.type]; m[c.name] = new A(buf.slice(base + c.off, base + c.off + c.n * A.BYTES_PER_ELEMENT)); });
      S.meta = m; return m;
    });
    S.metaP.catch(function () { S.metaP = null; });
    return S.metaP;
  }
  function pnIndex() {
    if (S.pnP) return S.pnP;
    S.pnP = ready().then(function (M) { return S.get(M.pn.file, 'text'); }).then(function (t) {
      var list = t.split('\n'), map = new Map(), T = g.LnpTok;
      for (var i = 0; i < list.length; i++) { map.set(list[i], i); var b = '#' + T.pnBase(list[i]), a = map.get(b); if (a) a.push(i); else map.set(b, [i]); }
      S.pn = { list: list, map: map }; return S.pn;
    });
    S.pnP.catch(function () { S.pnP = null; });
    return S.pnP;
  }
  // "EP3532103B1" | "EP 3 532 103" | "US8,058,069" | "WO2017/075531" -> p | -1.
  // Without a kind code (or with one that is not in the table) the best publication of that number is returned:
  // one with full text first, then granted (B, later kinds first), then the newest.
  // A granted publication without claim text whose corrected / amended version (B9, B2, B3 of the same number) carries
  // the text: -> p of that version, else -1. The fetch takes the latest B publication of an application, so the claims
  // of EP2350043B1 sit on EP2350043B9.
  function textTwin(ix, m, p) {
    if (m.flags[p] & 1) return -1;
    var kinds = m.h.kinds, k = kinds[m.kind[p]] || '';
    if (k.charAt(0) !== 'B' && k.charAt(0) !== 'C' && k.charAt(0) !== 'E') return -1;
    var l = ix.map.get('#' + g.LnpTok.pnBase(ix.list[p])), best = -1;
    for (var j = 0; l && j < l.length; j++) {
      var x = l[j], kx = kinds[m.kind[x]] || '';
      if (x !== p && (m.flags[x] & 1) && kx.charAt(0) !== 'A' && (best < 0 || m.pub[x] > m.pub[best])) best = x;
    }
    return best;
  }
  function textSibling(p) { return Promise.all([pnIndex(), meta()]).then(function (r) { return (p >= 0 && p < r[1].P) ? textTwin(r[0], r[1], p) : -1; }); }
  function byPn(input, opt) {
    return Promise.all([pnIndex(), meta()]).then(function (r) {
      var ix = r[0], m = r[1], q = g.LnpTok.pn(input), i;
      if (!q) return -1;
      for (i = 0; i < q.full.length; i++) {
        var p = ix.map.get(q.full[i]);
        if (p === undefined) continue;
        if (opt && opt.exact) return p;
        var t = textTwin(ix, m, p);
        return t >= 0 ? t : p;
      }
      for (i = 0; i < q.bases.length; i++) {
        var l = ix.map.get('#' + q.bases[i]);
        if (l && l.length) {
          var best = l[0], key = function (x) { var k = m.h.kinds[m.kind[x]] || ''; return ((m.flags[x] & 1) ? 4e9 : 0) + (k.charAt(0) === 'B' ? 2e9 : 0) + m.pub[x]; };
          for (var j = 1; j < l.length; j++) if (key(l[j]) > key(best)) best = l[j];
          return best;
        }
      }
      return -1;
    });
  }
  function allPn(input) {               // every publication of a number: -> p[]
    return pnIndex().then(function (ix) {
      var q = g.LnpTok.pn(input), i; if (!q) return [];
      for (i = 0; i < q.bases.length; i++) { var l = ix.map.get('#' + q.bases[i]); if (l) return l.slice(); }
      return [];
    });
  }
  function family(p) {
    return meta().then(function (m) {
      if (!S.famMap) { S.famMap = new Map(); for (var i = 0; i < m.P; i++) { var a = S.famMap.get(m.fam[i]); if (a) a.push(i); else S.famMap.set(m.fam[i], [i]); } }
      return (S.famMap.get(m.fam[p]) || [p]).slice();
    });
  }
  // columnar view of the whole table (loads every chunk once; about 10 MB of files for 125,000 publications)
  function all() {
    if (S.allP) return S.allP;
    S.allP = ready().then(function (M) {
      var n = M.pat.files.length, parts = new Array(n), next = 0;
      function worker() { if (next >= n) return Promise.resolve(); var i = next++; return chunk(i).then(function (c) { parts[i] = c; return worker(); }); }
      return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
        var P = M.counts.patents, o = { n: P, pn: new Array(P), auth: new Array(P), kind: new Array(P), title: new Array(P), assignee: new Array(P), cpc: new Array(P), wo: new Array(P), appNo: new Array(P), seedFam: new Array(P),
          pub: new Int32Array(P), app: new Int32Array(P), prio: new Int32Array(P), grant: new Int32Array(P), exp: new Int32Array(P), fam: new Int32Array(P), player: new Int16Array(P), tier: new Uint8Array(P), seedTier: new Uint8Array(P), flags: new Uint8Array(P), st: new Uint8Array(P), deIn: new Uint8Array(P) };
        var off = 0;
        parts.forEach(function (c) {
          for (var i = 0; i < c.pn.length; i++) {
            var p = off + i;
            o.pn[p] = c.pn[i]; o.auth[p] = c.auth[i]; o.kind[p] = c.kind[i]; o.title[p] = c.title[i]; o.assignee[p] = c.asgNames[c.asg[i]] || ''; o.cpc[p] = c.cpc[i]; o.wo[p] = c.wo[i] || ''; o.appNo[p] = c.appNo ? c.appNo[i] : ''; o.seedFam[p] = c.seedFam ? c.seedFam[i] : '';
            o.pub[p] = c.pub[i]; o.app[p] = c.app[i]; o.prio[p] = c.prio[i]; o.grant[p] = c.grant ? c.grant[i] : 0; o.exp[p] = c.exp[i]; o.fam[p] = c.fam[i]; o.player[p] = c.player[i]; o.tier[p] = c.tier[i]; o.seedTier[p] = c.seedTier[i]; o.flags[p] = c.flags[i]; o.st[p] = c.st[i]; o.deIn[p] = c.deIn[i];
          }
          off += c.pn.length;
        });
        o.players = M.players; o.statusCodes = M.statusCodes;
        return o;
      });
    });
    S.allP.catch(function () { S.allP = null; });
    return S.allP;
  }
  // links to the public registers; works on a patent object or on p
  function linksOf(x) {
    var pn = x.pn, m = /^([A-Z]{2})((?:RE|PP|D|H|T)?\d+)([A-Z]\d?)?$/.exec(pn) || [null, x.auth, pn, ''], num = m[2], out = {
      espacenet: 'https://worldwide.espacenet.com/patent/search?q=' + encodeURIComponent('pn=' + pn),
      google: 'https://patents.google.com/patent/' + encodeURIComponent(pn) + '/en', register: null, uspto: null };
    if (x.auth === 'EP') out.register = x.appNo ? 'https://register.epo.org/application?number=EP' + encodeURIComponent(x.appNo) + '&lng=en' : 'https://register.epo.org/smartSearch?searchMode=smart&query=' + encodeURIComponent('EP' + num);
    if (x.auth === 'US') out.uspto = 'https://ppubs.uspto.gov/pubwebapp/external.html?q=' + encodeURIComponent('"' + num + '".pn.');
    return out;
  }
  function links(p) { return (typeof p === 'object' && p) ? Promise.resolve(linksOf(p)) : patent(p).then(linksOf); }
  function diag() {
    return ready().then(function () { return S.ldiag(); }).then(function (ld) {
      return { mode: S.mode, gzip: S.gzip, enc: (ld && ld.enc) || S.enc, tried: S.tried, patents: D.manifest.counts.patents, fetches: ld && ld.fetches, bytes: ld && ld.bytes, chunksCached: S.chunks.m.size };
    });
  }
  D.init = init; D.patent = patent; D.patents = patents; D.byPn = byPn; D.allPn = allPn; D.family = family; D.status = status; D.all = all;
  D.textSibling = textSibling; D.metaBuffer = metaBuffer; D.base = function () { return S.base; }; D.links = links; D.linksOf = linksOf; D.diag = diag; D.meta = meta;
  D.onProgress = function (fn) { S.listeners.push(fn); return function () { var i = S.listeners.indexOf(fn); if (i >= 0) S.listeners.splice(i, 1); }; };
  D.reset = function () { if (S.h) { S.h.terminate(); S.h = null; } if (S.chunks) S.chunks.clear(); if (S.st) S.st.clear(); S.pn = null; S.meta = null; D.manifest = null; D.seed = null; S.ready = null; S.metaP = null; S.metaBufP = null; S.pnP = null; S.allP = null; S.famMap = null; S.mode = null; };
  g.LnpData = D;
})(typeof self !== 'undefined' ? self : this);
