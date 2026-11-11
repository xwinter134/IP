/* LNP Patent Desk: compound library screen. Route: #screen[-<saved id>]
   Paste or load a list of compounds (SMILES, reference lipid names, SCHEMBL numbers; one per line or CSV/TSV) and screen
   every compound against the structure data: exact, similar and substructure hits, the publications they sit in, claim
   and status flags, and the Markush check where a translated formula exists (engine x-screen.js). No model is involved.
   Every text from patents or from the input list is shown with textContent only.
   Also registers the compound-dialog button "Add to screen" when the shell offers LnpApp.ext.compoundAction. */
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

  var PAGE = 50;
  var FLAG = { 4: ['Exact, in claims, granted', 'crit'], 3: ['Exact, in claims', 'crit'], 2: ['Similar, in claims', 'warn'], 1: ['Hit, not in claims', 'info'], 0: ['No hit', 'hollow'] };
  var ROUTE = { exact: 'exact', sim: 'similar', sub: 'substructure', markush: 'Markush claim' };
  var EXAMPLE_NAMES = ['ALC-0315', 'SM-102', 'MC3'];

  /* ---------------------------------------------------------- hand-over from the compound dialog */
  function inboxAdd(hit) {
    var S = g.LnpStore;
    if (!S || !hit || !hit.smiles) return Promise.resolve(0);
    return Promise.resolve(S.get('settings', 'screen-inbox')).then(function (d) {
      var items = d && Array.isArray(d.items) ? d.items : [];
      if (!items.some(function (x) { return x.smiles === hit.smiles; })) items.push({ id: String(hit.id || ''), smiles: String(hit.smiles) });
      return S.put('settings', 'screen-inbox', { items: items.slice(0, 500) }).then(function () { return items.length; });
    });
  }
  if (g.LnpApp && g.LnpApp.ext && typeof g.LnpApp.ext.compoundAction === 'function') {
    g.LnpApp.ext.compoundAction(function (hit) {
      if (!hit || !hit.smiles) return null;
      return h('button.btn.sm', { type: 'button', title: 'Add this compound to the list of the library screen', onclick: function () {
        inboxAdd(hit).then(function (n) { U.toast(n ? 'Added to the library screen (' + n + ' waiting). Open the Library screen to run it.' : 'Could not add the compound', n ? { action: { label: 'Open', run: function () { R.go('#screen'); } } } : { error: true }); },
          function (e) { U.toast('Could not add the compound: ' + U.errText(e), { error: true }); });
      } }, U.icon('structure'), 'Add to screen');
    });
  }

  function mount(host, route, App) {
    var K = g.LnpKit, Ch = g.LnpChem, Sc = g.LnpScreen, Mk = g.LnpMarkush;
    var dead = false, rows = [], parseInfo = null, results = [], runInfo = null, savedId = '', savedName = '', savedAt = '', stored = false;
    var ctl = null, running = false, resolveSeq = 0, renderTimer = 0, shown = PAGE, expanded = new Set();
    var st = { modes: { exact: true, sim: true, sub: false }, minSim: 80, markush: true, onlyClaims: false, onlyForce: false, flag: '', sort: 'flag' };
    App.chemUsed = true;

    /* ---------------------------------------------------------- skeleton */
    var ta = h('textarea.textarea.mono.sc-ta', { id: 'sc-input', rows: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: 'One compound per line: SMILES, a reference lipid name (ALC-0315, SM-102, MC3), a SCHEMBL number\nor CSV / TSV with a header (id, name, smiles) \u2013 up to ' + U.num(Sc.MAX_ROWS) + ' rows', 'aria-label': 'List of compounds' });
    var fileBtn = h('button.btn', { type: 'button', id: 'sc-file', onclick: function () { K.pickFile('.csv,.tsv,.txt,.smi').then(function (t) { ta.value = t; onInput(); }, function (e) { if (e && e.code !== 'cancelled') U.toast(U.errText(e), { error: true }); }); } }, U.icon('rows'), 'Load file');
    var exBtn = h('button.btn.quiet', { type: 'button', id: 'sc-example', onclick: function () { ta.value = EXAMPLE_NAMES.join('\n'); onInput(); } }, 'Insert example');
    var clrBtn = h('button.btn.quiet', { type: 'button', id: 'sc-clear', onclick: function () { ta.value = ''; savedId = ''; savedName = ''; stored = false; results = []; runInfo = null; onInput(); drawResults(); if (route.arg) R.go('#screen', { silent: true }); } }, 'Clear');
    var preview = h('div.sc-preview', { 'aria-live': 'polite' });

    function chk(id, label, key, hint) {
      var c = h('input.chk', { type: 'checkbox', id: id, checked: !!st.modes[key], onchange: function () { st.modes[key] = c.checked; if (!Object.keys(st.modes).some(function (k) { return st.modes[k]; })) { st.modes.exact = true; sync(); } drawOptHint(); } });
      return h('label.k-check', { 'for': id, title: hint || null }, c, label);
    }
    var simIn = h('input', { id: 'sc-sim', type: 'range', min: '50', max: '100', step: '5', value: String(st.minSim) }), simOut = h('output.mono', { 'for': 'sc-sim' });
    simIn.addEventListener('input', function () { st.minSim = Number(simIn.value); simOut.textContent = (st.minSim / 100).toFixed(2); });
    var mkChk = h('input.chk', { type: 'checkbox', id: 'sc-mk', checked: true, onchange: function () { st.markush = mkChk.checked; } });
    var optHint = h('p.k-hint');
    var opts = h('div.sc-opts', { role: 'group', 'aria-label': 'Screen options' },
      h('div.k-checks', null, chk('sc-m-exact', 'Exact (and stereo variants)', 'exact', 'The same structure'), chk('sc-m-sim', 'Similar', 'sim', 'Tanimoto similarity of the count fingerprint'), chk('sc-m-sub', 'Substructure (slow)', 'sub', 'Compounds that contain the input as a substructure')),
      h('div.k-slider', null, h('label', { 'for': 'sc-sim', text: 'Minimum similarity' }), simIn, simOut),
      h('label.k-check', { 'for': 'sc-mk', title: 'Checks the compound against curated and saved Markush records and queues formula claims without a record' }, mkChk, 'Markush check'),
      optHint);
    var runBtn = h('button.btn.primary', { type: 'button', id: 'sc-run', onclick: function () { startRun(); } }, U.icon('search'), 'Run screen');
    var cancelBtn = h('button.btn', { type: 'button', id: 'sc-cancel', hidden: true, onclick: function () { if (ctl) ctl.abort(); } }, U.icon('x'), 'Cancel');
    var bar = h('div.sc-bar', { hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span')), progText = h('p.k-sub.sc-prog', { 'aria-live': 'polite' });

    var statsBox = h('div'), filterBox = h('div'), listBox = h('div.sc-list'), moreBox = h('div.k-more'), actions = h('div.k-row.sc-actions'), savedBox = h('div');
    var limits = h('details.k-fold.sc-limits', { open: true }, h('summary', null, U.icon('help'), h('span', { text: 'Limits of this screen' })), h('div.k-fold-body.k-prose', null));

    var page = h('div.page.k-page.sc-page', null,
      K.head('Library screen', 'Screen a compound library', 'against the patent corpus', 'Paste a list or load a file. Every compound is matched against the structures found in the publications of the dataset, and the publications are flagged by claim hit and legal status. This is a pre-screening, not legal advice.'),
      K.sec('Input', 'Compounds', null, h('div.sc-inrow', null, ta), h('div.k-row', null, fileBtn, exBtn, clrBtn, h('span.k-hint', { text: 'CSV, TSV, .smi or .txt; up to 5 MB' })), preview),
      K.sec('Options', 'What to look for', null, opts, h('div.k-row', null, runBtn, cancelBtn), bar, progText),
      savedBox,
      K.sec('Results', 'Screen results', actions, statsBox, filterBox, listBox, moreBox),
      limits);
    host.appendChild(page);

    /* ---------------------------------------------------------- helpers */
    function sync() { ['exact', 'sim', 'sub'].forEach(function (k) { var c = document.getElementById('sc-m-' + k); if (c) c.checked = !!st.modes[k]; }); simIn.value = String(st.minSim); simOut.textContent = (st.minSim / 100).toFixed(2); mkChk.checked = st.markush; drawOptHint(); }
    function drawOptHint() {
      var n = (App.manifest.counts || {}).compounds;
      U.set(optHint, st.modes.sub ? 'Substructure search scans ' + U.num(n) + ' compounds for every input compound and takes seconds per compound. Use it for a few compounds.' : (Mk ? '' : 'The Markush engine is not part of this build; the Markush check is skipped.'));
      optHint.hidden = !optHint.textContent;
      if (!Mk) { mkChk.checked = false; mkChk.disabled = true; st.markush = false; }
    }
    function modes() { return ['exact', 'sim', 'sub'].filter(function (k) { return st.modes[k]; }); }
    function snapshot() { return Sc.snapshotText(); }
    function pill(level) { var f = FLAG[level] || FLAG[0]; return h('span.pill.' + f[1], { text: f[0], title: level === 0 ? 'No structure match found. This does not mean the compound is free to use: generic claims are not searched by structure.' : 'Structure match from the SureChEMBL extraction; not a claim analysis' }); }
    function mkHref(pn, claim) { return R.build({ view: 'markush', arg: pn, params: { c: String(claim) } }); }
    function hitHref(id) { return R.build({ view: 'struktur', arg: '', params: { c: id } }); }
    function mkPill(m) {
      if (!m) return h('span.faint', { text: '\u2013' });
      if (m.covered.length) return h('span.pill.crit', { text: 'covered (' + m.covered.length + ')', title: 'A Markush record covers this compound under the translated formula' });
      if (m.unclear.length) return h('span.pill.warn', { text: 'unclear (' + m.unclear.length + ')' });
      if (m.queue.length) return h('span.pill.hollow', { text: m.queue.length + ' to translate', title: 'Formula claims in the hit publications that have no Markush record yet' });
      return h('span.faint', { text: m.checked ? 'not covered' : '\u2013' });
    }

    /* ---------------------------------------------------------- input and preview */
    var onInput = U.debounce(function () { parseNow(); }, 250);
    ta.addEventListener('input', onInput);
    function parseNow() {
      var my = ++resolveSeq;
      parseInfo = Sc.parseInput(ta.value);
      rows = parseInfo.slice();
      stored = false;
      drawPreview(false);
      if (!rows.length) return;
      if (Ch) Sc.resolve(rows).then(function () { if (my === resolveSeq && !dead) drawPreview(true); }, function () { /* the run reports engine errors */ });
    }
    function drawPreview(resolved) {
      if (!rows.length) { U.set(preview, parseInfo && parseInfo.total === 0 ? h('p.k-hint', { text: 'No compounds yet.' }) : null); return; }
      var bad = rows.filter(function (r) { return r.error; }), box = h('div.sc-pv');
      box.appendChild(h('p.k-sub', null, h('b', { text: K.plural(rows.length, 'row', 'rows') }), ' read' + (parseInfo.header ? ' (header found)' : '') + (resolved ? ' \u00b7 ' + (rows.length - bad.length) + ' recognised as structures' : ' \u00b7 checking structures \u2026') + (bad.length ? ' \u00b7 ' + K.plural(bad.length, 'row with an error', 'rows with errors') : '')));
      (parseInfo.notes || []).forEach(function (t) { box.appendChild(h('p.notice', { text: t })); });
      var show = rows.slice(0, 6), tb = h('tbody');
      show.forEach(function (r) {
        tb.appendChild(h('tr', { 'class': r.error ? 'sc-bad' : null }, h('td.mono', { text: String(r.row) }), h('td', null, r.parsed ? K.mol(r.parsed.smiles, 100, 48, '') : null),
          h('td.sc-id', { text: r.id }), h('td.mono.sc-in', { text: r.input }), h('td', { text: r.error ? r.error : r.parsed ? (r.parsed.name || r.parsed.id || r.parsed.formula || 'ok') : '' })));
      });
      box.appendChild(h('div.table-wrap.sc-pvt', null, h('table.data', null, h('thead', null, h('tr', null, ['Row', 'Structure', 'Id', 'Input', 'State'].map(function (t) { return h('th', { text: t }); }))), tb)));
      if (rows.length > show.length) box.appendChild(h('p.k-hint', { text: 'Showing the first ' + show.length + ' of ' + U.num(rows.length) + ' rows.' }));
      var rest = bad.filter(function (r) { return show.indexOf(r) < 0; }).slice(0, 8);
      if (rest.length) box.appendChild(h('ul.sc-errs', null, rest.map(function (r) { return h('li', null, h('span.mono', { text: 'row ' + r.row }), ' ', h('span', { text: r.error + (r.input ? ': ' + r.input.slice(0, 60) : '') })); })));
      U.set(preview, box);
    }

    /* ---------------------------------------------------------- run */
    function startRun() {
      if (running) return;
      if (!ta.value.trim() && !rows.length) { U.toast('Paste or load a list of compounds first', { error: true }); return; }
      parseInfo = Sc.parseInput(ta.value); rows = parseInfo.slice(); stored = false;
      if (!rows.length) { U.toast('No compounds found in the input', { error: true }); drawPreview(false); return; }
      drawPreview(false);
      var o = { modes: modes(), minSim: st.minSim / 100, markush: st.markush };
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      running = true; results = []; expanded.clear(); shown = PAGE;
      runBtn.disabled = true; cancelBtn.hidden = false; bar.hidden = false; bar.firstChild.style.width = '0%'; ta.readOnly = true;
      runInfo = { started: Date.now(), total: rows.length, opts: o, finished: null, cancelled: false, snapshot: snapshot() };
      U.set(progText, K.busy('Loading the structure data \u2026'));
      drawResults();
      var t0 = Date.now(), runRows = rows;
      Sc.run(runRows, Object.assign({}, o, { signal: ctl ? ctl.signal : undefined,
        onProgress: function (ev) {
          if (dead) return;
          var pct = ev.total ? Math.round(100 * ev.done / ev.total) : 0;
          bar.firstChild.style.width = pct + '%'; bar.setAttribute('aria-valuenow', String(pct));
          U.set(progText, K.busy(ev.done + ' of ' + ev.total + ' compounds' + (ev.phase === 'compound' && ev.row ? ' \u00b7 ' + (ev.row.id || ev.row.input || '').slice(0, 40) : '')));
        },
        onResult: function (r, i) { results[i] = r; if (!renderTimer) renderTimer = setTimeout(function () { renderTimer = 0; if (!dead) drawResults(); }, 400); } })).then(function (res) {
        if (dead) return;
        results = res.slice(); runInfo.finished = Date.now(); runInfo.cancelled = !!res.cancelled; runInfo.ms = Date.now() - t0;
        endRun();
        U.set(progText, h('p.k-sub', null, res.cancelled ? 'Cancelled after ' + res.length + ' of ' + runRows.length + ' compounds.' : 'Done: ' + K.plural(res.length, 'compound', 'compounds') + ' in ' + (runInfo.ms / 1000).toFixed(1) + ' s.'));
      }, function (e) {
        if (dead) return;
        endRun(); U.set(progText, K.errBox(e, 'The screen failed'));
      });
    }
    function endRun() {
      running = false; ctl = null; runBtn.disabled = false; cancelBtn.hidden = true; bar.hidden = true; ta.readOnly = false;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      drawResults();
    }

    /* ---------------------------------------------------------- results */
    function filtered() {
      var list = results.filter(Boolean);
      return list.filter(function (r) {
        if (st.flag === 'invalid') return !r.ok;
        if (st.flag === 'nohit') return r.ok && r.flags && r.flags.level === 0;
        if (st.flag === 'markush') return !!(r.markush && (r.markush.covered.length || r.markush.unclear.length || r.markush.queue.length));
        if (st.onlyClaims && !(r.flags && (r.flags.inClaimsExact || r.flags.inClaimsSim))) return false;
        if (st.onlyForce && !(r.flags && r.flags.grantedInForce)) return false;
        return true;
      }).sort(function (a, b) {
        if (st.sort === 'row') return a.row - b.row;
        var la = a.flags ? a.flags.level : -1, lb = b.flags ? b.flags.level : -1;
        return lb - la || ((b.patents && b.patents.length) || 0) - ((a.patents && a.patents.length) || 0) || a.row - b.row;
      });
    }
    function drawStats() {
      var s = Sc.summary(results.filter(Boolean));
      U.set(statsBox, K.stats([['Compounds', U.num(s.n), s.invalid ? s.invalid + ' invalid' : null], ['With a hit', U.num(s.parsed - s.noHit), s.noHit + ' without'],
        ['Exact in claims', U.num(s.inClaimsExact)], ['Similar in claims', U.num(s.inClaimsSim)], ['Granted, in force', U.num(s.grantedInForce), 'in the claims'],
        ['Markush covered', U.num(s.markushCovered), s.markushUnclear ? s.markushUnclear + ' unclear' : null], ['Markush queue', U.num(s.queueClaims), 'formula claims'], ['Publications', U.num(s.patents)]]));
    }
    function drawFilters() {
      function sel(id, label, opts, val, cb) { var s = h('select.select', { id: id, 'aria-label': label, onchange: function () { cb(s.value); } }); opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1], selected: o[0] === val })); }); return h('div.k-filter', null, h('span.k-filters-l', { text: label }), s); }
      var c1 = h('input.chk', { type: 'checkbox', id: 'sc-f-claims', checked: st.onlyClaims, onchange: function () { st.onlyClaims = c1.checked; shown = PAGE; drawList(); } });
      var c2 = h('input.chk', { type: 'checkbox', id: 'sc-f-force', checked: st.onlyForce, onchange: function () { st.onlyForce = c2.checked; shown = PAGE; drawList(); } });
      U.set(filterBox, h('div.k-filters', { role: 'group', 'aria-label': 'Filter the results' },
        h('label.k-check', { 'for': 'sc-f-claims' }, c1, 'only hits in claims'), h('label.k-check', { 'for': 'sc-f-force' }, c2, 'only granted and in force'),
        sel('sc-f-show', 'Show', [['', 'all compounds'], ['markush', 'with Markush state'], ['nohit', 'without a hit'], ['invalid', 'invalid input']], st.flag, function (v) { st.flag = v; shown = PAGE; drawList(); }),
        sel('sc-f-sort', 'Sort', [['flag', 'worst flag first'], ['row', 'input order']], st.sort, function (v) { st.sort = v; drawList(); })));
    }
    function drawActions() {
      var has = results.filter(Boolean).length > 0 && !running;
      U.set(actions,
        h('button.btn', { type: 'button', id: 'sc-csv', disabled: !has, onclick: exportCsv }, U.icon('download'), 'Export CSV'),
        h('button.btn', { type: 'button', id: 'sc-save', disabled: !has && !rows.length, onclick: saveRun }, U.icon('save'), savedId ? 'Save changes' : 'Save run'));
    }
    function exportCsv() {
      var csv = Sc.toCsv(results.filter(Boolean), {});
      U.saveFile('lnp-library-screen-' + K.fileStamp() + '.csv', csv, 'text/csv;charset=utf-8');
    }
    function saveRun() {
      var inp = h('input.input', { type: 'text', id: 'sc-name', value: savedName || 'Screen ' + K.fileStamp(), maxlength: '120', 'aria-label': 'Name of the saved screen' });
      var body = h('div.sc-savedlg', null, h('p.k-hint', { text: 'Saves the list and the options' + (results.length ? ' and, when small enough, the results' : '') + '. Results of larger runs are recomputed when the screen is opened.' }), inp,
        h('div.k-row', null, h('button.btn.primary', { type: 'button', id: 'sc-save-ok', onclick: function () { go(); } }, 'Save'), h('button.btn', { type: 'button', onclick: function () { d.close(); } }, 'Cancel')));
      var d = U.dialog('Save screen', body, {});
      setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { /* no focus */ } }, 30);
      function go() {
        var name = inp.value.trim() || 'Screen';
        Sc.save({ id: savedId || undefined, name: name, rows: rows, opts: runInfo ? runInfo.opts : { modes: modes(), minSim: st.minSim / 100, markush: st.markush }, results: results.filter(Boolean).length && !running ? results.filter(Boolean) : null, created: savedAt || undefined })
          .then(function (v) { savedId = v.id; savedName = v.name; savedAt = v.created; d.close(); U.toast('Screen saved'); R.go({ view: 'screen', arg: v.id }, { silent: true }); drawSaved(); },
            function (e) { U.toast('Could not save: ' + U.errText(e), { error: true }); });
      }
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
    }

    function patentRow(e, r) {
      var tr = h('tr', null,
        h('td', { 'data-l': 'Publication' }, K.patentLink(e.pn, App)),
        h('td', { 'data-l': 'Match' }, h('span.sc-tags', null, e.routes.map(function (x) { return h('span.tag', { text: ROUTE[x] + (x === 'sim' && e.sim != null ? ' ' + Math.round(e.sim * 100) + '%' : '') }); }))),
        h('td', { 'data-l': 'Found in' }, h('span.cmpd-w', null, K.whereTags(e.where))),
        h('td', { 'data-l': 'Status' }, e.status == null ? h('span.faint', { text: 'not in table' }) : U.statusPill(e.status)),
        h('td.mono', { 'data-l': 'Expiry (estimate)', text: K.expiryText({ exp: e.exp }) }),
        h('td', { 'data-l': 'Markush' }, markushFor(r, e.pn)));
      return tr;
    }
    function markushFor(r, pn) {
      var m = r.markush;
      if (!m) return h('span.faint', { text: '\u2013' });
      var out = [];
      m.covered.filter(function (x) { return x.pn === pn; }).forEach(function (x) { out.push(h('a.pill.crit.sc-mk', { href: mkHref(x.pn, x.claim), text: 'covered, claim ' + x.claim, title: 'Open the Markush check' })); });
      m.unclear.filter(function (x) { return x.pn === pn; }).forEach(function (x) { out.push(h('a.pill.warn.sc-mk', { href: mkHref(x.pn, x.claim), text: 'unclear, claim ' + x.claim })); });
      m.queue.filter(function (x) { return x.pn === pn; }).forEach(function (x) { out.push(h('a.pill.hollow.sc-mk', { href: mkHref(x.pn, x.claim), text: 'queue, claim ' + x.claim, title: 'The formula of this claim has no Markush record yet. Open it to translate it.' })); });
      return out.length ? h('span.sc-tags', null, out) : h('span.faint', { text: '\u2013' });
    }
    function detail(r) {
      var box = h('div.sc-detail');
      if (!r.ok) { box.appendChild(h('p.notice.err', { text: r.error || 'invalid input' })); return box; }
      var f = r.flags || {};
      var hl = h('div.sc-hits');
      function hitLine(label, list, total) {
        if (!list.length && !total) return;
        hl.appendChild(h('div.sc-hitgrp', null, h('span.k-filters-l', { text: label }), h('span.sc-hitlist', null, list.slice(0, 6).map(function (x) {
          return h('a.mono.sc-hit', { href: hitHref(x.id), title: (x.formula || '') + ' \u00b7 ' + (x.nPat || 0) + ' publications in the dataset, ' + (x.nPatGlobal != null ? x.nPatGlobal + ' in SureChEMBL' : ''), text: x.id + (x.sim != null && x.match !== 'exact' ? ' ' + Math.round(x.sim * 100) + '%' : '') + (x.match === 'stereo-variant' ? ' (stereo)' : '') });
        }), total > list.length ? h('span.k-hint', { text: ' \u2026 ' + U.num(total) + ' in total' }) : null)));
      }
      hitLine('Exact', r.exact, r.exact.length); hitLine('Similar', r.sim, r.simTotal || r.sim.length); hitLine('Substructure', r.sub.hits, r.sub.total);
      if (hl.firstChild) box.appendChild(hl);
      if (f.commodity) box.appendChild(h('p.k-hint', { text: 'This compound appears in very many publications (' + U.num(Math.max.apply(null, r.exact.map(function (x) { return x.nPatGlobal || 0; }))) + ' in SureChEMBL): a common building block. Hits say little about LNP-specific claims.' }));
      if (r.duplicateOf) box.appendChild(h('p.k-hint', { text: 'The same structure as the input in row ' + r.duplicateOf + '.' }));
      if (r.patents.length) {
        var tb = h('tbody'), cap = 60;
        r.patents.slice(0, cap).forEach(function (e) { tb.appendChild(patentRow(e, r)); });
        box.appendChild(h('div.table-wrap.sc-pt', null, h('table.data.sc-ptab', null, h('thead', null, h('tr', null, ['Publication', 'Match', 'Found in', 'Status', 'Expiry (estimate)', 'Markush'].map(function (t) { return h('th', { text: t }); }))), tb)));
        if (r.patents.length > cap) box.appendChild(h('p.k-hint', { text: 'Showing ' + cap + ' of ' + U.num(r.patents.length) + ' publications; the CSV export lists all.' }));
        box.appendChild(h('p.k-hint', { text: 'Order: claims hits first, then exact before similar, then granted and in force. \u201cFound in\u201d is where SureChEMBL recognised the structure; it is not evidence that a claim protects the compound.' }));
      } else box.appendChild(h('p.k-sub', { text: 'No publication of the dataset contains this structure or a similar one at the chosen settings.' }));
      var m = r.markush;
      if (m) {
        var mk = h('div.sc-mkbox', null, h('p.k-filters-l', { text: 'Markush check' }),
          h('p.k-sub', { text: m.checked ? m.checked + ' formula claim' + (m.checked === 1 ? '' : 's') + ' checked against records: ' + m.covered.length + ' covered, ' + m.unclear.length + ' unclear, ' + (m.notCovered || 0) + ' not covered. ' + (m.queue.length ? m.queue.length + ' formula claim' + (m.queue.length === 1 ? '' : 's') + ' in the hit publications without a record (queue).' : '') : (m.queue.length ? m.queue.length + ' formula claim' + (m.queue.length === 1 ? '' : 's') + ' in the hit publications without a record (queue).' : 'No Markush record and no formula claim in the hit publications.') }));
        if (m.covered.length || m.unclear.length) mk.appendChild(h('p.sc-tags', null, m.covered.map(function (x) { return h('a.pill.crit.sc-mk', { href: mkHref(x.pn, x.claim), text: 'covered: ' + U.pnPretty(x.pn) + ' claim ' + x.claim + (x.caveat ? ' (translation not reviewed)' : ''), title: 'Open the Markush check' }); })
          .concat(m.unclear.slice(0, 10).map(function (x) { return h('a.pill.warn.sc-mk', { href: mkHref(x.pn, x.claim), text: 'unclear: ' + U.pnPretty(x.pn) + ' claim ' + x.claim, title: x.why || '' }); }))));
        if (m.queue.length) mk.appendChild(h('p.sc-tags', null, m.queue.slice(0, 12).map(function (x) { return h('a.pill.hollow.sc-mk', { href: mkHref(x.pn, x.claim), text: U.pnPretty(x.pn) + ' claim ' + x.claim }); })));
        if (m.error) mk.appendChild(h('p.notice.err', { text: 'The Markush check failed: ' + m.error }));
        box.appendChild(mk);
      }
      return box;
    }
    function resultRow(r, i) {
      var f = r.flags, open = expanded.has(r.row + ':' + i), id = 'sc-d-' + r.row;
      var btn = h('button.btn.quiet.sm.sc-exp', { type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, 'aria-label': 'Details of ' + r.id, onclick: function () {
        var k = r.row + ':' + i; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); drawList(); } }, U.icon('back', open ? 'sc-ic-d' : 'sc-ic-r'));
      var cnt = function (n, extra) { return h('td.num', { 'data-l': extra }, n ? h('b', { text: U.num(n) }) : h('span.faint', { text: '0' })); };
      var tr = h('tr.sc-row' + (r.ok ? '' : '.sc-invalid'), { 'data-row': String(r.row), 'data-level': f ? String(f.level) : 'x' },
        h('td.sc-c0', { 'data-l': '#' }, btn, h('span.mono.sc-rn', { text: String(r.row) })),
        h('td.sc-c1', { 'data-l': 'Compound' }, h('div.sc-cmp', null, r.parsed ? K.mol(r.parsed.smiles, 130, 62, '') : h('div.k-mol.sc-nomol', { style: { height: '62px' } }, h('span.faint.mono', { text: 'invalid' })),
          h('div.sc-cn', null, h('div.sc-cname', { text: r.name || r.id }), r.name && r.id !== r.name ? h('div.mono.k-hint', { text: r.id }) : null, h('div.mono.k-hint.sc-smi', { text: r.parsed ? r.parsed.smiles : r.input.slice(0, 80) })))),
        r.ok ? cnt(r.exact.length, 'Exact') : h('td.num', { 'data-l': 'Exact' }, h('span.faint', { text: '\u2013' })),
        r.ok ? cnt(r.simTotal != null ? r.simTotal : r.sim.length, 'Similar') : h('td.num', { 'data-l': 'Similar' }, h('span.faint', { text: '\u2013' })),
        r.ok ? cnt(r.sub.total, 'Substructure') : h('td.num', { 'data-l': 'Substructure' }, h('span.faint', { text: '\u2013' })),
        r.ok ? cnt(r.patents.length, 'Publications') : h('td.num', { 'data-l': 'Publications' }, h('span.faint', { text: '\u2013' })),
        h('td.sc-flag', { 'data-l': 'Flag' }, r.ok ? h('span.sc-tags', null, pill(f ? f.level : 0), f && f.commodity ? h('span.tag', { text: 'commodity', title: 'Appears in very many publications' }) : null) : h('span.pill.crit', { text: 'invalid input', title: r.error || '' })),
        h('td.sc-mkc', { 'data-l': 'Markush' }, r.ok ? mkPill(r.markush) : null));
      var out = [tr];
      if (open) { var dt = h('tr.sc-detail-row', null, h('td', { colspan: '8', id: id }, detail(r))); out.push(dt); }
      return out;
    }
    function drawList() {
      var list = filtered(), tb = h('tbody'), total = results.filter(Boolean).length;
      drawActions(); drawFilters();
      if (!total) {
        U.set(listBox, running ? null : h('p.k-sub', { text: 'No results yet. Paste a list above and run the screen.' })); U.clear(moreBox); return;
      }
      list.slice(0, shown).forEach(function (r, i) { resultRow(r, i).forEach(function (n) { tb.appendChild(n); }); });
      var head = ['', 'Compound', 'Exact', 'Similar', 'Substructure', 'Publications', 'Flag', 'Markush'];
      U.set(listBox, h('p.k-sub', null, h('b', { text: K.plural(list.length, 'compound', 'compounds') }), list.length !== total ? ' of ' + U.num(total) + ' (filtered)' : '', ' \u00b7 corpus snapshot ' + snapshot()),
        list.length ? h('div.table-wrap.sc-tw', null, h('table.data.sc-table', null, h('thead', null, h('tr', null, head.map(function (t) { return h('th', { text: t }); }))), tb)) : h('div.empty', null, h('h3', { text: 'Nothing matches the filters' }), h('p', { text: 'Change or reset the filters above.' })));
      U.clear(moreBox);
      if (list.length > shown) moreBox.appendChild(h('button.btn', { type: 'button', id: 'sc-more', onclick: function () { shown += PAGE; drawList(); } }, 'Show ' + Math.min(PAGE, list.length - shown) + ' more'));
    }
    function drawResults() {
      var any = results.filter(Boolean).length;
      drawStats(); statsBox.hidden = !any; drawList();
      if (stored && any) U.add(listBox, h('p.notice', { text: 'These are the stored results of the saved screen (' + U.date((savedAt || '').slice(0, 10)) + '). Run the screen again to refresh hits, status and Markush state.' }));
    }

    /* ---------------------------------------------------------- saved screens */
    function drawSaved() {
      Sc.list().then(function (l) {
        if (dead) return;
        if (!l.length) { U.clear(savedBox); return; }
        U.set(savedBox, K.sec('Saved', 'Saved screens', null, h('ul.sc-saved', null, l.map(function (v) {
          return h('li', { 'data-id': v.id }, h('a.sc-sname', { href: R.build({ view: 'screen', arg: v.id }), text: v.name }),
            h('span.k-hint', { text: K.plural(v.rows.length, 'compound', 'compounds') + ' \u00b7 ' + U.date((v.updated || '').slice(0, 10)) + (v.summary ? ' \u00b7 ' + v.summary.inClaimsExact + ' exact in claims' : '') }),
            h('button.btn.quiet.sm', { type: 'button', 'aria-label': 'Delete ' + v.name, onclick: function () { Sc.remove(v.id).then(function () { if (savedId === v.id) { savedId = ''; savedName = ''; } drawSaved(); }); } }, U.icon('x'), 'Delete'));
        }))));
      }, function () { /* the list is optional */ });
    }
    function openSaved(id) {
      return Sc.load(id).then(function (v) {
        if (dead) return;
        if (!v || !Array.isArray(v.rows)) { U.set(preview, h('p.notice.err', { text: 'This saved screen no longer exists.' })); return; }
        savedId = v.id; savedName = v.name; savedAt = v.created || '';
        ta.value = v.rows.map(function (r) { return r.input; }).join('\n');
        // keep ids and names of the saved rows: re-parse the stored input, then restore row identity
        parseInfo = Sc.parseInput(ta.value); rows = parseInfo.map(function (r, i) { var s = v.rows[i]; if (s) { r.id = s.id || r.id; r.name = s.name || r.name; } return r; });
        if (v.opts) { ['exact', 'sim', 'sub'].forEach(function (k) { st.modes[k] = (v.opts.modes || []).indexOf(k) >= 0; }); st.minSim = Math.round((v.opts.minSim || 0.8) * 100); st.markush = v.opts.markush !== false; sync(); }
        drawPreview(false);
        if (Ch) Sc.resolve(rows).then(function () { if (!dead) drawPreview(true); }, function () { });
        if (v.results && v.results.length) { results = v.results; stored = true; runInfo = { opts: v.opts, snapshot: v.snapshot }; drawResults(); }
        else if (!st.modes.sub) startRun();
      }, function (e) { U.set(preview, K.errBox(e, 'The saved screen could not be opened')); });
    }

    /* ---------------------------------------------------------- limits */
    function drawLimits() {
      var body = limits.querySelector('.k-fold-body'); U.clear(body);
      var l = Sc.limits(); l.forEach(function (t) { body.appendChild(h('p', { text: t })); });
      body.appendChild(h('p', null, 'Generic claims are better checked with the ', h('a', { href: '#fto', text: 'FTO analysis' }), ' and the Markush check (', h('a', { href: '#markush', text: 'queue' }), ').'));
    }

    /* ---------------------------------------------------------- start */
    sync(); drawLimits(); drawSaved(); drawResults();
    function takeInbox() {
      if (!g.LnpStore) return Promise.resolve();
      return Promise.resolve(g.LnpStore.get('settings', 'screen-inbox')).then(function (d) {
        var items = d && Array.isArray(d.items) ? d.items : [];
        if (!items.length || dead) return;
        var cur = ta.value.trim();
        ta.value = (cur ? cur + '\n' : '') + items.map(function (x) { return x.smiles + (x.id ? ' ' + x.id : ''); }).join('\n');
        parseNow();
        return g.LnpStore.put('settings', 'screen-inbox', { items: [] });
      }).then(null, function () { });
    }
    if (route.arg) openSaved(route.arg); else takeInbox();

    return {
      update: function (r) {
        if (r.arg && r.arg !== savedId && !running) openSaved(r.arg);
        return true;
      },
      destroy: function () {
        dead = true; resolveSeq++;
        if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
        if (renderTimer) clearTimeout(renderTimer);
      }
    };
  }
  g.LnpApp.registerView({ id: 'screen', title: 'Library screen', icon: 'structure', rail: false, parent: 'tools', mount: g.LnpLazyView('screen', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
