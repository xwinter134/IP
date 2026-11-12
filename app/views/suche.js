/* LNP Patent Desk: search view. Route: #suche[-<query>][--a..][--k..][--y..][--p..][--c..][--t..][--r..][--e..][--x..][--s..][--mai]
   a auth, k kinds, y [from, to] publication year, p player indexes, c CPC subclasses, t status codes, r tiers,
   e seed tiers, x switches (text, comp, img, de, indep, seed), s sort (date | expiry), m = "ai" (AI search). */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  var PAGE = 30, MAX_BLOCKS = 400, EXPORT_MAX = 20000;
  var OPS = [
    ['AND', ' AND ', 'both terms'], ['OR', ' OR ', 'either term'], ['NOT', ' NOT ', 'without the term'], ['"…"', '""', 'exact phrase', 1],
    ['NEAR/5', ' NEAR/5 ', 'at most 5 words apart'], ['*', '*', 'word stem'], ['( )', '()', 'group', 1],
    ['indep:', 'indep:', 'independent claims only'], ['claims:', 'claims:', 'claims only'], ['title:', 'title:', 'title only'], ['asg:', 'asg:', 'applicant'],
    ['same:( )', 'same:()', 'all in the same claim', 1], ['cpc:', 'cpc:', 'CPC class'], ['year:', 'year:', 'publication year'], ['player:', 'player:', 'player'], ['status:', 'status:', 'legal status']
  ];
  var HELP = [
    ['lipid nanoparticle', 'both words, anywhere in the patent (AND is the default)'],
    ['"ionizable lipid"', 'exact phrase within a claim'],
    ['pKa NEAR/8 lipid', 'at most 8 words apart, in the same claim'],
    ['cholest* OR sterol', 'word stem; alternatives'],
    ['lipid -siRNA', 'without the term (also NOT)'],
    ['same:(PEG "mol %")', 'all conditions in the same claim'],
    ['indep:(molar ratio)', 'independent claims only; likewise dep: claims: title: abstract:'],
    ['asg:acuitas  player:Moderna', 'applicant (word stem); assigned player'],
    ['cpc:A61K9/51  cpc:C07C|C07D', 'CPC prefix, lists with |'],
    ['year:2018-2022  prio:-2012  exp:2030-', 'publication, priority, expiry (years)'],
    ['status:granted  inforce:1', 'legal status; in force in DE'],
    ['pn:"EP 3 532 103"  fam:62025447', 'number, family'],
    ['DLin-MC3-DMA  C12-200', 'hyphenated names are treated as a phrase'],
    ['lang:de  text:1  compounds:1', 'German claims; full text only; with structures']
  ];
  var EXAMPLES = ['"ionizable lipid" NEAR/10 pKa', 'indep:("molar ratio" cholesterol PEG)', 'player:Acuitas status:granted', 'cpc:A61K9/5123 year:2021-', 'DLin-MC3-DMA'];
  var TIER = { 0: 'key list only', 1: 'Tier 1 (core)', 2: 'Tier 2', 3: 'Tier 3', 4: 'Tier 4 (periphery)', 5: 'class search only' };
  var SWITCH = { text: 'Full text available', comp: 'Structures available', img: 'Formula image in main claim', de: 'In force in DE', indep: 'Search independent claims only', seed: 'Key families only' };
  var FIELD = { title: 'Title', abstract: 'Abstract', assignee: 'Applicant' };

  function mount(host, route, App) {
    var D = g.LnpData, S = g.LnpSearch, M = App.manifest;
    var st = { q: '', a: [], k: [], y: [], p: [], c: [], t: [], r: [], e: [], x: [], f: [], s: '', m: '' };   // f: extension facets, items "<facetId>:<value>"
    var seq = 0, res = null, blocks = [], io = null, ro = null, selected = new Map(), cur = -1, destroyed = false, aiCtl = null, openFacets = { t: 1, a: 1, p: 1, y: 1 };
    var density = 'comfortable'; try { density = g.localStorage.getItem('lnp.density') || density; } catch (e) { /* ignore */ }

    /* ---------------- skeleton */
    var qInput = h('input', { id: 'q', type: 'search', placeholder: 'Terms, "phrases", fields such as indep: or cpc:', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search query', enterkeyhint: 'search' });
    var helpBtn = h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Search syntax', title: 'Search syntax', onclick: showHelp }, U.icon('help'));
    var aiBtn = h('button.btn', { type: 'button', id: 'ai-toggle', 'aria-pressed': 'false', onclick: toggleAi }, U.icon('spark'), h('span.lbl', { text: 'AI search' }));
    var ops = h('div.q-ops', { role: 'group', 'aria-label': 'Operators' });
    OPS.forEach(function (o) { ops.appendChild(h('button.chip', { type: 'button', title: o[2], onclick: function () { insert(o[1], o[3]); } }, o[0])); });
    var warn = h('div.q-warn', { hidden: true });
    var count = h('div.s-count', { 'aria-live': 'polite' });
    var active = h('div.s-active');
    var sortSeg = h('div.seg', { role: 'group', 'aria-label': 'Sort order' });
    [['', 'Relevance'], ['date', 'Date'], ['expiry', 'Expiry']].forEach(function (s) { sortSeg.appendChild(h('button', { type: 'button', data: { s: s[0] }, onclick: function () { st.s = s[0]; commit(); } }, s[1])); });
    var densBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Result list density', title: 'Result list density', onclick: function () { setDensity(density === 'compact' ? 'comfortable' : 'compact'); } });
    var fToggle = h('button.btn.f-toggle', { type: 'button', 'aria-expanded': 'false', onclick: function () { var open = root.dataset.facets !== 'open'; root.dataset.facets = open ? 'open' : ''; fToggle.setAttribute('aria-expanded', String(open)); } }, U.icon('filter'), 'Filters');
    var saveBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Save search', title: 'Save search', onclick: saveSearch }, U.icon('save'));
    var savedBtn = h('button.btn', { type: 'button', title: 'Saved searches', 'aria-label': 'Saved searches', onclick: showSaved }, U.icon('rows'), h('span.lbl', { text: 'Saved' }));
    var csvBtn = h('button.btn', { type: 'button', title: 'Result list as CSV', 'aria-label': 'CSV export', onclick: exportCsv }, U.icon('download'), h('span.lbl', { text: 'CSV' }));
    var top = h('div.s-top', null,
      h('div.q-row', null, h('div.q-box', null, U.icon('search'), qInput, helpBtn), aiBtn),
      ops, warn,
      h('div.s-bar', null, count, fToggle, sortSeg, densBtn, saveBtn, savedBtn, csvBtn),
      active);
    var facets = h('aside.facets', { 'aria-label': 'Filters' });
    var results = h('div.results', { role: 'list', 'aria-label': 'Results' });
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
    var offExt = App.ext && App.ext.on ? App.ext.on(function (kind, entry) {      // a facet of a selected value registers late: apply it now
      if (kind !== 'searchFacet' || destroyed || !st.f.some(function (it) { return extSplit(it)[0] === entry.id; })) return;
      extComb.clear(); if (st.m !== 'ai') run();
    }) : function () { };
    var offKey = App.on('key', onKey), offMarks = App.on('marks', onMarks), offCaps = App.on('caps', drawAi);

    /* ---------------- state <-> route */
    function fromRoute(r) {
      var p = r.params || {};
      st.q = r.arg || '';
      ['a', 'k', 'y', 'p', 'c', 't', 'r', 'e', 'x', 'f'].forEach(function (k) { st[k] = R.list(p[k]); });
      st.s = typeof p.s === 'string' ? p.s : ''; st.m = p.m === 'ai' ? 'ai' : '';
      if (qInput.value.trim() !== st.q) qInput.value = st.q;
    }
    function toRoute() { return { view: 'suche', arg: st.q, params: { a: st.a, k: st.k, y: st.y, p: st.p, c: st.c, t: st.t, r: st.r, e: st.e, x: st.x, f: st.f, s: st.s, m: st.m } }; }
    function filters(skipExt) {            // skipExt: true = leave out the extension facets, an id = leave out that facet
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
      if (st.f.length && skipExt !== true) { var xps = extPs(skipExt); if (xps) f.ps = xps; }
      return f;
    }
    function nFilters() { return st.a.length + st.k.length + (st.y.length ? 1 : 0) + st.p.length + st.c.length + st.t.length + st.r.length + st.e.length + st.x.length + st.f.length; }
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
      extAll = {};
      afterExt(function () { return S.search(st.q, opts()); }).then(function (r) {
        if (my !== seq || destroyed) return;
        res = r; res.wall = Date.now() - t0;
        App.state.lastParsed = r.parsed || null;
        drawWarn(r.parsed && r.parsed.warnings);
        drawCount();
        drawResults(r);
        drawFacets(r.facets || {});
        root.removeAttribute('aria-busy');
        refineFacets(my);
        drawExtResult(r); loadExt(my);
      }, function (e) {
        if (my !== seq || destroyed) return;
        root.removeAttribute('aria-busy');
        res = null; teardownBlocks();
        U.set(count, 'Search failed');
        U.set(results, h('div.empty', null, h('p.overline', { text: 'Error' }), h('h3', { text: 'The search could not be run' }), h('p', { text: U.errText(e) }),
          e && e.name ? h('p.mono', { text: 'File: ' + e.name + (e.status ? '  HTTP ' + e.status : '') }) : null));
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
      U.set(count, h('b', { text: U.num(fam) }), ' ' + (fam === 1 ? 'family' : 'families') + ' · ', h('b', { text: U.num(res.total) }), ' ' + (res.total === 1 ? 'patent' : 'patents'),
        h('span.faint.mono', { text: '  ' + (res.ms != null ? Math.round(res.ms) : res.wall) + ' ms' }),
        isStart() ? h('span.faint', { text: '  \u00b7 No query yet: showing the curated key families as a starting point. Type a query to search all ' + U.num(M.counts.patents) + ' patents.' }) : null);
    }
    function drawBar() {
      var bs = sortSeg.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].dataset.s === st.s));
      U.clear(active);
      function chip(label, off) { active.appendChild(h('button.chip.on', { type: 'button', title: 'Remove filter', onclick: off }, label, h('span.x', { text: '×' }))); }
      st.t.forEach(function (v) { chip(U.statusLabel(v), function () { toggle('t', v); }); });
      st.a.forEach(function (v) { chip(v, function () { toggle('a', v); }); });
      st.k.forEach(function (v) { chip('Kind ' + v, function () { toggle('k', v); }); });
      st.p.forEach(function (v) { chip(M.players[+v] || v, function () { toggle('p', v); }); });
      if (st.y.length) chip(st.y[0] + (st.y[1] && st.y[1] !== st.y[0] ? '–' + st.y[1] : ''), function () { st.y = []; commit(); });
      st.c.forEach(function (v) { chip('CPC ' + v, function () { toggle('c', v); }); });
      st.r.forEach(function (v) { chip(TIER[v] || 'Tier ' + v, function () { toggle('r', v); }); });
      st.e.forEach(function (v) { chip('Key family tier ' + v, function () { toggle('e', v); }); });
      st.x.forEach(function (v) { chip(SWITCH[v] || v, function () { toggle('x', v); }); });
      st.f.forEach(function (it) { chip(extChip(it), function () { toggle('f', it); }); });
      if (nFilters() > 1) active.appendChild(h('button.btn.quiet.sm', { type: 'button', onclick: function () { ['a', 'k', 'y', 'p', 'c', 't', 'r', 'e', 'x', 'f'].forEach(function (k) { st[k] = []; }); commit(); } }, 'Clear all filters'));
      U.set(fToggle, U.icon('filter'), h('span', { text: 'Filters' + (nFilters() ? ' (' + nFilters() + ')' : '') }));
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
      if (fam > n * PAGE) results.appendChild(h('div.empty', null, h('p', { text: 'The list ends after ' + U.num(n * PAGE) + ' families. Use filters to narrow the search; the CSV export contains up to ' + U.num(EXPORT_MAX) + ' patents.' })));
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
      U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, h('span.spin'), '  Results ' + U.num(b.i * PAGE + 1) + ' to ' + U.num(b.i * PAGE + b.n)));
      S.search(st.q, opts({ offset: b.i * PAGE, facets: false })).then(function (r) {
        if (my !== seq || destroyed) return;
        b.data = { hits: r.hits }; fill(b);
      }, function (e) { if (my !== seq || destroyed) return; b.state = 'empty'; U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, 'Loading more failed: ' + U.errText(e))); });
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
      }, function (e) { if (my !== seq || destroyed) return; b.state = 'empty'; U.set(b.el, h('div.res-ph', { style: { height: '56px' } }, 'Could not load patent data: ' + U.errText(e))); });
    }
    function hitRow(x, map, idx) {
      var p = map[x.p], pn = p.pn, href = App.patentHref(pn, { q: st.q });
      var chk = h('input.chk', { type: 'checkbox', 'aria-label': 'Select ' + U.pnPretty(pn), checked: selected.has(pn), onchange: function () { select(pn, p, chk.checked); } });
      var star = h('button.btn.quiet.icon.sm.star', { type: 'button', 'aria-pressed': String(App.marks.isStar(pn)), 'aria-label': 'Add to watchlist', title: 'Add to watchlist', data: { pn: pn },
        onclick: function () { App.marks.toggle(pn, { title: p.title, player: p.player || '' }); } }, U.icon('star'));
      var meta = h('div.hit-meta', null,
        p.status ? U.statusPill(p.status) : null, U.dePill(p.deIn),
        h('span', { text: p.player || p.assignee || 'Applicant unknown', title: p.assignee || '' }),
        p.prio ? h('span', null, 'Priority ', h('span.mono', { text: U.year(p.prio) })) : null,
        h('span', null, 'publ. ', h('span.mono', { text: U.date(p.pub) })),
        p.exp ? h('span', { title: 'Estimate: filing date + 20 years (US plus PTA)' }, 'Expiry est. ', h('span.mono', { text: U.date(p.exp) })) : null,
        p.seedTier ? h('span.tag.seed', { title: 'Key family ' + (p.seedFam || '') }, 'Key ' + p.seedTier) : null,
        p.text ? null : h('span.tag', { title: p.textCut ? 'Full text not in the dataset (omitted for size)' : 'No full text in the dataset' }, 'bibliographic only'),
        p.hasCompounds ? h('span.tag', { title: 'Structures from SureChEMBL available' }, 'Structures') : null);
      var main = h('div.hit-main', null,
        h('div.hit-l1', null, h('a.hit-pn', { href: href, text: U.pnPretty(pn) }), h('a.hit-title', { href: href, text: p.title || '(untitled)' })),
        meta);
      var mem = (x.members || []).filter(function (m) { return m !== x.p && map[m]; });
      if (mem.length || (x.nMembers || 0) > 1) {
        var fam = h('div.hit-fam', null, h('a.tag', { href: R.build({ view: 'familie', arg: pn }), title: 'Compare family' }, 'Family ' + (x.nMembers || mem.length + 1)));
        mem.slice(0, 8).forEach(function (m) { fam.appendChild(h('a.tag', { href: App.patentHref(map[m].pn, { q: st.q }), text: map[m].pn, title: map[m].title || '' })); });
        if ((x.nMembers || 0) - 1 > 8) fam.appendChild(h('span.faint', { text: '+' + (x.nMembers - 9) }));
        main.appendChild(fam);
      }
      if (x.why) main.appendChild(h('div.snip.first', null, h('span.w.ind', { text: 'AI' }), h('span.t', { text: x.why })));
      (x.top && x.top.length ? x.top : x.best ? [x.best] : []).forEach(function (u) {
        if (!u || !u.snippet || u.field === 'title') return;
        var label = u.field === 'claim' || !u.field ? 'Claim ' + u.n + (u.lang === 'de' ? ' DE' : '') : (FIELD[u.field] || u.field);
        var w = u.field === 'claim' || !u.field ? h('a.w' + (u.indep ? '.ind' : ''), { href: App.patentHref(pn, { claim: u.n, lang: u.lang === 'de' ? 'de' : '', q: st.q }), title: u.indep ? 'independent claim' : 'dependent claim', text: label + (u.indep ? ' ●' : '') }) : h('span.w', { text: label });
        main.appendChild(h('div.snip' + (main.querySelector('.snip') ? '' : '.first'), null, w, U.pieces(h('span.t'), u.snippet)));
      });
      var row = h('div.hrow' + (selected.has(pn) ? '.sel' : ''), { role: 'listitem', tabindex: '-1', data: { pn: pn, idx: idx } }, chk, main, h('div.hit-act', null, star));
      row.addEventListener('focus', function () { cur = idx; });
      return row;
    }
    function emptyState() {
      var box = h('div.empty', null, h('p.overline', { text: 'No results' }), h('h3', { text: 'Nothing in the dataset matches' }));
      box.appendChild(h('p', { text: nFilters() ? 'Nothing is left with the filters applied. Removing a filter or using a more general term usually helps.' : 'No claim, title or abstract contains all the terms. OR, a word stem with * or fewer terms will widen the search.' }));
      var ex = h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } });
      EXAMPLES.forEach(function (q) { ex.appendChild(h('button.chip', { type: 'button', onclick: function () { qInput.value = q; st.q = q; commit(); } }, q)); });
      box.appendChild(h('p.faint', { text: 'Examples:' })); box.appendChild(ex);
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
        var more = h('button.btn.quiet.sm.f-more', { type: 'button', onclick: function () { rest.forEach(function (r) { more.parentNode.insertBefore(r, more); }); more.parentNode.removeChild(more); } }, rest.length + ' more');
        out.push(more);
      }
      return out;
    }
    function switchRow(v, n) {
      return h('label.f-row', null, h('input.chk', { type: 'checkbox', checked: st.x.indexOf(v) >= 0, onchange: function () { toggle('x', v); } }), h('span.l', { text: SWITCH[v] }), n != null ? h('span.n', { text: U.num(n) }) : null);
    }
    function drawFacets(f) {
      U.clear(facets);
      facets.appendChild(facetBox('t', 'Legal status', st.t.length + (st.x.indexOf('de') >= 0 ? 1 : 0), [switchRow('de', f.deInForce)].concat(rowsOf('t', f.status, { label: U.statusLabel }))));
      facets.appendChild(facetBox('a', 'Office', st.a.length, rowsOf('a', f.auth)));
      facets.appendChild(facetBox('p', 'Player', st.p.length, rowsOf('p', f.player, { toState: function (name) { var i = M.players.indexOf(name); return i >= 0 ? i : null; }, fromState: function (i) { return M.players[+i]; }, limit: 10 })));
      facets.appendChild(facetBox('y', 'Year', st.y.length ? 1 : 0, histogram(f.year || {})));
      facets.appendChild(facetBox('c', 'CPC subclass', st.c.length, rowsOf('c', f.cpc4, { limit: 8 })));
      facets.appendChild(facetBox('k', 'Kind code', st.k.length, rowsOf('k', f.kind, { limit: 6 })));
      facets.appendChild(facetBox('r', 'Relevance tier', st.r.length + st.e.length, rowsOf('r', f.tier, { label: function (k) { return TIER[k] || 'Tier ' + k; }, sort: function (a, b) { return a - b; } })
        .concat(rowsOf('e', f.seedTier, { label: function (k) { return 'Key family tier ' + k; }, toState: function (k) { return +k > 0 ? k : null; }, sort: function (a, b) { return a - b; } }))));
      facets.appendChild(facetBox('x', 'Content', st.x.filter(function (v) { return v !== 'de'; }).length, [switchRow('text', f.text), switchRow('comp'), switchRow('img'), switchRow('indep'), switchRow('seed')]));
      if (extFacets().length) { drawExt(); facets.appendChild(extHost); }
    }
    function histogram(years) {
      var ks = Object.keys(years).map(Number).filter(function (y) { return y >= 1970 && y <= 2100; }).sort(function (a, b) { return a - b; });
      var from = +st.y[0] || 0, to = +(st.y[1] || st.y[0]) || 0, out = [];
      if (ks.length) {
        var lo = ks[0], hi = ks[ks.length - 1], max = 0, y;
        ks.forEach(function (k) { if (years[k] > max) max = years[k]; });
        var bars = h('div.hist', { role: 'group', 'aria-label': 'Results per publication year' });
        for (y = lo; y <= hi; y++) (function (y) {
          var n = years[y] || 0;
          bars.appendChild(h('button' + (from && y >= from && y <= to ? '.in' : ''), { type: 'button', title: y + ': ' + U.num(n), 'aria-label': y + ', ' + n + ' results', style: { height: (n ? Math.max(4, Math.round(n / max * 100)) : 1) + '%' },
            onclick: function (ev) {
              if (from && (ev.shiftKey || from === to) && y !== from) st.y = [String(Math.min(from, y)), String(Math.max(to, y))];
              else if (from === y && to === y) st.y = [];
              else st.y = [String(y), String(y)];
              commit();
            } }));
        })(y);
        out.push(bars, h('div.hist-ax', null, h('span', { text: String(lo) }), h('span', { text: 'max. ' + U.num(max) + ' / year' }), h('span', { text: String(hi) })));
      } else out.push(h('p.faint', { style: { padding: '0 6px 6px', 'font-size': '12.5px' }, text: 'No year distribution' }));
      var a = h('input.input', { id: 'y-from', type: 'number', min: '1970', max: '2100', placeholder: 'from', value: st.y[0] || '', 'aria-label': 'Year from' });
      var b = h('input.input', { id: 'y-to', type: 'number', min: '1970', max: '2100', placeholder: 'to', value: st.y[1] || st.y[0] || '', 'aria-label': 'Year to' });
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

    /* ---------------- extension facets and result actions (LnpApp.ext.searchFacet / resultAction)
       A selected value is applied as filters.ps: the patent indexes of the value (spec.ps), several values intersect
       (spec.combine === 'or' makes the values of one facet a union). Counts come from spec.counts(all), where all = the
       patent indexes of the current result, requested after the first page has been painted; a facet with a selection is
       counted on the result without its own selection, so its other values stay selectable. */
    var extCache = new Map(), extComb = new Map(), extCounts = {}, extErr = {}, extHost = null, extAll = {}, extResNodes = [];
    function extFacets() { return App.ext ? App.ext.list('searchFacet').filter(function (x) { return /^[A-Za-z][A-Za-z0-9]*$/.test(x.id) && typeof x.counts === 'function' && typeof x.ps === 'function'; }) : []; }
    function extSplit(it) { var i = it.indexOf(':'); return i > 0 ? [it.slice(0, i), it.slice(i + 1)] : [it, '']; }
    function extVals(id) { return st.f.map(extSplit).filter(function (x) { return x[0] === id; }).map(function (x) { return x[1]; }); }
    function extSpec(id) { return extFacets().filter(function (x) { return x.id === id; })[0] || null; }
    function extChip(it) {
      var sp = extSplit(it), spec = extSpec(sp[0]), row = ((extCounts[sp[0]] || []).filter(function (x) { return String(x.value) === sp[1]; })[0]) || null;
      if (!spec) return sp[0] + ': ' + sp[1] + ' (loading filter \u2026)';
      return (spec ? spec.title || spec.id : sp[0]) + ': ' + (row && row.label ? row.label : sp[1]);
    }
    function extResolve() {
      return Promise.all(st.f.map(function (it) {
        var sp = extSplit(it), spec = extSpec(sp[0]);
        if (!spec || extCache.has(it)) return null;      // spec missing: pending, the filter is applied when the facet registers
        return Promise.resolve().then(function () { return spec.ps(sp[1]); }).then(function (a) { extCache.set(it, a instanceof Uint32Array ? a : Uint32Array.from(a || [])); });
      }));
    }
    function setIntersect(arrs) {
      arrs = arrs.slice().sort(function (a, b) { return a.length - b.length; });
      var set = new Set(arrs[0]);
      for (var i = 1; i < arrs.length && set.size; i++) { var nx = new Set(); for (var j = 0; j < arrs[i].length; j++) if (set.has(arrs[i][j])) nx.add(arrs[i][j]); set = nx; }
      return Uint32Array.from(set);
    }
    function extPs(skipId) {              // null = no extension facet restricts the result
      var key = (skipId || '') + '|' + st.f.join(','), hit = extComb.get(key);
      if (hit !== undefined) return hit;
      var groups = {}, ids = [], out = null, complete = true;
      st.f.forEach(function (it) {
        var sp = extSplit(it), a = extCache.get(it);
        if (sp[0] === skipId) return;
        if (!a || !extSpec(sp[0])) { complete = false; return; }
        if (!groups[sp[0]]) { groups[sp[0]] = []; ids.push(sp[0]); }
        groups[sp[0]].push(a);
      });
      var parts = ids.map(function (id) {
        var arrs = groups[id];
        if (arrs.length === 1) return arrs[0];
        if (extSpec(id).combine === 'or') { var u = new Set(); arrs.forEach(function (a) { for (var i = 0; i < a.length; i++) u.add(a[i]); }); return Uint32Array.from(u); }
        return setIntersect(arrs);
      });
      if (parts.length) out = parts.length === 1 ? parts[0] : setIntersect(parts);
      if (extComb.size > 40) extComb.clear();
      if (complete) extComb.set(key, out);      // a partial result (spec not registered yet) is never cached
      return out;
    }
    function afterExt(fn) { return st.f.length ? extResolve().then(fn) : fn(); }
    function extAllFor(skip) {            // patent indexes of the result (Uint32Array), with or without the selection of one facet
      var k = skip || '';
      if (!extAll[k]) extAll[k] = afterExt(function () {
        return S.search(st.q, { filters: filters(skip || undefined), limit: 1, facets: false, snippets: false, all: true, sort: 'score' }).then(function (r) { return r.all ? r.all : Uint32Array.from((r.hits || []).map(function (x) { return x.p; })); });
      });
      return extAll[k];
    }
    function toggleExt(id, v) { toggle('f', id + ':' + v); }
    function extRows(spec) {
      var list = extCounts[spec.id], on = extVals(spec.id);
      if (!list) return [h('p.faint', { style: { padding: '0 6px 6px', 'font-size': '12.5px' }, text: extErr[spec.id] || 'Counting …' })];
      list = list.slice();
      on.forEach(function (v) { if (!list.some(function (x) { return String(x.value) === v; })) list.push({ value: v, label: v, n: 0 }); });
      var out = [], rest = [], shown = 0;
      list.forEach(function (x) {
        var v = String(x.value), isOn = on.indexOf(v) >= 0, n = +x.n || 0;
        var row = h('label.f-row' + (n ? '' : '.zero'), null, h('input.chk', { type: 'checkbox', checked: isOn, onchange: function () { toggleExt(spec.id, v); } }),
          h('span.l', { text: String(x.label != null ? x.label : v), title: String(x.label != null ? x.label : v) }), h('span.n', { text: U.num(n) }));
        if (shown < 8 || isOn) { out.push(row); shown++; } else rest.push(row);
      });
      if (rest.length) { var more = h('button.btn.quiet.sm.f-more', { type: 'button', onclick: function () { rest.forEach(function (r2) { more.parentNode.insertBefore(r2, more); }); more.parentNode.removeChild(more); } }, rest.length + ' more'); out.push(more); }
      return out;
    }
    function drawExt() {
      if (!extHost) extHost = h('div', { style: { display: 'contents' } });
      U.clear(extHost);
      extFacets().forEach(function (spec) { if (extCounts[spec.id] && !extCounts[spec.id].length && !extVals(spec.id).length) return; extHost.appendChild(facetBox('x_' + spec.id, spec.title || spec.id, extVals(spec.id).length, extRows(spec))); });
    }
    function loadExt(my) {
      var specs = extFacets();
      if (!specs.length || st.m === 'ai') return;
      specs.forEach(function (spec) {
        var skip = extVals(spec.id).length ? spec.id : null;
        extAllFor(skip).then(function (all) { return spec.counts(all); }).then(function (list) {
          if (my !== seq || destroyed) return;
          extCounts[spec.id] = Array.isArray(list) ? list : []; delete extErr[spec.id]; drawExt(); drawBar();
        }, function (e) {
          App.logError('ext searchFacet ' + spec.id, e);
          if (my !== seq || destroyed) return;
          delete extCounts[spec.id]; extErr[spec.id] = 'The counts could not be computed.'; drawExt();
        });
      });
    }
    function drawExtResult(r) {
      extResNodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); }); extResNodes = [];
      if (!App.ext || !App.ext.has('resultAction')) return;
      var info = { query: st.q, parsed: r.parsed || null, filters: filters(), total: r.total, all: function () { return extAllFor(null); } }, ref = csvBtn;
      App.ext.nodes('resultAction', info).forEach(function (n) { ref.parentNode.insertBefore(n, ref.nextSibling); ref = n; extResNodes.push(n); });
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
      U.set(selbar, h('span.grow', null, h('b', { text: String(selected.size) }), selected.size === 1 ? ' patent selected' : ' patents selected'),
        h('button.btn.sm', { type: 'button', onclick: function () { Array.from(selected.keys()).forEach(function (pn) { select(pn, null, false); }); } }, 'Clear selection'),
        h('button.btn.sm', { type: 'button', onclick: function () { selected.forEach(function (v, pn) { if (!App.marks.isStar(pn)) App.marks.save(pn, { star: true, title: v.title || '' }); }); U.toast(selected.size + ' added to watchlist'); } }, U.icon('star'), 'Watch'),
        h('button.btn.sm.primary', { type: 'button', id: 'fto-go', onclick: function () { App.handToFto(Array.from(selected.keys()), { q: st.q }); } }, U.icon('fto'), 'Check FTO'));
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
      U.popover(helpBtn, [h('h3', { text: 'Search syntax' }), t, h('p.faint', { style: { 'margin-top': '8px', 'font-size': '12.5px' }, text: 'AND, OR and NOT combine at patent level; phrases and NEAR apply within a single claim. English and German claims, title and abstract are searched.' })], { align: 'right' });
    }

    /* ---------------- saved searches */
    function saveSearch() {
      var name = h('input.input', { id: 'save-name', type: 'text', value: st.q || 'Filters without search terms', 'aria-label': 'Search name' });
      var pop;
      function doSave() {
        var id = 's' + Date.now().toString(36);
        g.LnpStore.put('searches', id, { name: name.value.trim() || st.q || 'Search', q: st.q, hash: R.build(toRoute()), filters: filters(true), sort: st.s, total: res ? res.total : null, ts: new Date().toISOString() })
          .then(function () { U.toast('Search saved'); }, function (e) { U.toast('Save failed: ' + U.errText(e), { error: true }); });
        U.closePopover();
      }
      name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSave(); });
      pop = U.popover(saveBtn, [h('h3', { text: 'Save search' }), h('div', { style: { display: 'flex', gap: '8px' } }, name, h('button.btn.primary', { type: 'button', onclick: doSave }, 'Save'))], { align: 'right' });
      if (pop) { name.focus(); name.select(); }
    }
    function showSaved() {
      var box = h('div', null, h('p.faint', { text: 'Loading …' }));
      if (!U.popover(savedBtn, [h('h3', { text: 'Saved searches' }), box], { align: 'right' })) return;
      g.LnpStore.entries('searches').then(function (rows) {
        U.clear(box);
        if (!rows.length) { box.appendChild(h('p.faint', { text: 'Nothing saved yet. The disk icon stores the current search with its filters.' })); return; }
        rows.forEach(function (r) {
          var v = r.value || {};
          var line = h('div', { style: { display: 'flex', gap: '4px', 'align-items': 'center' } },
            h('button.menu-item', { type: 'button', onclick: function () { U.closePopover(); R.go(v.hash || { view: 'suche', arg: v.q || '' }); } }, h('span', { text: v.name || v.q || r.id }), h('span.s', { text: U.date((r.updated || '').slice(0, 10)) })),
            h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Delete', title: 'Delete', onclick: function () { g.LnpStore.remove('searches', r.id).then(function () { line.parentNode.removeChild(line); }); } }, U.icon('x')));
          box.appendChild(line);
        });
      }, function (e) { U.set(box, h('p.faint', { text: 'Could not be read: ' + U.errText(e) })); });
    }

    /* ---------------- CSV export */
    function exportCsv() {
      if (!res || !res.total) { U.toast('No results to export'); return; }
      csvBtn.disabled = true;
      var t = U.toast('Preparing export …', { ms: 60000 });
      var getAll = res.ai ? Promise.resolve(res.hits.map(function (x) { return x.p; })) : S.search(st.q, { filters: filters(), limit: 1, facets: false, snippets: false, all: true, sort: st.s || 'score' }).then(function (r) { return r.all ? Array.prototype.slice.call(r.all) : r.hits.map(function (x) { return x.p; }); });
      getAll.then(function (ps) {
        var cut = ps.length > EXPORT_MAX; if (cut) ps = ps.slice(0, EXPORT_MAX);
        var rows = [['Number', 'Title', 'Applicant', 'Player', 'Office', 'Kind', 'Published', 'Priority', 'Expiry (estimate)', 'Legal status', 'DE in force', 'Tier', 'Key family', 'Family', 'Full text', 'CPC', 'Espacenet']];
        function d(x) { return x ? String(x).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : ''; }
        var i = 0;
        function step() {
          var part = ps.slice(i, i + 2000); i += part.length;
          return D.patents(part).then(function (pats) {
            pats.forEach(function (p) {
              var l = D.linksOf ? D.linksOf(p) : {};
              rows.push([p.pn, p.title, p.assignee, p.player || '', p.auth, p.kind, d(p.pub), d(p.prio), d(p.exp), p.status || '', p.deIn === 1 ? 'yes' : p.deIn === 0 ? 'no' : '', p.tier, p.seedFam || '', p.fam, p.text ? 'yes' : 'no', (p.cpc || []).join(' '), l.espacenet || '']);
            });
            t.update('Export: ' + U.num(Math.min(i, ps.length)) + ' of ' + U.num(ps.length));
            return i < ps.length ? step() : null;
          });
        }
        return step().then(function () {
          t.close();
          var name = 'lnp-search-' + new Date().toISOString().slice(0, 10) + '.csv';
          if (cut) U.toast('Export limited to ' + U.num(EXPORT_MAX) + ' patents');
          return U.saveFile(name, U.csv(rows), 'text/csv;charset=utf-8');
        });
      }).catch(function (e) { t.close(); U.toast('Export failed: ' + U.errText(e), { error: true }); }).then(function () { csvBtn.disabled = false; });
    }

    /* ---------------- AI search (engine/ai.js of another part; absent -> explained, never faked) */
    function aiFn() { var A = App.ai(); return A && typeof A.semanticSearch === 'function' ? A : null; }
    function drawAi() {
      var ok = !!aiFn();
      aiBtn.setAttribute('aria-pressed', String(st.m === 'ai'));
      aiBtn.setAttribute('aria-disabled', String(!ok));
      aiBtn.title = ok ? 'Claude expands the query and rates the best claims. Runs only when you press Enter.' : 'AI search is not available in this view (Claude access is missing or was not granted).';
    }
    function toggleAi() {
      if (!aiFn()) { U.toast('AI search is not available here. Full-text search runs entirely in the browser.'); return; }
      st.m = st.m === 'ai' ? '' : 'ai';
      commit();
      if (st.m === 'ai') qInput.focus();
    }
    function drawAiIdle() {
      seq++; teardownBlocks(); res = null;
      U.set(count, 'AI search');
      U.set(results, h('div.empty', null, h('p.overline', { text: 'AI search' }), h('h3', { text: 'Describe your query in your own words' }),
        h('p', { text: 'Claude expands the query with technical terms, searches the independent claims and ranks the best results. The query and claim excerpts are sent to Claude. Press Enter to start.' }),
        h('p', null, h('button.btn.primary', { type: 'button', onclick: function () { st.q = qInput.value.trim(); runAi(); } }, U.icon('spark'), 'Start AI search'))));
    }
    function runAi() {
      var A = aiFn(); if (!A) { drawAi(); return; }
      if (!st.q) { U.toast('Please enter a query first'); return; }
      var my = ++seq; teardownBlocks();
      if (aiCtl) { try { aiCtl.abort(); } catch (e) { /* ignore */ } }
      aiCtl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var status = h('span', { text: 'Claude is working …' });
      U.set(count, h('span.spin'), ' ', status, ' ', h('button.btn.sm', { type: 'button', onclick: function () { if (aiCtl) aiCtl.abort(); seq++; drawAiIdle(); } }, 'Cancel'));
      Promise.resolve().then(function () {
        var STAGE = { expand: 'Expanding query', search: 'Searching claims', rerank: 'Rating claims', done: 'done' };
        function onStage(s) { var k = typeof s === 'string' ? s : s && (s.stage || s.text); status.textContent = (STAGE[k] || k || 'Claude is working') + (s && s.done != null && s.total ? ' (' + s.done + ' of ' + s.total + ')' : '') + ' \u2026'; }
        return afterExt(function () { return A.semanticSearch(st.q, { filters: filters(), n: 60, signal: aiCtl ? aiCtl.signal : undefined, onStage: onStage, onStatus: onStage }); });
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
        U.set(count, h('b', { text: String(hits.length) }), ' patents from AI search', used ? h('span.faint', { text: '  \u00b7 searched with: ' + used }) : null,
          degraded ? h('span', { style: { color: 'var(--warn)' }, text: '  \u00b7 without complete rating by Claude; order partly by full-text rank' }) : null);
        U.clear(results);
        if (!hits.length) { results.appendChild(emptyState()); return; }
        var el = h('div.res-block'); results.appendChild(el);
        blocks = [{ i: 0, el: el, n: hits.length, state: 'empty', data: { hits: hits } }];
        fill(blocks[0]);
        U.set(facets, h('p.faint', { style: { padding: '14px 18px', 'font-size': '13px' }, text: 'Filters apply to AI search when it starts. Counts are available only in full-text search.' }));
      }, function (e) {
        if (my !== seq || destroyed) return;
        if (e && e.code === 'cancelled') { drawAiIdle(); return; }
        var msg = U.errText(e);
        try { if (typeof A.message === 'function' && e && e.code) msg = A.message(e, 'en') || msg; } catch (e2) { /* keep the raw message */ }
        U.set(count, 'AI search failed');
        U.set(results, h('div.empty', null, h('p.overline', { text: 'AI search' }), h('h3', { text: 'Claude did not respond' }), h('p', { text: String(msg) }),
          h('p', null, h('button.btn', { type: 'button', onclick: function () { st.m = ''; commit(); } }, 'Back to full-text search'))));
      });
    }

    /* ---------------- lifecycle */
    fromRoute(route);
    drawBar();
    if (st.m === 'ai' && aiFn()) drawAiIdle(); else { st.m = aiFn() ? st.m : ''; run(); }
    if (!('ontouchstart' in g) && !st.q) setTimeout(function () { if (!destroyed && document.activeElement === document.body) qInput.focus(); }, 30);

    return {
      update: function (r) { fromRoute(r); drawBar(); if (st.m === 'ai' && aiFn()) drawAiIdle(); else run(); return true; },
      destroy: function () { destroyed = true; seq++; live.cancel(); teardownBlocks(); if (ro) ro.disconnect(); offKey(); offExt(); offMarks(); offCaps(); if (aiCtl) { try { aiCtl.abort(); } catch (e) { /* ignore */ } } }
    };
  }

  g.LnpApp.registerView({ id: 'suche', title: 'Search', icon: 'search', mount: mount });
})(window);
