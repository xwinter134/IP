#!/usr/bin/env node
/* Tests for the expiry timeline (web/engine/x-expiry.js, #expiry) and similar patents (web/engine/x-similar.js, #similar).
   usage: node tests/expiry_similar_test.cjs [--dist DIR] [--unit] [--shots DIR]
     --unit  Node part only (ICS, CSV, dates, cliff, scoring helpers with fake engines)
     --dist  a build made with: python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215
   Part 2 (Playwright + tests/artifact_server.cjs): expiry from a pasted list and from a stored profile, PTA of a US patent, ICS download,
   similar for a seed EP patent and text mode, window.claude absent, light / dark, 390 px, no request leaves the origin, timings.
   Exit code 1 when a check fails. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SCRATCH = '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/T9';
const DIST = path.resolve(argv('dist', path.join(SCRATCH, 'dist')));
const SHOTS = argv('shots', '');
const fails = []; let checks = 0, cur = 'setup'; const timings = {};
function section(n) { cur = n; console.log('\n## ' + n); }
function ok(cond, what, extra) {
  checks++;
  if (!cond) { fails.push(cur + ': ' + what); console.log('  FAIL ' + what + (extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
  else console.log('  ok   ' + what);
  return !!cond;
}
const E = require(path.join(ROOT, 'web', 'engine', 'x-expiry.js'));
const Sm = require(path.join(ROOT, 'web', 'engine', 'x-similar.js'));

/* ------------------------------------------------------------------------------------------ Part 1: Node */
function pat(o) { return Object.assign({ p: 0, pn: 'EP1B1', auth: 'EP', kind: 'B1', fam: 1, appNo: '1', title: 'T', assignee: 'A', pub: 20200101, app: 20170101, status: 'granted', exp: 0, deIn: 1 }, o); }
async function unit() {
  section('dates and escaping');
  ok(E._addYears('2016-02-29', 20) === '2036-02-29' && E._addYears('2017-02-28', 3) === '2020-02-28' && E._addYears('2000-02-29', 1) === '2001-02-28', 'addYears keeps the day and clamps 29 Feb');
  ok(E._escText('a,b;c\\d\ne') === 'a\\,b\\;c\\\\d\\ne', 'TEXT escaping: comma, semicolon, backslash, newline');
  const long = 'DESCRIPTION:' + 'x'.repeat(200), f = E._fold(long).split('\r\n');
  ok(f.length >= 3 && f.every((l, i) => Buffer.byteLength(l) <= 75 && (i === 0 || l[0] === ' ')), 'folding: every physical line <= 75 octets, continuations start with a space', f.map((l) => Buffer.byteLength(l)));
  ok(f.map((l, i) => (i ? l.slice(1) : l)).join('') === long, 'unfolding gives back the line');
  const mb = 'SUMMARY:' + '\u00e4\u20ac'.repeat(40), fm = E._fold(mb).split('\r\n');
  ok(fm.every((l) => Buffer.byteLength(l) <= 75) && fm.map((l, i) => (i ? l.slice(1) : l)).join('') === mb && fm.every((l) => !/\ufffd/.test(l)), 'folding never splits a multi-byte character');

  section('timeline, cliff, ICS and CSV with fake data');
  const P = [
    pat({ p: 0, pn: 'EP1B1', fam: 1, appNo: 'e1', title: '=HYPERLINK("x")' }),                         // granted, register
    pat({ p: 1, pn: 'EP1A1', kind: 'A1', fam: 1, appNo: 'e1', status: 'pending' }),                      // same application as EP1B1
    pat({ p: 2, pn: 'US2B2', auth: 'US', kind: 'B2', fam: 1, appNo: 'u2', app: 20120502, title: 'Comma, semi; "quote"\nline' }),
    pat({ p: 3, pn: 'US3A1', auth: 'US', kind: 'A1', fam: 2, appNo: 'u3', app: 20200101, status: 'pending' }),
    pat({ p: 4, pn: 'EP4B1', fam: 3, appNo: 'e4', app: 20050101, status: 'lapsed' }),
    pat({ p: 5, pn: 'WO5A1', auth: 'WO', kind: 'A1', fam: 3, appNo: 'w5', app: 20050101, status: 'unknown' }),
    pat({ p: 6, pn: 'EP6B1', fam: 4, appNo: 'e6', app: 20190301, deIn: 0 }),
    pat({ p: 7, pn: 'EP7A1', kind: 'A1', fam: 5, appNo: 'e7', app: 20210601, status: 'pending' })
  ];
  const ST = { 0: { code: 'granted', src: 'ep-register', asof: '2026-08-23', expiry_est: '2037-10-26', in_force_de: true, opposition: { filed: false }, filing: '2017-10-26' },
    2: { code: 'granted', src: 'us-calc', asof: '2026-11-11', expiry_est: '2034-01-17', pta_days: 625, term_base: '2012-05-02', terminal_disclaimer: true },
    4: { code: 'lapsed', src: 'ep-register', asof: '2026-08-23', expiry_est: '2025-01-01', in_force_de: false },
    6: { code: 'granted', src: 'ep-xml', asof: '2025-01-01', expiry_est: '2039-03-01', in_force_de: false } };
  E.configure({ data: { manifest: { snapshots: { ep_register: '2026-08-23' } }, patent: async (p) => P[p], status: async (p) => ST[p] || null, family: async (p) => P.filter((x) => x.fam === P[p].fam).map((x) => x.p), byPn: async (s) => { const x = P.find((q) => q.pn === s); return x ? x.p : -1; } }, now: () => '2026-11-11' });
  const ps = await E.setFrom({ source: 'pns', pns: 'EP1B1, US2B2\nUS3A1; EP4B1 WO5A1\nNOPE' }, {});
  ok(ps.length === 5 && ps.info.unknown.join() === 'NOPE', 'setFrom pns: 5 found (blank-separated pair split), 1 unknown', [ps, ps.info]);
  const fam = await E.setFrom({ source: 'pns', pns: ['EP1B1'] }, { family: true });
  ok(fam.length === 3, 'family option adds the family members', fam);
  const rows = await E.timeline([0, 1, 2, 3, 4, 5, 6], {});
  const by = Object.fromEntries(rows.map((r) => [r.pn, r]));
  ok(!by.WO5A1 && rows.skippedWo === 1, 'WO publications are not rights and are skipped');
  ok(by.EP1A1.superseded && !by.EP1B1.superseded, 'A1 of the same application is superseded by the B1');
  ok(by.US2B2.expiry.basis === 'filing + 20 y + PTA 625 days' && by.US2B2.expiry.ptaDays === 625 && by.US2B2.expiry.basisKind === 'pta' && by.US2B2.expiry.terminalDisclaimer === true, 'US basis names the PTA; terminal disclaimer true');
  ok(by.EP1B1.expiry.basis === 'filing + 20 y' && by.EP1B1.expiry.terminalDisclaimer === null && by.EP1B1.expiry.pte === 'not checked' && by.EP1B1.expiry.spc === 'not checked', 'EP basis, PTE and SPC "not checked", disclaimer not visible');
  ok(by.EP4B1.dead && by.EP4B1.deadReason === 'lapsed' && !by.EP4B1.inForce, 'lapsed right is dead');
  ok(by.US3A1.pending && !by.US3A1.inForce && by.US3A1.expiry.date === '2040-01-01' && by.US3A1.expiry.basisKind === 'computed', 'pending application: latest possible expiry computed from filing, no register record');
  ok(by.US3A1.noRecord && by.US3A1.stale, 'no register record counts as stale');
  ok(by.EP6B1.stale && by.EP6B1.flags.some((x) => /older than 6 months/.test(x)) && by.EP6B1.inForceDe === false && by.EP6B1.jur.join() === 'EP', 'old snapshot is stale; not in force in DE counts for EP only');
  ok(!by.EP1B1.stale, 'recent snapshot is not stale');
  const ep = await E.timeline([0, 2, 6], { jurisdictions: ['US'] });
  ok(ep.length === 1 && ep[0].pn === 'US2B2', 'jurisdiction filter US keeps only the US right', ep.map((r) => r.pn));
  ok(rows.families.length === 4 || rows.families.length === 3, 'rows are grouped by family', rows.families.length);

  const cl = E.cliff(rows);
  ok(cl.jurisdictions.EP.lastExpiry === '2039-03-01' && cl.jurisdictions.US.lastExpiry === '2034-01-17' && cl.jurisdictions.DE.lastExpiry === '2037-10-26', 'cliff: last in-force expiry per jurisdiction (DE excludes the right lapsed in DE)', cl.jurisdictions);
  ok(cl.jurisdictions.US.nPending === 1 && /pending application/.test(cl.jurisdictions.US.text) && /still grant/.test(cl.jurisdictions.US.text), 'cliff text carries the pending-applications caveat');
  const clp = E.cliff(await E.timeline([7], {}));
  ok(clp.jurisdictions.DE.nPending >= 1 && /pending application/.test(clp.jurisdictions.DE.text), 'a pending EP application gives the DE statement the pending caveat', clp.jurisdictions.DE);
  const y = Object.fromEntries(cl.years.map((x) => [x.year, x]));
  ok(y[2037].EP === 1 && y[2034].US === 1 && y[2040].pending === 1 && y[2039].EP === 1 && cl.nDead === 1 && cl.nSuperseded === 1, 'cliff: per-year counts, dead and superseded left out', cl.years);
  ok(cl.years.every((x, i, a) => i === 0 || x.year === a[i - 1].year + 1), 'cliff years are contiguous');

  const ics = E.toIcs(rows, { name: 'Test, "set"; 1', stamp: '20261111T000000Z' });
  const phys = ics.split('\r\n');
  ok(phys[phys.length - 1] === '' && phys[0] === 'BEGIN:VCALENDAR' && phys[phys.length - 2] === 'END:VCALENDAR' && !/[^\r]\n/.test(ics.replace(/\r\n/g, '')), 'ICS: CRLF everywhere, VCALENDAR frame');
  ok(phys.every((l) => Buffer.byteLength(l) <= 75), 'ICS: no physical line longer than 75 octets');
  const unf = ics.replace(/\r\n /g, '').split('\r\n');
  ok(unf.filter((l) => l === 'BEGIN:VEVENT').length === unf.filter((l) => l === 'END:VEVENT').length && unf.filter((l) => l === 'BEGIN:VEVENT').length === 4, 'ICS: balanced VEVENTs; one per live right (B1, US B2, A1 pending, EP6; not the dead or superseded ones)', unf.filter((l) => /^SUMMARY/.test(l)));
  ok(unf.includes('X-WR-CALNAME:Test\\, "set"\\; 1') && unf.includes('VERSION:2.0') && unf.some((l) => /^PRODID:/.test(l)), 'ICS: header properties, calendar name escaped');
  ok(unf.includes('UID:expiry-US2B2@lnp-patent-desk') && unf.includes('SUMMARY:Estimated expiry US2B2') && unf.includes('DTSTART;VALUE=DATE:20340117') && unf.includes('DTEND;VALUE=DATE:20340118'), 'ICS: stable UID, SUMMARY and all-day DTSTART/DTEND');
  const d = unf.find((l) => /^DESCRIPTION:/.test(l) && /PTA 625/.test(l));
  ok(d && /estimate\\; PTE\/SPC not checked\\; verify at the register/.test(d) && /Comma\\, semi\\; "quote"\\nline/.test(d), 'ICS: description with basis, caveat, and the title escaped (comma, semicolon, newline)', d);
  ok(E.toIcs(rows, { stamp: '20261111T000000Z', name: 'x' }) === E.toIcs(rows, { stamp: '20261111T000000Z', name: 'x' }) && E.toIcs(rows, { includeDead: true, stamp: 's' }).split('BEGIN:VEVENT').length === 6, 'ICS is deterministic; includeDead adds the lapsed right');
  ok(!/\u0000/.test(E.toIcs([{ pn: 'X1', status: 'granted', expiry: { date: '2030-01-01', basis: 'b\u0000\u0007' }, flags: [], title: 'a\u0001b' }])), 'ICS: control characters removed');

  const csv = E.toCsv(rows);
  ok(csv.charCodeAt(0) === 0xfeff && /^\ufeffpublication;authority;kind;family;status/.test(csv), 'CSV: BOM and header');
  ok(/'=HYPERLINK\("x"\)/.test(csv.replace(/""/g, '"')) && !/;=HYPERLINK/.test(csv), 'CSV: formula injection neutralised');
  ok(/"Comma, semi; ""quote""\nline"/.test(csv), 'CSV: separator, quote and newline quoted');
  ok(E._csvCell('+1', ';') === "'+1" && E._csvCell('@x', ';') === "'@x" && E._csvCell('-1', ';') === "'-1" && E._csvCell('\tx', ';') === "'\tx" && E._csvCell(' =1', ';') === "' =1" && E._csvCell('ok', ';') === 'ok', 'CSV: = + - @ tab and blank-then-= are neutralised');
  ok(/not checked/.test(csv) && /not visible/.test(csv) && /PTA 625 days/.test(csv), 'CSV: PTE/SPC "not checked", disclaimer "not visible", PTA basis');

  section('similar: scoring helpers');
  ok(Sm.jaccard(['A', 'B', 'C'], ['B', 'C', 'D']) === 0.5 && Sm.jaccard([], ['A']) === 0 && Sm.jaccard(['A', 'A'], ['A']) === 1, 'Jaccard over code sets');
  ok(Math.abs(Sm.combine({ text: 1, compounds: 0, cpc: 0 }) - 0.6) < 1e-9 && Math.abs(Sm.combine({ text: 1, compounds: null, cpc: null }) - 1) < 1e-9 && Sm.combine({ text: null, compounds: null, cpc: null }) === 0, 'combine: weights 0.6/0.25/0.15, missing parts drop out and the rest is renormalised');
  ok(Sm._compWeight(1) === 1 && Sm._compWeight(1000) < Sm._compWeight(10) && Sm._compScore([]) === 0 && Sm._compScore([1, 1, 1, 1, 1, 1]) > 0.95, 'compound score rises with shared specific compounds and falls with commonness');
  Sm.configure({ tok: require(path.join(ROOT, 'web', 'engine', 'tok.js')), df: async (t) => ({ lipid: 60000, cholesterol: 900, ionizable: 300 }[t] || 5), data: { manifest: { idx: { D: 900000 } } } });
  const tm = await Sm.terms('The ionizable lipid and the lipid and cholesterol, wherein claim 12 comprising zorbax zorbax', { n: 3 });
  ok(tm.length === 3 && tm[0].term === 'zorbax' && tm.every((x) => x.term !== 'wherein' && x.term !== 'claim' && x.term !== '12') && tm.every((x, i, a) => i === 0 || a[i - 1].weight >= x.weight), 'term picker: tf-idf order, generic words and numbers dropped', tm.map((x) => x.term));
}

/* ------------------------------------------------------------------------------------------ Part 2: browser */
async function openPage(B, srv, o) {
  const ctx = await B.newContext({ viewport: { width: o.w || 1280, height: o.h || 1000 }, colorScheme: o.scheme || 'light', reducedMotion: 'reduce', acceptDownloads: true });
  const st = { console: [], pageErrors: [], offOrigin: [] };
  await ctx.route((u) => u.origin !== srv.origin && u.protocol !== 'blob:' && u.protocol !== 'data:', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '/* answered by the test */' });
    st.offOrigin.push(route.request().url()); return route.abort();
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') st.console.push(m.text()); });
  page.on('pageerror', (e) => st.pageErrors.push(e.message));
  return { ctx, page, st };
}
function clean(S, label) {
  const bad = S.st.pageErrors.concat(S.st.console);
  ok(bad.length === 0, label + ': no console or page errors', bad.slice(0, 4));
  ok(S.st.offOrigin.length === 0, label + ': no request left the origin', S.st.offOrigin.slice(0, 4));
}
async function noHScroll(S, label) {
  const r = await S.page.evaluate(() => { const v = document.getElementById('view'); return { doc: document.documentElement.scrollWidth, win: window.innerWidth, view: v ? v.scrollWidth : 0, viewW: v ? v.clientWidth : 0 }; });
  ok(r.doc <= r.win + 1 && r.view <= r.viewW + 1, label + ': the page does not scroll horizontally', r);
}
async function shot(S, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } }

const SEED = 'EP3532103B1\nUS10000445B2\nEP3394030B2';
async function browser() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('\nBrowser part skipped: no dist at ' + DIST); return; }
  const pw = require('playwright');
  const srv = await require(path.join(ROOT, 'tests', 'artifact_server.cjs')).serve({ dist: DIST }), B = await pw.chromium.launch();
  try {
    section('browser: boot, window.claude absent, registration');
    let S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#expiry');
    await S.page.waitForSelector('#ex-run', { timeout: 120000 });
    const info = await S.page.evaluate(() => ({ claude: typeof window.claude, ev: LnpApp.views.expiry, sv: LnpApp.views.similar, e: typeof LnpExpiry, s: typeof LnpSimilar, ai: LnpAI.available(), act: LnpApp.ext.has('patentAction'), inRail: !!document.querySelector('#rail a[href="#expiry"], #rail a[href="#similar"]') }));
    ok(info.claude === 'undefined' && info.ai === false, 'window.claude is absent and LnpAI is not available', info);
    ok(info.ev && info.sv && info.ev.parent === 'tools' && info.sv.parent === 'tools' && !info.ev.rail && !info.sv.rail && !info.inRail && info.e === 'object' && info.s === 'object', 'both views registered as parent tools without a rail entry');
    ok(info.act, 'patentAction hook has entries');

    section('browser: expiry engine from a pasted list');
    let t0 = Date.now();
    const x = await S.page.evaluate(async (seed) => {
      const ps = await LnpExpiry.setFrom({ source: 'pns', pns: seed }, {}), rows = await LnpExpiry.timeline(ps, {}), cl = LnpExpiry.cliff(rows);
      return { ps, info: ps.info, rows: rows.map((r) => ({ pn: r.pn, auth: r.auth, status: r.status, inForce: r.inForce, filing: r.filing, ex: r.expiry, stale: r.stale, fam: r.family, sup: r.superseded })), cl, ics: LnpExpiry.toIcs(rows, { name: 'x' }), nFam: rows.families.length };
    }, SEED);
    timings.expiry_list_ms = Date.now() - t0;
    const us = x.rows.find((r) => r.pn === 'US10000445B2'), ep = x.rows.find((r) => r.pn === 'EP3532103B1');
    ok(x.ps.length === 3 && x.rows.length === 3, 'three seed patents resolved', x.info);
    ok(us && us.ex.ptaDays > 0 && /PTA \d+ days/.test(us.ex.basis) && us.ex.date > us.filing, 'US patent shows PTA in its basis (' + (us && us.ex.basis) + ')');
    ok(ep && ep.ex.date === ep.filing.replace(/^\d{4}/, (y) => String(+y + 20)) && ep.ex.basis === 'filing + 20 y', 'EP expiry is filing + 20 years', ep && [ep.filing, ep.ex.date]);
    ok(x.rows.every((r) => r.ex.pte === 'not checked' && r.ex.spc === 'not checked'), 'every row says PTE/SPC not checked');
    ok(x.cl.jurisdictions.EP.lastExpiry && x.cl.jurisdictions.US.lastExpiry && x.cl.years.length >= 3, 'cliff has dates for EP and US', x.cl.jurisdictions);
    ok(/BEGIN:VEVENT/.test(x.ics) && /Estimated expiry EP3532103B1/.test(x.ics.replace(/\r\n /g, '')) && x.ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'ICS from the real rows has events');
    const cm = await S.page.evaluate(async () => { const ps = await LnpExpiry.setFrom({ source: 'pns', pns: 'US 10,000,445\nEP 3 532 103 B1' }, {}); return { n: ps.length, unk: ps.info && ps.info.unknown }; });
    ok(cm.n === 2 && !(cm.unk && cm.unk.length), 'pasted list keeps "US 10,000,445" together', cm);
    const fam = await S.page.evaluate(async () => { const ps = await LnpExpiry.setFrom({ source: 'pns', pns: 'EP3532103B1' }, { family: true }); const rows = await LnpExpiry.timeline(ps, {}); return { n: ps.length, rows: rows.length, wo: rows.skippedWo, sup: rows.filter((r) => r.superseded).length }; });
    ok(fam.n > 1 && fam.wo >= 1 && fam.rows >= 1, 'family option adds members; WO publications skipped', fam);

    section('browser: expiry from a stored profile');
    const prof = await S.page.evaluate(async () => {
      const ex = (window.LnpProfile && LnpProfile.example) ? LnpProfile.example() : null;
      if (!ex) return { err: 'no LnpProfile.example' };
      ex.id = 'ex-test'; ex.name = 'Test profile'; await LnpStore.put('profiles', 'ex-test', ex);
      const t0 = performance.now(), ps = await LnpExpiry.setFrom({ source: 'profile', id: 'ex-test' }, {});
      const t1 = performance.now(), ps2 = await LnpExpiry.setFrom({ source: 'profile', id: 'ex-test' }, { candidates: false });
      const rows = await LnpExpiry.timeline(ps, {});
      return { n: ps.length, ms: Math.round(t1 - t0), n2: ps2.length, ms2: Math.round(performance.now() - t1), info: ps.info, rows: rows.length, lipids: (ex.lipids || []).map((l) => l.name) };
    });
    ok(!prof.err && prof.n > 0, 'profile source finds publications (' + prof.n + ' via routes ' + JSON.stringify(prof.info && prof.info.routes) + ')', prof);
    ok(prof.info && prof.info.routes.some((r) => /structure route/.test(r.name)) && prof.info.notes.concat(prof.info.routes.map((r) => r.name)).some((t) => /claim-text route/.test(t)), 'info says which routes ran (structure route; claim-text route run or skipped)', prof.info);
    timings.profile_with_candidates_ms = prof.ms; timings.profile_structure_only_ms = prof.ms2;
    ok(prof.n2 > 0 && prof.n2 <= prof.n, 'structure route alone is a subset (' + prof.n2 + ' of ' + prof.n + ')');
    const bad = await S.page.evaluate(() => LnpExpiry.setFrom({ source: 'profile', id: 'nope' }, {}).then(() => 'resolved', (e) => e.code));
    ok(bad === 'not_found', 'unknown profile rejects with not_found', bad);
    const ws = await S.page.evaluate(async () => { await LnpApp.marks.save('EP3532103B1', { star: true }); const ps = await LnpExpiry.setFrom({ source: 'watchlist' }, {}); return ps.map((p) => p); });
    ok(ws.length === 1, 'watchlist source gives the starred publication', ws);
    const sel = await S.page.evaluate(async () => { await LnpStore.put('settings', 'fto-selection', { pns: ['US10000445B2'], from: 'suche' }); return (await LnpExpiry.setFrom({ source: 'selection' }, {})).length; });
    ok(sel === 1, 'selection source reads settings/fto-selection', sel);
    const cmp = await S.page.evaluate(async () => { const ps = await LnpExpiry.setFrom({ source: 'compounds', compounds: ['ALC-0315'] }, {}); return { n: ps.length, notes: ps.info.notes }; });
    ok(cmp.n > 0, 'compounds source: publications naming ALC-0315 in claims (' + cmp.n + ')', cmp);
    clean(S, 'engine pass');
    await S.ctx.close();

    section('browser: #expiry view (list), light, 1280 px');
    S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#expiry--spns--lEP3532103B1-xUS10000445B2-xEP3394030B2');
    await S.page.waitForSelector('.ex-tl-row[data-pn]', { timeout: 120000 });
    await S.page.waitForSelector('.k-stats', { timeout: 30000 });
    const v = await S.page.evaluate(() => ({ lanes: document.querySelectorAll('.ex-tl-row[data-pn]').length, bars: document.querySelectorAll('.ex-bar').length, pta: document.querySelectorAll('.ex-bar.pta').length, now: document.querySelectorAll('.ex-tl-now').length,
      seg: document.querySelectorAll('.ex-chart svg .k-seg').length, jur: document.querySelectorAll('.ex-jur-item').length, rows: document.querySelectorAll('.ex-table tbody tr').length, text: document.querySelector('.ex-page').textContent }));
    ok(v.lanes === 3 && v.bars >= 3 && v.pta >= 1 && v.now >= 3, 'timeline: a lane per right, bars, a PTA segment for the US patent, today marker', v);
    ok(v.seg >= 3 && v.jur === 3, 'cliff chart columns and a statement per jurisdiction (EP, DE, US)', v);
    ok(/not checked/.test(v.text) && /PTE, SPC, paediatric extension, terminal disclaimers and maintenance fees after the snapshot are not checked/.test(v.text) && /register snapshot 2\d? ?\w* ?20\d\d|register snapshot/.test(v.text) && /not legal advice/.test(v.text), 'limits line states what is not checked, the snapshot and "not legal advice"');
    const tip = await S.page.evaluate(() => { const r = document.querySelector('.ex-tl-row[data-pn]'); r.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 400 })); const t = document.querySelector('.k-tip'); return t && !t.hidden ? t.textContent : ''; });
    ok(/Expiry \(estimate\)/.test(tip) && /PTE \/ SPC/.test(tip), 'a lane shows a tooltip with the estimate and PTE/SPC', tip);
    ok(await S.page.evaluate(() => Array.from(document.querySelectorAll('.ex-tl-lab')).slice(1).every((a) => /^#patent-/.test(a.getAttribute('href') || ''))), 'lane labels link to the patent page');
    const [dl] = await Promise.all([S.page.waitForEvent('download', { timeout: 15000 }), S.page.click('#ex-ics')]);
    const ics = fs.readFileSync(await dl.path(), 'utf8');
    ok(/\.ics$/.test(dl.suggestedFilename()) && ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n') && (ics.match(/BEGIN:VEVENT/g) || []).length === 3, 'ICS download: file name, frame, three events', ics.slice(0, 120));
    ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75) && /DTSTART;VALUE=DATE:\d{8}/.test(ics) && /estimate\\; PTE\/SPC not checked\\; verify at the register/.test(ics.replace(/\r\n /g, '')), 'ICS download: folded at 75 octets, all-day dates, caveat text');
    const [dl2] = await Promise.all([S.page.waitForEvent('download', { timeout: 15000 }), S.page.click('#ex-csv')]);
    const csv = fs.readFileSync(await dl2.path(), 'utf8');
    ok(csv.charCodeAt(0) === 0xfeff && /^\ufeffpublication;authority/.test(csv) && csv.split('\r\n').length >= 5 && /PTA \d+ days/.test(csv), 'CSV download: BOM, header, rows, PTA basis');
    await noHScroll(S, '1280 px');
    await shot(S, 'expiry-light-1280');
    // jurisdiction filter re-filters without a new source query
    await S.page.click('#ex-j-US'); await S.page.waitForFunction(() => document.querySelectorAll('.ex-tl-row[data-pn]').length === 2, null, { timeout: 10000 });
    ok(true, 'unticking US removes the US lane');
    clean(S, 'expiry view');
    await S.ctx.close();

    section('browser: #expiry view from the stored profile (route) and empty states');
    S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#expiry');
    await S.page.waitForSelector('#ex-profile');
    await S.page.evaluate(async () => { const ex = LnpProfile.example(); ex.id = 'ex-test'; ex.name = 'Test profile'; await LnpStore.put('profiles', 'ex-test', ex); });
    t0 = Date.now(); await S.page.goto(srv.origin + '/#expiry--sprofile--pex-2dtest');
    await S.page.reload();
    await S.page.waitForSelector('.ex-tl-row[data-pn]', { timeout: 120000 }); timings.expiry_view_profile_ms = Date.now() - t0;
    const pv = await S.page.evaluate(() => ({ lanes: document.querySelectorAll('.ex-tl-row[data-pn]').length, src: (document.querySelector('.ex-src') || {}).textContent, sel: (document.getElementById('ex-profile') || {}).value }));
    ok(pv.lanes >= 1 && /structure route/.test(pv.src) && pv.sel === 'ex-test', 'profile route builds the timeline and names the routes (' + pv.lanes + ' lanes)', pv);
    await S.page.click('button[data-s="pns"]'); await S.page.fill('#ex-text', 'XX999\nNOT A NUMBER'); await S.page.click('#ex-run');
    await S.page.waitForSelector('.ex-body .empty', { timeout: 30000 });
    ok(/No publication found/.test(await S.page.textContent('.ex-body')) && /Not found in this corpus/.test(await S.page.textContent('.ex-body')), 'unknown numbers: empty state with the list of unknown numbers');
    clean(S, 'profile view');
    await S.ctx.close();

    section('browser: #expiry dark and 390 px; null caps');
    S = await openPage(B, srv, { w: 390, h: 900, scheme: 'dark' });
    await S.ctx.addInitScript('window.claude = { use: function () { return Promise.resolve(null); } };');
    await S.page.goto(srv.origin + '/#expiry--spns--lEP3532103B1-xUS10000445B2--f1');
    await S.page.waitForSelector('.ex-tl-row[data-pn]', { timeout: 120000 });
    const dk = await S.page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, bar: getComputedStyle(document.querySelector('.ex-bar')).backgroundColor }));
    ok(dk.bg !== 'rgb(255, 255, 255)' && dk.bar !== 'rgba(0, 0, 0, 0)', 'dark theme applied to page and bars', dk);
    await noHScroll(S, '390 px expiry'); await shot(S, 'expiry-dark-390');
    ok(await S.page.evaluate(() => document.querySelector('.ex-tl').scrollWidth <= document.querySelector('.ex-tl').clientWidth + 1), 'timeline fits its box at 390 px (labels above the lanes)');
    const ax = await S.page.evaluate(() => { const t = Array.from(document.querySelectorAll('.ex-tl-axis .ex-tl-y')).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => a.left - b.left); let ov = 0; for (let i = 1; i < t.length; i++) if (t[i].left < t[i - 1].right - 1) ov++; return { n: t.length, ov }; });
    ok(ax.ov === 0, 'year labels of the axis do not overlap at 390 px', ax);
    clean(S, '390 px dark with null caps');
    await S.ctx.close();

    section('browser: similar engine for a seed EP patent');
    S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#similar-EP3532103B1');
    await S.page.waitForSelector('.sm-hit', { timeout: 120000 });
    t0 = Date.now();
    const sm = await S.page.evaluate(async () => {
      const r = await LnpSimilar.similar('EP3532103B1', { k: 25 });
      return { n: r.length, ms: r.ms, src: { terms: r.source.terms.length, cmp: r.source.compounds, cpc: r.source.cpc, text: r.source.text }, w: r.weights, fam: r.familyMembers.map((m) => m.pn), notes: r.notes,
        srcFam: (await LnpData.family(r.source.p)).length, srcFamId: (await LnpData.patent(r.source.p)).fam,
        hits: await Promise.all(r.map(async (h) => ({ pn: h.pn, score: h.score, parts: h.parts, why: h.why, fam: (await LnpData.patent(h.p)).fam, members: h.members, title: h.title }))) };
    });
    timings.similar_seed_ms = sm.ms;
    ok(sm.n === 25 && sm.src.terms === 25 && sm.src.cmp.used > 0 && sm.src.cpc.length > 0, '25 families, 25 terms, compounds and CPC codes of the source used', [sm.n, sm.src]);
    ok(sm.hits.every((h, i, a) => (i === 0 || a[i - 1].score >= h.score) && h.score > 0 && h.score <= 1), 'scores 0..1, sorted');
    ok(sm.hits.every((h) => h.fam !== sm.srcFamId && !sm.fam.includes(h.pn)), 'the source family is never listed as similar');
    ok(sm.srcFam > 1 && sm.fam.length === sm.srcFam - 1, 'family members are listed separately (' + sm.fam.length + ')', [sm.srcFam, sm.fam]);
    const withWhy = sm.hits.filter((h) => h.why.text.terms.length > 0), withComp = sm.hits.filter((h) => h.why.compounds.shared > 0), withCpc = sm.hits.filter((h) => h.why.cpc.shared.length > 0);
    ok(withWhy.length >= 15 && withComp.length >= 3 && withCpc.length >= 3, 'hits explain themselves: terms ' + withWhy.length + ', shared compounds ' + withComp.length + ', shared CPC ' + withCpc.length);
    ok(sm.hits.every((h) => Math.abs(h.score - Sm.combine(h.parts, sm.w)) < 1e-9), 'score equals the documented combination of the parts');
    ok(sm.hits.slice(0, 10).some((h) => /lipid/i.test(h.title)) && sm.hits.slice(0, 5).some((h) => h.why.compounds.shared >= 3), 'known related lipid families appear near the top', sm.hits.slice(0, 5).map((h) => [h.pn, h.title.slice(0, 40), h.why.compounds.shared]));
    ok(sm.hits.every((h) => h.why.compounds.examples.every((e) => !(e.nPatGlobal > 150))), 'commodity compounds (more than 150 publications worldwide) never count as shared');
    ok(sm.notes.length === 0, 'no notes for a patent with full text', sm.notes);
    const mem = await S.page.evaluate(async () => { const r = await LnpSimilar.similar('EP3532103B1', { k: 5, includeFamily: true }); return r.filter((h) => h.why.family).length; });
    ok(mem >= 1, 'includeFamily lists the family members with why.family = true', mem);
    const wo = await S.page.evaluate(async () => { const r = await LnpSimilar.similar('WO2018081480A1', { k: 5 }).then((x) => ({ n: x.length, notes: x.notes, via: x.source.text.via }), (e) => ({ err: e.code })); return r; });
    ok(!wo.err && wo.n >= 1, 'a publication without text of its own uses a family member (' + JSON.stringify(wo) + ')');
    const nf = await S.page.evaluate(() => LnpSimilar.similar('EP0000000X9', {}).then(() => 'resolved', (e) => e.code));
    ok(nf === 'not_found', 'unknown publication rejects with not_found', nf);

    section('browser: similar text mode');
    const tx = await S.page.evaluate(async () => {
      const text = 'A lipid nanoparticle composition comprising an ionizable cationic lipid, a phospholipid, cholesterol and a polyethylene glycol conjugated lipid, wherein the nucleic acid is messenger RNA encapsulated in the particle.';
      const r = await LnpSimilar.similar({ text }, { k: 10 });
      const alc = await LnpChem.names().then((n) => n.find((x) => x.name === 'ALC-0315'));
      const r2 = await LnpSimilar.similar({ text, smiles: [alc.smiles] }, { k: 10 });
      return { n: r.length, kind: r.source.kind, w: r.weights, cpc: r.source.cpc.length, why: r[0] && r[0].why, ms: r.ms, comp0: r.every((h) => h.why.compounds.shared === 0), w2: r2.weights, c2: r2.source.compounds, anyComp: r2.some((h) => h.why.compounds.shared > 0), nm: r2.notes };
    });
    ok(tx.n === 10 && tx.kind === 'text' && tx.w.text > 0 && tx.w.compounds === 0 && tx.w.cpc === 0 && tx.comp0, 'text mode: text part only', tx);
    ok(tx.why && tx.why.text.terms.length > 0, 'text-mode hits list their matched terms');
    ok(tx.w2.compounds > 0 && tx.c2.n >= 1 && tx.anyComp, 'text mode with a pasted SMILES adds the compound part', [tx.w2, tx.c2]);

    section('browser: #similar view');
    await S.page.goto(srv.origin + '/#similar-EP3532103B1'); await S.page.waitForSelector('.sm-hit', { timeout: 60000 });
    const sv = await S.page.evaluate(() => ({ hits: document.querySelectorAll('.sm-hit').length, bars: document.querySelectorAll('.sm-bar span').length, chips: document.querySelectorAll('.sm-hit .sm-term').length, comp: document.querySelectorAll('.sm-comp').length, cpc: document.querySelectorAll('.sm-cpc').length,
      terms: document.querySelectorAll('.sm-terms .sm-term').length, text: document.querySelector('.sm-page').textContent, fam: document.querySelectorAll('.sm-src a.chip').length, hrefs: Array.from(document.querySelectorAll('.sm-hit .k-pn')).slice(0, 3).map((a) => a.getAttribute('href')) }));
    ok(sv.hits === 25 && sv.bars >= 25 && sv.chips >= 50 && sv.comp >= 3 && sv.cpc >= 3 && sv.terms === 25 && sv.fam >= 1, 'result list: score bars, matched-term chips, shared compounds, classes, source terms, family chips', sv);
    ok(/not a novelty or infringement assessment/.test(sv.text) && /shared words, compounds and classes/.test(sv.text), 'limits line on the page');
    ok(sv.hrefs.every((h) => /^#patent-/.test(h || '')), 'hits link to the patent page', sv.hrefs);
    await noHScroll(S, '1280 px similar'); await shot(S, 'similar-light-1280');
    await S.page.click('button[data-m="text"]'); await S.page.waitForSelector('#sm-text');
    await S.page.fill('#sm-text', 'A lipid nanoparticle comprising an ionizable lipid, a helper lipid, cholesterol and a PEG-lipid encapsulating messenger RNA.'); await S.page.click('#sm-go');
    await S.page.waitForSelector('.sm-hit', { timeout: 60000 });
    ok(await S.page.evaluate(() => /Pasted text/.test(document.querySelector('.sm-src').textContent) && document.querySelectorAll('.sm-hit').length >= 10), 'text mode in the view lists hits');
    const pa = await S.page.evaluate(() => { const P = { pn: 'EP3532103B1', auth: 'EP' }; return LnpApp.ext.nodes('patentAction', P, {}).map((n) => n.textContent + '|' + n.getAttribute('href')); });
    ok(pa.some((t) => /^Similar patents\|#similar-EP3532103B1/.test(t)) && pa.some((t) => /^Expiry timeline\|#expiry/.test(t)), 'patent actions: Similar patents and Expiry timeline', pa);
    clean(S, 'similar view');
    await S.ctx.close();

    section('browser: #similar dark, 390 px');
    S = await openPage(B, srv, { w: 390, h: 900, scheme: 'dark' });
    await S.page.goto(srv.origin + '/#similar-EP3532103B1'); await S.page.waitForSelector('.sm-hit', { timeout: 120000 });
    await noHScroll(S, '390 px similar'); await shot(S, 'similar-dark-390');
    ok(await S.page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'), 'dark theme applied');
    clean(S, 'similar 390 px dark');
    await S.ctx.close();
  } finally { await B.close(); if (srv.close) srv.close(); }
}

(async () => {
  try { await unit(); if (!args.includes('--unit')) await browser(); }
  catch (e) { fails.push('crash: ' + (e && e.stack || e)); console.log('CRASH', e && e.stack || e); }
  console.log('\n' + checks + ' checks, ' + fails.length + ' failed');
  console.log('timings (ms): ' + JSON.stringify(timings));
  if (fails.length) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
})();
