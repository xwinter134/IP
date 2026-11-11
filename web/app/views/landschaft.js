/* LNP Patent Desk: landscape view. Route: #landschaft[--r<alle|kern>]
   Charts over LnpData.all(): filings per priority year by player (stacked), top players, CPC subclasses, expiry
   wave of rights in force, status mix, player x CPC heat map. Every mark links into the search view. */
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

  var CPC_DE = { A61K: 'Medicinal preparations', A61P: 'Therapeutic activity', C12N: 'Genetic engineering, nucleic acids, enzymes', C07C: 'Acyclic and carbocyclic compounds', C07D: 'Heterocyclic compounds', C07K: 'Peptides',
    C07H: 'Sugars, nucleosides, nucleic acids', C07F: 'Organometallic compounds (P, Si)', C07J: 'Steroids', C08G: 'Polycondensates, polyethers (PEG)', C08L: 'Polymer compositions', B82Y: 'Nanotechnology',
    B01J: 'Chemical processes, colloid chemistry', B01F: 'Mixing', C12Q: 'Assays involving nucleic acids', G01N: 'Analysis', A61L: 'Materials for medical devices', A61Q: 'Cosmetic use', C12P: 'Fermentation', A61J: 'Containers, administration',
    C12Y: 'Enzymes (index)', Y02A: 'Climate change adaptation (index)', A61M: 'Delivery devices', C09K: 'Other materials', A61B: 'Diagnosis, surgery', C11D: 'Detergents', A23L: 'Foods', C08F: 'Polymers', A01N: 'Biocides, preservation', Y10S: 'Former US classes (index)', Y10T: 'Former US classes (index)', C12M: 'Apparatus for microbiology' };
  var STATUS_GROUPS = [['granted', 'Granted, term running', 0, ['granted']], ['pending', 'Pending', 1, ['pending']], ['dead', 'No longer in force', -1, ['lapsed', 'revoked', 'withdrawn', 'refused', 'expired']], ['open', 'Legal status open', -2, ['unknown', '']]];

  function mount(host, route, App) {
    var K = g.LnpKit, C = g.LnpChart, D = g.LnpData, M = App.manifest, dead = false, offs = [];
    var scope = route.params.r === 'kern' ? 'kern' : 'alle', A = null;
    var body = h('div'), scopeSeg = h('div.seg', { role: 'group', 'aria-label': 'Scope' });
    var page = h('div.page.k-page', null,
      K.head('Landscape', 'Who files what,', 'and when it expires', 'Analysis of the patent table in the browser. Patent families are counted; for legal status and expiry, individual applications. Every column, bar and cell opens the matching selection in the search, where publications are counted.'),
      h('div.k-filters', null, h('span.k-filters-l', { text: 'Scope' }), scopeSeg), body);
    host.appendChild(page);
    [['alle', 'Whole dataset'], ['kern', 'Core dataset']].forEach(function (x) {
      scopeSeg.appendChild(h('button', { type: 'button', 'aria-pressed': scope === x[0] ? 'true' : 'false', title: x[0] === 'kern' ? 'Key families and tiers 1 to 2 of the field definition' : 'All publications in the table, including the wider periphery', onclick: function () { R.go({ view: 'landschaft', params: x[0] === 'kern' ? { r: 'kern' } : {} }); } }, x[1]));
    });
    function setScope(s) { scope = s; Array.prototype.forEach.call(scopeSeg.children, function (b, i) { b.setAttribute('aria-pressed', (i === 0) === (s === 'alle') ? 'true' : 'false'); }); if (A) draw(); }
    function cleanup() { offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); offs = []; K.tip.hide(); }

    function sUrl(arg, params) {
      var p = Object.assign({}, params || {});
      if (scope === 'kern') p.r = ['0', '1', '2'];
      return R.build({ view: 'suche', arg: arg || '', params: p });
    }

    function aggregate() {
      var n = A.n, today = U.today(), thisYear = Math.floor(today / 10000), core = scope === 'kern';
      var fams = new Map(), apps = new Map(), i;
      for (i = 0; i < n; i++) {
        if (core && !(A.tier[i] <= 2 || A.seedTier[i] > 0)) continue;
        var f = A.fam[i], rec = fams.get(f);
        var y = Math.floor((A.prio[i] || A.app[i] || A.pub[i]) / 10000);
        if (!rec) { rec = { y: y, pl: -1, c: null }; fams.set(f, rec); }
        if (y && (!rec.y || y < rec.y)) rec.y = y;
        if (rec.pl < 0 && A.player[i] >= 0) rec.pl = A.player[i];
        var cs = A.cpc[i];
        if (cs) { if (!rec.c) rec.c = {}; var parts = cs.split('|'); for (var j = 0; j < parts.length; j++) rec.c[parts[j].slice(0, 4)] = 1; }
        if (A.auth[i] === 'WO') continue;
        var key = A.auth[i] + (A.appNo[i] || A.pn[i]), old = apps.get(key);
        if (old == null || A.pub[i] > A.pub[old]) apps.set(key, i);
      }
      var nPl = A.players.length, byPlayer = new Array(nPl).fill(0), cpc = {}, yearMin = 2000, yearMax = thisYear, named = 0;
      fams.forEach(function (r) { if (r.pl >= 0) { byPlayer[r.pl]++; named++; } if (r.c) for (var k in r.c) cpc[k] = (cpc[k] || 0) + 1; });
      var order = byPlayer.map(function (v, idx) { return idx; }).filter(function (idx) { return byPlayer[idx] > 0; }).sort(function (a, b) { return byPlayer[b] - byPlayer[a]; });
      var top = order.slice(0, 7), rest = order.slice(7), slot = {}; top.forEach(function (idx, k) { slot[idx] = k; });
      var years = []; for (var yy = yearMin; yy <= yearMax; yy++) years.push(yy);
      var series = top.map(function (idx, k) { return { name: A.players[idx], color: C.color(k), values: years.map(function () { return 0; }), players: [idx] }; });
      if (rest.length) series.push({ name: 'Other players (' + rest.length + ')', color: C.OTHER, values: years.map(function () { return 0; }), players: rest });
      var before = 0;
      fams.forEach(function (r) {
        if (r.pl < 0) return;
        if (r.y < yearMin) { before++; return; }
        if (r.y > yearMax) return;
        var sidx = slot[r.pl] != null ? slot[r.pl] : series.length - 1;
        series[sidx].values[r.y - yearMin]++;
      });
      var cpcTop = Object.keys(cpc).sort(function (a, b) { return cpc[b] - cpc[a]; });
      // heat map: top 12 players x top 10 subclasses
      var hp = order.slice(0, 12), hc = cpcTop.slice(0, 10), hv = hp.map(function () { return hc.map(function () { return 0; }); }), hpi = {}, hci = {};
      hp.forEach(function (idx, k) { hpi[idx] = k; }); hc.forEach(function (c, k) { hci[c] = k; });
      fams.forEach(function (r) { if (r.pl < 0 || hpi[r.pl] == null || !r.c) return; for (var k in r.c) if (hci[k] != null) hv[hpi[r.pl]][hci[k]]++; });
      // rights: one record per application
      var exp = {}, st = { EP: {}, US: {} }, inForce = 0, expMax = thisYear + 22;
      apps.forEach(function (idx) {
        var au = A.auth[idx], code = A.statusCodes[A.st[idx]] || '', e = A.exp[idx];
        if (code === 'granted' && e && e < today) code = 'expired';
        if (st[au]) st[au][code] = (st[au][code] || 0) + 1;
        if (code === 'granted' && e >= today) {
          inForce++;
          var ey = Math.min(expMax, Math.floor(e / 10000));
          (exp[ey] = exp[ey] || { EP: 0, US: 0 })[au]++;
        }
      });
      var expYears = []; for (var ye = thisYear; ye <= expMax; ye++) expYears.push(ye);
      var peak = expYears.reduce(function (best, yv) { var v = exp[yv] ? exp[yv].EP + exp[yv].US : 0; return v > best[1] ? [yv, v] : best; }, [0, 0]);
      return { families: fams.size, named: named, before: before, years: years, series: series, order: order, byPlayer: byPlayer, cpc: cpc, cpcTop: cpcTop, hp: hp, hc: hc, hv: hv, exp: exp, expYears: expYears, expMax: expMax, st: st, inForce: inForce, peak: peak, apps: apps.size, thisYear: thisYear };
    }

    function chartSec(over, title, note) {
      var box = h('div.k-chartbox'), sec = K.sec(over, title, null, note ? h('p.k-note', { text: note }) : null, box);
      sec.classList.add('k-chartsec');
      return { sec: sec, box: box };
    }

    function draw() {
      cleanup();
      var X = aggregate(), grid = h('div.k-grid2');
      U.set(body,
        K.stats([
          ['Patent families', U.num(X.families), scope === 'kern' ? 'in the core dataset' : 'in the whole dataset'],
          ['With an assigned player', U.num(X.named), X.order.length + ' players observed'],
          ['Granted rights with term running', U.num(X.inForce), 'EP and US, per application, term estimated'],
          ['Peak expiry year', X.peak[0] ? String(X.peak[0]) : '–', X.peak[0] ? U.num(X.peak[1]) + ' rights expire' : null]]),
        grid);

      // 1 filings per year by player
      var c1 = chartSec('Filings', 'New families of the observed players per priority year', 'Year of the earliest priority. The last 18 months are incomplete because applications are only published after that time.' + (X.before ? ' ' + U.num(X.before) + ' families before 2000 are not drawn.' : ''));
      c1.sec.classList.add('wide'); grid.appendChild(c1.sec);
      if (X.series.length) {
        offs.push(C.stacked(c1.box, { cats: X.years, series: X.series, unit: 'families', height: 280, label: 'New patent families per priority year, stacked by player',
          onClick: function (ci, si) { var ps = si >= 0 ? X.series[si].players : X.order; R.go(sUrl('prio:' + X.years[ci], { p: ps.map(String) })); } }));
        C.table(c1.box, { head: ['Year'].concat(X.series.map(function (x) { return x.name; })), rows: X.years.map(function (y, i) { return [String(y)].concat(X.series.map(function (x) { return x.values[i]; })); }) });
      } else c1.box.appendChild(h('p.faint', { text: 'In this scope no family is assigned to a player.' }));

      // 2 top players
      var c2 = chartSec('Players', 'Families per player', 'Assigned via name variants of the applicants; publications with no match remain without a player.');
      grid.appendChild(c2.sec);
      C.hbars(c2.box, { unit: 'families', color: 'var(--s1)', rows: X.order.slice(0, 15).map(function (idx) { return { label: A.players[idx], value: X.byPlayer[idx], href: sUrl('', { p: [String(idx)] }) }; }) });

      // 3 CPC
      var c3 = chartSec('Classes', 'Families per CPC subclass', 'A family counts in every subclass in which one of its publications is classified.');
      grid.appendChild(c3.sec);
      C.hbars(c3.box, { unit: 'families', color: 'var(--s3)', rows: X.cpcTop.slice(0, 15).map(function (c) { return { label: c + (CPC_DE[c] ? '  ' + CPC_DE[c] : ''), value: X.cpc[c], href: sUrl('', { c: [c] }) }; }) });

      // 4 expiry wave
      var c4 = chartSec('Expiry', 'When granted rights expire', 'Granted EP and US patents whose estimated term has not yet ended, by expiry year. Estimate: filing date plus 20 years, US with term adjustment. Rights lapsed for unpaid fees are recorded for EP only.');
      c4.sec.classList.add('wide'); grid.appendChild(c4.sec);
      var eSeries = [{ name: 'EP', color: 'var(--s1)', values: X.expYears.map(function (y) { return (X.exp[y] || {}).EP || 0; }) }, { name: 'US', color: 'var(--s2)', values: X.expYears.map(function (y) { return (X.exp[y] || {}).US || 0; }) }];
      offs.push(C.stacked(c4.box, { cats: X.expYears.map(function (y) { return y === X.expMax ? y + '+' : y; }), series: eSeries, unit: 'rights', height: 240, label: 'Granted rights by estimated expiry year, EP and US',
        onClick: function (ci, si) { var y = X.expYears[ci]; R.go(sUrl('exp:' + (y === X.expMax ? y + '-' : y) + ' status:granted', si >= 0 ? { a: [eSeries[si].name] } : { a: ['EP', 'US'] })); } }));
      C.table(c4.box, { head: ['Expiry year', 'EP', 'US'], rows: X.expYears.map(function (y, i) { return [String(y), eSeries[0].values[i], eSeries[1].values[i]]; }) });

      // 5 status mix
      var c5 = chartSec('Legal status', 'What became of the applications', 'The latest publication per application. EP according to the register status of ' + U.date((M.snapshots || {}).ep_register) + '; US calculated, without checking maintenance fees. \u201cLegal status open\u201d means that no information is available for this application.');
      c5.sec.classList.add('wide'); grid.appendChild(c5.sec);
      var SC = ['var(--s1)', 'var(--s2)', 'var(--s-other)', 'var(--s-open)'], two = h('div.k-two'); c5.box.appendChild(two);
      ['EP', 'US'].forEach(function (au) {
        var col = h('div'); two.appendChild(col);
        col.appendChild(h('p.k-sub', null, h('b', { text: au }), ' · ' + U.num(Object.keys(X.st[au]).reduce(function (a, k) { return a + X.st[au][k]; }, 0)) + ' applications'));
        C.segbar(col, { unit: 'applications', label: 'Legal status of the ' + au + ' applications', parts: STATUS_GROUPS.map(function (grp, gi) {
          var v = grp[3].reduce(function (a, k) { return a + (X.st[au][k] || 0); }, 0);
          return { name: grp[1], value: v, color: SC[gi], href: grp[0] === 'open' ? null : sUrl(grp[0] === 'granted' ? 'exp:' + X.thisYear + '-' : '', { a: [au], t: grp[0] === 'granted' ? ['granted'] : grp[3].filter(Boolean) }) };
        }) });
      });

      // 6 heat map
      var c6 = chartSec('Focus areas', 'Player against CPC subclass', 'Families of the twelve largest players in the ten most frequent subclasses.');
      c6.sec.classList.add('wide'); grid.appendChild(c6.sec);
      if (X.hp.length && X.hc.length) C.heat(c6.box, { rows: X.hp.map(function (idx) { return A.players[idx]; }), cols: X.hc, v: X.hv, unit: 'families', colTitle: function (ci) { return CPC_DE[X.hc[ci]] || X.hc[ci]; },
        href: function (ri, ci) { return sUrl('', { p: [String(X.hp[ri])], c: [X.hc[ci]] }); }, rowHref: function (ri) { return sUrl('', { p: [String(X.hp[ri])] }); }, colHref: function (ci) { return sUrl('', { c: [X.hc[ci]] }); } });
      else c6.box.appendChild(h('p.faint', { text: 'No data in this scope.' }));
    }

    U.set(body, K.busy('Loading the full patent table (' + U.num((M.counts || {}).patents) + ' publications)'));
    D.all().then(function (all) { if (dead) return; A = all; draw(); }, function (e) { if (!dead) U.set(body, K.errBox(e, 'The patent table could not be loaded')); });

    return {
      update: function (r) { var s2 = r.params.r === 'kern' ? 'kern' : 'alle'; if (s2 !== scope) setScope(s2); return true; },
      destroy: function () { dead = true; cleanup(); }
    };
  }
  g.LnpApp.registerView({ id: 'landschaft', title: 'Landscape', icon: 'landscape', mount: g.LnpLazyView('landschaft', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });
})(window);
