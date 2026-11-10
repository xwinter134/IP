/* LNP Patent Desk: family view and claim comparison. Route: #familie-<publication number>[--a<pn left>][--b<pn right>] */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;

  function mount(host, route, App) {
    var D = g.LnpData, S = g.LnpSearch, destroyed = false, seq = 0;
    var st = { pn: route.arg, a: typeof route.params.a === 'string' ? route.params.a : '', b: typeof route.params.b === 'string' ? route.params.b : '' };
    var page = h('div.page'), members = [], cmpBox = null, selA = null, selB = null;
    host.appendChild(page);
    page.appendChild(h('div.empty', null, h('p.overline', { text: 'Family' }), h('h3', { text: U.pnPretty(st.pn) }), h('p', null, h('span.spin'), ' Loading family')));

    D.byPn(st.pn).then(function (p) {
      if (destroyed) return;
      if (!(p >= 0)) { U.set(page, h('div.empty', null, h('p.overline', { text: 'Not in dataset' }), h('h3', { text: U.pnPretty(st.pn) || 'Unknown number' }), h('p', { text: 'There is no family for this number in the dataset.' }), h('p', null, h('a.btn', { href: '#suche' }, 'Go to Search')))); return; }
      return D.family(p).then(function (ps) { return D.patents(ps && ps.length ? ps : [p]); }).then(function (ms) { if (destroyed) return; members = ms; build(p); });
    }).catch(function (e) { if (!destroyed) { App.logError('familie', e); U.set(page, h('p.notice.err', { text: 'The family could not be loaded: ' + U.errText(e) })); } });

    function rank(m, auth) { return (m.auth === auth ? 8 : 0) + (m.text ? 4 : 0) + (/^B/.test(m.kind) ? 2 : 0) + (m.status === 'granted' ? 1 : 0) + m.pub / 1e9; }
    function build(p) {
      members.sort(function (a, b) { return a.auth.localeCompare(b.auth) || a.pub - b.pub; });
      var me = members.filter(function (m) { return m.p === p; })[0] || members[0];
      var withText = members.filter(function (m) { return m.text; });
      function best(auth, not) { var c = withText.filter(function (m) { return m.auth === auth && m.pn !== not; }).sort(function (x, y) { return rank(y, auth) - rank(x, auth); })[0]; return c ? c.pn : ''; }
      function has(pn) { return withText.some(function (m) { return m.pn === pn; }); }
      if (!has(st.a)) st.a = (me.text && me.auth === 'EP') ? me.pn : best('EP') || (withText[0] || {}).pn || '';
      if (!has(st.b) || st.b === st.a) st.b = (me.text && me.auth === 'US' && me.pn !== st.a) ? me.pn : best('US', st.a) || (withText.filter(function (m) { return m.pn !== st.a; })[0] || {}).pn || '';

      var tbl = h('table.data', null, h('thead', null, h('tr', null, ['Number', 'Title', 'Legal status', 'Published', 'Expiry (estimate)', 'Full text'].map(function (t) { return h('th', { text: t }); }))));
      var tb = h('tbody'); tbl.appendChild(tb);
      members.forEach(function (m) {
        tb.appendChild(h('tr', null,
          h('td', null, h('a.mono', { href: App.patentHref(m.pn), text: m.pn })),
          h('td.t', { text: m.title || '' }),
          h('td', null, U.statusPill(m.status), ' ', U.dePill(m.deIn)),
          h('td.mono', { style: { 'white-space': 'nowrap' }, text: U.date(m.pub) }), h('td.mono', { text: m.exp ? U.date(m.exp) : '–' }),
          h('td', { text: m.text ? 'yes' : m.textCut ? 'not included' : 'no' })));
      });

      function picker(id, label, val) {
        var s = h('select.select', { id: id, 'aria-label': label });
        withText.forEach(function (m) { s.appendChild(h('option', { value: m.pn, selected: m.pn === val, text: m.pn + '  ' + U.statusLabel(m.status) + ', ' + U.year(m.pub) })); });
        s.addEventListener('change', function () { st.a = selA.value; st.b = selB.value; R.go({ view: 'familie', arg: st.pn, params: { a: st.a, b: st.b } }, { replace: true, silent: true }); compare(); });
        return s;
      }
      selA = picker('cmp-a', 'Left publication', st.a); selB = picker('cmp-b', 'Right publication', st.b);
      cmpBox = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } });
      U.set(page,
        h('p', { style: { 'margin-bottom': '14px' } }, h('a.btn.quiet.sm', { href: App.patentHref(me.pn) }, U.icon('back'), U.pnPretty(me.pn))),
        h('header.page-head', null, h('p.overline', { text: 'Family' + (me.seedFam ? ' · ' + me.seedFam : '') }), h('h1.page-title', null, (me.title || U.pnPretty(me.pn)) + ' ', h('span.light', { text: members.length + (members.length === 1 ? ' member' : ' members') })),
          h('p.lead', { text: (me.player ? me.player + ' · ' : '') + 'Priority ' + U.date(me.prio) + ' · Family ' + me.fam })),
        h('section.sec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Members' }), h('h2.sec-title', { text: 'Publications in the dataset' }))), h('div.table-wrap', null, tbl)),
        h('section.sec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Comparison' }), h('h2.sec-title', { text: 'Independent claims side by side' }))),
          withText.length >= 2 ? h('div.cmp-pick', null, h('label', null, 'Left', selA), h('label', null, 'Right', selB)) : null, cmpBox));
      if (withText.length < 2) cmpBox.appendChild(h('p.notice', { text: withText.length ? 'Only ' + withText[0].pn + ' has full text in the dataset. A comparison needs two publications with claims.' : 'No member of this family has full text in the dataset.' }));
      else compare();
    }

    function wordSet(t) { var s = {}; (String(t).toLowerCase().match(/[a-z0-9À-ɏ]+/g) || []).forEach(function (w) { s[w] = 1; }); return s; }
    function jac(a, b) { var i = 0, u = 0, k; for (k in a) { u++; if (b[k]) i++; } for (k in b) if (!a[k]) u++; return u ? i / u : 0; }
    function compare() {
      var my = ++seq, A = members.filter(function (m) { return m.pn === st.a; })[0], B = members.filter(function (m) { return m.pn === st.b; })[0];
      if (!A || !B) return;
      U.set(cmpBox, h('p.faint', null, h('span.spin'), ' Loading claims'));
      Promise.all([S.claims(A.p), S.claims(B.p)]).then(function (r) {
        if (destroyed || my !== seq) return;
        function pick(list) { var en = list.filter(function (c) { return c.lang === 'en'; }); return (en.length ? en : list.filter(function (c) { return c.lang === 'de'; })); }
        var ca = pick(r[0] || []), cb = pick(r[1] || []), ia = ca.filter(function (c) { return c.indep; }), ib = cb.filter(function (c) { return c.indep; });
        U.clear(cmpBox);
        if (!ia.length || !ib.length) { cmpBox.appendChild(h('p.notice', { text: 'At least one of the two publications has no independent claims in English or German in the dataset.' })); return; }
        if (ca[0].lang !== cb[0].lang) cmpBox.appendChild(h('p.notice', { text: 'The claims are in different languages (' + ca[0].lang.toUpperCase() + ' and ' + cb[0].lang.toUpperCase() + '); a word comparison is of limited value then.' }));
        cmpBox.appendChild(h('p.faint', { style: { 'font-size': '13px' } }, 'Each independent claim on the left is paired with the most similar independent claim on the right. ', h('del', { style: { background: 'var(--del-bg)', 'text-decoration': 'none', padding: '0 3px', 'border-radius': '2px' }, text: 'left only' }), ' ', h('ins', { style: { background: 'var(--ins-bg)', 'text-decoration': 'none', padding: '0 3px', 'border-radius': '2px' }, text: 'right only' })));
        var sb = ib.map(function (c) { return wordSet(c.text); }), used = {};
        var grid = h('div.cmp');
        ia.forEach(function (c) {
          var sa = wordSet(c.text), bi = -1, bs = -1;
          sb.forEach(function (s, j) { var v = jac(sa, s); if (v > bs) { bs = v; bi = j; } });
          var o = ib[bi]; used[bi] = 1;
          var d = U.diffWords(c.text, o.text);
          grid.appendChild(cell(A, c, d.same, U.diffNodes(h('div.cmp-text'), d.a, 'del')));
          grid.appendChild(cell(B, o, null, U.diffNodes(h('div.cmp-text'), d.b, 'ins')));
        });
        ib.forEach(function (o, j) {
          if (used[j]) return;
          grid.appendChild(h('div.cmp-cell', null, h('p.faint', { text: 'No closer claim on the left' })));
          var t = h('div.cmp-text'); t.textContent = o.text;
          grid.appendChild(cell(B, o, null, t));
        });
        cmpBox.appendChild(grid);
      }, function (e) { if (!destroyed && my === seq) U.set(cmpBox, h('p.notice.err', { text: 'Could not load claims: ' + U.errText(e) })); });
    }
    function cell(m, c, same, textEl) {
      return h('div.cmp-cell', null,
        h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'baseline', 'flex-wrap': 'wrap' } },
          h('a.mono', { href: App.patentHref(m.pn, { claim: c.n }), text: m.pn, style: { 'font-weight': '500' } }), h('span', { text: 'Claim ' + c.n }),
          same != null ? h('span.faint.mono', { style: { 'margin-left': 'auto' }, text: Math.round(same * 100) + '% of words identical' }) : null),
        textEl);
    }

    return {
      update: function (r) { return false; },
      destroy: function () { destroyed = true; seq++; }
    };
  }

  g.LnpApp.registerView({ id: 'familie', title: 'Family', icon: 'family', parent: 'suche', mount: mount });
})(window);
