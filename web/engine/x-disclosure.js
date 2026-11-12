/* LNP Patent Desk: earliest disclosure timeline and chemistry white-space grid (global LnpDisclosure).
   Plain ASCII script, no eval, no network of its own beyond the chemistry files of the dataset.
   Code decides everything, no model is involved. Both functions only count what the structure extraction of the dataset
   (SureChEMBL) found in the publications of this corpus. They indicate; they do not assess novelty, validity or scope.

   API
     timeline(query, {mode: 'exact'|'exact+stereo'|'sim', minSim = 0.9, limit = 300, signal})
        query = SMILES, reference lipid name, SCHEMBL number, compound index c, or {smiles|molfile|idcode|c}
        -> Promise<{query, mode, minSim, compounds[{c, id, smiles, match, sim, nPat, nFam, nClaims}], compoundsTotal, truncated,
                    entries[{p, pn, auth, kind, title, pub, prio, app, family, where{clm,desc,abs,ttl,img,mol}, inClaims, status, exp, player, cs[]}],
                    families[{fam, earliestPrio, earliestPub, members[], inClaimsAny, statusSummary{text, counts}, inForce, player, size, sizeInTable}],
                    earliest{publication, priority, claims, description: {pn, date, prio, p} | null}, snapshot, ms, limits[]}>
        Dates are ISO strings ("2016-10-26") or "". Entries sorted by publication date, families by earliest priority.
        Built from LnpChem.search + LnpChem.patentsOf (publications per compound, where-found flags) and LnpData.patents
        (dates, status, family).
     toCsv(result, {sep = ';', kind = 'entries'|'families'}) -> text, formula injection neutralised
     grid({x, y, filters, ps})   x, y = axis id (see axes()); filters as LnpChem.search filters plus any descriptor column
        -> Promise<{x, y, xs[], ys[], xKeys[], yKeys[], cells[yi][xi]{nCompounds, nPatents, nFamilies, nInClaims, nPatentsInClaims, cs[] (capped), pi (chemistry-set
                    publication indexes, internal), ps (filled by cellDetail)}, totals{...}, max{...}, n, matched, snapshot, ms, cached, limits[]}>
        Computed from the descriptor columns of the chemistry set (data/chem/desc.gz.bin, columns named in chem.json) and its
        compound -> publication map (map.gz.bin, pat.gz.bin): LnpChem does not expose its raw columns, so this engine reads the same
        three files itself through LnpLoader (about 4 MB gzip, fetched once). Result is cached per axes + filters.
     axes() -> [{id, label, hint}];  categories(id) -> Promise<{keys[], labels[]}> (menus)
     cellDetail(gridResult, xi, yi, {compounds = 60, patents = 100}) -> Promise<{compounds[LnpChem hit], nCompounds, patents[{p, pn, fam, inClaims, pub, prio, status}], nPatents, truncated}>
     configure({chem, data, kit, columns: {man, desc, map, pat}}) for tests (Node reads the files of data/work/chem).
     limits() -> text[]  */
(function (g) {
  'use strict';
  var HERE = '';
  try { if (document.currentScript && document.currentScript.src) HERE = document.currentScript.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''); } catch (e) { /* ignore */ }
  var S = { cfg: {}, cols: null, colsP: null, grids: [], axisCache: {} };

  function eng(name) { return S.cfg[name] || g['Lnp' + name.charAt(0).toUpperCase() + name.slice(1)] || null; }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function str(x) { return x == null ? '' : String(x); }
  function iso(n) { var s = String(n || '').replace(/-/g, ''); return /^\d{8}/.test(s) && s.slice(0, 8) !== '00000000' ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : ''; }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }

  var LIMITS_TIMELINE = [
    'Only publications in this LNP corpus (SureChEMBL extraction) are covered; journals, conference papers, products and other prior art are not.',
    'Where-found flags (claims, description, abstract, title, image, molfile) are machine extraction and can be wrong or incomplete.',
    'The earliest priority date is not the effective date of a disclosure in every jurisdiction, and a priority claim can be invalid or only partly supported. Check the documents.',
    'A structure that is only covered by a generic (Markush) formula is not found by a structure search, so a missing hit does not mean that nothing was disclosed.',
    'The result indicates where a structure appears first in this corpus. It does not assess novelty, inventive step or validity.'
  ];
  var LIMITS_GRID = [
    'Density of extracted compounds, not of claim scope: a cell counts structures that a publication discloses individually (SureChEMBL extraction).',
    'Markush scope is not counted: an empty cell may still lie inside a generic claim, and a full cell may be free of claims. White space here is not freedom to operate.',
    'Descriptors (head group, tails, linker, amine) are computed from the structure; unusual structures can be classed as "other" or "none".',
    'Corpus snapshot only; compounds from journals, products and later filings are not included.'
  ];

  /* ------------------------------------------------------------------------------------------ timeline */
  var MODES = ['exact', 'exact+stereo', 'sim'];
  function normMode(m) { m = str(m).toLowerCase().replace(/[\s_]/g, ''); if (m === 'stereo' || m === 'exactstereo') return 'exact+stereo'; return MODES.indexOf(m) >= 0 ? m : 'exact+stereo'; }
  function whereMerge(a, b) { var o = {}; ['clm', 'desc', 'abs', 'ttl', 'img', 'mol'].forEach(function (k) { o[k] = !!((a && a[k]) || (b && b[k])); }); return o; }
  function inForce(pt, today) { return !!pt && pt.status === 'granted' && (!pt.exp || pt.exp >= today); }
  function todayInt() { var t = new Date(); return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate(); }
  function lt(a, b) { return a && (!b || a < b); }     // ISO strings compare as text; "" = unknown

  function searchFor(query, mode, minSim, limit, signal) {
    var Ch = eng('chem'), o = { mode: mode === 'sim' ? 'sim' : 'exact', limit: limit, maxPatents: 0, signal: signal };
    if (mode === 'sim') o.minSim = minSim;
    if (query && typeof query === 'object') Object.keys(query).forEach(function (k) { o[k] = query[k]; });
    else if (typeof query === 'number') o.c = query;
    else o.query = str(query).trim();
    return Ch.search(o);
  }

  function timeline(query, opts) {
    opts = opts || {};
    var Ch = eng('chem'), D = eng('data'), t0 = now(), mode = normMode(opts.mode), minSim = opts.minSim > 0 && opts.minSim <= 1 ? +opts.minSim : 0.9, limit = Math.max(1, Math.min(1000, opts.limit || 300));
    if (!Ch || !D) return Promise.reject(err('no_engine', 'The chemistry and patent data engines are not available.'));
    if (query == null || query === '' ) return Promise.reject(err('bad_query', 'Enter a structure (SMILES), a reference lipid name or a SCHEMBL number.'));
    var q0 = typeof query === 'object' ? (query.query || query.smiles || (query.c != null ? query.c : '')) : query;
    return Ch.parse(query).then(function (pr) {
      if (!pr || !pr.ok) throw err('bad_query', (pr && pr.error) || 'The structure could not be read.');
      return searchFor(query, mode, minSim, limit, opts.signal).then(function (hits) {
        var list = hits.filter(function (h) { return mode === 'exact' ? h.match === 'exact' : true; });
        var total = mode === 'exact' ? list.length : hits.total;
        var truncated = mode === 'exact' ? false : !!hits.truncated;
        return Promise.all(list.map(function (h) { return Ch.patentsOf(h.c); })).then(function (lists) {
          return build(pr, q0, mode, minSim, list, lists, total, truncated, t0, opts);
        });
      });
    });
  }

  function build(pr, q0, mode, minSim, hits, lists, total, truncated, t0, opts) {
    var D = eng('data'), byP = new Map(), loose = new Map(), i, j;
    // one entry per publication; where flags merge over the compounds
    for (i = 0; i < hits.length; i++) {
      for (j = 0; j < lists[i].length; j++) {
        var x = lists[i][j], key = x.p >= 0 ? 'p' + x.p : 'n' + x.pn, e = byP.get(key);
        if (!e) { e = { p: x.p, pn: x.pn, fam0: x.fam, where: whereMerge(null, x.where), cs: [hits[i].c] }; byP.set(key, e); }
        else { e.where = whereMerge(e.where, x.where); if (e.cs.indexOf(hits[i].c) < 0) e.cs.push(hits[i].c); }
      }
    }
    var raw = Array.from(byP.values()), ps = raw.filter(function (e) { return e.p >= 0; }).map(function (e) { return e.p; });
    return D.patents(ps).then(function (pts) {
      var pm = new Map(); pts.forEach(function (pt) { if (pt) pm.set(pt.p, pt); });
      var today = todayInt(), unresolved = 0;
      var entries = raw.map(function (e) {
        var pt = e.p >= 0 ? pm.get(e.p) : null;
        if (!pt) unresolved++;
        return { p: e.p, pn: e.pn, auth: pt ? pt.auth : e.pn.slice(0, 2), kind: pt ? pt.kind : '', title: pt ? pt.title : '', pub: pt ? iso(pt.pub) : '', prio: pt ? iso(pt.prio || pt.app) : '', app: pt ? iso(pt.app) : '',
          family: pt && pt.fam != null ? pt.fam : e.fam0, where: e.where, inClaims: !!e.where.clm, status: pt ? str(pt.status) : '', exp: pt ? iso(pt.exp) : '', player: pt ? str(pt.player) : '', cs: e.cs.slice().sort(function (a, b) { return a - b; }), _inForce: inForce(pt, today) };
      });
      entries.sort(function (a, b) { return (a.pub || '9999').localeCompare(b.pub || '9999') || a.pn.localeCompare(b.pn); });
      // families
      var fm = new Map();
      entries.forEach(function (e) {
        var f = fm.get(e.family);
        if (!f) { f = { fam: e.family, earliestPrio: '', earliestPub: '', earliestKey: '', priorityKnown: false, members: [], inClaimsAny: false, statusSummary: { text: '', counts: {} }, inForce: false, player: '', size: 0, sizeInTable: 0, synthetic: e.family != null && e.family < 0 }; fm.set(e.family, f); }
        f.members.push(e);
        if (lt(e.prio, f.earliestPrio)) f.earliestPrio = e.prio;
        if (lt(e.pub, f.earliestPub)) f.earliestPub = e.pub;
        if (e.inClaims) f.inClaimsAny = true;
        var st = e.status || 'unknown'; f.statusSummary.counts[st] = (f.statusSummary.counts[st] || 0) + 1;
        if (e._inForce) f.inForce = true;
        if (!f.player && e.player) f.player = e.player;
      });
      var families = Array.from(fm.values());
      families.forEach(function (f) { f.earliestKey = lt(f.earliestPrio, f.earliestPub) || !f.earliestPub ? f.earliestPrio : f.earliestPub; f.priorityKnown = !!f.earliestPrio; f.statusSummary.text = Object.keys(f.statusSummary.counts).map(function (k) { return k + ' ' + f.statusSummary.counts[k]; }).join(', '); f.sizeInTable = f.members.length; });
      families.sort(function (a, b) { return (a.earliestKey || '9999').localeCompare(b.earliestKey || '9999') || (a.earliestPub || '9999').localeCompare(b.earliestPub || '9999') || String(a.fam).localeCompare(String(b.fam)); });
      entries.forEach(function (e) { delete e._inForce; });
      // family sizes in the whole table (how many publications of the family carry the compound is sizeInTable / size)
      return Promise.all(families.map(function (f) {
        var first = f.members.filter(function (e) { return e.p >= 0; })[0];
        if (!first) return 0;
        return Promise.resolve(D.family(first.p)).then(function (a) { return a ? a.length : 0; }, function () { return 0; });
      })).then(function (sizes) {
        families.forEach(function (f, k) { f.size = sizes[k] || f.members.length; });
        var earliest = { publication: null, priority: null, claims: null, description: null };
        function pick(cur, e, field, extra) { var d = e[field]; if (!d) return cur; if (!cur || d < cur.date || (d === cur.date && e.pub < cur._pub)) return { pn: e.pn, date: d, prio: e.prio, pub: e.pub, p: e.p, _pub: e.pub }; return cur; }
        entries.forEach(function (e) {
          earliest.publication = pick(earliest.publication, e, 'pub');
          earliest.priority = pick(earliest.priority, e, 'prio');
          if (e.where.clm) earliest.claims = pick(earliest.claims, e, 'pub');
          if (e.where.desc || e.where.abs || e.where.ttl || e.where.img || e.where.mol) earliest.description = pick(earliest.description, e, 'pub');
        });
        Object.keys(earliest).forEach(function (k) { if (earliest[k]) delete earliest[k]._pub; });
        var noPrioE = entries.filter(function (e) { return !e.prio; }).length, noPrioF = families.filter(function (f) { return !f.earliestPrio; }).length;
        var prioIncomplete = !!(earliest.publication && (!earliest.priority || earliest.publication.date < earliest.priority.date));
        var priorityMissing = { entries: noPrioE, families: noPrioF, entriesTotal: entries.length, familiesTotal: families.length, incomplete: prioIncomplete };
        var limits = LIMITS_TIMELINE.slice(), man = D.manifest || {}, snap = man.snapshots || {};
        if (mode === 'sim') limits.unshift('Similarity mode lists compounds with a count-fingerprint Tanimoto of at least ' + minSim.toFixed(2) + ' to the query; they are different structures, not the same compound.');
        else if (mode === 'exact+stereo') limits.unshift('Same connectivity: stereo variants (other or missing E/Z and R/S) of the query are included because SureChEMBL splits one lipid over several entries.');
        else limits.unshift('Exact structure only; stereo variants of the query are not included.');
        if (truncated) limits.push('Only the first ' + hits.length + ' of ' + total + ' matching compounds were used.');
        if (noPrioE) limits.push(noPrioE + ' of ' + entries.length + ' publications (' + plural(noPrioF, 'family', 'families') + ' of ' + families.length + ' without any dated member) carry no priority date in the patent table; the earliest priority shown is the earliest among the dated ones, and families are ordered by the earlier of priority and publication date.');
        if (prioIncomplete) limits.push('Priority incomplete: the earliest publication (' + earliest.publication.date + ') is earlier than the earliest known priority date' + (earliest.priority ? ' (' + earliest.priority.date + ')' : '') + '. The true earliest priority is not in the table and is at the latest the earliest publication date.');
        if (unresolved) limits.push(plural(unresolved, 'publication', 'publications') + ' of the chemistry set could not be matched to the patent table and carry no dates or status.');
        if (snap.surechembl) limits.push('Structure extraction snapshot: ' + snap.surechembl + (snap.ep_register ? '; EP legal status of ' + snap.ep_register : '') + '. Status can be out of date.');
        var compounds = hits.map(function (h) { return { c: h.c, id: h.id, smiles: h.smiles, match: h.match || (mode === 'sim' ? 'similar' : 'exact'), sim: h.sim, nPat: h.nPat, nFam: h.nFam, nClaims: h.nClaims, inClaims: h.inClaims, mw: h.mw }; });
        if (!compounds.length) limits.unshift(mode === 'sim' ? 'No compound of the corpus reaches the similarity threshold.' : 'This exact structure is not in the structure data of the corpus.');
        return { query: str(q0), parsed: { kind: pr.kind, smiles: pr.smiles, formula: pr.formula, mw: pr.mw, c: pr.c, id: pr.id }, mode: mode, minSim: minSim, compounds: compounds, compoundsTotal: total, truncated: truncated,
          entries: entries, families: families, earliest: earliest, priorityMissing: priorityMissing, snapshot: { surechembl: snap.surechembl || null, ep_register: snap.ep_register || null, built: man.built || null }, ms: Math.round(now() - t0), limits: limits };
      });
    });
  }

  /* ------------------------------------------------------------------------------------------ CSV */
  function csvCell(v, sep) {
    // same rule as the other exporters: C0 controls become spaces, and a formula start after optional whitespace is neutralised
    v = v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    if (/^[\t\r ]*[=+\-@]/.test(v) || /^[\t\r]/.test(v)) v = "'" + v;
    return (v.indexOf(sep) >= 0 || /["\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toCsv(res, o) {
    o = o || {};
    var sep = o.sep || ';', kind = o.kind || 'entries', rows = [], famOf = new Map();
    (res.families || []).forEach(function (f, k) { famOf.set(f.fam, f); f._k = k + 1; });
    if (kind === 'families') {
      rows.push(['family', 'earliest_priority', 'earliest_publication', 'publications_with_compound', 'publications_in_family', 'in_claims', 'status', 'in_force', 'player', 'publications']);
      (res.families || []).forEach(function (f) { rows.push([f.fam, f.earliestPrio, f.earliestPub, f.sizeInTable, f.size, f.inClaimsAny ? 'yes' : 'no', f.statusSummary.text, f.inForce ? 'yes' : 'no', f.player, f.members.map(function (e) { return e.pn; }).join(' ')]); });
    } else {
      rows.push(['publication', 'family', 'priority_date', 'publication_date', 'application_date', 'in_claims', 'in_description', 'in_abstract', 'in_title', 'in_image', 'status', 'expiry_estimate', 'player', 'compounds', 'title']);
      (res.entries || []).forEach(function (e) { rows.push([e.pn, e.family, e.prio, e.pub, e.app, e.where.clm ? 'yes' : 'no', e.where.desc ? 'yes' : 'no', e.where.abs ? 'yes' : 'no', e.where.ttl ? 'yes' : 'no', e.where.img ? 'yes' : 'no', e.status, e.exp, e.player, (e.cs || []).length, e.title]); });
    }
    var head = ['# query: ' + str(res.query), '# mode: ' + res.mode, '# earliest publication: ' + (res.earliest && res.earliest.publication ? res.earliest.publication.date + ' ' + res.earliest.publication.pn : ''), '# limits: ' + (res.limits || []).join(' | ')];
    return '﻿' + head.map(function (l) { return csvCell(l, sep); }).join('\r\n') + '\r\n' + rows.map(function (r) { return r.map(function (c) { return csvCell(c, sep); }).join(sep); }).join('\r\n');
  }

  /* ------------------------------------------------------------------------------------------ chemistry columns */
  var TA = { u8: 'Uint8Array', u16: 'Uint16Array', i16: 'Int16Array', u32: 'Uint32Array', f32: 'Float32Array' };
  function readColumns(man, descBuf, mapBuf, pat) {
    var col = {}, n = man.n;
    man.cols.forEach(function (c) { col[c.name] = new g[TA[c.type]](descBuf, c.off, n); });
    var dv = new DataView(mapBuf), ne = dv.getUint32(4, true);
    return { man: man, n: n, col: col, mOff: new Uint32Array(mapBuf, 8, n + 1), mEnt: new Uint32Array(mapBuf, 8 + (n + 1) * 4, ne), pn: pat.pn, fam: pat.fam, heads: man.heads || [] };
  }
  function ab(x) { if (x instanceof ArrayBuffer) return x; return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength); }
  function loadColumns() {
    if (S.cols) return Promise.resolve(S.cols);
    if (S.colsP) return S.colsP;
    var inj = S.cfg.columns;
    if (inj) { S.cols = readColumns(inj.man, ab(inj.desc), ab(inj.map), inj.pat); return Promise.resolve(S.cols); }
    var D = eng('data'), man = D && D.manifest;
    if (!man || man.chem === null || !man.chem) return Promise.reject(err('no_chem', 'This build contains no structure data.'));
    if (!g.LnpLoader) return Promise.reject(err('no_engine', 'The data loader is not available.'));
    var here = HERE;
    var base = D.base() + (man.chem.dir || 'chem/'), L = g.LnpLoader.create({ base: base, enc: man.enc || 'auto', vendorUrl: new URL('../vendor/fflate.js', here || document.baseURI).href });
    var chemP = fetch(base + 'chem.json').then(function (r) { if (!r.ok) throw err('http', 'chem.json: HTTP ' + r.status); return r.json(); });
    S.colsP = Promise.all([chemP, L.get('desc.gz.bin', { as: 'bin' }), L.get('map.gz.bin', { as: 'bin' }), L.get('pat.gz.bin', { as: 'json' })]).then(function (r) {
      S.cols = readColumns(r[0], ab(r[1]), ab(r[2]), r[3]); return S.cols;
    });
    S.colsP.catch(function () { S.colsP = null; });
    return S.colsP;
  }

  /* ------------------------------------------------------------------------------------------ axes */
  var LINKERS = ['ester', 'carbonate', 'carbamate', 'amide', 'urea', 'thioester', 'disulfide', 'ketal', 'phosphate', 'thioether', 'ether'];
  var AMINES = [['tertiary', 'nTert'], ['quaternary', 'nQuat'], ['secondary', 'nSec'], ['primary', 'nPrim'], ['amide', 'nAmideN']];
  var AXES = [
    { id: 'head', label: 'Head group', hint: 'Class of the polar head group (from the structure)' },
    { id: 'tailC', label: 'Longest tail (C atoms)', hint: 'Carbon atoms of the longest hydrocarbon tail (C6 or more), binned' },
    { id: 'tailTotal', label: 'Total tail carbons', hint: 'Sum of carbon atoms over all tails, binned' },
    { id: 'nTails', label: 'Number of tails', hint: 'Hydrocarbon groups of 6 or more carbons' },
    { id: 'linker', label: 'Dominant linker', hint: 'Linker type with the highest count in the structure' },
    { id: 'amine', label: 'Amine class', hint: 'Amine class with the highest count' },
    { id: 'unsat', label: 'Tail unsaturation', hint: 'Double bonds in all tails together' },
    { id: 'branched', label: 'Branched tails', hint: 'Number of branched tails' }
  ];
  function axisDef(id) { for (var i = 0; i < AXES.length; i++) if (AXES[i].id === id) return AXES[i]; return null; }
  function labelHead(k) { var K = eng('kit'); return K && K.headLabel ? K.headLabel(k) : k; }
  function labelAmine(k) { var K = eng('kit'); return K && K.AMINE && K.AMINE[k] ? K.AMINE[k] : k; }
  var BINS_TAIL = [[1, 5, 'none (< C6)'], [6, 8, 'C6-C8'], [9, 10, 'C9-C10'], [11, 12, 'C11-C12'], [13, 14, 'C13-C14'], [15, 16, 'C15-C16'], [17, 18, 'C17-C18'], [19, 20, 'C19-C20'], [21, 24, 'C21-C24'], [25, 999, 'C25+']];
  var BINS_TOTAL = [[0, 0, 'none'], [1, 16, 'up to C16'], [17, 24, 'C17-C24'], [25, 32, 'C25-C32'], [33, 40, 'C33-C40'], [41, 48, 'C41-C48'], [49, 64, 'C49-C64'], [65, 999, 'C65+']];
  function binIdx(bins, v) { for (var i = 0; i < bins.length; i++) if (v >= bins[i][0] && v <= bins[i][1]) return i; return bins.length - 1; }
  function capLabel(v, cap, zero) { return v === 0 && zero ? zero : (v >= cap ? cap + '+' : String(v)); }
  function longest(C, c) { var m = 0; for (var k = 0; k < 6; k++) { var v = C['t' + k] ? C['t' + k][c] : 0; if (v > m) m = v; } return m; }

  // labels that depend on the kit are mapped on every call (the kit may load after the first call); the cache holds keys and idx only
  var labelFns = { head: function (k) { return labelHead(k); }, amine: function (k) { return k === 'none' ? 'no amine' : labelAmine(k); } };
  function withLabels(v) { var fn = labelFns[v.id]; return { labels: fn ? v.keys.map(fn) : v._lab.slice(), keys: v.keys, idx: v.idx }; }
  // -> {labels[], keys[], idx: Int16Array(n)}; the category list is fixed by the data of the whole set, not by the filter
  function axis(id, X) {
    var key = id; if (S.axisCache[key] && S.axisCache[key].src === X) return withLabels(S.axisCache[key].val);
    var C = X.col, n = X.n, idx = new Int16Array(n), labels = [], keys = [], i, c;
    function fromValues(fn, order, labelFn, keepAll) {        // categorical: values from fn(c) in the given order; only present ones unless keepAll
      var seen = {};
      for (c = 0; c < n; c++) seen[fn(c)] = (seen[fn(c)] || 0) + 1;
      var present = order.filter(function (k) { return keepAll || seen[k]; });
      Object.keys(seen).forEach(function (k) { if (present.indexOf(k) < 0) present.push(k); });
      var pos = {}; present.forEach(function (k, j) { pos[k] = j; labels.push(labelFn ? labelFn(k) : k); keys.push(k); });
      for (c = 0; c < n; c++) idx[c] = pos[fn(c)];
    }
    if (id === 'head') fromValues(function (c) { return X.heads[C.head[c]] || 'none'; }, X.heads, labelHead);
    else if (id === 'tailC') { BINS_TAIL.forEach(function (b) { labels.push(b[2]); keys.push(b[0] + '-' + b[1]); }); for (c = 0; c < n; c++) { var L = longest(C, c); idx[c] = L === 0 ? 0 : binIdx(BINS_TAIL, L); } }
    else if (id === 'tailTotal') { BINS_TOTAL.forEach(function (b) { labels.push(b[2]); keys.push(b[0] + '-' + b[1]); }); for (c = 0; c < n; c++) idx[c] = binIdx(BINS_TOTAL, C.tailC[c]); }
    else if (id === 'nTails') { for (i = 0; i <= 5; i++) { labels.push(i === 0 ? 'none (< C6)' : (i === 5 ? '5+' : String(i))); keys.push(String(i)); } for (c = 0; c < n; c++) idx[c] = Math.min(5, C.nTails[c]); }
    else if (id === 'unsat') { for (i = 0; i <= 6; i++) { labels.push(i === 0 ? '0 (saturated)' : (i === 6 ? '6+' : String(i))); keys.push(String(i)); } for (c = 0; c < n; c++) idx[c] = Math.min(6, C.tailDbl[c]); }
    else if (id === 'branched') { for (i = 0; i <= 3; i++) { labels.push(i === 0 ? 'none (linear)' : (i === 3 ? '3+' : String(i))); keys.push(String(i)); } for (c = 0; c < n; c++) idx[c] = Math.min(3, C.nBranched[c]); }
    else if (id === 'linker') {
      var lk = LINKERS.filter(function (k) { return C[k]; });
      fromValues(function (c) { var best = 'none', bv = 0; for (var j = 0; j < lk.length; j++) { var v = C[lk[j]][c]; if (v > bv) { bv = v; best = lk[j]; } } return best; }, ['none'].concat(lk), function (k) { return k === 'none' ? 'no linker' : k; });
    } else if (id === 'amine') {
      var am = AMINES.filter(function (a) { return C[a[1]]; });
      fromValues(function (c) { var best = 'none', bv = 0; for (var j = 0; j < am.length; j++) { var v = C[am[j][1]][c]; if (v > bv) { bv = v; best = am[j][0]; } } return best; }, ['tertiary', 'secondary', 'primary', 'quaternary', 'amide', 'none'], function (k) { return k === 'none' ? 'no amine' : labelAmine(k); });
    } else throw err('bad_axis', 'Unknown axis: ' + id);
    var val = { keys: keys, idx: idx, _lab: labels, id: id }; S.axisCache[key] = { src: X, val: val }; return withLabels(val);
  }
  // value list of one axis over the whole set: {keys[], labels[]} (for filter menus)
  function categories(id) {
    if (!axisDef(id)) return Promise.reject(err('bad_axis', 'Unknown axis: ' + id));
    return loadColumns().then(function (X) { var A = axis(id, X); return { keys: A.keys.slice(), labels: A.labels.slice() }; });
  }
  function axes() { return AXES.map(function (a) { return { id: a.id, label: a.label, hint: a.hint }; }); }

  /* ------------------------------------------------------------------------------------------ filters */
  var SPECIAL = { head: 1, amine: 1, inClaims: 1, branched: 1, biodegradable: 1, tailLen: 1, unsat: 1, nTails: 1, mwMin: 1, mwMax: 1, pns: 1, ps: 1, where: 1 };
  function inRange(v, f) { return Array.isArray(f) ? (v >= f[0] && v <= f[1]) : v === f; }
  function normFilters(f) { var o = {}; Object.keys(f || {}).sort().forEach(function (k) { if (f[k] !== undefined && f[k] !== null && f[k] !== '') o[k] = f[k]; }); return o; }
  // -> Uint8Array(n) | null ; pubSet = Set of chemistry-set publication indexes (from ps / pns) | null
  function buildMask(X, f, pubSet) {
    var n = X.n, C = X.col, keys = Object.keys(f), m = null, c, i;
    keys.forEach(function (k) { if (!SPECIAL[k] && !C[k]) throw err('bad_filter', 'Unknown filter: ' + k); });
    function and(fn) { if (!m) { m = new Uint8Array(n).fill(1); } for (c = 0; c < n; c++) if (m[c] && !fn(c)) m[c] = 0; }
    if (f.head != null) { var hs = [].concat(f.head), hi = {}; hs.forEach(function (x) { hi[X.heads.indexOf(x)] = 1; }); and(function (c) { return hi[C.head[c]]; }); }
    if (f.amine != null) { var A = axis('amine', X), ak = [].concat(f.amine); and(function (c) { return ak.indexOf(A.keys[A.idx[c]]) >= 0; }); }
    if (f.inClaims) and(function (c) { return C.nClm[c] > 0; });
    if (f.branched === true) and(function (c) { return C.nBranched[c] > 0; }); else if (f.branched === false) and(function (c) { return C.nBranched[c] === 0; });
    if (f.biodegradable === true) and(function (c) { return (C.flags[c] & 1) === 1; });
    if (f.tailLen) and(function (c) { return inRange(longest(C, c), f.tailLen); });
    if (f.unsat != null) and(function (c) { return inRange(C.tailDbl[c], f.unsat); });
    if (f.nTails != null) and(function (c) { return inRange(C.nTails[c], f.nTails); });
    if (f.mwMin != null) and(function (c) { return C.mw[c] >= f.mwMin; });
    if (f.mwMax != null) and(function (c) { return C.mw[c] <= f.mwMax; });
    if (f.where) { var wb = 0, wm = { clm: 1, desc: 2, abs: 4, ttl: 8, img: 16, mol: 32 }; [].concat(f.where).forEach(function (w) { wb |= wm[w] || 0; }); if (wb) and(function (c) { return (C.wbits[c] & wb) !== 0; }); }
    keys.forEach(function (k) { if (!SPECIAL[k] && C[k]) and(function (c) { return inRange(C[k][c], f[k]); }); });
    if (pubSet) { and(function (c) { for (var j = X.mOff[c]; j < X.mOff[c + 1]; j++) if (pubSet.has(X.mEnt[j] >>> 8)) return true; return false; }); }
    return m;
  }
  function pubsForPs(X, ps, pns) {
    var D = eng('data'), idx = new Map(), i;
    for (i = 0; i < X.pn.length; i++) idx.set(X.pn[i], i);
    var want = new Set();
    (pns || []).forEach(function (pn) { var v = idx.get(String(pn).replace(/[^A-Za-z0-9]/g, '').toUpperCase()); if (v !== undefined) want.add(v); });
    if (!ps || !ps.length) return Promise.resolve(want);
    return D.patents(Array.from(ps)).then(function (pts) { pts.forEach(function (pt) { if (pt) { var v = idx.get(pt.pn); if (v !== undefined) want.add(v); } }); return want; });
  }

  /* ------------------------------------------------------------------------------------------ grid */
  var CAP_CS = 200;
  function grid(o) {
    o = o || {}; var t0 = now(), xid = o.x || 'head', yid = o.y || 'tailC', f = normFilters(o.filters), ps = o.ps && o.ps.length ? Array.from(o.ps) : null;
    if (!axisDef(xid)) return Promise.reject(err('bad_axis', 'Unknown axis: ' + xid));
    if (!axisDef(yid)) return Promise.reject(err('bad_axis', 'Unknown axis: ' + yid));
    var psKey = ps ? 'ps' + ps.length + ':' + ps.slice(0, 3).join(',') + ':' + ps.slice(-3).join(',') : '';
    var ck = JSON.stringify([xid, yid, f, psKey]);
    if (!ps) for (var gi = 0; gi < S.grids.length; gi++) if (S.grids[gi].key === ck) { var hit = S.grids[gi].res; return Promise.resolve(Object.assign({}, hit, { cached: true, ms: 0 })); }
    return loadColumns().then(function (X) {
      var t1 = now();
      var pnsF = f.pns, pre = (ps || pnsF) ? pubsForPs(X, ps, pnsF) : Promise.resolve(null);
      return pre.then(function (pubSet) {
        var ff = Object.assign({}, f); delete ff.pns;
        var mask = buildMask(X, ff, pubSet), A = axis(xid, X), B = axis(yid, X), nx = A.labels.length, ny = B.labels.length, C = X.col, n = X.n, c, j;
        var cells = new Array(nx * ny), lists = new Array(nx * ny), bm = new Array(nx * ny), fams = new Array(nx * ny), pubsOf = new Array(nx * ny), k, matched = 0;
        for (k = 0; k < nx * ny; k++) { cells[k] = { nCompounds: 0, nPatents: 0, nFamilies: 0, nInClaims: 0, nPatentsInClaims: 0, cs: [], pi: null, ps: null }; lists[k] = []; }
        var np = X.pn.length, allBm = new Uint8Array(np), allFam = new Set(), tot = { nCompounds: 0, nPatents: 0, nFamilies: 0, nInClaims: 0, nPatentsInClaims: 0 };
        for (c = 0; c < n; c++) {
          if (mask && !mask[c]) continue;
          matched++;
          var ci = B.idx[c] * nx + A.idx[c], cell = cells[ci];
          cell.nCompounds++; lists[ci].push(c); tot.nCompounds++;
          var inCl = C.nClm[c] > 0; if (inCl) { cell.nInClaims++; tot.nInClaims++; }
          var b = bm[ci]; if (!b) { b = bm[ci] = new Uint8Array(np); fams[ci] = new Set(); pubsOf[ci] = []; }
          for (j = X.mOff[c]; j < X.mOff[c + 1]; j++) {
            var e = X.mEnt[j], pi = e >>> 8;
            if (pubSet && !pubSet.has(pi)) continue;
            var inC = (e & 1) ? 2 : 0;
            if (!b[pi]) { b[pi] = 1; cell.nPatents++; pubsOf[ci].push(pi); var fam = X.fam[pi]; if (!fams[ci].has(fam)) fams[ci].add(fam); }
            if (inC && !(b[pi] & 2)) { b[pi] |= 2; cell.nPatentsInClaims++; }
            if (!allBm[pi]) { allBm[pi] = 1; tot.nPatents++; if (!allFam.has(X.fam[pi])) allFam.add(X.fam[pi]); }
            if (inC && !(allBm[pi] & 2)) { allBm[pi] |= 2; tot.nPatentsInClaims++; }
          }
        }
        tot.nFamilies = allFam.size;
        var max = { nCompounds: 0, nPatents: 0, nFamilies: 0, nInClaims: 0 };
        for (k = 0; k < nx * ny; k++) {
          var cl = cells[k], L = lists[k];
          cl.nFamilies = fams[k] ? fams[k].size : 0; cl.pi = pubsOf[k] ? Uint32Array.from(pubsOf[k]) : new Uint32Array(0);
          L.sort(function (a, b2) { return ((C.nClm[b2] > 0) - (C.nClm[a] > 0)) || (C.nPat[b2] - C.nPat[a]) || (a - b2); });
          cl.cs = L.slice(0, CAP_CS); cl._all = L; bm[k] = null;
          ['nCompounds', 'nPatents', 'nFamilies', 'nInClaims'].forEach(function (m) { if (cl[m] > max[m]) max[m] = cl[m]; });
        }
        var rows = []; for (var yi = 0; yi < ny; yi++) rows.push(cells.slice(yi * nx, (yi + 1) * nx));
        var man = (eng('data') || {}).manifest || {}, snap = (man.snapshots || {}).surechembl || X.man.snapshot || null, limits = LIMITS_GRID.slice();
        if (snap) limits.push('Structure extraction snapshot: ' + snap + '.');
        if (matched < n) limits.push('Filter: ' + matched.toLocaleString('en-GB') + ' of ' + n.toLocaleString('en-GB') + ' compounds are counted.');
        var res = { x: xid, y: yid, xs: A.labels.slice(), ys: B.labels.slice(), xKeys: A.keys.slice(), yKeys: B.keys.slice(), cells: rows, totals: tot, max: max, n: n, matched: matched, filters: f,
          snapshot: snap, ms: Math.round(now() - t1), msLoad: Math.round(t1 - t0), cached: false, limits: limits };
        Object.defineProperty(res, '_', { value: { X: X, cells: cells, nx: nx, ny: ny }, enumerable: false });
        if (!ps) { S.grids.unshift({ key: ck, res: res }); if (S.grids.length > 8) S.grids.pop(); }
        return res;
      });
    });
  }

  function cellDetail(res, xi, yi, o) {
    o = o || {}; var Ch = eng('chem'), D = eng('data'), I = res && res._;
    if (!I) return Promise.reject(err('bad_grid', 'This is not a result of grid().'));
    var cell = I.cells[yi * I.nx + xi]; if (!cell) return Promise.reject(err('bad_cell', 'No such cell.'));
    var nC = o.compounds || 60, nP = o.patents || 100, X = I.X;
    var cs = cell._all.slice(0, nC);
    var compP = Promise.all(cs.map(function (c) { return Ch.compound(c).catch(function () { return null; }); })).then(function (a) { return a.filter(Boolean); });
    // publications: earliest priority first (publication date where the priority date is missing); dates come from the binary columns of the patent table
    var pis = Array.from(cell.pi), pns = pis.map(function (pi) { return X.pn[pi]; });
    var patP = Promise.all(pns.map(function (pn) { return D.byPn(pn, { exact: true }).catch(function () { return -1; }); })).then(function (pp) {
      return Promise.resolve(D.meta ? D.meta() : null).catch(function () { return null; }).then(function (m) {
        var rows = pis.map(function (pi, i) { var p = pp[i]; return { pi: pi, pn: pns[i], p: p, fam: X.fam[pi], prio: m && p >= 0 ? m.prio[p] : 0, pub: m && p >= 0 && m.pub ? m.pub[p] : 0 }; });
        rows.sort(function (a, b) { return (a.prio || a.pub || 99999999) - (b.prio || b.pub || 99999999) || a.pn.localeCompare(b.pn); });
        var total = rows.length, top = rows.slice(0, nP);
        return D.patents(top.filter(function (r) { return r.p >= 0; }).map(function (r) { return r.p; })).then(function (pts) {
          var pm = new Map(); pts.forEach(function (pt) { if (pt) pm.set(pt.p, pt); });
          var out = top.map(function (r) { var pt = pm.get(r.p); return { p: r.p, pn: r.pn, fam: pt && pt.fam != null ? pt.fam : r.fam, pub: pt ? iso(pt.pub) : '', prio: pt ? iso(pt.prio || pt.app) : '', status: pt ? str(pt.status) : '', title: pt ? pt.title : '' }; });
          return { patents: out, nPatents: total, truncated: total > top.length };
        });
      });
    });
    return Promise.all([compP, patP]).then(function (r) { cell.ps = r[1].patents.map(function (x) { return x.p; }); return { compounds: r[0], nCompounds: cell.nCompounds, patents: r[1].patents, nPatents: r[1].nPatents, truncated: r[1].truncated || cell.nCompounds > cs.length }; });
  }

  function configure(o) { S.cfg = Object.assign(S.cfg, o || {}); if (o && (o.columns || o.reset)) { S.cols = null; S.colsP = null; S.grids = []; S.axisCache = {}; } }
  function limits() { return LIMITS_TIMELINE.concat(LIMITS_GRID); }
  function reset() { S.cols = null; S.colsP = null; S.grids = []; S.axisCache = {}; }

  g.LnpDisclosure = { timeline: timeline, toCsv: toCsv, grid: grid, axes: axes, categories: categories, cellDetail: cellDetail, configure: configure, limits: limits, reset: reset, MODES: MODES.slice(), _readColumns: readColumns };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.LnpDisclosure;
})(typeof window !== 'undefined' ? window : globalThis);
