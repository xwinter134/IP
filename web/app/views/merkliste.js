/* LNP Patent Desk: watchlist. Route: #merkliste[--t<tag>][--s<ts|exp|pn>]
   Marked publications (LnpStore "marks": star, tag, note) with status and expiry, bulk actions, and the saved
   searches (LnpStore "searches") with a rerun that marks what is new since the stored snapshot.
   A snapshot is written into the search document: snap = {ts, built, total, pns: "EP1 US2 ..." (up to 5000 results)}. */
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

  var SNAP_MAX = 5000;

  function mount(host, route, App) {
    var K = g.LnpKit, St = g.LnpStore, D = g.LnpData, S = g.LnpSearch;
    var dead = false, tag = '', sort = 'ts', pats = new Map(), sel = new Map(), lastKey = '';
    var listBox = h('div'), searchBox = h('div'), selbar = h('div.selbar', { hidden: true });
    var page = h('div.page.k-page', null,
      K.head('Watchlist', 'Watched publications,', 'with legal status, tag and note', 'The star in the result list and in the patent view puts a publication here. Tag and note can be edited directly in the table.'),
      K.sec('Publications', 'Watchlist', null, listBox), K.sec('Searches', 'Saved searches', null, h('p.k-note', { text: '"Run again" counts the results in the current dataset and shows what has been added since the saved snapshot.' }), searchBox));
    host.appendChild(page); host.appendChild(selbar);

    function fromRoute(r) { tag = r.params.t ? String(r.params.t) : ''; sort = r.params.s === 'exp' || r.params.s === 'pn' ? r.params.s : 'ts'; }
    function marks() { return App.marks.all(); }
    function keyOf(list) { return list.map(function (m) { return m.pn; }).sort().join('|'); }

    function drawSelbar(rows) {
      var n = sel.size; selbar.hidden = !n; if (!n) return;
      U.set(selbar, h('span.grow', { text: K.plural(n, 'publication', 'publications') + ' selected' }),
        h('button.btn', { type: 'button', onclick: function () { sel.clear(); draw(true); } }, 'Clear selection'),
        h('button.btn', { type: 'button', onclick: function () { Array.from(sel.keys()).forEach(function (pn) { App.marks.save(pn, { star: false, tag: '', note: '' }); }); sel.clear(); } }, 'Remove'),
        h('button.btn', { type: 'button', onclick: function () { exportCsv(rows.filter(function (m) { return sel.has(m.pn); })); } }, U.icon('download'), 'CSV'),
        h('button.btn.primary', { type: 'button', onclick: function () { App.handToFto(Array.from(sel.keys()), { from: 'merkliste' }); } }, U.icon('fto'), 'Check FTO'));
    }
    function exportCsv(rows) {
      var out = [['Number', 'Title', 'Player', 'Legal status', 'Expiry (estimate)', 'DE in force', 'Tag', 'Note', 'Changed']];
      rows.forEach(function (m) { var pt = pats.get(m.pn); out.push([m.pn, (pt && pt.title) || m.title || '', (pt && pt.player) || m.player || '', pt ? U.statusLabel(pt.status) : '', pt && pt.exp ? K.iso(pt.exp) : '', pt ? (pt.deIn === 1 ? 'yes' : pt.deIn === 0 ? 'no' : '') : '', m.tag || '', m.note || '', String(m.ts || '').slice(0, 10)]); });
      U.saveFile('lnp-watchlist-' + K.fileStamp() + '.csv', U.csv(out), 'text/csv;charset=utf-8');
    }

    function draw(force) {
      var all = marks(), key = keyOf(all);
      if (!force && key === lastKey && listBox.firstChild) return;      // an inline edit of this view: keep the focus
      lastKey = key;
      Array.from(sel.keys()).forEach(function (pn) { if (!App.marks.get(pn)) sel.delete(pn); });
      U.clear(listBox);
      if (!all.length) {
        listBox.appendChild(h('div.empty.k-empty', null, h('h3', { text: 'Nothing on the watchlist yet' }), h('p', { text: 'In Search, the star next to a result adds the publication; the s key does the same without a mouse. Notes made in the patent view also appear here.' }), h('p', null, h('a.btn', { href: '#suche' }, U.icon('search'), 'Go to Search'))));
        drawSelbar([]); return;
      }
      var tags = {}; all.forEach(function (m) { if (m.tag) tags[m.tag] = (tags[m.tag] || 0) + 1; });
      if (tag && !tags[tag]) tag = '';
      var rows = all.filter(function (m) { return !tag || m.tag === tag; });
      rows.sort(function (a, b) {
        if (sort === 'pn') return a.pn.localeCompare(b.pn);
        if (sort === 'exp') { var ea = (pats.get(a.pn) || {}).exp || 99999999, eb = (pats.get(b.pn) || {}).exp || 99999999; return ea - eb; }
        return String(b.ts || '').localeCompare(String(a.ts || ''));
      });
      var chips = h('div.k-chips', { role: 'group', 'aria-label': 'Filter by tag' }, h('button.chip' + (!tag ? '.on' : ''), { type: 'button', onclick: function () { R.go({ view: 'merkliste', params: { s: sort === 'ts' ? '' : sort } }); } }, 'All ', h('span.mono', { text: String(all.length) })));
      Object.keys(tags).sort().forEach(function (t) { chips.appendChild(h('button.chip' + (tag === t ? '.on' : ''), { type: 'button', onclick: function () { R.go({ view: 'merkliste', params: { t: t, s: sort === 'ts' ? '' : sort } }); } }, t + ' ', h('span.mono', { text: String(tags[t]) }))); });
      var sortSel = h('select.select', { id: 'ml-sort', 'aria-label': 'Sort order' }, [['ts', 'Last changed'], ['exp', 'Expiry, earliest first'], ['pn', 'Number']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      sortSel.value = sort; sortSel.addEventListener('change', function () { R.go({ view: 'merkliste', params: { t: tag, s: sortSel.value === 'ts' ? '' : sortSel.value } }); });
      var allCb = h('input.chk', { type: 'checkbox', 'aria-label': 'Select all', checked: rows.length > 0 && rows.every(function (m) { return sel.has(m.pn); }), onchange: function () { rows.forEach(function (m) { if (allCb.checked) sel.set(m.pn, 1); else sel.delete(m.pn); }); draw(true); } });
      var tb = h('tbody');
      rows.forEach(function (m) {
        var pt = pats.get(m.pn), state = h('span.note-state');
        var cb = h('input.chk', { type: 'checkbox', checked: sel.has(m.pn), 'aria-label': 'Select ' + m.pn, onchange: function () { if (cb.checked) sel.set(m.pn, 1); else sel.delete(m.pn); allCb.checked = rows.every(function (x) { return sel.has(x.pn); }); drawSelbar(rows); } });
        var tagIn = h('input.input.k-cell-in', { type: 'text', value: m.tag || '', maxlength: '40', placeholder: 'Tag', 'aria-label': 'Tag for ' + m.pn, list: 'ml-tags' });
        var noteIn = h('textarea.textarea.k-cell-in', { rows: '1', maxlength: '2000', placeholder: 'Note', 'aria-label': 'Note for ' + m.pn }); noteIn.value = m.note || '';
        function saved() { state.textContent = 'saved'; setTimeout(function () { if (state.isConnected) state.textContent = ''; }, 1800); }
        tagIn.addEventListener('change', function () { App.marks.save(m.pn, { tag: tagIn.value.trim() }).then(saved); });
        noteIn.addEventListener('change', function () { App.marks.save(m.pn, { note: noteIn.value.trim() }).then(saved); });
        tb.appendChild(h('tr', null, h('td', null, cb), h('td', null, K.patentLink(m.pn, App), m.star ? null : h('div.faint.k-small', { text: 'note only' })),
          h('td.t', null, h('span', { text: (pt && pt.title) || m.title || '' }), h('br'), h('span.faint', { text: (pt && (pt.player || pt.assignee)) || m.player || '' })),
          h('td', null, pt ? U.statusPill(pt.status) : h('span.faint', { text: pt === null ? 'not in dataset' : '…' }), pt ? U.dePill(pt.deIn) : null),
          h('td.mono', { text: pt ? K.expiryText(pt) : '' }), h('td', null, tagIn), h('td.k-note-cell', null, noteIn, state), h('td.mono', { text: U.date(String(m.ts || '').slice(0, 10)) }),
          h('td', null, h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Remove ' + m.pn + ' from the watchlist', title: 'Remove', onclick: function () { App.marks.save(m.pn, { star: false, note: '', tag: '' }); } }, U.icon('x')))));
      });
      listBox.appendChild(h('div.k-row.k-between', null, chips, h('span.k-row', null, sortSel,
        h('button.btn.sm', { type: 'button', onclick: function () { exportCsv(rows); } }, U.icon('download'), 'CSV'),
        h('button.btn.primary.sm', { type: 'button', onclick: function () { App.handToFto(rows.map(function (m) { return m.pn; }), { from: 'merkliste' }); } }, U.icon('fto'), 'All to FTO check'))));
      listBox.appendChild(h('datalist', { id: 'ml-tags' }, Object.keys(tags).sort().map(function (t) { return h('option', { value: t }); })));
      listBox.appendChild(h('div.table-wrap', null, h('table.data.k-marks', null, h('thead', null, h('tr', null, h('th', null, allCb), ['Number', 'Title and applicant', 'Legal status', 'Expiry', 'Tag', 'Note', 'Changed', ''].map(function (t) { return h('th', { text: t }); }))), tb)));
      listBox.appendChild(h('p.k-hint', { text: 'Legal status as per the dataset of ' + U.date(((App.manifest || {}).snapshots || {}).ep_register) + ' (EP Register); expiry is an estimate.' }));
      drawSelbar(rows);
      var missing = all.map(function (m) { return m.pn; }).filter(function (pn) { return !pats.has(pn); });
      if (missing.length) K.patentsByPn(missing).then(function (map) { if (dead) return; map.forEach(function (v, k) { pats.set(k, v); }); draw(true); });
    }

    /* ---------------------------------------------------------- saved searches */
    function drawSearches() {
      St.entries('searches').then(function (rows) {
        if (dead) return;
        U.clear(searchBox);
        if (!rows.length) { searchBox.appendChild(h('p.k-hint', { text: 'No search saved yet. In Search, "Save" stores the current query with its filters here.' })); return; }
        var box = h('div.k-searches');
        rows.forEach(function (r) {
          var v = r.value || {}, res = h('div.k-search-res'), snap = v.snap || null, base = snap ? snap.ts : v.ts, del = null, armed = false;
          var btn = h('button.btn.sm', { type: 'button', onclick: function () { rerun(r, res, btn); } }, 'Run again');
          del = h('button.btn.quiet.sm', { type: 'button', onclick: function () {
            if (!armed) { armed = true; U.set(del, 'Really delete?'); setTimeout(function () { armed = false; if (del.isConnected) U.set(del, 'Delete'); }, 4000); return; }
            St.remove('searches', r.id).then(drawSearches, function (e) { U.toast('Delete failed: ' + U.errText(e), { error: true }); });
          } }, 'Delete');
          box.appendChild(h('div.k-search', null, h('div.k-search-head', null,
            h('div.k-search-t', null, h('b', { text: v.name || v.q || 'Search' }), h('div.mono.k-query', { text: v.q || '(filters only)' }),
              h('div.faint.k-small', { text: 'As of ' + U.date(String(base || '').slice(0, 10)) + (snap ? ' · ' + U.num(snap.total) + ' results' : v.total != null ? ' · ' + U.num(v.total) + ' results when saved' : '') })),
            h('span.k-row', null, btn, h('a.btn.sm', { href: v.hash || R.build({ view: 'suche', arg: v.q || '' }) }, 'Open in Search'), del)), res));
        });
        searchBox.appendChild(box);
      }, function (e) { if (!dead) U.set(searchBox, K.errBox(e, 'The saved searches could not be read')); });
    }
    function rerun(r, res, btn) {
      var v = r.value || {}, snap = v.snap || null;
      btn.disabled = true; U.set(res, K.busy('Searching'));
      S.search(v.q || '', { filters: v.filters || {}, limit: 1, facets: false, snippets: false, all: true, sort: 'date' }).then(function (out) {
        var ps = out.all ? Array.prototype.slice.call(out.all) : (out.hits || []).map(function (x) { return x.p; }), total = ps.length;
        if (total > SNAP_MAX) return { total: total, big: true, rows: [], fresh: [], pns: null };
        return D.patents(ps).then(function (rows) {
          var fresh, mode;
          if (snap && typeof snap.pns === 'string') { var old = new Set(snap.pns.split(' ')); fresh = rows.filter(function (p) { return !old.has(p.pn); }); mode = 'set'; }
          else { var d0 = U.ymd(String(v.ts || '').slice(0, 10)); fresh = rows.filter(function (p) { return p.pub > d0; }); mode = 'date'; }
          return { total: total, rows: rows, fresh: fresh, mode: mode, pns: rows.map(function (p) { return p.pn; }).join(' ') };
        });
      }).then(function (x) {
        if (dead) return;
        btn.disabled = false;
        var before = snap ? snap.total : v.total, diff = before != null ? x.total - before : null;
        function keep() {
          var doc = Object.assign({}, v, { snap: { ts: new Date().toISOString(), built: (App.manifest || {}).built || null, total: x.total, pns: x.pns } });
          St.put('searches', r.id, doc).then(function () { U.toast('Snapshot saved'); drawSearches(); }, function (e) { U.toast('Save failed: ' + U.errText(e), { error: true }); });
        }
        U.clear(res);
        res.appendChild(h('p.k-sub', null, h('b', { text: K.plural(x.total, 'publication', 'publications') }), ' in the dataset of ' + U.date(String((App.manifest || {}).built || '').slice(0, 10)) + (diff != null ? ' · ' + (diff === 0 ? 'unchanged' : (diff > 0 ? '+' : '') + U.num(diff)) + ' compared with the saved snapshot' : ''), ' ',
          x.big ? null : h('span.pill.' + (x.fresh.length ? 'info' : 'hollow'), { text: x.fresh.length ? x.fresh.length + ' new' : 'nothing new' })));
        if (x.big) res.appendChild(h('p.k-hint', { text: 'With more than ' + U.num(SNAP_MAX) + ' results only the count is compared. A narrower search lists the new publications individually.' }));
        else {
          if (x.mode === 'date') res.appendChild(h('p.k-hint', { text: 'This search has no stored result snapshot yet. Publications published after the search was saved therefore count as new. "Save snapshot" records today\'s result list; after that the comparison is exact.' }));
          if (x.fresh.length) {
            var tb = h('tbody');
            x.fresh.slice(0, 25).forEach(function (p) { tb.appendChild(h('tr', null, h('td', null, h('span.tag.seed', { text: 'new' })), h('td', null, K.patentLink(p.pn, App)), h('td.t', { text: p.title || '' }), h('td.mono', { text: U.date(p.pub) }), h('td', null, U.statusPill(p.status)))); });
            res.appendChild(h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['', 'Number', 'Title', 'Published', 'Legal status'].map(function (t) { return h('th', { text: t }); }))), tb)));
            if (x.fresh.length > 25) res.appendChild(h('p.k-hint', { text: 'Showing 25 of ' + x.fresh.length + ' new publications.' }));
          }
        }
        res.appendChild(h('div.k-row', null, x.big ? null : h('button.btn.sm', { type: 'button', onclick: keep }, 'Save snapshot'),
          !x.big && x.fresh.length ? h('button.btn.sm', { type: 'button', onclick: function () { App.handToFto(x.fresh.map(function (p) { return p.pn; }), { from: 'merkliste', q: v.q || '' }); } }, U.icon('fto'), 'New ones to FTO check') : null));
      }).catch(function (e) { if (dead) return; btn.disabled = false; U.set(res, K.errBox(e, 'The search failed')); });
    }

    fromRoute(route); draw(true); drawSearches();
    var off = App.on('marks', function () { if (!dead) draw(false); });
    return {
      update: function (r) { fromRoute(r); draw(true); return true; },
      destroy: function () { dead = true; off(); if (selbar.parentNode) selbar.parentNode.removeChild(selbar); }
    };
  }
  g.LnpApp.registerView({ id: 'merkliste', title: 'Watchlist', icon: 'star', mount: g.LnpLazyView('merkliste', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
