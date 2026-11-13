/* LNP Patent Desk: FTO workspace around LnpFto. Route: #fto[-<opinion id>][--p<profile id>][--d<quick|standard|deep>]
   Without an opinion id: pick a profile -> candidates -> depth -> run (progress, cancel, resume) and the saved opinions.
   With an opinion id: the opinion (risk matrix first, expiry timeline, one fold per patent with the claim chart). */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  if (!g.LnpLazyView) g.LnpLazyView = (function () {
    var reg = {};
    function one(n) {
      return reg[n] || (reg[n] = new Promise(function (res, rej) {
        var el;
        if (/\.css$/.test(n)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = n; el.onload = el.onerror = function () { res(true); }; }
        else { el = document.createElement('script'); el.src = n; el.async = false; el.onload = function () { res(true); }; el.onerror = function () { delete reg[n]; rej({ code: 'script', message: 'could not be loaded: ' + n }); }; }
        document.head.appendChild(el);
      }));
    }
    return function (id, need, real) {
      return function (host, route, App) {
        var inst = null, dead = false;
        need.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()).then(function () { if (!dead) inst = real(host, route, App); }).catch(function (e) {
          App.logError('view ' + id, e);
          if (!dead) g.LnpUI.set(host, g.LnpUI.h('div.page', null, g.LnpUI.h('p.notice.err', { text: 'The view could not be built: ' + g.LnpUI.errText(e) })));
        });
        return { update: function (r) { return inst && inst.update ? inst.update(r) : false; }, destroy: function () { dead = true; try { if (typeof inst === 'function') inst(); else if (inst && inst.destroy) inst.destroy(); } catch (e) { App.logError('destroy ' + id, e); } } };
      };
    };
  })();

  var DEPTHS = [['quick', 'Quick', 'Triage and claim charts for the 5 most relevant publications. No dependent claims, no red-team review.'],
    ['standard', 'Standard', 'The 10 most relevant publications, with dependent claims and a red-team review from the patentee\'s point of view.'],
    ['deep', 'Deep', 'The 20 most relevant publications; expired, lapsed and revoked rights are analysed as well.']];
  var ROUTE = { structure: ['Structure', 'A lipid of the profile is listed as a compound in the publication'], markush: ['Formula in claim', 'Lipid disclosed and an independent claim contains a formula'], text: ['Claim text', 'Hit of the claim searches generated from the profile'],
    seed: ['Key family', 'From the list of known key families'], semantic: ['AI search', 'Hit of the semantic search'], manual: ['Manual', 'Handed over or added by hand'], family: ['Family', 'Family member of a hit in the target market'] };
  var REASON = { dead: 'No longer in force', triage_c: 'Classed as not relevant in triage', depth_limit: 'Not analysed because of the selected depth', no_text: 'No claim text in the dataset', text_cut: 'Claim text not in the data package',
    wo: 'WO publications (not enforceable as such)', market: 'No target market selected', no_ai: 'Not analysed without Claude' };
  var REASON_ORDER = ['depth_limit', 'no_ai', 'no_text', 'text_cut', 'triage_c', 'dead', 'market', 'wo'];
  var STATE = { done: ['Done', 'good'], running: ['Interrupted', 'warn'], paused: ['Paused', 'warn'], cancelled: ['Cancelled', 'hollow'] };
  var DEAD = { expired: 1, lapsed: 1, revoked: 1, withdrawn: 1, refused: 1 };
  var QCHK = { ok: 'Quote found verbatim in the claim', elided: 'Quote found only with an omission', approx: 'Quote found only approximately', fail: 'Quote not found in the claim', empty: 'no quote' };
  /* internal codes (flags, enum values) -> English labels; the renderer owns the vocabulary */
  function lab(c) { var FR = g.LnpFtoRender; return FR && FR.label ? FR.label(c, 'en') : String(c == null ? '' : c).replace(/_/g, ' '); }
  function labs(a) { return (a || []).map(lab).join(', '); }

  function mount(host, route, App) {
    var K = g.LnpKit, C = g.LnpChart, F = g.LnpFto, St = g.LnpStore, D = g.LnpData;
    var dead = false, ctl = null, running = false, viewSeq = 0;
    var S = { profiles: [], pid: '', depth: 'standard', features: null, cands: null, checked: new Map(), manual: [], handed: null, record: null, ai: false };
    var page = h('div.page.k-page'); host.appendChild(page);

    function aiReady() { var A = g.LnpAI; try { return !!(A && A.available && A.available()); } catch (e) { return false; } }
    function abortRun() { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } ctl = null; running = false; }

    if (!F) {
      U.set(page, K.head('Freedom to operate', 'Pre-screen', 'against the dataset'), h('p.notice.err', { text: 'The analysis scripts (engine/fto.js) are not part of this data package. Search, Structure search and Watchlist work without them.' }));
      return { destroy: function () { dead = true; } };
    }

    /* ============================================================ setup */
    function aiNotice() {
      if (S.ai) return null;
      return h('div.k-noai', { id: 'fto-noai', role: 'note' }, h('p.overline', { text: 'Claude not available' }),
        h('h2.k-h3', { text: 'The claim chart needs Claude in the artifact' }),
        h('p', { text: 'The analysis compares claim features with the product profile. Claude does this through the artifact capability of this page. It is not available here: the page runs outside claude.ai, the capability was not granted, or its use is switched off for this account.' }),
        h('p', { text: 'What still works without Claude: the candidate search by structure, claim text and key families, legal status and estimated expiry per publication, the search record and the export of this compilation. There is then no triage and no claim chart.' }));
    }
    function profileOf(id) { return S.profiles.filter(function (p) { return p.id === id; })[0] || null; }
    function setRoute() { R.go({ view: 'fto', params: { p: S.pid, d: S.depth === 'standard' ? '' : S.depth } }, { silent: true, replace: true }); }

    function showSetup(r) {
      var my = ++viewSeq;
      abortRun();
      S.depth = DEPTHS.some(function (d) { return d[0] === r.params.d; }) ? r.params.d : 'standard';
      U.set(page, K.head('Freedom to operate', 'Pre-screen against the dataset,', 'element by element', 'The pre-screen finds the relevant publications for a product profile, compares the independent claims with the product element by element and records legal status, expiry and open questions. The result is a pre-screen to take to your patent attorney, not a legal opinion.'), K.busy('Loading profiles and saved pre-screens'));
      var A = g.LnpAI;
      Promise.all([
        St.list('profiles').then(function (l) { return (l || []).filter(function (p) { return p && Array.isArray(p.lipids); }); }, function () { return []; }),
        St.get('settings', 'fto-selection').then(null, function () { return null; }),
        Promise.resolve(A && A.init ? A.init() : false).then(null, function () { return false; }),
        F.list().then(null, function () { return []; })
      ]).then(function (x) {
        if (dead || my !== viewSeq) return;
        S.profiles = x[0]; S.handed = x[1] && Array.isArray(x[1].pns) && x[1].pns.length ? x[1] : null; S.ai = aiReady();
        var want = r.params.p ? String(r.params.p) : '';
        if (want && want !== S.pid) { S.cands = null; S.features = null; S.checked.clear(); }
        S.pid = profileOf(want) ? want : (profileOf(S.pid) ? S.pid : (S.profiles[0] ? S.profiles[0].id : ''));
        drawSetup(x[3]);
      });
    }

    function drawSetup(saved) {
      var prodBox = h('div'), candBox = h('div'), depthBox = h('div'), startBox = h('div'), savedBox = h('div');
      U.set(page, K.head('Freedom to operate', 'Pre-screen against the dataset,', 'element by element', 'The pre-screen finds the relevant publications for a product profile, compares the independent claims with the product element by element and records legal status, expiry and open questions. The result is a pre-screen to take to your patent attorney, not a legal opinion.'),
        aiNotice(),
        K.sec('Step 1', 'Product', null, prodBox), K.sec('Step 2', 'Candidates', null, candBox), K.sec('Step 3', 'Depth and start', null, depthBox, startBox),
        K.sec('Archive', 'Saved pre-screens', null, savedBox));
      drawProduct(); drawCands(); drawDepth(); drawSaved(saved);

      function drawProduct() {
        U.clear(prodBox);
        if (!S.profiles.length) {
          prodBox.appendChild(h('div.empty.k-empty', null, h('h3', { text: 'No product profile yet' }), h('p', { text: 'The pre-screen needs a profile with the lipids and their proportions. The example profile shows the workflow with a generic MC3 siRNA formulation.' }),
            h('div.k-row', null, h('button.btn.primary', { type: 'button', onclick: useExample }, 'Use example profile'), h('a.btn', { href: '#produkte' }, U.icon('product'), 'Create profile'))));
          return;
        }
        var sel = h('select.select', { id: 'fto-profile', 'aria-label': 'Product profile' });
        S.profiles.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name || 'Profile' })); });
        sel.value = S.pid;
        sel.addEventListener('change', function () { S.pid = sel.value; S.cands = null; S.features = null; S.checked.clear(); setRoute(); drawProduct(); drawCands(); drawDepth(); });
        var p = profileOf(S.pid), lip = (p.lipids || []).filter(function (l) { return l.name || l.smiles; });
        prodBox.appendChild(h('div.k-row', null, sel, h('a.btn.sm', { href: R.build({ view: 'produkte', arg: p.id }) }, 'Edit profile')));
        prodBox.appendChild(K.kv([
          ['Lipids', lip.length ? lip.map(function (l) { return (l.name || 'own lipid') + (l.molPct != null ? ' ' + String(l.molPct) + ' mol-%' : ''); }).join(' · ') : 'not specified'],
          ['Payload', (p.payload && p.payload.type) || 'not specified'], ['Process', (p.process && p.process.mixing) || 'not specified'],
          ['Target markets', (p.markets && p.markets.length ? p.markets : ['DE', 'EP', 'US']).join(', ')], ['Modified', U.date(String(p.updated || '').slice(0, 10))]]));
        if (!lip.some(function (l) { return l.role === 'ionizable'; })) prodBox.appendChild(h('p.notice', { text: 'The profile has no ionizable lipid. Structure search and formula test then have nothing to start from.' }));
      }
      function useExample() {
        var ex = g.LnpProfile ? g.LnpProfile.clean(g.LnpProfile.example()) : null; if (!ex) return;
        ex.id = K.uid('pr'); ex.updated = new Date().toISOString();
        St.put('profiles', ex.id, ex).then(function () { S.profiles = [ex]; S.pid = ex.id; setRoute(); drawProduct(); drawCands(); drawDepth(); }, function (e) { U.toast('The example could not be saved: ' + U.errText(e), { error: true }); });
      }

      /* -------------------------------------------------------- candidates */
      function features(p) {
        var key = 'pf-' + p.id, stamp = (p.updated || '') + '|' + (S.ai ? 'ai' : 'det') + '|en';
        return St.get('settings', key).then(null, function () { return null; }).then(function (c) {
          if (c && c.stamp === stamp && c.features && c.features.schema_version === 'pf-1') return c.features;
          return F.normalizeProfile(p, { lang: 'en', signal: ctl ? ctl.signal : undefined }).then(function (f) { St.put('settings', key, { stamp: stamp, features: f }).catch(function () { }); return f; });
        });
      }
      function manualAll() { return (S.handed ? S.handed.pns : []).concat(S.manual); }
      function findCands() {
        var p = profileOf(S.pid); if (!p) return;
        ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var line = h('span', { text: S.ai ? 'Preparing the profile (one Claude call if it has changed)' : 'Preparing the profile' });
        U.set(candBox, h('div.k-busy', { role: 'status' }, h('span.spin'), line));
        var my = viewSeq;
        features(p).then(function (f) {
          S.features = f; if (dead || my !== viewSeq) return null;
          line.textContent = 'Searching for candidates';
          return F.candidates(f, { max: 90, markets: p.markets && p.markets.length ? p.markets : undefined, manual: manualAll(), signal: ctl ? ctl.signal : undefined,
            onEvent: function (ev) { if (ev && ev.type === 'stage') line.textContent = ev.stage === 'structure' ? 'Structure search: ' + (ev.lipid || '') : ev.stage === 'text' ? 'Claim search ' + (ev.query || '') : 'Searching for candidates'; } });
        }).then(function (list) {
          if (!list || dead || my !== viewSeq) return;
          S.cands = list; S.record = list.record || null; S.checked.clear();
          list.forEach(function (c) { S.checked.set(c.p, c.auth !== 'WO'); });
          drawCands(); drawDepth();
        }).catch(function (e) {
          if (dead || my !== viewSeq) return;
          U.set(candBox, K.errBox(e, 'The candidate search failed'), h('p', null, h('button.btn', { type: 'button', onclick: findCands }, 'Try again')));
        });
      }
      function addManual(input, msg) {
        var v = input.value.trim(); if (!v) return;
        D.byPn(v).then(function (p) { return p >= 0 ? D.patent(p) : null; }).then(function (pt) {
          if (!pt) { msg.textContent = 'The number "' + v + '" is not in the dataset.'; return; }
          input.value = ''; msg.textContent = '';
          if (S.cands) {
            if (!S.cands.some(function (c) { return c.p === pt.p; })) S.cands.unshift({ p: pt.p, pn: pt.pn, auth: pt.auth, kind: pt.kind, title: pt.title, assignee: pt.assignee, player: pt.player, status: pt.status, text: pt.text, routes: ['manual'], score: 1, why: ['added by hand'] });
            S.checked.set(pt.p, true); S.manual.push(pt.pn); drawCands(); drawDepth();
          } else { if (S.manual.indexOf(pt.pn) < 0) S.manual.push(pt.pn); drawCands(); }
        }, function (e) { msg.textContent = U.errText(e); });
      }
      function drawCands() {
        U.clear(candBox);
        var addIn = h('input.input.mono', { id: 'fto-add', type: 'text', placeholder: 'Number, e.g. EP 3 532 103', autocomplete: 'off', 'aria-label': 'Add a publication by hand' }), addMsg = h('span.k-hint', { 'aria-live': 'polite' });
        var addForm = h('form.k-qrow.k-add', { onsubmit: function (ev) { ev.preventDefault(); addManual(addIn, addMsg); } }, addIn, h('button.btn', { type: 'submit' }, 'Add'));
        if (S.handed) {
          var chips = h('div.k-chips'); S.handed.pns.slice(0, 30).forEach(function (pn) { chips.appendChild(h('a.tag', { href: App.patentHref(pn, { q: '' }), text: U.pnPretty(pn) })); });
          if (S.handed.pns.length > 30) chips.appendChild(h('span.tag', { text: '+ ' + (S.handed.pns.length - 30) }));
          candBox.appendChild(h('div.k-handed', { id: 'fto-handover' }, h('p.k-sub', null, h('b', { text: K.plural(S.handed.pns.length, 'publication', 'publications') }), ' handed over from ' + ({ suche: 'Search', patent: 'the patent view', merkliste: 'the Watchlist', struktur: 'Structure search' }[S.handed.from] || 'another view') + (S.handed.q ? ' ("' + S.handed.q + '")' : '') + '. They are added to the candidate list.'),
            chips, h('button.btn.quiet.sm', { type: 'button', onclick: function () { St.remove('settings', 'fto-selection').catch(function () { }); S.handed = null; S.cands = null; drawCands(); drawDepth(); } }, U.icon('x'), 'Discard handover')));
        }
        if (!profileOf(S.pid)) { candBox.appendChild(h('p.k-hint', { text: 'Select or create a product profile first.' })); return; }
        if (!S.cands) {
          if (S.manual.length) candBox.appendChild(h('p.k-sub', { text: 'Added by hand: ' + S.manual.map(U.pnPretty).join(', ') }));
          candBox.appendChild(h('div.k-row', null, h('button.btn.primary', { id: 'fto-find', type: 'button', onclick: findCands }, U.icon('search'), 'Find candidates'), addForm));
          candBox.appendChild(addMsg);
          candBox.appendChild(h('p.k-hint', { text: 'The search runs in the browser: every lipid by exact structure, substructure and similarity, plus claim searches generated from the profile, the key families and family members in the target markets.' + (S.ai ? ' Before that, Claude prepares the profile once.' : '') }));
          return;
        }
        var list = S.cands, tb = h('tbody'), count = h('b');
        function upd() { var n = 0; list.forEach(function (c) { if (S.checked.get(c.p)) n++; }); count.textContent = K.plural(n, 'publication', 'publications') + ' selected'; drawDepth(); }
        function setAll(fn) { list.forEach(function (c) { S.checked.set(c.p, !!fn(c)); }); drawCands(); drawDepth(); }
        list.forEach(function (c) {
          var cb = h('input.chk', { type: 'checkbox', checked: !!S.checked.get(c.p), 'aria-label': 'Include ' + c.pn, onchange: function () { S.checked.set(c.p, cb.checked); upd(); } });
          var why = (c.why || []);
          tb.appendChild(h('tr', null, h('td', null, cb), h('td', null, K.patentLink(c.pn, App)),
            h('td.t', null, h('span', { text: c.title || '' }), h('br'), h('span.faint', { text: c.player || c.assignee || '' })),
            h('td', null, U.statusPill(c.status), c.text ? null : h('span.tag.k-gap', { text: c.auth === 'WO' ? 'WO: pointer only' : 'no full text', title: 'No claim chart is possible without claim text' })),
            h('td', null, h('span.cmpd-w', null, (c.routes || []).map(function (rt) { var x = ROUTE[rt] || [rt, '']; return h('span.tag' + (rt === 'structure' || rt === 'markush' ? '.k-clm' : ''), { text: x[0], title: x[1] }); }))),
            h('td.k-why', { title: why.join('\n') }, why.slice(0, 2).map(function (w) { return h('div', { text: w }); }), why.length > 2 ? h('div.faint', { text: '+ ' + (why.length - 2) + ' more ' + (why.length - 2 === 1 ? 'reason' : 'reasons') }) : null)));
        });
        candBox.appendChild(h('div.k-row.k-between', null,
          h('p.k-sub', null, h('b', { text: K.plural(list.length, 'candidate', 'candidates') }), ' · ', count),
          h('span.k-row', null, h('button.btn.sm', { type: 'button', onclick: function () { setAll(function (c) { return c.auth !== 'WO'; }); } }, 'All'), h('button.btn.sm', { type: 'button', onclick: function () { setAll(function (c) { return c.text; }); } }, 'Full text only'),
            h('button.btn.sm', { type: 'button', onclick: function () { setAll(function () { return false; }); } }, 'None'), h('button.btn.sm', { type: 'button', onclick: function () { S.cands = null; findCands(); } }, 'Search again'))));
        candBox.appendChild(h('div.table-wrap.k-cands', null, h('table.data', null, h('thead', null, h('tr', null, ['', 'Number', 'Title and applicant', 'Legal status', 'Found via', 'Why'].map(function (t) { return h('th', { text: t }); }))), tb)));
        candBox.appendChild(h('div.k-row', null, addForm, addMsg));
        var rec = S.record;
        if (rec) {
          var rows = [];
          (rec.structure || []).forEach(function (s) { rows.push(['Structure', (s.lipid || '') + ' · ' + ({ exact: 'exact', sub: 'substructure', sim: 'similarity' }[s.mode] || s.mode || ''), s.error ? 'Error: ' + s.error : U.num(s.compounds) + ' compounds, ' + U.num(s.publications) + ' publications']); });
          (rec.text || []).forEach(function (t) { rows.push(['Claim text', t.query || '', t.error ? 'Error: ' + t.error : U.num(t.total) + ' hits, ' + U.num(t.taken) + ' taken']); });
          (rec.seed || []).forEach(function (s) { rows.push(['Key families', 'Tier ' + s.tier, s.error ? 'Error: ' + s.error : U.num(s.total) + ' publications']); });
          var t2 = h('table.data'), tb2 = h('tbody'); rows.forEach(function (r) { tb2.appendChild(h('tr', null, h('td', { text: r[0] }), h('td.mono.k-query', { text: r[1] }), h('td', { text: r[2] }))); });
          t2.appendChild(h('thead', null, h('tr', null, ['Route', 'Query', 'Result'].map(function (x) { return h('th', { text: x }); })))); t2.appendChild(tb2);
          candBox.appendChild(h('details.k-fold', null, h('summary', null, h('span', { text: 'Search record: ' + rows.length + (rows.length === 1 ? ' query' : ' queries') + ', verbatim' })), h('div.k-fold-body', null, h('div.table-wrap', null, t2), (rec.notes || []).map(function (n) { return h('p.k-hint', { text: n }); }))));
        }
        upd();
      }

      /* -------------------------------------------------------- depth, estimate, start */
      function selected() { return (S.cands || []).filter(function (c) { return S.checked.get(c.p); }); }
      function estimate(depth) {
        var d = F.DEPTH[depth], sel = selected(), live = sel.filter(function (c) { return c.text && c.auth !== 'WO' && (d.dead || !DEAD[c.status]); });
        var withText = sel.filter(function (c) { return c.text && c.auth !== 'WO'; }).length, tri = Math.ceil((d.dead ? live.length : withText) / 10), n = Math.min(d.n, live.length);
        return { sel: sel.length, live: d.dead ? live.length : withText, tri: tri, n: n, min: live.length ? tri + n + 1 : 0, max: live.length ? tri + n * (1 + (d.dep ? 1 : 0) + (d.red ? 1 : 0)) + 1 : 0, dep: d.dep, red: d.red };
      }
      function drawDepth() {
        U.clear(depthBox); U.clear(startBox);
        var seg = h('div.k-depth', { role: 'radiogroup', 'aria-label': 'Depth of analysis' });
        DEPTHS.forEach(function (d) {
          seg.appendChild(h('button.k-depth-opt', { type: 'button', role: 'radio', 'aria-checked': S.depth === d[0] ? 'true' : 'false', onclick: function () { S.depth = d[0]; setRoute(); drawDepth(); } }, h('b', { text: d[1] }), h('span', { text: d[2] })));
        });
        depthBox.appendChild(seg);
        if (!S.cands) { startBox.appendChild(h('p.k-hint', { text: 'The estimate of Claude calls appears once the candidates are known.' })); return; }
        var e = estimate(S.depth);
        if (S.ai) {
          depthBox.appendChild(h('div.k-est', { id: 'fto-estimate' }, h('p', null, 'Estimated ', h('b.mono', { text: e.min === e.max ? String(e.min) : e.min + ' to ' + e.max }), ' Claude calls for ' + K.plural(e.sel, 'selected publication', 'selected publications') + '.'),
            h('ul.k-est-list', null,
              h('li', { text: 'Triage: up to ' + e.tri + (e.tri === 1 ? ' call' : ' calls') + ' for ' + e.live + (e.live === 1 ? ' publication' : ' publications') + ' with claim text (10 per call; rights no longer in force are left out)' }),
              h('li', { text: 'Claim charts: ' + e.n + (e.n === 1 ? ' call' : ' calls') + ', one per publication; triage may sort out publications as not relevant, which lowers the number' }),
              e.dep ? h('li', { text: 'Dependent claims: up to ' + e.n + ', only for publications of the highest relevance' }) : null,
              e.red ? h('li', { text: 'Red-team review: up to ' + e.n + ', skipped where all features already count as met' }) : null,
              h('li', { text: 'Summary: 1 call' })),
            h('p.k-hint', { text: 'Not included: if Claude returns an invalid reply, the step is repeated exactly once. Very long claim sets are split over several calls. In the worst case the number doubles. Calls run one after another; usage counts against your own Claude account.' })));
        } else depthBox.appendChild(h('p.notice', { text: 'Without Claude, 0 calls are sent. The result is a compilation of candidates, legal status and expiry; every publication is listed as "not analysed without Claude".' }));
        var btn = h('button.btn.primary.k-start', { id: 'fto-start', type: 'button', disabled: !e.sel, onclick: start }, U.icon('fto'), S.ai ? 'Start analysis' : 'Compile without Claude');
        startBox.appendChild(h('div.k-row', null, btn, h('span.k-hint', { text: e.sel ? 'The analysis runs while this view is open. A cancelled run can be resumed later.' : 'Select at least one publication.' })));
      }
      function start() {
        var p = profileOf(S.pid), sel = selected(); if (!p || !sel.length || !S.features) return;
        runWith(function (o) { return F.run(S.features, Object.assign({ patents: sel, searchRecord: S.record, depth: S.depth, lang: 'en', markets: p.markets && p.markets.length ? p.markets : undefined }, o)); }, p.name);
      }

      /* -------------------------------------------------------- saved */
      function drawSaved(list) {
        U.clear(savedBox);
        if (!list || !list.length) { savedBox.appendChild(h('p.k-hint', { text: 'No pre-screen saved yet. Finished and interrupted pre-screens appear here and can be opened, resumed and exported.' })); return; }
        var rows = h('div.rows.k-saved');
        list.forEach(function (o) {
          var st = STATE[o.state] || [o.state || '–', 'hollow'], del = null, armed = false;
          var worst = o.summary && o.summary.overall && (o.summary.overall.markets || []).reduce(function (a, m) { return F.maxRisk(a, m.risk); }, null);
          del = h('button.btn.quiet.sm', { type: 'button', onclick: function () {
            if (!armed) { armed = true; U.set(del, 'Really delete?'); setTimeout(function () { armed = false; if (del.isConnected) U.set(del, 'Delete'); }, 4000); return; }
            F.remove(o.id).then(function () { return F.list(); }).then(drawSaved, function (e) { U.toast('Delete failed: ' + U.errText(e), { error: true }); });
          } }, 'Delete');
          rows.appendChild(h('div.row', null,
            h('span.grow', null, o.state === 'done' ? h('a', { href: R.build({ view: 'fto', arg: o.id }) }, h('b', { text: o.title || o.id })) : h('b', { text: o.title || o.id }), h('br'),
              h('span.faint', { text: U.date(String(o.updated || o.created || '').slice(0, 10)) + ' · ' + ((DEPTHS.filter(function (d) { return d[0] === o.depth; })[0] || [0, o.depth])[1]) + (o.summary ? ' · ' + o.summary.patents + ' analysed' : ' · ' + o.steps + (o.steps === 1 ? ' step saved' : ' steps saved')) + (o.error && o.error.message ? ' · ' + o.error.message : '') })),
            worst ? K.riskPill(worst) : null, h('span.pill.' + st[1], { text: st[0] }),
            o.state === 'done' ? h('a.btn.sm', { href: R.build({ view: 'fto', arg: o.id }) }, 'Open') : h('button.btn.sm', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(o.id, x); }, o.title); } }, 'Resume'), del));
        });
        savedBox.appendChild(rows);
      }
    }

    /* ============================================================ run */
    function runWith(call, title) {
      var my = ++viewSeq;
      abortRun();
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; running = true;
      var STG = [['status', 'Legal status and markets'], ['triage', 'Triage of the independent claims'], ['patent', 'Claim chart per publication'], ['synthesis', 'Summary']];
      var stEl = {}, steps = h('ol.k-steps'), log = h('ol.k-log', { 'aria-live': 'polite' }), stream = h('pre.k-stream', { 'aria-hidden': 'true' }), calls = h('span.mono', { text: '0' }), headLine = h('span', { text: 'Analysis running' }), spin = h('span.spin');
      var cancel = h('button.btn', { type: 'button', onclick: function () { cancel.disabled = true; headLine.textContent = 'Cancelling …'; if (ctl) ctl.abort(); } }, 'Cancel'), after = h('div.k-row');
      STG.forEach(function (s) { var li = h('li', { data: { s: 'wait' } }, h('span.st', { text: 'waiting' }), h('span.k-steps-t', { text: s[1] }), h('span.info')); stEl[s[0]] = li; steps.appendChild(li); });
      function stage(id, state, info) { var li = stEl[id]; if (!li) return; li.dataset.s = state; li.children[0].textContent = state === 'run' ? 'running' : state === 'ok' ? 'done' : state === 'err' ? 'stopped' : 'waiting'; if (info != null) li.children[2].textContent = info; }
      function line(text, cls) { log.appendChild(h('li' + (cls ? '.' + cls : ''), null, h('time.mono', { text: new Date().toLocaleTimeString('en-GB') }), h('span', { text: text }))); while (log.children.length > 300) log.removeChild(log.firstChild); log.scrollTop = log.scrollHeight; }
      U.set(page, K.head('Freedom to operate', title || 'Pre-screen', ''),
        h('section.sec', null, h('div.k-run-head', null, spin, h('h2.sec-title', null, headLine), h('span.k-sub', null, 'Claude calls: ', calls), cancel),
          steps, h('p.k-hint', { text: 'Every finished step is saved. After a cancellation, a reload or a usage limit, "Resume" continues from this point.' })),
        h('section.sec', null, h('h3.k-h3', { text: 'Progress log' }), log, h('h3.k-h3', { text: 'Reply of the current step' }), stream), after);
      var SUB = { chart: 'claim chart', dependent: 'dependent claims', redteam: 'red-team review' };
      function onEvent(ev) {
        if (dead || my !== viewSeq || !ev) return;
        if (ev.type === 'stage') {
          if (stEl[ev.stage]) {
            var done = ev.total != null && ev.done >= ev.total;
            stage(ev.stage, done ? 'ok' : 'run', ev.total != null ? ev.done + ' of ' + ev.total + (ev.pn && !done ? ' · ' + U.pnPretty(ev.pn) : '') : null);
            if (ev.stage === 'patent' && ev.pn && !done) line(U.pnPretty(ev.pn) + ': analysis started');
          } else if (SUB[ev.stage]) { stream.textContent = ''; line(U.pnPretty(ev.pn) + ': ' + SUB[ev.stage] + (ev.parts > 1 ? ' (part ' + ev.part + ' of ' + ev.parts + ')' : '')); }
        } else if (ev.type === 'triage') line(U.pnPretty(ev.pn) + ': relevance ' + (ev.rel || '–') + (ev.why ? ' · ' + ev.why : ''));
        else if (ev.type === 'chart') line(U.pnPretty(ev.pn) + ': claim chart done, risk ' + K.riskLabel(ev.risk), 'ok');
        else if (ev.type === 'redteam') line(U.pnPretty(ev.pn) + ': red-team review done, risk ' + K.riskLabel(ev.risk && ev.risk.final), 'ok');
        else if (ev.type === 'dependent') line(U.pnPretty(ev.pn) + ': dependent claims checked', 'ok');
        else if (ev.type === 'text') { var t = String(ev.text || ''); stream.textContent = t.length > 900 ? '… ' + t.slice(-900) : t; }
        else if (ev.type === 'repair') line('Invalid reply (' + ev.errors + (ev.errors === 1 ? ' error' : ' errors') + '), the step is repeated once', 'warn');
        else if (ev.type === 'warn') line(String(ev.message || ''), 'warn');
        else if (ev.type === 'usage') calls.textContent = String(ev.calls);
        else if (ev.type === 'resume') line('Saved run found: ' + ev.steps + ' finished ' + (ev.steps === 1 ? 'step is' : 'steps are') + ' reused');
        else if (ev.type === 'resumed') line('Step reused from the saved run');
      }
      function finish() { running = false; ctl = null; if (spin.parentNode) spin.parentNode.removeChild(spin); cancel.hidden = true; }
      call({ onEvent: onEvent, signal: ctl ? ctl.signal : undefined }).then(function (op) {
        if (dead || my !== viewSeq) return;
        finish(); R.go({ view: 'fto', arg: op.id });
      }, function (e) {
        if (dead || my !== viewSeq) return;
        finish();
        STG.forEach(function (s) { if (stEl[s[0]].dataset.s === 'run') stage(s[0], 'err'); });
        var cancelled = e && e.code === 'cancelled';
        headLine.textContent = cancelled ? 'Cancelled' : 'Paused';
        line(cancelled ? 'Cancelled. The finished steps are saved.' : (e && (e.userMessage || e.message)) || 'The analysis was paused.', cancelled ? null : 'warn');
        if (!cancelled) after.appendChild(h('p.notice.err', { text: (e && (e.userMessage || e.message)) || 'The analysis was paused.' }));
        if (e && e.id) after.appendChild(h('button.btn.primary', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(e.id, x); }, title); } }, 'Resume'));
        after.appendChild(h('button.btn', { type: 'button', onclick: function () { R.go({ view: 'fto', params: { p: S.pid, d: S.depth === 'standard' ? '' : S.depth } }); } }, 'Back to setup'));
      });
    }

    /* ============================================================ opinion */
    function showOpinion(id) {
      var my = ++viewSeq;
      abortRun();
      U.set(page, K.busy('Loading pre-screen'));
      Promise.resolve(F.load(id)).then(function (op) {
        if (dead || my !== viewSeq) return;
        if (op && op.patents) return drawOpinion(op);
        return St.get('opinions', id).then(null, function () { return null; }).then(function (head) {
          if (dead || my !== viewSeq) return;
          U.set(page, K.head('Freedom to operate', 'Pre-screen not finished', ''), h('div.empty', null,
            h('h3', { text: head ? 'This pre-screen was interrupted' : 'This pre-screen does not exist' }),
            h('p', { text: head ? Object.keys(head.steps || {}).length + ' finished steps are saved. Resume continues the analysis from this point.' : 'Nothing is saved under this address. Saved pre-screens live in the storage of this page; in another browser they are only visible if the artifact database is available.' }),
            h('div.k-row', null, head ? h('button.btn.primary', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(id, x); }, head.title); } }, 'Resume') : null, h('a.btn', { href: '#fto' }, 'All pre-screens'))));
        });
      }).catch(function (e) { if (!dead && my === viewSeq) U.set(page, K.errBox(e, 'The pre-screen could not be loaded'), h('p', null, h('a.btn', { href: '#fto' }, 'All pre-screens'))); });
    }
    function exportOp(op, fmt) {
      var text; try { text = F.render(op, fmt); } catch (e) { U.toast('Export failed: ' + U.errText(e), { error: true }); return; }
      var name = 'fto-' + String((op.profile && op.profile.bezeichnung) || 'pre-screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + String(op.finished || op.created || '').slice(0, 10) + '.' + fmt;
      U.saveFile(name, text, fmt === 'md' ? 'text/markdown;charset=utf-8' : fmt === 'html' ? 'text/html;charset=utf-8' : 'application/json');
    }
    /* PDF: the same HTML in a hidden frame, printed through the browser ("Save as PDF"). Where printing is blocked (sandboxed
       artifact frame) the print-ready HTML is saved instead, with a hint. The file itself contains no script. */
    function fileBase(op) { return 'fto-' + String((op.profile && op.profile.bezeichnung) || 'pre-screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + String(op.finished || op.created || '').slice(0, 10); }
    function printOp(op) {
      var html; try { html = F.render(op, 'html'); } catch (e) { U.toast('Export failed: ' + U.errText(e), { error: true }); return; }
      var done = false, frame, oldTitle = document.title;
      function fallback() {
        if (done) return; done = true; cleanup();
        U.saveFile(fileBase(op) + '-print.html', html, 'text/html;charset=utf-8');
        U.toast('Printing is not available here. Open the saved file in your browser and choose Print, then Save as PDF (A4).', { ms: 15000 });
      }
      function cleanup() { try { document.title = oldTitle; } catch (e) { /* ignore */ } if (frame && frame.parentNode) setTimeout(function () { if (frame.parentNode) frame.parentNode.removeChild(frame); }, 1000); }
      try {
        frame = document.createElement('iframe'); frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('tabindex', '-1');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        frame.onload = function () {
          if (done) return;
          try {
            var w = frame.contentWindow, seen = false;
            w.addEventListener('beforeprint', function () { seen = true; });
            document.title = fileBase(op);
            w.focus(); w.print();
            if (seen) { done = true; cleanup(); } else fallback();   // print() returned without the print preview: blocked
          } catch (e) { fallback(); }
        };
        frame.srcdoc = html; document.body.appendChild(frame);
        setTimeout(function () { if (!done && !frame.contentDocument) fallback(); }, 5000);
      } catch (e) { fallback(); }
    }
    function prose(text) { return h('div.k-prose', null, String(text || '').split(/\n{2,}/).filter(function (x) { return x.trim(); }).map(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim(); });
      if (lines.length && lines.every(function (l) { return /^\s*([-*]|\d+[.)])\s+/.test(l); })) return h('ul', null, lines.map(function (l) { return h('li', { text: l.replace(/^\s*([-*]|\d+[.)])\s+/, '').replace(/\*\*/g, '') }); }));
      return h('p', { text: b.replace(/\*\*/g, '') });
    })); }
    function limits(op, id) { return h('aside.k-limits', { id: id, 'aria-label': 'Limits of this pre-screen' }, String(op.limits || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l, i) { return h(i === 0 ? 'p.k-limits-t' : 'p', { text: l }); })); }

    function drawOpinion(op) {
      var matrix = (op.matrix || []).slice().sort(function (a, b) { return F.riskRank(b.risk) - F.riskRank(a.risk) || String(a.expiry || '').localeCompare(String(b.expiry || '')); });
      var folds = {}, syn = op.synthesis, einzel = {}; if (syn) (syn.einzelbewertungen || []).forEach(function (x) { einzel[x.patent_id] = x; });
      function jump(pn) { var d = folds[pn]; if (!d) return; d.open = true; d.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      var depthName = (DEPTHS.filter(function (d) { return d[0] === op.depth; })[0] || [0, op.depth])[1];
      var head = h('header.page-head', null, h('p.overline', null, h('a', { href: '#fto', text: 'Freedom to operate' }), ' / Pre-screen'), h('h1.page-title', { text: op.title || 'FTO pre-screen' }),
        h('p.lead', { text: 'Created ' + U.date(String(op.finished || op.created || '').slice(0, 10)) + ' · Depth ' + depthName + ' · Markets ' + (op.markets || []).join(', ') + ' · ' + K.plural((op.patents || []).length, 'publication analysed', 'publications analysed') + (op.run ? ' · ' + op.run.calls + ' Claude calls' : '') + ' · Legal status as of ' + U.date(op.statusSnapshot) }),
        h('div.k-row', null, [['md', 'Markdown'], ['html', 'HTML'], ['pdf', 'PDF'], ['json', 'JSON']].map(function (f) { return h('button.btn.sm', { type: 'button', 'data-fmt': f[0], onclick: function () { if (f[0] === 'pdf') printOp(op); else exportOp(op, f[0]); } }, U.icon('download'), f[1]); })));

      // overall + matrix
      var over = K.stats(((op.overall && op.overall.markets) || []).map(function (m) { return [m.market === 'EP_UPC' ? 'EP / unitary patent' : m.market === 'DE' ? 'Germany' : m.market === 'US' ? 'United States' : m.market, K.riskPill(m.risk), (m.drivers || []).length ? 'Driven by: ' + m.drivers.map(U.pnPretty).join(', ') : 'no driving patent right']; }));
      var mt = h('tbody');
      matrix.forEach(function (m) {
        mt.appendChild(h('tr', null, h('td', null, h('button.k-linkbtn.mono', { type: 'button', onclick: function () { jump(m.pn); }, text: U.pnPretty(m.pn) })), h('td', { text: (m.markets || []).join(', ') }), h('td', { text: m.rel || '–' }), h('td', null, K.riskPill(m.risk)),
          h('td', { text: K.litLabel(m.literal) }), h('td', null, h('span.pill.' + (m.dead ? 'hollow' : m.pending ? 'info' : 'good'), { text: m.dead ? 'not in force' : m.pending ? 'pending' : 'in force' }), h('div.faint.k-small', { text: m.status || '' })),
          h('td.mono', { text: m.expiry ? U.date(m.expiry) : 'unknown', title: m.expiryBasis || null }), h('td.k-small', { text: labs(m.flags) })));
      });
      var matrixSec = K.sec('Result', 'Risk matrix', null,
        op.aiUsed === false ? h('p.notice', { text: 'Compiled without Claude: this compilation contains the search and the legal status, but no claim charts.' }) : null,
        (op.overall && (op.overall.markets || []).length) ? over : null,
        matrix.length ? h('div.table-wrap', null, h('table.data.k-matrix', null, h('thead', null, h('tr', null, ['Patent right', 'Market', 'Relevance', 'Risk', 'Literal infringement', 'Legal status', 'Expiry (estimate)', 'Notes'].map(function (t) { return h('th', { text: t }); }))), mt)) : h('p.k-hint', { text: 'No publication was analysed. The reasons are listed under "Not analysed".' }),
        h('p.k-hint', { text: 'Risk = the more adverse result of claim chart and red-team review; the app sets floors (literally met and granted = very high). The level is a working hypothesis.' }));

      // timeline
      var tlBox = h('div');
      if (matrix.length) C.timeline(tlBox, { from: K.todayIso(), label: 'Estimated expiry of the analysed patent rights', rows: matrix.map(function (m) { return { label: U.pnPretty(m.pn), href: App.patentHref(m.pn, { q: '' }), end: m.expiry || null, lv: K.riskLevel(m.risk), risk: K.riskLabel(m.risk), dead: m.dead, pending: m.pending, note: m.expiryBasis || '' }; }) });
      var tlSec = matrix.length ? K.sec('Timeline', 'How long the rights run', null, h('p.k-note', { text: 'Bars from today to the estimated expiry, colour by risk level, dashed = application not yet granted. Expiry = filing date plus 20 years, US with patent term adjustment; surrenders, lapses for non-payment of fees and supplementary protection certificates are not taken into account.' }),
        h('div.k-legend', null, [0, 1, 2, 3, 4].map(function (i) { return h('span', null, h('i.k-lv', { data: { lv: String(i) } }), ['very low', 'low', 'medium', 'high', 'very high'][i]); }), h('span', null, h('i.k-lv', { data: { lv: '-1' } }), 'cannot be assessed')), tlBox) : null;

      // synthesis
      var synSec = syn ? K.sec('Summary', 'What Claude concludes from the individual results', null, prose(syn.zusammenfassung),
        syn.app && (syn.app.flags || []).length ? h('p.notice', { text: 'App notes on the summary: ' + labs(syn.app.flags) }) : null,
        syn.querschnitt ? h('div', null, h('h3.k-h3', { text: 'Cross-cutting points' }), prose(syn.querschnitt)) : null) : (op.synthesisFailed ? K.sec('Summary', 'Not produced', null, h('p.notice.err', { text: 'The summary failed: ' + (op.synthesisFailed.message || '') })) : null);

      // per patent
      var patSec = K.sec('Individual results', 'Claim chart per patent right', null);
      var order = {}; matrix.forEach(function (m, i) { order[m.pn] = i; });
      (op.patents || []).slice().sort(function (a, b) { return (order[a.pn] || 0) - (order[b.pn] || 0); }).forEach(function (e, idx) {
        var ch = e.chart, rt = e.redteam, da = e.dependent, gs = (ch && ch.gesamt) || {};
        var body = h('div.k-pat-body');
        body.appendChild(K.kv([['Applicant', e.assignee], ['Assessed for', (e.markets || []).join(', ') + (e.jurisdiction ? ' (' + e.jurisdiction + ')' : '')], ['Relevance', (e.rel || '–') + (e.relWhy ? ': ' + e.relWhy : '')], ['Found via', (e.why || []).join(' · ')],
          ['Legal status', (e.status || '') + (e.right && (e.right.notes || []).length ? ' · ' + e.right.notes.join(' · ') : '')], ['Expiry', e.expiry && e.expiry.date ? U.date(e.expiry.date) + ' (estimate)' + (e.expiry.basis ? ' · ' + e.expiry.basis : '') : 'unknown'],
          ['Risk', h('span.k-row', null, K.riskPill(e.risk && e.risk.final), h('span.faint.k-small', { text: 'Claim chart: ' + K.riskLabel(e.risk && e.risk.b) + ' · Red-team review: ' + (e.risk && e.risk.e ? K.riskLabel(e.risk.e) : '–') }))],
          ['Notes', labs(e.flags)]]));
        body.appendChild(h('p', null, h('a.btn.sm', { href: App.patentHref(e.pn, { q: '' }) }, 'Open publication')));
        if (e.failed) body.appendChild(h('p.notice.err', { text: 'Analysis failed: ' + (e.failed.message || e.failed.code || '') + '. The publication counts as "cannot be assessed".' }));
        if (einzel[e.pn]) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Short verdict' }), h('p', { text: einzel[e.pn].kurzfazit || '' }), einzel[e.pn].text ? prose(einzel[e.pn].text) : null));
        if (ch && ch.app && (ch.app.notes || []).length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'App checks' }), h('ul.k-list', null, ch.app.notes.concat(rt && rt.app ? (rt.app.notes || []) : []).map(function (n) { return h('li', { text: n }); }))));
        ((ch && ch.claims) || []).forEach(function (c) {
          var a = c.app || {}, tb = h('tbody');
          (c.merkmale || []).forEach(function (m) {
            var x = m.app || {}, verified = x.verified === true || x.quote === 'ok', au = m.auslegung || {}, extra = [];
            if (au.weite_auslegung || au.enge_auslegung) extra.push('Construction: broad = ' + (au.weite_auslegung || '–') + '; narrow = ' + (au.enge_auslegung || '–'));
            if (au.definition_quote) extra.push('Definition' + (au.definition_para ? ' [' + au.definition_para + ']' : '') + ': "' + au.definition_quote + '"');
            if (m.annahme) extra.push('Assumption: ' + m.annahme);
            if (m.klaerung) extra.push('To be clarified: ' + m.klaerung);
            if (x.redteam) extra.push('Red-team review: ' + lab(x.redteam));
            if (m.markush) extra.push('Formula test: ' + lab(m.markush.app_ergebnis || m.markush.ergebnis || '') + (m.markush.geruest ? ' · Scaffold: ' + m.markush.geruest : ''));
            tb.appendChild(h('tr', null, h('td.mono', { text: m.feature_id || '' }), h('td.k-quote', null, h('q', { text: m.claim_quote || '' })),
              h('td', null, h('span', { text: m.product_value == null ? '–' : String(m.product_value) }), (m.product_refs || []).length ? h('span.faint.mono.k-small', { text: ' [' + m.product_refs.join(', ') + ']' }) : null),
              h('td', null, K.verdictPill(x.verdict || m.verdict), x.forced ? h('div.faint.k-small', { text: 'set by the app (' + lab(x.forced) + '); Claude: ' + lab(m.verdict || '') }) : null,
                h('div.k-small.k-reason', { text: m.begruendung || '' }), extra.map(function (t) { return h('div.k-small.faint', { text: t }); })),
              h('td.k-verif', null, verified ? h('span.k-ok', { title: QCHK.ok }, U.icon('check'), h('span', { text: 'verified' })) : h('span.k-nok', { title: QCHK[x.quote] || 'Quote not verified' }, U.icon('x'), h('span', { text: x.quote === 'elided' ? 'omission' : x.quote === 'approx' ? 'approximate' : x.quote === 'empty' ? 'no quote' : 'not verified' })))));
          });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', null, 'Claim ' + c.claim_no, c.kategorie ? h('span.faint', { text: ' · ' + lab(c.kategorie) }) : null),
            h('p.k-sub', null, 'Result from the features: ', h('b', { text: K.litLabel(a.literal_final || a.literal || c.literal_ergebnis) }), a.literal_model && a.literal_model !== a.literal ? h('span.faint', { text: ' (Claude: ' + K.litLabel(a.literal_model) + ')' }) : null, (a.flags || []).length ? h('span.faint', { text: ' · ' + labs(a.flags) }) : null),
            h('div.table-wrap', null, h('table.data.k-chart-t', null, h('thead', null, h('tr', null, ['Feature', 'Claim wording (quote)', 'Product', 'Assessment', 'Quote'].map(function (t) { return h('th', { text: t }); }))), tb)),
            (c.aequivalenz || []).length ? h('div', null, h('h5.k-h5', { text: 'Equivalence questions for counsel (not decided here)' }), h('ul.k-list', null, c.aequivalenz.map(function (q) { return h('li', { text: (q.feature_id || '') + ': substituted means ' + (q.austauschmittel || '–') + '. ' + (q.begruendung || '') }); }))) : null));
        });
        if (da && (da.unteransprueche || []).length) {
          var tb3 = h('tbody');
          da.unteransprueche.forEach(function (u) { (u.zusatzmerkmale || []).forEach(function (z, i) { tb3.appendChild(h('tr', null, h('td.mono', { text: i ? '' : String(u.claim_no) }), h('td.k-quote', null, h('q', { text: z.claim_quote || '' })), h('td', null, K.verdictPill((z.app && z.app.verdict) || z.verdict), h('div.k-small', { text: z.begruendung || '' })), h('td', { text: i ? '' : lab((u.app && u.app.ketten_ergebnis) || u.ketten_ergebnis || '') }))); }); });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', { text: 'Dependent claims (fallback positions)' }), h('div.table-wrap', null, h('table.data.k-chart-t', null, h('thead', null, h('tr', null, ['Claim', 'Added feature (quote)', 'Assessment', 'Chain'].map(function (t) { return h('th', { text: t }); }))), tb3))));
        }
        if (rt) {
          var at = [];
          (rt.claims || []).forEach(function (rc) { (rc.angriffe || []).forEach(function (a2) { at.push('Claim ' + rc.claim_no + ' ' + (a2.feature_id || '') + ': ' + (a2.argument_patentinhaber || '') + (a2.gegenargument_nutzer ? ' · Counter-argument: ' + a2.gegenargument_nutzer : '') + ' · Outcome: ' + lab(a2.ergebnis || '')); }); });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', { text: 'Red-team review from the patentee\'s point of view' }), h('p.k-sub', null, 'Risk after the red-team review: ', K.riskPill(rt.revidiert && rt.revidiert.risiko), rt.revidiert && rt.revidiert.begruendung ? h('span', { text: ' ' + rt.revidiert.begruendung }) : null),
            at.length ? h('ul.k-list', null, at.map(function (t) { return h('li', { text: t }); })) : h('p.k-hint', { text: 'No viable attack found.' })));
        }
        var qs = (gs.offene_fragen || []).slice();
        if (qs.length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Open questions for counsel' }), h('ul.k-list', null, qs.map(function (q) { return h('li', { text: q }); }))));
        if ((gs.umgehungsloesungen || []).length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Design-around ideas (technical hypotheses)' }), h('ul.k-list', null, gs.umgehungsloesungen.map(function (u) { return h('li', { text: (u.feature_id || '') + ': ' + (u.aenderung || '') + (u.vorbehalt ? ' · Caveat: ' + u.vorbehalt : '') }); }))));
        var d = h('details.k-pat', { open: idx === 0 }, h('summary', null, h('span.mono.k-pat-pn', { text: U.pnPretty(e.pn) }), h('span.k-pat-t', { text: e.title || '' }), K.riskPill(e.risk && e.risk.final)), body);
        folds[e.pn] = d; patSec.appendChild(d);
      });
      if (!(op.patents || []).length) patSec.appendChild(h('p.k-hint', { text: 'No publication was analysed.' }));

      // not charted
      var groups = {}; (op.notCharted || []).forEach(function (n) { (groups[n.reason] = groups[n.reason] || []).push(n); });
      var ncSec = (op.notCharted || []).length ? K.sec('Gaps', 'Not analysed, and why', null, h('p.k-note', { text: 'These publications are part of the selection but have no claim chart. That does not clear them.' })) : null;
      if (ncSec) REASON_ORDER.concat(Object.keys(groups).filter(function (k) { return REASON_ORDER.indexOf(k) < 0; })).forEach(function (k) {
        if (!groups[k]) return;
        var tbn = h('tbody'); groups[k].forEach(function (n) { tbn.appendChild(h('tr', null, h('td', null, K.patentLink(n.pn, App)), h('td.t', { text: n.title || '' }), h('td', { text: n.status || '' }), h('td.mono', { text: n.expiry ? U.date(n.expiry) : '–' }), h('td.k-small', { text: n.text || '' }))); });
        ncSec.appendChild(h('details.k-fold', { open: k === 'depth_limit' || k === 'no_ai' }, h('summary', null, h('span', { text: (REASON[k] || k) + ' (' + groups[k].length + ')' })), h('div.k-fold-body', null, h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['Number', 'Title', 'Legal status', 'Expiry', 'Reason'].map(function (t) { return h('th', { text: t }); }))), tbn)))));
      });

      // next steps
      var steps = syn && (syn.naechste_schritte || []).length ? K.sec('Next', 'Next steps', null, h('ol.k-next', null, syn.naechste_schritte.slice().sort(function (a, b) { return (a.prioritaet || 0) - (b.prioritaet || 0); }).map(function (s) { return h('li', null, h('b', { text: s.schritt || '' }), s.warum ? h('span', { text: ' ' + s.warum }) : null); })),
        (syn.offene_fragen || []).length ? h('div', null, h('h3.k-h3', { text: 'Open questions' }), h('ul.k-list', null, syn.offene_fragen.map(function (q) { return h('li', { text: q }); }))) : null) : null;
      var warn = (op.warnings || []).length ? K.sec('Run', 'Notes from the analysis', null, h('ul.k-list', null, op.warnings.map(function (w) { return h('li', { text: w }); }))) : null;

      var endLimits = limits(op, 'fto-limits-end');
      var topLimits = h('aside.k-limits.short', { id: 'fto-limits', 'aria-label': 'Notice' }, h('p', null, h('b', { text: 'Pre-screen, not a legal opinion. ' }), 'Produced automatically; it does not replace review by a patent attorney. Legal status as of ' + U.date(op.statusSnapshot) + ', expiry dates are estimates, and generic claims may cover more than was found here.'),
        h('button.btn.sm', { type: 'button', onclick: function () { endLimits.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, 'Read all limits'));
      U.set(page, head, topLimits, matrixSec, tlSec, synSec, patSec, ncSec, steps, warn, endLimits);
    }

    /* ============================================================ routing */
    function show(r) { if (r.arg) showOpinion(r.arg); else showSetup(r); }
    show(route);
    var offCaps = App.on('caps', function () { if (!dead && !running && !App.route.arg && !S.ai && aiReady()) showSetup(App.route); });
    return {
      update: function (r) { show(r); return true; },
      destroy: function () { dead = true; abortRun(); offCaps(); K.tip.hide(); }
    };
  }
  g.LnpApp.registerView({ id: 'fto', title: 'FTO', icon: 'fto', mount: g.LnpLazyView('fto', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });
})(window);
