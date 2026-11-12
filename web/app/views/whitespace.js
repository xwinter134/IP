/* LNP Patent Desk: chemistry white-space map. Route: #whitespace[--x<axis>][--y<axis>][--m<compounds|patents|families|claims>][--f<filters>][--s<xi>-x<yi>]
   axis = head, tailC, tailTotal, nTails, linker, amine, unsat, branched (descriptor columns of the chemistry set); f = list of
   cl1 (only compounds with a match in claims), am<class>, hd<head class>; s = the selected cell (column and row index).
   A heat map of how many individually disclosed compounds, publications and families fall into each combination of two
   descriptors. Empty cells are visible as white space. Density of extracted compounds, not of claim scope. The engine is
   LnpDisclosure.grid (engine/x-disclosure.js). */
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

  var METRICS = [['compounds', 'Compounds', 'nCompounds', 'compounds', 'Individually disclosed compounds in the cell'], ['patents', 'Publications', 'nPatents', 'publications', 'Publications in which at least one compound of the cell was found'],
    ['families', 'Families', 'nFamilies', 'families', 'Patent families with at least one publication carrying a compound of the cell'], ['claims', 'In claims', 'nInClaims', 'compounds in claims', 'Compounds found in the claim text of at least one publication']];

  function mount(host, route, App) {
    var K = g.LnpKit, D = g.LnpDisclosure;
    var st = { x: 'head', y: 'tailC', m: 'compounds', cl: false, am: '', hd: '', sx: -1, sy: -1 }, dead = false, seq = 0, detSeq = 0, res = null, axes = D.axes(), cats = {}, offs = [];
    App.chemUsed = true;
    function axisOk(a) { return axes.some(function (x) { return x.id === a; }); }

    function fromRoute(r) {
      var p = r.params, f = R.list(p.f), s = R.list(p.s);
      st.x = axisOk(p.x) ? p.x : 'head'; st.y = axisOk(p.y) ? p.y : 'tailC'; if (st.y === st.x) st.y = st.x === 'tailC' ? 'head' : 'tailC';
      st.m = METRICS.some(function (m) { return m[0] === p.m; }) ? p.m : 'compounds';
      st.cl = false; st.am = ''; st.hd = '';
      f.forEach(function (x) { var m; if (x === 'cl1') st.cl = true; else if ((m = /^am(.+)$/.exec(x))) st.am = m[1]; else if ((m = /^hd(.+)$/.exec(x))) st.hd = m[1]; });
      st.sx = s.length === 2 && /^\d+$/.test(s[0]) && /^\d+$/.test(s[1]) ? +s[0] : -1; st.sy = st.sx >= 0 ? +s[1] : -1;
    }
    function toRoute() {
      var f = []; if (st.cl) f.push('cl1'); if (st.am) f.push('am' + st.am); if (st.hd) f.push('hd' + st.hd);
      return { view: 'whitespace', params: { x: st.x === 'head' ? '' : st.x, y: st.y === 'tailC' ? '' : st.y, m: st.m === 'compounds' ? '' : st.m, f: f, s: st.sx >= 0 ? [String(st.sx), String(st.sy)] : [] } };
    }
    function push(replace) { R.go(toRoute(), { silent: true, replace: !!replace }); }
    function filters() { var f = {}; if (st.cl) f.inClaims = true; if (st.am) f.amine = st.am; if (st.hd) f.head = st.hd; return f; }
    function cleanup() { offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); offs = []; K.tip.hide(); }
    function axLabel(id) { return (axes.filter(function (a) { return a.id === id; })[0] || {}).label || id; }

    /* ---------------------------------------------------------- skeleton */
    function sel(id, label, opts) { var s = h('select.select', { id: id, 'aria-label': label }); opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); }); return s; }
    var axOpts = axes.map(function (a) { return [a.id, a.label]; });
    var xSel = sel('ws-x', 'Columns', axOpts), ySel = sel('ws-y', 'Rows', axOpts);
    var hdSel = sel('ws-hd', 'Head group filter', [['', 'any']]), amSel = sel('ws-am', 'Amine class filter', [['', 'any']]);
    var clChk = h('input.chk', { id: 'ws-cl', type: 'checkbox' });
    var metricSeg = h('div.seg', { role: 'group', 'aria-label': 'Metric' });
    function fl(label, node, id) { return h('div.k-filter', null, h('label.k-filters-l', { 'for': id, text: label }), node); }
    var swap = h('button.btn.sm', { type: 'button', title: 'Swap rows and columns', onclick: function () { var t = st.x; st.x = st.y; st.y = t; st.sx = -1; st.sy = -1; sync(); push(); run(); } }, 'Swap axes');
    var reset = h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.cl = false; st.am = ''; st.hd = ''; st.sx = -1; st.sy = -1; sync(); push(); run(); } }, 'Reset filters');
    var ctl = h('div.ws-ctl', { role: 'group', 'aria-label': 'Map settings' }, fl('Columns', xSel, 'ws-x'), fl('Rows', ySel, 'ws-y'), h('div.k-filter', null, h('span.k-filters-l', { text: 'Count' }), metricSeg),
      fl('Head group', hdSel, 'ws-hd'), fl('Amine', amSel, 'ws-am'), h('label.k-check', { 'for': 'ws-cl' }, clChk, 'only with a match in claims'), swap, reset);
    var body = h('div.cm-body'), detail = h('div.ws-detail-host');
    var how = h('details.k-fold.k-limit', null, h('summary', null, U.icon('help'), h('span', { text: 'How to read this: density of extracted compounds, not claim scope' })),
      h('div.k-fold-body.k-prose', null,
        h('p', { text: 'Each cell counts the compounds that a publication of the corpus discloses individually (a drawn structure, an example, a table entry; source SureChEMBL) and fall into that combination of two structural descriptors. Descriptors are computed from the structure.' }),
        h('p', { text: 'An empty (hatched) cell means that no compound was extracted for that combination. It is not freedom to operate: generic claims with Markush formulae can cover a combination without naming a single compound, and a crowded cell can still be free of claims. Use it to see where the disclosed chemistry clusters, then check claims and the FTO analysis.' })));
    var page = h('div.page.k-page.cm-page', null,
      K.head('White-space map', 'Where the disclosed chemistry', 'is dense, and where it is empty', 'Two structural descriptors against each other: how many compounds, publications and patent families sit in each combination. Click a cell to list its compounds and publications.'),
      ctl, how, body);
    host.appendChild(page);
    METRICS.forEach(function (m) { metricSeg.appendChild(h('button', { type: 'button', title: m[4], data: { m: m[0] }, onclick: function () { st.m = m[0]; sync(); push(true); if (res) drawMap(); } }, m[1])); });
    xSel.addEventListener('change', function () { st.x = xSel.value; if (st.y === st.x) st.y = axes.filter(function (a) { return a.id !== st.x; })[0].id; st.sx = -1; st.sy = -1; sync(); push(); run(); });
    ySel.addEventListener('change', function () { st.y = ySel.value; if (st.x === st.y) st.x = axes.filter(function (a) { return a.id !== st.y; })[0].id; st.sx = -1; st.sy = -1; sync(); push(); run(); });
    hdSel.addEventListener('change', function () { st.hd = hdSel.value; st.sx = -1; st.sy = -1; push(); run(); });
    amSel.addEventListener('change', function () { st.am = amSel.value; st.sx = -1; st.sy = -1; push(); run(); });
    clChk.addEventListener('change', function () { st.cl = clChk.checked; st.sx = -1; st.sy = -1; push(); run(); });
    function fillMenu(selEl, id, cur) {
      D.categories(id).then(function (c) {
        if (dead || selEl.options.length > 1) return;
        c.keys.forEach(function (k, i) { selEl.appendChild(h('option', { value: k, text: c.labels[i] })); });
        selEl.value = cur;
      }, function () { /* the run reports a missing chemistry set */ });
    }
    function sync() {
      xSel.value = st.x; ySel.value = st.y; clChk.checked = st.cl; hdSel.value = st.hd; amSel.value = st.am;
      Array.prototype.forEach.call(metricSeg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.m === st.m ? 'true' : 'false'); });
    }

    /* ---------------------------------------------------------- run */
    function run() {
      var my = ++seq; cleanup(); sync();
      U.set(body, K.busy('Reading the structure descriptors (first use loads about 4 MB)'));
      D.grid({ x: st.x, y: st.y, filters: filters() }).then(function (r) {
        if (my !== seq || dead) return;
        res = r; fillMenu(hdSel, 'head', st.hd); fillMenu(amSel, 'amine', st.am); drawAll();
      }, function (e) {
        if (my !== seq || dead) return;
        res = null; U.set(body, e && e.code === 'no_chem' ? h('p.notice', { text: 'This build contains no structure data, so no map can be drawn.' }) : K.errBox(e, 'The map could not be built'));
      });
    }
    function metric() { for (var i = 0; i < METRICS.length; i++) if (METRICS[i][0] === st.m) return METRICS[i]; return METRICS[0]; }

    function drawAll() {
      var r = res, T = r.totals, empty = 0;
      r.cells.forEach(function (row) { row.forEach(function (c) { if (!c.nCompounds) empty++; }); });
      var cellsN = r.xs.length * r.ys.length;
      var stats = K.stats([['Compounds counted', U.num(r.matched), r.matched < r.n ? 'of ' + U.num(r.n) + ' after the filter' : 'all extracted compounds'], ['Publications', U.num(T.nPatents), U.num(T.nPatentsInClaims) + ' with a match in claims'],
        ['Patent families', U.num(T.nFamilies), null], ['Empty cells', U.num(empty) + ' of ' + U.num(cellsN), 'no compound extracted for the combination']]);
      var mapBox = h('div.ws-mapbox'), secM = K.sec('Map', axLabel(st.y) + ' by ' + axLabel(st.x).toLowerCase(), h('div.k-row', null,
        h('button.btn.sm', { type: 'button', onclick: function () { U.saveFile('whitespace-' + st.x + '-' + st.y + '-' + K.fileStamp() + '.csv', gridCsv(), 'text/csv'); } }, U.icon('download'), 'Grid (CSV)')), mapBox);
      U.set(body, stats, secM, detail, limitsBox(r));
      drawMap(mapBox);
      if (st.sx >= 0) openCell(st.sx, st.sy, true); else U.clear(detail);
    }
    var mapBoxRef = null;
    function drawMap(box) {
      box = box || mapBoxRef; mapBoxRef = box; if (!box || !res) return;
      var r = res, M = metric(), key = M[2], max = r.max[key] || 1, cap = M[3];
      function step(x) { return x <= 0 ? 0 : Math.max(1, Math.min(5, Math.ceil(5 * Math.sqrt(x / max)))); }
      var table = h('table.ws-grid', { role: 'grid', 'aria-label': 'Count of ' + cap + ' by ' + axLabel(st.y) + ' and ' + axLabel(st.x) }), hr = h('tr', null, h('th.ws-corner', { scope: 'col', text: axLabel(st.y) + ' \\ ' + axLabel(st.x) }));
      r.xs.forEach(function (x, xi) { hr.appendChild(h('th', { scope: 'col', 'class': st.sx === xi ? 'ws-sel-h' : null, text: x, title: x })); });
      table.appendChild(h('thead', null, hr));
      var tb = h('tbody');
      r.ys.forEach(function (yl, yi) {
        var tr = h('tr', null, h('th', { scope: 'row', 'class': st.sy === yi ? 'ws-sel-h' : null, text: yl, title: yl }));
        r.xs.forEach(function (xl, xi) {
          var c = r.cells[yi][xi], v = c[key] || 0, b = h('button.ws-cell.k-hm' + step(v), { type: 'button', text: v ? U.num(v) : '·', 'aria-pressed': st.sx === xi && st.sy === yi ? 'true' : 'false',
            'aria-label': yl + ', ' + xl + ': ' + U.num(v) + ' ' + cap + (c.nCompounds ? '' : ' (empty)'), onclick: function () { st.sx = xi; st.sy = yi; push(true); markSel(); openCell(xi, yi); } });
          function tip(ev) { K.tip.show(ev, yl + ' × ' + xl, [['Compounds', U.num(c.nCompounds), null], ['Publications', U.num(c.nPatents), null], ['Families', U.num(c.nFamilies), null], ['Compounds in claims', U.num(c.nInClaims), null]], c.nCompounds ? 'Click to list compounds and publications' : 'No compound extracted for this combination'); }
          b.addEventListener('mousemove', tip); b.addEventListener('focus', tip); b.addEventListener('mouseleave', K.tip.hide); b.addEventListener('blur', K.tip.hide);
          tr.appendChild(h('td', null, b));
        });
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      var scale = h('div.ws-scale', null, h('span', null, h('i.ws-hatch'), 'empty: no compound extracted'), h('div.k-heat-scale', null, h('span', { text: 'few' }), [1, 2, 3, 4, 5].map(function (i) { return h('i.k-hm' + i, { title: 'up to ' + U.num(Math.round(max * Math.pow(i / 5, 2))) }); }), h('span', { text: 'many (max. ' + U.num(max) + ' ' + cap + ')' })));
      U.set(box, h('div.ws-scroll', { tabindex: '-1' }, table), scale);
    }
    function markSel() {
      if (!mapBoxRef) return;
      Array.prototype.forEach.call(mapBoxRef.querySelectorAll('.ws-cell'), function (b) { b.setAttribute('aria-pressed', 'false'); });
      Array.prototype.forEach.call(mapBoxRef.querySelectorAll('.ws-sel-h'), function (b) { b.classList.remove('ws-sel-h'); });
      var rows = mapBoxRef.querySelectorAll('tbody tr'), tr = rows[st.sy];
      if (tr) { tr.children[0].classList.add('ws-sel-h'); var td = tr.children[st.sx + 1]; if (td) td.firstChild.setAttribute('aria-pressed', 'true'); }
      var th = mapBoxRef.querySelectorAll('thead th')[st.sx + 1]; if (th) th.classList.add('ws-sel-h');
    }

    /* ---------------------------------------------------------- cell detail */
    function openCell(xi, yi, quiet) {
      var my = ++detSeq, r = res, c = r.cells[yi] && r.cells[yi][xi];
      if (!c) { U.clear(detail); return; }
      var title = r.ys[yi] + ' × ' + r.xs[xi];
      if (!c.nCompounds) {
        U.set(detail, K.sec('Cell', title, null, h('p.k-note', { text: 'No compound of the corpus was extracted for this combination' + (r.matched < r.n ? ' under the current filter' : '') + '. This does not mean the combination is free: generic claims can still cover it.' })));
        return;
      }
      U.set(detail, K.sec('Cell', title, null, K.busy('Loading the compounds and publications of the cell')));
      if (!quiet) { try { detail.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (e) { /* ignore */ } }
      D.cellDetail(r, xi, yi, { compounds: 48, patents: 60 }).then(function (d) {
        if (my !== detSeq || dead) return;
        var cmps = h('div.ws-cmps');
        d.compounds.forEach(function (x) {
          cmps.appendChild(h('a.ws-cmp', { href: R.build({ view: 'struktur', arg: x.id, params: { m: 'exact', c: x.id } }), title: 'Open in structure search' }, K.mol(x.c, 150, 74, x.id),
            h('span.ws-cmp-id', null, h('span.mono', { text: x.id }), x.inClaims ? h('span.tag.k-clm', { text: 'claims', title: 'Found in the claim text of at least one publication' }) : null),
            h('span.faint', { text: U.num(x.nPat) + ' publ. · ' + U.num(x.nFam) + ' fam. · ' + U.num(Math.round(x.mw)) + ' g/mol' })));
        });
        var pl = h('div.ws-plist');
        d.patents.forEach(function (p) {
          pl.appendChild(h('div.ws-prow', null, p.p >= 0 ? K.patentLink(p.pn, App) : h('span.mono', { text: U.pnPretty(p.pn) }), h('span.faint.mono', { text: p.prio ? U.date(p.prio) : (p.pub ? U.date(p.pub) + ' (pub.)' : '\u2013') }), p.status ? h('span.tag', { text: p.status }) : h('span'), p.title ? h('span.ws-ptitle', { text: p.title }) : null));
        });
        U.set(detail, K.sec('Cell', title, h('div.k-row', null, h('span.k-hint', { text: U.num(c.nCompounds) + ' compounds · ' + U.num(c.nPatents) + ' publications · ' + U.num(c.nFamilies) + ' families · ' + U.num(c.nInClaims) + ' compounds in claims' })),
          h('div.ws-detail', null, h('div.ws-detail-cols', null,
            h('div', null, h('p.k-filters-l', { text: 'Compounds' + (d.nCompounds > d.compounds.length ? ' (first ' + d.compounds.length + ' of ' + U.num(d.nCompounds) + ', claims first, then most publications)' : '') }), cmps),
            h('div', null, h('p.k-filters-l', { text: 'Publications' + (d.truncated || d.nPatents > d.patents.length ? ' (earliest date first, ' + d.patents.length + ' of ' + U.num(d.nPatents) + ')' : ' (earliest date first)') }), pl)))));
      }, function (e) { if (my === detSeq && !dead) U.set(detail, K.sec('Cell', title, null, K.errBox(e, 'The cell could not be listed'))); });
    }

    function gridCsv() {
      var r = res, rows = [['# white-space map: ' + axLabel(st.y) + ' (rows) by ' + axLabel(st.x) + ' (columns)'], ['# ' + r.limits.join(' | ')], [axLabel(st.y), axLabel(st.x), 'compounds', 'publications', 'families', 'compounds_in_claims']];
      r.cells.forEach(function (row, yi) { row.forEach(function (c, xi) { rows.push([r.ys[yi], r.xs[xi], c.nCompounds, c.nPatents, c.nFamilies, c.nInClaims]); }); });
      return U.csv(rows);
    }

    function limitsBox(r) {
      return h('section.cm-limits', { 'aria-label': 'Limits of this result' }, h('p.overline', { text: 'Limits' }),
        h('ul', null, r.limits.map(function (l) { return h('li', { text: l }); })),
        h('p.k-hint', { text: 'Pre-screening aid, not legal advice. ' + (r.cached ? 'Served from the cache.' : 'Computed in your browser in ' + r.ms + ' ms (' + r.msLoad + ' ms to load the descriptor files).') }));
    }

    fromRoute(route); sync(); run();
    return {
      update: function (rt) {
        var o = JSON.stringify(st); fromRoute(rt); var n = JSON.stringify(st); if (n === o) return true;
        sync();
        var a = JSON.parse(o), b = st;
        if (a.x === b.x && a.y === b.y && a.cl === b.cl && a.am === b.am && a.hd === b.hd && res) { if (a.m !== b.m) drawMap(); markSel(); if (b.sx >= 0) openCell(b.sx, b.sy, true); else U.clear(detail); }
        else run();
        return true;
      },
      destroy: function () { dead = true; cleanup(); }
    };
  }

  g.LnpApp.registerView({ id: 'whitespace', title: 'White-space map', icon: 'landscape', rail: false, parent: 'tools', mount: g.LnpLazyView('whitespace', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
