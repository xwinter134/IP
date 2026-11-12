/* LNP Patent Desk: expiry timeline and patent cliff (global LnpExpiry).
   Plain ASCII script, no eval, no network of its own. Code decides everything; no model is involved.
   Every date is an ESTIMATE from the filing date (+ 20 years, + patent term adjustment for US) as the status file of the dataset
   carries it. Patent term extensions (US PTE), supplementary protection certificates (SPC), paediatric extensions, terminal
   disclaimers, maintenance fees after the snapshot and legal events after the snapshot are NOT checked. Not legal advice.

   API
     setFrom({source: 'profile'|'opinion'|'watchlist'|'selection'|'compounds'|'pns', id?, pns?, compounds?}, {family, claimsOnly, candidates, signal})
        -> Promise<p[]> with the property `info` = {source, label, ms, routes[{name, n}], notes[], unknown[]}
        profile    : lipids of a stored profile (kind "profiles") -> LnpChem exact + similarity >= 0.8 hits that are named in claims
                     (structure route, always); then LnpFto.candidates(...) without the semantic route (claim-text route) when
                     opts.candidates !== false and a normalised profile is cached (settings/pf-<id>) or Claude is not available
                     (the cache avoids a model call); info.routes says which routes ran
        opinion    : the patents of a saved FTO opinion (rights charted and not charted)
        watchlist  : starred publications (kind "marks"); selection: settings/fto-selection
        compounds  : LnpChem exact hits of the given structures / names -> LnpChem.patentsOf (claims hits only unless claimsOnly === false)
        pns        : a list of publication numbers (array or text; separators: newline , ;)
        opts.family = true adds every family member of the table (WO publications are never rights and are skipped).
     timeline(ps, {jurisdictions: ['EP','DE','US'], today?, includeWo?}) -> Promise<rows[]>; rows.families = [{family, rows[], filing, expiry, inForce, pending, dead}]
        row = {p, pn, auth, kind, family, title, assignee, status, granted, pending, inForce, inForceDe, dead, deadReason, expiredEst, superseded, jur[], filing,
               (dead: lapsed / revoked / withdrawn / refused per register; expiredEst: past the estimated date, SPC / PTE not checked)
               expiry: {date, basis, basisKind: 'filing'|'pta'|'register'|'computed', ptaDays, baseDate, pte: 'not checked', spc: 'not checked',
                        terminalDisclaimer: true|null, note}, stale, asof, src, noRecord, flags[], opposition, appeal}
        One row per right: when one application has several publications (A1 and B1, B1 and B2) the best one is the row, the others are
        `superseded` and ignored by cliff() and toIcs().
     cliff(rows, {today?}) -> {years: [{year, EP, US, pending, total}], jurisdictions: {EP, DE, US: {lastExpiry, pn, nInForce, nPending, pendingLatest, unverified, text}},
                              nRights, nDead, nSuperseded, nNoDate, caveats[], today}
     toIcs(rows, {name, stamp, includeDead}) -> text/calendar (RFC 5545: CRLF, TEXT escaping, folding at 75 octets, one all-day VEVENT per expiry)
     toCsv(rows, {sep = ';'}) -> text (BOM, formula injection neutralised)
     limits(rows?) -> text[]    configure({data, chem, fto, store, ai, now}) for tests  */
(function (g) {
  'use strict';
  var S = { cfg: {} };
  function eng(n) { return S.cfg[n] || g['Lnp' + n.charAt(0).toUpperCase() + n.slice(1)] || null; }
  function str(x) { return x == null ? '' : String(x); }
  function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function configure(c) { S.cfg = c || {}; }

  /* ------------------------------------------------------------------------------------------ dates (ISO strings, UTC arithmetic) */
  function iso(n) {
    var s = str(n).replace(/-/g, '');
    return /^\d{8}/.test(s) && s.slice(0, 8) !== '00000000' ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '';
  }
  function toMs(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function fromMs(ms) { var d = new Date(ms), y = d.getUTCFullYear(); return (y < 1000 ? ('000' + y).slice(-4) : String(y)) + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function addDays(d, n) { var t = toMs(d); return isFinite(t) ? fromMs(t + n * 864e5) : ''; }
  function addYears(d, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); if (!m) return '';
    var y = +m[1] + n, mo = +m[2], day = +m[3], dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return fromMs(Date.UTC(y, mo - 1, Math.min(day, dim)));
  }
  function daysBetween(a, b) { var x = toMs(a), y = toMs(b); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 864e5) : null; }
  function todayIso(o) { return (o && o.today) || (S.cfg.now ? S.cfg.now() : new Date().toISOString().slice(0, 10)); }

  var LIMITS = [
    'Estimates only: filing date + 20 years, plus patent term adjustment (PTA) where the US calculation of the dataset has one; US patents filed before 8 June 1995 run until the later of grant + 17 years and filing + 20 years. For continuations the date depends on the earliest non-provisional filing in the status file. Real terms can differ.',
    'A right past its estimated date is shown as "expired (estimate)", apart from rights the register shows as lapsed, revoked or withdrawn: an SPC or PTE can extend protection by up to 5 (+0.5) years.',
    'Not checked: patent term extension (PTE, 35 U.S.C. 156), supplementary protection certificates (SPC), paediatric extensions, terminal disclaimers, maintenance and renewal fees after the snapshot, assignments, licences and legal events after the snapshot.',
    'The register snapshot has a date; a status older than six months is marked stale. A missing record means the right is treated as in force but unverified.',
    'Pending applications may still be granted, narrowed or refused; their dates are the latest possible expiry, not a prediction.',
    'Pre-screening of dates, not legal advice. Verify every date at the register (EPO Register, USPTO Patent Center) before relying on it.'
  ];
  function limits(rows) {
    var out = LIMITS.slice();
    if (rows && rows.snapshot) out.push('Data snapshot: ' + Object.keys(rows.snapshot).map(function (k) { return k + ' ' + rows.snapshot[k]; }).join(', ') + '.');
    return out;
  }

  /* ------------------------------------------------------------------------------------------ sources */
  function splitList(x) {
    if (Array.isArray(x)) return x.map(str).map(function (s) { return s.trim(); }).filter(Boolean);
    return str(x).split(/[\r\n;]+|,(?!\d{3}(?!\d))/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function resolvePns(list) {
    var D = eng('data'), out = [], unknown = [];
    return list.reduce(function (chain, item) {
      return chain.then(function () {
        return Promise.resolve(D.byPn(item)).then(function (p) {
          if (p >= 0) return p;
          var parts = item.split(/\s+/).filter(Boolean);
          if (parts.length < 2) return -1;
          return Promise.all(parts.map(function (q) { return Promise.resolve(D.byPn(q)); })).then(function (ps) {
            var ok = ps.filter(function (x) { return x >= 0; }); if (ok.length === ps.length) { ok.slice(1).forEach(function (x) { out.push(x); }); return ok[0]; }
            return -1;
          });
        }, function () { return -1; }).then(function (p) { if (p >= 0) out.push(p); else unknown.push(item); });
      });
    }, Promise.resolve()).then(function () { return { ps: out, unknown: unknown }; });
  }
  function uniq(ps) { var seen = {}, out = []; ps.forEach(function (p) { if (p >= 0 && !seen[p]) { seen[p] = 1; out.push(p); } }); return out; }

  // structure route: claims hits of exact and similar (>= 0.8) matches -> p[]
  function structureRoute(inputs, o) {
    var Ch = eng('chem'), D = eng('data'), found = {}, nCompounds = 0, notes = [];
    if (!Ch) return Promise.resolve({ ps: [], n: 0, notes: ['The chemistry engine is not available in this build.'] });
    var claimsOnly = o.claimsOnly !== false;
    function takePatents(list) {
      return Promise.all(arr(list).map(function (x) {
        var p = x.p >= 0 ? x.p : -1;
        if (p >= 0 || !x.pn) return p;
        return Promise.resolve(D.byPn(x.pn)).then(function (q) { return q; }, function () { return -1; });
      })).then(function (ps) { arr(list).forEach(function (x, i) { if (ps[i] >= 0 && (!claimsOnly || (x.where && x.where.clm))) found[ps[i]] = 1; }); });
    }
    return inputs.reduce(function (chain, inp) {
      return chain.then(function () {
        var modes = o.modes || [['exact', {}], ['sim', { minSim: 0.8 }]];
        return modes.reduce(function (c2, md) {
          return c2.then(function () {
            var q = { mode: md[0], limit: md[0] === 'exact' ? 60 : 40, maxPatents: 300, signal: o.signal };
            if (md[1].minSim) q.minSim = md[1].minSim;
            if (typeof inp === 'object') Object.keys(inp).forEach(function (k) { q[k] = inp[k]; }); else q.query = inp;
            return Promise.resolve(Ch.search(q)).then(function (hits) {
              arr(hits).forEach(function () { nCompounds++; });
              return arr(hits).reduce(function (c3, h) { return c3.then(function () { return takePatents(h.patents && h.patents.length ? h.patents : Ch.patentsOf(h.c)); }); }, Promise.resolve());
            }, function (e) { if (e && e.code === 'cancelled') throw e; notes.push('Structure search failed for ' + str(typeof inp === 'object' ? (inp.query || inp.smiles || inp.c) : inp).slice(0, 60) + ': ' + str(e && (e.message || e.code))); });
          });
        }, Promise.resolve());
      });
    }, Promise.resolve()).then(function () { return { ps: Object.keys(found).map(Number), n: nCompounds, notes: notes }; });
  }

  function expandFamily(ps) {
    var D = eng('data');
    return Promise.all(ps.map(function (p) { return Promise.resolve(D.family(p)).then(function (m) { return arr(m); }, function () { return [p]; }); })).then(function (lists) {
      var all = ps.slice(); lists.forEach(function (l) { l.forEach(function (x) { all.push(x); }); }); return uniq(all);
    });
  }

  function setFrom(spec, o) {
    o = o || {}; spec = spec || {};
    var src = str(spec.source || (spec.pns ? 'pns' : '')), t0 = now(), D = eng('data'), St = eng('store');
    var info = { source: src, label: '', ms: 0, routes: [], notes: [], unknown: [] };
    function done(ps) {
      ps = uniq(ps);
      var fam = o.family ? expandFamily(ps).then(function (all) { info.routes.push({ name: 'family members added', n: all.length - ps.length }); return all; }) : Promise.resolve(ps);
      return fam.then(function (all) { info.ms = Math.round(now() - t0); all.info = info; return all; });
    }
    if (!D) return Promise.reject(err('no_engine', 'The patent data engine is not available.'));
    if (src === 'pns') {
      info.label = 'List of publication numbers';
      return resolvePns(splitList(spec.pns)).then(function (r) { info.unknown = r.unknown; info.routes.push({ name: 'publication numbers', n: r.ps.length }); return done(r.ps); });
    }
    if (src === 'watchlist') {
      info.label = 'Watchlist';
      if (!St) return Promise.reject(err('no_store', 'The store is not available.'));
      return St.list('marks').then(function (rows) {
        var all = arr(rows).filter(function (m) { return m && m.pn; }), starred = all.filter(function (m) { return m.star; });
        if (!starred.length && all.length) info.notes.push('No starred publications; the publications with a note or tag are used.');
        return resolvePns((starred.length ? starred : all).map(function (m) { return m.pn; }));
      }).then(function (r) { info.unknown = r.unknown; info.routes.push({ name: 'watchlist', n: r.ps.length }); return done(r.ps); });
    }
    if (src === 'selection') {
      info.label = 'Selection handed over from Search';
      if (!St) return Promise.reject(err('no_store', 'The store is not available.'));
      return St.get('settings', 'fto-selection').then(function (doc) {
        if (!doc || !arr(doc.pns).length) info.notes.push('No selection is stored. Select publications in Search or the watchlist and hand them over to the FTO check first.');
        return resolvePns(arr(doc && doc.pns));
      }).then(function (r) { info.unknown = r.unknown; info.routes.push({ name: 'selection', n: r.ps.length }); return done(r.ps); });
    }
    if (src === 'opinion') {
      var F = eng('fto');
      if (!F || !F.load) return Promise.reject(err('no_engine', 'The FTO engine is not available.'));
      return Promise.resolve(F.load(spec.id)).then(function (op) {
        if (!op) throw err('not_found', 'The opinion was not found.');
        info.label = 'FTO opinion: ' + str(op.title || spec.id);
        var ps = arr(op.patents).map(function (x) { return x.p; }).concat(arr(op.notCharted).map(function (x) { return x.p; })).filter(function (p) { return p >= 0; });
        var n1 = arr(op.patents).length; info.routes.push({ name: 'charted rights', n: n1 }); info.routes.push({ name: 'not charted', n: arr(op.notCharted).length });
        return done(ps);
      });
    }
    if (src === 'compounds') {
      info.label = 'Structures and compounds';
      var inputs = arr(spec.compounds).map(function (x) { return typeof x === 'number' ? { c: x } : (x && typeof x === 'object' ? x : str(x).trim()); }).filter(function (x) { return x !== ''; });
      if (!inputs.length) return Promise.reject(err('bad_input', 'Enter at least one structure (SMILES), reference lipid name or SCHEMBL number.'));
      return structureRoute(inputs, { signal: o.signal, claimsOnly: o.claimsOnly, modes: [['exact', {}]] }).then(function (r) {
        info.notes = info.notes.concat(r.notes); info.routes.push({ name: o.claimsOnly === false ? 'exact matches, any part of the publication' : 'exact matches named in claims', n: r.ps.length });
        if (!r.ps.length) info.notes.push('No publication of the corpus names these structures' + (o.claimsOnly === false ? '.' : ' in its claims. Try the option to include description-only mentions.'));
        return done(r.ps);
      });
    }
    if (src === 'profile') {
      if (!St) return Promise.reject(err('no_store', 'The store is not available.'));
      return St.get('profiles', spec.id).then(function (form) {
        if (!form) throw err('not_found', 'The profile was not found.');
        info.label = 'Product profile: ' + str(form.name || spec.id);
        var lipids = arr(form.lipids).filter(function (l) { return l && (str(l.smiles).trim() || str(l.name).trim()); });
        var inputs = lipids.map(function (l) { return str(l.smiles).trim() ? { smiles: str(l.smiles).trim() } : { query: str(l.name).trim() }; });
        if (!inputs.length) info.notes.push('The profile names no lipid with a structure or a name, so the structure route found nothing.');
        return structureRoute(inputs, { signal: o.signal, claimsOnly: true }).then(function (r) {
          info.notes = info.notes.concat(r.notes); info.routes.push({ name: 'structure route (exact + similarity >= 0.8, named in claims)', n: r.ps.length });
          var all = r.ps.slice();
          return candidatesRoute(form, spec.id, o, info).then(function (cps) { if (cps) { info.routes.push({ name: 'claim-text route of the FTO candidate search (no semantic route)', n: cps.length }); cps.forEach(function (p) { all.push(p); }); } return done(all); });
        });
      });
    }
    return Promise.reject(err('bad_source', 'Unknown source: ' + src));
  }

  // claim-text route: only with a cached normalised profile or without Claude (no model call is made by this tool)
  function candidatesRoute(form, id, o, info) {
    var F = eng('fto'), St = eng('store'), ai = eng('ai');
    if (o.candidates === false || !F || !F.candidates) { info.notes.push('Claim-text route of the FTO candidate search not run.'); return Promise.resolve(null); }
    var avail = false; try { avail = !!(ai && ai.available && ai.available()); } catch (e) { avail = false; }
    return Promise.resolve(St.get('settings', 'pf-' + id)).then(function (c) { return c && c.features && c.features.schema_version === 'pf-1' ? c.features : null; }, function () { return null; }).then(function (f) {
      if (f) return f;
      if (avail) { info.notes.push('Claim-text route skipped: the profile has not been normalised yet and doing so would use Claude. Find candidates for this profile once in the FTO check; the result is cached and used here.'); return null; }
      return F.normalizeProfile(form, { lang: 'en', signal: o.signal });
    }).then(function (f) {
      if (!f) return null;
      return F.candidates(f, { max: 60, semantic: false, signal: o.signal }).then(function (cs) { return arr(cs).map(function (c) { return c.p; }); }, function (e) { if (e && e.code === 'cancelled') throw e; info.notes.push('Claim-text route failed: ' + str(e && (e.message || e.code))); return null; });
    }, function (e) { if (e && e.code === 'cancelled') throw e; info.notes.push('Claim-text route failed: ' + str(e && (e.message || e.code))); return null; });
  }

  /* ------------------------------------------------------------------------------------------ timeline */
  var DEAD = { lapsed: 1, revoked: 1, withdrawn: 1, refused: 1, expired: 1 };
  function jurOf(row) {
    if (row.auth === 'EP') { var j = ['EP']; if (row.inForceDe !== false || (row.pending && !row.dead)) j.push('DE'); return j; }
    return row.auth ? [row.auth] : [];
  }
  function makeRow(pat, st, snap, today) {
    var auth = str(pat.auth), kind = str(pat.kind), code = str((st && st.code) || pat.status || 'unknown');
    // granted: a B-type publication, or an A publication whose application the status file knows to be granted (its B sibling is then the better row)
    var granted = (auth === 'EP' ? /^B/.test(kind) : auth === 'US' ? !/^A\d?$/.test(kind) : false) || (!!st && st.code === 'granted' && (auth === 'EP' || auth === 'US'));
    var row = { p: pat.p, pn: pat.pn, auth: auth, kind: kind, family: pat.fam, appNo: str(pat.appNo), title: str(pat.title), assignee: str(pat.assignee), status: code, granted: granted, pending: false, inForce: false,
      inForceDe: null, dead: false, deadReason: null, superseded: false, jur: [], filing: '', pub: iso(pat.pub),
      expiry: { date: null, basis: 'no filing date in the corpus', basisKind: 'computed', ptaDays: null, baseDate: '', pte: 'not checked', spc: 'not checked', terminalDisclaimer: null, note: '' },
      stale: true, asof: null, src: null, noRecord: !st, flags: [], opposition: null, appeal: null };
    var asof = st && st.asof ? st.asof : null;
    if (st && st.src === 'ep-register' && snap.ep_register && (!asof || snap.ep_register > asof)) asof = snap.ep_register;
    row.asof = asof; row.src = st ? (st.src || null) : null;
    var age = asof ? daysBetween(asof, today) : null;
    row.stale = age === null || age > 183;
    if (auth === 'EP') row.inForceDe = st && st.in_force_de != null ? !!st.in_force_de : (pat.deIn === 1 ? true : pat.deIn === 0 ? false : null);
    var filing = iso((st && (st.term_base || st.filing)) || '') || iso(pat.app), ex = row.expiry, base, pta = st && st.pta_days > 0 ? +st.pta_days : 0;
    row.filing = filing; ex.baseDate = filing;
    if (st && st.expiry_est) {
      ex.date = iso(st.expiry_est) || str(st.expiry_est); ex.ptaDays = st.pta_days != null ? +st.pta_days : null;
      if (st.src === 'seed') { ex.basis = 'register'; ex.basisKind = 'register'; }
      else if (pta) { ex.basis = 'filing + 20 y + PTA ' + pta + ' days'; ex.basisKind = 'pta'; }
      else { ex.basis = 'filing + 20 y'; ex.basisKind = 'filing'; }
      if (st.estimate) ex.note = str(st.estimate);
    } else if (iso(pat.exp)) {
      ex.date = iso(pat.exp); ex.basis = 'filing + 20 y'; ex.basisKind = 'filing'; ex.note = 'Expiry column of the corpus table (no register record).';
    } else if (filing) {
      base = addYears(filing, 20); ex.date = base; ex.basis = 'filing + 20 y'; ex.basisKind = 'computed'; ex.note = 'Computed from the filing date; no legal-status record.';
    }
    // US applications filed before 8 June 1995: the term is the longer of grant + 17 years and filing + 20 years
    if (auth === 'US' && granted && filing && filing < '1995-06-08' && ex.basisKind !== 'register' && row.pub) {
      var g17 = addYears(row.pub, 17);
      if (g17 && (!ex.date || g17 > ex.date)) { ex.date = g17; ex.basis = 'grant + 17 y (filed before 8 June 1995)'; ex.basisKind = 'computed'; ex.note = (ex.note ? ex.note + ' ' : '') + 'Pre-1995 US term rule: the longer of grant + 17 years and filing + 20 years.'; }
    }
    if (st && st.terminal_disclaimer === true) ex.terminalDisclaimer = true;
    if (!ex.date) ex.note = 'No filing date or expiry in the corpus.';
    var opp = st && st.opposition ? st.opposition : null; row.opposition = opp && opp.filed ? (opp.outcome || 'filed') : null; row.appeal = st && st.appeal === true ? true : (st && st.appeal === false ? false : null);
    var appealOpen = code === 'revoked' && (row.appeal === true || (opp && opp.outcome === 'pending'));
    if (DEAD[code] && st && st.src && st.asof && !appealOpen) { row.dead = true; row.deadReason = code; }
    // past the estimated date: kept apart from rights the register shows as dead, because an SPC or a PTE (not checked)
    // can extend protection by up to 5 (+0.5) years beyond it
    else if (ex.date && ex.date < today) { row.expiredEst = true; row.flags.push('expired by estimate; SPC / PTE not checked'); }
    if (appealOpen) row.flags.push('revoked, appeal on record: treated as in force');
    if (row.opposition === 'pending' || (opp && opp.filed && !opp.outcome)) row.flags.push('opposition pending');
    else if (row.opposition === 'revoked') row.flags.push('revoked after opposition');
    else if (row.opposition === 'maintained_amended') row.flags.push('maintained as amended after opposition');
    if (auth === 'EP' && granted && !row.dead && row.inForceDe === false) row.flags.push('not in force in DE per register; may be in force in other states');
    if (!st) row.flags.push('no register record: status unverified');
    else if (row.stale) row.flags.push('status snapshot older than 6 months');
    row.pending = !granted && !row.dead && !row.expiredEst;
    row.inForce = granted && !row.dead && !row.expiredEst;
    row.jur = jurOf(row);
    return row;
  }

  function markSuperseded(rows) {
    var groups = {};
    rows.forEach(function (r) { var k = r.auth + '|' + (r.appNo || r.pn.replace(/[A-Z]\d?$/, '')); (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g2 = groups[k]; if (g2.length < 2) return;
      var best = g2.slice().sort(function (a, b) { return (b.granted - a.granted) || (b.pub < a.pub ? -1 : b.pub > a.pub ? 1 : 0); })[0];
      g2.forEach(function (r) { if (r !== best) { r.superseded = true; r.flags.push('same application as ' + best.pn); } });
    });
  }

  function timeline(ps, o) {
    o = o || {};
    var D = eng('data'), today = todayIso(o), jur = arr(o.jurisdictions && o.jurisdictions.length ? o.jurisdictions : ['EP', 'DE', 'US']);
    if (!D) return Promise.reject(err('no_engine', 'The patent data engine is not available.'));
    var list = uniq(arr(ps));
    var snap = (D.manifest && D.manifest.snapshots) || {};
    return Promise.all(list.map(function (p) {
      return Promise.resolve(D.patent(p)).then(function (pat) {
        return Promise.resolve(D.status(p)).then(function (st) { return [pat, st || null]; }, function () { return [pat, null]; });
      }, function () { return null; });
    })).then(function (pairs) {
      var rows = [], skippedWo = 0, missing = 0;
      pairs.forEach(function (x) {
        if (!x) { missing++; return; }
        var pat = x[0];
        if (pat.auth === 'WO' && !o.includeWo) { skippedWo++; return; }
        if (pat.auth !== 'EP' && pat.auth !== 'US' && pat.auth !== 'WO') { /* other offices are shown as far as the table has them */ }
        rows.push(makeRow(pat, x[1], snap, today));
      });
      markSuperseded(rows);
      // jurisdiction filter: a right is kept when it counts in at least one of the selected jurisdictions
      var kept = rows.filter(function (r) { return !r.jur.length || r.jur.some(function (j) { return jur.indexOf(j) >= 0; }); });
      kept.sort(function (a, b) { return ((a.family < b.family) ? -1 : (a.family > b.family) ? 1 : 0) || (a.expiry.date || '9999') .localeCompare(b.expiry.date || '9999') || a.pn.localeCompare(b.pn); });
      var fams = {}, order = [];
      kept.forEach(function (r) { if (!fams[r.family]) { fams[r.family] = { family: r.family, rows: [] }; order.push(r.family); } fams[r.family].rows.push(r); });
      kept.families = order.map(function (k) {
        var f = fams[k], live = f.rows.filter(function (r) { return !r.superseded; });
        var fil = live.map(function (r) { return r.filing; }).filter(Boolean).sort()[0] || '', ex = live.map(function (r) { return r.expiry.date; }).filter(Boolean).sort().pop() || '';
        f.filing = fil; f.expiry = ex; f.inForce = live.some(function (r) { return r.inForce; }); f.pending = live.some(function (r) { return r.pending; }); f.dead = live.length > 0 && live.every(function (r) { return r.dead; });
        f.expiredEst = live.length > 0 && !f.dead && live.every(function (r) { return r.dead || r.expiredEst; });
        return f;
      }).sort(function (a, b) { return (a.filing || '9').localeCompare(b.filing || '9') || (a.family - b.family); });
      kept.today = today; kept.jurisdictions = jur; kept.skippedWo = skippedWo; kept.missing = missing; kept.snapshot = { ep_register: snap.ep_register || null, us_text: snap.us_text || null };
      kept.limits = limits(kept);
      return kept;
    });
  }

  /* ------------------------------------------------------------------------------------------ cliff */
  function cliff(rows, o) {
    o = o || {}; var today = (rows && rows.today) || todayIso(o);
    var live = arr(rows).filter(function (r) { return !r.superseded; }), years = {}, nDead = 0, nNoDate = 0, nExpiredEst = 0;
    var J = { EP: [], DE: [], US: [] };
    live.forEach(function (r) {
      if (r.dead) { nDead++; return; }
      if (r.expiredEst) { nExpiredEst++; return; }
      if (!r.expiry.date) { nNoDate++; return; }
      var y = +r.expiry.date.slice(0, 4), yy = years[y] || (years[y] = { year: y, EP: 0, US: 0, pending: 0, other: 0, total: 0 });
      if (r.pending) yy.pending++; else if (r.auth === 'EP') yy.EP++; else if (r.auth === 'US') yy.US++; else yy.other++;
      yy.total++;
      r.jur.forEach(function (j) { if (J[j]) J[j].push(r); });
    });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return a - b; }), out = [];
    if (ys.length) for (var y = ys[0]; y <= ys[ys.length - 1]; y++) out.push(years[y] || { year: y, EP: 0, US: 0, pending: 0, other: 0, total: 0 });
    var jur = {};
    Object.keys(J).forEach(function (j) {
      var gr = J[j].filter(function (r) { return r.granted; }), pe = J[j].filter(function (r) { return r.pending; });
      var last = gr.slice().sort(function (a, b) { return a.expiry.date < b.expiry.date ? 1 : a.expiry.date > b.expiry.date ? -1 : 0; })[0] || null;
      var pl = pe.slice().sort(function (a, b) { return a.expiry.date < b.expiry.date ? 1 : -1; })[0] || null;
      var unverified = gr.filter(function (r) { return r.stale || r.noRecord; }).length;
      var name = j === 'DE' ? 'DE (EP patents not lapsed in DE)' : j;
      var text = last ? 'No known in-force ' + name + ' right of this set remains after ' + last.expiry.date + ' (' + last.pn + ').' : 'No known in-force ' + name + ' right in this set.';
      if (pe.length) text += ' ' + pe.length + ' pending application' + (pe.length === 1 ? '' : 's') + ' could still grant' + (pl ? ' (latest possible expiry ' + pl.expiry.date + ')' : '') + ', so this date is not a freedom-to-operate date.';
      else text += ' Applications not in this set may still grant.';
      if (unverified) text += ' ' + unverified + ' of the granted right' + (unverified === 1 ? ' has' : 's have') + ' an old or missing status record.';
      jur[j] = { lastExpiry: last ? last.expiry.date : null, pn: last ? last.pn : null, nInForce: gr.length, nPending: pe.length, pendingLatest: pl ? pl.expiry.date : null, unverified: unverified, text: text };
    });
    return { years: out, jurisdictions: jur, nRights: live.length, nDead: nDead, nExpiredEst: nExpiredEst, nSuperseded: arr(rows).length - live.length, nNoDate: nNoDate, today: today,
      caveats: ['Pending applications may still be granted and then run until their estimated date.', 'Dates are estimates: PTE, SPC, paediatric extensions, terminal disclaimers and later fee lapses are not checked.', 'The set only contains the publications you selected or that the source found; other family members or later filings may extend protection.'] };
  }

  /* ------------------------------------------------------------------------------------------ ICS (RFC 5545) */
  function utf8Len(ch) { var c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  // fold a content line at 75 octets (without the line break), never inside a multi-byte character; continuation lines start with one space
  function fold(line) {
    var out = [], cur = '', n = 0, limit = 75;
    for (var ch of line) {
      var l = utf8Len(ch);
      if (n + l > limit) { out.push(cur); cur = ' '; n = 1; limit = 75; }
      cur += ch; n += l;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function escText(s) { return str(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n'); }
  function dateVal(d) { return d.replace(/-/g, ''); }
  function stampOf(o) {
    if (o && o.stamp) return o.stamp;
    var d = S.cfg.now ? new Date(S.cfg.now() + 'T00:00:00Z') : new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }
  function toIcs(rows, o) {
    o = o || {};
    var name = o.name || 'Patent expiry estimates', stamp = stampOf(o), lines = [];
    function add(l) { lines.push(fold(l)); }
    add('BEGIN:VCALENDAR'); add('VERSION:2.0'); add('PRODID:-//LNP Patent Desk//Expiry timeline//EN'); add('CALSCALE:GREGORIAN'); add('METHOD:PUBLISH');
    add('X-WR-CALNAME:' + escText(name));
    add('X-WR-CALDESC:' + escText('Estimated patent expiry dates; estimates only, PTE and SPC not checked. Verify at the register.'));
    var seen = {};
    arr(rows).forEach(function (r) {
      if (!r || r.superseded || !r.expiry || !r.expiry.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.expiry.date)) return;
      if ((r.dead || r.expiredEst) && !o.includeDead) return;
      var uid = 'expiry-' + str(r.pn).replace(/[^A-Za-z0-9]/g, '') + '@lnp-patent-desk';
      if (seen[uid]) return; seen[uid] = 1;
      var desc = ['Basis: ' + r.expiry.basis + ' (estimate; PTE/SPC not checked; verify at the register).', 'Status: ' + r.status + (r.pending ? ' (application)' : '') + (r.dead ? ' (' + r.deadReason + ')' : r.expiredEst ? ' (expired by estimate; SPC / PTE not checked)' : '') + '.'];
      if (r.title) desc.push('Title: ' + str(r.title).slice(0, 200));
      add('BEGIN:VEVENT'); add('UID:' + uid); add('DTSTAMP:' + stamp);
      add('DTSTART;VALUE=DATE:' + dateVal(r.expiry.date)); add('DTEND;VALUE=DATE:' + dateVal(addDays(r.expiry.date, 1)));
      add('SUMMARY:' + escText('Estimated expiry ' + r.pn));
      add('DESCRIPTION:' + escText(desc.join('\n')));
      add('CATEGORIES:' + escText('Patent expiry'));
      add('TRANSP:TRANSPARENT');
      add('END:VEVENT');
    });
    add('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------------------------------ CSV */
  function csvCell(v, sep) {
    var c = v == null ? '' : String(v);
    if (/^[\s]*[=+\-@]/.test(c) || /^[\t\r]/.test(c)) c = "'" + c;     // no formula injection from patent text
    return (c.indexOf(sep) >= 0 || /["\r\n]/.test(c)) ? '"' + c.replace(/"/g, '""') + '"' : c;
  }
  var CSV_HEAD = ['publication', 'authority', 'kind', 'family', 'status', 'in_force', 'pending', 'dead_reason', 'filing_date', 'expiry_estimate', 'expiry_basis', 'pta_days', 'pte', 'spc', 'terminal_disclaimer',
    'in_force_de', 'status_snapshot', 'status_stale', 'superseded_by_same_application', 'title', 'assignee', 'flags'];
  function toCsv(rows, o) {
    o = o || {}; var sep = o.sep || ';', out = [CSV_HEAD.join(sep)];
    arr(rows).forEach(function (r) {
      var ex = r.expiry || {};
      out.push([r.pn, r.auth, r.kind, r.family, r.status, r.inForce ? 'yes' : 'no', r.pending ? 'yes' : 'no', r.deadReason || (r.expiredEst ? 'expired (estimate; SPC/PTE not checked)' : ''), r.filing, ex.date || '', ex.basis || '', ex.ptaDays == null ? '' : ex.ptaDays, ex.pte || 'not checked', ex.spc || 'not checked',
        ex.terminalDisclaimer === true ? 'yes' : 'not visible', r.inForceDe == null ? '' : (r.inForceDe ? 'yes' : 'no'), r.asof || '', r.stale ? 'yes' : 'no', r.superseded ? 'yes' : 'no', r.title, r.assignee, arr(r.flags).join(' | ')].map(function (c) { return csvCell(c, sep); }).join(sep));
    });
    out.push(csvCell('# Estimates only (filing date + 20 years, plus PTA where known); PTE, SPC, paediatric extensions, terminal disclaimers and later fee lapses are not checked. Verify at the register. Not legal advice.', sep));
    return '\ufeff' + out.join('\r\n') + '\r\n';
  }

  var api = { setFrom: setFrom, timeline: timeline, cliff: cliff, toIcs: toIcs, toCsv: toCsv, limits: limits, configure: configure, _fold: fold, _escText: escText, _addYears: addYears, _csvCell: csvCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpExpiry = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
