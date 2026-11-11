/* LNP Patent Desk: legal and prosecution timeline. Route: #legal-<publication number> (whole family).
   Also registers the patent-page panel "Legal and prosecution timeline" (LnpApp.ext.patentPanel). Data: engine/x-legal.js.
   Register data only; every text of the register is inserted with textContent. */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  var PILL = { opposition: 'warn', appeal: 'crit', revocation: 'crit', expiry_est: 'info', grant: 'good', filing: 'hollow', priority: 'hollow', publication: 'hollow', fee: 'hollow', lapse: 'hollow', unitary: 'hollow', event: 'hollow' };
  var KEEP = { priority: 1, filing: 1, grant: 1, expiry_est: 1 };           // never folded
  var MINOR = { event: 1, fee: 1, lapse: 1 };                  // folded in the compact panel when the list is long
  var LIM = 'Register snapshot; later events are not seen; not a full file history.';

  function pill(kind) { var L = g.LnpLegal; return h('span.pill.' + (PILL[kind] || 'hollow'), { text: L.KINDS[kind] || kind }); }
  function dateEl(e) { return e.date ? h('span.lg-d.mono', { text: U.date(e.date) }) : h('span.lg-d.mono.lg-nod', { text: 'no date', title: 'The register states this without a date' }); }

  // the timeline list; curPn: entries that belong to other family members show their numbers
  function listNode(entries, o) {
    o = o || {};
    var ol = h('ol.lg-tl'), folded = [];
    entries.forEach(function (e) {
      var li = h('li.lg-it' + (e.hot ? '.hot.' + (e.kind === 'opposition' ? 'warn' : 'crit') : ''), { data: { kind: e.kind } },
        dateEl(e), pill(e.kind), h('span.lg-t', { text: e.text }));
      var other = o.curPn && e.pn.length && e.pn.indexOf(o.curPn) < 0;
      var meta = [];
      if (other || o.showPn) meta.push(e.pn.slice(0, 4).join(', ') + (e.pn.length > 4 ? ' +' + (e.pn.length - 4) : ''));
      if (o.showSrc) meta.push(e.src);
      if (meta.length) li.appendChild(h('span.lg-m.mono', { text: meta.join(' · ') }));
      if (o.compact && !e.hot && !KEEP[e.kind] && (MINOR[e.kind] || (o.curPn && e.pn.indexOf(o.curPn) < 0))) { li.hidden = true; folded.push(li); }
      ol.appendChild(li);
    });
    var box = h('div.lg-box', null, ol);
    if (folded.length) {
      var b = h('button.btn.sm', { type: 'button', style: { 'align-self': 'flex-start' }, onclick: function () { var open = b.dataset.open !== '1'; folded.forEach(function (li) { li.hidden = !open; }); b.dataset.open = open ? '1' : ''; b.textContent = open ? 'Hide ' + folded.length + ' entries' : 'Show ' + folded.length + ' more entries'; } }, 'Show ' + folded.length + ' more entries');
      box.appendChild(b);
    }
    return box;
  }
  function summaryNode(s) {
    var L = g.LnpLegal, row = h('div.lg-sum');
    if (!s.hasStatus) { row.appendChild(h('span.pill.hollow', { text: 'No register data' })); return row; }
    if (s.opposed) row.appendChild(h('span.pill.warn', { text: 'Opposition filed' + (s.outcome && L.OUTCOME[s.outcome] ? ': ' + L.OUTCOME[s.outcome] : '') }));
    else row.appendChild(h('span.pill.hollow', { text: 'No opposition on record' }));
    if (s.appealed) row.appendChild(h('span.pill.crit', { text: 'Appeal on record' }));
    if (s.lapsedCc.length) row.appendChild(h('span.pill.hollow', { text: 'Lapsed in ' + s.lapsedCc.length + (s.lapsedCc.length === 1 ? ' state' : ' states'), title: s.lapsedCc.join(', ') }));
    if (s.unitary) row.appendChild(h('span.pill.hollow', { text: 'Unitary effect ' + s.unitary }));
    return row;
  }
  function asofNode(s) {
    var p = h('p.lg-asof', null, s.asof ? 'Register snapshot of ' : 'No snapshot date. ', s.asof ? h('span.mono', { text: U.date(s.asof) }) : null,
      s.stale ? h('span.pill.warn', { style: { 'margin-left': '8px' }, text: 'older than 6 months', title: 'Events since the snapshot are not shown' }) : null);
    return p;
  }

  /* ------------------------------------------------------------------ patent page panel */
  function registerPanel() {
    var App = g.LnpApp;
    if (!App || !App.ext || typeof App.ext.patentPanel !== 'function') return;
    App.ext.patentPanel({
      id: 'legal', title: 'Legal and prosecution timeline', over: 'Prosecution', order: 20,
      when: function (P) { return !!(P && P.hasStatus); },
      render: function (P, el) {
        var dead = false;
        el.appendChild(h('p.faint', null, h('span.spin'), ' loading'));
        Promise.all([g.LnpLegal.timeline(P), g.LnpLegal.summary(P, { family: true })]).then(function (r) {
          if (dead) return;
          var tl = r[0], s = r[1];
          U.clear(el);
          el.appendChild(summaryNode(s));
          el.appendChild(listNode(tl, { compact: tl.length > 10, curPn: P.pn }));
          el.appendChild(h('p.lg-limits', null, asofNode(s), h('span', { text: LIM }), ' ', h('a', { href: R.build({ view: 'legal', arg: P.pn }) }, 'Open the timeline of the whole family')));
        }, function (e) { if (!dead) U.set(el, h('p.notice.err', { text: 'The timeline could not be built: ' + U.errText(e) })); });
        return function () { dead = true; };
      }
    });
  }

  /* ------------------------------------------------------------------ full view */
  function mount(host, route, App) {
    var D = g.LnpData, L = g.LnpLegal, dead = false, pn0 = route.arg;
    var page = h('div.page.lg-page');
    host.appendChild(page);
    U.set(page, h('div.empty', null, h('p.overline', { text: 'Legal timeline' }), h('h3', { text: U.pnPretty(pn0) || 'Patent' }), h('p', null, h('span.spin'), ' Loading data')));
    function back(P) { return h('p', { style: { 'margin-bottom': '14px' } }, h('a.btn.quiet.sm', { href: P ? App.patentHref(P.pn) : R.build({ view: 'suche', arg: '' }) }, U.icon('back'), P ? 'Patent ' + U.pnPretty(P.pn) : 'Search')); }
    D.byPn(pn0).then(function (p) {
      if (dead) return;
      if (!(p >= 0)) { U.set(page, back(null), h('div.empty', null, h('p.overline', { text: 'Not in dataset' }), h('h3', { text: U.pnPretty(pn0) || 'Unknown number' }), h('p', { text: 'This publication number is not in the dataset.' }))); return; }
      return D.patent(p).then(function (P) {
        return Promise.resolve(D.family(P.p)).then(function (ps) {
          ps = (ps && ps.length ? ps : [P.p]).slice(0, 60);
          return Promise.all(ps.map(function (q) { return Promise.all([D.patent(q), D.status(q).catch(function () { return null; })]).then(function (x) { return { P: x[0], st: x[1] }; }); }));
        }).then(function (members) {
          if (dead) return;
          draw(P, members);
        });
      });
    }).catch(function (e) { if (dead) return; App.logError('legal', e); U.set(page, back(null), h('p.notice.err', { text: 'The timeline could not be loaded: ' + U.errText(e) })); });

    function draw(P, members) {
      var all = L.build(members), sum = L.summarise(P, members.filter(function (m) { return m.P.p === P.p; })[0].st);
      var fam = members.map(function (m) { return L.summarise(m.P, m.st); });
      var asof = fam.map(function (s) { return s.asof; }).filter(Boolean).sort()[0] || null, stale = fam.some(function (s) { return s.stale; });
      var active = {}, listHost = h('div'), kinds = {};
      all.forEach(function (e) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
      function redraw() {
        var on = Object.keys(active).filter(function (k) { return active[k]; });
        var shown = all.filter(function (e) { return !on.length || on.indexOf(e.kind) >= 0; });
        U.set(listHost, shown.length ? listNode(shown, { showPn: true, showSrc: true }) : h('p.faint', { text: 'No entries of this kind.' }));
      }
      var chips = h('div.lg-chips', { role: 'group', 'aria-label': 'Filter by kind' });
      Object.keys(L.KINDS).filter(function (k) { return kinds[k]; }).forEach(function (k) {
        var b = h('button.chip', { type: 'button', 'aria-pressed': 'false', onclick: function () { active[k] = !active[k]; b.setAttribute('aria-pressed', String(!!active[k])); b.classList.toggle('on', !!active[k]); redraw(); } }, L.KINDS[k], h('span.mono', { text: String(kinds[k]) }));
        chips.appendChild(b);
      });
      var tb = h('tbody');
      members.slice().sort(function (a, b) { return String(a.P.pub).localeCompare(String(b.P.pub)); }).forEach(function (m) {
        var s = L.summarise(m.P, m.st);
        tb.appendChild(h('tr', null,
          h('td', null, h('a.mono', { href: App.patentHref(m.P.pn), text: m.P.pn })),
          h('td', null, m.P.status ? U.statusPill(m.P.status) : h('span.pill.hollow', { text: 'No status' })),
          h('td', null, s.opposed ? h('span.pill.warn', { text: s.outcome && L.OUTCOME[s.outcome] ? L.OUTCOME[s.outcome] : 'filed' }) : h('span.faint', { text: s.hasStatus ? 'none' : '–' })),
          h('td', null, s.appealed ? h('span.pill.crit', { text: 'on record' }) : h('span.faint', { text: s.hasStatus ? 'none' : '–' })),
          h('td', null, s.lapsedCc.length ? h('span', { text: s.lapsedCc.length + ' states', title: s.lapsedCc.join(', ') }) : h('span.faint', { text: s.hasStatus ? 'none' : '–' })),
          h('td.mono', { text: s.asof ? U.date(s.asof) : '–' })));
      });
      var lim = h('details.lg-limits-box', null, h('summary', null, U.icon('help'), h('span', { text: 'Limits of this timeline' })), h('ul', null, L.limits().map(function (t) { return h('li', { text: t }); })));
      U.set(page, back(P),
        h('header.page-head', null, h('p.overline', { text: 'Legal timeline' }), h('h1.page-title', { text: 'Family of ' + U.pnPretty(P.pn) }),
          h('p.faint', { text: (P.title || '') }),
          h('p.lg-asof', null, asof ? 'Register snapshot of ' : 'No snapshot date. ', asof ? h('span.mono', { text: U.date(asof) }) : null, stale ? h('span.pill.warn', { style: { 'margin-left': '8px' }, text: 'older than 6 months' }) : null, ' · ', LIM)),
        h('section.sec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Summary' }), h('h2.sec-title', { text: 'This publication' }))), summaryNode(sum)),
        h('section.sec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Family' }), h('h2.sec-title', { text: members.length + (members.length === 1 ? ' member' : ' members') }))),
          h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['Publication', 'Status', 'Opposition', 'Appeal', 'Lapses', 'Snapshot'].map(function (t) { return h('th', { text: t }); }))), tb))),
        h('section.sec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Timeline' }), h('h2.sec-title', { text: 'All dated events of the family' }))), chips, listHost, lim));
      redraw();
    }
    return { destroy: function () { dead = true; } };
  }

  registerPanel();
  g.LnpApp.registerView({ id: 'legal', title: 'Legal timeline', icon: 'family', rail: false, parent: 'suche', mount: mount });
})(window);
