/* LNP Patent Desk: expiry timeline and patent cliff. Route: #expiry[--s<source>][--p<id>][--l<publication numbers>][--c<compounds>][--f1]
   source = profile | opinion | watchlist | selection | compounds | pns. Shows the estimated expiry of the rights found for a set of
   publications: lanes per family (filing date to estimated expiry, the PTA segment drawn apart), the cliff per year and per jurisdiction,
   a table, and calendar (ICS) and CSV exports. The engine is LnpExpiry (engine/x-expiry.js). Every date is an estimate; PTE, SPC, paediatric
   extensions, terminal disclaimers and later fee lapses are not checked. Pre-screening, not legal advice.
   Also registers the patent-page button "Expiry timeline" (family) through LnpApp.ext.patentAction. */
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

  var SOURCES = [['profile', 'Product profile', 'The lipids of a saved product profile: structure search in the claims (and the claim-text route of the FTO candidate search where it needs no Claude call)'],
    ['opinion', 'FTO opinion', 'The rights of a saved FTO opinion'], ['watchlist', 'Watchlist', 'The starred publications'], ['selection', 'Selection', 'The selection handed over from Search or the watchlist to the FTO check'],
    ['compounds', 'Compounds', 'Publications that name given structures in their claims'], ['pns', 'List', 'A pasted list of publication numbers']];
  var SRC_IDS = SOURCES.map(function (s) { return s[0]; });
  var MAX_LANES = 60;

  function slug(s) { return String(s || 'expiry').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'expiry'; }

  function mount(host, route, App) {
    var K = g.LnpKit, E = g.LnpExpiry, C = g.LnpChart, St = g.LnpStore;
    var st = { src: 'profile', id: '', text: '', family: false, claimsOnly: true, jur: { EP: true, DE: true, US: true }, all: false }, dead = false, seq = 0, res = null, offs = [], profiles = null, opinions = null;

    function fromRoute(r) {
      var s = r.params.s; st.src = SRC_IDS.indexOf(s) >= 0 ? s : (r.params.l ? 'pns' : r.params.c ? 'compounds' : st.src);
      st.id = r.params.p ? String(r.params.p) : '';
      if (r.params.l) st.text = R.list(r.params.l).join('\n');
      if (r.params.c) st.text = R.list(r.params.c).join('\n');
      st.family = r.params.f === '1'; st.claimsOnly = r.params.d !== '1';
    }
    function toRoute() {
      var p = { s: st.src };
      if (st.id && (st.src === 'profile' || st.src === 'opinion')) p.p = st.id;
      var lines = st.text.split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 40);
      if (st.src === 'pns' && lines.length) p.l = lines;
      if (st.src === 'compounds' && lines.length) p.c = lines;
      if (st.family) p.f = '1'; if (st.src === 'compounds' && !st.claimsOnly) p.d = '1';
      return { view: 'expiry', params: p };
    }
    function push(replace) { R.go(toRoute(), { silent: true, replace: !!replace }); }
    function cleanup() { offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); offs = []; K.tip.hide(); }

    /* ---------------------------------------------------------- skeleton */
    var srcSeg = h('div.seg', { role: 'group', 'aria-label': 'Source of the publications' });
    var ctlBox = h('div.ex-ctl'), jurBox = h('div.k-row.ex-jur'), runBtn = h('button.btn.primary', { type: 'button', id: 'ex-run', onclick: function () { push(); run(); } }, U.icon('search'), 'Build timeline');
    var body = h('div.ex-body');
    var how = h('details.k-fold.k-limit', null, h('summary', null, U.icon('help'), h('span', { text: 'How to read this: estimates, not legal term calculations' })),
      h('div.k-fold-body.k-prose', null,
        h('p', { text: 'Each date is the filing date plus 20 years, plus the patent term adjustment (PTA) where the US calculation of the dataset has one. The bar of a right runs from its filing date to that estimate; the hatched end is the PTA.' }),
        h('p', { text: 'Not checked: patent term extension (PTE) and supplementary protection certificates (SPC), paediatric extensions, terminal disclaimers, maintenance and renewal fees after the snapshot, and legal events after it. A right without a recent register record is shown as in force but marked as unverified. Pending applications are drawn dashed: they may still be granted, narrowed or refused.' })));
    var page = h('div.page.k-page.ex-page', null,
      K.head('Expiry timeline', 'When do the rights', 'run out?', 'Estimated expiry of the patents behind a product profile, an opinion, your watchlist or a list of numbers, with the patent cliff per year and jurisdiction and a calendar file. Estimates from filing dates; PTE and SPC are not checked.'),
      h('div.ex-pick', null, srcSeg, ctlBox, h('div.k-row.ex-opts', null, jurBox, runBtn)), how, body);
    host.appendChild(page);
    SOURCES.forEach(function (s) {
      srcSeg.appendChild(h('button', { type: 'button', title: s[2], data: { s: s[0] }, onclick: function () { st.src = s[0]; st.id = ''; drawControls(); push(true); } }, s[1]));
    });
    ['EP', 'DE', 'US'].forEach(function (j) {
      var cb = h('input.chk', { type: 'checkbox', id: 'ex-j-' + j, checked: !!st.jur[j], onchange: function () { st.jur[j] = cb.checked; if (res) rebuild(); } });
      jurBox.appendChild(h('label.k-check', { 'for': 'ex-j-' + j, title: j === 'DE' ? 'EP patents not lapsed in Germany' : j }, cb, j));
    });

    /* ---------------------------------------------------------- source controls */
    function drawControls() {
      Array.prototype.forEach.call(srcSeg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.s === st.src ? 'true' : 'false'); });
      U.clear(ctlBox);
      var famCb = h('input.chk', { type: 'checkbox', id: 'ex-fam', checked: st.family, onchange: function () { st.family = famCb.checked; push(true); } });
      var famLab = h('label.k-check', { 'for': 'ex-fam', title: 'Add every publication of the same patent families that the table holds' }, famCb, 'Include all family members');
      if (st.src === 'profile') {
        var sel = h('select.select', { id: 'ex-profile', 'aria-label': 'Product profile' }, h('option', { value: '', text: 'Loading profiles ...' }));
        ctlBox.appendChild(h('div.k-row', null, sel, famLab));
        ctlBox.appendChild(h('p.k-hint', { text: 'Structure search for the lipids of the profile (exact and similarity 0.8 or more, named in claims), plus the claim-text route of the FTO candidate search when it can run without Claude. The result says which routes ran.' }));
        St.list('profiles').then(function (rows) {
          if (dead) return; profiles = (rows || []).filter(function (x) { return x && x.id; }); U.clear(sel);
          if (!profiles.length) { sel.appendChild(h('option', { value: '', text: 'No profile saved' })); ctlBox.appendChild(h('p.k-hint', null, 'No product profile yet. ', h('a', { href: '#produkte-beispiel' }, 'Open the example profile in Products'), ' or create one there.')); return; }
          sel.appendChild(h('option', { value: '', text: 'Choose a profile' }));
          profiles.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name || p.id })); });
          sel.value = st.id && profiles.some(function (p) { return p.id === st.id; }) ? st.id : '';
        }, function (e) { if (!dead) ctlBox.appendChild(K.errBox(e, 'The profiles could not be read')); });
        sel.addEventListener('change', function () { st.id = sel.value; push(true); });
      } else if (st.src === 'opinion') {
        var sel2 = h('select.select', { id: 'ex-opinion', 'aria-label': 'FTO opinion' }, h('option', { value: '', text: 'Loading opinions ...' }));
        ctlBox.appendChild(h('div.k-row', null, sel2, famLab));
        Promise.resolve(g.LnpFto && g.LnpFto.list ? g.LnpFto.list() : []).then(function (rows) {
          if (dead) return; opinions = rows || []; U.clear(sel2);
          if (!opinions.length) { sel2.appendChild(h('option', { value: '', text: 'No opinion saved' })); ctlBox.appendChild(h('p.k-hint', null, 'No FTO opinion saved yet. ', h('a', { href: '#fto' }, 'Open the FTO check'), '.')); return; }
          sel2.appendChild(h('option', { value: '', text: 'Choose an opinion' }));
          opinions.forEach(function (o) { sel2.appendChild(h('option', { value: o.id, text: (o.title || o.id) + (o.created ? ' (' + U.date(String(o.created).slice(0, 10)) + ')' : '') })); });
          sel2.value = st.id && opinions.some(function (o) { return o.id === st.id; }) ? st.id : '';
        }, function () { if (!dead) U.set(sel2, h('option', { value: '', text: 'Opinions not available' })); });
        sel2.addEventListener('change', function () { st.id = sel2.value; push(true); });
      } else if (st.src === 'watchlist' || st.src === 'selection') {
        ctlBox.appendChild(h('div.k-row', null, h('span.k-hint', { text: st.src === 'watchlist' ? 'The starred publications of your watchlist (' + K.plural(App.marks.count(), 'publication', 'publications') + ').' : 'The publications last handed over from Search or the watchlist to the FTO check.' }), famLab));
      } else {
        var ta = h('textarea.textarea.mono', { id: 'ex-text', rows: '4', maxlength: '8000', spellcheck: 'false', 'aria-label': st.src === 'pns' ? 'Publication numbers' : 'Structures',
          placeholder: st.src === 'pns' ? 'One publication number per line, e.g. EP3532103B1, US10000445B2' : 'One SMILES, reference lipid name (ALC-0315, SM-102 ...) or SCHEMBL number per line' });
        ta.value = st.text; ta.addEventListener('input', function () { st.text = ta.value; });
        ctlBox.appendChild(ta);
        var extra = [famLab];
        if (st.src === 'compounds') { var cb2 = h('input.chk', { type: 'checkbox', id: 'ex-desc', checked: !st.claimsOnly, onchange: function () { st.claimsOnly = !cb2.checked; push(true); } }); extra.push(h('label.k-check', { 'for': 'ex-desc', title: 'Also publications that only mention the structure in the description, abstract or title' }, cb2, 'Include description-only mentions')); }
        ctlBox.appendChild(h('div.k-row', null, extra));
      }
    }

    /* ---------------------------------------------------------- run */
    function run() {
      var my = ++seq; cleanup(); res = null;
      var spec = { source: st.src };
      if (st.src === 'profile' || st.src === 'opinion') {
        if (!st.id) { U.set(body, h('div.empty', null, h('p.overline', { text: 'Nothing chosen' }), h('h3', { text: st.src === 'profile' ? 'Choose a product profile' : 'Choose an FTO opinion' }), h('p', { text: 'Pick one in the list above, then build the timeline.' }))); return; }
        spec.id = st.id;
      }
      if (st.src === 'pns') spec.pns = st.text;
      if (st.src === 'compounds') spec.compounds = st.text.split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if ((st.src === 'pns' && !st.text.trim()) || (st.src === 'compounds' && !spec.compounds.length)) {
        U.set(body, h('div.empty', null, h('p.overline', { text: 'Enter a list' }), h('h3', { text: st.src === 'pns' ? 'Paste publication numbers' : 'Enter one or more structures' }), h('p', { text: st.src === 'pns' ? 'Numbers can be written as EP3532103B1, EP 3 532 103 B1 or US 10,000,445; separate them by line break, comma or semicolon.' : 'SMILES, a reference lipid name or a SCHEMBL number, one per line.' }))); return;
      }
      runBtn.disabled = true; U.set(body, K.busy(st.src === 'profile' ? 'Searching the claims for the lipids of the profile' : 'Collecting the publications'));
      E.setFrom(spec, { family: st.family, claimsOnly: st.claimsOnly }).then(function (ps) {
        if (my !== seq || dead) return null;
        res = { ps: ps, info: ps.info, rows: null };
        return build(my);
      }).then(function () { if (my === seq) runBtn.disabled = false; }, function (e) {
        if (my !== seq || dead) return; runBtn.disabled = false;
        U.set(body, K.errBox(e, e && e.code === 'not_found' ? 'Not found' : 'The set could not be collected'));
      });
    }
    function jurList() { return ['EP', 'DE', 'US'].filter(function (j) { return st.jur[j]; }); }
    function build(my) {
      return E.timeline(res.ps, { jurisdictions: jurList() }).then(function (rows) {
        if (my != null && (my !== seq || dead)) return; res.rows = rows; res.cliff = E.cliff(rows); draw();
      });
    }
    function rebuild() { if (!res) return; var my = ++seq; build(my).catch(function (e) { if (my === seq && !dead) U.set(body, K.errBox(e, 'The timeline could not be built')); }); }

    /* ---------------------------------------------------------- drawing */
    function statusPill(r) {
      if (r.dead) return h('span.pill.hollow', { text: r.deadReason === 'expired' ? 'expired (est.)' : r.deadReason, title: 'No longer in force according to the dataset' });
      if (r.expiredEst) return h('span.pill.warn.hollow', { text: 'expired (est.)', title: 'Past the estimated expiry date; an SPC or a PTE (not checked) can extend protection by up to 5.5 years' });
      if (r.pending) return h('span.pill.warn', { text: 'pending', title: 'Application: may still be granted, narrowed or refused' });
      return h('span.pill.good', { text: 'in force', title: r.stale || r.noRecord ? 'Treated as in force; status record old or missing' : 'Granted, no lapse or revocation in the dataset' });
    }
    function tile(label, value, small) { return h('div.stat', null, h('dt', { text: label }), h('dd', null, value, small ? h('small', { text: small }) : null)); }

    function draw() {
      cleanup();
      var rows = res.rows, info = res.info, cl = res.cliff, live = rows.filter(function (r) { return !r.superseded; });
      if (!rows.length) {
        U.set(body, srcInfo(info, rows), h('div.empty', null, h('p.overline', { text: 'No rights' }), h('h3', { text: res.ps.length ? 'No right in the selected jurisdictions' : 'No publication found' }),
          h('p', { text: res.ps.length ? 'The set only holds publications outside EP, DE and US, or the jurisdiction filter removed all of them.' : 'The source gave no publication of this corpus. The notes above say what was searched.' })), limitsBox(rows)); return;
      }
      var nIn = live.filter(function (r) { return r.inForce; }).length, nPend = live.filter(function (r) { return r.pending; }).length, nDead = live.filter(function (r) { return r.dead; }).length, nEst = live.filter(function (r) { return r.expiredEst; }).length;
      var maxExp = live.filter(function (r) { return (r.inForce || r.pending) && r.expiry.date; }).map(function (r) { return r.expiry.date; }).sort().pop();
      var nStale = live.filter(function (r) { return (r.inForce || r.pending) && (r.stale || r.noRecord); }).length;
      var stats = h('dl.stats.k-stats', null, tile('Rights', U.num(live.length), K.plural(rows.families.length, 'family', 'families')), tile('In force (estimate)', U.num(nIn), nStale ? U.num(nStale) + ' with an old or missing status' : 'status as per the register snapshot'),
        tile('Pending', U.num(nPend), 'applications, may still grant'), tile('No longer in force', U.num(nDead), 'lapsed, revoked or withdrawn per register'), tile('Expired (estimate)', U.num(nEst), 'term passed; SPC / PTE not checked'), tile('Latest estimated expiry', maxExp ? U.date(maxExp) : '–', 'of the rights still in force or pending'));
      var tl = h('div.ex-tlbox'), cliffBox = h('div.ex-cliff'), tblBox = h('div.ex-tbl');
      var secT = K.sec('Timeline', 'Filing date to estimated expiry', null, h('p.k-note', { text: 'One lane per right, grouped by patent family, oldest family on top. The solid bar runs from the filing date to the estimated expiry; the hatched end is the patent term adjustment (US). Dashed bars are applications, grey bars rights that are no longer in force. The red line is today.' }), tl);
      drawTimeline(tl, rows);
      var secC = K.sec('Cliff', 'Rights expiring per year', null, cliffBox);
      drawCliff(cliffBox, cl);
      var btns = h('div.k-row', null, h('button.btn.primary', { type: 'button', id: 'ex-ics', onclick: exportIcs }, U.icon('download'), 'Calendar (ICS)'), h('button.btn', { type: 'button', id: 'ex-csv', onclick: exportCsv }, U.icon('download'), 'Table (CSV)'),
        h('span.k-hint', { text: 'One all-day event per estimated expiry. Estimates; PTE and SPC are not checked; verify at the register.' }));
      var secE = K.sec('Table', 'Rights and their dates', btns, tblBox);
      drawTable(tblBox, rows);
      U.set(body, srcInfo(info, rows), stats, secT, secC, secE, limitsBox(rows));
    }

    function srcInfo(info, rows) {
      var parts = [h('p.k-sub', null, h('b', { text: info.label || 'Source' }), ' · ' + (info.routes || []).map(function (r) { var nm = String(r.name || ''), one = { 'publication numbers': 'publication number', 'charted rights': 'charted right', 'family members added': 'family member added' }[nm]; return U.num(r.n) + ' ' + (r.n === 1 && one ? one : nm); }).join(' · ') + ' · ' + info.ms + ' ms')];
      (info.notes || []).forEach(function (n) { parts.push(h('p.k-hint.ex-note', { text: n })); });
      if (info.unknown && info.unknown.length) parts.push(h('p.notice', { text: 'Not found in this corpus: ' + info.unknown.slice(0, 8).join(', ') + (info.unknown.length > 8 ? ' and ' + (info.unknown.length - 8) + ' more' : '') + '.' }));
      if (rows && rows.skippedWo) parts.push(h('p.k-hint.ex-note', { text: K.plural(rows.skippedWo, 'PCT publication', 'PCT publications') + ' left out: a WO publication is not a right; its national and regional members are.' }));
      return h('div.ex-src', null, parts);
    }

    function drawTimeline(box, rows) {
      var fams = rows.families, today = rows.today, shown = st.all ? fams : fams.slice(0, MAX_LANES);
      var lanes = [];
      shown.forEach(function (f) { f.rows.forEach(function (r) { if (!r.superseded) lanes.push({ f: f, r: r }); }); });
      var yMin = 9999, yMax = 0;
      lanes.forEach(function (l) { var a = l.r.filing || l.r.pub, b = l.r.expiry.date; if (a) yMin = Math.min(yMin, +a.slice(0, 4)); if (b) yMax = Math.max(yMax, +b.slice(0, 4) + 1); });
      yMin = Math.min(yMin, +today.slice(0, 4) - 1); yMax = Math.max(yMax, +today.slice(0, 4) + 3);
      if (yMin > yMax) { yMin = +today.slice(0, 4) - 5; yMax = yMin + 20; }
      var span = yMax - yMin, a0 = Date.UTC(yMin, 0, 1), b0 = Date.UTC(yMax, 0, 1);
      function pos(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); if (!m) return null; return Math.max(0, Math.min(100, (Date.UTC(+m[1], +m[2] - 1, +m[3]) - a0) / (b0 - a0) * 100)); }
      var narrow = (box.clientWidth || (g.innerWidth || 1000)) < 560;
      var stepY = narrow ? (span > 40 ? 10 : span > 20 ? 5 : 4) : (span > 30 ? 5 : span > 16 ? 2 : 1), nowP = pos(today);
      var inner = h('div.ex-tl-in', { role: 'img', 'aria-label': 'Timeline of estimated expiry dates, one lane per right' });
      var axis = h('div.ex-tl-row.ex-tl-axis', null, h('span.ex-tl-lab', { text: 'Publication' }), h('div.ex-tl-track'));
      for (var y = yMin; y <= yMax; y += stepY) axis.lastChild.appendChild(h('span.ex-tl-y', { style: { left: pos(y + '-01-01') + '%' }, text: String(y) }));
      inner.appendChild(axis);
      var lastFam = null;
      lanes.forEach(function (l) {
        var r = l.r;
        var track = h('div.ex-tl-track');
        for (var yy = yMin; yy <= yMax; yy += stepY) track.appendChild(h('i.ex-tl-grid', { style: { left: pos(yy + '-01-01') + '%' } }));
        var s = pos(r.filing || r.pub), e = pos(r.expiry.date);
        if (s != null && e != null && e >= s) {
          var pta = r.expiry.ptaDays > 0 ? r.expiry.ptaDays : 0, baseEnd = pta ? pos(addDaysIso(r.expiry.date, -pta)) : e;
          var cls = r.dead || r.expiredEst ? 'dead' : r.pending ? 'pending' : 'live';
          track.appendChild(h('span.ex-bar.' + cls, { style: { left: s + '%', width: Math.max(.4, baseEnd - s) + '%' } }));
          if (pta && baseEnd < e) track.appendChild(h('span.ex-bar.pta' + (r.dead || r.expiredEst ? '.dead' : r.pending ? '.pending' : ''), { style: { left: baseEnd + '%', width: Math.max(.3, e - baseEnd) + '%' } }));
          track.appendChild(h('span.ex-end' + (e > 85 ? '.left' : ''), { style: { left: e + '%' }, text: r.expiry.date.slice(0, 4) }));
        } else track.appendChild(h('span.ex-none', { style: { left: (s || 0) + '%' }, text: 'no expiry estimate' }));
        if (nowP != null) track.appendChild(h('i.ex-tl-now', { style: { left: nowP + '%' } }));
        var lab = h('a.ex-tl-lab.mono', { href: App.patentHref(r.pn, { q: '' }), title: r.title || r.pn }, h('span.ex-tl-pn', { text: U.pnPretty(r.pn) }));
        var row = h('div.ex-tl-row' + (l.f.family !== lastFam ? '.ex-first' : ''), { data: { pn: r.pn } }, lab, track);
        lastFam = l.f.family;
        row.addEventListener('mousemove', function (ev) { K.tip.show(ev, U.pnPretty(r.pn), tipRows(r), r.title ? r.title.slice(0, 120) : null); });
        row.addEventListener('mouseleave', K.tip.hide);
        inner.appendChild(row);
      });
      box.appendChild(h('div.ex-tl', null, inner));
      var leg = h('div.ex-legend', null, h('span', null, h('i.ex-key.live'), 'in force or granted'), h('span', null, h('i.ex-key.pta'), 'PTA (US)'), h('span', null, h('i.ex-key.pending'), 'pending application'), h('span', null, h('i.ex-key.dead'), 'no longer in force or expired (est.)'), h('span', null, h('i.ex-key.now'), 'today'));
      box.appendChild(leg);
      if (fams.length > shown.length) box.appendChild(h('p.k-hint', null, 'Showing the ' + shown.length + ' oldest of ' + fams.length + ' families. ', h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.all = true; draw(); } }, 'Show all')));
    }
    function addDaysIso(d, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); var t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 864e5, x = new Date(t); return x.getUTCFullYear() + '-' + ('0' + (x.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + x.getUTCDate()).slice(-2); }
    function tipRows(r) {
      var ex = r.expiry, out = [['Status', r.dead ? r.deadReason : r.expiredEst ? 'expired (estimate; SPC / PTE not checked)' : r.pending ? 'pending' : 'in force', null], ['Filing', r.filing ? U.date(r.filing) : '–', null], ['Expiry (estimate)', ex.date ? U.date(ex.date) : '–', null], ['Basis', ex.basis, null]];
      if (ex.ptaDays) out.push(['PTA', ex.ptaDays + ' days', null]);
      out.push(['PTE / SPC', 'not checked', null]);
      if (r.stale || r.noRecord) out.push(['Status record', r.noRecord ? 'missing' : 'from ' + U.date(r.asof), null]);
      return out;
    }

    function drawCliff(box, cl) {
      var ys = cl.years;
      if (!ys.length) { box.appendChild(h('p.k-hint', { text: 'No right of this set has an estimated expiry in the future.' })); }
      else {
        var holder = h('div.ex-chart');
        box.appendChild(holder);
        offs.push(C.stacked(holder, { cats: ys.map(function (y) { return String(y.year); }), unit: 'rights', height: 230, label: 'Number of rights expiring per year, granted EP, granted US and pending applications',
          series: [{ name: 'Granted EP', color: C.color(0), values: ys.map(function (y) { return y.EP; }) }, { name: 'Granted US', color: C.color(1), values: ys.map(function (y) { return y.US; }) }, { name: 'Pending applications', color: C.color(3), values: ys.map(function (y) { return y.pending; }) }].concat(ys.some(function (y) { return y.other; }) ? [{ name: 'Other', color: C.OTHER, values: ys.map(function (y) { return y.other; }) }] : []) }));
        C.table(box, { head: ['Year', 'Granted EP', 'Granted US', 'Pending', 'Total'], rows: ys.map(function (y) { return [String(y.year), y.EP, y.US, y.pending, y.total]; }) });
      }
      var jl = h('div.ex-jur-list');
      ['EP', 'DE', 'US'].forEach(function (j) {
        if (!st.jur[j]) return; var x = cl.jurisdictions[j];
        jl.appendChild(h('div.ex-jur-item', { data: { j: j } }, h('span.overline', { text: j === 'DE' ? 'DE (EP patents)' : j }), h('b.mono', { text: x.lastExpiry ? U.date(x.lastExpiry) : 'none' }), h('p', { text: x.text })));
      });
      box.appendChild(h('div.ex-jurs', null, h('p.overline', { text: 'Date after which no known in-force right of this set remains' }), jl));
      box.appendChild(h('ul.ex-caveats', null, cl.caveats.map(function (c) { return h('li', { text: c }); })));
    }

    function drawTable(box, rows) {
      var tb = h('tbody');
      rows.forEach(function (r) {
        var ex = r.expiry;
        tb.appendChild(h('tr' + (r.superseded ? '.ex-sup' : ''), null, h('td', null, K.patentLink(r.pn, App), h('div.faint.k-small', { text: r.auth + (r.family != null ? ' · family ' + r.family : '') })),
          h('td', null, r.superseded ? h('span.pill.hollow', { text: 'same application', title: 'Another publication of the same application is the row of this right' }) : statusPill(r), r.stale && !r.dead && !r.superseded ? h('span.tag', { text: r.noRecord ? 'no record' : 'stale', title: r.noRecord ? 'No register record in the dataset' : 'Status snapshot older than 6 months' }) : null),
          h('td.mono', { text: r.filing ? U.date(r.filing) : '–' }), h('td.mono.ex-nw', { text: ex.date ? U.date(ex.date) : '–' }), h('td.t', { text: ex.basis }),
          h('td.num', { text: ex.ptaDays > 0 ? String(ex.ptaDays) : '–' }), h('td.ex-nw', { text: 'not checked' }), h('td.ex-nw', { text: ex.terminalDisclaimer === true ? 'yes' : 'not visible' }),
          h('td.t', null, r.flags.length ? r.flags.join('; ') : '–', r.asof ? h('div.faint.k-small', { text: 'status as of ' + U.date(r.asof) }) : null)));
      });
      box.appendChild(h('div.table-wrap', null, h('table.data.ex-table', null, h('thead', null, h('tr', null, ['Number', 'Status', 'Filing', 'Expiry (est.)', 'Basis', 'PTA days', 'PTE / SPC', 'Terminal disclaimer', 'Notes'].map(function (t) { return h('th', { text: t }); }))), tb)));
    }

    function limitsBox(rows) {
      var snap = rows && rows.snapshot ? rows.snapshot : {}, asof = snap.ep_register ? ' EP register snapshot ' + U.date(snap.ep_register) + '.' : '';
      return h('section.ex-limits', { 'aria-label': 'Limits of this result' }, h('p.overline', { text: 'Limits' }),
        h('p', { text: 'Estimates from filing date and PTA; PTE, SPC, paediatric extension, terminal disclaimers and maintenance fees after the snapshot are not checked; register snapshot ' + (snap.ep_register ? U.date(snap.ep_register) : 'unknown') + '; not legal advice.' }),
        h('ul', null, E.limits().map(function (l) { return h('li', { text: l }); })), h('p.k-hint', { text: 'Pre-screening aid.' + asof }));
    }

    function exportIcs() {
      var name = (res.info && res.info.label) || 'Patent expiry estimates';
      U.saveFile('lnp-expiry-' + slug(name) + '-' + K.fileStamp() + '.ics', E.toIcs(res.rows, { name: name }), 'text/calendar;charset=utf-8');
    }
    function exportCsv() { U.saveFile('lnp-expiry-' + slug(res.info && res.info.label) + '-' + K.fileStamp() + '.csv', E.toCsv(res.rows), 'text/csv;charset=utf-8'); }

    /* ---------------------------------------------------------- start */
    fromRoute(route); drawControls();
    var auto = (st.src === 'pns' && st.text.trim()) || (st.src === 'compounds' && st.text.trim()) || ((st.src === 'profile' || st.src === 'opinion') && st.id) || st.src === 'watchlist' || st.src === 'selection' && route.params.s;
    if (auto) run();
    else U.set(body, h('div.empty', null, h('p.overline', { text: 'Choose a source' }), h('h3', { text: 'Which publications should the timeline cover?' }), h('p', { text: 'Pick a source above and build the timeline. Nothing is sent anywhere: the dates are computed in your browser from the dataset.' })));
    return {
      update: function (r) { var was = JSON.stringify(toRoute().params); fromRoute(r); if (JSON.stringify(toRoute().params) === was && res) return true; drawControls(); if (r.params.s && ((st.src === 'pns' && st.text.trim()) || (st.src === 'compounds' && st.text.trim()) || st.id || st.src === 'watchlist' || st.src === 'selection')) run(); return true; },
      destroy: function () { dead = true; cleanup(); }
    };
  }

  g.LnpApp.registerView({ id: 'expiry', title: 'Expiry timeline', icon: 'landscape', rail: false, parent: 'tools', mount: g.LnpLazyView('expiry', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });

  // button on the patent page: the family of this publication on the expiry timeline
  if (g.LnpApp.ext && typeof g.LnpApp.ext.patentAction === 'function') {
    g.LnpApp.ext.patentAction(function (P) {
      if (!P || !P.pn || P.auth === 'WO' && !P.fam) return null;
      return h('a.btn', { href: R.build({ view: 'expiry', params: { s: 'pns', l: [P.pn], f: '1' } }), title: 'Estimated expiry of this patent family' }, U.icon('landscape'), 'Expiry timeline');
    });
  }
})(window);
