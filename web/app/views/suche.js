/* LNP Patent Desk: search view. Route: #suche[-<query>][--a..][--k..][--y..][--p..][--c..][--t..][--r..][--e..][--x..][--s..][--mai]
   a auth, k kinds, y [from, to] publication year, p player indexes, c CPC subclasses, t status codes, r tiers,
   e seed tiers, x switches (text, comp, img, de, indep, seed), s sort (date | expiry), m = "ai" (KI-Suche). */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  var PAGE = 30, MAX_BLOCKS = 400, EXPORT_MAX = 20000;
  var OPS = [
    ['AND', ' AND ', 'beide Begriffe'], ['OR', ' OR ', 'einer der Begriffe'], ['NOT', ' NOT ', 'ohne den Begriff'], ['"…"', '""', 'exakte Wortfolge', 1],
    ['NEAR/5', ' NEAR/5 ', 'höchstens 5 Wörter Abstand'], ['*', '*', 'Wortanfang'], ['( )', '()', 'Gruppe', 1],
    ['indep:', 'indep:', 'nur unabhängige Claims'], ['claims:', 'claims:', 'nur Claims'], ['title:', 'title:', 'nur Titel'], ['asg:', 'asg:', 'Anmelder'],
    ['same:( )', 'same:()', 'alles im selben Claim', 1], ['cpc:', 'cpc:', 'CPC-Klasse'], ['year:', 'year:', 'Jahr der Veröffentlichung'], ['player:', 'player:', 'Akteur'], ['status:', 'status:', 'Rechtsstand']
  ];
  var HELP = [
    ['lipid nanoparticle', 'beide Wörter, irgendwo im Patent (AND ist Standard)'],
    ['"ionizable lipid"', 'exakte Wortfolge innerhalb eines Claims'],
    ['pKa NEAR/8 lipid', 'höchstens 8 Wörter Abstand, im selben Claim'],
    ['cholest* OR sterol', 'Wortanfang; Alternativen'],
    ['lipid -siRNA', 'ohne den Begriff (auch NOT)'],
    ['same:(PEG "mol %")', 'alle Bedingungen im selben Claim'],
    ['indep:(molar ratio)', 'nur unabhängige Claims; ebenso dep: claims: title: abstract:'],
    ['asg:acuitas  player:Moderna', 'Anmelder (Wortanfang); zugeordneter Akteur'],
    ['cpc:A61K9/51  cpc:C07C|C07D', 'CPC-Präfix, Listen mit |'],
    ['year:2018-2022  prio:-2012  exp:2030-', 'Veröffentlichung, Priorität, Ablauf (Jahre)'],
    ['status:granted  inforce:1', 'Rechtsstand; in DE in Kraft'],
    ['pn:"EP 3 532 103"  fam:62025447', 'Nummer, Familie'],
    ['DLin-MC3-DMA  C12-200', 'Namen mit Bindestrich gelten als Wortfolge'],
    ['lang:de  text:1  compounds:1', 'deutsche Claims; nur Volltext; mit Strukturen']
  ];
  var EXAMPLES = ['"ionizable lipid" NEAR/10 pKa', 'indep:("molar ratio" cholesterol PEG)', 'player:Acuitas status:granted', 'cpc:A61K9/5123 year:2021-', 'DLin-MC3-DMA'];
  var TIER = { 0: 'nur Schlüsselliste', 1: 'Stufe 1 (Kern)', 2: 'Stufe 2', 3: 'Stufe 3', 4: 'Stufe 4 (Umfeld)', 5: 'nur Klassensuche' };
  var SWITCH = { text: 'Volltext vorhanden', comp: 'Strukturen vorhanden', img: 'Formelbild im Hauptanspruch', de: 'In DE in Kraft', indep: 'Nur unabhängige Claims durchsuchen', seed: 'Nur Schlüsselfamilien' };
  var FIELD = { title: 'Titel', abstract: 'Abstract', assignee: 'Anmelder' };

  function mount(host, route, App) {
    var D = g.LnpData, S = g.LnpSearch, M = App.manifest;
    var st = { q: '', a: [], k: [], y: [], p: [], c: [], t: [], r: [], e: [], x: [], s: '', m: '' };
    var seq = 0, res = null, blocks = [], io = null, ro = null, selected = new Map(), cur = -1, destroyed = false, aiCtl = null, openFacets = { t: 1, a: 1, p: 1, y: 1 };
    var density = 'comfortable'; try { density = g.localStorage.getItem('lnp.density') || density; } catch (e) { /* ignore */ }

    /* ---------------- skeleton */
    var qInput = h('input', { id: 'q', type: 'search', placeholder: 'Begriffe, "Wortfolgen", Felder wie indep: oder cpc:', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Suchanfrage', enterkeyhint: 'search' });
    var helpBtn = h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Suchsyntax', title: 'Suchsyntax', onclick: showHelp }, U.icon('help'));
    var aiBtn = h('button.btn', { type: 'button', id: 'ai-toggle', 'aria-pressed': 'false', onclick: toggleAi }, U.icon('spark'), h('span.lbl', { text: 'KI-Suche' }));
    var ops = h('div.q-ops', { role: 'group', 'aria-label': 'Operatoren' });
    OPS.forEach(function (o) { ops.appendChild(h('button.chip', { type: 'button', title: o[2], onclick: function () { insert(o[1], o[3]); } }, o[0])); });
    var warn = h('div.q-warn', { hidden: true });
    var count = h('div.s-count', { 'aria-live': 'polite' });
    var active = h('div.s-active');
    var sortSeg = h('div.seg', { role: 'group', 'aria-label': 'Sortierung' });
    [['', 'Relevanz'], ['date', 'Datum'], ['expiry', 'Ablauf']].forEach(function (s) { sortSeg.appendChild(h('button', { type: 'button', data: { s: s[0] }, onclick: function () { st.s = s[0]; commit(); } }, s[1])); });
    var densBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Dichte der Trefferliste', title: 'Dichte der Trefferliste', onclick: function () { setDensity(density === 'compact' ? 'comfortable' : 'compact'); } });
    var fToggle = h('button.btn.f-toggle', { type: 'button', 'aria-expanded': 'false', onclick: function () { var open = root.dataset.facets !== 'open'; root.dataset.facets = open ? 'open' : ''; fToggle.setAttribute('aria-expanded', String(open)); } }, U.icon('filter'), 'Filter');
    var saveBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Suche speichern', title: 'Suche speichern', onclick: saveSearch }, U.icon('save'));
    var savedBtn = h('button.btn', { type: 'button', title: 'Gespeicherte Suchen', 'aria-label': 'Gespeicherte Suchen', onclick: showSaved }, U.icon('rows'), h('span.lbl', { text: 'Gespeichert' }));
    var csvBtn = h('button.btn', { type: 'button', title: 'Trefferliste als CSV', 'aria-label': 'CSV-Export', onclick: exportCsv }, U.icon('download'), h('span.lbl', { text: 'CSV' }));
    var top = h('div.s-top', null,
      h('div.q-row', null, h('div.q-box', null, U.icon('search'), qInput, helpBtn), aiBtn),
      ops, warn,
      h('div.s-bar', null, count, fToggle, sortSeg, densBtn, saveBtn, savedBtn, csvBtn),
      active);
    var facets = h('aside.facets', { 'aria-label': 'Filter' });
    var results = h('div.results', { role: 'list', 'aria-label': 'Treffer' });
    var selbar = h('div.selbar', { hidden: true });
    var root = h('div.page.search', { data: { density: density } }, top, facets, h('div', { style: { 'min-width': '0' } }, results, selbar));
    host.appendChild(root);
    setDensity(density, true);

    try { ro = new ResizeObserver(function () { root.style.setProperty('--s-top-h', top.offsetHeight + 'px'); }); ro.observe(top); } catch (e) { /* older browsers keep the default */ }

    var live = U.debounce(function () { if (st.m === 'ai') return; st.q = qInput.value.trim(); commit(true); }, 170);
    qInput.addEventListener('input', live);
    qInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); live.cancel(); st.q = qInput.value.trim(); if (st.m === 'ai') { commit(true, true); runAi(); } else commit(true); }
      else if (ev.key === 'ArrowDown' && results.querySelector('.hrow')) { ev.preventDefault(); focusHit(0); }
    });
    var offKey = App.on('key', onKey), offMarks = App.on('marks', onMarks), offCaps = App.on('caps', drawAi);

    /* ---------------- state <-> route */
    function fromRoute(r) {
      var p = r.params || {};
      st.q = r.arg || '';
      ['a', 'k', 'y', 'p', 'c', 't', 'r', 'e', 'x'].forEach(function (k) { st[k] = R.list(p[k]); });
      st.s = typeof p.s === 'string' ? p.s : ''; st.m = p.m === 'ai' ? 'ai' : '';
      if (qInput.value.trim() !== st.q) qInput.value = st.q;
    }
    function toRoute() { return { view: 'suche', arg: st.q, params: { a: st.a, k: st.k, y: st.y, p: st.p, c: st.c, t: st.t, r: st.r, e: st.e, x: st.x, s: st.s, m: st.m } }; }
    function filters() {
      var f = {};
      if (st.a.length) f.auth = st.a.slice();
      if (st.k.length) f.kinds = st.k.slice();
      if (st.y[0]) f.yearFrom = +st.y[0];
      if (st.y[1] || st.y[0]) f.yearTo = +(st.y[1] || st.y[0]);
      if (st.p.length) f.players = st.p.map(function (i) { return M.players[+i]; }).filter(Boolean);
      if (st.c.length) f.cpc = st.c.slice();
      if (st.t.length) f.status = st.t.slice();
      if (st.r.length) f.tiers = st.r.map(Number);
      if (st.e.length) f.seedTiers = st.e.map(Number);
      if (st.x.indexOf('text') >= 0) f.textOnly = true;
      if (st.x.indexOf('comp') >= 0) f.hasCompounds = true;
      if (st.x.indexOf('img') >= 0) f.hasImg = true;
      if (st.x.indexOf('de') >= 0) f.deInForce = true;
      if (st.x.indexOf('indep') >= 0) f.indepOnly = true;
      if (st.x.indexOf('seed') >= 0) f.seedOnly = true;
      return f;
    }
    function nFilters() { return st.a.length + st.k.length + (st.y.length ? 1 : 0) + st.p.length + st.c.length + st.t.length + st.r.length + st.e.length + st.x.length; }
    function commit(typed, noRun) {
      R.go(toRoute(), { replace: true, silent: true });
      App.route = R.current();
      if (!noRun) { if (st.m === 'ai') drawAiIdle(); else run(); }
      drawBar();
    }
    function toggle(key, val) {
      var a = st[key], i = a.indexOf(String(val));
      if (i >= 0) a.splice(i, 1); else a.push(String(val));
      commit();
    }

    /* ---------------- search */
    // nothing asked yet: the start view lists the curated key families instead of 125k unordered publications
    function isStart() { return !st.q && !nFilters(); }
    function opts(extra) {
      var f = filters(); if (isStart()) f.seedOnly = true;
      return Object.assign({ filters: f, limit: PAGE, offset: 0, sort: st.s === 'date' || (!st.q && !st.s) ? 'date' : st.s === 'expiry' ? 'expiry' : 'score', group: 'family', facets: true, snippets: true, perHit: 3, snippetLength: 260 }, extra || {});
    }
    function run() {
      var my = ++seq, t0 = Date.now();
      if (aiCtl) { try { aiCtl.abort(); } catch (e) { /* ignore */ } aiCtl = null; }
      App.state.lastQuery = st.q;
      root.setAttribute('aria-busy', 'true');
      S.search(st.q, opts()).then(function (r) {
        if (my !== seq || destroyed) return;
        res = r; res.wall = Date.now() - t0;
        App.state.lastParsed = r.parsed || null;
        drawWarn(r.parsed && r.parsed.warnings);
        drawCount();
        drawResults(r);
        drawFacets(r.facets || {});
        root.removeAttribute('aria-busy');
        refineFacets(my);
      }, function (e) {
        if (my !== seq || destroyed) return;
        root.removeAttribute('aria-busy');
        res = null; teardownBlocks();
        U.set(count, 'Suche gescheitert');
        U.set(results, h('div.empty', null, h('p.overline', { text: 'Fehler' }), h('h3', { text: 'Die Suche konnte nicht ausgeführt werden' }), h('p', { text: U.errText(e) }),
          e && e.name ? h('p.mono', { text: 'Datei: ' + e.name + (e.status ? '  HTTP ' + e.status : '') }) : null));
        App.logError('search', e);
      });
    }
    // facet counts of a group with a selection are taken from a search without that group's filter,
    // so the other values stay selectable
    function refineFacets(my) {
      var groups = [['a', 'auth', 'auth'], ['k', 'kinds', 'kind'], ['p', 'players', 'player'], ['t', 'status', 'status'], ['r', 'tiers', 'tier'], ['e', 'seedTiers', 'seedTier'], ['c', 'cpc', 'cpc4'], ['y', null, 'year']];
      var jobs = groups.filter(function (x) { return st[x[0]].length; }).map(function (x) {
        var f = filters();
        if (x[1]) delete f[x[1]]; else { delete f.yearFrom; delete f.yearTo; }
        return S.search(st.q, { filters: f, limit: 1, facets: true, snippets: false, group: 'family' }).then(function (r) { return [x[2], (r.facets || {})[x[2]] || {}]; }, function () { return null; });
      });
      if (!jobs.length) return;
      Promise.all(jobs).then(function (rs) {
        if (my !== seq || destroyed || !res) return;
        var f = Object.assign({}, res.facets || {});
        rs.forEach(function (x) { if (x) f[x[0]] = x[1]; });
        drawFacets(f);
      });
    }
    function drawWarn(ws) {
      warn.hidden = !(ws && ws.length);
      if (ws && ws.length) warn.textContent = ws.map(function (w) { return w.message || w.code; }).join(' · ');
    }
    function drawCount() {
      if (!res) return;
      var fam = res.totalFamilies != null ? res.totalFamilies : res.total;
      U.set(count, h('b', { text: U.num(fam) }), ' ' + (fam === 1 ? 'Familie' : 'Familien') + ' · ', h('b', { text: U.num(res.total) }), ' ' + (res.total === 1 ? 'Patent' : 'Patente'),
        h('span.faint.mono', { text: '  ' + (res.ms != null ? Math.round(res.ms) : res.wall) + ' ms' }),
        isStart() ? h('span.faint', { text: '  \u00b7 Startansicht: Schl\u00fcsselfamilien. Eine Eingabe durchsucht alle ' + U.num(M.counts.patents) + ' Patente.' }) : null);
    }
    function drawBar() {
      var bs = sortSeg.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].dataset.s === st.s));
      U.clear(active);
      function chip(label, off) { active.appendChild(h('button.chip.on', { type: 'button', title: 'Filter entfernen', onclick: off }, label, h('span.x', { text: '×' }))); }
      st.t.forEach(function (v) { chip(U.statusLabel(v), function () { toggle('t', v); }); });
      st.a.forEach(function (v) { chip(v, function () { toggle('a', v); }); });
      st.k.forEach(function (v) { chip('Art ' + v, function () { toggle('k', v); }); });
      st.p.forEach(function (v) { chip(M.players[+v] || v, function () { toggle('p', v); }); });
      if (st.y.length) chip(st.y[0] + (st.y[1] && st.y[1] !== st.y[0] ? '–' + st.y[1] : ''), function () { st.y = []; commit(); });
      st.c.forEach(function (v) { chip('CPC ' + v, function () { toggle('c', v); }); });
      st.r.forEach(function (v) { chip(TIER[v] || 'Stufe ' + v, function () { toggle('r', v); }); });
      st.e.forEach(function (v) { chip('Schlüsselfamilie Stufe ' + v, function () { toggle('e', v); }); });
      st.x.forEach(function (v) { chip(SWITCH[v] || v, function () { toggle('x', v); }); });
      if (nFilters() > 1) active.appendChild(h('button.btn.quiet.sm', { type: 'button', onclick: function () { ['a', 'k', 'y', 'p', 'c', 't', 'r', 'e', 'x'].forEach(function (k) { st[k] = []; }); commit(); } }, 'Alle Filter lösen'));
      U.set(fToggle, U.icon('filter'), h('span', { text: 'Filter' + (nFilters() ? ' (' + nFilters() + ')' : '') }));
      drawAi();
    }

    /* ---------------- result blocks (virtualised: a block is filled near the viewport and emptied far away) */
    function teardownBlocks() { if (io) { io.disconnect(); io = null; } blocks = []; cur = -1; }
    function estHeight() { return density === 'compact' ? 74 : 168; }
    function drawResults(r) {
      teardownBlocks();
      U.clear(results);
      var fam = r.totalFamilies != null ? r.totalFamilies : r.total;
      if (!fam) { results.appendChild(emptyState()); return; }
      var n = Math.min(MAX_BLOCKS, Math.ceil(fam / PAGE));
      io = new IntersectionObserver(onSee, { root: document.getElementById('view'), rootMargin: '1400px 0px' });
      for (var i = 0; i < n; i++) {
        var cnt = Math.min(PAGE, fam - i * PAGE);
        var el = h('div.res-block', { data: { i: i }, style: { 'min-height': (cnt * estHeight()) + 'px' } });
        blocks.push({ i: i, el: el, n: cnt, state: 'empty', data: null });
        results.appendChild(el);
      }
      blocks[0].data = { hits: r.hits }; fill(blocks[0]);
      blocks.forEach(function (b) { io.observe(b.el); });
      if (fam > n * PAGE) results.appendChild(h('div.empty', null, h('p', { text: 'Die Liste endet nach ' + U.num(n * PAGE) + ' Familien. Die Suche lässt sich mit Filtern eingrenzen; der CSV-Export enthält bis zu ' + U.num(EXPORT_MAX) + ' Patente.' })));
    }
    function onSee(entries) {
      entries.forEach(function (en) {
        var b = blocks[+en.target.dataset.i]; if (!b) return;
        if (en.isIntersecting) { if (b.state === 'empty') load(b); }
        else free(b);
      });
    }
    function free(b) {                              // drop the rows, keep the height
      if (b.state !== 'full' || b.i === 0 && blocks.length === 1 || b.el.contains(document.activeElement)) return;
      b.el.style.minHeight = b.el.offsetHeight + 'px'; U.clear(b.el); b.state = 'empty';
    }
    function near(b) {
      var v = document.getElementById('view'); if (!v) return true;
      var r = b.el.getBoundingClientRect(), vr = v.getBoundingClientRect();
      return r.bottom > vr.top - 1400 && r.top < vr.bottom + 1400;
    }
    function load(b) {
      if (b.data) { fill(b); return; }
      var my = seq; b.state = 'loading';
      U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, h('span.spin'), '  Treffer ' + U.num(b.i * PAGE + 1) + ' bis ' + U.num(b.i * PAGE + b.n)));
      S.search(st.q, opts({ offset: b.i * PAGE, facets: false })).then(function (r) {
        if (my !== seq || destroyed) return;
        b.data = { hits: r.hits }; fill(b);
      }, function (e) { if (my !== seq || destroyed) return; b.state = 'empty'; U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, 'Nachladen gescheitert: ' + U.errText(e))); });
    }
    function fill(b) {
      var my = seq, hits = b.data.hits || [];
      b.state = 'loading';
      var need = [];
      hits.forEach(function (x) { need.push(x.p); (x.members || []).slice(0, 9).forEach(function (m) { if (m !== x.p) need.push(m); }); });
      (b.data.pats ? Promise.resolve(b.data.pats) : D.patents(need).then(function (ps) { var map = {}; ps.forEach(function (p) { map[p.p] = p; }); return map; })).then(function (map) {
        if (my !== seq || destroyed) return;
        b.data.pats = map;
        var frag = document.createDocumentFragment();
        hits.forEach(function (x, j) { if (map[x.p]) frag.appendChild(hitRow(x, map, b.i * PAGE + j)); });
        U.clear(b.el); b.el.appendChild(frag); b.el.style.minHeight = ''; b.state = 'full';
        if (b.i === 0 && hits.length) {            // real row height of this result -> better estimates for the unloaded blocks
          var avg = b.el.offsetHeight / hits.length;
          if (avg > 20) blocks.forEach(function (o) { if (o !== b && o.state === 'empty' && !o.data) o.el.style.minHeight = Math.round(o.n * avg) + 'px'; });
        }
        if (!near(b)) free(b);                     // it scrolled away while loading
      }, function (e) { if (my !== seq || destroyed) return; b.state = 'empty'; U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, 'Patentdaten nicht ladbar: ' + U.errText(e))); });
    }
    function hitRow(x, map, idx) {
      var p = map[x.p], pn = p.pn, href = App.patentHref(pn, { q: st.q });
      var chk = h('input.chk', { type: 'checkbox', 'aria-label': U.pnPretty(pn) + ' auswählen', checked: selected.has(pn), onchange: function () { select(pn, p, chk.checked); } });
      var star = h('button.btn.quiet.icon.sm.star', { type: 'button', 'aria-pressed': String(App.marks.isStar(pn)), 'aria-label': 'Merken', title: 'Auf die Merkliste', data: { pn: pn },
        onclick: function () { App.marks.toggle(pn, { title: p.title, player: p.player || '' }); } }, U.icon('star'));
      var meta = h('div.hit-meta', null,
        p.status ? U.statusPill(p.status) : null, U.dePill(p.deIn),
        h('span', { text: p.player || p.assignee || 'Anmelder unbekannt', title: p.assignee || '' }),
        p.prio ? h('span', null, 'Prio ', h('span.mono', { text: U.year(p.prio) })) : null,
        h('span', null, 'veröff. ', h('span.mono', { text: U.date(p.pub) })),
        p.exp ? h('span', { title: 'Schätzung: Anmeldetag + 20 Jahre (US zuzüglich PTA)' }, 'Ablauf ca. ', h('span.mono', { text: U.date(p.exp) })) : null,
        p.seedTier ? h('span.tag.seed', { title: 'Schlüsselfamilie ' + (p.seedFam || '') }, 'Schlüssel ' + p.seedTier) : null,
        p.text ? null : h('span.tag', { title: p.textCut ? 'Volltext aus Platzgründen nicht im Bestand' : 'Kein Volltext im Bestand' }, 'nur Biblio'),
        p.hasCompounds ? h('span.tag', { title: 'Strukturen aus SureChEMBL vorhanden' }, 'Strukturen') : null);
      var main = h('div.hit-main', null,
        h('div.hit-l1', null, h('a.hit-pn', { href: href, text: U.pnPretty(pn) }), h('a.hit-title', { href: href, text: p.title || '(ohne Titel)' })),
        meta);
      var mem = (x.members || []).filter(function (m) { return m !== x.p && map[m]; });
      if (mem.length || (x.nMembers || 0) > 1) {
        var fam = h('div.hit-fam', null, h('a.tag', { href: R.build({ view: 'familie', arg: pn }), title: 'Familie vergleichen' }, 'Familie ' + (x.nMembers || mem.length + 1)));
        mem.slice(0, 8).forEach(function (m) { fam.appendChild(h('a.tag', { href: App.patentHref(map[m].pn, { q: st.q }), text: map[m].pn, title: map[m].title || '' })); });
        if ((x.nMembers || 0) - 1 > 8) fam.appendChild(h('span.faint', { text: '+' + (x.nMembers - 9) }));
        main.appendChild(fam);
      }
      if (x.why) main.appendChild(h('div.snip.first', null, h('span.w.ind', { text: 'KI' }), h('span.t', { text: x.why })));
      (x.top && x.top.length ? x.top : x.best ? [x.best] : []).forEach(function (u) {
        if (!u || !u.snippet || u.field === 'title') return;
        var label = u.field === 'claim' || !u.field ? 'Claim ' + u.n + (u.lang === 'de' ? ' DE' : '') : (FIELD[u.field] || u.field);
        var w = u.field === 'claim' || !u.field ? h('a.w' + (u.indep ? '.ind' : ''), { href: App.patentHref(pn, { claim: u.n, lang: u.lang === 'de' ? 'de' : '', q: st.q }), title: u.indep ? 'unabhängiger Claim' : 'abhängiger Claim', text: label + (u.indep ? ' ●' : '') }) : h('span.w', { text: label });
        main.appendChild(h('div.snip' + (main.querySelector('.snip') ? '' : '.first'), null, w, U.pieces(h('span.t'), u.snippet)));
      });
      var row = h('div.hrow' + (selected.has(pn) ? '.sel' : ''), { role: 'listitem', tabindex: '-1', data: { pn: pn, idx: idx } }, chk, main, h('div.hit-act', null, star));
      row.addEventListener('focus', function () { cur = idx; });
      return row;
    }
    function emptyState() {
      var box = h('div.empty', null, h('p.overline', { text: 'Keine Treffer' }), h('h3', { text: 'Dazu steht nichts im Bestand' }));
      box.appendChild(h('p', { text: nFilters() ? 'Mit den gesetzten Filtern bleibt nichts übrig. Ein Filter weniger oder ein allgemeinerer Begriff hilft meist.' : 'Kein Claim, Titel oder Abstract enthält alle Begriffe. OR, ein Wortanfang mit * oder weniger Begriffe erweitern die Suche.' }));
      var ex = h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } });
      EXAMPLES.forEach(function (q) { ex.appendChild(h('button.chip', { type: 'button', onclick: function () { qInput.value = q; st.q = q; commit(); } }, q)); });
      box.appendChild(h('p.faint', { text: 'Beispiele:' })); box.appendChild(ex);
      return box;
    }

    /* ---------------- facets */
    function facetBox(key, title, nOn, body) {
      var d = h('details.facet', { open: !!openFacets[key] || nOn > 0 }, h('summary', null, title, nOn ? h('span.on', { text: String(nOn) }) : null), h('div.facet-body', null, body));
      d.addEventListener('toggle', function () { openFacets[key] = d.open ? 1 : 0; });
      return d;
    }
    function rowsOf(key, counts, o) {
      o = o || {};
      var keys = Object.keys(counts || {}), on = st[key];
      on.forEach(function (v) { var k = o.fromState ? o.fromState(v) : v; if (keys.indexOf(k) < 0) keys.push(k); });
      keys.sort(o.sort || function (a, b) { return (counts[b] || 0) - (counts[a] || 0) || String(a).localeCompare(String(b)); });
      var limit = o.limit || 8, out = [], shown = 0, rest = [];
      keys.forEach(function (k) {
        var val = o.toState ? o.toState(k) : k; if (val == null) return;
        var isOn = on.indexOf(String(val)) >= 0, n = counts[k] || 0;
        var cb = h('input.chk', { type: 'checkbox', checked: isOn, onchange: function () { toggle(key, val); } });
        var row = h('label.f-row' + (n ? '' : '.zero'), null, cb, h('span.l', { text: o.label ? o.label(k) : k, title: o.label ? o.label(k) : k }), h('span.n', { text: U.num(n) }));
        if (shown < limit || isOn) { out.push(row); shown++; } else rest.push(row);
      });
      if (rest.length) {
        var more = h('button.btn.quiet.sm.f-more', { type: 'button', onclick: function () { rest.forEach(function (r) { more.parentNode.insertBefore(r, more); }); more.parentNode.removeChild(more); } }, rest.length + ' weitere');
        out.push(more);
      }
      return out;
    }
    function switchRow(v, n) {
      return h('label.f-row', null, h('input.chk', { type: 'checkbox', checked: st.x.indexOf(v) >= 0, onchange: function () { toggle('x', v); } }), h('span.l', { text: SWITCH[v] }), n != null ? h('span.n', { text: U.num(n) }) : null);
    }
    function drawFacets(f) {
      U.clear(facets);
      facets.appendChild(facetBox('t', 'Rechtsstand', st.t.length + (st.x.indexOf('de') >= 0 ? 1 : 0), [switchRow('de', f.deInForce)].concat(rowsOf('t', f.status, { label: U.statusLabel }))));
      facets.appendChild(facetBox('a', 'Amt', st.a.length, rowsOf('a', f.auth)));
      facets.appendChild(facetBox('p', 'Akteur', st.p.length, rowsOf('p', f.player, { toState: function (name) { var i = M.players.indexOf(name); return i >= 0 ? i : null; }, fromState: function (i) { return M.players[+i]; }, limit: 10 })));
      facets.appendChild(facetBox('y', 'Jahr', st.y.length ? 1 : 0, histogram(f.year || {})));
      facets.appendChild(facetBox('c', 'CPC-Unterklasse', st.c.length, rowsOf('c', f.cpc4, { limit: 8 })));
      facets.appendChild(facetBox('k', 'Schriftart', st.k.length, rowsOf('k', f.kind, { limit: 6 })));
      facets.appendChild(facetBox('r', 'Relevanzstufe', st.r.length + st.e.length, rowsOf('r', f.tier, { label: function (k) { return TIER[k] || 'Stufe ' + k; }, sort: function (a, b) { return a - b; } })
        .concat(rowsOf('e', f.seedTier, { label: function (k) { return 'Schlüsselfamilie Stufe ' + k; }, toState: function (k) { return +k > 0 ? k : null; }, sort: function (a, b) { return a - b; } }))));
      facets.appendChild(facetBox('x', 'Inhalt', st.x.filter(function (v) { return v !== 'de'; }).length, [switchRow('text', f.text), switchRow('comp'), switchRow('img'), switchRow('indep'), switchRow('seed')]));
    }
    function histogram(years) {
      var ks = Object.keys(years).map(Number).filter(function (y) { return y >= 1970 && y <= 2100; }).sort(function (a, b) { return a - b; });
      var from = +st.y[0] || 0, to = +(st.y[1] || st.y[0]) || 0, out = [];
      if (ks.length) {
        var lo = ks[0], hi = ks[ks.length - 1], max = 0, y;
        ks.forEach(function (k) { if (years[k] > max) max = years[k]; });
        var bars = h('div.hist', { role: 'group', 'aria-label': 'Treffer je Veröffentlichungsjahr' });
        for (y = lo; y <= hi; y++) (function (y) {
          var n = years[y] || 0;
          bars.appendChild(h('button' + (from && y >= from && y <= to ? '.in' : ''), { type: 'button', title: y + ': ' + U.num(n), 'aria-label': y + ', ' + n + ' Treffer', style: { height: (n ? Math.max(4, Math.round(n / max * 100)) : 1) + '%' },
            onclick: function (ev) {
              if (from && (ev.shiftKey || from === to) && y !== from) st.y = [String(Math.min(from, y)), String(Math.max(to, y))];
              else if (from === y && to === y) st.y = [];
              else st.y = [String(y), String(y)];
              commit();
            } }));
        })(y);
        out.push(bars, h('div.hist-ax', null, h('span', { text: String(lo) }), h('span', { text: 'max. ' + U.num(max) + ' / Jahr' }), h('span', { text: String(hi) })));
      } else out.push(h('p.faint', { style: { padding: '0 6px 6px', 'font-size': '12.5px' }, text: 'Keine Jahresverteilung' }));
      var a = h('input.input', { id: 'y-from', type: 'number', min: '1970', max: '2100', placeholder: 'von', value: st.y[0] || '', 'aria-label': 'Jahr von' });
      var b = h('input.input', { id: 'y-to', type: 'number', min: '1970', max: '2100', placeholder: 'bis', value: st.y[1] || st.y[0] || '', 'aria-label': 'Jahr bis' });
      function apply() {
        var va = /^\d{4}$/.test(a.value) ? a.value : '', vb = /^\d{4}$/.test(b.value) ? b.value : '';
        if (!va && !vb) st.y = []; else st.y = [va || vb, vb || va];
        if (+st.y[0] > +st.y[1]) st.y.reverse();
        commit();
      }
      a.addEventListener('change', apply); b.addEventListener('change', apply);
      out.push(h('div.hist-in', null, a, '–', b));
      return out;
    }

    /* ---------------- selection, keyboard, marks */
    function select(pn, p, on) {
      if (on) selected.set(pn, { pn: pn, title: p && p.title }); else selected.delete(pn);
      var row = results.querySelector('.hrow[data-pn="' + pn + '"]');
      if (row) { row.classList.toggle('sel', on); var c = row.querySelector('.chk'); if (c) c.checked = on; }
      drawSel();
    }
    function drawSel() {
      selbar.hidden = !selected.size;
      if (!selected.size) return;
      U.set(selbar, h('span.grow', null, h('b', { text: String(selected.size) }), selected.size === 1 ? ' Patent ausgewählt' : ' Patente ausgewählt'),
        h('button.btn.sm', { type: 'button', onclick: function () { Array.from(selected.keys()).forEach(function (pn) { select(pn, null, false); }); } }, 'Auswahl aufheben'),
        h('button.btn.sm', { type: 'button', onclick: function () { selected.forEach(function (v, pn) { if (!App.marks.isStar(pn)) App.marks.save(pn, { star: true, title: v.title || '' }); }); U.toast(selected.size + ' gemerkt'); } }, U.icon('star'), 'Merken'),
        h('button.btn.sm.primary', { type: 'button', id: 'fto-go', onclick: function () { App.handToFto(Array.from(selected.keys()), { q: st.q }); } }, U.icon('fto'), 'FTO prüfen'));
    }
    function hitEls() { return results.querySelectorAll('.hrow'); }
    function focusHit(i) {
      var els = hitEls(); if (!els.length) return;
      i = Math.max(0, Math.min(els.length - 1, i));
      els[i].focus({ preventScroll: true }); els[i].scrollIntoView({ block: 'nearest' });
    }
    function onKey(ev) {
      var els = hitEls(), at = Array.prototype.indexOf.call(els, document.activeElement && document.activeElement.closest ? document.activeElement.closest('.hrow') : null);
      if (ev.key === 'j') { ev.preventDefault(); focusHit(at + 1); }
      else if (ev.key === 'k') { ev.preventDefault(); focusHit(Math.max(0, at - 1)); }
      else if (at >= 0 && ev.key === 'Enter' && document.activeElement === els[at]) { ev.preventDefault(); App.openPatent(els[at].dataset.pn, { q: st.q }); }
      else if (at >= 0 && ev.key === 'x') { ev.preventDefault(); var c = els[at].querySelector('.chk'); c.checked = !c.checked; select(els[at].dataset.pn, { title: (els[at].querySelector('.hit-title') || {}).textContent }, c.checked); }
      else if (at >= 0 && ev.key === 's') { ev.preventDefault(); App.marks.toggle(els[at].dataset.pn, { title: (els[at].querySelector('.hit-title') || {}).textContent }); }
    }
    function onMarks(ev) {
      var b = results.querySelector('.star[data-pn="' + ev.pn + '"]');
      if (b) b.setAttribute('aria-pressed', String(!!(ev.mark && ev.mark.star)));
    }
    function setDensity(d, quiet) {
      density = d; root.dataset.density = d;
      U.set(densBtn, U.icon(d === 'compact' ? 'rowsDense' : 'rows'));
      densBtn.setAttribute('aria-pressed', String(d === 'compact'));
      try { g.localStorage.setItem('lnp.density', d); } catch (e) { /* ignore */ }
      if (!quiet && res) drawResults(res);
    }

    /* ---------------- query box helpers */
    function insert(text, inside) {
      var el = qInput, a = el.selectionStart == null ? el.value.length : el.selectionStart, b = el.selectionEnd == null ? a : el.selectionEnd, v = el.value;
      var selText = v.slice(a, b), ins = text, caret;
      if (inside) { ins = text.slice(0, -1) + selText + text.slice(-1); caret = a + ins.length - (selText ? 0 : 1); }
      else { if (text.charAt(0) === ' ' && (a === 0 || v.charAt(a - 1) === ' ')) ins = text.slice(1); caret = a + ins.length; }
      el.value = v.slice(0, a) + ins + v.slice(b);
      el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
      live();
    }
    function showHelp() {
      var t = h('table');
      HELP.forEach(function (r) { t.appendChild(h('tr', null, h('td', { text: r[0] }), h('td', { text: r[1] }))); });
      U.popover(helpBtn, [h('h3', { text: 'Suchsyntax' }), t, h('p.faint', { style: { 'margin-top': '8px', 'font-size': '12.5px' }, text: 'AND, OR und NOT verknüpfen auf Ebene des Patents; Wortfolgen und NEAR gelten innerhalb eines Claims. Gesucht wird in englischen und deutschen Claims, Titel und Abstract.' })], { align: 'right' });
    }

    /* ---------------- saved searches */
    function saveSearch() {
      var name = h('input.input', { id: 'save-name', type: 'text', value: st.q || 'Filter ohne Suchbegriff', 'aria-label': 'Name der Suche' });
      var pop;
      function doSave() {
        var id = 's' + Date.now().toString(36);
        g.LnpStore.put('searches', id, { name: name.value.trim() || st.q || 'Suche', q: st.q, hash: R.build(toRoute()), filters: filters(), sort: st.s, total: res ? res.total : null, ts: new Date().toISOString() })
          .then(function () { U.toast('Suche gespeichert'); }, function (e) { U.toast('Speichern gescheitert: ' + U.errText(e), { error: true }); });
        U.closePopover();
      }
      name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSave(); });
      pop = U.popover(saveBtn, [h('h3', { text: 'Suche speichern' }), h('div', { style: { display: 'flex', gap: '8px' } }, name, h('button.btn.primary', { type: 'button', onclick: doSave }, 'Speichern'))], { align: 'right' });
      if (pop) { name.focus(); name.select(); }
    }
    function showSaved() {
      var box = h('div', null, h('p.faint', { text: 'Lädt …' }));
      if (!U.popover(savedBtn, [h('h3', { text: 'Gespeicherte Suchen' }), box], { align: 'right' })) return;
      g.LnpStore.entries('searches').then(function (rows) {
        U.clear(box);
        if (!rows.length) { box.appendChild(h('p.faint', { text: 'Noch nichts gespeichert. Das Diskettensymbol legt die aktuelle Suche mit ihren Filtern ab.' })); return; }
        rows.forEach(function (r) {
          var v = r.value || {};
          var line = h('div', { style: { display: 'flex', gap: '4px', 'align-items': 'center' } },
            h('button.menu-item', { type: 'button', onclick: function () { U.closePopover(); R.go(v.hash || { view: 'suche', arg: v.q || '' }); } }, h('span', { text: v.name || v.q || r.id }), h('span.s', { text: U.date((r.updated || '').slice(0, 10)) })),
            h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Löschen', title: 'Löschen', onclick: function () { g.LnpStore.remove('searches', r.id).then(function () { line.parentNode.removeChild(line); }); } }, U.icon('x')));
          box.appendChild(line);
        });
      }, function (e) { U.set(box, h('p.faint', { text: 'Nicht lesbar: ' + U.errText(e) })); });
    }

    /* ---------------- CSV export */
    function exportCsv() {
      if (!res || !res.total) { U.toast('Keine Treffer zum Exportieren'); return; }
      csvBtn.disabled = true;
      var t = U.toast('Export wird vorbereitet …', { ms: 60000 });
      var getAll = res.ai ? Promise.resolve(res.hits.map(function (x) { return x.p; })) : S.search(st.q, { filters: filters(), limit: 1, facets: false, snippets: false, all: true, sort: st.s || 'score' }).then(function (r) { return r.all ? Array.prototype.slice.call(r.all) : r.hits.map(function (x) { return x.p; }); });
      getAll.then(function (ps) {
        var cut = ps.length > EXPORT_MAX; if (cut) ps = ps.slice(0, EXPORT_MAX);
        var rows = [['Nummer', 'Titel', 'Anmelder', 'Akteur', 'Amt', 'Art', 'Veroeffentlicht', 'Prioritaet', 'Ablauf (Schaetzung)', 'Rechtsstand', 'DE in Kraft', 'Stufe', 'Schluesselfamilie', 'Familie', 'Volltext', 'CPC', 'Espacenet']];
        function d(x) { return x ? String(x).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : ''; }
        var i = 0;
        function step() {
          var part = ps.slice(i, i + 2000); i += part.length;
          return D.patents(part).then(function (pats) {
            pats.forEach(function (p) {
              var l = D.linksOf ? D.linksOf(p) : {};
              rows.push([p.pn, p.title, p.assignee, p.player || '', p.auth, p.kind, d(p.pub), d(p.prio), d(p.exp), p.status || '', p.deIn === 1 ? 'ja' : p.deIn === 0 ? 'nein' : '', p.tier, p.seedFam || '', p.fam, p.text ? 'ja' : 'nein', (p.cpc || []).join(' '), l.espacenet || '']);
            });
            t.update('Export: ' + U.num(Math.min(i, ps.length)) + ' von ' + U.num(ps.length));
            return i < ps.length ? step() : null;
          });
        }
        return step().then(function () {
          t.close();
          var name = 'lnp-suche-' + new Date().toISOString().slice(0, 10) + '.csv';
          if (cut) U.toast('Export auf ' + U.num(EXPORT_MAX) + ' Patente begrenzt');
          return U.saveFile(name, U.csv(rows), 'text/csv;charset=utf-8');
        });
      }).catch(function (e) { t.close(); U.toast('Export gescheitert: ' + U.errText(e), { error: true }); }).then(function () { csvBtn.disabled = false; });
    }

    /* ---------------- KI-Suche (engine/ai.js of another part; absent -> explained, never faked) */
    function aiFn() { var A = App.ai(); return A && typeof A.semanticSearch === 'function' ? A : null; }
    function drawAi() {
      var ok = !!aiFn();
      aiBtn.setAttribute('aria-pressed', String(st.m === 'ai'));
      aiBtn.setAttribute('aria-disabled', String(!ok));
      aiBtn.title = ok ? 'Claude erweitert die Anfrage und bewertet die besten Claims. Läuft erst mit der Eingabetaste.' : 'KI-Suche ist in dieser Ansicht nicht verfügbar (Claude-Zugriff fehlt oder wurde nicht erteilt).';
    }
    function toggleAi() {
      if (!aiFn()) { U.toast('KI-Suche ist hier nicht verfügbar. Die Volltextsuche läuft vollständig im Browser.'); return; }
      st.m = st.m === 'ai' ? '' : 'ai';
      commit();
      if (st.m === 'ai') qInput.focus();
    }
    function drawAiIdle() {
      seq++; teardownBlocks(); res = null;
      U.set(count, 'KI-Suche');
      U.set(results, h('div.empty', null, h('p.overline', { text: 'KI-Suche' }), h('h3', { text: 'Anfrage in eigenen Worten beschreiben' }),
        h('p', { text: 'Claude erweitert die Anfrage um Fachbegriffe, durchsucht die unabhängigen Claims und ordnet die besten Treffer. Dabei werden Anfrage und Claim-Auszüge an Claude gesendet. Start mit der Eingabetaste.' }),
        h('p', null, h('button.btn.primary', { type: 'button', onclick: function () { st.q = qInput.value.trim(); runAi(); } }, U.icon('spark'), 'KI-Suche starten'))));
    }
    function runAi() {
      var A = aiFn(); if (!A) { drawAi(); return; }
      if (!st.q) { U.toast('Bitte zuerst eine Anfrage eingeben'); return; }
      var my = ++seq; teardownBlocks();
      if (aiCtl) { try { aiCtl.abort(); } catch (e) { /* ignore */ } }
      aiCtl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var status = h('span', { text: 'Claude arbeitet …' });
      U.set(count, h('span.spin'), ' ', status, ' ', h('button.btn.sm', { type: 'button', onclick: function () { if (aiCtl) aiCtl.abort(); seq++; drawAiIdle(); } }, 'Abbrechen'));
      Promise.resolve().then(function () {
        var STAGE = { expand: 'Anfrage wird erweitert', search: 'Claims werden durchsucht', rerank: 'Claims werden bewertet', done: 'fertig' };
        function onStage(s) { var k = typeof s === 'string' ? s : s && (s.stage || s.text); status.textContent = (STAGE[k] || k || 'Claude arbeitet') + (s && s.done != null && s.total ? ' (' + s.done + ' von ' + s.total + ')' : '') + ' \u2026'; }
        return A.semanticSearch(st.q, { filters: filters(), n: 60, signal: aiCtl ? aiCtl.signal : undefined, onStage: onStage, onStatus: onStage });
      }).then(function (out) {
        if (my !== seq || destroyed) return;
        // engine/ai.js answers per claim: {hits: [{p, claimNo, lang, score 0-3 | null, reason, text}], used, degraded[]}
        var list = Array.isArray(out) ? out : (out && (out.hits || out.results)) || [], byP = {}, hits = [];
        list.forEach(function (x) {
          if (typeof x === 'number') x = { p: x };
          if (!x || !(x.p >= 0)) return;
          var hit = byP[x.p];
          if (!hit) { hit = byP[x.p] = { p: x.p, score: x.score || 0, why: x.why || x.reason || '', top: x.top ? x.top.slice() : [], best: x.best || null, members: [x.p], nMembers: 1 }; hits.push(hit); }
          if (x.claimNo && x.text && hit.top.length < 3) hit.top.push({ n: x.claimNo, lang: x.lang || 'en', indep: true, field: 'claim', snippet: [[String(x.text).length > 300 ? String(x.text).slice(0, 300) + ' \u2026' : String(x.text), false]] });
        });
        res = { total: hits.length, totalFamilies: hits.length, hits: hits, facets: {}, ai: true, ms: null, wall: 0 };
        var used = out && typeof out.query === 'string' ? out.query : '';
        var degraded = out && out.degraded && out.degraded.length;
        U.set(count, h('b', { text: String(hits.length) }), ' Patente aus der KI-Suche', used ? h('span.faint', { text: '  \u00b7 gesucht mit: ' + used }) : null,
          degraded ? h('span', { style: { color: 'var(--warn)' }, text: '  \u00b7 ohne vollst\u00e4ndige Bewertung durch Claude, Reihenfolge teils nach Volltextrang' }) : null);
        U.clear(results);
        if (!hits.length) { results.appendChild(emptyState()); return; }
        var el = h('div.res-block'); results.appendChild(el);
        blocks = [{ i: 0, el: el, n: hits.length, state: 'empty', data: { hits: hits } }];
        fill(blocks[0]);
        U.set(facets, h('p.faint', { style: { padding: '14px 18px', 'font-size': '13px' }, text: 'Die Filter gelten für die KI-Suche beim Start. Zählungen gibt es nur in der Volltextsuche.' }));
      }, function (e) {
        if (my !== seq || destroyed) return;
        if (e && e.code === 'cancelled') { drawAiIdle(); return; }
        var msg = U.errText(e);
        try { if (typeof A.message === 'function' && e && e.code) msg = A.message(e, 'de') || msg; } catch (e2) { /* keep the raw message */ }
        U.set(count, 'KI-Suche gescheitert');
        U.set(results, h('div.empty', null, h('p.overline', { text: 'KI-Suche' }), h('h3', { text: 'Claude hat nicht geantwortet' }), h('p', { text: String(msg) }),
          h('p', null, h('button.btn', { type: 'button', onclick: function () { st.m = ''; commit(); } }, 'Zur Volltextsuche'))));
      });
    }

    /* ---------------- lifecycle */
    fromRoute(route);
    drawBar();
    if (st.m === 'ai' && aiFn()) drawAiIdle(); else { st.m = aiFn() ? st.m : ''; run(); }
    if (!('ontouchstart' in g) && !st.q) setTimeout(function () { if (!destroyed && document.activeElement === document.body) qInput.focus(); }, 30);

    return {
      update: function (r) { fromRoute(r); drawBar(); if (st.m === 'ai' && aiFn()) drawAiIdle(); else run(); return true; },
      destroy: function () { destroyed = true; seq++; live.cancel(); teardownBlocks(); if (ro) ro.disconnect(); offKey(); offMarks(); offCaps(); if (aiCtl) { try { aiCtl.abort(); } catch (e) { /* ignore */ } } }
    };
  }

  g.LnpApp.registerView({ id: 'suche', title: 'Suche', icon: 'search', mount: mount });
})(window);
