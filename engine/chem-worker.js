/* chem-worker.js - structure search core of LnpChem (OpenChemLib 8.21.0, pure JS; no wasm, no eval). ASCII only.

   The same file is used three ways:
   - as a dedicated Worker script (new Worker('engine/chem-worker.js')); the first message {op:'boot', urls:[...]}
     tells it which scripts to importScripts (OpenChemLib, chemfp.js);
   - inside a blob: Worker, where OpenChemLib + chemfp.js + this file are concatenated into one script;
   - on the main thread (script tag) or in Node (require): it then only defines LnpChemCore.create(OCL, ChemFP).

   Messages: {id, op, a} -> {id, ok:true, r} | {id, ok:false, error}. Operations are the methods of the core object:
     load({idc, ffp, fp})                       compound shards (inflated): idcodes text bytes, Int32 x16 per compound, count fingerprints
     resolve({smiles|molfile|idcode|smarts|c})  -> {idcode, flat, flatHash, smiles, formula, mw}
     prepare({qid, q, mask})                    substructure query for the following sss calls (mask: Uint8Array, 0 = skip)
     sss({qid, from, to, brute})                -> {hits: Uint32Array, tested}; brute = no fingerprint pre-screen
     release({qid})
     sim({q, min, k, mask})                     -> {idx: Uint32Array, sim: Float32Array, above} best first
     simFor({q, list})                          -> Float32Array, count Tanimoto of q against the listed compounds
     exact({q})                                 -> {c, idcode, flat, flatHash}
     flatMatch({flat, list})                    -> compounds of list whose stereo-free idcode equals flat
     info({list})                               -> [{c, idcode, smiles, formula}]
     svg({c|q, w, h, mono})                     -> svg string, themed with currentColor
     describe({q})                              -> lipid descriptors (ChemFP.describe) + formula, mw, logP, scaffold, smiles, idcode
*/
(function (g) {
  'use strict';

  function create(OCL, FP) {
    var N = 0, IDC = [], FFP = null, OFF = null, PK = null, idMap = null, queries = {};

    function molOf(q, coords) {
      if (q == null) throw new Error('no structure given');
      var m;
      if (q.c !== undefined && q.c !== null) { if (!(q.c >= 0 && q.c < N)) throw new Error('unknown compound ' + q.c); m = OCL.Molecule.fromIDCode(IDC[q.c], !!coords); }
      else if (q.idcode) m = OCL.Molecule.fromIDCode(q.idcode, !!coords);
      else if (q.molfile) m = OCL.Molecule.fromMolfile(q.molfile);
      else if (q.smarts) { m = new OCL.SmilesParser({ smartsMode: 'smarts' }).parseMolecule(q.smarts); }
      else if (q.smiles) m = OCL.Molecule.fromSmiles(q.smiles); // with coordinates: OCL needs them to keep stereo in the idcode
      else throw new Error('no structure given');
      if (!m || m.getAllAtoms() === 0) throw new Error('empty structure');
      return m;
    }
    function formulaOf(m) { var f = m.getMolecularFormula(); return { formula: f.formula, mw: +f.relativeWeight.toFixed(3) }; }

    function load(a) {
      var t = '', u = a.idc instanceof Uint8Array ? a.idc : new Uint8Array(a.idc), CH = 32768;
      for (var i = 0; i < u.length; i += CH) t += String.fromCharCode.apply(null, u.subarray(i, Math.min(u.length, i + CH)));
      IDC = t.length ? t.split('\n') : []; N = IDC.length; idMap = null;
      var fb = a.ffp instanceof ArrayBuffer ? a.ffp : a.ffp.buffer.slice(a.ffp.byteOffset, a.ffp.byteOffset + a.ffp.byteLength);
      FFP = new Int32Array(fb);
      if (FFP.length !== N * 16) throw new Error('ffp size does not match the number of idcodes');
      if (a.fp) {
        var pb = a.fp instanceof ArrayBuffer ? a.fp : a.fp.buffer.slice(a.fp.byteOffset, a.fp.byteOffset + a.fp.byteLength);
        var dv = new DataView(pb), n = dv.getUint32(0, true), tot = dv.getUint32(4, true);
        if (n !== N) throw new Error('fp size does not match the number of idcodes');
        OFF = new Uint32Array(pb, 8, N + 1); PK = new Uint16Array(pb, 8 + (N + 1) * 4, tot);
      }
      return { n: N, ocl: OCL.version, fp: !!PK };
    }

    function resolve(a) {
      var m = molOf(a), f = formulaOf(m), flat = FP.flatIdcode(OCL, m);
      var smiles = ''; try { smiles = m.toIsomericSmiles(); } catch (e) { smiles = ''; }
      return { idcode: m.getIDCode(), flat: flat, flatHash: FP.hashStr(flat), smiles: smiles, formula: f.formula, mw: f.mw, atoms: m.getAllAtoms() };
    }

    function prepare(a) {
      var q = molOf(a.q); q.setFragment(true);
      var s = new OCL.SSSearcher(); s.setFragment(q);
      queries[a.qid] = { s: s, qi: Int32Array.from(q.getIndex()), mask: a.mask || null };
      return { ok: true };
    }
    function release(a) { delete queries[a.qid]; return { ok: true }; }

    function sss(a) {
      var Q = queries[a.qid]; if (!Q) throw new Error('query not prepared');
      var from = a.from || 0, to = Math.min(N, a.to === undefined ? N : a.to), mask = Q.mask, s = Q.s, qi = Q.qi, F = FFP, hits = [], tested = 0;
      var q0 = qi[0], q1 = qi[1], q2 = qi[2], q3 = qi[3], q4 = qi[4], q5 = qi[5], q6 = qi[6], q7 = qi[7], q8 = qi[8], q9 = qi[9], q10 = qi[10], q11 = qi[11], q12 = qi[12], q13 = qi[13], q14 = qi[14], q15 = qi[15];
      for (var i = from; i < to; i++) {
        if (mask && !mask[i]) continue;
        if (!a.brute) {
          var b = i * 16;
          if ((q0 & ~F[b]) | (q1 & ~F[b + 1]) | (q2 & ~F[b + 2]) | (q3 & ~F[b + 3]) | (q4 & ~F[b + 4]) | (q5 & ~F[b + 5]) | (q6 & ~F[b + 6]) | (q7 & ~F[b + 7]) |
              (q8 & ~F[b + 8]) | (q9 & ~F[b + 9]) | (q10 & ~F[b + 10]) | (q11 & ~F[b + 11]) | (q12 & ~F[b + 12]) | (q13 & ~F[b + 13]) | (q14 & ~F[b + 14]) | (q15 & ~F[b + 15])) continue;
        }
        tested++;
        s.setMolecule(OCL.Molecule.fromIDCode(IDC[i], false));
        if (s.isFragmentInMolecule()) hits.push(i);
      }
      return { hits: Uint32Array.from(hits), tested: tested };
    }

    function needFp() { if (!PK) throw new Error('fingerprints not loaded in this worker'); }
    function sim(a) {
      needFp();
      var f = FP.fp(molOf(a.q)).pk, min = a.min || 0, k = a.k || 100, mask = a.mask || null, sc = new Float32Array(N), idx = [], i;
      for (i = 0; i < N; i++) { if (mask && !mask[i]) continue; var v = FP.tanimotoPacked(f, PK, OFF[i], OFF[i + 1] - OFF[i]); if (v >= min) { sc[i] = v; idx.push(i); } }
      idx.sort(function (x, y) { return sc[y] - sc[x] || x - y; });
      var top = idx.slice(0, k), o = new Float32Array(top.length);
      for (i = 0; i < top.length; i++) o[i] = sc[top[i]];
      return { idx: Uint32Array.from(top), sim: o, above: idx.length };
    }
    function simFor(a) {
      needFp();
      var f = FP.fp(molOf(a.q)).pk, list = a.list, o = new Float32Array(list.length);
      for (var i = 0; i < list.length; i++) { var c = list[i]; o[i] = FP.tanimotoPacked(f, PK, OFF[c], OFF[c + 1] - OFF[c]); }
      return o;
    }

    function exact(a) {
      if (!idMap) { idMap = new Map(); for (var i = 0; i < N; i++) idMap.set(IDC[i], i); }
      var m = molOf(a.q), idc = m.getIDCode(), flat = FP.flatIdcode(OCL, m), c = idMap.get(idc);
      return { c: c === undefined ? -1 : c, idcode: idc, flat: flat, flatHash: FP.hashStr(flat) };
    }
    function flatMatch(a) {
      var out = [];
      for (var i = 0; i < a.list.length; i++) { var c = a.list[i]; if (FP.flatIdcode(OCL, OCL.Molecule.fromIDCode(IDC[c], false)) === a.flat) out.push(c); }
      return out;
    }

    function info(a) {
      return Array.prototype.map.call(a.list, function (c) {
        var m = OCL.Molecule.fromIDCode(IDC[c], false), f = m.getMolecularFormula(), smiles = '';
        try { smiles = m.toIsomericSmiles(); } catch (e) { smiles = ''; }
        return { c: c, idcode: IDC[c], smiles: smiles, formula: f.formula };
      });
    }

    // --- depiction: OCL SVG, re-coloured so that it follows the page theme (bonds and carbon labels = currentColor) ---
    function midTone(r, gg, b) {
      // keep the hue of a hetero atom colour but force a lightness that is readable on light and on dark backgrounds
      r /= 255; gg /= 255; b /= 255;
      var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
      if (d > 0) { s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? ((gg - b) / d + (gg < b ? 6 : 0)) : mx === gg ? ((b - r) / d + 2) : ((r - gg) / d + 4); h /= 6; }
      if (s < 0.15) return 'currentColor';
      l = Math.min(0.62, Math.max(0.5, l)); s = Math.min(s, 0.85);
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      function ch(t) { if (t < 0) t += 1; if (t > 1) t -= 1; var v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; v = Math.round(v * 255).toString(16); return v.length < 2 ? '0' + v : v; }
      return '#' + ch(h + 1 / 3) + ch(h) + ch(h - 1 / 3);
    }
    function theme(svg, mono) {
      if (/<script|<foreignObject|\son[a-z]+\s*=|href\s*=|javascript:/i.test(svg)) return '';
      svg = svg.replace(/<style>[\s\S]*?<\/style>\s*/, '');
      svg = svg.replace(/\s*<(?:line|circle|rect)\b[^>]*class="event"[^>]*\/>/g, ''); // invisible hit targets with ids
      svg = svg.replace(/^<svg id="[^"]*"/, '<svg class="lnp-mol" font-family="sans-serif" stroke-linecap="round" stroke-linejoin="round"');
      svg = svg.replace(/(width|height)="(\d+(?:\.\d+)?)px"/g, '$1="$2"');
      return svg.replace(/rgb\((\d+),(\d+),(\d+)\)/g, function (all, r, gg, b) {
        r = +r; gg = +gg; b = +b;
        if (mono || (r === gg && gg === b)) return 'currentColor';
        return midTone(r, gg, b);
      });
    }
    function svg(a) {
      var m = (a.c !== undefined && a.c !== null) ? molOf({ c: a.c }, true) : molOf(a.q, true);
      if (a.q && a.q.smarts) m.inventCoordinates();
      var w = Math.max(40, Math.min(2000, a.w || 300)), h = Math.max(40, Math.min(2000, a.h || 200));
      return theme(m.toSVG(w, h, 'm', { suppressChiralText: true, suppressESR: true, suppressCIPParity: true, noStereoProblem: true }), !!a.mono);
    }

    function describe(a) {
      var m = molOf(a.q), d = FP.describe(m, { OCL: OCL }), f = formulaOf(m), sc = FP.scaffold(OCL, m);
      d.formula = f.formula; d.mw = f.mw;
      try { d.logPest = +new OCL.MoleculeProperties(m).logP.toFixed(2); } catch (e) { d.logPest = null; }
      d.idcode = m.getIDCode(); d.flat = FP.flatIdcode(OCL, m);
      try { d.smiles = m.toIsomericSmiles(); } catch (e2) { d.smiles = ''; }
      d.scaffold = { idcode: sc.idcode, smiles: '', truncatedChains: sc.nTrunc };
      try { d.scaffold.smiles = OCL.Molecule.fromIDCode(sc.idcode, false).toSmiles(); } catch (e3) { d.scaffold.smiles = ''; }
      d.row = FP.row(d);
      return d;
    }

    return { load: load, resolve: resolve, prepare: prepare, release: release, sss: sss, sim: sim, simFor: simFor, exact: exact, flatMatch: flatMatch, info: info, svg: svg, describe: describe, theme: theme, size: function () { return N; } };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  g.LnpChemCore = api;

  var inWorker = typeof WorkerGlobalScope !== 'undefined' && g instanceof WorkerGlobalScope;
  if (!inWorker) return;
  var core = null;
  function transfers(r) {
    var t = [];
    if (r && typeof r === 'object') {
      if (ArrayBuffer.isView(r)) t.push(r.buffer);
      else for (var k in r) if (r[k] && ArrayBuffer.isView(r[k]) && t.indexOf(r[k].buffer) < 0) t.push(r[k].buffer);
    }
    return t;
  }
  g.onmessage = function (e) {
    var m = e.data, r;
    try {
      if (m.op === 'boot') {
        var urls = (m.a && m.a.urls) || [];
        if (!g.OCL) {
          var cands = (m.a && m.a.ocl) || [], ok = false, last = null;
          for (var i = 0; i < cands.length && !ok; i++) { try { importScripts(cands[i]); ok = !!g.OCL; } catch (err) { last = err; } }
          if (!ok) throw new Error('OpenChemLib could not be loaded: ' + (last && last.message || 'no candidate url'));
        }
        if (!g.ChemFP) for (var j = 0; j < urls.length; j++) importScripts(urls[j]);
        if (!g.ChemFP) throw new Error('chemfp.js could not be loaded');
        core = create(g.OCL, g.ChemFP);
        r = { ocl: g.OCL.version, fp: g.ChemFP.VERSION };
      } else {
        if (!core) throw new Error('worker not booted');
        if (typeof core[m.op] !== 'function') throw new Error('unknown op ' + m.op);
        r = core[m.op](m.a || {});
      }
      g.postMessage({ id: m.id, ok: true, r: r }, transfers(r));
    } catch (err2) {
      g.postMessage({ id: m.id, ok: false, error: String(err2 && err2.message || err2).slice(0, 300) });
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
