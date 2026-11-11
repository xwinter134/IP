#!/usr/bin/env node
/* Tests for the earliest-disclosure timeline and the white-space map: engine web/engine/x-disclosure.js (LnpDisclosure),
   views web/app/views/disclosure.js (#disclosure) and web/app/views/whitespace.js (#whitespace).

   usage: node tests/disclosure_test.cjs [--dist DIR] [--unit] [--shots DIR] [--json FILE]
     --unit   only the Node part (needs data/work/chem, no browser)
     --dist   a build made with:
                python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215
              (the chemistry set must be in it; the browser part is skipped with a notice when the dist does not exist)
   Part 1 (Node): grid over the real descriptor columns (data/work/chem): totals, every axis, filters, cache, errors, cell caps, CSV safety.
   Part 2 (Playwright + tests/artifact_server.cjs): timeline for ALC-0315, SM-102 and MC3 (dates plausible, families grouped, cross-check
     against LnpChem.patentsOf + LnpData.patent), #disclosure view (marks, table, CSV, limits), #whitespace view (heat map, click a cell,
     metric, axes, filters, CSV), window.claude absent, null caps, light / dark, 390 px, no request leaves the origin; grid timings.
   Exit code 1 when a check fails. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SCRATCH = '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/T8';
const DIST = path.resolve(argv('dist', path.join(SCRATCH, 'distb')));
const SHOTS = argv('shots', '');
const fails = []; let checks = 0, cur = 'setup'; const timings = {};
function section(n) { cur = n; console.log('\n## ' + n); }
function ok(cond, what, extra) {
  checks++;
  if (!cond) { fails.push(cur + ': ' + what); console.log('  FAIL ' + what + (extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
  else console.log('  ok   ' + what);
  return !!cond;
}

const Dc = require(path.join(ROOT, 'web', 'engine', 'x-disclosure.js'));

/* ------------------------------------------------------------------------------------------ Part 1: Node */
async function unit() {
  const dir = path.join(ROOT, 'data', 'work', 'chem');
  if (!fs.existsSync(path.join(dir, 'desc.gz.bin'))) { console.log('\nNode part: no data/work/chem here, only the data-free checks run'); }
  section('toCsv: formula injection and shape');
  {
    const res = { query: '=cmd()', mode: 'exact', earliest: { publication: { date: '2016-01-01', pn: 'WO1' } }, limits: ['a; b'], families: [{ fam: 1, earliestPrio: '2015-01-01', earliestPub: '2016-01-01', sizeInTable: 1, size: 2, inClaimsAny: true, statusSummary: { text: 'granted 1' }, inForce: true, player: '+x', members: [{ pn: 'WO1' }] }],
      entries: [{ pn: 'WO1', family: 1, prio: '2015-01-01', pub: '2016-01-01', app: '', where: { clm: true }, status: 'granted', exp: '', player: '@x', cs: [1], title: '-1+1' }] };
    const a = Dc.toCsv(res, { kind: 'entries' }), b = Dc.toCsv(res, { kind: 'families' });
    ok(a.charCodeAt(0) === 0xfeff, 'BOM first');
    ok(/'@x/.test(a) && /'-1\+1/.test(a) && /'\+x/.test(b), 'cells that start with = + - @ are neutralised', a.slice(0, 200));
    ok(/"[^"]*a; b[^"]*"/.test(a), 'a field with the separator is quoted');
    ok(a.split('\r\n').length >= 6 && /^publication;family;priority_date/m.test(a), 'header row and data row present');
  }
  if (!fs.existsSync(path.join(dir, 'desc.gz.bin'))) return;
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'chem.json'), 'utf8'));
  const gz = (f) => zlib.gunzipSync(fs.readFileSync(path.join(dir, f)));
  Dc.configure({ columns: { man, desc: gz('desc.gz.bin'), map: gz('map.gz.bin'), pat: JSON.parse(gz('pat.gz.bin').toString()) } });
  const X = Dc._readColumns(man, (() => { const b = gz('desc.gz.bin'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })(), (() => { const b = gz('map.gz.bin'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })(), JSON.parse(gz('pat.gz.bin').toString()));

  section('grid: head x tailC over the real columns');
  let t = Date.now(); const r = await Dc.grid({ x: 'head', y: 'tailC' }); timings.node_grid_head_tailC_ms = Date.now() - t;
  let sum = 0, mx = 0; r.cells.forEach((row) => row.forEach((c) => { sum += c.nCompounds; mx = Math.max(mx, c.nPatents); }));
  ok(sum === man.n && r.totals.nCompounds === man.n && r.matched === man.n, 'every compound lands in exactly one cell', [sum, man.n]);
  ok(r.xs.length === r.xKeys.length && r.ys.length === 10 && r.cells.length === r.ys.length && r.cells[0].length === r.xs.length, 'dimensions match labels', [r.xs.length, r.ys.length]);
  ok(r.totals.nPatents === man.nPat || r.totals.nPatents <= man.nPat, 'distinct publications <= chemistry set publications', [r.totals.nPatents, man.nPat]);
  let nClm = 0; for (let c = 0; c < X.n; c++) if (X.col.nClm[c] > 0) nClm++;
  ok(r.totals.nInClaims === nClm, 'compounds in claims equals the count of nClm > 0 in the column', [r.totals.nInClaims, nClm]);
  // cross-check one cell by hand: head index 'tert-amine' and longest tail 17-18
  const hk = r.xKeys.indexOf('tert-amine'), hi = X.heads.indexOf('tert-amine'); let hand = 0;
  for (let c = 0; c < X.n; c++) { let L = 0; for (let k = 0; k < 6; k++) L = Math.max(L, X.col['t' + k][c]); if (X.col.head[c] === hi && L >= 17 && L <= 18) hand++; }
  ok(hk >= 0 && r.cells[r.yKeys.indexOf('17-18')][hk].nCompounds === hand, 'cell tert-amine x C17-C18 equals a hand count', [r.cells[r.yKeys.indexOf('17-18')][hk].nCompounds, hand]);
  const big = r.cells.flat().find((c) => c.nCompounds > 300);
  ok(big && big.cs.length === 200 && big._all.length === big.nCompounds, 'cs is capped at 200 and sorted claims first', big && big.cs.length);
  ok(big.cs.slice(0, 5).every((c, i, a) => i === 0 || !(X.col.nClm[a[i - 1]] === 0 && X.col.nClm[c] > 0)), 'claims compounds come first in cs');
  t = Date.now(); const r2 = await Dc.grid({ x: 'head', y: 'tailC' });
  ok(r2.cached === true && r2.cells === r.cells, 'second call is served from the cache', Date.now() - t);

  section('grid: every axis, filters, errors');
  for (const a of Dc.axes()) {
    const other = a.id === 'head' ? 'nTails' : 'head';
    t = Date.now(); const g = await Dc.grid({ x: a.id, y: other }); timings['node_grid_' + a.id + '_x_' + other + '_ms'] = Date.now() - t;
    let s = 0; g.cells.forEach((row) => row.forEach((c) => { s += c.nCompounds; }));
    ok(s === man.n && g.xs.length >= 2, 'axis ' + a.id + ': all compounds counted, ' + g.xs.length + ' categories', s);
  }
  const f = await Dc.grid({ x: 'head', y: 'tailC', filters: { inClaims: true, amine: 'tertiary' } });
  let hand2 = 0; for (let c = 0; c < X.n; c++) if (X.col.nClm[c] > 0 && X.col.nTert[c] > 0) hand2++;
  ok(f.matched > 0 && f.matched <= hand2 && f.totals.nInClaims === f.matched, 'filter inClaims + amine tertiary: all counted compounds are in claims', [f.matched, hand2]);
  ok(f.limits.some((l) => /Filter:/.test(l)), 'a filter is stated in the limits');
  const f2 = await Dc.grid({ x: 'nTails', y: 'unsat', filters: { nTails: [2, 2] } });
  ok(f2.cells.every((row) => row.every((c, xi) => c.nCompounds === 0 || f2.xKeys[xi] === '2')), 'filter nTails = 2 leaves only that column');
  for (const bad of [{ x: 'nope' }, { y: 'nope' }, { filters: { nope: 1 } }]) {
    let code = ''; try { await Dc.grid(Object.assign({ x: 'head', y: 'tailC' }, bad)); } catch (e) { code = e.code; }
    ok(/^bad_/.test(code), 'rejects ' + JSON.stringify(bad) + ' with ' + code);
  }
  ok(Dc.limits().some((l) => /Markush/.test(l)) && Dc.limits().some((l) => /earliest priority date is not the effective date/.test(l)), 'limits text names Markush and the effective date caveat');
}

/* ------------------------------------------------------------------------------------------ Part 2: browser */
async function openPage(B, srv, o) {
  const ctx = await B.newContext({ viewport: { width: o.w || 1280, height: o.h || 900 }, colorScheme: o.scheme || 'light', reducedMotion: 'reduce', acceptDownloads: true });
  const st = { console: [], pageErrors: [], offOrigin: [] };
  await ctx.route((u) => u.origin !== srv.origin && u.protocol !== 'blob:' && u.protocol !== 'data:', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '/* answered by the test */' });
    st.offOrigin.push(route.request().url()); return route.abort();
  });
  if (o.claude === 'null') await ctx.addInitScript('window.claude = { use: function () { return Promise.resolve(null); } };');
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') st.console.push(m.text()); });
  page.on('pageerror', (e) => st.pageErrors.push(e.message));
  return { ctx, page, st };
}
async function shot(S, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }
function clean(S, label) {
  const bad = S.st.pageErrors.concat(S.st.console);
  ok(bad.length === 0, label + ': no console or page errors', bad.slice(0, 4));
  ok(S.st.offOrigin.length === 0, label + ': no request left the origin', S.st.offOrigin.slice(0, 4));
}
async function noHScroll(S, label) {
  const r = await S.page.evaluate(() => { const v = document.getElementById('view'); return { doc: document.documentElement.scrollWidth, win: window.innerWidth, view: v ? v.scrollWidth : 0, viewW: v ? v.clientWidth : 0 }; });
  ok(r.doc <= r.win + 1 && r.view <= r.viewW + 1, label + ': the page does not scroll horizontally', r);
}
const T = (S, q, mode) => S.page.evaluate(async ([q, mode]) => {
  const r = await LnpDisclosure.timeline(q, { mode });
  return { query: r.query, mode: r.mode, entries: r.entries.map((e) => ({ p: e.p, pn: e.pn, family: e.family, pub: e.pub, prio: e.prio, app: e.app, inClaims: e.inClaims, where: e.where, status: e.status })),
    families: r.families.map((f) => ({ fam: f.fam, earliestPrio: f.earliestPrio, earliestPub: f.earliestPub, n: f.members.length, famOfMembers: f.members.map((m) => m.family), inClaimsAny: f.inClaimsAny, size: f.size })),
    earliest: r.earliest, compounds: r.compounds, limits: r.limits, ms: r.ms, snapshot: r.snapshot };
}, [q, mode]);

async function browser() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('\nBrowser part skipped: no dist at ' + DIST); return; }
  const pw = require('playwright');
  const srv = await require(path.join(ROOT, 'tests', 'artifact_server.cjs')).serve({ dist: DIST }), B = await pw.chromium.launch();
  try {
    section('browser: boot, window.claude absent, registration');
    let S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#disclosure');
    await S.page.waitForSelector('#dc-q', { timeout: 120000 });
    const info = await S.page.evaluate(() => ({ claude: typeof window.claude, d: !!LnpApp.views.disclosure, w: !!LnpApp.views.whitespace, pd: LnpApp.views.disclosure && LnpApp.views.disclosure.parent, pw: LnpApp.views.whitespace && LnpApp.views.whitespace.parent,
      rail: !!(LnpApp.views.disclosure && LnpApp.views.disclosure.rail) || !!(LnpApp.views.whitespace && LnpApp.views.whitespace.rail), inRail: !!document.querySelector('#rail a[href="#disclosure"], #rail a[href="#whitespace"]'), eng: typeof LnpDisclosure, ext: !!(LnpApp.ext && LnpApp.ext.has && LnpApp.ext.has('compoundAction')) }));
    ok(info.claude === 'undefined', 'window.claude is absent');
    ok(info.d && info.w && info.pd === 'tools' && info.pw === 'tools' && !info.rail && !info.inRail, 'both views registered as parent tools without a rail entry', info);
    ok(info.eng === 'object' && info.ext, 'LnpDisclosure global; compoundAction hook registered', info);
    ok(await S.page.locator('.cm-body .empty').count() === 1, 'empty state before a query');

    section('browser: timeline engine for ALC-0315, SM-102, MC3');
    const out = {};
    for (const [name, lo] of [['ALC-0315', 2012], ['SM-102', 2012], ['MC3', 2008]]) {
      const t0 = Date.now(); const r = await T(S, name, 'exact+stereo'); timings['timeline_' + name + '_ms'] = Date.now() - t0; out[name] = r;
      ok(r.entries.length > 0 && r.compounds.length >= 1, name + ': ' + r.entries.length + ' publications, ' + r.families.length + ' families, ' + r.compounds.length + ' compounds', r.limits);
      const pubY = +(r.earliest.publication && r.earliest.publication.date.slice(0, 4)), prY = +(r.earliest.priority && r.earliest.priority.date.slice(0, 4));
      ok(pubY >= lo && pubY <= 2026 && prY >= lo - 3 && prY <= pubY, name + ': earliest publication ' + (r.earliest.publication && r.earliest.publication.date) + ', earliest priority ' + (r.earliest.priority && r.earliest.priority.date) + ' are plausible', r.earliest);
      ok(r.entries.every((e) => !e.pub || !e.prio || e.prio <= e.pub), name + ': no priority date after its publication date');
      ok(r.entries.every((e, i, a) => i === 0 || (a[i - 1].pub || '9') <= (e.pub || '9')), name + ': entries sorted by publication date');
      ok(r.families.length < r.entries.length && r.families.every((f) => f.famOfMembers.every((x) => x === f.fam)), name + ': members are grouped by family (' + r.families.length + ' families for ' + r.entries.length + ' publications)');
      ok(r.families.reduce((a, f) => a + f.n, 0) === r.entries.length && r.families.every((f, i, a) => i === 0 || (a[i - 1].earliestPrio || '9') <= (f.earliestPrio || '9')), name + ': every publication sits in one family; families sorted by earliest priority');
      ok(r.families.every((f) => f.earliestPrio <= f.earliestPub || !f.earliestPrio), name + ': family earliest priority <= earliest publication');
      ok(r.earliest.claims === null || (r.entries.filter((e) => e.where.clm).sort((a, b) => a.pub.localeCompare(b.pub))[0].pub === r.earliest.claims.date), name + ': earliest-in-claims date is the minimum over the claims entries');
      ok(r.limits.some((l) => /journals/.test(l)) && r.limits.some((l) => /machine extraction/.test(l)) && r.limits.some((l) => /effective date/.test(l)), name + ': limits state corpus scope, machine extraction and the priority caveat');
    }
    section('browser: cross-check against LnpChem.patentsOf and LnpData.patent');
    const xc = await S.page.evaluate(async () => {
      const nm = (await LnpChem.names()).find((n) => n.name === 'ALC-0315'), tl = await LnpDisclosure.timeline('ALC-0315', { mode: 'exact' }), c = nm && nm.c >= 0 ? nm.c : tl.compounds[0].c;
      const direct = await LnpChem.patentsOf(c);
      const a = new Set(direct.map((x) => x.pn)), b = new Set(tl.entries.map((e) => e.pn));
      const sample = tl.entries.filter((e) => e.p >= 0).slice(0, 5), checks = [];
      for (const e of sample) {
        const pt = await LnpData.patent(e.p), d = direct.find((x) => x.pn === e.pn);
        const iso = (n) => { const s = String(n || ''); return s.length >= 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : ''; };
        checks.push({ pn: e.pn, pub: e.pub === iso(pt.pub), prio: e.prio === iso(pt.prio || pt.app), status: e.status === (pt.status || ''), fam: e.family === pt.fam, clm: e.where.clm === !!d.where.clm, claimsFlag: e.inClaims === !!d.where.clm });
      }
      const direct1 = direct.filter((x) => x.where.clm).length;
      return { c, exactCompounds: tl.compounds.length, same: a.size === b.size && [...a].every((x) => b.has(x)), nDirect: a.size, nTl: b.size, checks, claimsDirect: direct1, claimsTl: tl.entries.filter((e) => e.inClaims).length };
    });
    ok(xc.exactCompounds === 1 && xc.same, 'exact mode: the publications equal LnpChem.patentsOf(c) (' + xc.nDirect + ' of ' + xc.nTl + ')', xc);
    ok(xc.checks.length >= 3 && xc.checks.every((k) => k.pub && k.prio && k.status && k.fam && k.clm), 'five sample entries agree with LnpData.patent and the where flags of patentsOf', xc.checks);
    ok(xc.claimsDirect === xc.claimsTl, 'number of publications with a claims hit is the same (' + xc.claimsTl + ')');
    const ex = await T(S, 'ALC-0315', 'exact'), st2 = await T(S, 'ALC-0315', 'exact+stereo'), sim = await T(S, 'ALC-0315', 'sim');
    ok(st2.entries.length >= ex.entries.length && sim.compounds.length >= 1, 'stereo variants never remove publications; similar mode finds compounds', [ex.entries.length, st2.entries.length, sim.compounds.length]);
    ok(sim.limits[0] && /Tanimoto/.test(sim.limits[0]), 'similar mode says the hits are different structures');
    const bad = await S.page.evaluate(() => LnpDisclosure.timeline('not a structure ((', {}).then(() => 'resolved', (e) => e.code));
    ok(bad === 'bad_query', 'an unreadable structure rejects with bad_query', bad);
    clean(S, 'engine pass');

    section('browser: #disclosure view');
    await S.page.goto(srv.origin + '/#disclosure-SM-2d102');
    await S.page.waitForSelector('.cm-tl .cm-m', { timeout: 120000 });
    const v = await S.page.evaluate(() => ({ marks: document.querySelectorAll('.cm-m').length, prio: document.querySelectorAll('.cm-m.cm-prio').length, claims: document.querySelectorAll('a.cm-m.cm-claims').length, desc: document.querySelectorAll('a.cm-m.cm-desc').length, lanes: document.querySelectorAll('.cm-tl-row').length,
      rows: document.querySelectorAll('.cm-table tbody tr').length, limits: (document.querySelector('.cm-limits') || {}).textContent || '', stats: (document.querySelector('.k-stats') || {}).textContent || '', preview: !!document.querySelector('.k-preview svg'), legend: !!document.querySelector('.cm-legend'),
      hrefs: Array.from(document.querySelectorAll('a.cm-m')).slice(0, 3).map((a) => a.getAttribute('href')), tbl: (document.querySelector('.cm-table') || {}).textContent || '' }));
    ok(v.prio >= 5 && v.desc >= 10 && v.lanes > 5, 'timeline lanes with priority rings and publication dots', v);
    ok(v.claims >= 1, 'at least one claims diamond for SM-102', v.claims);
    ok(v.rows >= 20 && /Earliest priority/.test(v.tbl) && /granted|pending|status|in force/i.test(v.tbl + v.stats), 'family table with earliest priority and status', v.rows);
    ok(/Earliest publication/.test(v.stats) && /Earliest priority/.test(v.stats) && /Earliest in claims/.test(v.stats), 'the three earliest dates are in the stat row');
    ok(v.preview, 'query depiction drawn');
    ok(/journals/.test(v.limits) && /Markush/.test(v.limits) && /effective date/.test(v.limits) && /does not assess novelty/.test(v.limits) && /not legal advice/.test(v.limits), 'limits box on the page (scope, Markush, priority caveat, no novelty assessment, no legal advice)', v.limits.slice(0, 200));
    ok(v.hrefs.every((h) => /^#patent-/.test(h || '')), 'marks link to the patent page', v.hrefs);
    const tip = await S.page.evaluate(() => { const a = document.querySelector('a.cm-m.cm-desc'); a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 })); const t = document.querySelector('.k-tip'); return t && !t.hidden ? t.textContent : ''; });
    ok(/Published/.test(tip) && /Found in/.test(tip), 'a mark shows a tooltip with dates and where it was found', tip);
    const [dl] = await Promise.all([S.page.waitForEvent('download', { timeout: 15000 }), S.page.click('text=Publications (CSV)')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    ok(csv.charCodeAt(0) === 0xfeff && /# limits:/.test(csv) && /^publication;family;priority_date;publication_date/m.test(csv) && csv.split('\r\n').length > 30, 'CSV download: BOM, limits comment, header, rows', csv.slice(0, 200));
    const [dl2] = await Promise.all([S.page.waitForEvent('download', { timeout: 15000 }), S.page.click('text=Families (CSV)')]);
    ok(/^family;earliest_priority/m.test(fs.readFileSync(await dl2.path(), 'utf8')), 'families CSV download');
    await S.page.click('.seg button[data-m="sim"]'); await S.page.waitForFunction(() => /Tanimoto/.test((document.querySelector('.cm-limits') || {}).textContent || ''), null, { timeout: 120000 });
    ok(/--msim/.test(await S.page.evaluate(() => location.hash)), 'mode is written to the route (--msim)');
    await S.page.goto(srv.origin + '/#disclosure-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-28C-29');
    await S.page.waitForSelector('.cm-body .empty, .cm-body .notice', { timeout: 60000 });
    ok(true, 'a structure that is not in the corpus gives an empty state or a notice, not an error');
    await S.page.goto(srv.origin + '/#disclosure-MC3');
    await S.page.waitForSelector('.cm-tl .cm-m', { timeout: 120000 });
    await shot(S, 'disclosure-light');
    await noHScroll(S, 'disclosure desktop');
    clean(S, 'disclosure view'); await S.ctx.close();

    section('browser: #disclosure at 390 px, dark, null capabilities');
    S = await openPage(B, srv, { w: 390, h: 800, scheme: 'dark', claude: 'null' });
    await S.page.goto(srv.origin + '/#disclosure-ALC-2d0315');
    await S.page.waitForSelector('.cm-tl .cm-m', { timeout: 120000 });
    await noHScroll(S, 'disclosure 390 px');
    const sc = await S.page.evaluate(() => { const t = document.querySelector('.cm-tl'); return { inner: t.scrollWidth, outer: t.clientWidth, dark: getComputedStyle(document.body).backgroundColor }; });
    ok(sc.inner > sc.outer, 'the timeline scrolls inside its own box at 390 px', sc);
    ok(/^rgb\((2\d|1\d|\d), ?(2\d|1\d|\d), ?(2\d|1\d|\d)\)$/.test(sc.dark), 'dark theme background', sc.dark);
    await shot(S, 'disclosure-390-dark');
    clean(S, 'disclosure 390 dark'); await S.ctx.close();

    section('browser: #whitespace view');
    S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#whitespace');
    const tg = Date.now(); await S.page.waitForSelector('.ws-grid .ws-cell', { timeout: 120000 }); timings.ui_whitespace_first_render_ms = Date.now() - tg;
    const w = await S.page.evaluate(() => ({ cells: document.querySelectorAll('.ws-cell').length, cols: document.querySelectorAll('.ws-grid thead th').length - 1, rows: document.querySelectorAll('.ws-grid tbody tr').length, limits: (document.querySelector('.cm-limits') || {}).textContent || '', stats: (document.querySelector('.k-stats') || {}).textContent || '',
      first: document.querySelector('.ws-cell').textContent, title: (document.querySelector('.sec-title') || {}).textContent }));
    ok(w.cols >= 10 && w.rows === 10 && w.cells === w.cols * w.rows, 'head x longest-tail grid renders ' + w.cols + ' x ' + w.rows + ' cells', w);
    ok(/Markush/.test(w.limits) && /not of claim scope/.test(w.limits) && /not legal advice/.test(w.limits), 'limits box: density of extracted compounds, Markush not counted', w.limits.slice(0, 200));
    ok(/84,691|Compounds counted/.test(w.stats), 'stat row counts the compounds', w.stats);
    await S.page.click('.ws-cell:not(.k-hm0) >> nth=14');
    await S.page.waitForSelector('.ws-cmp', { timeout: 60000 });
    const d = await S.page.evaluate(() => ({ cmps: document.querySelectorAll('.ws-cmp').length, svgs: document.querySelectorAll('.ws-cmp svg').length, rows: document.querySelectorAll('.ws-prow').length, hash: location.hash, href: document.querySelector('.ws-cmp').getAttribute('href'), pat: (document.querySelector('.ws-prow a') || {}).getAttribute && document.querySelector('.ws-prow a').getAttribute('href'), pressed: document.querySelectorAll('.ws-cell[aria-pressed="true"]').length }));
    ok(d.cmps >= 1 && d.rows >= 1, 'a click lists compounds and publications of the cell', d);
    ok(/^#struktur/.test(d.href) && /--c/.test(d.href) && /^#patent-/.test(d.pat || ''), 'compounds link to #struktur--c<id>, publications to the patent page', d);
    ok(/--s\d+-x\d+/.test(d.hash) && d.pressed === 1, 'the selected cell is in the route and marked', d.hash);
    await S.page.waitForFunction(() => document.querySelectorAll('.ws-cmp svg').length > 0, null, { timeout: 30000 });
    // the selection survives a reload
    await S.page.reload(); await S.page.waitForSelector('.ws-cmp', { timeout: 120000 });
    ok(await S.page.locator('.ws-cell[aria-pressed="true"]').count() === 1, 'the cell selection is restored from the route');
    await S.page.click('.seg button[data-m="claims"]');
    const m1 = await S.page.evaluate(() => ({ text: document.querySelector('.ws-scale').textContent, hash: location.hash }));
    ok(/compounds in claims/.test(m1.text) && /--mclaims/.test(m1.hash), 'metric toggle changes the scale and the route', m1);
    const tx = Date.now(); await S.page.selectOption('#ws-x', 'nTails'); await S.page.selectOption('#ws-y', 'linker');
    await S.page.waitForFunction(() => /number of tails/i.test((document.querySelector('.sec-title') || {}).textContent || ''), null, { timeout: 60000 }); timings.ui_axis_change_ms = Date.now() - tx;
    const w2 = await S.page.evaluate(() => ({ title: document.querySelector('.sec-title').textContent, empty: document.querySelectorAll('.ws-cell.k-hm0').length, hash: location.hash }));
    ok(/Dominant linker by number of tails/.test(w2.title) && w2.empty > 0, 'other axes: linker x tails shows empty (hatched) cells = white space', w2);
    await S.page.check('#ws-cl'); await S.page.waitForFunction(() => /after the filter/.test((document.querySelector('.k-stats') || {}).textContent || ''), null, { timeout: 60000 });
    ok(/--fcl1/.test(await S.page.evaluate(() => location.hash)), 'the filter is in the route (--fcl1)');
    const [g] = await Promise.all([S.page.waitForEvent('download', { timeout: 15000 }), S.page.click('text=Grid (CSV)')]);
    const gc = fs.readFileSync(await g.path(), 'utf8');
    ok(gc.charCodeAt(0) === 0xfeff && /compounds;publications;families;compounds_in_claims/.test(gc), 'grid CSV download', gc.slice(0, 160));
    await shot(S, 'whitespace-light');
    await noHScroll(S, 'whitespace desktop');
    // route with a bad axis falls back to the defaults
    await S.page.goto(srv.origin + '/#whitespace--xbogus--ybogus'); await S.page.reload(); await S.page.waitForSelector('.ws-cell', { timeout: 60000 });
    ok(/Longest tail \(C atoms\) by head group/.test(await S.page.textContent('.sec-title')), 'unknown axes in the route fall back to head x longest tail');
    clean(S, 'whitespace view'); await S.ctx.close();

    section('browser: grid timings in the page');
    S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#disclosure'); await S.page.waitForSelector('#dc-q', { timeout: 120000 });
    const tm = await S.page.evaluate(async () => {
      const o = {}; let t = performance.now(); let r = await LnpDisclosure.grid({ x: 'head', y: 'tailC' }); o.first_incl_load_ms = Math.round(performance.now() - t); o.first_compute_ms = r.ms; o.load_ms = r.msLoad;
      for (const [x, y] of [['nTails', 'linker'], ['amine', 'unsat'], ['head', 'branched'], ['tailTotal', 'tailC']]) { t = performance.now(); r = await LnpDisclosure.grid({ x, y }); o[x + '_' + y + '_ms'] = Math.round(performance.now() - t); }
      t = performance.now(); r = await LnpDisclosure.grid({ x: 'head', y: 'tailC', filters: { inClaims: true } }); o.filtered_ms = Math.round(performance.now() - t);
      t = performance.now(); const cd = await LnpDisclosure.cellDetail(r, r.xKeys.indexOf('tert-amine'), r.yKeys.indexOf('17-18'), { compounds: 48, patents: 60 }); o.cellDetail_ms = Math.round(performance.now() - t); o.detail = [cd.compounds.length, cd.patents.length, cd.nPatents];
      return o;
    });
    Object.keys(tm).forEach((k) => { timings['grid_' + k] = tm[k]; });
    ok(tm.first_compute_ms < 3000 && tm.nTails_linker_ms < 3000, 'grid computes in the page in under 3 s', tm);
    ok(tm.detail[0] > 0 && tm.detail[1] > 0, 'cellDetail returns compounds and publications', tm.detail);
    clean(S, 'timings'); await S.ctx.close();

    section('browser: #whitespace at 390 px, dark');
    S = await openPage(B, srv, { w: 390, h: 800, scheme: 'dark' });
    await S.page.goto(srv.origin + '/#whitespace--xnTails--ylinker');
    await S.page.waitForSelector('.ws-cell', { timeout: 120000 });
    await noHScroll(S, 'whitespace 390 px');
    const sc2 = await S.page.evaluate(() => { const t = document.querySelector('.ws-scroll'); return { inner: t.scrollWidth, outer: t.clientWidth }; });
    ok(sc2.inner >= sc2.outer, 'the grid sits in its own scroll box', sc2);
    await S.page.click('.ws-cell:not(.k-hm0) >> nth=3'); await S.page.waitForSelector('.ws-cmp', { timeout: 60000 });
    await noHScroll(S, 'whitespace 390 px with a cell open');
    await shot(S, 'whitespace-390-dark');
    clean(S, 'whitespace 390 dark'); await S.ctx.close();
  } finally { await B.close(); await srv.close(); }
}

(async () => {
  try { await unit(); if (!args.includes('--unit')) await browser(); } catch (e) { fails.push(cur + ': threw ' + (e && e.stack || e)); console.log('THREW', e && e.stack || e); }
  console.log('\n' + checks + ' checks, ' + fails.length + ' failed');
  fails.forEach((f) => console.log('  - ' + f));
  console.log('timings (ms): ' + JSON.stringify(timings));
  if (argv('json', '')) fs.writeFileSync(argv('json', ''), JSON.stringify({ checks, fails, timings }, null, 1));
  process.exit(fails.length ? 1 : 0);
})();
