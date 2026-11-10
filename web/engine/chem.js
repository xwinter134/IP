/* chem.js - LnpChem: structure search over the lipid compound set, in the browser. ASCII only. No eval, no wasm.

   Needs next to it: chem-worker.js, chemfp.js and OpenChemLib 8.21.0 (../vendor/openchemlib-full.js, or
   openchemlib-full.js in the same directory). Data: the chemistry shards written by pipeline/chem_build.cjs
   (chem.json, idc/ffp/fp/desc/scaf/map/pat .gz.bin, names.json), by default under data/chem/.

   Modes, first that works: dedicated Workers from chem-worker.js ("worker"), Workers from a blob: URL built from the
   same sources ("blob"), main thread ("main"). Substructure search is spread over up to 4 workers.

   API (every function returns a promise; details in docs/ARCHITECTURE.md):
     LnpChem.init(opts) | LnpChem.init(manifest, loader)
     LnpChem.parse(input)                      input: SMILES, molfile, reference lipid name/synonym, "SCHEMBL123", "smarts:..."
     LnpChem.search({query, mode, limit, minSim, filters, sort, maxPatents, onProgress, signal})
     LnpChem.patentsOf(c)  LnpChem.compoundsOf(pOrPn, k)  LnpChem.compound(c)  LnpChem.byId(id)
     LnpChem.svg(x, w, h)  LnpChem.descriptors(input)  LnpChem.names()  LnpChem.editor(el, opts)  LnpChem.diag()
*/
(function (g) {
  'use strict';
  var isNode = typeof module !== 'undefined' && !!module.exports && typeof document === 'undefined';
  var scriptUrl = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  var WHERE = { clm: 1, desc: 2, abs: 4, ttl: 8, img: 16, mol: 32 };
  var CHUNK = 1024;
  var S = null;        // state after init
  var starting = null; // init promise

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ------------------------------------------------------------------ loading */
  function gunzip(u8) {
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return Promise.resolve(u8); // already inflated (server-side content encoding)
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('gzip'), w = ds.writable.getWriter();
      w.write(u8).catch(function () {}); w.close().catch(function () {});
      return new Response(ds.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    if (g.fflate && g.fflate.gunzipSync) return Promise.resolve(g.fflate.gunzipSync(u8));
    return Promise.reject(err('no_gzip', 'no gzip decoder available (DecompressionStream and fflate are both missing)'));
  }
  function b64ToBytes(t) {
    var bin = atob(t.replace(/\s+/g, '')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function fetchFile(base, name, enc) {
    function bin() { return fetch(base + name).then(function (r) { if (!r.ok) throw err('http', name + ': HTTP ' + r.status); return r.arrayBuffer(); }).then(function (b) { return new Uint8Array(b); }); }
    function b64() { var n2 = name.replace(/\.bin$/, '.b64.txt'); return fetch(base + n2).then(function (r) { if (!r.ok) throw err('http', n2 + ': HTTP ' + r.status); return r.text(); }).then(b64ToBytes); }
    var p = enc === 'b64' ? b64() : enc === 'bin' ? bin() : bin().catch(function () { return b64(); });
    return p.then(gunzip);
  }
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = function () { resolve(url); }; s.onerror = function () { reject(err('script', 'could not load ' + url)); };
      document.head.appendChild(s);
    });
  }
  function firstThatLoads(urls, test) {
    var i = 0;
    function next(last) { if (test()) return Promise.resolve(); if (i >= urls.length) return Promise.reject(last || err('script', 'no url')); return loadScript(urls[i++]).then(function () { return next(); }, next); }
    return next();
  }
  function fetchText(url) { return fetch(url).then(function (r) { if (!r.ok) throw err('http', url + ': HTTP ' + r.status); return r.text(); }); }

  /* ------------------------------------------------------------------ workers */
  function Remote(worker) {
    var self = this; this.w = worker; this.seq = 0; this.pending = {}; this.dead = null;
    worker.onmessage = function (e) { var m = e.data, p = self.pending[m.id]; if (!p) return; delete self.pending[m.id]; if (m.ok) p[0](m.r); else p[1](err('chem', m.error)); };
    worker.onerror = function (e) { self.dead = err('worker', 'worker failed: ' + (e && e.message || 'load error')); if (e && e.preventDefault) e.preventDefault(); for (var k in self.pending) { self.pending[k][1](self.dead); } self.pending = {}; };
  }
  Remote.prototype.call = function (op, a, transfer) {
    var self = this;
    if (this.dead) return Promise.reject(this.dead);
    return new Promise(function (resolve, reject) { var id = ++self.seq; self.pending[id] = [resolve, reject]; self.w.postMessage({ id: id, op: op, a: a }, transfer || []); });
  };
  Remote.prototype.close = function () { try { this.w.terminate(); } catch (e) { /* ignore */ } };
  function Local(core) { this.core = core; }
  Local.prototype.call = function (op, a) { var c = this.core; return Promise.resolve().then(function () { return c[op](a || {}); }); };
  Local.prototype.close = function () {};

  function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) { var t = setTimeout(function () { reject(err('timeout', what + ' timed out')); }, ms); p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); }); });
  }
  function urls(o) {
    var eb = o.engineBase || (scriptUrl ? scriptUrl.replace(/[^\/]*$/, '') : 'engine/');
    if (typeof location !== 'undefined') { try { eb = new URL(eb, location.href).href; } catch (e) { /* keep */ } }
    var ocl = o.oclUrl ? [o.oclUrl] : [eb + '../vendor/openchemlib-full.js', eb + 'openchemlib-full.js'];
    if (typeof location !== 'undefined') ocl = ocl.map(function (u) { try { return new URL(u, location.href).href; } catch (e) { return u; } });
    return { ocl: ocl, fp: eb + 'chemfp.js', worker: eb + 'chem-worker.js' };
  }
  var blobUrl = null;
  function blobSource(U) {
    if (blobUrl) return blobUrl;
    var i = 0;
    function ocl(last) { if (i >= U.ocl.length) return Promise.reject(last || err('http', 'OpenChemLib not found')); return fetchText(U.ocl[i++]).catch(ocl); }
    blobUrl = Promise.all([ocl(), fetchText(U.fp), fetchText(U.worker)]).then(function (t) {
      return URL.createObjectURL(new Blob([t[0], '\n;\n', t[1], '\n;\n', t[2]], { type: 'text/javascript' }));
    });
    blobUrl.catch(function () { blobUrl = null; });
    return blobUrl;
  }
  function spawn(mode, U) {
    if (mode === 'worker') {
      return Promise.resolve().then(function () {
        var r = new Remote(new Worker(U.worker));
        return withTimeout(r.call('boot', { ocl: U.ocl, urls: [U.fp] }), 30000, 'worker start').then(function () { return r; }, function (e) { r.close(); throw e; });
      });
    }
    if (mode === 'blob') {
      return blobSource(U).then(function (url) {
        var r = new Remote(new Worker(url));
        return withTimeout(r.call('boot', {}), 30000, 'blob worker start').then(function () { return r; }, function (e) { r.close(); throw e; });
      });
    }
    return firstThatLoads(U.ocl, function () { return !!g.OCL; })
      .then(function () { return g.ChemFP ? null : loadScript(U.fp); })
      .then(function () { return g.LnpChemCore ? null : loadScript(U.worker); })
      .then(function () { return new Local(g.LnpChemCore.create(g.OCL, g.ChemFP)); });
  }

  /* ------------------------------------------------------------------ init */
  function init(a, b) {
    if (starting) return starting;
    var o = (a && a.files) ? { manifest: a } : (a || {});
    if (typeof b === 'function') o.loader = b;
    starting = doInit(o).then(function () { return diagSync(); });
    starting.catch(function () { starting = null; S = null; });
    return starting;
  }
  function ready() { return starting ? starting : init(); }

  function doInit(o) {
    var t0 = now(), st = { o: o, ms: {}, tried: [] };
    var base = o.base || 'data/chem/';
    var enc = o.enc || (g.LnpData && g.LnpData.manifest && g.LnpData.manifest.enc) || null;
    var U = urls(o);
    var manifestP = o.manifest ? Promise.resolve(o.manifest) :
      fetch(base + 'chem.json').then(function (r) { if (!r.ok) throw err('http', 'chem.json: HTTP ' + r.status); return r.json(); });
    return manifestP.then(function (man) {
      st.man = man; st.n = man.n;
      var load = o.loader ? function (key) { return Promise.resolve(o.loader(man.files[key].file, man.files[key])).then(function (x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }); }
        : function (key) { return fetchFile(base, man.files[key].file, enc); };
      var namesP = o.loader ? Promise.resolve(o.loader(man.names || 'names.json', null)).then(function (x) { return typeof x === 'string' ? JSON.parse(x) : (x instanceof Uint8Array || x instanceof ArrayBuffer) ? JSON.parse(new TextDecoder().decode(x)) : x; })
        : fetch(base + (man.names || 'names.json')).then(function (r) { return r.ok ? r.json() : []; });
      // the first worker decides the mode
      var chain = o.core ? ['given'] : (o.mode && o.mode !== 'auto') ? [o.mode] : ((typeof Worker !== 'undefined') ? ['worker', 'blob', 'main'] : ['main']);
      function start(i, last) {
        if (i >= chain.length) return Promise.reject(last || err('init', 'no engine mode works'));
        var mode = chain[i];
        if (mode === 'given') { st.mode = 'main'; return Promise.resolve(new Local(o.core.create(o.core.OCL, o.core.ChemFP))); }
        return spawn(mode, U).then(function (r) { st.mode = mode; return r; }, function (e) { st.tried.push(mode + ': ' + (e && e.message || e)); return start(i + 1, e); });
      }
      var primaryP = start(0);
      var keys = ['idc', 'ffp', 'fp', 'desc', 'scaf', 'map', 'pat'];
      return Promise.all([primaryP, namesP.catch(function () { return []; })].concat(keys.map(load))).then(function (r) {
        st.ms.fetch = Math.round(now() - t0);
        var primary = r[0], names = r[1], f = {};
        keys.forEach(function (k, i) { f[k] = r[i + 2]; });
        st.pool = [primary]; st.names = names || [];
        // descriptor columns
        var TA = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, f32: Float32Array };
        var db = f.desc.buffer.slice(f.desc.byteOffset, f.desc.byteOffset + f.desc.byteLength); st.col = {};
        man.cols.forEach(function (c) { st.col[c.name] = new TA[c.type](db, c.off, man.n); });
        // compound -> publications
        var mb = f.map.buffer.slice(f.map.byteOffset, f.map.byteOffset + f.map.byteLength), dv = new DataView(mb), ne = dv.getUint32(4, true);
        st.mOff = new Uint32Array(mb, 8, man.n + 1); st.mEnt = new Uint32Array(mb, 8 + (man.n + 1) * 4, ne);
        var pat = JSON.parse(new TextDecoder().decode(f.pat)); st.pn = pat.pn; st.fam = pat.fam;
        st.pOf = new Int32Array(st.pn.length).fill(-2);
        st.scafs = new TextDecoder('latin1').decode(f.scaf).split('\n');
        st.nameIdx = {}; st.names.forEach(function (nm, i) { [nm.name].concat(nm.synonyms || []).forEach(function (s) { var k = normName(s); if (k && st.nameIdx[k] === undefined) st.nameIdx[k] = i; }); });
        st.idcBytes = f.idc; st.ffpBytes = f.ffp;
        var t1 = now();
        return primary.call('load', { idc: f.idc, ffp: f.ffp, fp: f.fp }).then(function (res) {
          if (res.n !== man.n) throw err('init', 'compound count mismatch');
          st.ms.load = Math.round(now() - t1); st.ms.init = Math.round(now() - t0);
          S = st;
          // helper workers for substructure search join in the background
          var want = st.mode === 'main' ? 1 : Math.max(1, Math.min(4, o.workers || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
          st.helpers = [];
          for (var i = 1; i < want; i++) {
            st.helpers.push(spawn(st.mode, U).then(function (w) {
              return w.call('load', { idc: st.idcBytes, ffp: st.ffpBytes }).then(function () { st.pool.push(w); return w; });
            }).catch(function (e) { st.tried.push('helper: ' + (e && e.message || e)); return null; }));
          }
          st.helpersDone = Promise.all(st.helpers).then(function () { st.idcBytes = null; st.ffpBytes = null; st.ms.pool = Math.round(now() - t0); });
        });
      });
    });
  }
  function diagSync() { return { mode: S.mode, workers: S.pool.length, n: S.n, publications: S.pn.length, links: S.mEnt.length, scaffolds: S.scafs.length, ocl: S.man.ocl, snapshot: S.man.snapshot, built: S.man.built, ms: S.ms, tried: S.tried, gzip: typeof DecompressionStream !== 'undefined' ? 'native' : (g.fflate ? 'fflate' : 'none') }; }
  function diag() { return ready().then(function () { return S.helpersDone; }).then(diagSync); }

  /* ------------------------------------------------------------------ queries */
  function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  var idMap = null;
  function cOfId(id) {
    if (!idMap) { idMap = new Map(); var ids = S.col.id; for (var i = 0; i < ids.length; i++) idMap.set(ids[i], i); }
    var c = idMap.get(+String(id).replace(/^SCHEMBL\s*/i, ''));
    return c === undefined ? -1 : c;
  }
  // -> {kind, q, name?}
  function classify(input) {
    if (typeof input === 'number') { if (!(input >= 0 && input < S.n)) throw err('bad_query', 'unknown compound ' + input); return { kind: 'compound', q: { c: input } }; }
    if (input && typeof input === 'object') {
      if (input.c !== undefined && input.c !== null) return classify(+input.c);
      if (input.molfile) return { kind: 'molfile', q: { molfile: String(input.molfile) } };
      if (input.idcode) return { kind: 'idcode', q: { idcode: String(input.idcode) } };
      if (input.smarts) return { kind: 'smarts', q: { smarts: String(input.smarts) } };
      if (input.smiles) return classify(String(input.smiles));
      if (input.query !== undefined) return classify(input.query);
      throw err('bad_query', 'no structure given');
    }
    var s = String(input == null ? '' : input);
    if (/\n/.test(s) && /M {2}END|V2000|V3000/.test(s)) return { kind: 'molfile', q: { molfile: s } };
    s = s.trim();
    if (!s) throw err('bad_query', 'empty query');
    if (s.length > 20000) throw err('bad_query', 'query too long');
    var ni = S.nameIdx[normName(s)];
    if (ni !== undefined && normName(s).length >= 2) return { kind: 'name', name: S.names[ni].name, q: { smiles: S.names[ni].smiles } };
    if (/^SCHEMBL\s*\d+$/i.test(s)) { var c = cOfId(s); if (c < 0) throw err('bad_query', s + ' is not in the compound set'); return { kind: 'id', q: { c: c } }; }
    if (/^smarts:/i.test(s)) return { kind: 'smarts', q: { smarts: s.slice(7).trim() } };
    if (/^idcode:/i.test(s)) return { kind: 'idcode', q: { idcode: s.slice(7).trim() } };
    if (/\s/.test(s)) throw err('bad_query', 'not a known lipid name and not a SMILES: ' + s.slice(0, 60));
    return { kind: 'smiles', q: { smiles: s } };
  }
  function parse(input) {
    return ready().then(function () {
      var k; try { k = classify(input); } catch (e) { return { ok: false, error: e.message }; }
      return S.pool[0].call('resolve', k.q).then(function (r) {
        var o = { ok: true, kind: k.kind, smiles: r.smiles, idcode: r.idcode, formula: r.formula, mw: r.mw };
        if (k.name) o.name = k.name;
        if (k.q.c !== undefined) { o.c = k.q.c; o.id = 'SCHEMBL' + S.col.id[k.q.c]; }
        return o;
      }, function (e) { return { ok: false, kind: k.kind, error: 'could not read the structure: ' + e.message }; });
    });
  }

  /* ------------------------------------------------------------------ filters */
  // filters: {<column>: n | [min, max], head: name | [names], amine: 'tertiary'|..., inClaims: bool, where: ['clm','img',..] (any),
  //           branched: bool, biodegradable: bool, tailLen: [min,max] (longest tail), unsat: [min,max] (double bonds in tails),
  //           pns: [publication numbers] | ps: [patent indexes] (compounds found in any of them)}
  var ALIAS = { mwMin: 1, mwMax: 1 };
  function buildMask(f) {
    if (!f) return Promise.resolve(null);
    var keys = Object.keys(f).filter(function (k) { return f[k] !== undefined && f[k] !== null && f[k] !== '' && !(Array.isArray(f[k]) && !f[k].length); });
    if (!keys.length) return Promise.resolve(null);
    var n = S.n, m = new Uint8Array(n).fill(1), C = S.col, i;
    function range(col, lo, hi) { for (var j = 0; j < n; j++) if (m[j] && (col[j] < lo || col[j] > hi)) m[j] = 0; }
    function bit(col, b, want) { for (var j = 0; j < n; j++) if (m[j] && (((col[j] & b) !== 0) !== want)) m[j] = 0; }
    var pre = Promise.resolve();
    keys.forEach(function (k) {
      var v = f[k];
      if (k === 'mwMin') range(C.mw, +v, Infinity);
      else if (k === 'mwMax') range(C.mw, -Infinity, +v);
      else if (k === 'head') { var hs = (Array.isArray(v) ? v : [v]).map(function (x) { return S.man.heads.indexOf(x); }); for (i = 0; i < n; i++) if (m[i] && hs.indexOf(C.head[i]) < 0) m[i] = 0; }
      else if (k === 'amine') { var col = { tertiary: C.nTert, secondary: C.nSec, primary: C.nPrim, quaternary: C.nQuat, amide: C.nAmideN }[v]; if (!col) throw err('bad_filter', 'unknown amine class ' + v); range(col, 1, Infinity); }
      else if (k === 'inClaims') { if (v) range(C.nClm, 1, Infinity); else range(C.nClm, 0, 0); }
      else if (k === 'where') { var b = 0; (Array.isArray(v) ? v : [v]).forEach(function (x) { if (!WHERE[x]) throw err('bad_filter', 'unknown where ' + x); b |= WHERE[x]; }); bit(C.wbits, b, true); }
      else if (k === 'branched') { if (v) range(C.nBranched, 1, Infinity); else range(C.nBranched, 0, 0); }
      else if (k === 'biodegradable') bit(C.flags, 1, !!v);
      else if (k === 'tailLen') { var tl = Array.isArray(v) ? v : [v, v]; range(C.t0, tl[0] == null ? 0 : tl[0], tl[1] == null ? Infinity : tl[1]); }
      else if (k === 'unsat') { var us = Array.isArray(v) ? v : [v, v]; range(C.tailDbl, us[0] == null ? 0 : us[0], us[1] == null ? Infinity : us[1]); }
      else if (k === 'pns' || k === 'ps') {
        pre = pre.then(function () { return k === 'ps' ? Promise.all(v.map(pnOfP)) : v; }).then(function (pns) {
          var allow = new Uint8Array(n); inverse();
          pns.forEach(function (pn) { var pi = pnIndex().get(String(pn)); if (pi === undefined) return; for (var j = S.iOff[pi]; j < S.iOff[pi + 1]; j++) allow[S.iEnt[j] >>> 8] = 1; });
          for (var j2 = 0; j2 < n; j2++) if (!allow[j2]) m[j2] = 0;
        });
      }
      else if (C[k]) { var r = Array.isArray(v) ? v : [v, v]; range(C[k], r[0] == null ? -Infinity : +r[0], r[1] == null ? Infinity : +r[1]); }
      else if (!ALIAS[k]) throw err('bad_filter', 'unknown filter ' + k);
    });
    return pre.then(function () { return m; });
  }

  /* ------------------------------------------------------------------ records */
  function whereObj(b) { return { clm: !!(b & 1), desc: !!(b & 2), abs: !!(b & 4), ttl: !!(b & 8), img: !!(b & 16), mol: !!(b & 32) }; }
  function summary(c) {
    var C = S.col, tails = [], k;
    for (k = 0; k < 6; k++) { var len = C['t' + k][c]; if (!len) break; var u = C['u' + k][c]; tails.push({ nC: len, nDoubleBonds: u & 15, branched: !!(u & 16), branchPosition: C['b' + k][c], ring: !!(u & 32), acyl: !!(u & 64), triple: !!(u & 128) }); }
    var linkers = {};
    ['ester', 'carbonate', 'carbamate', 'amide', 'urea', 'thioester', 'ether', 'thioether', 'disulfide', 'ketal', 'phosphate', 'hydroxyl', 'acid'].forEach(function (x) { if (C[x][c]) linkers[x] = C[x][c]; });
    var am = { tertiary: C.nTert[c], secondary: C.nSec[c], primary: C.nPrim[c], quaternary: C.nQuat[c], amide: C.nAmideN[c], aromatic: C.nArN[c], other: C.nOtherN[c] };
    var cls = 'none', cnt = 0; ['tertiary', 'quaternary', 'secondary', 'primary'].forEach(function (x) { if (am[x] > cnt) { cnt = am[x]; cls = x; } });
    return { head: S.man.heads[C.head[c]], amine: { 'class': cls, count: cnt }, amines: am, linkers: linkers, nTails: C.nTails[c], nChainEnds: C.nEnds[c], tails: tails,
      tailCarbons: C.tailC[c], tailDoubleBonds: C.tailDbl[c], nBranchedTails: C.nBranched[c], heavy: C.heavy[c], nC: C.nC[c], nN: C.nN[c], nO: C.nO[c], nP: C.nP[c], nS: C.nS[c], charge: C.charge[c], rings: C.rings[c],
      nCarbonsToAmine: C.spacer[c] === 255 ? -1 : C.spacer[c], hasOH: !!(C.flags[c] & 2), biodegradable: !!(C.flags[c] & 1), hasCyclopropyl: !!(C.flags[c] & 4), stereo: !!(C.flags[c] & 16),
      logPest: C.logp[c] / 100, scaffold: C.scaf[c] };
  }
  function resolveP(idxs) {
    // fills S.pOf for the given publication indexes of the chemistry set
    var need = []; for (var i = 0; i < idxs.length; i++) if (S.pOf[idxs[i]] === -2) need.push(idxs[i]);
    if (!need.length) return Promise.resolve();
    var o = S.o, D = g.LnpData;
    if (o.resolvePn) return Promise.all(need.map(function (pi) { return Promise.resolve(o.resolvePn(S.pn[pi])).then(function (p) { S.pOf[pi] = (p === undefined || p === null) ? -1 : p; }, function () { S.pOf[pi] = -1; }); }));
    if (D && D.all && !S.bulkTried) {
      S.bulkTried = true;
      return Promise.resolve(D.all()).then(function (v) {
        var arr = v && v.pn; if (!arr) throw new Error('no pn column');
        var mp = new Map(); for (var j = 0; j < arr.length; j++) mp.set(arr[j], j);
        for (var k = 0; k < S.pn.length; k++) { var p = mp.get(S.pn[k]); S.pOf[k] = p === undefined ? -1 : p; }
      }).catch(function () { return resolveP(idxs); });
    }
    if (D && D.byPn) return Promise.all(need.map(function (pi) { return Promise.resolve(D.byPn(S.pn[pi])).then(function (p) { S.pOf[pi] = (p === undefined || p === null) ? -1 : p; }, function () { S.pOf[pi] = -1; }); }));
    need.forEach(function (pi) { S.pOf[pi] = -1; });
    return Promise.resolve();
  }
  function patentList(c, max) {
    var a = [], j;
    for (j = S.mOff[c]; j < S.mOff[c + 1]; j++) a.push(S.mEnt[j]);
    a.sort(function (x, y) { return (y & 1) - (x & 1) || ((y & 48) ? 1 : 0) - ((x & 48) ? 1 : 0) || (x >>> 8) - (y >>> 8); }); // claims first, then drawn structures
    if (max && a.length > max) a = a.slice(0, max);
    return resolveP(a.map(function (e) { return e >>> 8; })).then(function () {
      return a.map(function (e) { var pi = e >>> 8; return { p: S.pOf[pi], pn: S.pn[pi], fam: S.fam[pi], where: whereObj(e & 63) }; });
    });
  }
  function record(c) {
    var C = S.col;
    return { c: c, id: 'SCHEMBL' + C.id[c], mw: +C.mw[c].toFixed(2), nPat: C.nPat[c], nFam: C.nFam[c], nClaims: C.nClm[c], inClaims: C.nClm[c] > 0, where: whereObj(C.wbits[c]), nPatGlobal: C.nPatG[c], desc: summary(c) };
  }
  function buildHits(list, sims, o, extra) {
    var maxP = o.maxPatents === undefined ? 25 : o.maxPatents;
    return S.pool[0].call('info', { list: Array.from(list) }).then(function (info) {
      return Promise.all(info.map(function (x, i) {
        var h = record(x.c); h.sim = sims ? +(+sims[i]).toFixed(4) : null; h.smiles = x.smiles; h.idcode = x.idcode; h.formula = x.formula;
        if (extra && extra[x.c]) h.match = extra[x.c];
        if (!maxP) { h.patents = []; h.morePatents = h.nPat; return h; }
        return patentList(x.c, maxP).then(function (pl) { h.patents = pl; h.morePatents = Math.max(0, h.nPat - pl.length); return h; });
      }));
    });
  }
  function sorter(sort, sims) {
    var C = S.col;
    if (sort === 'patents') return function (a, b) { return C.nPat[b.c] - C.nPat[a.c] || b.s - a.s; };
    if (sort === 'claims') return function (a, b) { return C.nClm[b.c] - C.nClm[a.c] || b.s - a.s; };
    if (sort === 'mw') return function (a, b) { return C.mw[a.c] - C.mw[b.c]; };
    return function (a, b) { return b.s - a.s || C.nClm[b.c] - C.nClm[a.c] || C.nPat[b.c] - C.nPat[a.c] || a.c - b.c; };
  }
  function rank(list, sims, sort, limit) {
    var arr = []; for (var i = 0; i < list.length; i++) arr.push({ c: list[i], s: sims ? sims[i] : 0 });
    arr.sort(sorter(sort)); if (arr.length > limit) arr.length = limit;
    return arr;
  }

  /* ------------------------------------------------------------------ search */
  var qSeq = 0;
  function search(o) {
    o = typeof o === 'string' ? { query: o } : (o || {});
    return ready().then(function () {
      var t0 = now(), mode = o.mode || 'sim', limit = Math.max(1, o.limit || o.k || 100), k = classify(o), q = k.q;
      var prog = typeof o.onProgress === 'function' ? o.onProgress : null;
      function aborted() { if (o.signal && o.signal.aborted) throw err('cancelled', 'search cancelled'); }
      function finish(hits, total, stats) {
        hits.total = total; hits.ms = Math.round(now() - t0); hits.mode = mode; hits.truncated = total > hits.length; hits.stats = stats || {}; hits.engine = S.mode;
        if (prog) prog({ mode: mode, phase: 'done', done: S.n, total: S.n, found: total, ms: hits.ms });
        return hits;
      }
      return buildMask(o.filters).then(function (mask) {
        var P = S.pool[0];
        if (mode === 'exact') {
          return P.call('exact', { q: q }).then(function (r) {
            var cand = [], ns = S.col.ns, i;
            for (i = 0; i < S.n; i++) if (ns[i] === r.flatHash && i !== r.c && (!mask || mask[i])) cand.push(i);
            return (cand.length ? P.call('flatMatch', { flat: r.flat, list: cand }) : Promise.resolve([])).then(function (vars) {
              var list = [], extra = {};
              if (r.c >= 0 && (!mask || mask[r.c])) { list.push(r.c); extra[r.c] = 'exact'; }
              vars.forEach(function (c) { list.push(c); extra[c] = 'stereo-variant'; });
              var total = list.length; list = list.slice(0, limit);
              return buildHits(list, list.map(function () { return 1; }), o, extra).then(function (h) { return finish(h, total, { idcode: r.idcode }); });
            });
          });
        }
        if (mode === 'sim') {
          var min = o.minSim === undefined ? 0.5 : o.minSim;
          return P.call('sim', { q: q, min: min, k: o.sort && o.sort !== 'sim' ? S.n : limit, mask: mask }).then(function (r) {
            var arr = rank(r.idx, r.sim, o.sort, limit);
            return buildHits(arr.map(function (x) { return x.c; }), arr.map(function (x) { return x.s; }), o).then(function (h) { return finish(h, r.above, { minSim: min }); });
          });
        }
        if (mode === 'scaffold') {
          return P.call('describe', { q: q }).then(function (d) {
            var si = bsearch(S.scafs, d.scaffold.idcode), list = [];
            if (si >= 0) { var sc = S.col.scaf, lo = 0, hi = S.n; while (lo < hi) { var mid = (lo + hi) >> 1; if (sc[mid] < si) lo = mid + 1; else hi = mid; } for (var i = lo; i < S.n && sc[i] === si; i++) if (!mask || mask[i]) list.push(i); }
            return (list.length ? P.call('simFor', { q: q, list: list }) : Promise.resolve([])).then(function (sims) {
              var arr = rank(list, sims, o.sort, limit);
              return buildHits(arr.map(function (x) { return x.c; }), arr.map(function (x) { return x.s; }), o).then(function (h) { return finish(h, list.length, { scaffold: d.scaffold }); });
            });
          });
        }
        if (mode !== 'sub') throw err('bad_query', 'unknown mode ' + mode);
        // ---- substructure: fingerprint pre-screen + graph match, chunks handed to every worker that is ready ----
        var qid = 'q' + (++qSeq), found = [], tested = 0, done = 0, next = 0, n = S.n, previewed = false, tFirst = null, prepared = [], failed = null;
        var previewN = Math.min(limit, o.previewAt || 20);
        function runOn(w) {
          return w.call('prepare', { qid: qid, q: q, mask: mask }).then(function () {
            prepared.push(w);
            function step() {
              if (failed || next >= n) return null;
              aborted();
              var from = next, to = Math.min(n, from + CHUNK); next = to;
              return w.call('sss', { qid: qid, from: from, to: to, brute: !!o.brute }).then(function (r) {
                for (var i = 0; i < r.hits.length; i++) found.push(r.hits[i]);
                tested += r.tested; done += to - from;
                if (tFirst === null && r.hits.length) tFirst = Math.round(now() - t0);
                var chain = Promise.resolve();
                if (prog) {
                  var ev = { mode: mode, phase: 'scan', done: done, total: n, found: found.length, ms: Math.round(now() - t0) };
                  if (!previewed && (found.length >= previewN || done >= n) && found.length) {
                    previewed = true;
                    var first = found.slice(0, previewN);
                    chain = buildHits(first, null, { maxPatents: o.maxPatents === undefined ? 5 : Math.min(5, o.maxPatents) }).then(function (h) { ev.partial = h; ev.ms = Math.round(now() - t0); prog(ev); }, function () { prog(ev); });
                  } else prog(ev);
                }
                return chain.then(function () { return S.mode === 'main' ? tick() : null; }).then(step);
              });
            }
            return step();
          });
        }
        var started = [], seen = 0;
        function startNew() { while (seen < S.pool.length) started.push(runOn(S.pool[seen++]).catch(function (e) { failed = failed || e; })); }
        startNew();
        var poll = setInterval(startNew, 25); // helpers that finish loading during a scan join it
        function settle() { var cnt = started.length; return Promise.all(started).then(function () { startNew(); return started.length > cnt ? settle() : null; }); }
        return settle().then(function () {
          clearInterval(poll);
          prepared.forEach(function (w) { w.call('release', { qid: qid }).catch(function () {}); });
          if (failed) throw (failed.code ? failed : err('bad_query', 'could not read the structure: ' + failed.message));
          found.sort(function (a, b) { return a - b; });
          if (prog) prog({ mode: mode, phase: 'rank', done: n, total: n, found: found.length, ms: Math.round(now() - t0) });
          var tScan = Math.round(now() - t0);
          return (found.length ? P.call('simFor', { q: q, list: found }) : Promise.resolve([])).then(function (sims) {
            var arr = rank(found, sims, o.sort, limit);
            return buildHits(arr.map(function (x) { return x.c; }), arr.map(function (x) { return x.s; }), o).then(function (h) {
              if (o.all) h.all = Uint32Array.from(found);
              return finish(h, found.length, { tested: tested, screenedOut: n - tested, firstHitMs: tFirst, scanMs: tScan, workers: started.length });
            });
          });
        }, function (e) { clearInterval(poll); throw e; });
      });
    });
  }
  function bsearch(arr, v) { var lo = 0, hi = arr.length - 1; while (lo <= hi) { var mid = (lo + hi) >> 1; if (arr[mid] === v) return mid; if (arr[mid] < v) lo = mid + 1; else hi = mid - 1; } return -1; }

  /* ------------------------------------------------------------------ compound <-> patent */
  var pnIdx = null;
  function pnIndex() { if (!pnIdx) { pnIdx = new Map(); for (var i = 0; i < S.pn.length; i++) pnIdx.set(S.pn[i], i); } return pnIdx; }
  function inverse() {
    if (S.iOff) return;
    var np = S.pn.length, off = new Uint32Array(np + 1), ent = new Uint32Array(S.mEnt.length), c, j;
    for (j = 0; j < S.mEnt.length; j++) off[(S.mEnt[j] >>> 8) + 1]++;
    for (j = 0; j < np; j++) off[j + 1] += off[j];
    var pos = off.slice(0, np);
    for (c = 0; c < S.n; c++) for (j = S.mOff[c]; j < S.mOff[c + 1]; j++) { var e = S.mEnt[j]; ent[pos[e >>> 8]++] = ((c << 8) | (e & 63)) >>> 0; }
    S.iOff = off; S.iEnt = ent;
  }
  function pnOfP(p) {
    if (typeof p === 'string') return Promise.resolve(p.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    var D = g.LnpData;
    if (S.o.pnOf) return Promise.resolve(S.o.pnOf(p));
    if (D && D.patent) return Promise.resolve(D.patent(p)).then(function (x) { return x ? x.pn : null; });
    return Promise.resolve(null);
  }
  function patentsOf(c) { return ready().then(function () { if (!(c >= 0 && c < S.n)) throw err('bad_query', 'unknown compound ' + c); return patentList(c, 0); }); }
  function compoundsOf(p, k) {
    return ready().then(function () { return pnOfP(p); }).then(function (pn) {
      var pi = pn ? pnIndex().get(pn) : undefined; if (pi === undefined) return [];
      inverse();
      var a = [], C = S.col; for (var j = S.iOff[pi]; j < S.iOff[pi + 1]; j++) a.push(S.iEnt[j]);
      // claims first, then drawn structures, then the most specific compounds (found in the fewest publications worldwide)
      a.sort(function (x, y) { return (y & 1) - (x & 1) || ((y & 48) ? 1 : 0) - ((x & 48) ? 1 : 0) || C.nPatG[x >>> 8] - C.nPatG[y >>> 8] || (x >>> 8) - (y >>> 8); });
      var total = a.length; a = a.slice(0, k || 200);
      return S.pool[0].call('info', { list: a.map(function (e) { return e >>> 8; }) }).then(function (info) {
        var out = info.map(function (x, i) { var r = record(x.c); r.smiles = x.smiles; r.idcode = x.idcode; r.formula = x.formula; r.where = whereObj(a[i] & 63); r.whereAll = whereObj(C.wbits[x.c]); return r; });
        out.total = total; return out;
      });
    });
  }
  function compound(c) {
    return ready().then(function () {
      if (typeof c === 'string') c = cOfId(c);
      if (!(c >= 0 && c < S.n)) throw err('bad_query', 'unknown compound');
      return buildHits([c], null, { maxPatents: 0 }).then(function (h) { delete h[0].sim; h[0].scaffoldIdcode = S.scafs[h[0].desc.scaffold]; return h[0]; });
    });
  }
  function byId(id) { return ready().then(function () { return cOfId(id); }); }

  /* ------------------------------------------------------------------ depiction, descriptors, names */
  function svg(x, w, h) {
    var o = (w && typeof w === 'object') ? w : { w: w, h: h };
    return ready().then(function () {
      var k = classify(x), a = { w: o.w || 300, h: o.h || 200, mono: !!o.mono };
      if (k.q.c !== undefined) a.c = k.q.c; else a.q = k.q;
      return S.pool[0].call('svg', a);
    });
  }
  function descriptors(input) {
    return ready().then(function () {
      var k = classify(input);
      return S.pool[0].call('describe', { q: k.q }).then(function (d) {
        d.scaffold.index = bsearch(S.scafs, d.scaffold.idcode); delete d.row;
        if (k.name) d.name = k.name;
        return d;
      });
    });
  }
  function names() { return ready().then(function () { return S.names.map(function (n) { return { name: n.name, synonyms: (n.synonyms || []).slice(), smiles: n.smiles, role: n.role, note: n.note || null, c: n.c, variants: (n.variants || []).slice() }; }); }); }

  /* ------------------------------------------------------------------ editor (main thread, OCL StructureEditor) */
  var edSeq = 0;
  function editor(el, opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return Promise.reject(err('no_dom', 'the editor needs a document'));
    var U = urls((S && S.o) || {});
    return firstThatLoads(U.ocl, function () { return !!g.OCL; }).then(function () {
      if (typeof el === 'string') el = document.getElementById(el);
      if (!el) throw err('bad_query', 'editor element not found');
      if (!el.id) el.id = 'lnp-chem-editor-' + (++edSeq);
      // the editor paints dark strokes on a transparent canvas: give it a light surface in every theme
      if (opts.background !== false) { el.style.backgroundColor = opts.background || '#fff'; el.style.color = '#000'; }
      var ed = g.OCL.StructureEditor.createSVGEditor(el.id, opts.scale || 1), quiet = false;
      function state() { var smi = ''; try { smi = ed.getSmiles(); } catch (e) { smi = ''; } return { smiles: smi, idcode: ed.getIDCode(), molfile: ed.getMolFile(), empty: !smi }; }
      if (opts.fragment) ed.setFragment(true);
      if (opts.molfile) ed.setMolFile(opts.molfile); else if (opts.smiles) ed.setSmiles(opts.smiles);
      if (typeof opts.onChange === 'function') ed.setChangeListenerCallback(function () { if (!quiet) { try { opts.onChange(state()); } catch (e) { /* listener errors stay in the listener */ } } });
      return {
        getSmiles: function () { return state().smiles; },
        getMolfile: function () { return ed.getMolFile(); },
        getIdcode: function () { return ed.getIDCode(); },
        getState: state,
        setSmiles: function (s) { ed.setSmiles(s || ''); },
        setMolfile: function (m) { ed.setMolFile(m); },
        setFragment: function (f) { ed.setFragment(!!f); },
        clear: function () { quiet = true; try { ed.setSmiles(''); } finally { quiet = false; } },
        destroy: function () { quiet = true; while (el.firstChild) el.removeChild(el.firstChild); }
      };
    });
  }

  function reset() { if (S) S.pool.forEach(function (w) { w.close(); }); S = null; starting = null; idMap = null; pnIdx = null; }

  var api = { init: init, parse: parse, search: search, patentsOf: patentsOf, compoundsOf: compoundsOf, compound: compound, byId: byId, svg: svg, descriptors: descriptors, names: names, editor: editor, diag: diag, WHERE: WHERE, _reset: reset };
  if (isNode) module.exports = api; else g.LnpChem = api;
})(typeof self !== 'undefined' ? self : globalThis);
