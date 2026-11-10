/* LNP-FTO text search, page side (global LnpSearch). Plain script, ASCII only.
   Starts the search core (search-worker.js) in the first mode that works:
     "worker" = dedicated Worker from engine/search-worker.js,
     "blob"   = Worker from a blob: URL built from tok.js + loader.js + search-worker.js,
     "main"   = on the main thread.
   All functions return promises; errors are plain objects {code, message}. API: docs/ARCHITECTURE.md. */
(function (g) {
  'use strict';
  var here = '';
  try { if (document.currentScript && document.currentScript.src) here = document.currentScript.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); } catch (e) { /* ignore */ }
  var S = { mode: null, h: null, core: null, ready: null, tried: [], info: null, listeners: [], opts: null };
  function mkErr(code, message) { return { code: code, message: message }; }
  function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
  function emit(ev) { for (var i = 0; i < S.listeners.length; i++) { try { S.listeners[i](ev); } catch (e) { /* ignore */ } } }
  function need(name, url) { return g[name] ? Promise.resolve() : g.LnpLoader && g.LnpLoader.loadScript ? g.LnpLoader.loadScript(url) : new Promise(function (res, rej) { var s = document.createElement('script'); s.src = url; s.onload = function () { res(); }; s.onerror = function () { rej(mkErr('script', 'could not load ' + url)); }; document.head.appendChild(s); }); }

  function lowMemory() {
    try { var n = g.navigator || {}; return (n.deviceMemory > 0 && n.deviceMemory <= 4) || /Mobi|Android|iPhone|iPad/.test(n.userAgent || ''); } catch (e) { return false; }
  }
  function init(o) {
    if (S.ready) return S.ready;
    o = o || {};
    var eb = abs(o.engineBase || here || 'engine/'), base = abs(o.base || 'data/');
    var vendorUrl = abs(o.vendorUrl || eb + '../vendor/fflate.js');
    var want = o.mode && o.mode !== 'auto' ? [o.mode] : ['worker', 'blob', 'main'];
    var coreOpts = { base: base, enc: o.enc || (g.LnpData && g.LnpData.manifest && g.LnpData.manifest.enc) || undefined, vendorUrl: vendorUrl, gzip: o.gzip };
    // Small devices (navigator.deviceMemory <= 4 GB, phones): the caches of the search core are halved, so the worker
    // stays near 150 MB instead of 300 MB after many different queries. Results are identical, repeats a little slower.
    var low = o.lowMemory != null ? !!o.lowMemory : lowMemory();
    if (low) { coreOpts.postCacheBytes = 20e6; coreOpts.posCacheBytes = 16e6; coreOpts.textCacheBytes = 40e6; coreOpts.postingsCacheBytes = 16e6; }
    S.low = low;
    S.opts = o; S.tried = [];
    // The manifest and the meta columns are taken from LnpData when it is already initialised, so the search core does
    // not download them a second time (meta is 1.5 MB as base64). Any failure there falls back to the core's own fetch.
    var LD0 = g.LnpData, shared = Promise.resolve();
    if (o.share !== false && LD0 && LD0.manifest && LD0.metaBuffer && abs((LD0.base && LD0.base()) || 'data/') === base) {
      coreOpts.manifest = LD0.manifest;
      shared = LD0.metaBuffer().then(function (buf) { coreOpts.meta = buf; }, function () { });
    }
    function startWorker(mode) {
      var srcs = [eb + 'tok.js', eb + 'loader.js', eb + 'search-worker.js'];
      if (typeof DecompressionStream === 'undefined' || o.gzip === 'fflate') srcs.splice(0, 0, vendorUrl);
      return g.LnpLoader.spawn({ name: 'lnp-search', file: eb + 'search-worker.js', sources: srcs, timeoutMs: o.timeoutMs || 6000, modes: [mode] }).then(function (h) {
        h.onEvent = function (m) { if (m.ev === 'progress') emit(m); };
        return h.call('init', [coreOpts]).then(function (info) { S.h = h; S.mode = mode; return info; }, function (e) { h.terminate(); throw e; });
      }, function (e) { throw (e && e.tried && e.tried[0]) ? mkErr('no_worker', e.tried[0].error) : e; });
    }
    function startMain() {
      return need('LnpTok', eb + 'tok.js').then(function () { return need('LnpLoader', eb + 'loader.js'); }).then(function () { return need('LnpSearchCore', eb + 'search-worker.js'); }).then(function () {
        var core = g.LnpSearchCore.create({ onProgress: emit });
        return core.init(coreOpts).then(function (info) { S.core = core; S.mode = 'main'; return info; });
      });
    }
    var chain = shared.then(function () { throw mkErr('no_mode', 'no engine mode'); });
    want.forEach(function (mode) {
      chain = chain.catch(function () {
        var p = mode === 'main' ? startMain() : need('LnpLoader', eb + 'loader.js').then(function () { return startWorker(mode); });
        return p.then(function (info) { S.tried.push({ mode: mode, ok: true }); return info; }, function (e) { S.tried.push({ mode: mode, ok: false, error: (e && e.message) || String(e), code: e && e.code }); throw e; });
      });
    });
    S.ready = chain.then(function (info) { S.info = info; return { mode: S.mode, D: info.D, P: info.P, terms: info.terms, claims: info.claims, ms: info.ms, gzip: info.gzip, enc: info.enc, tried: S.tried }; },
      function (e) { S.ready = null; var err = (e && e.code) ? e : mkErr('error', String(e && e.message || e)); err.tried = S.tried; throw err; });
    return S.ready;
  }
  function call(op, args) {
    return (S.ready || init()).then(function () { return S.core ? S.core[op].apply(S.core, args) : S.h.call(op, args); });
  }
  g.LnpSearch = {
    init: init,
    search: function (query, opts) { return call('search', [query, opts || {}]); },
    claims: function (p, lang) { return call('claims', [p, lang]); },
    abstract: function (p) { return call('abstract', [p]); },
    defs: function (p) { return call('defs', [p]); },
    claimImages: function (p) { return call('claimImages', [p]); },
    suggest: function (prefix, k) { return call('suggest', [prefix, k]); },
    highlight: function (text, parsed) { return call('highlight', [text, parsed]); },
    snippets: function (ps, parsed, o) { return call('snippets', [ps, parsed, o]); },
    parse: function (q) { return call('parse', [q]); },
    diag: function () { return call('diag', []).then(function (d) { d.mode = S.mode; d.tried = S.tried; d.lowMemory = !!S.low; d.gzip = S.info && S.info.gzip; d.enc = S.info && S.info.enc; return d; }); },
    onProgress: function (fn) { S.listeners.push(fn); return function () { var i = S.listeners.indexOf(fn); if (i >= 0) S.listeners.splice(i, 1); }; },
    reset: function () { if (S.h) S.h.terminate(); S.h = null; S.core = null; S.ready = null; S.mode = null; S.info = null; }
  };
})(typeof self !== 'undefined' ? self : this);
