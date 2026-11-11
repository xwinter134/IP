/* LNP Patent Desk: tags, legal bits and canonical assignees per patent (global LnpTags). Plain script, ASCII only. Also loads in
   Node (module.exports) for tests: LnpTags.init({file: 'tags.gz.bin'}) or init({buffer: <ArrayBuffer of the inflated payload>}).
   Data: xdata "tags" (pipeline/tags_build.py, format tg-1, docs/TOOLS_PLAN.md 2.5, rules data/seed/tag_rules.json, assignee
   aliases data/seed/assignee_aliases.json), read through LnpData.manifest.x.tags. Without it available() is false with the
   reason "not in this build". The tags are set by pattern rules and compound descriptors (code, not a model); they are search
   aids: a route tag means the route is named in the claims / title / abstract, not that it is the only one.
   Indexed by the patent index p of LnpData (row order of the corpus file); info().mismatch says when the dist was built from
   another corpus snapshot than the tags.

   LnpTags.init(opts?)             -> Promise<{available, reason, ...info}>
   LnpTags.available() / reason() / info()        info = {v, built, patents, tags, assignees, counts, mismatch: ''|text}
   LnpTags.list()                  -> [{id, label, title, kind: 'group', tags: [{id, label, group, bit}]}]   (one entry per tag group;
                                      LnpTags.tags() is the flat list of tag definitions, LnpTags.legalList() the legal bits)
   LnpTags.tagsOf(p)               -> [{id, label, group, fromClaims}]
   LnpTags.legalOf(p)              -> [{id, label}]
   LnpTags.assignee(p)             -> canonical assignee name | null (first owner; banks and security agents are never owners)
   LnpTags.ps(key)                 -> Uint32Array of patent indexes (ascending); key = tag id | 'legal:<id>' | 'asg:<slug>'
                                      (slug = lower-case canonical name with runs of non-alphanumerics as '-': stable across rebuilds, unlike the index)
   LnpTags.asgSlug(name)           -> the stable slug of a canonical name
   LnpTags.counts(allPs, opts?)    -> {groupId: [{value, label, n}], legal: [...], asg: [...top N by n]}   (value is the key for ps())
   LnpTags.registerFacets(opts?)   -> number of facets registered with LnpApp.ext.searchFacet (0 when that hook does not exist yet;
                                      it is retried when LnpApp emits 'ready')
   Everything but init() is synchronous once init() has resolved. */
(function (g) {
  'use strict';
  var NONE = 0xffffffff;
  var S = { ready: null, ok: false, reason: 'not in this build', doc: null, W: 1, P: 0, bits: null, from: null, legal: null, asg: null,
            byId: {}, legalById: {}, psCache: {}, info: null, regged: false, loader: null };
  var HERE = '';
  try { if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) HERE = document.currentScript.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); } catch (e) { /* ignore */ }

  function err(m) { return { code: 'tags', message: m }; }

  /* ------------------------------------------------------------------ parse */
  function parse(buf) {
    if (!(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (buf.byteLength < 8) throw err('tags file is too short');
    var dv = new DataView(buf), jl = dv.getUint32(0, true);
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buf, 4, jl));
    var doc = JSON.parse(text);
    if (doc.v !== 'tg-1') throw err('unknown tags format ' + doc.v);
    var P = doc.P, W = doc.W || 1, o = 4 + jl;
    while (o % 4) o++;
    var need = o + 4 * W * P * 2 + P;
    var oAsg = need; while (oAsg % 4) oAsg++;
    if (buf.byteLength < oAsg + 4 * P) throw err('tags file is truncated');
    S.doc = doc; S.W = W; S.P = P;
    S.bits = new Uint32Array(buf, o, W * P);
    S.from = new Uint32Array(buf, o + 4 * W * P, W * P);
    S.legal = new Uint8Array(buf, o + 8 * W * P, P);
    S.asg = new Uint32Array(buf, oAsg, P);
    S.byId = {}; S.legalById = {}; S.psCache = {};
    doc.tags.forEach(function (t) { S.byId[t.id] = t; });
    doc.legal.forEach(function (l) { S.legalById[l.id] = l; });
    S.ok = true; S.reason = '';
  }

  function mismatchText() {
    var D = g.LnpData, man = D && D.manifest, x = man && man.x && man.x.tags;
    if (!x || !S.doc) return '';
    var counts = man.counts || {}, why = [];
    if (counts.patents != null) {
      // a --limit build holds a prefix of the corpus: the tags then cover more patents than the dist, which is fine
      if (man.limit ? counts.patents > S.P : counts.patents !== S.P) why.push('the tags cover ' + S.P + ' patents, the dataset has ' + counts.patents);
    }
    var snap = x.counts && x.counts.snapshot;
    if (snap && man.snapshots && man.snapshots.corpus && snap !== man.snapshots.corpus) why.push('the corpus snapshot differs');
    return why.length ? 'Tags were built from another corpus snapshot (' + why.join('; ') + '); rebuild with pipeline/run_all.sh.' : '';
  }

  function status() {
    var D = g.LnpData, man = D && D.manifest, x = man && man.x && man.x.tags;
    S.info = S.ok ? { available: true, reason: '', v: S.doc.v, built: x && x.built || null, patents: S.P, tags: S.doc.tags.length, assignees: S.doc.asg.length,
                      counts: x && x.counts || null, mismatch: mismatchText() } : { available: false, reason: S.reason };
    return S.info;
  }

  function init(o) {
    o = o || {};
    if (S.ready && !o.force) return S.ready;
    S.ready = (function () {
      try {
        if (o.buffer) { parse(o.buffer); return Promise.resolve(status()); }
        if (o.file && typeof require === 'function') {
          var fs = require('fs'), zlib = require('zlib'), b = fs.readFileSync(o.file);
          var raw = (b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b) : b;
          parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
          return Promise.resolve(status());
        }
      } catch (e) { S.ok = false; S.reason = 'could not be read: ' + (e && e.message); return Promise.resolve(status()); }
      var D = g.LnpData, man = D && D.manifest, x = man && man.x && man.x.tags;
      if (!x) { S.reason = 'not in this build'; return Promise.resolve(status()); }
      if (!g.LnpLoader) { S.reason = 'loader missing'; return Promise.resolve(status()); }
      var L = g.LnpLoader.create({ base: D.base() + 'x/tags/', enc: man.enc || 'auto',
                                   vendorUrl: new URL('../vendor/fflate.js', HERE || (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')).href });
      S.loader = L;
      return L.get('tags.gz.bin', { as: 'bin' }).then(function (buf) { parse(buf); return status(); },
        function (e) { S.ok = false; S.reason = 'could not be loaded: ' + (e && e.message || e); return status(); });
    })().then(function (inf) { if (!S.ok) S.ready = null; return inf; });
    return S.ready;
  }

  function available() { return S.ok; }
  function reason() { return S.ok ? '' : S.reason; }
  function info() { return S.info || status(); }

  /* ------------------------------------------------------------------ definitions */
  function tags() { return S.ok ? S.doc.tags.map(function (t) { return { id: t.id, label: t.label, group: t.group, bit: t.bit }; }) : []; }
  function legalList() { return S.ok ? S.doc.legal.map(function (l) { return { id: l.id, label: l.label, bit: l.bit }; }) : []; }
  function groups() { return S.ok ? S.doc.groups.slice() : []; }
  function list() {
    if (!S.ok) return [];
    return S.doc.groups.map(function (gr) {
      return { id: gr.id, label: gr.label, title: gr.label, kind: 'group', tags: tags().filter(function (t) { return t.group === gr.id; }) };
    });
  }

  /* ------------------------------------------------------------------ per patent */
  function tagsOf(p) {
    if (!S.ok || p == null || p < 0 || p >= S.P) return [];
    var out = [], W = S.W, P = S.P, t, i, w, m;
    for (i = 0; i < S.doc.tags.length; i++) {
      t = S.doc.tags[i]; w = t.bit >> 5; m = 1 << (t.bit & 31);
      if (S.bits[w * P + p] & m) out.push({ id: t.id, label: t.label, group: t.group, fromClaims: !!(S.from[w * P + p] & m) });
    }
    return out;
  }
  function legalOf(p) {
    if (!S.ok || p == null || p < 0 || p >= S.P) return [];
    var b = S.legal[p], out = [];
    if (!b) return out;
    S.doc.legal.forEach(function (l) { if (b >> l.bit & 1) out.push({ id: l.id, label: l.label }); });
    return out;
  }
  function asgSlug(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function asgIndexes(slug) {
    if (!S.asgBySlug) {
      S.asgBySlug = {};
      S.doc.asg.forEach(function (nm, i) { var k = asgSlug(nm); (S.asgBySlug[k] = S.asgBySlug[k] || []).push(i); });
    }
    return S.asgBySlug[slug] || [];
  }
  function assignee(p) {
    if (!S.ok || p == null || p < 0 || p >= S.P) return null;
    var a = S.asg[p];
    return a === NONE ? null : (S.doc.asg[a] || null);
  }

  /* ------------------------------------------------------------------ sets */
  function ps(key) {
    if (!S.ok) return new Uint32Array(0);
    key = String(key);
    var hit = S.psCache[key];
    if (hit) return hit;
    var P = S.P, out = [], p, k;
    if (key.indexOf('legal:') === 0) {
      var l = S.legalById[key.slice(6)];
      if (l) { var m = 1 << l.bit; for (p = 0; p < P; p++) if (S.legal[p] & m) out.push(p); }
    } else if (key.indexOf('asg:') === 0) {
      var ix = asgIndexes(key.slice(4));
      if (ix.length) for (p = 0; p < P; p++) if (S.asg[p] !== NONE && ix.indexOf(S.asg[p]) >= 0) out.push(p);
    } else {
      var t = S.byId[key];
      if (t) { var w = t.bit >> 5, mm = 1 << (t.bit & 31), base = w * P; for (p = 0; p < P; p++) if (S.bits[base + p] & mm) out.push(p); }
    }
    var arr = Uint32Array.from(out);
    var keys = Object.keys(S.psCache);
    if (keys.length > 80) delete S.psCache[keys[0]];
    S.psCache[key] = arr;
    return arr;
  }

  function counts(allPs, o) {
    o = o || {};
    var res = {};
    if (!S.ok) return res;
    var P = S.P, nT = S.doc.tags.length, i, j, p, c;
    var tc = new Uint32Array(nT), lc = new Uint32Array(8), asgN = new Map();
    var n = allPs ? allPs.length : P;
    var w = new Array(nT), mk = new Array(nT);
    for (i = 0; i < nT; i++) { w[i] = (S.doc.tags[i].bit >> 5) * P; mk[i] = 1 << (S.doc.tags[i].bit & 31); }
    for (j = 0; j < n; j++) {
      p = allPs ? allPs[j] : j;
      if (p >= P) continue;
      for (i = 0; i < nT; i++) if (S.bits[w[i] + p] & mk[i]) tc[i]++;
      c = S.legal[p];
      if (c) for (i = 0; i < 8; i++) if (c >> i & 1) lc[i]++;
      c = S.asg[p];
      if (c !== NONE) asgN.set(c, (asgN.get(c) || 0) + 1);
    }
    S.doc.groups.forEach(function (gr) {
      var rows = [];
      S.doc.tags.forEach(function (t, ti) { if (t.group === gr.id && tc[ti]) rows.push({ value: t.id, label: t.label, n: tc[ti] }); });
      rows.sort(function (a, b) { return b.n - a.n; });
      res[gr.id] = rows;
    });
    res.legal = S.doc.legal.filter(function (l) { return lc[l.bit]; }).map(function (l) { return { value: 'legal:' + l.id, label: l.label, n: lc[l.bit] }; })
      .sort(function (a, b) { return b.n - a.n; });
    var bySlug = {};
    asgN.forEach(function (c, ix) {
      var nm = S.doc.asg[ix], k = asgSlug(nm), r = bySlug[k];
      if (r) r.n += c; else bySlug[k] = { value: 'asg:' + k, label: nm, n: c };
    });
    res.asg = Object.keys(bySlug).map(function (k) { return bySlug[k]; })
      .sort(function (a, b) { return (b.n - a.n) || (a.label < b.label ? -1 : 1); }).slice(0, o.top || 30);
    return res;
  }

  /* ------------------------------------------------------------------ search facets (hook of the shell, optional) */
  function registerFacets(o) {
    o = o || {};
    var App = g.LnpApp;
    if (!S.ok || !App || !App.ext || typeof App.ext.searchFacet !== 'function') return 0;
    var cache = new WeakMap();
    function countsFor(all) {
      var hit = all && typeof all === 'object' ? cache.get(all) : null;
      if (hit) return hit;
      var r = counts(all);
      if (all && typeof all === 'object') cache.set(all, r);
      return r;
    }
    var specs = S.doc.groups.map(function (gr) { return { id: gr.id.replace(/[^A-Za-z]/g, ''), title: gr.label, key: gr.id }; });
    if (o.legal !== false) specs.push({ id: 'legal', title: 'Legal events', key: 'legal' });
    specs.push({ id: 'assignee', title: 'Assignee (normalised)', key: 'asg' });
    var n = 0, stale = mismatchText();
    specs.forEach(function (sp, i) {
      if (!/^[A-Za-z]+$/.test(sp.id)) return;
      App.ext.searchFacet({
        id: sp.id, title: sp.title + (stale ? ' (stale snapshot)' : ''), note: stale || undefined, order: 100 + i,
        counts: function (all) { return Promise.resolve((countsFor(all) || {})[sp.key] || []); },
        ps: function (value) { return Promise.resolve(ps(value)); }
      });
      n++;
    });
    S.regged = n > 0;
    return n;
  }

  function autoRegister() {
    if (S.regged) return;
    if (g.LnpApp && g.LnpApp.ext && typeof g.LnpApp.ext.searchFacet === 'function') {
      init().then(function () { if (!S.regged) registerFacets(); });
    }
  }
  var T = { init: init, available: available, reason: reason, info: info, list: list, tags: tags, groups: groups, legalList: legalList, tagsOf: tagsOf,
            legalOf: legalOf, assignee: assignee, asgSlug: asgSlug, ps: ps, counts: counts, registerFacets: registerFacets, _reset: function () { S.ready = null; S.ok = false; S.regged = false; S.psCache = {}; S.asgBySlug = null; } };
  g.LnpTags = T;
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
  // the hook may be defined now or later: try at load time and again when the app is ready
  try {
    autoRegister();
    if (!S.regged && g.LnpApp && typeof g.LnpApp.on === 'function') g.LnpApp.on('ready', function () { autoRegister(); });
  } catch (e) { /* the facets are optional */ }
})(typeof window !== 'undefined' ? window : globalThis);
