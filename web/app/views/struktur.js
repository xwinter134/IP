/* LNP Patent Desk: structure search. Route: #struktur[-<query>][--m<exact|sub|sim|scaffold>][--t<min similarity %>][--n<pn>][--c<SCHEMBL id>][--f<filters>][--s<sort>]
   query = SMILES, reference lipid name or SCHEMBL number; n restricts to one publication; c opens the compound;
   f = list of tl<min>-<max> (longest tail), nt<n> (tails), es<n> (esters), am<class> (amine), cl1 (found in claims). */
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

  var MODES = [['sim', 'Similarity', 'Compounds with a similar fingerprint (Tanimoto), also with a different tail length'], ['exact', 'Exact', 'The same structure and its stereo variants'],
    ['sub', 'Substructure', 'All compounds that contain the drawn structure'], ['scaffold', 'Scaffold', 'Same head group, linker and branching with any tails']];
  var ROLE = { ionizable: 'ionizable', cationic: 'cationic', helper: 'helper lipid', sterol: 'sterol', peg: 'PEG lipid' };
  var SORTS = [['sim', 'Similarity'], ['claims', 'Matches in claims'], ['patents', 'Number of publications'], ['mw', 'Molar mass']];
  var PAGE = 48;

  function mount(host, route, App) {
    var K = g.LnpKit, Ch = g.LnpChem, D = g.LnpData;
    var st = { q: '', m: 'sim', t: 70, n: '', c: '', tl: [0, 0], nt: '', es: '', am: '', cl: false, s: 'sim' };
    var dead = false, seq = 0, ctl = null, editor = null, editorWanted = false, hits = null, shown = 0, sel = new Map(), dlg = null, dlgFor = '', quietEditor = false;
    App.chemUsed = true;

    /* ---------------------------------------------------------- state <-> route */
    function fromRoute(r) {
      var p = r.params, f = R.list(p.f);
      st.q = r.arg || ''; st.m = MODES.some(function (x) { return x[0] === p.m; }) ? p.m : 'sim';
      st.t = Math.max(30, Math.min(100, parseInt(p.t, 10) || 70)); st.n = p.n ? String(p.n) : ''; st.c = p.c ? String(p.c) : '';
      st.s = SORTS.some(function (x) { return x[0] === p.s; }) ? p.s : 'sim';
      st.tl = [0, 0]; st.nt = ''; st.es = ''; st.am = ''; st.cl = false;
      f.forEach(function (x) {
        var m;
        if ((m = /^tl(\d*)-(\d*)$/.exec(x))) st.tl = [Number(m[1]) || 0, Number(m[2]) || 0];
        else if ((m = /^nt(\d)$/.exec(x))) st.nt = m[1];
        else if ((m = /^es(\d)$/.exec(x))) st.es = m[1];
        else if ((m = /^am([a-z]+)$/.exec(x)) && K.AMINE[m[1]]) st.am = m[1];
        else if (x === 'cl1') st.cl = true;
      });
    }
    function toRoute(extra) {
      var f = [];
      if (st.tl[0] || st.tl[1]) f.push('tl' + (st.tl[0] || '') + '-' + (st.tl[1] || ''));
      if (st.nt) f.push('nt' + st.nt); if (st.es !== '') f.push('es' + st.es); if (st.am) f.push('am' + st.am); if (st.cl) f.push('cl1');
      var p = { m: st.m === 'sim' ? '' : st.m, t: st.m === 'sim' && st.t !== 70 ? String(st.t) : '', n: st.n, c: st.c, f: f, s: st.s === 'sim' ? '' : st.s };
      return { view: 'struktur', arg: st.q, params: Object.assign(p, extra || {}) };
    }
    function push(replace) { R.go(toRoute(), { silent: true, replace: !!replace }); }
    function chemFilters() {
      var f = {};
      if (st.tl[0] || st.tl[1]) f.tailLen = [st.tl[0] || 0, st.tl[1] || 99];
      if (st.nt) f.nTails = st.nt === '4' ? [4, 99] : Number(st.nt);
      if (st.es !== '') f.ester = st.es === '3' ? [3, 99] : Number(st.es);
      if (st.am) f.amine = st.am;
      if (st.cl) f.inClaims = true;
      if (st.n) f.pns = [st.n];
      return f;
    }
    function hasFilters() { return !!(st.tl[0] || st.tl[1] || st.nt || st.es !== '' || st.am || st.cl); }

    /* ---------------------------------------------------------- skeleton */
    var qIn = h('input.input.mono', { id: 'st-q', type: 'text', placeholder: 'SMILES, name (MC3, ALC-0315 …) or SCHEMBL number', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Structure as SMILES, name or SCHEMBL number' });
    var goBtn = h('button.btn.primary', { type: 'submit' }, U.icon('search'), 'Search');
    var form = h('form.k-qrow', { onsubmit: function (ev) { ev.preventDefault(); st.q = qIn.value.trim(); st.c = ''; push(); run(); } }, qIn, goBtn);
    var examples = h('div.k-chips', { 'aria-label': 'Reference lipids as examples' });
    var modeSeg = h('div.seg', { role: 'group', 'aria-label': 'Search type' });
    var simIn = h('input', { id: 'st-sim', type: 'range', min: '30', max: '100', step: '5' }), simOut = h('output.mono', { 'for': 'st-sim' });
    var simRow = h('div.k-slider', null, h('label', { 'for': 'st-sim', text: 'Minimum similarity' }), simIn, simOut);
    var preview = h('div.k-preview');
    var edHost = h('div.k-editor'), edState = h('p.k-hint', { text: 'The editor loads when opened.' });
    var edFold = h('details.k-fold', { id: 'st-edfold' }, h('summary', null, U.icon('structure'), h('span', { text: 'Draw structure' })), h('div.k-fold-body', null, edHost, h('div.k-row', null, edState, h('button.btn.sm', { type: 'button', onclick: function () { if (editor) editor.clear(); qIn.value = ''; drawPreview(''); } }, 'Clear'))));
    edFold.addEventListener('toggle', function () { if (edFold.open) openEditor(); });
    var scopeNote = h('div');
    var tlMin = h('input.input.k-num', { id: 'st-tlmin', type: 'number', min: '6', max: '40', placeholder: 'from', 'aria-label': 'Longest tail, minimum carbon atoms' }), tlMax = h('input.input.k-num', { id: 'st-tlmax', type: 'number', min: '6', max: '40', placeholder: 'to', 'aria-label': 'Longest tail, maximum carbon atoms' });
    function sel2(id, label, opts) { var s = h('select.select', { id: id, 'aria-label': label }); opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); }); return s; }
    var ntSel = sel2('st-nt', 'Number of tails', [['', 'any'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4 or more']]);
    var esSel = sel2('st-es', 'Number of esters', [['', 'any'], ['0', 'none'], ['1', '1'], ['2', '2'], ['3', '3 or more']]);
    var amSel = sel2('st-am', 'Type of amine', [['', 'any'], ['tertiary', 'tertiary (ionizable)'], ['secondary', 'secondary'], ['primary', 'primary'], ['quaternary', 'quaternary (permanently cationic)'], ['amide', 'Amide']]);
    var clChk = h('input.chk', { id: 'st-cl', type: 'checkbox' });
    var sortSel = sel2('st-sort', 'Sort order', SORTS);
    var resetBtn = h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.tl = [0, 0]; st.nt = ''; st.es = ''; st.am = ''; st.cl = false; syncControls(); push(); run(); } }, 'Reset filters');
    function fl(label, node) { return h('div.k-filter', null, h('span.k-filters-l', { text: label }), node); }
    var filterBar = h('div.k-filters', { role: 'group', 'aria-label': 'Filter by lipid features' },
      fl('Longest tail (C)', h('span.k-pair', null, tlMin, tlMax)), fl('Tails', ntSel), fl('Esters', esSel), fl('Amine', amSel),
      h('label.k-check', { 'for': 'st-cl' }, clChk, 'only with a match in claims'), fl('Sort', sortSel), resetBtn);
    var status = h('div.k-status', { 'aria-live': 'polite' }), grid = h('div.k-cgrid'), more = h('div.k-more');
    var selbar = h('div.selbar', { hidden: true });
    var markush = h('details.k-fold.k-limit', null, h('summary', null, U.icon('help'), h('span', { text: 'Limit of structure search: only individually disclosed compounds' })),
      h('div.k-fold-body.k-prose', null,
        h('p', { text: 'The search finds compounds that appear in a publication as a specific structure: examples, tables, named compounds (source: SureChEMBL). \u201cClaims\u201d means the structure was recognised in the claim text. This is an indication, not proof that the claim protects the compound.' }),
        h('p', { text: 'Generic claims with Markush formulae (\u201cR1 and R2 are independently C6\u2013C24 alkyl\u201d) also cover compounds that are not named individually anywhere. A structure search cannot return such hits. No hit therefore does not mean that a lipid is free to use.' }),
        h('p', null, 'For generic claims there are two routes: the ', h('a', { href: '#suche', text: 'claim search' }), ' in the text of the independent claims and the ', h('a', { href: '#fto', text: 'FTO analysis' }), ', which checks the formula of a claim variable by variable against your own lipid. A Markush search in a specialist database replaces neither.')));
    var page = h('div.page.k-page', null,
      K.head('Structure search', 'Find lipids by structure,', 'exact, substructure or similar', 'The search runs in the browser over ' + U.num((App.manifest.counts || {}).compounds) + ' compounds from the publications in the dataset. The results are the compounds and the publications they appear in.'),
      h('div.k-struct', null,
        h('div.k-struct-q', null, form, examples, h('div.k-row', null, modeSeg, simRow), scopeNote, preview),
        edFold),
      filterBar, markush, status, grid, more);
    host.appendChild(page); host.appendChild(selbar);

    MODES.forEach(function (m) { modeSeg.appendChild(h('button', { type: 'button', title: m[2], data: { m: m[0] }, onclick: function () { st.m = m[0]; st.c = ''; syncControls(); push(); if (st.q) run(); } }, m[1])); });
    simIn.addEventListener('input', function () { st.t = Number(simIn.value); simOut.textContent = (st.t / 100).toFixed(2); });
    simIn.addEventListener('change', function () { push(true); if (st.q) run(); });
    var filt = U.debounce(function () {
      st.tl = [Math.max(0, parseInt(tlMin.value, 10) || 0), Math.max(0, parseInt(tlMax.value, 10) || 0)]; st.nt = ntSel.value; st.es = esSel.value; st.am = amSel.value; st.cl = clChk.checked; st.s = sortSel.value;
      resetBtn.hidden = !hasFilters(); push(true); run();
    }, 250);
    [tlMin, tlMax].forEach(function (el) { el.addEventListener('input', filt); });
    [ntSel, esSel, amSel, clChk, sortSel].forEach(function (el) { el.addEventListener('change', filt); });

    function syncControls() {
      qIn.value = st.q;
      Array.prototype.forEach.call(modeSeg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.m === st.m ? 'true' : 'false'); });
      simRow.hidden = st.m !== 'sim'; simIn.value = String(st.t); simOut.textContent = (st.t / 100).toFixed(2);
      tlMin.value = st.tl[0] || ''; tlMax.value = st.tl[1] || ''; ntSel.value = st.nt; esSel.value = st.es; amSel.value = st.am; clChk.checked = st.cl; sortSel.value = st.s;
      resetBtn.hidden = !hasFilters();
      U.clear(scopeNote);
      if (st.n) scopeNote.appendChild(h('p.k-scope', null, 'Restricted to publication ', K.patentLink(st.n, App), ' ', h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.n = ''; syncControls(); push(); run(); } }, U.icon('x'), 'Remove restriction')));
    }

    /* ---------------------------------------------------------- editor (loaded when opened) */
    function openEditor() {
      if (editor || editorWanted) return;
      editorWanted = true; edState.textContent = 'Loading editor …';
      Ch.editor(edHost, { smiles: '', onChange: U.debounce(function (s) {
        if (quietEditor || dead) return;
        if (s && !s.empty) { qIn.value = s.smiles; drawPreview(s.smiles); edState.textContent = 'Drawn structure applied. \u201cSearch\u201d starts the search.'; }
      }, 300) }).then(function (ed) {
        if (dead) { ed.destroy(); return; }
        editor = ed; edState.textContent = 'Drawing updates the search field. For substructures, the fragment is enough.';
        setEditor(lastSmiles);
      }, function (e) { editorWanted = false; edState.textContent = 'The editor could not be loaded: ' + U.errText(e); });
    }
    var lastSmiles = '';
    function setEditor(smiles) {
      lastSmiles = smiles || '';
      if (!editor) return;
      quietEditor = true;
      try { editor.setSmiles(lastSmiles); } catch (e) { /* the editor keeps its content */ }
      setTimeout(function () { quietEditor = false; }, 400);
    }

    /* ---------------------------------------------------------- query preview */
    var prevSeq = 0;
    function drawPreview(q) {
      var my = ++prevSeq;
      if (!q) { U.clear(preview); return; }
      Ch.parse(q).then(function (p) {
        if (my !== prevSeq || dead) return;
        if (!p || !p.ok) { U.set(preview, h('p.notice.err', { text: 'The input was not recognised as a structure' + (p && p.error ? ': ' + p.error : '') + '. Accepted are SMILES, the name of a reference lipid or a SCHEMBL number.' })); return; }
        var info = h('div.k-preview-info', null, h('p.k-sub', { text: (p.name ? p.name + ' · ' : p.id ? p.id + ' · ' : '') + (p.formula || '') + (p.mw ? ' · ' + U.num(Math.round(p.mw * 10) / 10) + ' g/mol' : '') }));
        U.set(preview, h('div.k-preview-box', null, K.mol(p.smiles || q, 260, 130, p.formula), info));
        if (p.kind !== 'smarts') Ch.descriptors(p.smiles || q).then(function (d) { if (my === prevSeq && !dead) info.appendChild(K.descList(d)); }, function () { });
      }, function (e) { if (my === prevSeq && !dead) U.set(preview, K.errBox(e)); });
    }

    /* ---------------------------------------------------------- examples */
    Ch.names().then(function (names) {
      if (dead) return;
      names.forEach(function (n) {
        examples.appendChild(h('button.chip', { type: 'button', title: (ROLE[n.role] || n.role || '') + (n.c < 0 ? ', not in dataset' : ''), onclick: function () { st.q = n.name; st.c = ''; syncControls(); push(); run(); } }, n.name));
      });
      if (!st.q && !st.n) drawStart(names);
    }, function (e) { U.set(examples, K.errBox(e, 'The structure data could not be loaded')); });

    /* ---------------------------------------------------------- cards */
    function card(x, opt) {
      opt = opt || {};
      var d = K.desc(x.desc), simTxt = x.sim != null ? Math.round(x.sim * 100) + '%' : '';
      var badge = x.match === 'exact' ? 'exact' : x.match === 'stereo-variant' ? 'stereo variant' : simTxt;
      var b = h('button.k-card', { type: 'button', 'aria-label': (opt.title || x.id) + (badge ? ', ' + badge : '') + ', ' + (x.nPat || 0) + ' publications', onclick: function () { if (opt.onClick) opt.onClick(); else openCompound(x.id); } },
        h('div.k-card-top', null, h('span.k-card-id.mono', { text: opt.title || x.id }), badge ? h('span.k-card-sim.mono', { text: badge, title: x.sim != null ? 'Tanimoto similarity of the count fingerprint' : null }) : null),
        K.mol(x.c != null && x.c >= 0 ? x.c : x.smiles, 220, 104, x.formula),
        opt.sub ? h('p.k-card-sub', { text: opt.sub }) : null,
        x.desc ? h('p.k-card-desc', { text: (d.nTails ? (d.nTails === 1 ? '1 tail: ' : d.nTails + ' tails: ') + d.tails.map(K.tailText).join(', ') : 'no tail from C6') }) : null,
        x.desc ? h('p.k-card-desc', { text: [K.headLabel(d.head), K.amineLabel(d.amine), d.ester ? d.ester + ' ester(s)' : ''].filter(Boolean).join(' · ') }) : null,
        x.nPat != null ? h('div.k-card-foot', null, h('span.mono', { text: K.plural(x.nPat, 'publication', 'publications') + (x.nClaims ? ', ' + x.nClaims + ' in claims' : '') }), h('span.cmpd-w', null, K.whereTags(x.where))) : null);
      return b;
    }
    function drawStart(names) {
      hits = null; U.clear(more);
      U.set(status, h('p.k-sub', { text: 'Reference lipids to start with. One click searches for similar compounds in the dataset.' }));
      U.clear(grid);
      names.forEach(function (n) {
        grid.appendChild(card({ id: n.name, c: n.c, smiles: n.smiles, formula: '' }, { title: n.name, sub: (ROLE[n.role] || n.role || '') + (n.c < 0 ? ' · not in dataset' : ''), onClick: function () { st.q = n.name; st.c = ''; syncControls(); push(); run(); } }));
      });
    }
    function drawMore() {
      U.clear(more);
      if (!hits) return;
      var end = Math.min(hits.length, shown + PAGE);
      for (var i = shown; i < end; i++) grid.appendChild(card(hits[i]));
      shown = end;
      if (shown < hits.length) more.appendChild(h('button.btn', { type: 'button', onclick: drawMore }, 'Show ' + Math.min(PAGE, hits.length - shown) + ' more'));
      else if (hits.total > hits.length) more.appendChild(h('p.k-sub', { text: 'Showing the best ' + U.num(hits.length) + ' of ' + U.num(hits.total) + ' hits. Filters or a higher minimum similarity narrow the list.' }));
    }

    /* ---------------------------------------------------------- search */
    function run() {
      var my = ++seq;
      if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      drawPreview(st.q);
      if (!st.q) {
        hits = null; U.clear(more);
        if (st.n) return listPublication(my);
        return Ch.names().then(function (n) { if (my === seq && !dead) drawStart(n); }, function () { });
      }
      U.set(status, K.busy(st.m === 'sub' ? 'Substructure search running' : 'Search running'));
      grid.setAttribute('aria-busy', 'true');
      var t0 = Date.now();
      return Ch.parse(st.q).then(function (p) {
        if (my !== seq || dead) return null;
        if (!p || !p.ok) throw { code: 'bad_query', message: 'The input was not recognised as a structure. Accepted are SMILES, the name of a reference lipid or a SCHEMBL number.' };
        if (p.smiles && p.kind !== 'smarts') setEditor(p.smiles);
        return Ch.search({ query: st.q, mode: st.m, minSim: st.t / 100, limit: 240, filters: chemFilters(), sort: st.s, maxPatents: 0, signal: ctl ? ctl.signal : undefined,
          onProgress: function (ev) { if (my === seq && !dead && ev && ev.phase === 'scan' && ev.total) U.set(status, K.busy('Substructure search: ' + U.num(ev.done) + ' of ' + U.num(ev.total) + ' checked, ' + U.num(ev.found || 0) + ' hits')); } });
      }).then(function (res) {
        if (my !== seq || dead || !res) return;
        grid.removeAttribute('aria-busy');
        hits = res; shown = 0; U.clear(grid);
        var modeName = MODES.filter(function (x) { return x[0] === st.m; })[0][1];
        U.set(status, h('p.k-sub', null, h('b', { text: K.plural(res.total != null ? res.total : res.length, 'compound', 'compounds') }), ' · ' + modeName + (st.m === 'sim' ? ' from ' + (st.t / 100).toFixed(2) : '') + (hasFilters() ? ' · filtered' : '') + ' · ' + U.num(res.ms != null ? Math.round(res.ms) : Date.now() - t0) + ' ms'));
        if (!res.length) {
          grid.appendChild(h('div.empty', null, h('h3', { text: 'No compound found' }),
            h('p', { text: st.m === 'exact' ? 'This structure does not appear as an individual compound in any publication in the dataset. The similarity search shows the nearest neighbours.' : st.m === 'sim' ? 'No compound reaches the minimum similarity' + (hasFilters() ? ' with these filters' : '') + '. A lower value shows more distant neighbours.' : 'There is no hit for this input' + (hasFilters() ? ' and these filters' : '') + '.' }),
            h('p', { text: 'No hit does not mean the lipid is free to use: structure search does not capture generic claims.' }),
            st.m !== 'sim' ? h('p', null, h('button.btn', { type: 'button', onclick: function () { st.m = 'sim'; syncControls(); push(); run(); } }, 'Search similar compounds')) : null));
          return;
        }
        drawMore();
        if (st.c) openCompound(st.c, true);
      }).catch(function (e) {
        if (my !== seq || dead || (e && e.code === 'cancelled')) return;
        grid.removeAttribute('aria-busy'); hits = null; U.clear(grid); U.clear(more);
        U.set(status, K.errBox(e, 'The search failed'));
      });
    }
    function listPublication(my) {
      U.set(status, K.busy('Loading compounds of the publication'));
      return Ch.compoundsOf(st.n, 240).then(function (list) {
        if (my !== seq || dead) return;
        hits = list; hits.total = list.total; shown = 0; U.clear(grid);
        U.set(status, h('p.k-sub', null, h('b', { text: K.plural(list.total != null ? list.total : list.length, 'compound', 'compounds') }), ' in ', K.patentLink(st.n, App), ' · matches in claims first'));
        if (!list.length) grid.appendChild(h('div.empty', null, h('h3', { text: 'No structures for this publication' }), h('p', { text: 'SureChEMBL recognised no lipid structure in this publication, or the publication is newer than the structure data.' })));
        else drawMore();
        if (st.c) openCompound(st.c, true);
      }, function (e) { if (my === seq && !dead) U.set(status, K.errBox(e, 'The compounds could not be loaded')); });
    }

    /* ---------------------------------------------------------- compound -> patents */
    function openCompound(id, fromRoute2) {
      if (dlg && dlgFor === id) return;
      if (dlg) { var d0 = dlg; dlg = null; d0.close(); }
      st.c = id; dlgFor = id; if (!fromRoute2) push();
      var body = h('div.k-cdlg', null, K.busy('Loading compound'));
      dlg = U.dialog('Compound ' + id, body, { onClose: function () { if (dlgFor === id) { dlg = null; dlgFor = ''; if (st.c === id) { st.c = ''; if (!dead) push(true); } } } });
      dlg.el.classList.add('k-wide');
      var my = id;
      Promise.resolve(Ch.compound(id)).then(function (x) {
        if (!x) throw { message: 'Compound ' + id + ' is not in this dataset.' };
        return Ch.patentsOf(x.c).then(function (pats) {
          var ps = pats.filter(function (p) { return p.p >= 0; }).map(function (p) { return p.p; });
          return D.patents(ps).then(function (rows) { var by = {}; rows.forEach(function (r) { by[r.p] = r; }); return { x: x, pats: pats, by: by }; });
        });
      }).then(function (r) {
        if (dead || dlgFor !== my) return;
        var x = r.x, today = U.today();
        var list = r.pats.map(function (p) { return { pn: p.pn, where: p.where, pt: r.by[p.p] || null }; });
        function rank(a) { return (a.where.clm ? 0 : 4) + (a.pt && K.inForce(a.pt, today) ? 0 : a.pt && a.pt.status === 'pending' ? 1 : 2); }
        list.sort(function (a, b) { return rank(a) - rank(b) || ((b.pt && b.pt.exp) || 0) - ((a.pt && a.pt.exp) || 0) || a.pn.localeCompare(b.pn); });
        var tb = h('tbody'), nClm = list.filter(function (a) { return a.where.clm; }).length, cap = 400;
        var fto = h('button.btn.primary', { type: 'button', onclick: function () { handOver(); } }, U.icon('fto'), 'Check FTO');
        function upd() { var n = sel.size; fto.disabled = !n; U.set(fto, U.icon('fto'), n ? 'Check FTO (' + n + ')' : 'Check FTO'); drawSelbar(); }
        list.slice(0, cap).forEach(function (a) {
          var cb = h('input.chk', { type: 'checkbox', checked: sel.has(a.pn), 'aria-label': 'Select ' + a.pn, onchange: function () { if (cb.checked) sel.set(a.pn, 1); else sel.delete(a.pn); upd(); } });
          a.cb = cb;
          tb.appendChild(h('tr', null, h('td', null, cb), h('td', null, K.patentLink(a.pn, App)), h('td', null, h('span.cmpd-w', null, K.whereTags(a.where))),
            h('td.t', { text: a.pt ? a.pt.title : 'not in the patent table' }), h('td', null, a.pt ? U.statusPill(a.pt.status) : null), h('td.mono', { text: K.expiryText(a.pt) })));
        });
        U.set(body,
          h('div.k-cdlg-top', null, K.mol(x.c, 420, 170, x.formula),
            h('div', null, h('p.k-sub', { text: (x.formula || '') + ' · ' + U.num(Math.round(x.mw * 10) / 10) + ' g/mol' }), K.descList(x.desc),
              h('p.k-hint', { text: 'In ' + K.plural(x.nPat, 'publication', 'publications') + ' in the dataset (' + K.plural(x.nFam, 'family', 'families') + '), ' + nClm + ' of them with a match in claims. Across SureChEMBL: ' + K.plural(x.nPatGlobal, 'publication', 'publications') + (x.nPatGlobal > 2000 ? ': a widely used standard compound.' : '.') }),
              h('div.k-row', null, h('button.btn.sm', { type: 'button', onclick: function () { var s = x.smiles; dlg.close(); st.q = s; st.m = 'sim'; st.c = ''; syncControls(); push(); run(); } }, 'Find similar'),
                h('button.btn.sm', { type: 'button', onclick: function () { var s = x.smiles; dlg.close(); st.q = s; st.m = 'scaffold'; st.c = ''; syncControls(); push(); run(); } }, 'Same scaffold'),
                h('button.btn.sm', { type: 'button', onclick: function () { U.copy(x.smiles, 'SMILES copied'); } }, U.icon('copy'), 'SMILES')))),
          h('div.k-row.k-between', null, h('h3.k-h3', { text: 'Publications with this compound' }),
            h('span.k-row', null, nClm ? h('button.btn.sm', { type: 'button', onclick: function () { list.slice(0, cap).forEach(function (a) { if (a.where.clm && a.pt && a.pt.auth !== 'WO') { sel.set(a.pn, 1); a.cb.checked = true; } }); upd(); } }, 'Select all with a match in claims') : null, fto)),
          h('p.k-hint', { text: 'Order: matches in claims first, then granted rights still in force, then later expiry. Expiry is an estimate.' }),
          h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['', 'Number', 'Location', 'Title', 'Legal status', 'Expiry'].map(function (t) { return h('th', { text: t }); }))), tb)),
          list.length > cap ? h('p.k-hint', { text: 'Showing ' + cap + ' of ' + U.num(list.length) + ' publications.' }) : null);
        upd();
      }).catch(function (e) { if (!dead && dlgFor === my) U.set(body, K.errBox(e)); });
    }
    function handOver() {
      var pns = Array.from(sel.keys());
      if (!pns.length) return;
      if (dlg) { var d0 = dlg; dlg = null; dlgFor = ''; st.c = ''; d0.close(); }
      App.handToFto(pns, { from: 'struktur', q: st.q });
    }
    function drawSelbar() {
      var n = sel.size;
      selbar.hidden = !n;
      if (!n) return;
      U.set(selbar, h('span.grow', { text: K.plural(n, 'publication', 'publications') + ' selected for the FTO check' }),
        h('button.btn', { type: 'button', onclick: function () { sel.clear(); drawSelbar(); } }, 'Clear selection'),
        h('button.btn.primary', { type: 'button', onclick: handOver }, U.icon('fto'), 'Check FTO'));
    }

    /* ---------------------------------------------------------- start */
    fromRoute(route); syncControls();
    try { if (g.matchMedia('(min-width: 1000px)').matches) edFold.open = true; } catch (e) { /* stays closed */ }
    if (st.q || st.n) run(); else if (st.c) openCompound(st.c, true);

    return {
      update: function (r) {
        var before = JSON.stringify([st.q, st.m, st.t, st.n, st.tl, st.nt, st.es, st.am, st.cl, st.s]), c0 = st.c;
        fromRoute(r); syncControls();
        if (JSON.stringify([st.q, st.m, st.t, st.n, st.tl, st.nt, st.es, st.am, st.cl, st.s]) !== before) run();
        else if (st.c && st.c !== c0) openCompound(st.c, true);
        else if (!st.c && dlg) { var d0 = dlg; dlg = null; dlgFor = ''; d0.close(); }
        return true;
      },
      destroy: function () {
        dead = true; seq++;
        if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
        if (editor) { try { editor.destroy(); } catch (e2) { /* ignore */ } }
        if (dlg) { var d0 = dlg; dlg = null; d0.close(); }
        if (selbar.parentNode) selbar.parentNode.removeChild(selbar);
      }
    };
  }
  g.LnpApp.registerView({ id: 'struktur', title: 'Structure', icon: 'structure', mount: g.LnpLazyView('struktur', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
