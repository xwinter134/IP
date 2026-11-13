/* LNP Patent Desk: compound library screen (global LnpScreen). Plain ASCII script, no eval, no network of its own.
   Takes a list of compounds (SMILES, names, SCHEMBL numbers; pasted text or a CSV/TSV/SMILES file) and screens every
   one against the structure data (LnpChem) and the patent table (LnpData): exact, substructure and similar hits, the
   publications they sit in, claim / status flags and the state of the Markush check (LnpMarkush).
   Code decides everything: no model is involved. A hit is a structure match from the SureChEMBL extraction, not a
   claim analysis. FTO-type output is a pre-screening, not legal advice.

   API
     parseInput(text | Blob)            -> rows [{row, id, name, input, alt?, smiles?, error?}] (array for text; Promise for a Blob/File).
                                           The array carries .total (data rows seen), .truncated (rows beyond MAX_ROWS), .notes[], .header, .delimiter.
     resolve(rows, {signal})            -> Promise: sets row.parsed / row.error with LnpChem.parse (names, SCHEMBL ids, SMILES); returns rows
     run(rows, {modes, minSim, subMaxHits, simTop, commodityMin, markush, signal, onProgress, onResult}) -> Promise<results>
                                           results[i] = {row, id, name, input, ok, error?, parsed, exact, sub, sim, patents, flags, markush, ms}
                                           (.cancelled = true when the signal fired; results then hold the finished compounds)
     summary(results)                   -> counts
     toCsv(results, {sep, snapshot})    -> text (formula injection neutralised)
     compact(results)                   -> JSON-safe, smaller copy (<= MAX_STORE_CHARS or null)
     save({id?, name, rows, opts, results}) / load(id) / list() / remove(id)   store kind 'screens'
     configure({chem, data, markush, store, kit})  for tests; limits(), MAX_ROWS
   Row limit: MAX_ROWS (2,000). */
(function (g) {
  'use strict';
  var MAX_ROWS = 2000, MAX_STORE_CHARS = 100000, KIND = 'screens', MAX_INPUT = 2000;
  var S = { eng: {}, mem: {} };

  function eng(name) { return S.eng[name] || g['Lnp' + name.charAt(0).toUpperCase() + name.slice(1)] || null; }
  function str(x) { return x == null ? '' : String(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function mkErr(code, message) { var e = new Error(message); e.code = code; return e; }
  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }
  function clean(s) { return str(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').trim(); }

  /* ------------------------------------------------------------------------------------------ parsing */
  var HDR_SMILES = ['smiles', 'canonical_smiles', 'canonicalsmiles', 'isomeric_smiles', 'isomericsmiles', 'smi', 'structure', 'mol', 'molecule'];
  var HDR_NAME = ['name', 'compound_name', 'compoundname', 'lipid', 'title', 'compound', 'label'];
  var HDR_ID = ['id', 'compound_id', 'compoundid', 'cid', 'identifier', 'ident', 'ref', 'no', 'nr', 'number', 'sample', 'sample_id'];
  var HDR_INPUT = ['input', 'query'];
  function norm(h) { return str(h).toLowerCase().replace(/^[\s"'\ufeff]+|[\s"']+$/g, '').replace(/[\s\-.]+/g, '_'); }
  function isIn(list, h) { return list.indexOf(h) >= 0; }

  // a string that can only be a SMILES (bond, branch, bracket or ring syntax) as opposed to a name or an id
  function strongSmiles(s) {
    s = str(s).trim();
    if (!s || /\s/.test(s)) return false;
    if (!/^[A-Za-z0-9@+\-\[\]()=#$:~&!*\/\\.%]+$/.test(s)) return false;
    if (/[()=#\[\]\/\\@%]/.test(s)) return /[A-Za-z]/.test(s);
    return /^[BCNOPSFIcnops0-9]{3,}$/.test(s) && /[A-Za-z].*[A-Za-z].*[A-Za-z]/.test(s);   // plain atom strings such as CCCCO or c1ccccc1
  }
  function brackets(s) {            // syntax check that needs no chemistry: ( ) [ ] balance, quotes
    var d = 0, b = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (c === '[') { if (b) return 'unbalanced [ ]'; b = 1; } else if (c === ']') { if (!b) return 'unbalanced [ ]'; b = 0; }
      else if (!b && c === '(') d++; else if (!b && c === ')') { d--; if (d < 0) return 'unbalanced ( )'; }
    }
    if (b) return 'unbalanced [ ]';
    if (d) return 'unbalanced ( )';
    return '';
  }

  // text -> records of cells. Quoted fields may hold the delimiter, doubled quotes and line breaks.
  function tokenize(text, delim) {
    var rows = [], row = [], cell = '', q = false, i = 0, n = text.length, c, line = 1, startLine = 1, wasQuoted = false, qLine = 0;
    function endCell() { row.push(wasQuoted ? cell : cell.trim()); cell = ''; wasQuoted = false; }
    function endRow() { endCell(); rows.push({ line: startLine, cells: row }); row = []; }
    for (; i < n; i++) {
      c = text.charAt(i);
      if (q) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else { cell += c; if (c === '\n') line++; }
        continue;
      }
      if (c === '"' && cell.trim() === '') { q = true; wasQuoted = true; cell = ''; qLine = line; continue; }
      if (c === delim) { endCell(); continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        endRow(); line++; startLine = line; continue;
      }
      cell += c;
    }
    if (q) rows.unclosed = qLine;      // end of input inside a quoted field: everything after the quote is one cell
    if (cell !== '' || row.length || q) endRow();
    return rows;
  }
  function countOutsideQuotes(line, ch) {
    var q = false, n = 0;
    for (var i = 0; i < line.length; i++) { var c = line.charAt(i); if (c === '"') q = !q; else if (!q && c === ch) n++; }
    return n;
  }
  function detectDelimiter(text) {
    // the delimiter must be on the first line and on most of the sampled lines: one name with a comma does not make a list a CSV
    var lines = text.split(/\r\n|\n|\r/).filter(function (l) { var t = l.trim(); return t && t.charAt(0) !== '#'; }).slice(0, 30);
    if (!lines.length) return '';
    var cands = ['\t', ';', ','];
    for (var i = 0; i < cands.length; i++) {
      var hit = 0;
      lines.forEach(function (l) { if (countOutsideQuotes(l, cands[i]) > 0) hit++; });
      if (countOutsideQuotes(lines[0], cands[i]) > 0 && hit >= Math.ceil(lines.length * 0.6)) return cands[i];
    }
    return '';
  }

  function parseInput(text, opts) {
    if (text && typeof text === 'object' && typeof text.text === 'function' && typeof text !== 'string') {
      return text.text().then(function (t) { return parseInput(t, opts); });
    }
    opts = opts || {};
    var max = opts.max || MAX_ROWS;
    var src = str(text).replace(/^\ufeff/, ''), out = [], notes = [];
    out.total = 0; out.truncated = 0; out.notes = notes; out.header = false; out.delimiter = '';
    if (!src.trim()) return out;
    var delim = detectDelimiter(src), recs = tokenize(src, delim);
    out.delimiter = delim;
    if (recs.unclosed) {
      notes.push('Unclosed quote from line ' + recs.unclosed + ': the rest of the file was read as one cell, so fewer compounds than the file holds may be screened. Close the quote or remove it and load the file again.');
      out.unclosedQuote = recs.unclosed;
    }
    recs = recs.filter(function (r) { return !r.cells.every(function (c) { return c === ''; }) && !(r.cells[0] && r.cells[0].charAt(0) === '#'); });
    if (!recs.length) return out;

    // header detection: any cell of the first record named like a column we know
    var cols = { smiles: -1, name: -1, id: -1 }, hdr = recs[0].cells.map(norm), isHeader = false, k;
    if (delim) {
      for (k = 0; k < hdr.length; k++) {
        if (isIn(HDR_SMILES, hdr[k]) || isIn(HDR_NAME, hdr[k]) || isIn(HDR_ID, hdr[k]) || isIn(HDR_INPUT, hdr[k])) isHeader = true;
      }
      if (recs[0].cells.some(strongSmiles)) isHeader = false;      // a row with a real structure is data ("lipid,CCCCN(C)C")
    } else if (recs.length > 0 && recs[0].cells.length === 1 && (isIn(HDR_SMILES, hdr[0]) || isIn(HDR_INPUT, hdr[0]))) isHeader = true;
    if (isHeader) {
      for (k = 0; k < hdr.length; k++) {
        if (cols.smiles < 0 && isIn(HDR_SMILES, hdr[k])) cols.smiles = k;
        else if (cols.name < 0 && isIn(HDR_NAME, hdr[k])) cols.name = k;
        else if (cols.id < 0 && isIn(HDR_ID, hdr[k])) cols.id = k;
      }
      if (cols.smiles < 0) {
        for (k = 0; k < hdr.length; k++) if (isIn(HDR_INPUT, hdr[k])) { cols.smiles = k; break; }
      }
      if (cols.smiles < 0) {            // header without a structure column: name column carries the input, else the first column left over
        if (cols.name >= 0) { cols.smiles = cols.name; cols.name = -1; }
        else for (k = 0; k < hdr.length; k++) if (k !== cols.id) { cols.smiles = k; break; }
      }
      out.header = true;
      recs = recs.slice(1);
    } else if (delim) {
      // no header: guess from the content of the first 25 records which column holds the structure
      var width = 0; recs.forEach(function (r) { width = Math.max(width, r.cells.length); });
      var score = [], j;
      for (j = 0; j < width; j++) score.push(0);
      recs.slice(0, 25).forEach(function (r) { r.cells.forEach(function (c, ci) { if (strongSmiles(c) || /^SCHEMBL\d+$/i.test(c)) score[ci]++; }); });
      var best = -1, bs = 0;
      score.forEach(function (s, ci) { if (s > bs) { bs = s; best = ci; } });
      var others = [];
      if (best < 0) { best = 0; notes.push('No column with structures was recognised; the first column is read as the structure input. Add a header (id, name, smiles) to choose the columns.'); }
      for (j = 0; j < width; j++) if (j !== best) others.push(j);
      cols.smiles = best; cols.id = others.length ? others[0] : -1; cols.name = others.length > 1 ? others[1] : -1;
    } else cols.smiles = 0;
    if (cols.smiles >= 0 && cols.id === cols.smiles) cols.id = -1;

    recs.forEach(function (r) {
      out.total++;
      if (out.length >= max) { out.truncated++; return; }
      var cells = r.cells, raw = cols.smiles >= 0 ? clean(cells[cols.smiles]) : '', name = cols.name >= 0 ? clean(cells[cols.name]) : '', id = cols.id >= 0 ? clean(cells[cols.id]) : '';
      var item = { row: r.line, id: '', name: name, input: '' }, alt = null;
      if (!delim) {                      // one cell per line: "SMILES name" (.smi) or a bare structure, name or SCHEMBL number
        var t = raw.split(/\s+/);
        if (t.length > 1) { alt = { smiles: t[0], name: t.slice(1).join(' ') }; raw = t.join(' '); }
      }
      item.input = raw.slice(0, MAX_INPUT + 1);
      item.id = id || (name && name !== raw ? name : '') || 'row ' + r.line;
      if (alt) item.alt = alt;
      if (!raw) item.error = 'empty structure field';
      else if (raw.length > MAX_INPUT) item.error = 'input is longer than ' + MAX_INPUT + ' characters';
      else if (strongSmiles(raw)) { var bad = brackets(raw); if (bad) item.error = 'not a valid SMILES: ' + bad; else item.smiles = raw; }
      out.push(item);
    });
    if (out.truncated) notes.push('Only the first ' + MAX_ROWS + ' rows are screened; ' + out.truncated + ' further row' + (out.truncated === 1 ? ' was' : 's were') + ' ignored.');
    return out;
  }

  /* ------------------------------------------------------------------------------------------ resolve */
  function parseOne(chem, input) {
    return Promise.resolve(chem.parse(input)).then(function (p) { return p; }, function (e) { return { ok: false, error: str(e && e.message) || 'could not be parsed' }; });
  }
  function resolveRow(chem, row) {
    if (row.error && !row.smiles && !row.alt) return Promise.resolve(row);
    if (row.error && row.error.indexOf('not a valid SMILES') === 0 && !row.alt) return Promise.resolve(row);
    return parseOne(chem, row.input).then(function (p) {
      if ((!p || !p.ok) && row.alt) return parseOne(chem, row.alt.smiles).then(function (p2) {
        if (p2 && p2.ok) { if (!row.name) row.name = row.alt.name; if (/^row \d+$/.test(row.id)) row.id = row.alt.name || row.id; row.input = row.alt.smiles; return p2; }
        return p;
      });
      return p;
    }).then(function (p) {
      if (p && p.ok && p.kind === 'smarts') { row.error = 'a SMARTS pattern is not a compound'; row.parsed = null; return row; }
      if (p && p.ok && p.smiles) {
        row.parsed = { kind: p.kind, name: p.name || '', id: p.id || '', smiles: p.smiles, idcode: p.idcode || '', formula: p.formula || '', mw: p.mw || 0, c: p.c != null ? p.c : null };
        delete row.error;
        if (!row.name && p.name) row.name = p.name;
        if (/^row \d+$/.test(row.id) && p.name) row.id = p.name;
      } else { row.parsed = null; row.error = 'Not recognised (not a SMILES, a known lipid name or a SCHEMBL number)'; row.errorDetail = p && p.error ? str(p.error) : ''; }
      return row;
    });
  }
  function resolve(rows, o) {
    o = o || {};
    var chem = eng('chem'), i = 0;
    if (!chem) return Promise.reject(mkErr('no_chem', 'the structure engine is not loaded'));
    function step() {
      if (i >= rows.length) return Promise.resolve(rows);
      if (o.signal && o.signal.aborted) return Promise.reject(mkErr('cancelled', 'cancelled'));
      var r = rows[i++];
      return resolveRow(chem, r).then(function () { return (i % 40 === 0) ? tick() : null; }).then(step);
    }
    return step();
  }

  /* ------------------------------------------------------------------------------------------ run */
  function slim(h, sim) {
    return { c: h.c, id: h.id, sim: h.sim != null ? Math.round(h.sim * 1000) / 1000 : (sim != null ? sim : null), match: h.match || null, smiles: h.smiles, formula: h.formula || '', nPat: h.nPat || 0,
      nClaims: h.nClaims || 0, inClaims: !!h.inClaims, where: h.where || null, nPatGlobal: h.nPatGlobal != null ? h.nPatGlobal : null };
  }
  function inForce(pt, today) { return !!pt && pt.status === 'granted' && (!pt.exp || pt.exp >= today); }
  function todayNum() { var t = new Date(); return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate(); }
  var ROUTE_ORDER = { exact: 0, markush: 1, sim: 2, sub: 3 };

  function defaults(o) {
    o = o || {};
    var modes = arr(o.modes).length ? o.modes.filter(function (m) { return m === 'exact' || m === 'sub' || m === 'sim'; }) : ['exact', 'sim'];
    return { modes: modes.length ? modes : ['exact'], minSim: o.minSim != null ? o.minSim : 0.8, subMaxHits: o.subMaxHits || 200, simTop: o.simTop || 12, subPatentHits: o.subPatentHits || 25, patentCap: o.patentCap || 400,
      commodityMin: o.commodityMin || 1000, commodityMaxHeavy: o.commodityMaxHeavy || 16, markush: o.markush !== false, markushPatents: o.markushPatents || 40, signal: o.signal, onProgress: o.onProgress, onResult: o.onResult, today: o.today || todayNum() };
  }

  // one compound, all modes
  function screenOne(row, op, ctx) {
    var chem = eng('chem'), data = eng('data'), t0 = Date.now(), parsed = row.parsed;
    var res = { row: row.row, id: row.id, name: row.name || '', input: row.input, ok: true, parsed: parsed, exact: [], sub: { total: 0, hits: [], capped: false }, sim: [], patents: [], flags: null, markush: null, ms: 0 };
    var hitsByRoute = { exact: [], sub: [], sim: [] }, key = parsed.idcode || parsed.smiles;
    function search(mode, extra) {
      var q = { smiles: parsed.smiles, mode: mode, maxPatents: 0, signal: op.signal };
      Object.keys(extra).forEach(function (k) { q[k] = extra[k]; });
      return chem.search(q);
    }
    function check() { if (op.signal && op.signal.aborted) throw mkErr('cancelled', 'cancelled'); }
    var p = Promise.resolve();
    if (op.modes.indexOf('exact') >= 0) p = p.then(function () { check(); return search('exact', { limit: 40 }); }).then(function (hs) { res.exact = arr(hs).map(function (h) { return slim(h); }); hitsByRoute.exact = arr(hs); });
    if (op.modes.indexOf('sim') >= 0) p = p.then(function () { check(); return search('sim', { limit: 60, minSim: op.minSim }); }).then(function (hs) {
      var exactC = {}; hitsByRoute.exact.forEach(function (h) { exactC[h.c] = 1; });
      var list = arr(hs).filter(function (h) { return !exactC[h.c] && h.match !== 'exact' && h.match !== 'stereo-variant'; });
      res.sim = list.slice(0, op.simTop).map(function (h) { return slim(h); }); res.simTotal = list.length; hitsByRoute.sim = list.slice(0, op.simTop);
    });
    if (op.modes.indexOf('sub') >= 0) p = p.then(function () { check(); return search('sub', { limit: op.subMaxHits }); }).then(function (hs) {
      var exactC = {}; hitsByRoute.exact.forEach(function (h) { exactC[h.c] = 1; });
      var total = hs.total != null ? hs.total : arr(hs).length;
      res.sub = { total: total, hits: arr(hs).slice(0, 20).map(function (h) { return slim(h); }), capped: total > arr(hs).length };
      hitsByRoute.sub = arr(hs).filter(function (h) { return !exactC[h.c]; }).slice(0, op.subPatentHits);
    });
    // publications of every hit, merged per publication
    p = p.then(function () {
      var by = new Map(), jobs = [];
      ['exact', 'sim', 'sub'].forEach(function (route) {
        hitsByRoute[route].forEach(function (h) {
          jobs.push(Promise.resolve(chem.patentsOf(h.c)).then(function (pats) {
            arr(pats).slice(0, op.patentCap).forEach(function (x) {
              var e = by.get(x.pn);
              if (!e) { e = { p: x.p, pn: x.pn, routes: [], inClaims: false, where: {}, family: x.fam != null ? x.fam : null, sim: null, via: [], routeClaims: {} }; by.set(x.pn, e); }
              if (e.routes.indexOf(route) < 0) e.routes.push(route);
              var w = x.where || {};
              Object.keys(w).forEach(function (k) { if (w[k]) e.where[k] = 1; });
              if (w.clm) { e.inClaims = true; e.routeClaims[route] = true; }
              var s = route === 'exact' ? 1 : h.sim;
              if (s != null && (e.sim == null || s > e.sim)) e.sim = s;
              if (e.via.length < 6 && e.via.indexOf(h.id) < 0) e.via.push(h.id);
            });
          }, function () { return null; }));
        });
      });
      return Promise.all(jobs).then(function () { return by; });
    }).then(function (by) {
      var list = Array.from(by.values()), ps = list.filter(function (e) { return e.p != null && e.p >= 0; }).map(function (e) { return e.p; });
      return (data && ps.length ? Promise.resolve(data.patents(ps)).then(function (rows) { var m = {}; arr(rows).forEach(function (r) { m[r.p] = r; }); return m; }, function () { return {}; }) : Promise.resolve({})).then(function (m) {
        list.forEach(function (e) {
          var pt = m[e.p] || null;
          e.status = pt ? pt.status || '' : null; e.exp = pt && pt.exp ? pt.exp : 0; e.auth = pt ? pt.auth : (/^[A-Z]{2}/.exec(e.pn) || [''])[0];
          e.title = pt ? str(pt.title) : ''; e.inForce = inForce(pt, op.today); e.hasImg = !!(pt && pt.hasImg);
          e.routes.sort(function (a, b) { return ROUTE_ORDER[a] - ROUTE_ORDER[b]; });
        });
        list.sort(function (a, b) {
          return (b.inClaims ? 1 : 0) - (a.inClaims ? 1 : 0) || ROUTE_ORDER[a.routes[0]] - ROUTE_ORDER[b.routes[0]] || (b.inForce ? 1 : 0) - (a.inForce ? 1 : 0) || (b.sim || 0) - (a.sim || 0) || a.pn.localeCompare(b.pn);
        });
        res.patents = list;
        res.flags = flagsOf(res, op);
      });
    });
    if (op.markush && eng('markush')) p = p.then(function () { check(); return markushOf(res, parsed, op, ctx); }).then(function () { return addMarkushPatents(res, op); }).then(function () { res.flags = flagsOf(res, op); });
    return p.then(function () { res.ms = Date.now() - t0; return res; }, function (e) {
      if (e && e.code === 'cancelled') throw e;
      res.ok = false; res.error = 'screen failed: ' + str(e && e.message); res.ms = Date.now() - t0; return res;
    });
  }

  function heavyAtoms(p) {      // heavy atoms from the molecular formula ("C2H6O" -> 3); 0 when unknown
    var f = p && p.formula ? String(p.formula) : '', n = 0, m, re = /([A-Z][a-z]?)(\d*)/g;
    while ((m = re.exec(f))) { if (m[1] !== 'H' && m[1] !== 'D' && m[1] !== 'T') n += m[2] ? +m[2] : 1; }
    return n;
  }
  function flagsOf(res, op) {
    var f = { inClaimsExact: false, inClaimsSim: false, grantedInForce: false, inForceAny: false, markushCovered: false, commodity: false, level: 0, label: 'no hit' };
    var exactForce = false, mkForce = false;
    res.patents.forEach(function (e) {
      var ex = e.routes.indexOf('exact') >= 0, si = e.routes.indexOf('sim') >= 0;
      if (ex && e.routeClaims.exact) { f.inClaimsExact = true; if (e.inForce) exactForce = true; }
      if (si && e.routeClaims.sim) f.inClaimsSim = true;
      if (e.routeClaims.markush) { f.markushCovered = true; if (e.inForce) mkForce = true; }
      if (e.inForce && (e.routeClaims.exact || e.routeClaims.sim || e.routeClaims.markush)) f.grantedInForce = true;
      if (e.inForce && (ex || si)) f.inForceAny = true;
    });
    if (res.exact.some(function (h) { return h.inClaims; })) f.inClaimsExact = true;     // compound-level flag too: the publication list is capped
    if (res.sim.some(function (h) { return h.inClaims; })) f.inClaimsSim = true;
    // widely published: many publications world-wide (neutral information, says nothing about relevance). Common building
    // block: widely published AND small (reagents, solvents, simple acids), whose hits rarely concern the claimed invention
    f.widely = res.exact.some(function (h) { return h.nPatGlobal != null && h.nPatGlobal >= op.commodityMin; });
    f.commodity = f.widely && heavyAtoms(res.parsed) > 0 && heavyAtoms(res.parsed) <= op.commodityMaxHeavy;
    var any = res.exact.length || res.sim.length || res.sub.total;
    if (exactForce) { f.level = 4; f.label = 'exact match in the claims of a granted patent'; }
    else if (mkForce) { f.level = 4; f.label = 'covered by a Markush claim of a granted patent'; }
    else if (f.inClaimsExact) { f.level = 3; f.label = 'exact match in the claims'; }
    else if (f.markushCovered) { f.level = 3; f.label = 'covered by a Markush claim'; }
    else if (f.inClaimsSim) { f.level = 2; f.label = 'similar compound in the claims'; }
    else if (any) { f.level = 1; f.label = res.exact.length ? 'exact match in descriptions only' : res.sim.length ? 'similar compound, not in claims' : 'substructure hits only'; }
    return f;
  }

  // publications of covered Markush records that no structure hit led to: look them up and add them (route "markush")
  function addMarkushPatents(res, op) {
    var m = res.markush, data = eng('data');
    if (!m || !m.covered.length) return Promise.resolve();
    var have = {}; res.patents.forEach(function (e) { have[e.pn] = e; });
    var jobs = [];
    m.covered.forEach(function (c) {
      var e = have[c.pn];
      if (e) { if (e.routes.indexOf('markush') < 0) e.routes.push('markush'); e.inClaims = true; e.routeClaims.markush = true; e.routes.sort(function (a, b) { return ROUTE_ORDER[a] - ROUTE_ORDER[b]; }); return; }
      e = { p: -1, pn: c.pn, routes: ['markush'], inClaims: true, where: { clm: 1 }, family: null, sim: null, via: [], routeClaims: { markush: true }, status: null, exp: 0, auth: (/^[A-Z]{2}/.exec(c.pn) || [''])[0], title: '', inForce: false, hasImg: true };
      have[c.pn] = e; res.patents.push(e);
      if (data && typeof data.byPn === 'function') jobs.push(Promise.resolve(data.byPn(c.pn)).then(function (p) {
        if (p == null || p < 0) return null;
        return Promise.resolve(data.patents([p])).then(function (rows) {
          var pt = arr(rows)[0]; if (!pt) return;
          e.p = p; e.status = pt.status || ''; e.exp = pt.exp || 0; e.title = str(pt.title); e.family = pt.fam != null ? pt.fam : null; e.inForce = inForce(pt, op.today);
        });
      }).then(null, function () { return null; }));
    });
    return Promise.all(jobs).then(function () {
      res.patents.sort(function (a, b) {
        return (b.inClaims ? 1 : 0) - (a.inClaims ? 1 : 0) || ROUTE_ORDER[a.routes[0]] - ROUTE_ORDER[b.routes[0]] || (b.inForce ? 1 : 0) - (a.inForce ? 1 : 0) || (b.sim || 0) - (a.sim || 0) || a.pn.localeCompare(b.pn);
      });
    });
  }

  /* Markush: curated or stored records are checked against every compound (a generic claim covers compounds that no
     publication names), formula claims of the hit publications without a record go to the queue. */
  function markushOf(res, parsed, op, ctx) {
    var M = eng('markush'), out = { covered: [], unclear: [], queue: [], notCovered: 0, checked: 0, ms: 0 }, t0 = Date.now();
    res.markush = out;
    var cand = res.patents.filter(function (e) { return e.routes.indexOf('sub') < 0 || e.routes.length > 1; });
    cand = cand.filter(function (e) { return e.hasImg || e.inClaims; }).slice(0, op.markushPatents);
    function formulaClaims(e) {
      if (!ctx.fc.has(e.p)) ctx.fc.set(e.p, e.p >= 0 && typeof M.claimsWithFormula === 'function' ? Promise.resolve(M.claimsWithFormula(e.p)).then(function (cs) { return arr(cs).map(function (c) { return c.n; }); }, function () { return []; }) : Promise.resolve([]));
      return ctx.fc.get(e.p);
    }
    return Promise.resolve(typeof M.list === 'function' ? M.list({ curated: true }) : []).then(function (recs) {
      var targets = [], seen = {}, i = 0, hitPn = {};
      function add(pn, claim, why) { var k = pn + '--c' + claim; if (!seen[k]) { seen[k] = 1; targets.push({ pn: pn, claim: claim, why: why }); } }
      arr(recs).forEach(function (r) { add(r.pn, r.claim, 'record'); });
      function next() {
        if (i >= cand.length) return Promise.resolve();
        if (op.signal && op.signal.aborted) return Promise.reject(mkErr('cancelled', 'cancelled'));
        var e = cand[i++];
        return formulaClaims(e).then(function (ns) { ns.forEach(function (n) { add(e.pn, n, 'hit'); hitPn[e.pn] = 1; }); });
      }
      return next().then(function loop() { return i < cand.length ? next().then(loop) : null; }).then(function () {
        if (!targets.length) return null;
        return M.batch(parsed.smiles, targets.map(function (t) { return { pn: t.pn, claim: t.claim }; }), { signal: op.signal }).then(function (rs) {
          rs.forEach(function (r, ix) {
            var t = targets[ix];
            out.checked++;
            if (r.reason === 'no_record') { if (t.why === 'hit') out.queue.push({ pn: r.pn, claim: r.claim }); return; }
            if (!r.result) { out.unclear.push({ pn: r.pn, claim: r.claim, why: r.reason || 'error' }); return; }
            var v = r.result.overall;
            if (v === 'covered') out.covered.push({ pn: r.pn, claim: r.claim, caveat: r.result.caveat || null });
            else if (v === 'not_covered') out.notCovered++;
            else out.unclear.push({ pn: r.pn, claim: r.claim, why: arr(r.result.reasons)[0] || 'unclear' });
          });
        });
      });
    }).then(function () { out.ms = Date.now() - t0; }, function (e) {
      if (e && e.code === 'cancelled') throw e;
      out.error = str(e && e.message); out.ms = Date.now() - t0;
    });
  }

  function run(rows, o) {
    var op = defaults(o), chem = eng('chem'), results = [], i = 0, cache = new Map(), ctx = { fc: new Map() };
    results.cancelled = false;
    if (!chem) return Promise.reject(mkErr('no_chem', 'the structure engine is not loaded'));
    rows = arr(rows).slice(0, MAX_ROWS);
    function progress(extra) { if (typeof op.onProgress === 'function') { try { op.onProgress(Object.assign({ done: results.length, total: rows.length }, extra || {})); } catch (e) { /* the caller's problem */ } } }
    function finish(r) { results.push(r); if (typeof op.onResult === 'function') { try { op.onResult(r, results.length - 1); } catch (e) { /* ignore */ } } progress({ last: r }); }
    function step() {
      if (i >= rows.length) return Promise.resolve(results);
      if (op.signal && op.signal.aborted) { results.cancelled = true; return Promise.resolve(results); }
      var row = rows[i++];
      progress({ phase: 'compound', row: row });
      return resolveRow(chem, row).then(function () {
        if (!row.parsed) { finish({ row: row.row, id: row.id, name: row.name || '', input: row.input, ok: false, error: row.error || 'invalid input', errorDetail: row.errorDetail || '', parsed: null, exact: [], sub: { total: 0, hits: [], capped: false }, sim: [], patents: [], flags: null, markush: null, ms: 0 }); return null; }
        var key = row.parsed.idcode || row.parsed.smiles;
        if (cache.has(key)) {                                    // the same structure twice: reuse, keep the row identity
          var c = JSON.parse(JSON.stringify(cache.get(key))); c.row = row.row; c.id = row.id; c.name = row.name || c.name; c.input = row.input; c.duplicateOf = cache.get(key).row; c.parsed = row.parsed; finish(c); return null;
        }
        return screenOne(row, op, ctx).then(function (r) { cache.set(key, r); finish(r); });
      }).then(tick, function (e) {
        if (e && e.code === 'cancelled') { results.cancelled = true; return null; }
        throw e;
      }).then(step);
    }
    return step();
  }

  /* ------------------------------------------------------------------------------------------ summary and CSV */
  function summary(results) {
    var s = { n: 0, parsed: 0, invalid: 0, withExact: 0, withSim: 0, withSub: 0, noHit: 0, inClaimsExact: 0, inClaimsSim: 0, grantedInForce: 0, commodity: 0, markushCovered: 0, markushUnclear: 0, markushQueued: 0, queueClaims: 0, patents: 0, ms: 0 };
    var pns = {}, q = {};
    arr(results).forEach(function (r) {
      s.n++; s.ms += r.ms || 0;
      if (!r.ok || !r.parsed) { s.invalid++; return; }
      s.parsed++;
      if (r.exact.length) s.withExact++;
      if (r.sim.length) s.withSim++;
      if (r.sub && r.sub.total) s.withSub++;
      if (!r.exact.length && !r.sim.length && !(r.sub && r.sub.total)) s.noHit++;
      var f = r.flags || {};
      if (f.inClaimsExact) s.inClaimsExact++;
      if (f.inClaimsSim) s.inClaimsSim++;
      if (f.grantedInForce) s.grantedInForce++;
      if (f.commodity) s.commodity++;
      r.patents.forEach(function (e) { pns[e.pn] = 1; });
      var m = r.markush;
      if (m) { if (m.covered.length) s.markushCovered++; if (m.unclear.length) s.markushUnclear++; if (m.queue.length) s.markushQueued++; m.queue.forEach(function (x) { q[x.pn + '--c' + x.claim] = 1; }); }
    });
    s.patents = Object.keys(pns).length; s.queueClaims = Object.keys(q).length;
    return s;
  }

  var CSV_COLS = ['compound id', 'input', 'smiles', 'match type', 'similarity', 'pn', 'in claims', 'status', 'expiry estimate', 'markush verdict', 'limits note'];
  function snapshotText(o) {
    var d = eng('data'), m = (o && o.snapshot) || (d && d.manifest && d.manifest.snapshots) || null;
    if (typeof m === 'string') return m;
    if (m && m.surechembl) return 'SureChEMBL ' + m.surechembl + (m.ep_register ? ', EP register ' + m.ep_register : '');
    return 'snapshot date not available';
  }
  function limitsNote(o) {
    return 'Pre-screening, not legal advice. Hits are structure matches from the SureChEMBL extraction and OpenChemLib search, not a claim analysis. Markush coverage is checked only where a translated formula exists. Corpus: ' + snapshotText(o) + '. Expiry is an estimate.';
  }
  function cell(v, sep) {
    var s = v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    if (/^[\t\r ]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;           // spreadsheet formula injection: patent text and user input are data
    return (s.indexOf(sep) >= 0 || /["\n\r]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function expiryText(n) { n = Number(n) || 0; if (!n) return ''; var s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
  function csvRows(results, o) {
    var note0 = limitsNote(o), note = note0, rows = [CSV_COLS];
    arr(results).forEach(function (r) {
      note = note0 + (r.nPatents > arr(r.patents).length ? ' Stored results: only ' + arr(r.patents).length + ' of ' + r.nPatents + ' publications are listed; run the screen again for the full list.' : '');
      var smi = r.parsed ? r.parsed.smiles : '', id = r.id;
      if (!r.ok || !r.parsed) { rows.push([id, r.input, '', 'invalid input', '', '', '', '', '', '', (r.error || 'invalid input') + '. ' + note]); return; }
      var inList = {}; r.patents.forEach(function (e) { inList[e.pn] = 1; });
      var extra = {}, nExtra = 0;
      if (r.markush) r.markush.unclear.forEach(function (x) { if (!inList[x.pn] && !extra[x.pn]) { extra[x.pn] = 1; nExtra++; rows.push([id, r.input, smi, 'markush record', '', x.pn, '', '', '', mkText(r, x.pn), note]); } });
      if (!r.patents.length && !nExtra) { rows.push([id, r.input, smi, r.sub && r.sub.total ? 'substructure (no publication listed)' : 'none', '', '', '', '', '', mkText(r, ''), note]); return; }
      r.patents.forEach(function (e) {
        rows.push([id, r.input, smi, e.routes.join('+'), e.sim != null ? (Math.round(e.sim * 100) / 100).toFixed(2) : '', e.pn, e.inClaims ? 'yes' : 'no', e.status == null ? 'not in table' : (e.status || 'unknown'), expiryText(e.exp), mkText(r, e.pn), note]);
      });
    });
    return rows;
  }
  function mkText(r, pn) {
    var m = r.markush;
    if (!m) return 'not checked';
    var c = m.covered.filter(function (x) { return !pn || x.pn === pn; }), u = m.unclear.filter(function (x) { return !pn || x.pn === pn; }), q = m.queue.filter(function (x) { return !pn || x.pn === pn; });
    if (c.length) return 'covered (claim ' + c.map(function (x) { return x.claim; }).join(', ') + ')' + (c.some(function (x) { return x.caveat; }) ? ', translation not reviewed' : '');
    if (u.length) return 'unclear (claim ' + u.map(function (x) { return x.claim; }).join(', ') + ')';
    if (q.length) return 'formula claim without translation (claim ' + q.map(function (x) { return x.claim; }).join(', ') + ')';
    if (!pn && m.covered.length) return 'covered by a record for another publication';
    return 'no formula claim checked';
  }
  function toCsv(results, o) {
    o = o || {};
    var sep = o.sep || ',';
    return '\ufeff' + csvRows(results, o).map(function (r) { return r.map(function (c) { return cell(c, sep); }).join(sep); }).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------------------------------ store */
  function compact(results) {
    var out = arr(results).map(function (r) {
      var c = { row: r.row, id: r.id, name: r.name, input: r.input, ok: r.ok, error: r.error, errorDetail: r.errorDetail || undefined, parsed: r.parsed ? { kind: r.parsed.kind, name: r.parsed.name, id: r.parsed.id, smiles: r.parsed.smiles, formula: r.parsed.formula, mw: r.parsed.mw } : null,
        exact: r.exact.slice(0, 5), sub: { total: r.sub.total, hits: r.sub.hits.slice(0, 5), capped: r.sub.capped }, sim: r.sim.slice(0, 6), simTotal: r.simTotal,
        patents: r.patents.slice(0, 40).map(function (e) { return { p: e.p, pn: e.pn, routes: e.routes, inClaims: e.inClaims, where: e.where, family: e.family, sim: e.sim, status: e.status, exp: e.exp, inForce: e.inForce, via: e.via.slice(0, 2), routeClaims: e.routeClaims }; }),
        nPatents: r.patents.length, flags: r.flags, markush: r.markush ? { covered: r.markush.covered, unclear: r.markush.unclear.slice(0, 10), queue: r.markush.queue.slice(0, 20), notCovered: r.markush.notCovered, checked: r.markush.checked } : null, ms: r.ms };
      return c;
    });
    var txt = JSON.stringify(out);
    return txt.length <= MAX_STORE_CHARS ? out : null;
  }
  function newId() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }
  function st() { return eng('store'); }
  function save(doc) {
    if (!doc || !arr(doc.rows).length) return Promise.reject(mkErr('empty', 'nothing to save'));
    var id = doc.id || newId(), now = new Date().toISOString();
    var value = { v: 1, id: id, name: str(doc.name).slice(0, 120) || 'Screen ' + now.slice(0, 10), created: doc.created || now, updated: now,
      rows: arr(doc.rows).slice(0, MAX_ROWS).map(function (r) { return { row: r.row, id: r.id, name: r.name || '', input: r.input, alt: r.alt || undefined }; }), opts: doc.opts || null,
      summary: doc.results ? summary(doc.results) : (doc.summary || null), snapshot: doc.snapshot || snapshotText(), results: doc.results ? compact(doc.results) : null };
    var s = st();
    if (s) return Promise.resolve(s.put(KIND, id, value)).then(function () { return value; });
    S.mem[id] = JSON.stringify(value); return Promise.resolve(value);
  }
  function load(id) {
    var s = st();
    if (s) return Promise.resolve(s.get(KIND, id));
    return Promise.resolve(S.mem[id] ? JSON.parse(S.mem[id]) : null);
  }
  function list() {
    var s = st();
    var p = s ? Promise.resolve(s.list(KIND)) : Promise.resolve(Object.keys(S.mem).map(function (k) { return JSON.parse(S.mem[k]); }));
    return p.then(function (rows) { return arr(rows).filter(function (r) { return r && r.v === 1 && Array.isArray(r.rows); }).sort(function (a, b) { return str(b.updated).localeCompare(str(a.updated)); }); });
  }
  function remove(id) {
    var s = st();
    if (s) return Promise.resolve(s.remove(KIND, id)).then(function () { return true; });
    delete S.mem[id]; return Promise.resolve(true);
  }

  function limits() {
    return ['Structure matches come from the SureChEMBL extraction and the OpenChemLib search; a hit is not a claim analysis.',
      'A compound that matches nothing is not necessarily free to use: generic (Markush) claims cover compounds that no publication names.',
      'Markush coverage is checked only where a translated formula exists (curated or saved records); other formula claims are queued for translation.',
      'Corpus: ' + snapshotText() + '. Legal status and expiry are estimates from the register snapshot.',
      'Pre-screening, not legal advice.'];
  }
  function configure(o) { o = o || {}; Object.keys(o).forEach(function (k) { S.eng[k] = o[k]; }); return api; }

  var api = { MAX_ROWS: MAX_ROWS, MAX_STORE_CHARS: MAX_STORE_CHARS, CSV_COLUMNS: CSV_COLS, parseInput: parseInput, resolve: resolve, run: run, summary: summary, toCsv: toCsv, csvRows: csvRows, compact: compact,
    save: save, load: load, list: list, remove: remove, limits: limits, snapshotText: snapshotText, limitsNote: limitsNote, configure: configure, _internal: { strongSmiles: strongSmiles, cell: cell, tokenize: tokenize } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpScreen = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
