/* LNP-FTO file loader (global LnpLoader). Plain script, ASCII only, no dependencies.
   Fetches files that are published next to the page (relative, same origin only), inflates gzip with
   DecompressionStream or - when that is missing - with the bundled fflate (vendor/fflate.js), understands the
   base64 fallback encoding (x.gz.bin -> x.gz.b64.txt, x.bin -> x.b64.txt), keeps an LRU cache, reports progress
   and rejects with plain error objects {code, message, name, url, status}.

   var L = LnpLoader.create({base: 'data/', enc: 'bin'|'b64'|'auto', sizes: {name: bytes}, cacheBytes: 48e6,
                             onProgress: fn, fetch: fn, gzip: 'auto'|'native'|'fflate', vendorUrl: '.../fflate.js'});
   L.get(name, {as: 'bin'|'json'|'text', cache: true})  -> Promise (ArrayBuffer | object | string)
        names ending in .gz.bin are inflated; .json/.txt are fetched as they are; any other .bin is raw bytes
   L.on(fn) / LnpLoader.on(fn)   progress events {type: 'start'|'progress'|'done'|'error', name, loaded, total, active}
   L.diag() -> {gzip, enc, fetches, bytes, cached, cacheBytes}
   When this file runs inside a Worker that was created with the name "lnp-loader" it serves
   {id, op: 'init'|'get'|'enc'|'diag', ...} messages (used by LnpData to keep inflating off the main thread). */
(function (g) {
  'use strict';
  function mkErr(code, message, extra) { var e = { code: code, message: message }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  var globalListeners = [];

  // ---------------------------------------------------------------- LRU (by approximate bytes)
  function LRU(maxBytes, maxEntries) { this.max = maxBytes || 48e6; this.maxN = maxEntries || 1e9; this.m = new Map(); this.bytes = 0; }
  LRU.prototype.get = function (k) { var e = this.m.get(k); if (!e) return undefined; this.m.delete(k); this.m.set(k, e); return e.v; };
  LRU.prototype.has = function (k) { return this.m.has(k); };
  LRU.prototype.set = function (k, v, size) {
    var old = this.m.get(k); if (old) { this.bytes -= old.s; this.m.delete(k); }
    size = size || 1; this.m.set(k, { v: v, s: size }); this.bytes += size;
    while ((this.bytes > this.max || this.m.size > this.maxN) && this.m.size > 1) {
      var first = this.m.keys().next().value; if (first === k) break;
      this.bytes -= this.m.get(first).s; this.m.delete(first);
    }
    return v;
  };
  LRU.prototype.delete = function (k) { var e = this.m.get(k); if (e) { this.bytes -= e.s; this.m.delete(k); } };
  LRU.prototype.clear = function () { this.m.clear(); this.bytes = 0; };

  // ---------------------------------------------------------------- helpers
  function b64ToBytes(t) {
    var s;
    try { s = atob(t.replace(/\s+/g, '')); } catch (e) { throw mkErr('b64', 'invalid base64 data'); }
    var n = s.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function toU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function tight(u8) { return (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }
  function dirOf(url) { return String(url).replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); }
  var selfUrl = '';
  try { if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) selfUrl = document.currentScript.src; } catch (e) { /* ignore */ }
  var isWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
  if (!selfUrl && isWorker) { try { if (!/^blob:/.test(String(self.location.href))) selfUrl = String(self.location.href); } catch (e) { /* ignore */ } }

  var fflateLoading = null;
  function ensureFflate(vendorUrl) {
    if (g.fflate && g.fflate.gunzipSync) return Promise.resolve(g.fflate);
    if (fflateLoading) return fflateLoading;
    var url = vendorUrl || (selfUrl ? dirOf(selfUrl) + '../vendor/fflate.js' : '');
    fflateLoading = new Promise(function (resolve, reject) {
      var fail = function (why) { fflateLoading = null; reject(mkErr('no_gzip', 'no gzip decoder: DecompressionStream is missing and fflate could not be loaded (' + why + ')', { url: url })); };
      if (!url) return fail('location of vendor/fflate.js unknown');
      if (isWorker) {
        try { self.importScripts(url); } catch (e) { return fail(String(e && e.message || e)); }
        return (g.fflate && g.fflate.gunzipSync) ? resolve(g.fflate) : fail('script did not define fflate');
      }
      if (typeof document === 'undefined') return fail('no document');
      var s = document.createElement('script'); s.src = url;
      s.onload = function () { (g.fflate && g.fflate.gunzipSync) ? resolve(g.fflate) : fail('script did not define fflate'); };
      s.onerror = function () { fail('script load error'); };
      document.head.appendChild(s);
    });
    return fflateLoading;
  }
  function hasNative() { return typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined'; }
  // -> Promise<ArrayBuffer>
  function gunzip(bytes, how, vendorUrl) {
    var u8 = toU8(bytes);
    if (how !== 'fflate' && hasNative()) {
      return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        .catch(function (e) { throw mkErr('gzip', 'gzip stream is damaged: ' + (e && e.message || e)); });
    }
    if (how === 'native') return Promise.reject(mkErr('no_gzip', 'DecompressionStream is not available'));
    return ensureFflate(vendorUrl).then(function (f) {
      try { return tight(f.gunzipSync(u8)); } catch (e) { throw mkErr('gzip', 'gzip stream is damaged: ' + (e && e.message || e)); }
    });
  }

  // ---------------------------------------------------------------- loader instance
  function create(o) {
    o = o || {};
    var base = o.base == null ? '' : String(o.base);
    var st = { enc: o.enc || 'auto', fetches: 0, bytes: 0, active: 0 };
    var cache = new LRU(o.cacheBytes || 48e6, o.cacheEntries);
    var inflight = new Map(), listeners = [];
    var doFetch = o.fetch || function (u) { return fetch(u); };
    var sizes = o.sizes || null;
    function emit(ev) {
      ev.active = st.active;
      if (o.onProgress) { try { o.onProgress(ev); } catch (e) { /* listener errors never break loading */ } }
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](ev); } catch (e) { /* ignore */ } }
      for (var j = 0; j < globalListeners.length; j++) { try { globalListeners[j](ev); } catch (e) { /* ignore */ } }
    }
    function fileName(name, enc) { return enc === 'b64' && /\.bin$/.test(name) ? name.replace(/\.bin$/, '.b64.txt') : name; }
    // fetch one physical file -> Uint8Array, with progress
    function fetchBytes(name, phys) {
      var url = base + phys, total = (sizes && sizes[phys]) || 0;
      return Promise.resolve().then(function () { return doFetch(url); }).then(function (r) {
        if (!r || !r.ok) throw mkErr('http', phys + ': HTTP ' + (r ? r.status : '?'), { name: name, url: url, status: r ? r.status : 0 });
        if (!total) { var cl = r.headers && r.headers.get && +r.headers.get('content-length'); if (cl) total = cl; }
        if (!r.body || !r.body.getReader) return r.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        var reader = r.body.getReader(), chunks = [], loaded = 0;
        function pump() {
          return reader.read().then(function (x) {
            if (x.done) return;
            chunks.push(x.value); loaded += x.value.length;
            emit({ type: 'progress', name: name, loaded: loaded, total: total });
            return pump();
          });
        }
        return pump().then(function () {
          if (chunks.length === 1) return chunks[0];
          var u = new Uint8Array(loaded), off = 0;
          for (var i = 0; i < chunks.length; i++) { u.set(chunks[i], off); off += chunks[i].length; }
          return u;
        });
      }, function (e) {
        if (e && e.code) throw e;
        throw mkErr('network', phys + ': ' + (e && e.message || e), { name: name, url: url, status: 0 });
      }).then(function (u8) { st.fetches++; st.bytes += u8.length; return u8; }, function (e) {
        if (e && e.code) throw e;
        throw mkErr('network', phys + ': ' + (e && e.message || e), { name: name, url: url, status: 0 });
      });
    }
    function rawBytes(name) { // -> Uint8Array of the logical binary (base64 already decoded)
      var isBin = /\.bin$/.test(name);
      if (!isBin) return fetchBytes(name, name);
      function viaB64() {
        return fetchBytes(name, fileName(name, 'b64')).then(function (u8) {
          var s = '', CH = 0x8000;
          for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
          try { return b64ToBytes(s); } catch (e) { e.name = name; throw e; }
        });
      }
      if (st.enc === 'b64') return viaB64();
      if (st.enc === 'bin') return fetchBytes(name, name);
      return fetchBytes(name, name).then(function (u) { st.enc = 'bin'; return u; }, function (e1) {
        return viaB64().then(function (u) { st.enc = 'b64'; return u; }, function () { throw e1; });
      });
    }
    function load(name, as) {
      st.active++; emit({ type: 'start', name: name, loaded: 0, total: (sizes && sizes[fileName(name, st.enc)]) || 0 });
      var p = rawBytes(name).then(function (u8) {
        return /\.gz\.bin$/.test(name) ? gunzip(u8, o.gzip, o.vendorUrl) : tight(u8);
      }).then(function (buf) {
        if (as === 'bin') return buf;
        var txt;
        try { txt = new TextDecoder('utf-8').decode(new Uint8Array(buf)); } catch (e) { throw mkErr('parse', name + ': not UTF-8'); }
        if (as === 'text') return txt;
        try { return JSON.parse(txt); } catch (e) { throw mkErr('parse', name + ': invalid JSON (' + (e && e.message || e) + ')'); }
      });
      return p.then(function (v) { st.active--; emit({ type: 'done', name: name, loaded: 1, total: 1 }); return v; },
        function (e) {
          st.active--;
          if (!e || !e.code) e = mkErr('error', name + ': ' + (e && e.message || e));
          if (!e.name) e.name = name;
          emit({ type: 'error', name: name, error: e, loaded: 0, total: 0 });
          throw e;
        });
    }
    function sizeOf(v, as) { return as === 'bin' ? v.byteLength : as === 'text' ? v.length * 2 : 0; }
    function get(name, opt) {
      opt = opt || {};
      var as = opt.as || (/\.json$/.test(name) ? 'json' : /\.txt$/.test(name) ? 'text' : 'bin');
      var key = as + ':' + name, useCache = opt.cache !== false;
      if (useCache) { var hit = cache.get(key); if (hit !== undefined) return Promise.resolve(hit); }
      var p = inflight.get(key);
      if (p) return p;
      p = load(name, as).then(function (v) {
        inflight.delete(key);
        if (useCache) cache.set(key, v, opt.size || sizeOf(v, as) || 4096);
        return v;
      }, function (e) { inflight.delete(key); throw e; });
      inflight.set(key, p);
      return p;
    }
    return {
      get: get,
      bin: function (name, opt) { opt = opt || {}; opt.as = 'bin'; return get(name, opt); },
      json: function (name, opt) { opt = opt || {}; opt.as = 'json'; return get(name, opt); },
      text: function (name, opt) { opt = opt || {}; opt.as = 'text'; return get(name, opt); },
      on: function (fn) { listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      setEnc: function (e) { if (e) st.enc = e; },
      setSizes: function (s) { sizes = s; },
      url: function (name) { return base + fileName(name, st.enc === 'b64' ? 'b64' : 'bin'); },
      base: base, cache: cache,
      diag: function () {
        return { gzip: o.gzip === 'fflate' ? 'fflate' : hasNative() ? 'native' : 'fflate', enc: st.enc, fetches: st.fetches, bytes: st.bytes, cached: cache.m.size, cacheBytes: cache.bytes };
      }
    };
  }

  // ---------------------------------------------------------------- worker start: file -> blob -> (caller falls back to main)
  // spawn({name, file, sources: [urls of the scripts that make up the worker, in order], timeoutMs, modes: ['worker','blob']})
  //   -> Promise<{mode: 'worker'|'blob', worker, call(op, args) -> Promise, onEvent: fn|null, terminate(), tried: [...]}>
  //   rejects with {code: 'no_worker', tried} when neither kind of worker answers a ping.
  // Protocol: {id, op, a} -> {id, ok, r|error}; messages without id ({ev: ...}) go to onEvent.
  function spawn(o) {
    var tried = [], timeoutMs = o.timeoutMs || 6000, modes = o.modes || ['worker', 'blob'];
    function wrap(w, mode) {
      var seq = 0, pending = new Map(), h = { mode: mode, worker: w, onEvent: null, tried: tried, dead: null };
      function killAll(e) { h.dead = e; pending.forEach(function (p) { p.reject(e); }); pending.clear(); }
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.id == null) { if (h.onEvent) { try { h.onEvent(m); } catch (e) { /* ignore */ } } return; }
        var p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        if (m.ok) p.resolve(m.r); else p.reject(m.error || mkErr('error', 'worker error'));
      };
      w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); killAll(mkErr('worker_error', 'worker failed: ' + (e && e.message || 'script error'))); };
      w.onmessageerror = function () { killAll(mkErr('worker_error', 'worker message could not be decoded')); };
      h.call = function (op, a, transfer) {
        if (h.dead) return Promise.reject(h.dead);
        return new Promise(function (resolve, reject) { var id = ++seq; pending.set(id, { resolve: resolve, reject: reject }); w.postMessage({ id: id, op: op, a: a || [] }, transfer || []); });
      };
      h.terminate = function () { try { w.terminate(); } catch (e) { /* ignore */ } killAll(mkErr('terminated', 'worker terminated')); };
      return h;
    }
    function ping(h) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { h.terminate(); reject(mkErr('timeout', 'worker did not answer within ' + timeoutMs + ' ms')); }, timeoutMs);
        h.call('ping').then(function () { clearTimeout(t); resolve(h); }, function (e) { clearTimeout(t); h.terminate(); reject(e); });
      });
    }
    function fromFile() {
      return Promise.resolve().then(function () {
        if (typeof Worker === 'undefined') throw mkErr('no_worker', 'Worker is not available');
        return ping(wrap(new Worker(o.file, { name: o.name }), 'worker'));
      });
    }
    function fromBlob() {
      return Promise.resolve().then(function () {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !g.URL || !URL.createObjectURL) throw mkErr('no_worker', 'blob workers are not available');
        return Promise.all(o.sources.map(function (u) { return fetch(u).then(function (r) { if (!r.ok) throw mkErr('http', u + ': HTTP ' + r.status); return r.text(); }); }));
      }).then(function (srcs) {
        var url = URL.createObjectURL(new Blob([srcs.join('\n;\n')], { type: 'text/javascript' }));
        var h = wrap(new Worker(url, { name: o.name }), 'blob');
        return ping(h).then(function (x) { return x; }, function (e) { try { URL.revokeObjectURL(url); } catch (e2) { /* ignore */ } throw e; });
      });
    }
    var chain = Promise.reject(mkErr('no_worker', 'no worker mode requested'));
    modes.forEach(function (m) {
      chain = chain.catch(function () {
        return (m === 'worker' ? fromFile() : fromBlob()).then(function (h) { tried.push({ mode: m, ok: true }); return h; },
          function (e) { tried.push({ mode: m, ok: false, error: (e && e.message) || String(e) }); throw e; });
      });
    });
    return chain.catch(function () { throw mkErr('no_worker', 'no worker could be started', { tried: tried }); });
  }
  function loadScript(url) {            // main thread only
    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') return reject(mkErr('no_document', 'cannot load ' + url));
      var s = document.createElement('script'); s.src = url;
      s.onload = function () { resolve(); }; s.onerror = function () { reject(mkErr('script', 'could not load ' + url)); };
      document.head.appendChild(s);
    });
  }

  var api = {
    create: create, LRU: LRU, spawn: spawn, loadScript: loadScript, gunzip: gunzip, b64ToBytes: b64ToBytes, error: mkErr, dirOf: dirOf, selfUrl: selfUrl,
    hasNativeGzip: hasNative,
    on: function (fn) { globalListeners.push(fn); return function () { var i = globalListeners.indexOf(fn); if (i >= 0) globalListeners.splice(i, 1); }; },
    VERSION: 1
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpLoader = api;

  // ---------------------------------------------------------------- worker service (only for Worker name "lnp-loader")
  if (isWorker && self.name === 'lnp-loader') {
    var inst = null, waiting = {};
    self.onmessage = function (ev) {
      var m = ev.data || {}, id = m.id;
      function ok(r, tr) { self.postMessage({ id: id, ok: true, r: r }, tr || []); }
      function fail(e) { self.postMessage({ id: id, ok: false, error: (e && e.code) ? e : mkErr('error', String(e && e.message || e)) }); }
      try {
        if (m.op === 'ping') ok('pong');
        else if (m.op === 'init') {
          var o = (m.a && m.a[0]) || {};
          o.onProgress = function (e) { var c = { ev: 'progress', type: e.type, name: e.name, loaded: e.loaded, total: e.total, active: e.active }; if (e.error) c.error = e.error; self.postMessage(c); };
          inst = create(o); ok({ gzip: inst.diag().gzip });
        } else if (m.op === 'get') {
          // never cached here: the page side keeps the cache; ArrayBuffers are transferred
          // Concurrent requests for one file share one fetch and so one ArrayBuffer: only the last waiter may take it
          // by transfer, the others get a copy (a second transfer of the same buffer throws and the caller would hang).
          var key = m.a[0] + '|' + (m.a[1] || 'bin');
          waiting[key] = (waiting[key] || 0) + 1;
          inst.get(m.a[0], { as: m.a[1] || 'bin', cache: false }).then(function (v) {
            var shared = waiting[key] > 1; waiting[key]--;
            if (!(v instanceof ArrayBuffer)) ok(v);
            else if (shared) ok(v.slice(0), []);
            else ok(v, [v]);
          }, function (e) { waiting[key]--; fail(e); }).then(null, fail);
        } else if (m.op === 'enc') { inst.setEnc(m.a[0]); ok(true); }
        else if (m.op === 'diag') ok(inst ? inst.diag() : null);
        else fail(mkErr('bad_op', 'unknown op ' + m.op));
      } catch (e) { fail(e); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
