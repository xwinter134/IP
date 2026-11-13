/* LNP-FTO pre-screen chain (global LnpFto). Plain script, no dependencies of its own; calls LnpAI, LnpFtoPrompts,
   LnpFtoRender, LnpData, LnpSearch, LnpChem and LnpStore (all replaceable through configure(), which the tests use).
   Method: docs/method/FTO_METHOD.md, prompts: docs/method/prompts.md.
   Chain: A product normalisation -> candidates (deterministic search) -> T triage -> per patent B claim chart,
   C dependent claims, E red team -> app-built digest -> D synthesis. Calls to Claude are strictly sequential.
   What the app decides itself and never leaves to the model:
   - chemistry descriptors of the user's lipids (LnpChem),
   - legal status, in-force-in-DE flag and expiry estimate (LnpData.status), jurisdiction logic,
   - quote verification: a quoted claim feature must be a substring of the claim text (whitespace-normalised),
   - the literal result of a claim, recomputed from the feature rows,
   - the final risk of a patent = the more adverse of chart (B) and red team (E), never lowered automatically,
   - the limits block at the top and at the bottom of every rendering.
   Equivalence is reported as a question for counsel and never changes a result by itself. */
(function (g) {
  'use strict';
  var cfg = {};
  function eng(name) { return cfg[name] || g[{ data: 'LnpData', search: 'LnpSearch', chem: 'LnpChem', store: 'LnpStore', ai: 'LnpAI', prompts: 'LnpFtoPrompts', render: 'LnpFtoRender' }[name]] || null; }
  /* optional evidence engines (x-markush.js, x-ranges.js): configure({markush: false}) switches one off explicitly */
  function xeng(name) { if (Object.prototype.hasOwnProperty.call(cfg, name)) return cfg[name] || null; return g[{ markush: 'LnpMarkush', ranges: 'LnpRanges' }[name]] || null; }
  function mkErr(code, message, extra) { var e = { code: code, message: message || code }, k; if (extra) for (k in extra) e[k] = extra[k]; return e; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function str(x) { return x == null ? '' : String(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')); return isFinite(n) ? n : null; }

  // ------------------------------------------------------------------------------------------------ scales
  var RISK_RANK = { '1_sehr_gering': 1, '2_gering': 2, '3_mittel': 3, 'nicht_beurteilbar': 3.5, '4_hoch': 4, '5_sehr_hoch': 5 };
  var LIT_RANK = { wortsinngemaess_nicht_erfuellt: 0, nicht_beurteilbar: 1, wortsinngemaess_moeglich: 2, wortsinngemaess_erfuellt: 3 };
  var EQ_RANK = { entfaellt: 0, gering: 1, nicht_beurteilbar: 2, mittel: 3, hoch: 4 };
  var DEPTH = { quick: { n: 5, dep: false, red: false, dead: false }, standard: { n: 10, dep: true, red: true, dead: false }, deep: { n: 20, dep: true, red: true, dead: true } };
  /* English wording of the internal codes, for the notes the app writes itself */
  var RISK_TXT = { '5_sehr_hoch': 'very high (5)', '4_hoch': 'high (4)', '3_mittel': 'medium (3)', '2_gering': 'low (2)', '1_sehr_gering': 'very low (1)', nicht_beurteilbar: 'cannot be assessed' };
  var LIT_TXT = { wortsinngemaess_erfuellt: 'literally met', wortsinngemaess_moeglich: 'literally possible', wortsinngemaess_nicht_erfuellt: 'literally not met', nicht_beurteilbar: 'cannot be assessed' };
  function rl(r) { return RISK_TXT[r] || str(r); }
  function ll(l) { return LIT_TXT[l] || str(l); }
  function riskRank(r) { return RISK_RANK[r] || 0; }
  /* the more adverse of two risk levels; "nicht_beurteilbar" ranks between 3 and 4 */
  function maxRisk(a, b) { if (!RISK_RANK[a]) return RISK_RANK[b] ? b : null; if (!RISK_RANK[b]) return a; return RISK_RANK[b] > RISK_RANK[a] ? b : a; }
  function worseLiteral(a, b) { if (!(a in LIT_RANK)) return (b in LIT_RANK) ? b : null; if (!(b in LIT_RANK)) return a; return LIT_RANK[b] > LIT_RANK[a] ? b : a; }
  /* literal result of a claim from its feature verdicts (FTO_METHOD 7.4) */
  function literalFromVerdicts(vs) {
    if (!vs.length) return 'nicht_beurteilbar';
    var miss = false, unclear = false, i;
    for (i = 0; i < vs.length; i++) { if (vs[i] === 'nicht_erfuellt') miss = true; else if (vs[i] !== 'erfuellt') unclear = true; }
    return miss ? 'wortsinngemaess_nicht_erfuellt' : unclear ? 'wortsinngemaess_moeglich' : 'wortsinngemaess_erfuellt';
  }

  // ------------------------------------------------------------------------------------------------ small tools
  function hash(s) {
    s = String(s);
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 13; }
    return ('0000000' + (h1 >>> 0).toString(16)).slice(-8) + ('0000000' + (h2 >>> 0).toString(16)).slice(-8);
  }
  function nowDate() { return cfg.now ? new Date(cfg.now()) : new Date(); }
  function today() { return nowDate().toISOString().slice(0, 10); }
  function ymd(n) { var s = String(n || ''); return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : (/^\d{4}-\d\d-\d\d/.test(s) ? s.slice(0, 10) : null); }
  function addYears(d, y) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(str(d)); return m ? (Number(m[1]) + y) + '-' + m[2] + '-' + m[3] : null; }
  function daysBetween(a, b) { var x = Date.parse(a), y = Date.parse(b); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 864e5) : null; }

  // ------------------------------------------------------------------------------------------------ quote check
  function normWs(s) { return str(s).replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '').replace(/\u2039/g, '<').replace(/\s+/g, ' ').trim(); }
  function normLoose(s) {
    return normWs(s).toLowerCase().replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, '\'').replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb\u2033]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  }
  /* verifyQuote(quote, text) -> {status, verified, near}
     "ok": the quote is a substring of the text after whitespace normalisation (the only status that counts as
     verified); "elided": the quote contains an ellipsis and all its pieces occur in order; "approx": it matches only
     after folding case and typographic quotes/dashes or without surrounding punctuation; "fail": not found;
     "empty": no quote. "elided" and "approx" are near misses (near = true): shown as deviating, not as invented. */
  function verifyQuote(quote, text) {
    var q = normWs(quote), t = normWs(text), i;
    if (q.length < 2) return { status: 'empty', verified: false, near: false };
    if (t.indexOf(q) >= 0) return { status: 'ok', verified: true, near: false };
    var segs = q.split(/\s*(?:\[\s*(?:\.\.\.|\u2026)\s*\]|\(\s*(?:\.\.\.|\u2026)\s*\)|\.\.\.|\u2026)\s*/).filter(function (x) { return x.length > 0; });
    if (segs.length > 1) {
      var pos = 0, all = true;
      for (i = 0; i < segs.length; i++) { if (segs[i].length < 4) { all = false; break; } var at = t.indexOf(segs[i], pos); if (at < 0) { all = false; break; } pos = at + segs[i].length; }
      if (all) return { status: 'elided', verified: false, near: true };
    }
    var ql = normLoose(q), tl = normLoose(t);
    if (tl.indexOf(ql) >= 0) return { status: 'approx', verified: false, near: true };
    var q2 = ql.replace(/^["'\s(\[]+|["'\s.,;:)\]]+$/g, '');
    if (q2.length >= 8 && tl.indexOf(q2) >= 0) return { status: 'approx', verified: false, near: true };
    return { status: 'fail', verified: false, near: false };
  }

  // ------------------------------------------------------------------------------------------------ store
  var memStore = (function () {
    var m = {};
    return {
      init: function () { return Promise.resolve({ backend: 'memory' }); },
      get: function (k, id) { var v = m[k + '/' + id]; return Promise.resolve(v === undefined ? null : JSON.parse(v)); },
      put: function (k, id, o) { m[k + '/' + id] = JSON.stringify(o); return Promise.resolve(true); },
      remove: function (k, id) { delete m[k + '/' + id]; return Promise.resolve(true); },
      list: function (k) { var out = [], key; for (key in m) if (key.indexOf(k + '/') === 0) { var o = JSON.parse(m[key]); if (o && typeof o === 'object' && o.id === undefined) o.id = key.slice(k.length + 1); out.push(o); } return Promise.resolve(out); }
    };
  })();
  var KIND = 'opinions', CHUNK = 60000;
  function store() { return eng('store') || memStore; }
  function partId(id, key) { return id + '--' + String(key).replace(/[^A-Za-z0-9]/g, '_'); }
  /* a saved step: {part: 1, head: opinion id, key, n: number of chunks, s: JSON text (first chunk)}; further chunks
     live in <id>-c<i>. Documents stay well under 200 KiB. */
  function putPart(id, key, obj) {
    var s = JSON.stringify(obj), st = store(), pid = partId(id, key), n = Math.max(1, Math.ceil(s.length / CHUNK)), chain, i;
    chain = Promise.resolve(st.put(KIND, pid, { part: 1, head: id, key: key, n: n, s: s.slice(0, CHUNK) }));
    for (i = 1; i < n; i++) (function (i) { chain = chain.then(function () { return st.put(KIND, pid + '-c' + i, { part: 1, head: id, key: key, c: i, s: s.slice(i * CHUNK, (i + 1) * CHUNK) }); }); })(i);
    return chain.then(function () { return n; });
  }
  function getPart(id, key) {
    var st = store(), pid = partId(id, key);
    return Promise.resolve(st.get(KIND, pid)).then(function (d) {
      if (!d || typeof d.s !== 'string') return null;
      var chain = Promise.resolve(d.s), i;
      for (i = 1; i < (d.n || 1); i++) (function (i) { chain = chain.then(function (s) { return s === null ? null : Promise.resolve(st.get(KIND, pid + '-c' + i)).then(function (c) { return c && typeof c.s === 'string' ? s + c.s : null; }); }); })(i);
      return chain.then(function (s) { if (s === null) return null; try { return JSON.parse(s); } catch (e) { return null; } });
    }, function () { return null; });
  }
  function removePart(id, key, n) {
    var st = store(), pid = partId(id, key), chain = Promise.resolve(st.remove(KIND, pid)).then(null, function () { }), i;
    for (i = 1; i < (n || 1); i++) (function (i) { chain = chain.then(function () { return Promise.resolve(st.remove(KIND, pid + '-c' + i)).then(null, function () { }); }); })(i);
    return chain;
  }

  // ------------------------------------------------------------------------------------------------ step A: profile
  var ROLE_MAP = { ionizable: 'ionizable', ionisable: 'ionizable', cationic: 'ionizable', kationisch: 'ionizable', ionisierbar: 'ionizable', helper: 'helper', phospholipid: 'helper', helfer: 'helper',
    sterol: 'sterol', cholesterol: 'sterol', peg: 'peg', 'peg-lipid': 'peg', peg_lipid: 'peg', other: 'other', sonstiges: 'other' };
  var ROLE_SCHEMA = { helper: 'helferlipid_phospholipid', sterol: 'sterol', peg: 'peg_lipid', other: 'sonstiges', ionizable: 'permanent_kationisch' };
  var MOL_KEY = { ionizable: 'ionizable_lipid', helper: 'phospholipid', sterol: 'sterol', peg: 'peg_lipid', other: 'sonstige' };
  var AMINE_MAP = { primary: 'primaer', secondary: 'sekundaer', tertiary: 'tertiaer', quaternary: 'quartaer' };
  var ROLE_TXT = { helferlipid_phospholipid: 'Helper lipid / phospholipid', sterol: 'Sterol', peg_lipid: 'PEG-lipid', sonstiges: 'Other lipid', permanent_kationisch: 'Permanently cationic lipid' };
  function roleOf(r) { return ROLE_MAP[str(r).toLowerCase().trim()] || 'other'; }

  /* descriptors of one lipid, computed by LnpChem (never by the model) */
  function computeLipid(l) {
    var chem = eng('chem'), out = { role: roleOf(l.role), name: l.name || null, smiles_input: l.smiles || null, ok: false };
    if (!chem) { out.error = 'LnpChem not loaded'; return Promise.resolve(out); }
    var q = l.smiles || l.name;
    if (!q) { out.error = 'no structure and no name'; return Promise.resolve(out); }
    return Promise.resolve().then(function () { return chem.parse(q); }).then(function (pr) {
      if ((!pr || !pr.ok) && l.smiles && l.name) return chem.parse(l.name);
      return pr;
    }).then(function (pr) {
      if (!pr || !pr.ok) { out.error = (pr && pr.error) || 'structure not understood'; return out; }
      out.ok = true; out.source = pr.kind === 'name' ? 'reference lipid name' : pr.kind;
      out.smiles = l.smiles && pr.kind !== 'name' ? l.smiles : pr.smiles; out.smiles_canonical = pr.smiles; out.idcode = pr.idcode || null; out.formula = pr.formula || null; out.mw = pr.mw || null;
      if (pr.name) out.ref_name = pr.name;
      return Promise.resolve(chem.descriptors(pr.smiles)).then(function (d) { out.desc = d || null; return out; }, function (e) { out.desc = null; out.desc_error = str(e && e.message); return out; });
    }).then(function (o) {
      if (!o.ok || !chem.names) return o;
      return Promise.resolve(chem.names()).then(function (names) {
        var key = str(o.name || o.ref_name).toLowerCase().replace(/[\s-]/g, ''), i, n;
        for (i = 0; i < names.length; i++) {
          n = names[i];
          var hit = (o.idcode && n.idcode && n.idcode === o.idcode) || (key && (str(n.name).toLowerCase().replace(/[\s-]/g, '') === key || arr(n.synonyms).some(function (s) { return str(s).toLowerCase().replace(/[\s-]/g, '') === key; })));
          if (hit) { o.ref = { name: n.name, role: n.role || null, inchikey: n.inchikey || null, cid: n.cid || null, note: n.note || null }; break; }
        }
        return o;
      }, function () { return o; });
    }).then(null, function (e) { out.error = str((e && e.message) || e); return out; });
  }
  /* LnpChem.descriptors -> the "descriptors" object of the ProductFeatures schema (+ the full object under "app") */
  function schemaDescriptors(c) {
    var d = c.desc || {}, links = d.links || {}, frags = [], i;
    if (d.headgroup) frags.push({ id: 'F1', rolle: 'kopfgruppe', smiles_fragment: str(d.headgroup.smiles || d.head || ''), c_atoms: null, verzweigt: null, verzweigungsposition: null, doppelbindungen: null, gebunden_an: [],
      app: { klasse: d.head || null, hydroxyl: !!d.headgroup.hasOH, c_zwischen_amin_und_linker: d.headgroup.nCarbonsToAmine, methyl_am_n: d.headgroup.nMethylOnN } });
    arr(d.linkers).forEach(function (l) { frags.push({ id: 'F' + (frags.length + 1), rolle: 'linker', smiles_fragment: l.type + ' x' + l.count, c_atoms: null, verzweigt: null, verzweigungsposition: null, doppelbindungen: null, gebunden_an: [] }); });
    arr(d.tails).forEach(function (t) {
      frags.push({ id: 'F' + (frags.length + 1), rolle: 'kette', smiles_fragment: str(t.smiles), c_atoms: t.nC == null ? null : t.nC, verzweigt: !!t.branched,
        verzweigungsposition: t.branched ? ('position ' + t.branchPosition + (arr(t.arms).length ? ', arms ' + t.arms.join('+') + ' C' : '')) : null, doppelbindungen: t.nDoubleBonds == null ? null : t.nDoubleBonds, gebunden_an: [],
        app: { acyl: !!t.acyl, dreifachbindungen: t.nTripleBonds || 0, methylverzweigungen: t.nMethylBranches || 0, ring: !!t.hasRing } });
    });
    var nAm = 0, am = d.amines || {}, k;
    for (k in am) if (am[k] > 0 && k !== 'amide' && k !== 'aromatic') nAm += am[k];
    for (i = 0; i < frags.length; i++) if (frags[i].app === undefined) delete frags[i].app;
    return {
      formula: d.formula || c.formula || null, mw: num(d.mw != null ? d.mw : c.mw), c_atoms_total: d.el && d.el.C != null ? d.el.C : (d.totalCarbons != null ? d.totalCarbons : null), n_atoms: d.nN != null ? d.nN : null,
      n_ester: links.ester != null ? links.ester : null, n_amide: links.amide != null ? links.amide : null, n_carbonate: links.carbonate != null ? links.carbonate : null, n_ether: links.ether != null ? links.ether : null,
      n_hydroxyl: links.hydroxyl != null ? links.hydroxyl : null, n_disulfide: links.disulfide != null ? links.disulfide : null, n_double_bonds_cc: d.tailDoubleBonds != null ? d.tailDoubleBonds : null,
      amine_type: nAm > 1 ? 'mehrere' : (d.amine && AMINE_MAP[d.amine.class]) || null, fragments: frags,
      zaehlkonvention: 'Computed by the app (OpenChemLib), not by the model. A chain (kette) is a hydrocarbon group of 6 or more carbons on one hetero atom or carbonyl carbon; c_atoms of an acyl chain (app.acyl = true) INCLUDES the carbonyl carbon; verzweigungsposition counts from the atom the chain hangs on; arms = chain lengths after the first branch point; n_double_bonds_cc counts C=C in the chains only.',
      app: { head: d.head || null, amine: d.amine || null, nTails: d.nTails, nChainEnds: d.nChainEnds, tailCarbons: d.tailCarbons, nBranchedTails: d.nBranchedTails, biodegradable: d.biodegradable, rings: d.rings, charge: d.charge, logPest: d.logPest, links: links }
    };
  }
  var MIX_MAP = [[/t[- ]?(st(ue|\u00fc)ck|junction|connector|mix)/i, 't_stueck'], [/imping/i, 'impinging_jet'], [/herring|shm/i, 'mikrofluidik_herringbone'], [/toroid|bifurc|nanoassemblr|ignite|mikrofluid|microfluid/i, 'mikrofluidik_bifurkierend_toroidal'],
    [/injekt|injection/i, 'ethanol_injektion'], [/extru/i, 'extrusion']];
  var STAGE_MAP = [[/kommerz|commerc|markt|market/i, 'kommerziell'], [/zulassung|approval|bla|maa/i, 'zulassung_beantragt'], [/phase\s*(3|iii)/i, 'klinik_phase_3'], [/pr(ae|\u00e4|e)-?klin|pre-?clin/i, 'praeklinik'], [/phase|klini|clinic/i, 'klinik_phase_1_2'], [/pr(ae|\u00e4|e)klin|gmp|tox/i, 'praeklinik'], [/forsch|research|labor|discovery/i, 'forschung']];
  var PAYLOAD_MAP = [[/sa-?rna|self[- ]?ampl/i, 'saRNA'], [/circ/i, 'circRNA'], [/crispr|grna|cas9/i, 'CRISPR_mRNA_gRNA'], [/sirna/i, 'siRNA'], [/\baso\b|antisense/i, 'ASO'], [/pdna|plasmid|\bdna\b/i, 'pDNA'], [/mrna|messenger/i, 'mRNA'], [/leer|empty|none|ohne/i, 'leer']];
  function mapFirst(map, v, enumOk) { var s = str(v), i; if (!s) return null; if (enumOk && enumOk.indexOf(s) >= 0) return s; for (i = 0; i < map.length; i++) if (map[i][0].test(s)) return map[i][1]; return 'sonstiges'; }
  function marketsOf(list) {
    var out = [], seen = {};
    arr(list).forEach(function (m) { m = str(m).toUpperCase().trim(); if (m === 'EU' || m === 'EPA' || m === 'EPO') m = 'EP'; if (/^(DE|EP|UPC|US)$/.test(m) && !seen[m]) { seen[m] = 1; out.push(m); } });
    return out;
  }
  /* deterministic profile from the form (used alone when Claude is not available, and as the frame that the
     model output is checked against) */
  function baseProfile(input, lipids, lang) {
    var P = [], i;
    function feat(kat, text, wert, einheit, quelle, sicher) { P.push({ id: 'P' + (P.length + 1), kategorie: kat, aussage: text, wert: wert === undefined ? null : wert, einheit: einheit || null, quelle: quelle || 'nutzer', sicherheit: sicher || 'hoch' }); }
    var ion = null, others = [], mol = { ionizable_lipid: null, phospholipid: null, sterol: null, peg_lipid: null, sonstige: null };
    lipids.forEach(function (c, k) {
      var src = arr(input.lipids)[k] || {}, mp = num(src.molPct != null ? src.molPct : src.mol), key = MOL_KEY[c.role];
      if (mp !== null) mol[key] = (mol[key] || 0) + mp;
      if (c.role === 'ionizable' && !ion) ion = { c: c, src: src }; else others.push({ c: c, src: src });
    });
    var il = { name_user: null, name_normalised: null, cas: null, smiles: null, inchikey: null, descriptors: {}, pka_apparent: null, pka_methode: null, strukturbeschreibung: '', quelle: 'nutzer' };
    if (ion) {
      var c = ion.c, d = c.desc;
      il.name_user = c.name; il.name_normalised = (c.ref && c.ref.name) || null; il.cas = ion.src.cas || null; il.smiles = c.ok ? c.smiles : (c.smiles_input || null); il.inchikey = (c.ref && c.ref.inchikey) || null;
      il.pka_apparent = num(ion.src.pka); il.pka_methode = ion.src.pkaMethod || null; il.quelle = c.ok && c.source === 'reference lipid name' ? 'berechnet' : 'nutzer';
      if (c.ok && d) {
        il.descriptors = schemaDescriptors(c);
        var tails = arr(d.tails).map(function (t) { return (t.acyl ? 'Acyl ' : '') + 'C' + t.nC + (t.branched ? ' branched at position ' + t.branchPosition + (arr(t.arms).length ? ' (' + t.arms.join('+') + ')' : '') : ' linear') + (t.nDoubleBonds ? ', ' + t.nDoubleBonds + ' C=C' : ''); });
        var lk = arr(d.linkers).map(function (l) { return l.count + ' x ' + l.type; });
        il.strukturbeschreibung = 'Computed by the app: head group ' + str(d.head) + (d.headgroup && d.headgroup.smiles ? ' ' + d.headgroup.smiles + '' : '') +
          '; amine: ' + str(d.amine && d.amine.class) + '; linkers: ' + (lk.join(', ') || '-') + '; chains: ' + (tails.join(' | ') || '-') + '.';
        feat('lipid_struktur', 'Ionizable lipid: ' + str(c.name || c.ref_name || '') + ' SMILES ' + il.smiles, il.smiles, null, il.quelle);
        feat('lipid_struktur', 'Formula / molecular weight' + ': ' + str(il.descriptors.formula) + ' / ' + str(il.descriptors.mw), il.descriptors.formula, null, 'berechnet');
        feat('lipid_struktur', 'Head group and amine' + ': ' + str(d.head) + ', ' + str(d.amine && d.amine.class) + ' ' + str(d.amine && d.amine.count) + '', str(d.head), null, 'berechnet');
        feat('lipid_struktur', 'Linkers' + ': ' + (lk.join(', ') || '-'), lk.join(', ') || null, null, 'berechnet');
        tails.forEach(function (t, k) { feat('lipid_struktur', 'Chain ' + (k + 1) + ': ' + t + ' (acyl: carbonyl carbon counted)', arr(d.tails)[k].nC, 'C', 'berechnet'); });
        feat('lipid_struktur', 'Total carbon atoms' + ': ' + str(il.descriptors.c_atoms_total), il.descriptors.c_atoms_total, 'C', 'berechnet');
      } else {
        il.strukturbeschreibung = 'The app could not read the structure; descriptors are missing.';
        if (c.name || c.smiles_input) feat('lipid_struktur', 'Ionizable lipid: ' + str(c.name || c.smiles_input), c.name || c.smiles_input, null, 'nutzer', 'mittel');
      }
      if (il.pka_apparent !== null) feat('lipid_struktur', 'pKa (apparent)' + (il.pka_methode ? ', ' + il.pka_methode : ''), il.pka_apparent, null, 'nutzer');
    }
    var wl = others.map(function (o) {
      var c = o.c, role = c.role === 'ionizable' ? 'permanent_kationisch' : ROLE_SCHEMA[c.role];
      feat('komponente', ((ROLE_TXT[role] || role)) + ': ' + str(c.name || c.ref_name || c.smiles_input || ''), c.name || c.ref_name || null, null, 'nutzer');
      return { rolle: role, name_user: c.name || null, name_normalised: (c.ref && c.ref.name) || null, smiles: c.ok ? c.smiles : (c.smiles_input || null), peg_mw: num(o.src.pegMw), anker_kettenlaenge_c: null, anker_typ: null, quelle: 'nutzer' };
    });
    for (i in mol) if (mol[i] !== null) feat('verhaeltnis', 'mol-% ' + (({ ionizable_lipid: 'ionizable lipid', peg_lipid: 'PEG-lipid', sonstige: 'other' }[i] || i)), mol[i], 'mol-%', 'nutzer');
    var np = num(input.np != null ? input.np : input.npRatio);
    if (np !== null) feat('verhaeltnis', 'N/P', np, null, 'nutzer');
    var pay = input.payload || {}, part = input.particle || {}, proc = input.process || {}, form = input.formulation || {}, use = input.use || {};
    if (typeof pay === 'string') pay = { type: pay };
    var payTyp = mapFirst(PAYLOAD_MAP, pay.type, ['mRNA', 'saRNA', 'siRNA', 'ASO', 'pDNA', 'circRNA', 'CRISPR_mRNA_gRNA', 'leer', 'sonstiges']);
    if (payTyp) feat('payload', 'Payload: ' + str(pay.type) + (pay.modification ? ', ' + pay.modification : ''), payTyp, null, 'nutzer');
    [['sizeNm', 'Particle size', 'nm'], ['pdi', 'PDI', null], ['encapsulationPct', 'Encapsulation', '%'], ['zetaMv', 'Zeta', 'mV']].forEach(function (x) {
      var v = num(part[x[0]]); if (v !== null) feat('partikel', x[1] + (x[0] === 'sizeNm' && part.sizeMethod ? ' ' + part.sizeMethod + '' : ''), v, x[2], 'nutzer');
    });
    var mix = mapFirst(MIX_MAP, proc.mixing, ['t_stueck', 'impinging_jet', 'mikrofluidik_herringbone', 'mikrofluidik_bifurkierend_toroidal', 'ethanol_injektion', 'extrusion', 'sonstiges']);
    if (mix) feat('verfahren', 'Mixing principle: ' + str(proc.mixing), mix, null, 'nutzer');
    [['frr', 'Flow rate ratio aqueous:organic', null], ['tfr', 'Total flow rate', 'mL/min'], ['ethanolPct', 'Ethanol at mixing', '%'], ['ph', 'pH at mixing', null], ['tempC', 'Temperature', '\u00b0C']].forEach(function (x) {
      var v = num(proc[x[0]]); if (v !== null) feat('verfahren', x[1], v, x[2], 'nutzer');
    });
    if (proc.buffer) feat('verfahren', 'Aqueous buffer: ' + proc.buffer, proc.buffer, null, 'nutzer');
    if (proc.site) feat('verfahren', 'Manufacturing site: ' + proc.site, proc.site, null, 'nutzer');
    if (form.buffer || form.cryo || form.lyo != null || form.storage) feat('formulierung', 'Formulation/storage: ' + [form.buffer, form.cryo, form.lyo ? 'lyophilised' : null, form.storage].filter(Boolean).join('; '), null, null, 'nutzer');
    if (use.route) feat('anwendung', 'Route: ' + use.route, use.route, null, 'nutzer');
    if (use.indication) feat('anwendung', 'Indication class: ' + use.indication, use.indication, null, 'nutzer');
    var markets = marketsOf(input.markets || input.countries), launch = input.launchDate || input.launch || null;
    if (!markets.length) markets = ['DE', 'EP', 'US'];
    var akte = arr(input.acts).filter(function (a) { return a && a.akt; }).map(function (a) { return { land: str(a.land || ''), akt: a.akt, zeitpunkt: a.zeitpunkt === 'derzeit' ? 'derzeit' : 'geplant', geplant_ab: a.geplant_ab || null, zweck: a.zweck || null }; });
    if (!akte.length && launch) markets.forEach(function (m) { if (m !== 'UPC') akte.push({ land: m, akt: 'inverkehrbringen', zeitpunkt: 'geplant', geplant_ab: str(launch), zweck: null }); });
    if (launch) feat('handlung', 'Planned launch: ' + launch + ' (' + markets.join(', ') + ')', str(launch), null, 'nutzer');
    var names = [];
    lipids.forEach(function (c) { [c.name, c.ref_name, c.ref && c.ref.name].forEach(function (n) { if (n && names.indexOf(n) < 0) names.push(n); }); });
    arr(input.lipids).forEach(function (l) { if (l && l.cas && names.indexOf(l.cas) < 0) names.push(l.cas); });
    return {
      schema_version: 'pf-1', output_language: 'en', bezeichnung: str(input.name || input.bezeichnung || 'LNP product'),
      ionizable_lipid: il, weitere_lipide: wl,
      zusammensetzung: { molprozent: mol, basis: /gemessen|measured/i.test(str(input.ratioBasis)) ? 'gesamtlipid_gemessen_partikel' : (/nominal|einsatz|input/i.test(str(input.ratioBasis)) ? 'gesamtlipid_nominal_einsatz' : 'unbekannt'), np_verhaeltnis: np,
        lipid_zu_nukleinsaeure_gewicht: num(input.lipidToNaWeight), chargenvariabilitaet: input.batchVariability || null },
      payload: { typ: payTyp, nukleosidmodifikation: pay.modification || null, laenge_nt: num(pay.lengthNt) === null ? null : Math.round(num(pay.lengthNt)), kodiert_fuer: pay.encodes || null, anzahl_spezies: num(pay.species) === null ? null : Math.round(num(pay.species)) },
      partikel: { groesse_nm: num(part.sizeNm), groesse_methode: part.sizeMethod || null, pdi: num(part.pdi), verkapselung_prozent: num(part.encapsulationPct), zeta_mv: num(part.zetaMv), morphologie: part.morphology || null },
      verfahren: { mischprinzip: mix, geraet: proc.device || null, flussratenverhaeltnis_waessrig_zu_organisch: num(proc.frr), gesamtflussrate_ml_min: num(proc.tfr), loesungsmittel: proc.solvent || null, ethanol_prozent_bei_mischung: num(proc.ethanolPct),
        waessriger_puffer: proc.buffer || null, ph_bei_mischung: num(proc.ph), temperatur_c: num(proc.tempC), nachbehandlung: arr(proc.post).map(str), schritte_frei: arr(proc.steps).map(str), ort_der_herstellung: proc.site || null,
        hersteller: /cdmo|lohn/i.test(str(proc.maker)) ? 'cdmo' : /partner|koop/i.test(str(proc.maker)) ? 'kooperationspartner' : (proc.maker ? 'selbst' : null) },
      formulierung_lagerung: { endpuffer: form.buffer || null, kryoprotektor: form.cryo || null, lyophilisiert: form.lyo == null ? null : !!form.lyo, lagerung: form.storage || null },
      anwendung: { applikationsweg: use.route || null, indikationsklasse: use.indication || null, zielgewebe: use.tissue || null, dosis: use.dose || null },
      handlungen: { entwicklungsstand: input.stage ? (mapFirst(STAGE_MAP, input.stage, ['forschung', 'praeklinik', 'klinik_phase_1_2', 'klinik_phase_3', 'zulassung_beantragt', 'kommerziell']) === 'sonstiges' ? null : mapFirst(STAGE_MAP, input.stage, ['forschung', 'praeklinik', 'klinik_phase_1_2', 'klinik_phase_3', 'zulassung_beantragt', 'kommerziell'])) : null,
        maerkte: markets, akte: akte, regulatorischer_zweck: input.regulatoryPurpose || null, oeffentlicher_auftraggeber_us: input.usGovernment == null ? null : !!input.usGovernment },
      merkmalsliste: P, annahmen: [], offene_fragen: [],
      suchbegriffe: { namen_codes: names, klassenbegriffe_en: [], klassenbegriffe_de: [], verfahrensbegriffe: [] }
    };
  }
  /* normalizeProfile(input, {signal, lang, onEvent}) -> ProductFeatures (schema pf-1) with an extra "_app" block.
     input: {name, lipids: [{role: ionizable|helper|sterol|peg|other, name, smiles, molPct, pka, pegMw, cas}], ratioBasis, np,
       payload: {type, modification, lengthNt, encodes}, particle: {sizeNm, sizeMethod, pdi, encapsulationPct, zetaMv, morphology},
       process: {mixing, device, frr, tfr, solvent, ethanolPct, buffer, ph, tempC, post[], site, maker}, formulation: {buffer, cryo, lyo, storage},
       use: {route, indication, tissue, dose}, stage, markets | countries: ["DE","EP","US"], launchDate, acts[], freeText, lang}
     Structures are parsed and described by LnpChem; Claude (step A) only arranges and words the profile. Whatever the
     model returns for SMILES and descriptors is replaced by the app's values. Without Claude the deterministic profile
     is returned (_app.model = false). */
  /* englishForm(form) -> a copy of a profile form whose option values are English. Profiles saved by older versions carry
     the German option values of the old form (e.g. stage "Pr\u00e4klinik", mixing "T-St\u00fcck", route "intraven\u00f6s"); they
     would otherwise reach the report as free text. Unknown values are kept as they are. */
  var LEGACY_FORM = {
    stage: { 'Forschung': 'Research', 'Pr\u00e4klinik': 'Preclinical', 'Klinik Phase 1/2': 'Clinical phase 1/2', 'Klinik Phase 3': 'Clinical phase 3', 'Zulassung beantragt': 'Approval applied for', 'Kommerziell': 'Commercial' },
    type: { 'leer (ohne Wirkstoff)': 'empty (no payload)' },
    mixing: { 'T-St\u00fcck': 'T-junction', 'Impinging-Jet-Mischer': 'Impinging jet mixer', 'Mikrofluidik Herringbone': 'Microfluidic herringbone', 'Mikrofluidik toroidal': 'Microfluidic toroidal', 'Ethanol-Injektion': 'Ethanol injection', 'sonstiges': 'Other' },
    route: { 'intraven\u00f6s': 'Intravenous', 'intramuskul\u00e4r': 'Intramuscular', 'subkutan': 'Subcutaneous', 'inhalativ': 'Inhaled', 'intratumoral': 'Intratumoral', 'intrathekal': 'Intrathecal', 'topisch': 'Topical', 'andere': 'Other' },
    ratioBasis: { 'gemessen': 'measured' }
  };
  /* English text of an internal code for text that the model or the user reads (LnpFtoRender.label when loaded) */
  function codeText(c) { var R = eng('render'); return R && typeof R.label === 'function' ? R.label(c) : str(c).replace(/_/g, ' '); }
  function englishForm(src) {
    if (!src || typeof src !== 'object') return src;
    function m(kind, v) { return v != null && Object.prototype.hasOwnProperty.call(LEGACY_FORM[kind], v) ? LEGACY_FORM[kind][v] : v; }
    function sub(o, k, kind) { if (!o || typeof o !== 'object' || o[k] == null) return o; var c = {}, x; for (x in o) if (Object.prototype.hasOwnProperty.call(o, x)) c[x] = o[x]; c[k] = m(kind, o[k]); return c; }
    var out = {}, k;
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    if (out.stage != null) out.stage = m('stage', out.stage);
    if (out.ratioBasis != null) out.ratioBasis = m('ratioBasis', out.ratioBasis);
    out.payload = sub(out.payload, 'type', 'type'); out.process = sub(out.process, 'mixing', 'mixing'); out.use = sub(out.use, 'route', 'route');
    return out;
  }
  function normalizeProfile(input, o) {
    o = o || {}; input = input || {};
    input = englishForm(input);
    var lang = 'en', ai = eng('ai'), P = eng('prompts'), warnings = [];
    return Promise.all(arr(input.lipids).map(function (l) { return computeLipid(l || {}); })).then(function (lipids) {
      lipids.forEach(function (c) { if (!c.ok) warnings.push('Structure not read: ' + str(c.name || c.smiles_input) + ' ' + str(c.error) + ''); });
      var base = baseProfile(input, lipids, lang);
      function finish(p, model, note) {
        if (note) warnings.push(note);
        p._app = { v: 1, model: !!model, created: nowDate().toISOString(), lang: lang, form: clone(input), lipids: lipids.map(function (c) { var x = clone(c); return x; }), warnings: warnings };
        return p;
      }
      return Promise.resolve(ai ? ai.init() : false).then(function (ok) {
        if (!ok || !P) return finish(base, false, 'Built without Claude: profile from the form fields only, free text not evaluated.');
        var computed = lipids.map(function (c) { return { rolle: c.role, name: c.name, ok: c.ok, smiles: c.ok ? c.smiles : null, referenzname: (c.ref && c.ref.name) || null, inchikey: (c.ref && c.ref.inchikey) || null, descriptors: c.ok && c.desc ? schemaDescriptors(c) : null, fehler: c.error || null }; });
        var req = P.buildA({ lang: lang, input: input, computed: computed });
        return ai.json(req.parts, { schema: req.schema, tier: 'A', signal: o.signal, label: 'A', onText: o.onEvent ? function (u) { o.onEvent({ type: 'text', section: 'A', text: u.text }); } : undefined }).then(function (m) {
          return finish(mergeProfile(base, m, lang, warnings), true);
        }, function (e) {
          if (e && e.code === 'cancelled') throw e;
          return finish(base, false, 'Step A (Claude) failed, profile from the form fields only: ' + (ai.message ? ai.message(e, lang) : str(e && e.code)));
        });
      });
    });
  }
  /* model output of step A, with every chemistry and number field that the app knows put back */
  function mergeProfile(base, m, lang, warnings) {
    var out = clone(m), k;
    out.schema_version = 'pf-1'; out.output_language = base.output_language;
    var bi = base.ionizable_lipid, mi = out.ionizable_lipid || {};
    if (str(mi.smiles) !== str(bi.smiles) && mi.smiles) warnings.push('SMILES from the model reply discarded (differs from the input).');
    mi.smiles = bi.smiles; mi.inchikey = bi.inchikey; mi.descriptors = bi.descriptors; mi.name_user = bi.name_user; mi.cas = bi.cas;
    mi.pka_apparent = bi.pka_apparent; mi.pka_methode = bi.pka_methode || mi.pka_methode || null;
    if (!mi.strukturbeschreibung) mi.strukturbeschreibung = bi.strukturbeschreibung; else if (bi.strukturbeschreibung) mi.strukturbeschreibung = mi.strukturbeschreibung + ' [' + bi.strukturbeschreibung + ']';
    out.ionizable_lipid = mi;
    var allowed = {}; base.weitere_lipide.forEach(function (l) { if (l.smiles) allowed[l.smiles] = 1; });
    out.weitere_lipide = arr(out.weitere_lipide).map(function (l, i) {
      var b = base.weitere_lipide[i];
      if (l.smiles && !allowed[l.smiles]) { l.smiles = b && b.rolle === l.rolle ? b.smiles : null; }
      if (b && b.rolle === l.rolle) { l.name_user = b.name_user; if (b.peg_mw !== null) l.peg_mw = b.peg_mw; if (!l.smiles) l.smiles = b.smiles; }
      return l;
    });
    out.zusammensetzung = out.zusammensetzung || {}; out.zusammensetzung.molprozent = out.zusammensetzung.molprozent || {};
    for (k in base.zusammensetzung.molprozent) if (base.zusammensetzung.molprozent[k] !== null) out.zusammensetzung.molprozent[k] = base.zusammensetzung.molprozent[k];
    if (base.zusammensetzung.np_verhaeltnis !== null) out.zusammensetzung.np_verhaeltnis = base.zusammensetzung.np_verhaeltnis;
    ['partikel', 'verfahren'].forEach(function (sec) { out[sec] = out[sec] || {}; for (var f in base[sec]) if (typeof base[sec][f] === 'number') out[sec][f] = base[sec][f]; });
    out.handlungen = out.handlungen || {}; out.handlungen.maerkte = base.handlungen.maerkte;
    if (!arr(out.handlungen.akte).length) out.handlungen.akte = base.handlungen.akte;
    // the computed chemistry features are appended so that later steps can always cite them
    var list = arr(out.merkmalsliste).slice(), n = 0;
    list.forEach(function (f) { var x = /^P(\d+)$/.exec(str(f.id)); if (x) n = Math.max(n, Number(x[1])); });
    base.merkmalsliste.forEach(function (f) { if (f.quelle === 'berechnet') { var c = clone(f); c.id = 'P' + (++n); list.push(c); } });
    out.merkmalsliste = list;
    out.suchbegriffe = out.suchbegriffe || {};
    var names = arr(out.suchbegriffe.namen_codes).slice();
    base.suchbegriffe.namen_codes.forEach(function (x) { if (names.indexOf(x) < 0) names.push(x); });
    out.suchbegriffe.namen_codes = names;
    out.annahmen = arr(out.annahmen); out.offene_fragen = arr(out.offene_fragen);
    return out;
  }
  function productForModel(profile, slim) {
    var p = clone(profile) || {};
    delete p._app;
    if (slim && p.ionizable_lipid && p.ionizable_lipid.descriptors) delete p.ionizable_lipid.descriptors.fragments;
    return p;
  }

  // ------------------------------------------------------------------------------------------------ candidates
  var Q_LNP = '("lipid nanoparticle" OR "lipid nanoparticles" OR "nucleic acid-lipid particle" OR "lipid particle" OR "lipid particles" OR lipidnanopartikel OR "lipid-nanopartikel" OR "lipidpartikel" OR liposom* OR "lipid vesicle")';
  var Q_CAT = '("cationic lipid" OR "ionizable lipid" OR "ionisable lipid" OR "amino lipid" OR "kationisches lipid" OR "kationische lipid" OR "ionisierbares lipid" OR "ionisierbare lipid")';
  function qTerm(t) { t = str(t).replace(/["()*:\[\]{}]/g, ' ').trim().replace(/\s+/g, ' '); return !t ? '' : '"' + t + '"'; }
  function textQueries(profile) {
    var qs = [], names = [], il = profile.ionizable_lipid || {}, z = profile.zusammensetzung || {}, mol = z.molprozent || {}, pay = profile.payload || {}, proc = profile.verfahren || {}, part = profile.partikel || {}, fl = profile.formulierung_lagerung || {};
    function addName(n) { n = str(n).trim(); if (n.length >= 3 && n.length <= 60 && names.indexOf(n) < 0 && !/^(lnp|lipid|mrna|peg)$/i.test(n)) names.push(n); }
    [il.name_user, il.name_normalised, il.cas].forEach(addName);
    arr(profile.suchbegriffe && profile.suchbegriffe.namen_codes).forEach(addName);
    var commodity = /^(cholesterol|cholesterin|dspc|dope|dopc|dppc|popc|dotap|sucrose|ethanol)$/i;
    var special = names.filter(function (n) { return !commodity.test(n); }).slice(0, 14);
    if (special.length) {
      qs.push({ id: 'name-claims', label: 'Names/codes in the claims', q: 'claims:(' + special.map(qTerm).join(' OR ') + ')', w: 5 });
      qs.push({ id: 'name-any', label: 'Names/codes in title, abstract, claims', q: '(' + special.map(qTerm).join(' OR ') + ')', w: 2.5 });
    }
    qs.push({ id: 'lnp-cationic', label: 'LNP with cationic/ionizable lipid (independent claims)', q: 'same:(' + Q_LNP + ' AND ' + Q_CAT + ') indep:1', w: 3 });
    var hasMol = false, k; for (k in mol) if (mol[k] !== null && mol[k] !== undefined) hasMol = true;
    if (hasMol || z.np_verhaeltnis != null) qs.push({ id: 'molar-ratio', label: 'Molar ratios / mol-%', q: 'same:(' + Q_CAT + ' AND ("mol %" OR "mol%" OR "mol percent" OR "molar ratio" OR molprozent OR "mol-%" OR "molverh\u00e4ltnis") AND (cholesterol OR cholesterin OR sterol OR phospholipid OR "non-cationic lipid" OR "neutral lipid")) indep:1', w: 4 });
    if (arr(profile.weitere_lipide).some(function (l) { return l.rolle === 'peg_lipid' || l.rolle === 'polymer_lipid_sonstig'; })) qs.push({ id: 'peg-lipid', label: 'PEG-/polymer-conjugated lipid', q: 'same:(("conjugated lipid" OR "peg-lipid" OR "pegylated lipid" OR "peg lipid" OR "polymer conjugated lipid" OR "polyethylene glycol" OR "pegyliertes lipid" OR "polyethylenglykol") AND ' + Q_LNP + ') indep:1', w: 3 });
    if (il.smiles || il.name_user) qs.push({ id: 'formula', label: 'Lipid compound claims with a generic formula (C07C/C07D)', q: 'indep:("compound of formula" OR "lipid of formula" OR "compound having" OR "having the structure" OR "following structure" OR "verbindung der formel" OR "lipid der formel" OR "compound of the formula") cpc:C07C,C07D', w: 2 });
    if (pay.typ && pay.typ !== 'leer') {
      var pt = /sirna/i.test(pay.typ) ? '(sirna OR "interfering rna" OR "interfering ribonucleic acid")' : /mrna|sarna|circ|crispr/i.test(pay.typ) ? '(mrna OR "messenger rna" OR "messenger ribonucleic acid" OR "ribonucleic acid" OR rna OR boten*)' : '("nucleic acid" OR nukleins\u00e4ure OR oligonucleotide OR dna)';
      qs.push({ id: 'payload', label: 'Payload ' + pay.typ + ' in LNP', q: 'same:(' + pt + ' AND ' + Q_LNP + ' AND ' + Q_CAT + ') indep:1', w: 2.5 });
    }
    if (proc.mischprinzip || arr(proc.schritte_frei).length || proc.flussratenverhaeltnis_waessrig_zu_organisch != null) qs.push({ id: 'process', label: 'Manufacturing process (mixing, ethanol, microfluidics)', q: 'same:((mixing OR mischen OR vermischen OR "t-connector" OR "t-junction" OR microfluidic* OR mikrofluid* OR herringbone OR "impinging jet") AND (ethanol OR alcohol OR alkohol OR "organic solvent") AND lipid* AND (nanoparticle* OR particle* OR vesicle* OR liposom* OR partikel* OR nanopartikel*)) indep:1', w: 3 });
    if (part.groesse_nm != null || part.pdi != null) qs.push({ id: 'particle', label: 'Particle parameters (size, PDI)', q: 'same:((diameter OR durchmesser OR "particle size" OR polydispersity OR polydispersit\u00e4t* OR "mean size") AND ' + Q_LNP + ' AND ' + Q_CAT + ') indep:1', w: 2 });
    if (fl.lyophilisiert || /lyo|gefrier/i.test(str(fl.lagerung))) qs.push({ id: 'lyo', label: 'Lyophilisation/storage', q: 'same:((lyophili* OR "freeze-dried" OR "freeze drying" OR gefriergetrock* OR cryoprotect* OR kryoprotekt*) AND ' + Q_LNP + ') indep:1', w: 2 });
    return qs;
  }
  var ROLE_W = { ionizable: 1, peg: 0.6, other: 0.4, helper: 0.15, sterol: 0.08 };
  /* candidates(profile, {max = 90, markets, manual: [p | pn], semantic: bool | query text, signal, onEvent})
     -> [{p, pn, auth, kind, title, assignee, player, status, text, family, routes[], score, why[]}] with a property
     `record` (the search record for the opinion: every query with its hit count, the structure searches, corpus
     snapshot). Deterministic except for the optional semantic route. Seed families of tier 1 and user marks are always
     part of the result (generic claims of the key players do not name the user's lipid); the rest is filled by score. */
  function candidates(profile, o) {
    o = o || {};
    var data = eng('data'), search = eng('search'), chem = eng('chem'), ai = eng('ai');
    var max = o.max || 90, markets = marketsOf(o.markets || (profile.handlungen && profile.handlungen.maerkte));
    if (!markets.length) markets = ['DE', 'EP', 'US'];
    var wantEP = markets.indexOf('DE') >= 0 || markets.indexOf('EP') >= 0 || markets.indexOf('UPC') >= 0, wantUS = markets.indexOf('US') >= 0;
    var auths = (wantEP ? ['EP'] : []).concat(wantUS ? ['US'] : []);
    var acc = {}, record = { created: nowDate().toISOString(), snapshot: (data && data.manifest && data.manifest.snapshots) || null, counts: (data && data.manifest && data.manifest.counts) || null, markets: markets,
      structure: [], text: [], seed: [], semantic: null, family: { added: 0 }, wo: { found: 0 }, notes: [], total: 0, returned: 0 };
    var emit = typeof o.onEvent === 'function' ? o.onEvent : function () { };
    function add(p, route, s, why, qid) {
      if (!(p >= 0)) return;
      var c = acc[p] || (acc[p] = { p: p, by: {}, whyBy: {}, tq: {} });
      if (route === 'text') { if (!(c.tq[qid] >= s)) c.tq[qid] = s; }
      else if (!(c.by[route] >= s)) c.by[route] = s;
      var w = c.whyBy[route] || (c.whyBy[route] = []);
      if (why && w.indexOf(why) < 0 && w.length < 4) w.push(why);
    }
    // reasons in a fixed order of routes, so that the strongest reason is never crowded out by text hits
    function whyOf(c) { var out = []; ['manual', 'markush', 'structure', 'seed', 'semantic', 'text', 'family'].forEach(function (r) { arr(c.whyBy[r]).slice(0, r === 'text' ? 3 : 4).forEach(function (w) { if (out.length < 9) out.push(w); }); }); return out; }
    /* score = sum over the routes; the text route counts its best query fully and the further queries half, so that a
       publication hit by several independent queries ranks above one hit by a single query */
    function total(c) { var s = 0, r, best = 0, sum = 0; for (r in c.by) s += c.by[r]; for (r in c.tq) { sum += c.tq[r]; if (c.tq[r] > best) best = c.tq[r]; } c.text = best + 0.5 * (sum - best); c.score = s + c.text; return c; }
    function routesOf(c) { var r = Object.keys(c.by); if (c.text > 0) r.push('text'); return r; }
    var chain = Promise.resolve();
    // 1. structure route
    var lipids = arr(profile._app && profile._app.lipids).filter(function (c) { return c && c.ok && c.smiles; });
    if (!lipids.length && profile.ionizable_lipid && profile.ionizable_lipid.smiles) lipids = [{ role: 'ionizable', name: profile.ionizable_lipid.name_user, smiles: profile.ionizable_lipid.smiles }];
    if (chem) lipids.forEach(function (c) {
      var w = ROLE_W[c.role] || 0.3, nm = str(c.name || c.ref_name || c.role);
      // [mode, weight when SureChEMBL found the structure in the claims, weight when only elsewhere in the document]
      [['exact', 10, 2.5], ['sub', 6, 1.5], ['sim', 5, 1.2]].forEach(function (md) {
        if (md[0] !== 'exact' && w < 0.5) return;
        chain = chain.then(function () {
          emit({ type: 'stage', stage: 'structure', lipid: nm, mode: md[0] });
          var q = { smiles: c.smiles_canonical || c.smiles, mode: md[0], limit: md[0] === 'exact' ? 60 : 40, maxPatents: 300, signal: o.signal };
          if (md[0] === 'sim') q.minSim = 0.8;
          return Promise.resolve(chem.search(q)).then(function (hits) {
            var nPat = 0;
            arr(hits).forEach(function (h) {
              var sim = md[0] === 'sim' ? (h.sim || 0.8) : 1;
              arr(h.patents).forEach(function (pt) {
                nPat++;
                var inClaims = pt.where && pt.where.clm, known = acc[pt.p] && acc[pt.p].cmp && acc[pt.p].cmp[c.role + h.id];
                add(pt.p, 'structure', w * sim * (inClaims ? md[1] : md[2]), known ? null :
                  (md[0] === 'exact' ? (h.match === 'stereo-variant' ? 'Exact structure (stereo variant)' : 'Exact structure') : md[0] === 'sub' ? 'Substructure' : 'Similar structure (' + Math.round(sim * 100) + ' %)') + ': ' + nm + ' = ' + str(h.id) + (inClaims ? ' in the claims' : ' in the document') + ' (SureChEMBL occurrence, no evidence of claim scope)');
                if (acc[pt.p]) { (acc[pt.p].cmp = acc[pt.p].cmp || {})[c.role + h.id] = 1; if (md[0] === 'exact' && w >= 0.5) acc[pt.p].exact = nm; }
              });
            });
            record.structure.push({ lipid: nm, role: c.role, mode: md[0], compounds: (hits && hits.total != null) ? hits.total : arr(hits).length, publications: nPat });
          }, function (e) { if (e && e.code === 'cancelled') throw mkErr('cancelled', 'cancelled'); record.structure.push({ lipid: nm, role: c.role, mode: md[0], error: str(e && (e.message || e.code)) }); });
        });
      });
    });
    else record.notes.push('Structure search not run: LnpChem not loaded.');
    if (chem && !lipids.length) record.notes.push('Structure search not run: no readable structure in the profile.');
    // 2. text route
    if (search) textQueries(profile).forEach(function (tq) {
      chain = chain.then(function () {
        emit({ type: 'stage', stage: 'text', query: tq.id });
        return Promise.resolve(search.search(tq.q, { filters: { auth: auths.concat(['WO']) }, limit: 150, snippets: false, facets: false })).then(function (r) {
          var n = arr(r.hits).length;
          arr(r.hits).forEach(function (h, i) { add(h.p, 'text', tq.w * (0.4 + 0.6 * (1 - i / Math.max(n, 1))), 'Text search "' + tq.label + '"' + (h.best && h.best.field === 'claim' ? ' (claim ' + h.best.n + ')' : ''), tq.id); });
          record.text.push({ id: tq.id, label: tq.label, query: tq.q, total: r.total, taken: n, warnings: arr(r.parsed && r.parsed.warnings).map(function (w) { return w.message || w.code; }) });
        }, function (e) { record.text.push({ id: tq.id, label: tq.label, query: tq.q, error: str(e && (e.message || e.code)) }); });
      });
    });
    else record.notes.push('Text search not run: LnpSearch not loaded.');
    // 3. seed families of the key players (found regardless of keywords: generic claims do not name the lipid)
    if (search) [[1, 3], [2, 1.2]].forEach(function (st) {
      chain = chain.then(function () {
        return Promise.resolve(search.search('', { filters: { seedTiers: [st[0]], auth: auths }, limit: 1000, snippets: false, facets: false })).then(function (r) {
          arr(r.hits).forEach(function (h) { add(h.p, 'seed', st[1], 'Key family (tier ' + st[0] + ') of a watched applicant'); });
          record.seed.push({ tier: st[0], total: r.total, taken: arr(r.hits).length });
        }, function (e) { record.seed.push({ tier: st[0], error: str(e && (e.message || e.code)) }); });
      });
    });
    // 4. optional semantic route (Claude)
    if (o.semantic && ai && ai.semanticSearch) chain = chain.then(function () {
      var q = typeof o.semantic === 'string' ? o.semantic : [profile.bezeichnung, profile.ionizable_lipid && profile.ionizable_lipid.strukturbeschreibung].concat(arr(profile.merkmalsliste).slice(0, 40).map(function (f) { return f.aussage; })).filter(Boolean).join('\n');
      emit({ type: 'stage', stage: 'semantic' });
      return ai.semanticSearch(q, { n: 60, signal: o.signal, filters: { auth: auths } }).then(function (r) {
        r.hits.forEach(function (h, i) { if (h.score === null || h.score >= 1) add(h.p, 'semantic', h.score === null ? 1 : 2 * h.score, 'Semantic search' + (h.reason ? ': ' + h.reason : '')); });
        record.semantic = { used: r.used, queries: r.queries, hits: r.hits.length, calls: r.calls, degraded: r.degraded };
      }, function (e) { if (e && e.code === 'cancelled') throw e; record.semantic = { error: str(e && e.code) }; });
    });
    // 5. user marks
    chain = chain.then(function () {
      var ch = Promise.resolve();
      arr(o.manual).forEach(function (m) { ch = ch.then(function () { return Promise.resolve(typeof m === 'number' ? m : (data ? data.byPn(str(m)) : -1)).then(function (p) { add(p, 'manual', 20, 'Marked by the user'); }, function () { }); }); });
      return ch;
    });
    // 5b. Markush route: stored and curated mk-1 records checked by code (LnpMarkush), no model call
    var mkE = xeng('markush');
    if (mkE && mkE.batch && mkE.list) chain = chain.then(function () {
      emit({ type: 'stage', stage: 'markush' });
      var mr = record.markush = { records: 0, lipids: 0, checked: 0, covered: [], unclear: [], notCovered: 0, errors: [] };
      return Promise.resolve(mkE.list({ curated: true })).then(function (recs) {
        recs = arr(recs).filter(function (r) { return r && r.pn && r.claim != null; });
        mr.records = recs.length;
        var mls = lipids.filter(function (c) { return c.smiles; }), ch = Promise.resolve();
        mr.lipids = mls.length;
        if (!recs.length || !mls.length) return null;
        var targets = recs.map(function (r) { return { pn: r.pn, claim: r.claim }; });
        mls.forEach(function (c) {
          var nm = str(c.name || c.ref_name || c.role);
          ch = ch.then(function () {
            return Promise.resolve(mkE.batch(c.smiles_canonical || c.smiles, targets, { signal: o.signal })).then(function (rows) {
              var ch2 = Promise.resolve();
              arr(rows).forEach(function (row) {
                if (!row || !row.result) { if (row && row.reason !== 'no_record') mr.errors.push({ lipid: nm, pn: row.pn, claim: row.claim, reason: row.reason }); return; }
                mr.checked++;
                var res = row.result, rv = mkReviewed(row), ov = res.overall;
                if (ov === 'not_covered') { mr.notCovered++; return; }
                var why = 'Markush check: ' + nm + (ov === 'covered' ? ' covered by claim ' : ' unclear for claim ') + row.claim + (ov === 'covered' ? ' (code-verified, translation ' + (rv ? 'reviewed' : 'not reviewed') + ')' : ' (code check, ' + (arr(res.reasons)[0] ? str(res.reasons[0]).slice(0, 120) : 'no decision') + ')');
                ch2 = ch2.then(function () {
                  return Promise.resolve(data ? data.byPn(str(row.pn)) : -1).then(function (p) {
                    var item = { lipid: nm, role: c.role, pn: row.pn, claim: row.claim, overall: ov, reviewed: rv, origin: row.origin || res.origin || null, p: p >= 0 ? p : null };
                    if (ov === 'covered') { mr.covered.push(item); if (p >= 0) { add(p, 'markush', 12, why); acc[p].mkCovered = true; } }
                    else { mr.unclear.push(item); if (p >= 0 && acc[p]) { var w = acc[p].whyBy.markush || (acc[p].whyBy.markush = []); if (w.indexOf(why) < 0 && w.length < 4) w.push(why); } }
                  }, function () { });
                });
              });
              return ch2;
            }, function (e) { if (e && e.code === 'cancelled') throw e; mr.errors.push({ lipid: nm, reason: str(e && (e.code || e.message)) }); });
          });
        });
        return ch;
      }, function (e) { mr.errors.push({ reason: 'records not readable: ' + str(e && (e.code || e.message)) }); });
    });
    // 6. family members in the target jurisdictions, then biblio
    return chain.then(function () {
      var list = Object.keys(acc).map(function (k) { return total(acc[k]); }).sort(function (a, b) { return (b.score - a.score) || (a.p - b.p); });
      record.total = list.length;
      if (!data) return list;
      var top = list.slice(0, max * 2), ch = Promise.resolve();
      top.forEach(function (c) {
        ch = ch.then(function () {
          return Promise.resolve(data.family(c.p)).then(function (fam) {
            arr(fam).slice(0, 40).forEach(function (p2) { if (p2 !== c.p && !acc[p2]) { acc[p2] = { p: p2, by: { family: 0.5 * c.score }, tq: {}, whyBy: { family: ['Family member of a hit (index ' + c.p + ')'] }, fromFamily: c.p }; record.family.added++; } });
          }, function () { });
        });
      });
      return ch.then(function () { return Object.keys(acc).map(function (k) { return total(acc[k]); }).sort(function (a, b) { return (b.score - a.score) || (a.p - b.p); }); });
    }).then(function (list) {
      if (!data || !list.length) return list.map(function (c) { return { p: c.p, routes: routesOf(c), score: Math.round(c.score * 100) / 100, why: whyOf(c) }; });
      // the must-hit set (seed tier 1, user marks) is always looked at, whatever its rank
      var take = list.slice(0, Math.max(600, max * 4)), inTake = {};
      take.forEach(function (c) { inTake[c.p] = 1; });
      list.forEach(function (c) { if (!inTake[c.p] && (c.by.manual || c.by.seed >= 3 || c.exact || c.mkCovered)) take.push(c); });
      return Promise.resolve(data.patents(take.map(function (c) { return c.p; }))).then(function (ps) {
        var out = [], pnOf = {};
        ps.forEach(function (pt) { if (pt) pnOf[pt.p] = pt.pn; });
        take.forEach(function (c, i) {
          var pt = ps[i]; if (!pt) return;
          if (pt.auth === 'WO') { record.wo.found++; return; }
          if (auths.indexOf(pt.auth) < 0) return;
          /* Markush signal: the user's own lipid is disclosed in the document and an independent claim carries a formula
             that exists only as an image. Such a generic claim never names the compound, so neither the text route nor
             "structure in the claims" can find it. */
          if (c.exact && pt.hasImg) { c.by.markush = Math.max(c.by.markush || 0, 9); (c.whyBy.markush = c.whyBy.markush || []).push('Possible generic formula claim: ' + c.exact + ' is disclosed in the document and an independent claim contains a formula that exists only as an image \u2013 formula test needed'); total(c); }
          var why = whyOf(c).map(function (w) { return c.fromFamily != null && pnOf[c.fromFamily] ? w.replace('index ' + c.fromFamily, pnOf[c.fromFamily]) : w; });
          if (pt.seedFam && c.by.seed) why = why.map(function (w) { return w.indexOf('Key family') === 0 ? w + ': ' + pt.seedFam + (pt.player ? ' ' + pt.player + '' : '') : w; });
          out.push({ p: c.p, pn: pt.pn, auth: pt.auth, kind: pt.kind, title: pt.title, assignee: pt.assignee, player: pt.player || null, status: pt.status || null, text: !!pt.text, family: pt.fam, routes: routesOf(c), score: Math.round(c.score * 100) / 100, why: why, must: !!(c.by.manual || c.by.seed >= 3 || c.mkCovered) });
        });
        return out;
      });
    }).then(function (out) {
      out.sort(function (a, b) { return (b.score - a.score) || (a.p - b.p); });
      var must = out.filter(function (c) { return c.must; }), rest = out.filter(function (c) { return !c.must; });
      var res = must.concat(rest.slice(0, Math.max(0, max - must.length))).sort(function (a, b) { return (b.score - a.score) || (a.p - b.p); });
      res.forEach(function (c) { delete c.must; });
      record.must = must.length;
      if (record.wo.found) record.notes.push(record.wo.found + ' WO publication(s) among the hits: not enforceable, used only as pointers to the EP/US family members.');
      record.returned = res.length; record.cut = Math.max(0, out.length - res.length);
      res.record = record;
      return res;
    });
  }

  // ------------------------------------------------------------------------------------------------ legal status
  var DEAD = { expired: 1, lapsed: 1, revoked: 1, withdrawn: 1, refused: 1 };
  /* jurisdiction logic for one publication: which markets it is assessed for, whether it is granted / pending / dead,
     the expiry estimate with its basis, and the modifiers that go next to the risk level */
  function rightOf(pat, st, markets) {
    var now = today(), auth = pat.auth, r = { jurisdiction: auth, markets: [], granted: false, pending: false, code: 'unknown', text: null, src: null, asof: null, stale: false, unverified: true,
      inForceDe: null, lapsedIn: [], opposition: null, appeal: null, unitary: null, note: null, expiry: { date: null, basis: null, estimate: true, ptaDays: null }, dead: false, deadReason: null, modifiers: [], notes: [] };
    st = st || null;
    if (auth === 'EP') { r.granted = /^B/.test(str(pat.kind)); r.markets = markets.filter(function (m) { return m === 'DE' || m === 'EP' || m === 'UPC'; }); }
    else if (auth === 'US') { r.granted = !/^A\d$/.test(str(pat.kind)); r.markets = markets.filter(function (m) { return m === 'US'; }); }
    r.code = (st && st.code) || pat.status || 'unknown';
    if (st) {
      var snap = (eng('data') && eng('data').manifest && eng('data').manifest.snapshots) || {};
      r.text = st.text || null; r.src = st.src || null; r.recordDate = st.asof || null;
      // a register record keeps the date of its last change; what counts for staleness is the date of the snapshot
      r.asof = (st.src === 'ep-register' && snap.ep_register && (!st.asof || snap.ep_register > st.asof)) ? snap.ep_register : (st.asof || null); r.lapsedIn = arr(st.lapsed_in); r.opposition = st.opposition || null; r.appeal = st.appeal == null ? null : st.appeal; r.unitary = st.unitary || null; r.note = st.note || null;
      if (auth === 'EP') r.inForceDe = st.in_force_de == null ? null : !!st.in_force_de;
      var age = r.asof ? daysBetween(r.asof, now) : null;
      r.stale = age === null || age > 183;
      r.unverified = r.stale || r.code === 'unknown' || !r.src;
    } else if (auth === 'EP' && pat.deIn != null && pat.deIn !== 2) r.inForceDe = pat.deIn === 1;
    // expiry: an estimate, computed from the data, never by the model
    var exp = (st && st.expiry_est) || ymd(pat.exp), filing = (st && (st.term_base || st.filing)) || ymd(pat.app);
    if (exp) {
      r.expiry.date = exp; r.expiry.ptaDays = st && st.pta_days != null ? st.pta_days : null;
      r.expiry.basis = (st && st.estimate) ? str(st.estimate) : auth === 'US'
        ? 'earliest effective US filing date' + (filing ? ' ' + filing : '') + ' + 20 years' + (r.expiry.ptaDays ? ' + PTA ' + r.expiry.ptaDays + ' days' : '') + '; terminal disclaimer, PTE and maintenance fees not checked'
        : 'filing date' + (filing ? ' ' + filing : '') + ' + 20 years (Art. 63 EPC); SPC, surrender and renewal fees after the snapshot date not taken into account';
    } else if (filing) {
      r.expiry.date = addYears(filing, 20);
      r.expiry.basis = 'computed by the app from the filing date ' + filing + ' + 20 years (no legal-status record); PTA/PTE/SPC not taken into account';
    } else r.expiry.basis = 'no filing date in the corpus';
    var appealOpen = r.code === 'revoked' && (r.appeal === true || (r.opposition && r.opposition.outcome === 'pending'));
    r.appealOpen = !!appealOpen;
    if (DEAD[r.code] && st && st.src && st.asof && !appealOpen) { r.dead = true; r.deadReason = r.code; }
    else if (r.expiry.date && r.expiry.date < now) { r.dead = true; r.deadReason = 'expired'; r.notes.push('estimated expiry ' + r.expiry.date + ' has passed'); }
    else if (auth === 'EP' && r.granted && r.inForceDe === false && st && st.src && r.markets.length && r.markets.every(function (m) { return m === 'DE'; })) { r.dead = true; r.deadReason = 'lapsed_de'; }
    r.pending = !r.granted && !r.dead;
    if (appealOpen) r.notes.push('Revoked according to the register, but an appeal is on record: finality not checked, treated as in force');
    if (auth === 'EP' && r.granted && !r.dead && r.inForceDe === false) r.notes.push('not in force in DE according to the register; possibly in force in other validation states');
    if (!r.dead && r.unverified) r.modifiers.push('rechtsstand_ungeprueft');
    if (r.pending) r.modifiers.push('anmeldung_ansprueche_veraenderlich');
    if (appealOpen || (r.opposition && (r.opposition.outcome === 'pending' || (r.opposition.filed && !r.opposition.outcome)))) r.modifiers.push('einspruch_ipr_anhaengig');
    return r;
  }
  var STATUS_LABEL = { granted: 'granted', pending: 'pending', lapsed: 'lapsed', revoked: 'revoked', withdrawn: 'withdrawn', refused: 'refused', expired: 'expired', unknown: 'unknown', lapsed_de: 'lapsed in DE' };
  function statusLabel(r, lang) {
    var L = STATUS_LABEL, s = L[r.dead ? r.deadReason : r.code] || str(r.code);
    if (r.appealOpen) s = 'revocation not final (appeal on record)';
    if (!r.granted && !r.dead && r.code !== 'pending') s = 'application, ' + s;
    if (r.src === 'us-calc' && r.granted && !r.dead) s += ', maintenance fees not checked';
    if (r.jurisdiction === 'EP' && r.granted && !r.dead) s += r.inForceDe === true ? ', in force in DE' : r.inForceDe === false ? ', not in force in DE' : ', DE part unknown';
    if (r.modifiers.indexOf('einspruch_ipr_anhaengig') >= 0 && !r.appealOpen) s += ', opposition/appeal pending';
    if (!r.dead && r.unverified) s += ' (unverified' + (r.asof ? ', snapshot ' + r.asof : ', no record') + '; treated as in force)';
    else if (r.asof) s += ' (snapshot ' + r.asof + ')';
    return s;
  }

  // ------------------------------------------------------------------------------------------------ claims
  function claimSet(p, pat) {
    var search = eng('search'), P = eng('prompts');
    if (!search) return Promise.resolve(null);
    return Promise.resolve(search.claims(p)).then(function (cl) {
      cl = arr(cl);
      if (!cl.length) return null;
      var n = {}, lang;
      cl.forEach(function (c) { n[c.lang] = (n[c.lang] || 0) + 1; });
      lang = (n.en && n.en >= (n.de || 0)) ? 'en' : (n.de ? 'de' : Object.keys(n)[0]);
      var all = cl.filter(function (c) { return c.lang === lang; }).map(function (c) { return { n: c.n, indep: !!c.indep, dep: arr(c.dep), text: str(c.text), img: arr(c.img), lang: lang, ph: P ? P.countPlaceholders(c.text) : 0 }; }).sort(function (a, b) { return a.n - b.n; });
      var byNo = {}; all.forEach(function (c) { byNo[c.n] = c; });
      return { lang: lang, langs: Object.keys(n), all: all, byNo: byNo, indep: all.filter(function (c) { return c.indep; }), dep: all.filter(function (c) { return !c.indep; }) };
    }, function () { return null; });
  }
  function imagesFor(p, pat, cs) {
    var search = eng('search');
    if (!search || !search.claimImages || !cs || !cs.all.some(function (c) { return c.ph > 0; })) return Promise.resolve([]);
    return Promise.resolve(search.claimImages(p)).then(function (x) { return arr(x).filter(function (i) { return i && i.blob; }); }, function () { return []; });
  }

  // ------------------------------------------------------------------------------------------------ app-side checks
  function dependsOnFormula(m, P) {
    return !!(m.markush || (P && P.hasPlaceholder(m.claim_quote)) || /\b(formula|formel|structure|struktur|compound of|verbindung der)\b/i.test(str(m.claim_quote)));
  }
  /* checkChart: quote verification, formula-missing rule, literal result recomputed from the rows, risk guards.
     chart is modified in place: every feature and claim gets an "app" object, chart.app carries the summary. */
  function checkChart(chart, cs, defs, info) {
    var P = eng('prompts'), flags = [], notes = [], defsText = arr(defs).join('\n'), quotes = { total: 0, ok: 0, near: 0, failed: 0 }, seen = {}, worst = null, worstClaim = null, markushUnclear = false, forced = 0;
    function flag(f) { if (flags.indexOf(f) < 0) flags.push(f); }
    info = info || {};
    var missing = info.formulaMissing || {}, cut = info.cutClaims || {};
    chart.claims = arr(chart.claims);
    chart.claims.forEach(function (cl) {
      var src = cs.byNo[cl.claim_no], app = cl.app = { literal_model: cl.literal_ergebnis, flags: [] };
      seen[cl.claim_no] = 1;
      if (!src || !src.indep) { app.flags.push(src ? 'kein_unabhaengiger_anspruch' : 'anspruch_nicht_im_korpus'); if (!src) { app.literal = 'nicht_beurteilbar'; flag('anspruch_nicht_im_korpus'); worst = worseLiteral(worst, app.literal); return; } }
      var verdicts = [];
      arr(cl.merkmale).forEach(function (m) {
        var q = verifyQuote(m.claim_quote, src.text), a = m.app = { quote: q.status, verified: q.verified, near: q.near, verdict: m.verdict, forced: null };
        quotes.total++; if (q.verified) quotes.ok++; else if (q.near) quotes.near++; else quotes.failed++;
        if (!q.verified) { a.flag = q.near ? 'zitat_abweichend' : 'zitat_nicht_verifiziert'; a.konfidenz = q.near ? (m.konfidenz === 'hoch' ? 'mittel' : m.konfidenz) : 'niedrig'; }
        if (m.auslegung && m.auslegung.definition_quote) { var dq = verifyQuote(m.auslegung.definition_quote, defsText); a.def_quote = dq.status; if (!dq.verified && !dq.near) flag('definitionszitat_nicht_verifiziert'); }
        if (m.markush) {
          var mk = m.markush, bad = 0;
          arr(mk.variablen).forEach(function (v) { var vq = verifyQuote(v.definition_quote, src.text + '\n' + defsText); v.app = { quote: vq.status }; if (!vq.verified && !vq.near) bad++; });
          arr(mk.massgaben).forEach(function (v) { var vq = verifyQuote(v.quote, src.text); v.app = { quote: vq.status }; if (!vq.verified && !vq.near) bad++; });
          arr(mk.gesamtbedingungen).forEach(function (v) { var vq = verifyQuote(v.quote, src.text); v.app = { quote: vq.status }; if (!vq.verified && !vq.near) bad++; });
          if (bad) { a.markush_quotes_failed = bad; flag('markush_zitat_nicht_verifiziert'); }
          if (mk.ergebnis === 'unklar' || mk.ergebnis === 'formel_fehlt') markushUnclear = true;
          if (mk.ergebnis === 'faellt_unter_formel' && m.verdict === 'nicht_erfuellt') app.flags.push('markush_widerspruch_' + m.feature_id);
          if (mk.ergebnis === 'faellt_nicht_unter_formel' && m.verdict === 'erfuellt') app.flags.push('markush_widerspruch_' + m.feature_id);
        }
        // a feature can only count as "not met" on a verified basis
        if (a.verdict === 'nicht_erfuellt') {
          if (missing[cl.claim_no] && dependsOnFormula(m, P)) { a.verdict = 'unklar'; a.forced = 'formel_fehlt'; if (m.markush) m.markush.app_ergebnis = 'formel_fehlt'; markushUnclear = true; }
          else if (!q.verified && !q.near) { a.verdict = 'unklar'; a.forced = 'zitat_nicht_verifiziert'; }
          else if (m.markush && (m.markush.ergebnis === 'unklar' || m.markush.ergebnis === 'formel_fehlt')) { a.verdict = 'unklar'; a.forced = 'markush_unklar'; }
          else if (m.markush && a.markush_quotes_failed) { a.verdict = 'unklar'; a.forced = 'markush_zitat_nicht_verifiziert'; }
        }
        if (['erfuellt', 'nicht_erfuellt', 'unklar'].indexOf(a.verdict) < 0) { a.verdict = 'unklar'; a.forced = 'ungueltiges_urteil'; }
        if (a.forced) forced++;
        verdicts.push(a.verdict);
      });
      app.literal = literalFromVerdicts(verdicts);
      if (missing[cl.claim_no]) { app.flags.push('formel_fehlt'); flag('formel_fehlt'); if (app.literal === 'wortsinngemaess_erfuellt') { app.literal = 'wortsinngemaess_moeglich'; notes.push('Claim ' + cl.claim_no + ': formula image not available, result at most "possible"'); } }
      if (cut[cl.claim_no]) { app.flags.push('text_gekuerzt'); flag('text_gekuerzt'); if (app.literal === 'wortsinngemaess_erfuellt') { app.literal = 'wortsinngemaess_moeglich'; notes.push('Claim ' + cl.claim_no + ': text shortened, result at most "possible"'); } }
      if (app.literal !== cl.literal_ergebnis) { app.flags.push('literal_neu_berechnet'); flag('literal_neu_berechnet'); notes.push('Claim ' + cl.claim_no + ': result recomputed from the feature rows (' + ll(cl.literal_ergebnis) + ' -> ' + ll(app.literal) + ')'); }
      if (worst === null || LIT_RANK[app.literal] > LIT_RANK[worst]) { worst = app.literal; worstClaim = cl.claim_no; }
    });
    cs.indep.forEach(function (c) {
      if (seen[c.n]) return;
      chart.claims.push({ claim_no: c.n, kategorie: 'sonstiges', betroffene_akte: [], merkmale: [], literal_ergebnis: 'nicht_beurteilbar', tragende_merkmale: [], robustheit: 'entfaellt', konfidenz: 'niedrig', app: { literal: 'nicht_beurteilbar', literal_model: null, flags: ['anspruch_fehlt_in_analyse'] } });
      flag('anspruch_fehlt_in_analyse'); notes.push('Independent claim ' + c.n + ' is missing from the analysis: cannot be assessed');
      if (worst === null || LIT_RANK.nicht_beurteilbar > LIT_RANK[worst]) { worst = 'nicht_beurteilbar'; worstClaim = c.n; }
    });
    if (quotes.failed) flag('zitat_nicht_verifiziert');
    if (quotes.near) flag('zitat_abweichend');
    if (forced) flag('urteil_von_app_auf_unklar_gesetzt');
    var g0 = chart.gesamt || {}, model = RISK_RANK[g0.risiko] ? g0.risiko : 'nicht_beurteilbar', risk = model;
    function raise(to, why) { if (riskRank(to) > riskRank(risk)) { notes.push('Risk raised from ' + rl(risk) + ' to ' + rl(to) + ': ' + why); risk = to; } }
    var right = info.right || {};
    if (worst === 'wortsinngemaess_erfuellt') raise(right.granted ? '5_sehr_hoch' : '3_mittel', right.granted ? 'an independent claim is literally met according to the feature rows' : 'a claim of the application reads on the product');
    else if (worst === 'wortsinngemaess_moeglich') raise('3_mittel', 'no feature is clearly not met');
    else if (worst === 'nicht_beurteilbar') raise('nicht_beurteilbar', 'at least one independent claim cannot be assessed');
    if (flags.indexOf('formel_fehlt') >= 0) raise('nicht_beurteilbar', 'claim text incomplete: the formula exists only as an image and was not read');
    if (riskRank(risk) <= 2 && markushUnclear) raise('nicht_beurteilbar', 'formula test unclear');
    if (riskRank(risk) <= 2 && quotes.failed) raise('nicht_beurteilbar', 'quotes not verified');
    chart.app = { literal_worst: worst || 'nicht_beurteilbar', claim_worst: worstClaim, flags: flags, notes: notes, quotes: quotes, risk_model: g0.risiko || null, risk: risk, forced: forced };
    return chart;
  }
  /* dependent claims: quotes checked against the dependent claim's own text, chain result recomputed */
  function checkDependent(da, chart, cs) {
    var flags = [], own = {}, rootLit = {}, memo = {};
    arr(chart.claims).forEach(function (c) { rootLit[c.claim_no] = (c.app && c.app.literal) || c.literal_ergebnis; });
    da.unteransprueche = arr(da.unteransprueche);
    da.unteransprueche.forEach(function (u) {
      var src = cs.byNo[u.claim_no], vs = [];
      u.app = { flags: [] };
      if (!src) { u.app.flags.push('anspruch_nicht_im_korpus'); if (flags.indexOf('anspruch_nicht_im_korpus') < 0) flags.push('anspruch_nicht_im_korpus'); return; }
      arr(u.zusatzmerkmale).forEach(function (z) {
        var q = verifyQuote(z.claim_quote, src.text); z.app = { quote: q.status, verified: q.verified, near: q.near, verdict: z.verdict };
        if (!q.verified && !q.near) { if (flags.indexOf('zitat_nicht_verifiziert') < 0) flags.push('zitat_nicht_verifiziert'); if (z.verdict === 'nicht_erfuellt') z.app.verdict = 'unklar'; }
        vs.push(z.app.verdict);
      });
      if (u.einzelnennung_quote) { var eq = verifyQuote(u.einzelnennung_quote, src.text); u.app.einzelnennung_quote = eq.status; if (!eq.verified && !eq.near && u.einzelnennung === 'ja') { u.app.flags.push('einzelnennung_zitat_nicht_verifiziert'); if (flags.indexOf('einzelnennung_zitat_nicht_verifiziert') < 0) flags.push('einzelnennung_zitat_nicht_verifiziert'); } }
      own[u.claim_no] = vs.length ? vs : ['unklar'];
    });
    // chain result: the most adverse path up to an independent claim (rank: erfuellt 2 > moeglich 1 > nicht_erfuellt 0)
    function chainOf(n, depth) {
      if (memo[n] !== undefined) return memo[n];
      var c = cs.byNo[n];
      if (!c || depth > 30) return (memo[n] = 1);
      if (c.indep) { var l = rootLit[n]; return (memo[n] = l === 'wortsinngemaess_erfuellt' ? 2 : l === 'wortsinngemaess_nicht_erfuellt' ? 0 : 1); }
      var mine = own[n] || ['unklar'], me = mine.indexOf('nicht_erfuellt') >= 0 ? 0 : mine.every(function (v) { return v === 'erfuellt'; }) ? 2 : 1, best = -1;
      c.dep.forEach(function (d) { best = Math.max(best, chainOf(d, depth + 1)); });
      if (best < 0) best = 1;
      return (memo[n] = Math.min(me, best));
    }
    da.unteransprueche.forEach(function (u) {
      if (!cs.byNo[u.claim_no]) return;
      var r = ['nicht_erfuellt', 'moeglich', 'erfuellt'][chainOf(u.claim_no, 0)];
      u.app.ketten_ergebnis = r;
      if (r !== u.ketten_ergebnis) { u.app.flags.push('kette_neu_berechnet'); if (flags.indexOf('kette_neu_berechnet') < 0) flags.push('kette_neu_berechnet'); }
    });
    da.app = { flags: flags };
    return da;
  }
  /* red team: final literal result per claim and final risk = the more adverse of B and E */
  function applyRedTeam(rt, chart, right) {
    var notes = [], byNo = {}, worst = chart.app.literal_worst, worstClaim = chart.app.claim_worst;
    arr(chart.claims).forEach(function (c) { byNo[c.claim_no] = c; c.app.literal_final = c.app.literal; });
    arr(rt.claims).forEach(function (rc) {
      var c = byNo[rc.claim_no]; if (!c) return;
      c.app.literal_e = rc.literal_ergebnis_revidiert;
      c.app.literal_final = worseLiteral(c.app.literal, rc.literal_ergebnis_revidiert) || c.app.literal;
      if (c.app.literal_final !== c.app.literal) notes.push('Claim ' + rc.claim_no + ': red-team result more adverse (' + ll(c.app.literal) + ' -> ' + ll(c.app.literal_final) + ')');
      else if (rc.literal_ergebnis_revidiert !== c.app.literal) notes.push('Claim ' + rc.claim_no + ': red-team result more favourable ' + ll(rc.literal_ergebnis_revidiert) + ', not adopted');
      if (LIT_RANK[c.app.literal_final] > LIT_RANK[worst]) { worst = c.app.literal_final; worstClaim = rc.claim_no; }
      arr(rc.angriffe).forEach(function (a) { var m = arr(c.merkmale).filter(function (x) { return x.feature_id === a.feature_id; })[0]; if (m) m.app.redteam = a.ergebnis; });
    });
    var rb = chart.app.risk, re = rt.revidiert && RISK_RANK[rt.revidiert.risiko] ? rt.revidiert.risiko : null, fin = maxRisk(rb, re) || rb;
    if (worst === 'wortsinngemaess_erfuellt' && riskRank(fin) < (right && right.granted ? 5 : 3)) { fin = right && right.granted ? '5_sehr_hoch' : '3_mittel'; notes.push('Risk raised after the red-team review: a claim counts as literally met'); }
    else if (worst === 'wortsinngemaess_moeglich' && riskRank(fin) < 3) { fin = '3_mittel'; notes.push('Risk raised after the red-team review: no feature is clearly not met'); }
    if (re && riskRank(re) < riskRank(rb)) notes.push('The red-team review considers a lower risk arguable (' + rl(re) + (rt.revidiert.herabstufung_wegen_fehler ? ', because of an error in the first analysis' : '') + '): not adopted automatically, question for counsel');
    rt.app = { risk_e: re, literal_worst: worst, claim_worst: worstClaim, notes: notes, escalation: riskRank(fin) > riskRank(rb) };
    return { b: rb, e: re, final: fin, literal: worst, claim: worstClaim };
  }

  // ------------------------------------------------------------------------------------------------ digest
  function buildDigest(e) {
    var chart = e.chart, rt = e.redteam, da = e.dependent, fb = {}, rtBy = {};
    if (da) arr(da.rueckzugspositionen).forEach(function (r) { fb[r.unabhaengiger_anspruch] = r.engster_noch_treffender_anspruch == null ? null : r.engster_noch_treffender_anspruch; });
    if (rt) arr(rt.claims).forEach(function (rc) { rtBy[rc.claim_no] = rc; });
    var claims = arr(chart.claims).map(function (c) {
      var mk = 'entfaellt', mkMiss = [], eq = 'entfaellt', att = {};
      if (rtBy[c.claim_no]) arr(rtBy[c.claim_no].angriffe).forEach(function (a) { att[a.feature_id] = a.ergebnis; });
      arr(c.merkmale).forEach(function (m) {
        if (!m.markush) return;
        var r = m.markush.app_ergebnis || m.markush.ergebnis, rank = { entfaellt: 0, faellt_nicht_unter_formel: 1, unklar: 2, formel_fehlt: 2, faellt_unter_formel: 3 };
        if ((rank[r] || 0) > (rank[mk] || 0)) mk = r;
        var best = arr(m.markush.mappings).filter(function (x) { return x.mapping_id === m.markush.bestes_mapping; })[0] || arr(m.markush.mappings)[0];
        if (best) arr(best.zuordnung).forEach(function (z) { if (z.verdict === 'nicht_erfuellt') mkMiss.push(str(z.variable)); });
      });
      arr(c.aequivalenz).forEach(function (a) { if ((EQ_RANK[a.aequivalenz_risiko] || 0) > (EQ_RANK[eq] || 0)) eq = a.aequivalenz_risiko; });
      var d = {
        claim_no: c.claim_no, kategorie: str(c.kategorie), literal_b: c.app.literal, literal_e: c.app.literal_e || null,
        tragende_merkmale: arr(c.merkmale).filter(function (m) { return m.app && m.app.verdict === 'nicht_erfuellt'; }).map(function (m) { return { feature_id: m.feature_id, claim_quote: str(m.claim_quote).slice(0, 400), product_value: m.product_value == null ? null : str(m.product_value).slice(0, 200), robustheit: str(c.robustheit), redteam: att[m.feature_id] || null }; }),
        unklare_merkmale: arr(c.merkmale).filter(function (m) { return m.app && m.app.verdict === 'unklar'; }).map(function (m) { return { feature_id: m.feature_id, claim_quote: str(m.claim_quote).slice(0, 400), klaerung: m.app.forced ? 'set to unclear by the app: ' + codeText(m.app.forced) : (m.klaerung == null ? null : str(m.klaerung).slice(0, 300)) }; }),
        markush_ergebnis: mk, markush_fehlende_variablen: mkMiss, aequivalenz_risiko_max: eq, engster_treffender_unteranspruch: fb[c.claim_no] === undefined ? null : fb[c.claim_no]
      };
      return d;
    });
    var g0 = chart.gesamt || {}, mods = arr(g0.modifikatoren).slice();
    e.right.modifiers.concat(chart.app.flags.indexOf('formel_fehlt') >= 0 ? ['formel_fehlt'] : []).forEach(function (m) { if (mods.indexOf(m) < 0) mods.push(m); });
    return {
      patent_id: e.pn, family_id: e.family == null ? null : String(e.family), jurisdiction: e.right.jurisdiction, assignees: e.assignee ? String(e.assignee).split(/;\s*/) : [], title: str(e.title), is_granted: !!e.right.granted,
      status: e.statusText, status_snapshot_date: e.right.asof, filing_date: e.filing || null, expiry_estimate: e.right.expiry.date, relevanz: e.rel === 'A' ? 'A' : 'B', claims: claims,
      risiko_b: e.risk.b, risiko_e: e.risk.e, risiko_final: e.risk.final, modifikatoren: mods, ausnahmen: g0.ausnahmen || null,
      umgehungsloesungen: arr(g0.umgehungsloesungen).slice(0, 6), offene_fragen: (e.app && e.app.evidence ? arr(e.app.evidence.questions) : []).concat(arr(g0.offene_fragen)).concat(rt ? arr(rt.zu_klaeren) : []).slice(0, 10).map(function (s) { return str(s).slice(0, 300); }),
      zitat_pruefung_fehlgeschlagen: chart.app.quotes.failed > 0
    };
  }

  // ------------------------------------------------------------------------------------------------ app-computed evidence
  /* Evidence computed by code from stored data (FTO_METHOD "App-computed evidence"): numeric ranges of the claims
     (LnpRanges, xdata "ranges") and Markush records (LnpMarkush, stored and curated mk-1 records). It may add flags and
     questions and raise a risk floor; it never lowers a risk and never turns "unclear" into "not met". */
  var EV_LIMITS = [
    'Evidence computed by the app: deterministic code on stored data (range table of the claims, Markush records); no model output.',
    'It can add flags and questions for counsel and raise a risk floor; it never lowers a risk.',
    'Only claims with a stored or curated Markush record and ranges found by the pattern rules are covered; everything else is not checked here.',
    'Pre-screening, not legal advice.'
  ];
  function pnKey(s) { return str(s).replace(/[\s,]/g, '').toUpperCase(); }
  /* a Markush result counts as "translation reviewed" when the record is curated, typed by the user, or a Claude
     translation that a person marked as reviewed */
  function mkReviewed(row) {
    var r = (row && row.result) || {}, origin = (row && row.origin) || r.origin || null;
    return r.caveat !== 'translation_not_reviewed' && (origin !== 'claude' || r.reviewed === true);
  }
  function mkRecords(ctx) {
    var mk = xeng('markush');
    if (!mk || !mk.list) return Promise.resolve([]);
    if (!ctx.mkList) ctx.mkList = Promise.resolve(mk.list({ curated: true })).then(function (rs) { return arr(rs).filter(function (r) { return r && r.pn && r.claim != null; }); }, function () { return []; });
    return ctx.mkList;
  }
  /* what the evidence depends on, for the opinion id: Markush record ids + updated, range dataset build; null without engines */
  function evidenceInputs(ctx) {
    var mk = xeng('markush'), rg = xeng('ranges'), data = eng('data');
    if (!mk && !rg) return Promise.resolve(null);
    var out = {};
    return mkRecords(ctx).then(function (rs) {
      if (mk) out.markush = rs.map(function (r) { return [pnKey(r.pn) + '--c' + r.claim, str(r.updated), str(r.origin), !!r.reviewed]; }).sort();
      if (!rg) return null;
      return Promise.resolve(rg.init ? rg.init() : null).then(null, function () { return null; }).then(function () {
        var x = data && data.manifest && data.manifest.x && data.manifest.x.ranges, inf = rg.info ? rg.info() : null;
        out.ranges = { available: !!(rg.available && rg.available()), built: (x && x.built) || null, v: (inf && inf.v) || (x && x.v) || null, rows: (inf && inf.rows) || null };
      });
    }).then(function () { return out; });
  }
  function unitOk(a, b) {
    a = str(a).toLowerCase().replace(/\s+/g, ''); b = str(b).toLowerCase().replace(/\s+/g, '');
    return !a || !b || a === b || (a === '%' && (b === 'mol%' || b === 'wt%')) || (b === '%' && (a === 'mol%' || a === 'wt%'));
  }
  function rgDist(r, x) { if (r.lo != null && x < r.lo) return r.lo - x; if (r.hi != null && x > r.hi) return x - r.hi; return 0; }
  /* ranges per claim of one publication: the statuses of LnpRanges.check for claims with at least one value inside;
     for the other claims a value is "outside" when the claim states a range for that parameter (and component) */
  function rangesFor(ctx, pn) {
    var rg = xeng('ranges'), form = ctx.profile && ctx.profile._app && ctx.profile._app.form;
    var base = { available: false, reason: null, built: null, values: [], notes: [], claims: [], limits: rg && rg.limits ? rg.limits() : [] };
    return Promise.resolve(rg.init ? rg.init() : null).then(null, function () { return null; }).then(function () {
      var data = eng('data'), x = data && data.manifest && data.manifest.x && data.manifest.x.ranges;
      base.built = (x && x.built) || null;
      if (!rg.available || !rg.available()) { base.reason = 'range data not available: ' + str(rg.reason ? rg.reason() : 'not in this build'); return base; }
      base.available = true;
      if (!form) { base.reason = 'the profile carries no form values (it was not built by normalizeProfile)'; return base; }
      return Promise.all([rg.checkProfile(form, { pns: [pn], mode: 'any' }), rg.forPatent(pn)]).then(function (r) {
        var res = r[0] || {}, pat = arr(r[1]), V = arr(res.values), by = {};
        base.values = V.map(function (v) { return { param: v.param, label: v.paramLabel, comp: v.compLabel || null, value: v.value, unit: v.unit || '' }; });
        base.notes = arr(res.skippedNotes).concat(arr(res.skipped).map(function (s) { return str(s.reason); }));
        if (!V.length) { base.reason = 'the profile has no value that a claim range could be compared with'; return base; }
        arr(res.all).concat(arr(res.partial)).forEach(function (it) { if (it.pn === pn) by[it.claim] = it; });
        pat.forEach(function (pc) {
          var it = by[pc.claim], vals = V.map(function (v, k) {
            var st, row = null, cu = false;
            if (it && it.values[k]) { st = it.values[k].status; row = it.values[k].row; cu = !!it.values[k].compUnknown; }
            else {
              var rows = [], pm = pc.params[v.param] || {};
              Object.keys(pm).forEach(function (ck) { arr(pm[ck]).forEach(function (rw) { if (unitOk(rw.unit, v.unit)) rows.push(rw); }); });
              if (v.comp != null && v.comp >= 0) {
                var ex = rows.filter(function (rw) { return rw.comp === v.comp; });
                if (ex.length) rows = ex; else { rows = rows.filter(function (rw) { return rw.comp < 0 || rw.compId === 'total'; }); cu = rows.length > 0; }
              }
              if (!rows.length) st = 'no_range_in_claim';
              else { st = 'outside'; row = rows.slice().sort(function (a, b) { return rgDist(a, v.value) - rgDist(b, v.value); })[0]; }
            }
            st = st === 'no_range_in_claim' ? 'no_range' : st;
            return { param: v.param, label: v.paramLabel, comp: v.compLabel || null, value: v.value, unit: v.unit || '', status: st, range: row ? row.text : null, fromClaim: row ? row.fromClaim : null, inherited: !!(row && row.inherited), approx: !!(row && row.approx), compUnknown: cu, row: row };
          });
          if (!vals.some(function (x) { return x.status !== 'no_range'; })) return;
          // all_inside: every value for which the claim states a range is inside it (values without a range in the claim do not count)
          var nIn = vals.filter(function (x) { return x.status === 'inside'; }).length, nOut = vals.filter(function (x) { return x.status === 'outside'; }).length;
          base.claims.push({ claim: pc.claim, indep: !!pc.indep, deps: arr(pc.deps), verdict: nOut ? (nIn ? 'partial' : 'outside') : 'all_inside', values: vals });
        });
        // verbatim quotes of the deciding ranges (from the file or cut from the claim text), at most 60 per publication
        var n = 0, ch = Promise.resolve();
        base.claims.forEach(function (c) {
          c.values.forEach(function (v) {
            var rw = v.row; delete v.row;
            if (!rw) return;
            if (++n > 60) { v.quote = null; v.quoteSource = 'not loaded (more than 60 rows)'; return; }
            ch = ch.then(function () {
              return Promise.resolve(rg.quote ? rg.quote(rw) : null).then(function (q) {
                v.quote = q && q.text ? str(q.text).slice(0, 240) : (rw.q || null); v.quoteVerified = q ? q.verified : null; v.quoteSource = q ? q.source : (rw.q ? 'file' : 'none');
              }, function () { v.quote = rw.q || null; v.quoteVerified = null; v.quoteSource = rw.q ? 'file' : 'none'; });
            });
          });
        });
        return ch.then(function () { return base; });
      });
    }).then(null, function (e) { base.reason = 'range check failed: ' + str(e && (e.message || e.code)); base.claims = []; return base; });
  }
  function profileLipids(profile) {
    var l = arr(profile && profile._app && profile._app.lipids).filter(function (c) { return c && c.ok && c.smiles; });
    if (!l.length && profile && profile.ionizable_lipid && profile.ionizable_lipid.smiles && !arr(profile._app && profile._app.lipids).length) l = [{ role: 'ionizable', name: profile.ionizable_lipid.name_user, smiles: profile.ionizable_lipid.smiles }];
    return l;
  }
  function markushFor(ctx, pn) {
    var mk = xeng('markush'), out = { records: [], results: [], errors: [], limits: [] };
    return mkRecords(ctx).then(function (rs) {
      var mine = rs.filter(function (r) { return pnKey(r.pn) === pnKey(pn); }).sort(function (a, b) { return a.claim - b.claim; }), lipids = profileLipids(ctx.profile), ch = Promise.resolve();
      out.records = mine.map(function (r) { return { claim: r.claim, origin: r.origin || null, reviewed: !!r.reviewed, updated: r.updated || null }; });
      if (!mine.length || !lipids.length || !mk.batch) return out;
      var targets = mine.map(function (r) { return { pn: r.pn, claim: r.claim }; });
      lipids.forEach(function (c) {
        var nm = str(c.name || c.ref_name || c.role);
        ch = ch.then(function () {
          return Promise.resolve(mk.batch(c.smiles_canonical || c.smiles, targets, { signal: ctx.signal })).then(function (rows) {
            arr(rows).forEach(function (row) {
              if (!row || !row.result) { out.errors.push({ lipid: nm, claim: row && row.claim, reason: row ? str(row.reason) : 'error' }); return; }
              var r = row.result;
              arr(r.limits).forEach(function (x) { if (out.limits.indexOf(str(x)) < 0) out.limits.push(str(x)); });
              out.results.push({ claim: row.claim, lipid: nm, role: c.role || null, smiles: c.smiles_canonical || c.smiles, overall: r.overall, raw: r.raw || null, caveat: r.caveat || null, reviewed: mkReviewed(row), origin: row.origin || r.origin || null,
                reasons: arr(r.reasons).slice(0, 6).map(str), coreMatched: !!(r.core && r.core.matched),
                groups: arr(r.groups).filter(function (gr) { return gr && gr.verdict !== 'n/a'; }).map(function (gr) { return { name: str(gr.name), kind: gr.kind || null, verdict: gr.verdict, why: str(gr.why).slice(0, 300), fragment: gr.fragment == null ? null : str(gr.fragment).slice(0, 200), quote: str(gr.quote).slice(0, 400), quoteStatus: gr.quoteStatus || null }; }),
                provisos: arr(r.provisos).map(function (pv) { return { quote: str(pv.quote).slice(0, 400), quoteStatus: pv.quoteStatus || null, matched: pv.matched, why: str(pv.why).slice(0, 200) }; }) });
            });
          }, function (e) { if (e && e.code === 'cancelled') throw e; out.errors.push({ lipid: nm, reason: str(e && (e.code || e.message)) }); });
        });
      });
      return ch.then(function () { return out; });
    });
  }
  /* computes e.app.evidence (nothing when neither engine is loaded); never rejects except on cancel */
  function evidenceFor(ctx, e) {
    var mk = xeng('markush'), rg = xeng('ranges');
    if (!mk && !rg) return Promise.resolve(null);
    var ev = { v: 1, created: nowDate().toISOString(), ranges: null, markush: null, applied: [], flags: [], questions: [], limits: EV_LIMITS.slice() }, p = Promise.resolve();
    if (rg) p = p.then(function () { return rangesFor(ctx, e.pn).then(function (r) { ev.ranges = r; }); });
    if (mk) p = p.then(function () { return markushFor(ctx, e.pn).then(function (r) { ev.markush = r; }, function (x) { if (x && x.code === 'cancelled') throw x; ev.markush = { records: [], results: [], errors: [{ reason: str(x && (x.code || x.message)) }], limits: [] }; }); });
    return p.then(function () {
      if (ev.ranges) arr(ev.ranges.limits).forEach(function (x) { if (ev.limits.indexOf(x) < 0) ev.limits.push(x); });
      if (ev.markush) ev.markush.limits.forEach(function (x) { if (ev.limits.indexOf(x) < 0) ev.limits.push(x); });
      (e.app = e.app || {}).evidence = ev;
      return ev;
    });
  }
  /* the rules, applied in code after the model chart (checkChart): floors only, flags, questions */
  function applyEvidence(chart, e, cs) {
    var ev = e.app && e.app.evidence;
    /* independence of a claim: from the claim set; without one (no claim text) from the range table, else unknown (null) */
    function indepOf(no) {
      if (cs && cs.byNo[no]) return !!cs.byNo[no].indep;   // a claim number outside the claim set is unknown (null), not dependent
      var rc = ev && ev.ranges ? arr(ev.ranges.claims).filter(function (c) { return c.claim === no; })[0] : null;
      return rc ? !!rc.indep : null;
    }
    if (!ev || !chart || !chart.app) return;
    var right = e.right || {}, risk = chart.app.risk, notes = chart.app.notes, flags = ev.flags, qs = ev.questions;
    function flag(f) { if (flags.indexOf(f) < 0) flags.push(f); if (e.flags.indexOf(f) < 0) e.flags.push(f); }
    function raise(to, why, rule) {
      if (riskRank(to) > riskRank(risk)) { notes.push('Risk raised from ' + rl(risk) + ' to ' + rl(to) + ': ' + why); ev.applied.push({ rule: rule, from: risk, to: to, text: why }); risk = to; }
      else ev.applied.push({ rule: rule, from: risk, to: risk, text: why + ' (risk already at or above ' + rl(to) + ')' });
    }
    if (ev.markush) arr(ev.markush.results).forEach(function (r) {
      if (r.overall !== 'covered') return;
      var indep = indepOf(r.claim);
      var why = 'Markush check: ' + r.lipid + ' covered by claim ' + r.claim + ' (code-verified, translation ' + (r.reviewed ? 'reviewed' : 'not reviewed') + ')';
      if (indep === null) why += '; whether claim ' + r.claim + ' is independent cannot be checked (no claim text in the corpus), floor applied as a precaution';
      flag(r.reviewed ? 'markush_covered' : 'markush_covered_unreviewed');
      if (indep === false) { ev.applied.push({ rule: 'markush_covered', from: risk, to: risk, text: why + '; claim ' + r.claim + ' is not an independent claim of the corpus text, no floor applied' }); return; }
      if (right.dead) { ev.applied.push({ rule: 'markush_covered', from: risk, to: risk, text: why + '; the right is not in force, no floor applied' }); return; }
      if (r.reviewed) raise(right.granted ? '5_sehr_hoch' : '3_mittel', why + (right.granted ? ': floor as for a literally met independent claim of a granted right' : ': floor as for a claim of an application that reads on the product'), 'markush_covered_reviewed');
      else raise('3_mittel', why + ': floor "possible" (medium) until the translation is reviewed', 'markush_covered_unreviewed');
      var cc = arr(chart.claims).filter(function (c) { return c.claim_no === r.claim; })[0];
      if (cc && cc.app && cc.app.literal === 'wortsinngemaess_nicht_erfuellt') { flag('markush_contradicts_chart'); qs.push('Claim ' + r.claim + ': the claim chart finds a literal miss, but the code-verified Markush check finds ' + r.lipid + ' covered by the formula - check the chart against the formula.'); }
    });
    if (ev.ranges) {
      var outs = [], alls = [];
      arr(ev.ranges.claims).forEach(function (c) {
        var src = cs && cs.byNo[c.claim], indep = src ? !!src.indep : !!c.indep;
        if (!indep) return;
        if (c.verdict === 'all_inside') alls.push(c.claim);
        c.values.forEach(function (v) { if (v.status === 'outside') outs.push({ c: c, v: v }); });
      });
      if (outs.length) {
        flag('range_outside');
        outs.forEach(function (x) { qs.push('Claim ' + x.c.claim + ': product value ' + x.v.value + (x.v.unit ? ' ' + x.v.unit : '') + ' (' + x.v.label + (x.v.comp ? ', ' + x.v.comp : '') + ') is outside the claimed range ' + str(x.v.range) + (x.v.quote ? ' ("' + x.v.quote + '")' : '') + '. Not used to lower the risk: "about", the basis and method of the value and equivalence are open.'); });
        ev.applied.push({ rule: 'range_outside', from: risk, to: risk, text: outs.length + ' product value(s) outside a range of an independent claim: flag and question for counsel, risk not lowered' });
      }
      if (alls.length) { flag('ranges_all_inside'); ev.applied.push({ rule: 'ranges_all_inside', from: risk, to: risk, text: 'all compared product values inside the ranges of independent claim(s) ' + alls.join(', ') + ' (other features decide; no risk change)' }); }
    }
    chart.app.risk = risk;
  }
  /* analysis failed or no claim text: risk "cannot be assessed", then the same code-verified floors without a chart */
  function failFloor(e, cs) {
    e.risk = { b: 'nicht_beurteilbar', e: null, final: 'nicht_beurteilbar' };
    var pseudo = { claims: [], app: { risk: e.risk.final, notes: [] } };
    applyEvidence(pseudo, e, cs && arr(cs.all).length ? cs : null);
    e.risk.b = e.risk.final = pseudo.app.risk;
    return e;
  }
  /* code-verified "covered" Markush results of an entry (from e.app.evidence) */
  function mkCovOf(e) { var ev = e.app && e.app.evidence; return arr(ev && ev.markush && ev.markush.results).filter(function (r) { return r.overall === 'covered'; }); }
  function mkCovText(list) { return list.map(function (r) { return r.lipid + ' covered by claim ' + r.claim + ' (code-verified, translation ' + (r.reviewed ? 'reviewed' : 'not reviewed') + ')'; }).filter(function (t, i, l) { return l.indexOf(t) === i; }).join('; '); }

  // ------------------------------------------------------------------------------------------------ the chain
  function fatal(e) { var ai = eng('ai'); return ai && ai.isFatal ? ai.isFatal(e) : !!(e && (e.code === 'cancelled' || e.code === 'rate_limited' || e.code === 'not_granted')); }
  function userMsg(e, lang) { var ai = eng('ai'); return ai && ai.message ? ai.message(e, lang) : str(e && (e.message || e.code)); }
  function promptHash(req, extra) { return hash(req.parts.map(function (p) { return typeof p === 'string' ? p : p.t; }).join('\u0001') + '|' + str(extra)); }

  /* one model step: builds the request, reuses a saved result when the request is unchanged, otherwise calls
     LnpAI.json and saves the result. -> {out} | {failed: {code, message}}; fatal errors are thrown. */
  function step(ctx, key, req, opt) {
    opt = opt || {};
    var ai = eng('ai'), h = promptHash(req, opt.hashExtra);
    return Promise.resolve(ctx.persist ? getPart(ctx.id, key) : (ctx.mem[key] || null)).then(function (saved) {
      if (saved && saved.h === h && saved.out) { ctx.emit({ type: 'resumed', step: key }); ctx.resumed++; return { out: saved.out, meta: saved.meta || {}, resumed: true }; }
      if (ctx.signal && ctx.signal.aborted) throw mkErr('cancelled', 'cancelled');
      var meta = {};
      return ai.json(req.parts, { schema: req.schema, tier: req.label, label: req.label + ' ' + key, signal: ctx.signal, images: opt.images, check: opt.check, meta: meta,
        onText: function (u) { ctx.emit({ type: 'text', section: key, text: u.text }); },
        onStatus: function (s) {
          if (s.type === 'truncated') ctx.warn('Step ' + key + ': input shortened (' + s.cuts.map(function (c) { return c.label + ' -' + c.removedBytes + ' bytes'; }).join(', ') + ')');
          else if (s.type === 'repair') ctx.emit({ type: 'repair', step: key, errors: s.errors.length, detail: s.errors.slice(0, 3) });
          else if (s.type === 'tier') ctx.warn('Step ' + key + ': model tier ' + s.asked + ' not available, ' + s.applied + ' used');
          else if (s.type === 'images_dropped') ctx.warn('Step ' + key + ': ' + s.n + ' formula image(s) not sent');
        } }).then(function (out) {
        var m = { cuts: arr(meta.cuts).map(function (c) { return { label: c.label, removedBytes: c.removedBytes }; }), repaired: !!meta.repaired, imagesSent: meta.imagesSent || 0, imagesDropped: meta.imagesDropped || 0, tier: meta.tierApplied || meta.tier };
        ctx.calls += meta.calls || 1;
        ctx.emit({ type: 'usage', calls: ctx.calls, usage: ai.usage ? ai.usage() : null });
        var save = ctx.persist ? putPart(ctx.id, key, { h: h, out: out, meta: m }).then(function (n) { ctx.head.steps[key] = n; return ctx.saveHead(); }) : Promise.resolve(ctx.mem[key] = { h: h, out: out, meta: m });
        return save.then(function () { ctx.emit({ type: 'saved', step: key }); return { out: out, meta: m }; }, function (e) { ctx.warn('Step ' + key + ' could not be saved: ' + str(e && (e.message || e.code))); return { out: out, meta: m }; });
      }, function (e) {
        ctx.calls += meta.calls || 1;
        ctx.emit({ type: 'usage', calls: ctx.calls, usage: ai.usage ? ai.usage() : null });
        if (fatal(e)) throw e;
        ctx.warn('Step ' + key + ' failed: ' + userMsg(e, ctx.lang));
        return { failed: { code: e.code, message: userMsg(e, ctx.lang) } };
      });
    });
  }

  function biblioFor(e, cs) {
    return { patent_id: e.pn, jurisdiction: e.right.jurisdiction, kind: e.kind, is_granted: !!e.right.granted, title: str(e.title), assignees: e.assignee ? String(e.assignee).split(/;\s*/) : [], priority_date: e.priority || null, filing_date: e.filing || null,
      claims_language: cs.lang, claims_source: 'original', claims_version: (e.right.granted ? (/^B[23]$/.test(str(e.kind)) ? 'amended ' : /^B9$/.test(str(e.kind)) ? 'corrected ' : 'as granted ') : 'as published ') + str(e.kind) };
  }
  function statusFor(e) {
    var r = e.right, st = e.statusDetail || {};
    return { snapshot_date: r.asof, status: r.dead ? r.deadReason : r.code, status_text: r.text, status_unverified: r.unverified, in_force_de: r.inForceDe, expiry_estimate: r.expiry.date, expiry_basis: r.expiry.basis,
      opposition: r.opposition, appeal: r.appeal, unitary: r.unitary, lapsed_in: r.lapsedIn.map(function (x) { return x.cc; }), events: arr(st.events).slice(0, 6), note: r.note };
  }
  /* which images go with a set of claims; -> {images: [blob], img: {lines, missing} | null, missing: {claimNo: true}} */
  function imagePlan(claims, imgs, lim) {
    var canSend = !!(lim && lim.images && lim.images.maxCount > 0), maxN = canSend ? lim.images.maxCount : 0, images = [], lines = [], missing = {}, missList = [];
    claims.forEach(function (c) {
      if (!c.ph) return;
      var mine = imgs.filter(function (i) { return i.claim === c.n; }), sent = 0;
      mine.forEach(function (im, k) {
        if (images.length < maxN && (!lim.images.maxInputBytes || !(im.blob.size > lim.images.maxInputBytes))) { images.push(im.blob); sent++; lines.push('image ' + images.length + ' = claim ' + c.n + ', placeholder ' + (k + 1) + (im.id ? ' (' + String(im.id).replace(/[^A-Za-z0-9_-]/g, '') + ')' : '')); }
      });
      if (sent < c.ph) { missing[c.n] = true; missList.push('claim ' + c.n + (sent ? ' (only ' + sent + ' of ' + c.ph + ' placeholders have an image)' : '')); }
    });
    return { images: images, img: images.length ? { lines: lines, missing: missList.join(', ') } : null, missing: missing };
  }
  function mergeCharts(parts) {
    if (parts.length === 1) return parts[0];
    var out = clone(parts[0]), i;
    for (i = 1; i < parts.length; i++) {
      out.claims = arr(out.claims).concat(arr(parts[i].claims));
      var a = out.gesamt || {}, b = parts[i].gesamt || {};
      if (riskRank(b.risiko) > riskRank(a.risiko)) { b = clone(b); ['umgehungsloesungen', 'offene_fragen', 'fuer_unteransprueche', 'hinweise', 'modifikatoren'].forEach(function (k) { b[k] = arr(a[k]).concat(arr(b[k])); }); out.gesamt = b; }
      else ['umgehungsloesungen', 'offene_fragen', 'fuer_unteransprueche', 'hinweise', 'modifikatoren'].forEach(function (k) { a[k] = arr(a[k]).concat(arr(b[k])); });
      if (parts[i].textqualitaet && out.textqualitaet) out.textqualitaet.probleme = arr(out.textqualitaet.probleme).concat(arr(parts[i].textqualitaet.probleme));
    }
    out.gesamt.modifikatoren = arr(out.gesamt.modifikatoren).filter(function (m, k, l) { return l.indexOf(m) === k; });
    return out;
  }
  /* B (+ C, E) for one patent; fills e.chart, e.dependent, e.redteam, e.risk, e.digest, e.flags */
  function analysePatent(ctx, e) {
    var P = eng('prompts'), ai = eng('ai'), product = productForModel(ctx.profile, false), depth = ctx.depthCfg;
    e.flags = e.flags || [];
    return Promise.all([claimSet(e.p, e), Promise.resolve(eng('search').defs ? eng('search').defs(e.p) : []).then(null, function () { return []; }), ai.limits(), e.app && e.app.evidence ? e.app.evidence : evidenceFor(ctx, e)]).then(function (r) {
      var cs = r[0], defs = arr(r[1]), lim = r[2];
      if (!cs || !cs.indep.length) { e.failed = { step: 'B', code: 'no_claims', message: 'no independent claim text in the corpus' }; return failFloor(e, cs); }
      e.claimsLang = cs.lang;
      return imagesFor(e.p, e, cs).then(function (imgs) {
        // B: one call, or several when the independent claims are very long
        var groups = [], cur = [], size = 0;
        cs.indep.forEach(function (c) { var b = c.text.length; if (cur.length && size + b > 110000) { groups.push(cur); cur = []; size = 0; } cur.push(c); size += b; });
        if (cur.length) groups.push(cur);
        var charts = [], missing = {}, cutClaims = {}, chain = Promise.resolve(), failed = null, imgSent = 0;
        groups.forEach(function (grp, gi) {
          chain = chain.then(function () {
            if (failed) return null;
            var plan = imagePlan(grp, imgs, lim), k;
            for (k in plan.missing) missing[k] = true;
            var req = P.buildB({ lang: ctx.lang, product: product, biblio: biblioFor(e, cs), status: statusFor(e), claims: grp, defs: defs, img: plan.img });
            var want = grp.map(function (c) { return c.n; });
            ctx.emit({ type: 'stage', stage: 'chart', pn: e.pn, part: gi + 1, parts: groups.length });
            return step(ctx, 'B.' + e.pn + (groups.length > 1 ? '.' + (gi + 1) : ''), req, { images: plan.images, hashExtra: 'img' + plan.images.length,
              check: function (v) { var have = {}, errs = []; arr(v.claims).forEach(function (c) { have[c.claim_no] = 1; }); want.forEach(function (n) { if (!have[n]) errs.push({ path: '$.claims', message: 'no entry for independent claim ' + n + '; every independent claim in <claims> needs its own entry' }); }); return errs; } }).then(function (res) {
              if (res.failed) { failed = res.failed; return; }
              arr(res.meta.cuts).forEach(function (c) { var m = /^claim (\d+)$/.exec(str(c.label)); if (m) cutClaims[m[1]] = true; });
              if (res.meta.imagesDropped) grp.forEach(function (c) { if (c.ph) missing[c.n] = true; });
              imgSent += res.meta.imagesSent || 0;
              charts.push(res.out);
            });
          });
        });
        return chain.then(function () {
          if (failed || !charts.length) { e.failed = { step: 'B', code: failed ? failed.code : 'error', message: failed ? failed.message : 'no chart' }; return failFloor(e, cs); }
          var chart = mergeCharts(charts);
          checkChart(chart, cs, defs, { formulaMissing: missing, cutClaims: cutClaims, right: e.right });
          applyEvidence(chart, e, cs);
          chart.app.images_sent = imgSent;
          e.chart = chart; e.risk = { b: chart.app.risk, e: null, final: chart.app.risk };
          e.literal = { b: chart.app.literal_worst, e: null, final: chart.app.literal_worst, claim: chart.app.claim_worst };
          chart.app.flags.forEach(function (f) { if (e.flags.indexOf(f) < 0) e.flags.push(f); });
          ctx.emit({ type: 'chart', p: e.p, pn: e.pn, chart: chart, risk: chart.app.risk });
          var next = Promise.resolve();
          // C: dependent claims
          if (depth.dep && cs.dep.length && (e.rel === 'A' || ctx.depth === 'deep' || ctx.single)) next = next.then(function () {
            var plan = imagePlan(cs.all, imgs, lim);
            var summary = arr(chart.claims).map(function (c) { return { claim_no: c.claim_no, literal_ergebnis: c.app.literal, merkmale: arr(c.merkmale).map(function (m) { return { feature_id: m.feature_id, claim_quote: m.claim_quote, verdict: m.app.verdict }; }) }; });
            var req = P.buildC({ lang: ctx.lang, product: product, biblio: biblioFor(e, cs), status: statusFor(e), claims: cs.all, defs: defs, chartSummary: summary, img: plan.img });
            ctx.emit({ type: 'stage', stage: 'dependent', pn: e.pn });
            return step(ctx, 'C.' + e.pn, req, { images: plan.images, hashExtra: 'img' + plan.images.length }).then(function (res) {
              if (res.failed) { e.flags.push('unteransprueche_fehlgeschlagen'); e.dependentFailed = res.failed; return; }
              e.dependent = checkDependent(res.out, chart, cs);
              e.dependent.app.flags.forEach(function (f) { var x = 'unteransprueche_' + f; if (e.flags.indexOf(x) < 0) e.flags.push(x); });
              ctx.emit({ type: 'dependent', p: e.p, pn: e.pn, dependent: e.dependent });
            });
          });
          // E: red team (every chart that is not already "met" throughout, and every chart with flags)
          var allMet = arr(chart.claims).every(function (c) { return c.app.literal === 'wortsinngemaess_erfuellt'; });
          if (depth.red && !(allMet && !chart.app.flags.length)) next = next.then(function () {
            var plan = imagePlan(cs.indep, imgs, lim);
            var reduced = { patent_id: e.pn, claims: arr(chart.claims).map(function (c) {
              return { claim_no: c.claim_no, literal_ergebnis: c.app.literal, tragende_merkmale: arr(c.tragende_merkmale), merkmale: arr(c.merkmale).map(function (m) {
                var x = { feature_id: m.feature_id, claim_quote: m.claim_quote, verdict: m.app.verdict, annahme: m.annahme == null ? null : m.annahme };
                if (m.verdict !== 'erfuellt') { x.begruendung = m.begruendung; x.product_value = m.product_value; if (m.markush) x.markush_ergebnis = m.markush.ergebnis; }
                if (m.app.flag) x.app_hinweis = m.app.flag; if (m.app.forced) x.app_urteil_gesetzt = m.app.forced;
                return x; }), aequivalenz: arr(c.aequivalenz).map(function (a) { return { feature_id: a.feature_id, aequivalenz_risiko: a.aequivalenz_risiko }; }) }; }),
              gesamt: { risiko: chart.app.risk, ausnahmen: (chart.gesamt && chart.gesamt.ausnahmen) || null } };
            var req = P.buildE({ lang: ctx.lang, product: product, biblio: biblioFor(e, cs), status: statusFor(e), claims: cs.indep, defs: defs, chart: reduced, img: plan.img });
            ctx.emit({ type: 'stage', stage: 'redteam', pn: e.pn });
            return step(ctx, 'E.' + e.pn, req, { images: plan.images, hashExtra: 'img' + plan.images.length }).then(function (res) {
              if (res.failed) { e.flags.push('gegenpruefung_fehlgeschlagen'); e.redteamFailed = res.failed; return; }
              e.redteam = res.out;
              var rr = applyRedTeam(e.redteam, chart, e.right);
              e.risk = { b: rr.b, e: rr.e, final: rr.final }; e.literal = { b: chart.app.literal_worst, e: e.redteam.app.literal_worst, final: rr.literal, claim: rr.claim };
              if (e.redteam.app.escalation) e.flags.push('eskalation_durch_gegenpruefung');
              ctx.emit({ type: 'redteam', p: e.p, pn: e.pn, report: e.redteam, risk: e.risk });
            });
          });
          return next.then(function () { e.digest = buildDigest(e); return e; });
        });
      });
    });
  }

  function entryFrom(cand, pat, st, markets, lang) {
    var right = rightOf(pat, st, markets);
    return { p: pat.p, pn: pat.pn, auth: pat.auth, kind: pat.kind, title: pat.title, assignee: pat.assignee, player: pat.player || null, family: pat.fam, filing: (st && (st.term_base || st.filing)) || ymd(pat.app), priority: ymd(pat.prio), hasText: !!pat.text, textCut: !!pat.textCut,
      routes: arr(cand.routes), score: cand.score || 0, why: arr(cand.why), right: right, statusText: statusLabel(right, lang), statusDetail: st ? { events: arr(st.events).slice(0, 6), fees_paid_years: st.fees_paid_years || null, src: st.src || null } : null,
      rel: null, relWhy: null, triage: null, flags: [] };
  }
  var FORBIDDEN = [/\bfree to operate\b/i, /\bfreedom to operate (is|was) (given|confirmed)\b/i, /\bno infringement\b/i, /\bdoes not infringe\b/i, /\bnon-infringing\b/i, /\bkeine (patent)?verletzung\b/i, /\bverletzt (kein|nicht)\b/i, /\bfrei von rechten dritter\b/i, /\bfto (ist |liegt )?(gegeben|best\u00e4tigt|vor)\b/i, /\b(ist|sind) frei\b/i, /\bunbedenklich\b/i, /\brisikolos\b/i];
  function wordingIssues(o) {
    var out = [];
    (function walk(v, path) {
      if (typeof v === 'string') { for (var i = 0; i < FORBIDDEN.length; i++) { var m = FORBIDDEN[i].exec(v); if (m) { if (out.length < 12) out.push({ path: path, phrase: m[0] }); break; } } }
      else if (Array.isArray(v)) v.forEach(function (x, i) { walk(x, path + '[' + i + ']'); });
      else if (v && typeof v === 'object') for (var k in v) walk(v[k], path + '.' + k);
    })(o, '$');
    return out;
  }
  function overallRisk(patents) {
    var m = { DE: { market: 'DE', risk: null, drivers: [] }, EP_UPC: { market: 'EP_UPC', risk: null, drivers: [] }, US: { market: 'US', risk: null, drivers: [] } }, pend = { risk: null, drivers: [] };
    function put(t, e) { var r = e.risk.final; if (!t.risk || riskRank(r) > riskRank(t.risk)) { t.risk = r; t.drivers = [e.pn]; } else if (r === t.risk && t.drivers.length < 8) t.drivers.push(e.pn); }
    patents.forEach(function (e) {
      if (!e.risk || e.right.dead) return;
      if (!e.right.granted) { put(pend, e); return; }
      if (e.right.jurisdiction === 'EP') { if (e.right.markets.indexOf('EP') >= 0 || e.right.markets.indexOf('UPC') >= 0) put(m.EP_UPC, e); if (e.right.markets.indexOf('DE') >= 0 && e.right.inForceDe !== false) put(m.DE, e); }
      else if (e.right.jurisdiction === 'US' && e.right.markets.indexOf('US') >= 0) put(m.US, e);
    });
    return { markets: [m.DE, m.EP_UPC, m.US], pending: pend };
  }

  function normalizeCandidates(list) {
    var data = eng('data'), chain = Promise.resolve(), out = [];
    arr(list).forEach(function (c) {
      chain = chain.then(function () {
        if (typeof c === 'number') { out.push({ p: c, routes: ['manual'], score: 0, why: [] }); return null; }
        if (typeof c === 'string') return Promise.resolve(data.byPn(c)).then(function (p) { if (p >= 0) out.push({ p: p, routes: ['manual'], score: 0, why: [] }); });
        if (c && c.p >= 0) { out.push({ p: c.p, routes: arr(c.routes), score: c.score || 0, why: arr(c.why) }); return null; }
        if (c && c.pn) return Promise.resolve(data.byPn(c.pn)).then(function (p) { if (p >= 0) out.push({ p: p, routes: arr(c.routes), score: c.score || 0, why: arr(c.why) }); });
        return null;
      });
    });
    return chain.then(function () { var seen = {}; return out.filter(function (c) { if (seen[c.p]) return false; seen[c.p] = 1; return true; }); });
  }

  /* run(profile, {patents, depth: "quick"|"standard"|"deep", lang, markets, onEvent, signal, id, searchRecord, persist})
     also accepted: run({profile | features, candidates | patents, ...}).
     -> Opinion. Sequential, resumable: every finished model step is saved through LnpStore under the opinion id (the id
     is derived from the inputs, so the same call after a reload continues where it stopped; resume(id) does the same
     from the saved head). Rejects with {code, message, id, userMessage} on abort ("cancelled"), "rate_limited",
     "not_granted" and the like; what was finished stays saved. */
  function run(profile, o) {
    if (profile && !o && (profile.profile || profile.features)) { o = profile; profile = o.features || o.profile; }
    o = o || {};
    var data = eng('data'), ai = eng('ai'), P = eng('prompts');
    if (!data || !P) return Promise.reject(mkErr('not_ready', 'LnpData and LnpFtoPrompts are required'));
    if (!profile || profile.schema_version !== 'pf-1') return Promise.reject(mkErr('bad_profile', 'profile must come from normalizeProfile()'));
    var depth = DEPTH[o.depth] ? o.depth : 'standard', lang = 'en'; // all output is English (o.lang is accepted and ignored)
    var markets = marketsOf(o.markets || (profile.handlungen && profile.handlungen.maerkte)); if (!markets.length) markets = ['DE', 'EP', 'US'];
    var emit = function (ev) { if (typeof o.onEvent === 'function') { try { o.onEvent(ev); } catch (x) { /* ignore */ } } };
    var ctx = { profile: profile, depth: depth, depthCfg: DEPTH[depth], lang: lang, markets: markets, signal: o.signal || null, emit: emit, persist: o.persist !== false, mem: {}, calls: 0, resumed: 0, warnings: [], head: null, id: null, single: false };
    ctx.warn = function (m) { if (ctx.warnings.indexOf(m) < 0) ctx.warnings.push(m); emit({ type: 'warn', message: m }); };
    var given = o.patents || o.candidates, record = o.searchRecord || (given && given.record) || null;
    return Promise.resolve(given ? given : candidates(profile, { markets: markets, signal: o.signal, onEvent: emit, semantic: o.semantic })).then(function (list) {
      if (!record && list && list.record) record = list.record;
      return normalizeCandidates(list);
    }).then(function (cands) { return evidenceInputs(ctx).then(function (x) { ctx.evIn = x; return cands; }); }).then(function (cands) {
      var snap = (data.manifest && data.manifest.snapshots) || {}, pclean = clone(profile);
      if (pclean._app) delete pclean._app.created;
      var inputHash = hash(JSON.stringify([pclean, depth, lang, markets, cands.map(function (c) { return c.p; }), snap.corpus || snap].concat(ctx.evIn ? [ctx.evIn] : [])));
      ctx.id = o.id || ('op' + inputHash);
      ctx.saveHead = function (patch) {
        if (!ctx.persist) return Promise.resolve();
        var k; if (patch) for (k in patch) ctx.head[k] = patch[k];
        ctx.head.updated = nowDate().toISOString();
        return Promise.resolve(store().put(KIND, ctx.id, ctx.head)).then(null, function (e) { ctx.warn('Saving failed: ' + str(e && (e.message || e.code))); });
      };
      return Promise.resolve(ctx.persist ? store().get(KIND, ctx.id) : null).then(null, function () { return null; }).then(function (old) {
        if (old && old.inputHash === inputHash && old.steps) { ctx.head = old; ctx.head.state = 'running'; ctx.head.error = null; emit({ type: 'resume', id: ctx.id, steps: Object.keys(old.steps).length }); }
        else ctx.head = { id: ctx.id, kind: 'fto-opinion', v: 1, created: nowDate().toISOString(), inputHash: inputHash, steps: {}, title: profile.bezeichnung, depth: depth, lang: lang, markets: markets, state: 'running',
          args: { profile: profile, patents: cands, searchRecord: record, depth: depth, lang: lang, markets: markets } };
        return ctx.saveHead();
      }).then(function () { return execute(ctx, cands, record); }).then(function (op) {
        return ctx.saveHead({ state: 'done', error: null, summary: { patents: op.patents.length, notCharted: op.notCharted.length, overall: op.overall } }).then(function () {
          if (!ctx.persist) return op;
          return putPart(ctx.id, 'opinion', op).then(function (n) { ctx.head.steps.opinion = n; return ctx.saveHead(); }).then(function () { return op; }, function (e) { ctx.warn('The pre-screen report could not be saved: ' + str(e && (e.message || e.code))); return op; });
        });
      }, function (e) {
        var err = (e && e.code) ? e : mkErr('error', str((e && e.message) || e));
        err.id = ctx.id; err.userMessage = userMsg(err, lang);
        return ctx.saveHead({ state: err.code === 'cancelled' ? 'cancelled' : 'paused', error: { code: err.code, message: err.userMessage } }).then(function () { throw err; });
      });
    });
  }

  function execute(ctx, cands, record) {
    var data = eng('data'), ai = eng('ai'), P = eng('prompts'), emit = ctx.emit, lang = ctx.lang;
    var entries = [], notCharted = [], triageCounts = { A: 0, B: 0, C: 0 }, aiOk = false, snap = (data.manifest && data.manifest.snapshots) || {};
    function skip(e, reason, text) {
      var mc = mkCovOf(e), n = { p: e.p, pn: e.pn, auth: e.auth, kind: e.kind, title: e.title, assignee: e.assignee, reason: reason, text: text, rel: e.rel, relWhy: e.relWhy, status: e.statusText, expiry: e.right.expiry.date, expiryBasis: e.right.expiry.basis, score: e.score, routes: e.routes };
      if (mc.length) { n.text = str(text) + ' | Code result (Markush): ' + mkCovText(mc); n.markushCovered = mc.map(function (r) { return { claim: r.claim, lipid: r.lipid, reviewed: r.reviewed }; }); }
      if (e.app && e.app.evidence) n.evidence = e.app.evidence;
      notCharted.push(n);
    }
    emit({ type: 'stage', stage: 'status', done: 0, total: cands.length });
    return Promise.resolve(ai ? ai.init() : false).then(function (ok) {
      aiOk = !!ok;
      return Promise.resolve(data.patents(cands.map(function (c) { return c.p; })));
    }).then(function (pats) {
      var chain = Promise.resolve();
      pats.forEach(function (pat, i) {
        if (!pat) return;
        chain = chain.then(function () {
          return Promise.resolve(pat.hasStatus === false ? null : data.status(pat.p)).then(null, function () { return null; }).then(function (st) { entries.push(entryFrom(cands[i], pat, st, ctx.markets, lang)); });
        });
      });
      return chain;
    }).then(function () {
      emit({ type: 'stage', stage: 'status', done: entries.length, total: entries.length });
      // code-verified Markush evidence first (no model): a right that code finds covered is never dropped by the
      // text gate, the model's triage or the depth cut-off, and the result is kept for rights that are not analysed
      return mkRecords(ctx).then(function (rs) {
        var has = {}, ch = Promise.resolve();
        rs.forEach(function (r) { has[pnKey(r.pn)] = 1; });
        entries.forEach(function (e) {
          if (e.auth === 'WO' || !has[pnKey(e.pn)]) return;
          ch = ch.then(function () { return evidenceFor(ctx, e).then(function () { e.mkCov = mkCovOf(e); }); });
        });
        return ch;
      });
    }).then(function () {
      function mkc(e) { return !!(e.mkCov && e.mkCov.length && !e.right.dead); }
      // jurisdiction and status gate
      var live = [];
      entries.forEach(function (e) {
        if (e.auth === 'WO') return skip(e, 'wo', 'WO publication: not enforceable; the EP/US family members count');
        if (!e.right.markets.length) return skip(e, 'market', 'no target market selected for this right');
        if (e.right.dead && !ctx.depthCfg.dead) return skip(e, 'dead', 'Legal status: ' + e.statusText + (e.right.expiry.date ? '; expiry (estimate) ' + e.right.expiry.date : '') + '; no claim chart (only at depth "deep")');
        if (!e.hasText && !mkc(e)) return skip(e, e.textCut ? 'text_cut' : 'no_text', e.textCut ? 'claim text not in the data package (size budget)' : 'no claim text in the corpus (biblio only); check a family member');
        live.push(e);
      });
      if (!aiOk) {
        live.forEach(function (e) { skip(e, 'no_ai', 'AI not available: no triage, no claim chart'); });
        ctx.warn(userMsg({ code: (ai && ai.state && ai.state().off) || 'unavailable' }, lang));
        return [];
      }
      // T: triage in batches of 10
      var batches = [], i, chain = Promise.resolve(), slim = { merkmalsliste: ctx.profile.merkmalsliste, strukturbeschreibung: ctx.profile.ionizable_lipid && ctx.profile.ionizable_lipid.strukturbeschreibung, maerkte: ctx.markets };
      for (i = 0; i < live.length; i += 10) batches.push(live.slice(i, i + 10));
      batches.forEach(function (b, bi) {
        chain = chain.then(function () {
          emit({ type: 'stage', stage: 'triage', done: bi, total: batches.length });
          var ch = Promise.resolve(), items = [];
          b.forEach(function (e) { ch = ch.then(function () { return claimSet(e.p, e).then(function (cs) { items.push({ id: e.pn, jurisdiction: e.right.jurisdiction, kind: e.kind, status: e.right.dead ? e.right.deadReason : e.right.code, granted: e.right.granted, title: e.title, claims: cs ? cs.indep.slice(0, 4).map(function (c) { return { n: c.n, text: c.text, lang: cs.lang }; }) : [] }); }); }); });
          return ch.then(function () {
            var req = P.buildT({ lang: lang, product: slim, patents: items }), want = b.map(function (e) { return e.pn; });
            return step(ctx, 'T.' + (bi + 1) + '.' + hash(want.join(',')).slice(0, 6), req, { check: function (v) { var have = {}; arr(v.ergebnisse).forEach(function (r) { have[r.patent_id] = 1; }); return want.filter(function (id) { return !have[id]; }).map(function (id) { return { path: '$.ergebnisse', message: 'no entry for patent ' + id + '; one entry per input patent is required' }; }); } });
          }).then(function (res) {
            var by = {};
            if (!res.failed) arr(res.out.ergebnisse).forEach(function (r) { by[r.patent_id] = r; });
            b.forEach(function (e) {
              var r = by[e.pn];
              if (r) { e.rel = r.relevanz; e.relWhy = str(r.grund); e.triage = r; }
              else { e.rel = 'B'; e.relWhy = res.failed ? 'triage failed (' + res.failed.code + '); class B as a precaution' : 'no triage result; class B as a precaution'; e.flags.push('triage_ohne_ergebnis'); }
              triageCounts[e.rel] = (triageCounts[e.rel] || 0) + 1;
              emit({ type: 'triage', p: e.p, pn: e.pn, rel: e.rel, why: e.relWhy });
            });
          });
        });
      });
      return chain.then(function () {
        emit({ type: 'stage', stage: 'triage', done: batches.length, total: batches.length });
        // a code-verified Markush hit overrides triage C (the model's verdict is kept in relModel and relWhy)
        live.forEach(function (e) {
          if (!mkc(e) || e.rel !== 'C') return;
          triageCounts.C--; triageCounts.B = (triageCounts.B || 0) + 1;
          e.relModel = 'C'; e.rel = 'B';
          e.relWhy = 'Triage C overridden by the code result (' + mkCovText(e.mkCov) + '); model reason: ' + str(e.relWhy);
          if (e.flags.indexOf('triage_c_ueberstimmt') < 0) e.flags.push('triage_c_ueberstimmt');
        });
        // order of analysis: rights in force before dead ones, code-verified Markush hits first, A before B, granted rights before applications, then score
        var order = live.filter(function (e) { return e.rel !== 'C'; }).sort(function (a, b) { return ((a.right.dead ? 1 : 0) - (b.right.dead ? 1 : 0)) || ((mkc(a) ? 0 : 1) - (mkc(b) ? 0 : 1)) || ((a.rel === 'A' ? 0 : 1) - (b.rel === 'A' ? 0 : 1)) || ((a.right.granted ? 0 : 1) - (b.right.granted ? 0 : 1)) || (b.score - a.score) || (a.p - b.p); });
        live.filter(function (e) { return e.rel === 'C'; }).forEach(function (e) { skip(e, 'triage_c', 'Triage C: ' + e.relWhy); });
        var cut = order.filter(function (e, k) { return k >= ctx.depthCfg.n && !mkc(e); });
        cut.forEach(function (e) { skip(e, 'depth_limit', ('Triage ' + e.rel + ' but outside the selected depth (' + ctx.depth + ': ' + ctx.depthCfg.n + ' rights) - NOT analysed') + (e.relWhy ? ': ' + e.relWhy : '')); });
        // code-verified Markush hits are analysed even beyond the depth limit
        return order.filter(function (e, k) { return k < ctx.depthCfg.n || mkc(e); });
      });
    }).then(function (todo) {
      var chain = Promise.resolve(), done = [];
      todo.forEach(function (e, i) {
        chain = chain.then(function () {
          emit({ type: 'stage', stage: 'patent', done: i, total: todo.length, pn: e.pn });
          return analysePatent(ctx, e).then(function () {
            if (e.failed) { if (!e.risk) e.risk = { b: 'nicht_beurteilbar', e: null, final: 'nicht_beurteilbar' }; e.flags.push('analyse_fehlgeschlagen'); }
            if (e.right.dead && e.risk) { e.risk.chart = e.risk.final; e.risk.final = '1_sehr_gering'; e.flags.push('rechtsstand_' + e.right.deadReason); }
            done.push(e);
          });
        });
      });
      return chain.then(function () { emit({ type: 'stage', stage: 'patent', done: todo.length, total: todo.length }); return done; });
    }).then(function (done) {
      done.sort(function (a, b) { return (riskRank(b.risk.final) - riskRank(a.risk.final)) || (b.score - a.score) || (a.p - b.p); });
      var overall = overallRisk(done), digests = done.filter(function (e) { return e.digest; }).map(function (e) { return e.digest; });
      var searchReport = { korpus_stand: snap, maerkte: ctx.markets, tiefe: ctx.depth, routen: record ? { struktur: record.structure, text: arr(record.text).map(function (t) { return { id: t.id, label: t.label, treffer: t.total, ausgewertet: t.taken }; }), schluesselfamilien: record.seed, semantisch: record.semantic, hinweise: record.notes } : null,
        kandidaten: cands.length, triage: triageCounts, analysiert: done.length,
        nicht_analysiert: notCharted.slice(0, 80).map(function (n) { return { patent_id: n.pn, grund_code: n.reason, grund: str(n.text).slice(0, 240) }; }),
        gesamtrisiko_app: overall.markets.map(function (m) { return { markt: m.market, risiko: m.risk, treibende_schutzrechte: m.drivers }; }), anhaengig_app: { risiko: overall.pending.risk, schutzrechte: overall.pending.drivers } };
      var synth = Promise.resolve(null);
      if (aiOk && digests.length) synth = Promise.resolve().then(function () {
        emit({ type: 'stage', stage: 'synthesis', done: 0, total: 1 });
        var ids = {}; digests.forEach(function (d) { ids[d.patent_id] = 1; });
        var req = P.buildD({ lang: lang, product: productForModel(ctx.profile, true), searchReport: searchReport, digests: digests });
        return step(ctx, 'D', req, { check: function (v) { var bad = []; arr(v.einzelbewertungen).forEach(function (x) { if (!ids[x.patent_id]) bad.push({ path: '$.einzelbewertungen', message: 'patent_id ' + x.patent_id + ' is not in <digests>; use only patents from the digests' }); }); return bad; } }).then(function (res) {
          if (res.failed) { ctx.warn('Synthesis failed: ' + res.failed.message); return { failed: res.failed }; }
          var s = res.out, flags = [];
          s.einzelbewertungen = arr(s.einzelbewertungen).filter(function (x) { return ids[x.patent_id]; });
          s.zeitachse = arr(s.zeitachse).filter(function (x) { if (ids[x.patent_id]) return true; flags.push('unbekannte_nummer_in_zeitachse'); return false; });
          var w = wordingIssues(s);
          if (w.length) { flags.push('formulierung_pruefen'); ctx.warn('Synthesis text contains an impermissibly sweeping phrase ("' + w[0].phrase + '"): check before use'); }
          var by = {}; overall.markets.forEach(function (m) { by[m.market] = m; });
          arr(s.gesamtrisiko).forEach(function (gr) { var m = by[gr.markt]; if (m && m.risk && gr.risiko !== m.risk) { gr.app_risiko = m.risk; gr.app_hinweis = 'computed by the app: ' + m.risk; flags.push('gesamtrisiko_abweichend'); } });
          arr(s.einzelbewertungen).forEach(function (x) { var d = digests.filter(function (y) { return y.patent_id === x.patent_id; })[0]; if (d && x.risiko !== d.risiko_final) { x.app_risiko = d.risiko_final; } });
          s.app = { flags: flags.filter(function (f, i, l) { return l.indexOf(f) === i; }), wording: w, cuts: res.meta.cuts };
          emit({ type: 'stage', stage: 'synthesis', done: 1, total: 1 });
          return s;
        });
      });
      return synth.then(function (s) {
        var usage = ai && ai.usage ? ai.usage() : null;
        var statusDate = snap.ep_register || null, dates = {};
        done.forEach(function (e) { if (e.right.asof) dates[e.right.asof] = 1; });
        var op = {
          v: 1, id: ctx.id, kind: 'fto-opinion', created: (ctx.head && ctx.head.created) || nowDate().toISOString(), finished: nowDate().toISOString(), lang: lang, depth: ctx.depth, markets: ctx.markets, aiUsed: aiOk,
          title: 'FTO pre-screen (not a legal opinion): ' + str(ctx.profile.bezeichnung),
          snapshot: snap, statusSnapshot: statusDate || Object.keys(dates).sort()[0] || null, limits: P.limits(lang, statusDate || Object.keys(dates).sort()[0] || null),
          profile: ctx.profile, search: { record: record, candidates: cands.length, triage: triageCounts, charted: done.length, report: searchReport },
          patents: done.map(function (e) {
            return { p: e.p, pn: e.pn, auth: e.auth, kind: e.kind, title: e.title, assignee: e.assignee, player: e.player, family: e.family, filing: e.filing, priority: e.priority, routes: e.routes, score: e.score, why: e.why,
              jurisdiction: e.right.jurisdiction, markets: e.right.markets, rel: e.rel, relWhy: e.relWhy, status: e.statusText, right: e.right, statusDetail: e.statusDetail, expiry: e.right.expiry, claimsLang: e.claimsLang || null,
              risk: e.risk, literal: e.literal || null, flags: e.flags, failed: e.failed || null, chart: e.chart || null, dependent: e.dependent || null, redteam: e.redteam || null, digest: e.digest || null,
              dependentFailed: e.dependentFailed || null, redteamFailed: e.redteamFailed || null, app: e.app };
          }).map(function (x) { if (!x.app) delete x.app; return x; }),
          notCharted: notCharted, overall: overall, synthesis: s && !s.failed ? s : null, synthesisFailed: s && s.failed ? s.failed : null,
          matrix: done.map(function (e) { return { pn: e.pn, jurisdiction: e.right.jurisdiction, markets: e.right.markets, rel: e.rel, risk: e.risk.final, riskB: e.risk.b, riskE: e.risk.e, literal: e.literal ? e.literal.final : null, status: e.statusText, expiry: e.right.expiry.date, expiryBasis: e.right.expiry.basis, dead: e.right.dead, pending: e.right.pending, flags: e.flags }; }),
          warnings: ctx.warnings.slice(), usage: usage ? { calls: usage.calls, bytesIn: usage.bytesIn, bytesOut: usage.bytesOut, failed: usage.failed, repairs: usage.repairs } : null, run: { calls: ctx.calls, resumedSteps: ctx.resumed }
        };
        emit({ type: 'done', id: op.id });
        return op;
      });
    });
  }

  /* chartOne(profile, pn | p, {depth = "quick", lang, markets, signal, onEvent}) -> one entry of Opinion.patents
     (claim chart with the app-side checks; "standard" adds dependent claims and red team). Nothing is saved. */
  function chartOne(profile, pn, o) {
    o = o || {};
    var data = eng('data'), ai = eng('ai'), lang = 'en';
    var markets = marketsOf(o.markets || (profile && profile.handlungen && profile.handlungen.maerkte)); if (!markets.length) markets = ['DE', 'EP', 'US'];
    var emit = function (ev) { if (typeof o.onEvent === 'function') { try { o.onEvent(ev); } catch (x) { /* ignore */ } } };
    var depth = DEPTH[o.depth] ? o.depth : 'quick';
    var ctx = { profile: profile, depth: depth, depthCfg: DEPTH[depth], lang: lang, markets: markets, signal: o.signal || null, emit: emit, persist: false, mem: {}, calls: 0, resumed: 0, warnings: [], single: true };
    ctx.warn = function (m) { ctx.warnings.push(m); emit({ type: 'warn', message: m }); };
    return Promise.resolve(ai ? ai.init() : false).then(function (ok) {
      if (!ok) throw mkErr((ai && ai.state && ai.state().off) || 'unavailable', 'Claude is not available', { userMessage: userMsg({ code: 'unavailable' }, lang) });
      return typeof pn === 'number' ? pn : data.byPn(str(pn));
    }).then(function (p) {
      if (!(p >= 0)) throw mkErr('not_found', 'unknown publication ' + pn);
      return Promise.resolve(data.patent(p)).then(function (pat) { return Promise.resolve(data.status(p)).then(null, function () { return null; }).then(function (st) { return entryFrom({ p: p, routes: ['manual'], score: 0, why: [] }, pat, st, markets.length ? markets : ['DE', 'EP', 'US'], lang); }); });
    }).then(function (e) {
      if (!e.right.markets.length) e.right.markets = e.auth === 'US' ? ['US'] : ['DE', 'EP'];
      e.rel = 'A';
      return analysePatent(ctx, e).then(function () {
        if (e.failed) { if (!e.risk) e.risk = { b: 'nicht_beurteilbar', e: null, final: 'nicht_beurteilbar' }; e.flags.push('analyse_fehlgeschlagen'); }
        if (e.right.dead && e.risk) { e.risk.chart = e.risk.final; e.risk.final = '1_sehr_gering'; e.flags.push('rechtsstand_' + e.right.deadReason); }
        e.status = e.statusText; e.expiry = e.right.expiry; e.jurisdiction = e.right.jurisdiction; e.markets = e.right.markets; e.warnings = ctx.warnings;
        e.limits = eng('prompts').limits(lang, e.right.asof);
        return e;
      });
    }).then(null, function (e) { if (e && e.code && !e.userMessage) e.userMessage = userMsg(e, lang); throw e; });
  }

  // ------------------------------------------------------------------------------------------------ saved opinions
  function list() {
    return Promise.resolve(store().list(KIND)).then(function (docs) {
      return arr(docs).filter(function (d) { return d && typeof d === 'object' && d.kind === 'fto-opinion' && !d.part; }).map(function (d) { return { id: d.id, title: d.title, created: d.created, updated: d.updated, state: d.state, depth: d.depth, lang: d.lang, error: d.error || null, steps: d.steps ? Object.keys(d.steps).length : 0, summary: d.summary || null }; })
        .sort(function (a, b) { return str(b.updated).localeCompare(str(a.updated)); });
    }, function () { return []; });
  }
  function load(id) { return getPart(id, 'opinion'); }
  /* continue a saved run that was stopped (abort, reload, rate limit) */
  function resume(id, o) {
    o = o || {};
    return Promise.resolve(store().get(KIND, id)).then(function (head) {
      if (!head || !head.args) throw mkErr('not_found', 'no saved run ' + id);
      var a = head.args;
      return run(a.profile, { patents: a.patents, searchRecord: a.searchRecord, depth: a.depth, lang: a.lang, markets: a.markets, id: id, onEvent: o.onEvent, signal: o.signal });
    });
  }
  function remove(id) {
    return Promise.resolve(store().get(KIND, id)).then(function (head) {
      var chain = Promise.resolve(), k;
      if (head && head.steps) for (k in head.steps) (function (k) { chain = chain.then(function () { return removePart(id, k, head.steps[k]); }); })(k);
      return chain.then(function () { return store().remove(KIND, id); });
    });
  }
  function render(opinion, fmt) {
    var R = eng('render');
    if (!R) throw mkErr('not_ready', 'LnpFtoRender is not loaded');
    return R.render(opinion, fmt);
  }
  function configure(o) { for (var k in o) cfg[k] = o[k]; if (o && (o.search || o.data) && eng('ai') && eng('ai').configure) eng('ai').configure({ search: o.search || eng('search'), data: o.data || eng('data') }); return api; }

  var api = {
    configure: configure, normalizeProfile: normalizeProfile, englishForm: englishForm, candidates: candidates, run: run, resume: resume, chartOne: chartOne, render: render, list: list, load: load, remove: remove,
    // deterministic parts, exported for the UI and the tests
    verifyQuote: verifyQuote, literalFromVerdicts: literalFromVerdicts, maxRisk: maxRisk, riskRank: riskRank, worseLiteral: worseLiteral, rightOf: rightOf, statusLabel: statusLabel, checkChart: checkChart, checkDependent: checkDependent,
    applyRedTeam: applyRedTeam, buildDigest: buildDigest, applyEvidence: applyEvidence, evidenceInputs: function (o) { return evidenceInputs(o || {}); }, overallRisk: overallRisk, textQueries: textQueries, wordingIssues: wordingIssues, hash: hash, DEPTH: DEPTH, RISK_RANK: RISK_RANK
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpFto = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
