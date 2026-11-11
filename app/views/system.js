/* LNP Patent Desk: system view. Route: #system[--xtest] (xtest starts the self-test)
   Corpus snapshot and coverage from the manifest, source dates with a staleness warning for the legal status,
   engine diagnostics, AI usage log, a self-test, the limits statement and a short method description. */
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

  var MODE = { worker: 'dedicated worker', blob: 'blob worker', main: 'main thread' };
  var SIZE_DE = { chemistry: 'Structures', images: 'Formula images', 'claim text': 'Claim text', 'patent table': 'Patent table', definitions: 'Definitions', postings: 'Search index (words)', positions: 'Search index (positions)', web: 'Page and scripts', status: 'Legal status', meta: 'Filter columns', 'index other': 'Search index (other)', seed: 'Master data' };
  var LIMITS_FALLBACK = ['This page is a search and FTO pre-screening tool and not legal advice. It does not replace review by a patent attorney.',
    'The dataset is limited by subject matter (LNP and lipid field, EP, US and WO). Rights outside this scope are not covered.',
    'Generic claims (Markush) can cover structures that are not individually indexed in the dataset.', 'Legal status and expiry are snapshots and estimates.'];

  function mount(host, route, App) {
    var K = g.LnpKit, C = g.LnpChart, D = g.LnpData, S = g.LnpSearch, Ch = g.LnpChem, St = g.LnpStore;
    var M = App.manifest || {}, c = M.counts || {}, snap = M.snapshots || {}, cut = M.cut || {}, dead = false;
    var covBox = h('div', null, K.busy('Counting coverage')), engBox = h('div'), aiBox = h('div'), testBox = h('div.k-tests'), errBox = h('div');
    var testBtn = h('button.btn.primary', { id: 'sys-test', type: 'button', onclick: runTests }, U.icon('check'), 'Run self-test');

    /* ---------------------------------------------------------- sources and staleness */
    var regDays = K.daysSince(snap.ep_register), builtDays = K.daysSince(String(M.built || '').slice(0, 10));
    var stale = regDays == null ? h('p.notice.err', { id: 'sys-stale', text: 'The date of the legal status is unknown. Treat every legal status statement as unchecked.' })
      : regDays > 180 ? h('p.notice.err', { id: 'sys-stale', text: 'The legal status (EP Register) is ' + regDays + ' days old, i.e. older than six months. The FTO check therefore treats every legal status as unchecked and every right as in force. Check the status in the register before any decision.' })
        : regDays > 45 ? h('p.notice', { id: 'sys-stale', text: 'The legal status (EP Register) is ' + regDays + ' days old. Grants, oppositions, revocations and lapsed rights after ' + U.date(snap.ep_register) + ' are missing. For individual publications, the register link in the patent view leads to the current status.' })
          : h('p.k-ok-note', { id: 'sys-stale', text: 'The legal status (EP Register) is ' + regDays + ' days old.' });
    var sources = K.kv([
      ['Data package built', U.date(String(M.built || '').slice(0, 10)) + (builtDays != null ? ' · ' + builtDays + ' days ago' : '')],
      ['Legal status EP', 'EP Register, as of ' + U.date(snap.ep_register) + ' · lapsed states additionally from the patent documents'],
      ['Legal status US', 'calculated from filing date and term adjustment; maintenance fees and disclaimers are not checked'],
      ['EP full texts', 'EPO Publication Server, retrieved up to ' + U.date(snap.ep_text)], ['US full texts', 'USPTO Patent Public Search, retrieved up to ' + U.date(snap.us_text)],
      ['Structures and field definition', 'SureChEMBL, as of ' + U.date(snap.surechembl) + ' (CC BY 4.0)'], ['Dataset compiled', U.date(String(snap.corpus || '').slice(0, 10))]]);

    /* ---------------------------------------------------------- coverage */
    function coverage() {
      var auths = ['EP', 'US', 'WO'];
      Promise.all(auths.map(function (a) { return S.search('', { filters: { auth: [a] }, limit: 1, facets: true, snippets: false }).then(function (r) { return r; }, function () { return null; }); })).then(function (res) {
        if (dead) return;
        var tb = h('tbody'), tot = [0, 0, 0];
        auths.forEach(function (a, i) {
          var r = res[i]; if (!r) { tb.appendChild(h('tr', null, h('td', { text: a }), h('td', { colspan: '5', text: 'not counted' }))); return; }
          var f = r.facets || {}, st = f.status || {}, withSt = 0; Object.keys(st).forEach(function (k) { if (k && k !== 'unknown') withSt += st[k]; });
          var live = st.granted || 0;
          tot[0] += r.total; tot[1] += f.text || 0; tot[2] += withSt;
          tb.appendChild(h('tr', null, h('td', null, h('a', { href: R.build({ view: 'suche', params: { a: [a] } }), text: a })), h('td.num', { text: U.num(r.total) }), h('td.num', { text: U.num(f.text || 0) }),
            h('td.num', { text: r.total ? ((f.text || 0) / r.total * 100).toFixed(1) + '%' : '–' }), h('td.num', { text: a === 'WO' ? '–' : U.num(withSt) }), h('td.num', { text: a === 'WO' ? '–' : U.num(live) })));
        });
        tb.appendChild(h('tr.k-total', null, h('td', { text: 'Total' }), h('td.num', { text: U.num(tot[0]) }), h('td.num', { text: U.num(tot[1]) }), h('td.num', { text: tot[0] ? (tot[1] / tot[0] * 100).toFixed(1) + '%' : '–' }), h('td.num', { text: U.num(tot[2]) }), h('td')));
        U.set(covBox, h('div.table-wrap', null, h('table.data.k-cov', null, h('thead', null, h('tr', null, ['Office', 'Publications', 'with claim text', 'Share', 'with legal status', 'of which granted'].map(function (t) { return h('th', { text: t }); }))), tb)));
      });
    }
    var idxC = (M.idx && M.idx.counts) || {};
    var facts = K.stats([
      ['Publications', U.num(c.patents), U.num(c.families) + ' families'],
      ['With claim text', U.num(c.fulltext), 'of ' + U.num(c.fulltextAvailable) + ' retrieved full texts'],
      ['Claims', U.num(c.claims), idxC.claimsEn != null ? U.num(idxC.claimsEn) + ' English, ' + U.num(idxC.claimsDe) + ' German · ' + U.num(idxC.indep) + ' independent' : null],
      ['Compounds', U.num(c.compounds), M.chem ? 'in ' + U.num(M.chem.nPat) + ' publications' : 'not included'],
      ['Key families', U.num(c.seed_present) + ' of ' + U.num(c.seed_expected), U.num(c.seed_fulltext) + ' with claim text'],
      ['Formula images', M.img ? U.num(M.img.images) : '0', M.img ? 'from ' + U.num(M.img.patents) + ' EP publications' + (M.img.cut ? ', ' + U.num(M.img.cut) + ' truncated' : '') : 'not included']]);
    var textShare = c.patents ? c.fulltext / c.patents * 100 : 0;
    var gaps = h('ul.k-list', null,
      h('li', { text: 'Claim text is available for ' + U.num(c.fulltext) + ' of ' + U.num(c.patents) + ' publications (' + textShare.toFixed(1) + ' %). All others can be found via title, abstract, applicant, classes, legal status and structures, but not via their claims, and they cannot be analysed.' }),
      h('li', { text: 'For each EP application, the latest B publication is retrieved (otherwise the A publication from filing year 2017), plus every US patent; US pre-grant publications only where there is no granted patent, and from 2018. WO publications never have claim text: the EP and US family members count instead.' }),
      h('li', { text: cut.applied ? 'Because of the size limit of the data package (' + U.num(cut.budgetMb) + ' MB), the claim text of ' + U.num((cut.text || {}).cut) + ' retrieved publications (' + U.num((cut.text || {}).claimsCut) + ' claims) and the definitions of ' + U.num((cut.defs || {}).cut) + ' publications are missing. The wider periphery is truncated first, oldest first; key families remain complete.' + (cut.firstCut ? ' First truncated publication: ' + cut.firstCut.pn + '.' : '')
        : 'No truncation: all ' + U.num((cut.text || {}).available != null ? cut.text.available : c.fulltextAvailable) + ' retrieved full texts are in the data package.' }),
      h('li', { text: 'Definitions from the description are available for ' + U.num(c.withDefs) + ' publications (excerpt, at most 8,000 characters per publication). The complete description is not included.' }),
      h('li', { text: 'Formula images exist only for EP publications. US claims with formulae contain a placeholder at that point; the analysis then reports \u201cformula not available\u201d.' }));
    var sizeBox = h('div');
    if (M.sizes) C.hbars(sizeBox, { unit: 'bytes', color: 'var(--s1)', rows: Object.keys(M.sizes).sort(function (a, b) { return M.sizes[b] - M.sizes[a]; }).map(function (k) { return { label: SIZE_DE[k] || k, value: Math.round(M.sizes[k] / 1024), title: U.bytes(M.sizes[k]) }; }) });

    /* ---------------------------------------------------------- engines */
    function drawEngines() {
      var d = App.diag(), eng = d.engines || {}, sd = St.diag ? St.diag() : {};
      Promise.all([Promise.resolve(D.diag()).then(null, function () { return null; }), Promise.resolve(S.diag ? S.diag() : null).then(null, function () { return null; }), App.chemUsed ? Promise.resolve(Ch.diag()).then(null, function () { return null; }) : Promise.resolve(null)]).then(function (x) {
        if (dead) return;
        var dd = x[0] || eng.data || {}, sdg = x[1] || {}, cd = x[2], se = eng.search || {};
        var chemCell = cd ? (MODE[cd.mode] || cd.mode) + ', ' + cd.workers + ' workers · ' + U.num(cd.n) + ' compounds · loaded in ' + U.num(Math.round(((cd.ms || {}).fetch || 0) + ((cd.ms || {}).load || 0) + ((cd.ms || {}).init || 0))) + ' ms · OpenChemLib ' + (cd.ocl || '')
          : h('span', null, 'not loaded yet ', h('button.btn.sm', { type: 'button', onclick: function () { App.chemUsed = true; U.toast('Loading structure data'); Ch.init().then(drawEngines, function (e) { U.toast('Structure data could not be loaded: ' + U.errText(e), { error: true }); }); } }, 'Load now'));
        U.set(engBox, K.kv([
          ['Patent table', (MODE[dd.mode] || dd.mode || '–') + ' · decompressed with ' + (dd.gzip === 'native' ? 'DecompressionStream' : 'fflate') + (dd.fetches != null ? ' · ' + dd.fetches + ' files, ' + U.bytes(dd.bytes || 0) + ' loaded' : '')],
          ['Search index', (MODE[se.mode] || se.mode || '–') + (se.ms != null ? ' · ready after ' + U.num(Math.round(se.ms)) + ' ms' : '') + (sdg && sdg.cache ? ' · ' + sdg.cache.postShards + ' word and ' + sdg.cache.textShards + ' text blocks in memory (' + U.bytes(sdg.cache.bytes || 0) + ')' : '')],
          ['Structures', chemCell],
          ['File format', d.enc === 'b64' ? 'Base64 text (fallback format)' : 'binary (gzip)'],
          ['Storage', ({ db: 'Artifact database: profiles, checks and watchlist follow the account', local: 'Browser storage: only in this browser on this device', memory: 'this session only: everything is lost on closing' })[App.store.backend] + (sd.readonly ? ' · Writing to the database was rejected, changes stay local' : '')],
          ['Claude (analysis, AI search)', d.aiAvailable ? 'available' : d.caps.claude ? 'not usable by the page (not enabled or switched off)' : 'not available: page runs outside claude.ai'],
          ['File export', d.caps.downloads ? 'via the claude.ai save dialog' : 'via a browser file link'],
          ['Start-up', d.ms.ready != null ? U.num(d.ms.ready) + ' ms to first view (table ' + U.num(d.ms.meta) + ' ms, index ' + U.num(d.ms.index) + ' ms)' : '–'],
          ['Browser', d.ua.browser + ' ' + (d.ua.major || '') + ' · ' + d.ua.os + ' · ' + d.viewport[0] + ' × ' + d.viewport[1]],
          ['Errors since start', String(d.errors.length)]]));
        U.clear(errBox);
        if (d.errors.length) { var ul = h('ul.k-list'); d.errors.slice(-10).forEach(function (e) { ul.appendChild(h('li.mono.k-small', { text: e.where + (e.code ? ' [' + e.code + ']' : '') + ': ' + e.message })); }); errBox.appendChild(ul); }
      });
    }
    function drawAi() {
      var A = g.LnpAI; U.clear(aiBox);
      if (!A || !A.usage) { aiBox.appendChild(h('p.k-hint', { text: 'The AI module is not included in this data package.' })); return; }
      var u = A.usage(), log = (u.log || []).slice(-40).reverse();
      aiBox.appendChild(K.stats([['Calls in this session', U.num(u.calls), u.failed ? u.failed + ' failed' : 'none failed'], ['Retries', U.num(u.repairs), 'after an invalid response'], ['Sent', U.bytes(u.bytesIn), 'text to Claude'], ['Received', U.bytes(u.bytesOut), null]]));
      if (!log.length) { aiBox.appendChild(h('p.k-hint', { text: 'Nothing has been sent to Claude in this session yet. Search and structure search never send anything; only the FTO analysis, the AI search and \u201cExplain claim\u201d call Claude. The log covers the current session and is not saved.' })); return; }
      var tb = h('tbody');
      log.forEach(function (e) { tb.appendChild(h('tr', null, h('td.mono', { text: new Date(e.t).toLocaleTimeString('en-GB') }), h('td', { text: (e.label || '') + (e.repair ? ' (retry)' : '') }), h('td', { text: e.tierApplied || e.tier || '' }), h('td.num', { text: U.bytes(e.bytesIn) }), h('td.num', { text: U.bytes(e.bytesOut) }), h('td.num', { text: U.num(e.ms) + ' ms' }), h('td', null, h('span.pill.' + (e.ok ? 'good' : 'crit'), { text: e.ok ? 'ok' : (e.code || 'Error') })))); });
      aiBox.appendChild(h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['Time', 'Step', 'Model tier', 'sent', 'received', 'Duration', 'Result'].map(function (t) { return h('th', { text: t }); }))), tb)));
    }

    /* ---------------------------------------------------------- self-test */
    function runTests() {
      testBtn.disabled = true; App.chemUsed = true;
      var tests = [
        ['Patent lookup', function () { return D.patent(0).then(function (p) { return D.byPn(U.pnPretty(p.pn)).then(function (i) { if (i < 0) throw { message: p.pn + ' not found' }; return D.patent(i).then(function (q) { if (q.appNo !== p.appNo) throw { message: 'wrong publication' }; return U.pnPretty(p.pn) + ' found via the formatted number'; }); }); }); }],
        ['Full-text search', function () { return S.search('"lipid nanoparticle" AND cholesterol', { limit: 5 }).then(function (r) { if (!(r.total > 0) || !r.hits.length) throw { message: 'no hits for a standard query' }; if (!r.hits[0].best || !r.hits[0].best.snippet) throw { message: 'hit without a text passage' }; return U.num(r.total) + ' hits, text passage present'; }); }],
        ['Filter and count', function () { return S.search('', { filters: { auth: ['EP'] }, limit: 1, snippets: false }).then(function (r) { if (c.ep != null && r.total !== c.ep) throw { message: r.total + ' EP publications counted, the manifest says ' + c.ep }; return U.num(r.total) + ' EP publications, as in the manifest'; }); }],
        ['Exact structure (DLin-MC3-DMA)', function () { return Ch.search({ query: 'DLin-MC3-DMA', mode: 'exact', limit: 5 }).then(function (r) { if (!r.length) throw { message: 'MC3 not found' }; return r[0].id + ' in ' + r[0].nPat + ' publications'; }); }],
        ['Substructure (dimethylaminobutyrate)', function () { return Ch.search({ query: 'CN(C)CCCC(=O)OC', mode: 'sub', limit: 5 }).then(function (r) { if (!(r.total > 0)) throw { message: 'no hit' }; return U.num(r.total) + ' compounds'; }); }],
        ['Similarity (ALC-0315, from 0.70)', function () { return Ch.search({ query: 'ALC-0315', mode: 'sim', minSim: 0.7, limit: 5 }).then(function (r) { if (!r.length) throw { message: 'no hit' }; if (!(r[0].sim >= 0.99)) throw { message: 'best hit only ' + r[0].sim }; return U.num(r.total) + ' compounds, best hit ' + Math.round(r[0].sim * 100) + '%'; }); }],
        ['Storage: write, read, delete', function () { var v = { t: Date.now(), s: 'äöü ✓' }; return St.put('settings', 'selftest', v).then(function () { return St.get('settings', 'selftest'); }).then(function (r) { if (!r || r.t !== v.t || r.s !== v.s) throw { message: 'value read back differs' }; return St.remove('settings', 'selftest'); }).then(function () { return St.get('settings', 'selftest'); }).then(function (r) { if (r != null) throw { message: 'entry still present after deletion' }; return 'Storage type: ' + ({ db: 'artifact database', local: 'browser storage', memory: 'session only' }[St.diag().backend] || St.diag().backend); }); }],
        ['Claude reachable', function () { var A = g.LnpAI; if (!A) return Promise.resolve({ skip: 'AI module not in the data package' }); return Promise.resolve(A.init()).then(function (ok) { return ok ? 'available (no call sent)' : { skip: 'not available; search and structure search work without Claude' }; }); }]
      ];
      var rows = tests.map(function (t) { var li = h('li', { data: { s: 'wait' } }, h('span.st', { text: 'waiting' }), h('span.k-steps-t', { text: t[0] }), h('span.info')); return li; });
      var summary = h('p.k-sub', { id: 'sys-test-result', 'aria-live': 'polite', text: 'Test running …' });
      U.set(testBox, h('ol.k-steps', null, rows), summary);
      var pass = 0, fail = 0, skip = 0;
      tests.reduce(function (p, t, i) {
        return p.then(function () {
          if (dead) return;
          var li = rows[i], t0 = performance.now(); li.dataset.s = 'run'; li.children[0].textContent = 'running';
          return Promise.resolve().then(t[1]).then(function (msg) {
            var ms = Math.round(performance.now() - t0);
            if (msg && msg.skip) { skip++; li.dataset.s = 'wait'; li.children[0].textContent = 'skipped'; li.children[2].textContent = msg.skip; }
            else { pass++; li.dataset.s = 'ok'; li.children[0].textContent = 'passed'; li.children[2].textContent = msg + ' · ' + U.num(ms) + ' ms'; }
          }, function (e) { fail++; li.dataset.s = 'err'; li.children[0].textContent = 'failed'; li.children[2].textContent = U.errText(e); });
        });
      }, Promise.resolve()).then(function () {
        if (dead) return;
        testBtn.disabled = false;
        summary.textContent = fail ? fail + ' of ' + tests.length + ' checks failed. The diagnostics below help with troubleshooting.' : pass + ' checks passed' + (skip ? ', ' + skip + ' skipped' : '') + '.';
        summary.dataset.ok = fail ? '0' : '1';
        drawEngines(); drawAi();
      });
    }

    /* ---------------------------------------------------------- limits and method */
    var P = g.LnpFtoPrompts, limText = null;
    try { limText = P && P.limits ? P.limits('en', snap.ep_register ? U.date(snap.ep_register) : null) : null; } catch (e) { limText = null; }
    var limBox = h('aside.k-limits', { id: 'sys-limits' }, (limText ? String(limText).split('\n') : ['Limits of this tool'].concat(LIMITS_FALLBACK)).filter(function (l) { return l.trim(); }).map(function (l, i) { return h(i === 0 ? 'p.k-limits-t' : 'p', { text: l }); }));
    var method = h('div.k-prose', null,
      h('p', { text: 'The dataset is built outside the page from freely accessible sources: SureChEMBL defines the field and supplies the structures; the EPO and the USPTO supply bibliography, claim texts and legal status. A list of known key families ensures that the central LNP patents are included.' }),
      h('p', { text: 'Text search is a word index over claims, titles and abstracts with Boolean operators, phrases and proximity search; the ranking weights independent claims higher. Structure search compares fingerprints and checks substructures with OpenChemLib. Both run entirely in the browser; no query leaves the device.' }),
      h('p', { text: 'The FTO check works in fixed steps: candidates via structure, claim text and key families; legal status and target market; triage of the independent claims; feature analysis per publication with a verbatim quotation for each feature; dependent claims; counter-check from the patent holder\'s point of view; summary. Only these steps send text to Claude.' }),
      h('p', { text: 'What the page calculates itself and never leaves to the model: every quotation must appear verbatim in the claim, otherwise the feature counts as not substantiated. The result for a claim follows from its features. A claim with a formula that exists only as an image is at most \u201cpossible\u201d. The risk is never lower than the less favourable result of analysis and counter-check. Equivalence is noted as a question for the law firm and not decided.' }));

    var page = h('div.page.k-page', null,
      K.head('System', 'Data status,', 'diagnostics and limits', 'What is in the data package, how old it is, how the page is currently working and what it cannot do.'),
      K.sec('Dataset', 'What is included', null, facts, covBox),
      K.sec('Gaps', 'What is missing', null, gaps, h('h3.k-h3', { text: 'Size of the data package: ' + (M.totalBytes ? U.bytes(M.totalBytes) + ' in ' + M.nFiles + ' files' : 'unknown') + (cut.budgetMb ? ' (limit ' + U.num(cut.budgetMb) + ' MB)' : '') }), h('p.k-note', { text: 'Figures in kB.' }), sizeBox),
      K.sec('Sources', 'Data status', null, stale, sources),
      K.sec('Self-test', 'Is everything working?', testBtn, h('p.k-note', { text: 'Checks lookup, full-text search, three structure searches and storage with known queries. This loads the structure data (about 19 MB). Nothing is sent to Claude.' }), testBox),
      K.sec('Runtime', 'How the page is working', h('span.k-row', null, h('button.btn.sm', { type: 'button', onclick: function () { U.copy(JSON.stringify(App.diag(), null, 1), 'Diagnostics copied'); } }, U.icon('copy'), 'Copy diagnostics'), h('button.btn.sm', { type: 'button', onclick: function () { App.shortcuts(); } }, U.icon('help'), 'Keyboard shortcuts')), engBox, errBox),
      K.sec('Claude', 'Usage in this session', null, aiBox),
      K.sec('Limits', 'What this tool is not', null, limBox),
      K.sec('Method', 'How the results are produced', null, method));
    host.appendChild(page);
    coverage(); drawEngines(); drawAi();
    var offAi = g.LnpAI && g.LnpAI.onUsage ? g.LnpAI.onUsage(function () { if (!dead) drawAi(); }) : null;
    var offCaps = App.on('caps', function () { if (!dead) drawEngines(); });
    if (R.list(route.params.x).indexOf('test') >= 0) runTests();
    return { update: function (r) { if (R.list(r.params.x).indexOf('test') >= 0) runTests(); return true; }, destroy: function () { dead = true; offCaps(); if (typeof offAi === 'function') offAi(); K.tip.hide(); } };
  }
  g.LnpApp.registerView({ id: 'system', title: 'System', icon: 'system', mount: g.LnpLazyView('system', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });
})(window);
