/* Test of the shell extension hooks (LnpApp.ext), deep links (LnpLinks), legal timeline (LnpLegal, legal view, patent panel)
   and the extension facets of #suche, in headless Chromium behind the Artifact-host server (tests/artifact_server.cjs).
     node tests/hooks_test.cjs [--dist DIR] [--scratch DIR] [--shots DIR] [--limit 3000]
   Without --dist a scratch dist is built:
     python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215 --limit 3000
   Parts: unit (LnpLinks / LnpLegal in Node), ext (a test extension registers one of each hook; slots, isolation, facet
   route round trip and filtering, links, legal panel and view, compound dialog), none (no extension registered: the views
   carry no extension markup), tags (facets.js against a mock LnpTags), mobile (390 px, dark, window.claude absent),
   nullcaps (window.claude.use() resolves null). Exit code 1 when a check fails. No network: Google Fonts is answered
   locally, any other request that leaves the origin is aborted and fails the run. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { serve } = require('./artifact_server.cjs');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SHOTS = arg('shots', null);
const LIMIT = arg('limit', '3000');

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}
let nOk = 0, nFail = 0, part = '';
function ok(cond, name, detail) {
  if (cond) nOk++; else nFail++;
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (!cond && detail != null ? '\n          ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''));
  return !!cond;
}
function section(n) { part = n; console.log('\n== ' + n); }
async function step(name, fn) { try { await fn(); } catch (e) { ok(false, name + ' (step threw)', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); } }

/* ------------------------------------------------------------------------------------------ unit (Node) */
function unit() {
  section('unit: LnpLinks, LnpLegal (Node)');
  const L = require('../web/engine/x-links.js'), G = require('../web/engine/x-legal.js');
  const ps = L.patent({ pn: 'WO2023232976A1', auth: 'WO' });
  ok(ps.length === 3 && ps[0].href === 'https://patentscope.wipo.int/search/en/detail.jsf?docId=WO2023232976', 'WO: PATENTSCOPE document page', ps[0]);
  ok(ps[1].href === 'https://www.lens.org/lens/search/patent/list?q=WO2023232976A1', 'Lens search by number', ps[1].href);
  ok(ps[2].href === 'https://www.surechembl.org/document/WO-2023232976-A1', 'SureChEMBL document id CC-number-kind', ps[2].href);
  const ep = L.patent({ pn: 'EP3532103B1', auth: 'EP' });
  ok(ep[0].href === 'https://patentscope.wipo.int/search/en/result.jsf?query=PN%3AEP3532103', 'EP: PATENTSCOPE query', ep[0].href);
  ok(ep[2].href === 'https://www.surechembl.org/document/EP-3532103-B1', 'EP: SureChEMBL', ep[2].href);
  const us = L.patent({ pn: 'US20250108080A1', auth: 'US', appNo: '18/959314' });
  ok(us.length === 4 && us[3].href === 'https://patentcenter.uspto.gov/applications/18959314', 'US: Patent Center by application number', us.map((x) => x.href));
  ok(L.patent({ pn: 'US10166298B2', auth: 'US' }).length === 3, 'US without application number: no Patent Center link');
  ok(L.patent({ pn: 'junk' }).length === 0 && L.patent(null).length === 0, 'unparsable number gives no links');
  const c1 = L.compound({ id: 'SCHEMBL881351', smiles: 'CCCCN(C)C' });
  ok(c1.map((x) => x.id).join() === 'pubchem,surechembl,chembl', 'compound hit: PubChem, SureChEMBL, ChEMBL', c1.map((x) => x.id));
  ok(c1[0].href === 'https://pubchem.ncbi.nlm.nih.gov/#query=CCCCN(C)C&input_type=smiles' || c1[0].href.indexOf('input_type=smiles') > 0, 'PubChem by SMILES when no InChIKey', c1[0].href);
  ok(c1[1].href === 'https://www.surechembl.org/chemical/SCHEMBL881351', 'SureChEMBL compound page', c1[1].href);
  const key = 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N';
  const c2 = L.compound(key);
  ok(c2[0].href === 'https://pubchem.ncbi.nlm.nih.gov/#query=' + key && c2.length === 2, 'InChIKey string: PubChem by key and ChEMBL', c2);
  ok(L.compound({ smiles: 'CCO', inchikey: key })[0].href.indexOf(key) > 0, 'hit with an inchikey: PubChem by key');
  ok(L.compound('SCHEMBL12').map((x) => x.id).join() === 'surechembl,chembl' || L.compound('SCHEMBL12')[0].id === 'surechembl', 'SCHEMBL id string');
  ok(L.compound('').length === 0 && L.compound(null).length === 0, 'empty input gives no links');
  ok(L.compound('C'.repeat(2000)).every((x) => x.href.length < 400), 'overlong SMILES is not put into a URL');

  // legal timeline from synthetic records
  const P1 = { p: 1, pn: 'EP1000001A1', kind: 'A1', auth: 'EP', prio: 20150101, app: 20160102, pub: 20170105, grant: 0, appNo: '16000001', exp: 20360102 };
  const P2 = { p: 2, pn: 'EP1000001B1', kind: 'B1', auth: 'EP', prio: 20150101, app: 20160102, pub: 20200101, grant: 20200101, appNo: '16000001', exp: 20360102 };
  const ev = [{ date: '2023-05-01', text: 'Opposition filed' }, { date: '2024-01-10', text: 'Lapse of the patent in a contracting state' }, { date: '2022-02-02', text: 'Request for examination filed' }];
  const st = { src: 'ep-register', asof: '2026-08-23', code: 'granted', expiry_est: '2036-01-02', pta_days: null, lapsed_in: [{ cc: 'CH', date: '2024-01-10' }, { cc: 'FR', date: '2024-01-10' }],
    opposition: { filed: true, opponents: ['A Corp', 'B Corp'], outcome: 'maintained_amended', date_first_filed: '2023-04-30', note: 'appeal pending' }, appeal: true, unitary: null, fees_paid_years: [3, 4, 5], last_fee_date: '2021-01-05',
    events: ev, appeal_detail: [{ num: 'T0001/24-3304', result: null, result_date: null }, { num: 'T0001/24-3304', result: null, result_date: null }] };
  const tl = G.build([{ P: P1, st }, { P: P2, st }]);
  const kinds = tl.map((e) => e.kind);
  ok(tl.every((e, i) => i === 0 || e.date === null || tl[i - 1].date === null ? true : tl[i - 1].date <= e.date) && tl.findIndex((e) => e.date === null) > tl.length - 5, 'timeline sorted by date, undated facts last', tl.map((e) => (e.date || '-') + ' ' + e.kind));
  ['filing', 'priority', 'publication', 'grant', 'opposition', 'appeal', 'fee', 'lapse', 'expiry_est', 'event'].forEach((k) => ok(kinds.indexOf(k) >= 0, 'timeline has kind ' + k));
  ok(tl.filter((e) => e.kind === 'publication').length === 2, 'both publications are listed');
  ok(tl.filter((e) => e.kind === 'lapse').length === 1 && /CH, FR/.test(tl.find((e) => e.kind === 'lapse').text), 'lapses grouped per date, generic register line dropped', tl.filter((e) => e.kind === 'lapse'));
  ok(tl.filter((e) => e.kind === 'opposition' && /filed/.test(e.text)).length === 1 && tl.find((e) => /filed/.test(e.text) && e.kind === 'opposition').pn.length === 2, 'identical entries of two members are merged and list both numbers; the bare register event is dropped', tl.filter((e) => e.kind === 'opposition'));
  ok(tl.filter((e) => e.kind === 'appeal').length === 1, 'duplicate appeal rows collapse', tl.filter((e) => e.kind === 'appeal'));
  ok(tl.filter((e) => e.hot).every((e) => ['opposition', 'appeal', 'revocation'].indexOf(e.kind) >= 0) && tl.some((e) => e.hot), 'opposition / appeal are flagged hot');
  ok(tl.find((e) => e.kind === 'opposition' && /outcome/.test(e.text)).text.indexOf('maintained as amended') > 0, 'outcome wording present');
  const s = G.summarise(P1, st, { today: '2026-09-01' });
  ok(s.opposed && s.outcome === 'maintained_amended' && s.appealed && s.lapsedCc.join() === 'CH,FR' && s.asof === '2026-08-23' && s.stale === false, 'summary fields', s);
  ok(G.summarise(P1, st, { today: '2027-03-01' }).stale === true, 'stale when the snapshot is older than 6 months');
  ok(G.summarise(P1, null).hasStatus === false && G.summarise(P1, null).opposed === false, 'summary without status');
  ok(G.kindOf('Patent revoked') === 'revocation' && G.kindOf('Appeal filed') === 'appeal' && G.kindOf('Renewal fee paid') === 'fee' && G.kindOf('x') === 'event', 'register wording mapped to kinds');
  ok(G.kindOf('No opposition filed within time limit') === 'event' && G.kindOf('Communication of intention to grant') === 'event' && G.kindOf('Opposition filed') === 'opposition' && G.kindOf('Renewal fees not paid: Unitary patent protection lapsed') === 'unitary' && G.kindOf('Unitary effect lapsed') === 'unitary', 'negative / preliminary wording is not a hot or grant event; unitary lapse stays unitary');
  const D = { patent: async (p) => ({ 1: P1, 2: P2 })[p], status: async (p) => st, family: async () => [1, 2] };
  return Promise.all([G.timeline(1, { data: D }), G.summary(2, { data: D, family: true, today: '2026-09-01' })]).then(([t, sm]) => {
    ok(t.length === tl.length, 'timeline(p) over the family through LnpData-like source', t.length);
    ok(sm.opposed && sm.lapsedIn.length === 2, 'summary(p, {family}) merges members', sm);
  });
}

/* ------------------------------------------------------------------------------------------ browser helpers */
const TEST_EXT = `
(function () {
  function reg(App) {
    var E = App.ext, h = window.LnpUI.h;
    window.__xt = { destroyed: 0, allLen: -1, allType: '', resultInfo: null, calls: [] };
    E.patentAction(function (P, ctx) { return h('button.btn.xt-act', { type: 'button', 'data-xt': P.pn, text: 'XT action' }); });
    E.patentAction(function () { throw new Error('xt patentAction boom'); });
    E.claimAction(function (P, c, ctx) { return h('span.xt-claim', { text: 'XT claim ' + c.n }); });
    E.claimAction(function () { throw new Error('xt claimAction boom'); });
    E.patentPanel({ id: 'xtpanel', title: 'XT panel', over: 'Test', order: 99, when: function (P) { return P.auth !== 'WO'; }, render: function (P, el, ctx) { el.appendChild(h('p.xt-panel-body', { text: 'XT panel for ' + P.pn + ' lang ' + (ctx && ctx.lang) })); return function () { window.__xt.destroyed++; }; } });
    E.patentPanel({ id: 'xthidden', title: 'XT hidden', over: 'Test', order: 100, when: function () { return false; }, render: function (P, el) { el.textContent = 'must not render'; } });
    E.patentPanel({ id: 'xtwhen', title: 'XT when boom', order: 101, when: function () { throw new Error('xt when boom'); }, render: function () { } });
    E.patentPanel({ id: 'xtrender', title: 'XT render boom', order: 102, when: function () { return true; }, render: function () { throw new Error('xt render boom'); } });
    E.links(function (P) { return [{ label: 'XT link', href: 'https://example.org/p/' + encodeURIComponent(P.pn), title: 'xt title' }, { label: 'XT evil', href: 'javascript:alert(1)' }]; });
    E.links(function () { throw new Error('xt links boom'); });
    E.compoundAction(function (hit) { return h('span.xt-compound', { text: 'XT compound ' + hit.id }); });
    E.compoundAction(function () { throw new Error('xt compoundAction boom'); });
    function setOf(k, r) { return function (v) { return Promise.resolve(window.LnpData.ready ? 0 : 0).then(function () { var n = App.manifest.counts.patents, a = []; for (var p = 0; p < n; p++) if (p % k === +v) a.push(p); return Uint32Array.from(a); }); }; }
    E.searchFacet({ id: 'xtmod', title: 'XT mod 3', order: 1, counts: function (all) { window.__xt.allLen = all.length; window.__xt.allType = Object.prototype.toString.call(all); var c = [0, 0, 0]; for (var i = 0; i < all.length; i++) c[all[i] % 3]++; return Promise.resolve([0, 1, 2].map(function (v) { return { value: String(v), label: 'rest ' + v, n: c[v] }; })); }, ps: setOf(3) });
    E.searchFacet({ id: 'xtpar', title: 'XT parity', order: 2, counts: function (all) { var c = [0, 0]; for (var i = 0; i < all.length; i++) c[all[i] % 2]++; return [0, 1].map(function (v) { return { value: String(v), label: v ? 'odd' : 'even', n: c[v] }; }); }, ps: setOf(2) });
    E.searchFacet({ id: 'xtbad', title: 'XT bad', order: 3, counts: function () { throw new Error('xt counts boom'); }, ps: function () { return []; } });
    E.resultAction(function (info) { window.__xt.resultInfo = { query: info.query, total: info.total, hasAll: typeof info.all === 'function', filtersKeys: Object.keys(info.filters || {}) }; return h('button.btn.xt-res', { type: 'button', 'data-total': String(info.total), text: 'XT result action' }); });
    E.resultAction(function () { throw new Error('xt resultAction boom'); });
  }
  var cur;
  Object.defineProperty(window, 'LnpApp', { configurable: true, get: function () { return cur; }, set: function (v) { cur = v; if (v && v.ext) reg(v); } });
})();`;
const MOCK_TAGS = `
window.LnpTags = (function () {
  var G = { payload: [['mrna', 'mRNA', 3, 0], ['sirna', 'siRNA', 3, 1]], route: [['im', 'Intramuscular', 4, 0], ['iv', 'Intravenous', 4, 1]], legal: [['opposed', 'Opposed', 5, 0]], assignee: [['moderna', 'Moderna Inc', 7, 0]] };
  function set(k, r) { var n = (window.LnpApp && window.LnpApp.manifest && window.LnpApp.manifest.counts.patents) || 0, a = []; for (var p = 0; p < n; p++) if (p % k === r) a.push(p); return Uint32Array.from(a); }
  var index = {}; Object.keys(G).forEach(function (g) { G[g].forEach(function (x) { index[g + ':' + x[0]] = x; }); });
  window.__tagsCalls = { counts: 0, ps: [] };
  return {
    available: function () { return true; },
    list: function () { return [{ id: 'payload', title: 'Payload' }, { id: 'route', title: 'Route' }]; },
    counts: function (all) { window.__tagsCalls.counts++; var out = {}; Object.keys(G).forEach(function (g) { out[g] = G[g].map(function (x) { var n = 0; for (var i = 0; i < all.length; i++) if (all[i] % x[2] === x[3]) n++; return { value: g + ':' + x[0], label: x[1], n: n }; }); }); return Promise.resolve(out); },
    ps: function (v) { window.__tagsCalls.ps.push(v); var x = index[v]; return Promise.resolve(x ? set(x[2], x[3]) : new Uint32Array(0)); }
  };
})();`;

async function openPage(B, srv, o) {
  const ctx = await B.newContext({ viewport: { width: o.w || 1280, height: o.h || 900 }, colorScheme: o.scheme || 'light', reducedMotion: 'reduce' });
  const st = { console: [], pageErrors: [], offOrigin: [], blocked: [] };
  await ctx.route((u) => u.origin !== srv.origin && u.protocol !== 'blob:' && u.protocol !== 'data:', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '/* answered by the test */' });
    st.offOrigin.push(route.request().url()); return route.abort();
  });
  // blank: every extension file (engine/x-*.js and every view that is not one of the nine built-in views) answers empty
  if (o.blank) await ctx.route(/\/(engine\/x-[a-z0-9._-]+\.js|app\/views\/(?!(?:suche|patent|familie|struktur|produkte|fto|landschaft|merkliste|system)\.js)[a-z0-9_-]+\.js)$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  if (o.blankTags) await ctx.route(/\/engine\/x-tags\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  if (o.claude === 'null') await ctx.addInitScript('window.claude = { use: function () { return Promise.resolve(null); } };');
  if (o.init) for (const s of [].concat(o.init)) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') st.console.push(m.text()); });
  page.on('pageerror', (e) => st.pageErrors.push(e.message));
  return { ctx, page, st, origin: srv.origin };
}
async function go(S, hash, sel) {
  await S.page.goto(S.origin + '/' + hash);
  if (S.first !== false) S.first = false;
  if (sel) await S.page.waitForSelector(sel, { timeout: 90000 });
}
async function route(S, hash, sel) {        // in-app navigation without a reload
  await S.page.evaluate((h) => { location.hash = h; }, hash);
  if (sel) await S.page.waitForSelector(sel, { timeout: 90000 });
}
const settle = (S, ms = 400) => S.page.waitForTimeout(ms);
async function shot(S, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }
function cleanErrors(S, label, allowed) {
  const bad = S.st.pageErrors.concat(S.st.console).filter((t) => !(allowed || []).some((a) => t.indexOf(a) >= 0));
  ok(bad.length === 0, label + ': no console or page errors', bad.slice(0, 4));
  ok(S.st.offOrigin.length === 0, label + ': no request left the origin', S.st.offOrigin.slice(0, 4));
}
async function noHScroll(S, label) {
  const r = await S.page.evaluate(() => { const v = document.getElementById('view'); return { doc: document.documentElement.scrollWidth, win: window.innerWidth, view: v ? v.scrollWidth : 0, viewW: v ? v.clientWidth : 0 }; });
  ok(r.doc <= r.win + 1 && r.view <= r.viewW + 1, label + ': no horizontal scroll', r);
}

/* in-page scans: a patent with text, opposition and appeal; one without opposition; indexes of the build */
async function findTargets(S) {
  return S.page.evaluate(async () => {
    const n = LnpApp.manifest.counts.patents, out = { op: null, plain: null, n };
    for (let p = 0; p < n && !(out.op && out.plain); p++) {
      const P = await LnpData.patent(p); if (!P.text || P.auth !== 'EP') continue;
      const s = await LnpData.status(p);
      if (s && s.opposition && s.opposition.filed && (s.appeal_detail || []).length && !out.op) out.op = { p, pn: P.pn, fam: (await LnpData.family(p)).length };
      if (s && !s.opposition && !out.plain) out.plain = { p, pn: P.pn };
    }
    return out;
  });
}
const openFacet = async (S, title) => { await S.page.evaluate((t) => { Array.from(document.querySelectorAll('.facets details.facet')).forEach((d) => { if (d.querySelector('summary').childNodes[0].textContent.trim() === t) d.open = true; }); }, title); };
const countsOf = async (S) => S.page.evaluate(() => { const t = document.querySelector('.s-count').textContent.replace(/ /g, ' '); const m = /([\d.,]+) famil\w+ . ([\d.,]+) patent/.exec(t); return m ? { fam: +m[1].replace(/\D/g, ''), pat: +m[2].replace(/\D/g, ''), text: t } : { text: t }; });
const facetTitles = (S) => S.page.evaluate(() => Array.from(document.querySelectorAll('.facets > details.facet > summary, .facets > div > details.facet > summary')).map((s) => s.childNodes[0].textContent.trim()));

/* ------------------------------------------------------------------------------------------ browser parts */
async function partExt(B, srv) {
  section('ext: test extension registers one of each hook');
  const S = await openPage(B, srv, { init: TEST_EXT, claude: 'absent' });
  await step('boot', async () => {
    await go(S, '#suche-lipid', '.hrow');
    const info = await S.page.evaluate(() => ({ claude: typeof window.claude, keys: Object.keys(LnpApp.ext).sort(), ai: !!LnpApp.ai(), caps: LnpApp.caps }));
    ok(info.claude === 'undefined' && !info.ai && !info.caps.sample, 'window.claude absent: caps null, no AI', info);
    ok(['claimAction', 'compoundAction', 'links', 'patentAction', 'patentPanel', 'resultAction', 'searchFacet'].every((k) => info.keys.indexOf(k) >= 0) && ['list', 'nodes', 'has', 'call', 'linkItems'].every((k) => info.keys.indexOf(k) >= 0), 'LnpApp.ext has the seven registries and the getters', info.keys);
    const l = await S.page.evaluate(() => ({ patentPanel: LnpApp.ext.list('patentPanel').map((x) => x.id), facets: LnpApp.ext.list('searchFacet').map((x) => x.id) }));
    ok(l.patentPanel.indexOf('xtpanel') >= 0 && l.patentPanel.indexOf('legal') > l.patentPanel.indexOf('xtpanel') === false, 'ext.list(patentPanel) is ordered by order (legal 20 before xtpanel 99)', l);
    ok(l.facets.slice(0, 3).join() === 'xtmod,xtpar,xtbad', 'ext.list(searchFacet) ordered by order (the tag facets of the build follow)', l.facets);
  });

  await step('suche: facets, counts, resultAction', async () => {
    await S.page.waitForSelector('.facets details.facet', { timeout: 30000 });
    await S.page.waitForFunction(() => !!window.__xt && window.__xt.allLen >= 0, null, { timeout: 30000 });
    await settle(S, 600);
    const titles = await facetTitles(S);
    ok(titles.slice(0, 8).join('|') === 'Legal status|Office|Player|Year|CPC subclass|Kind code|Relevance tier|Content', 'built-in facet groups unchanged and first', titles);
    ok(titles.slice(8, 11).join('|') === 'XT mod 3|XT parity|XT bad', 'extension groups below the built-in ones, in order', titles);
    const x = await S.page.evaluate(() => ({ all: window.__xt.allLen, type: window.__xt.allType, rows: Array.from(document.querySelectorAll('.facet')).filter((d) => /XT mod 3/.test(d.textContent)).map((d) => Array.from(d.querySelectorAll('.f-row')).map((r) => r.textContent)), bad: Array.from(document.querySelectorAll('.facet')).filter((d) => /XT bad/.test(d.textContent)).map((d) => d.textContent)[0] }));
    const cnt = await countsOf(S);
    ok(x.type === '[object Uint32Array]' && x.all === cnt.pat, 'counts() receives the Uint32Array of the whole result (' + x.all + ' = patents of the result)', { x, cnt });
    ok(x.rows[0] && x.rows[0].length === 3 && x.rows[0][0].indexOf('rest 0') >= 0, 'facet rows (label and count) are drawn', x.rows);
    ok(/could not be computed/.test(x.bad || ''), 'a facet whose counts() throws shows a message, the others still render', x.bad);
    const rb = await S.page.evaluate(() => { const b = document.querySelector('.s-bar .xt-res'), csv = document.querySelector('.s-bar button[aria-label="CSV export"]'); return { has: !!b, afterCsv: !!(b && csv && csv.nextElementSibling === b), total: b && b.dataset.total, info: window.__xt.resultInfo, n: document.querySelectorAll('.s-bar .xt-res').length }; });
    ok(rb.has && rb.afterCsv && rb.n === 1 && +rb.total === cnt.pat && rb.info.hasAll && rb.info.query === 'lipid', 'resultAction node in the result toolbar after CSV, with {query, total, all}', rb);
    await shot(S, 'ext-suche-1280-light');
  });

  await step('suche: facet selection round trip and filtering', async () => {
    const before = await countsOf(S);
    await openFacet(S, 'XT mod 3'); await openFacet(S, 'XT parity');
    const row = S.page.locator('.facet', { hasText: 'XT mod 3' }).locator('.f-row', { hasText: 'rest 1' }).locator('input');
    await row.check();
    await S.page.waitForFunction((n) => { const t = document.querySelector('.s-count').textContent; return !/Search failed/.test(t) && t.indexOf(String(n)) < 0; }, before.pat, { timeout: 30000 }).catch(() => { });
    await settle(S, 800);
    const hash = await S.page.evaluate(() => location.hash);
    ok(/--fxtmod-3a1(--|$)/.test(hash), 'selection is written to the route as --f<facetId>:<value> (router list syntax)', hash);
    const after = await countsOf(S);
    const truth = await S.page.evaluate(async () => { const r = await LnpSearch.search('lipid', { filters: {}, limit: 1, facets: false, snippets: false, all: true }); let n = 0; for (const p of r.all) if (p % 3 === 1) n++; return { total: r.all.length, mod1: n }; });
    ok(after.pat === truth.mod1 && after.pat < before.pat, 'result is restricted to the ps of the value (' + after.pat + ' of ' + before.pat + ')', { after, truth });
    const rows = await S.page.evaluate(async () => { const out = []; for (const r of document.querySelectorAll('.hrow')) { const p = await LnpData.byPn(r.dataset.pn); out.push(p % 3); } return out; });
    ok(rows.length > 0 && rows.every((x) => x === 1), 'every listed result belongs to the selected value', rows);
    const chip = await S.page.evaluate(() => Array.from(document.querySelectorAll('.s-active .chip')).map((c) => c.textContent));
    ok(chip.some((t) => /XT mod 3: rest 1/.test(t)), 'active filter chip names the facet and value', chip);
    const counts2 = await S.page.evaluate(() => Array.from(document.querySelectorAll('.facet')).filter((d) => /XT mod 3/.test(d.textContent))[0].textContent);
    ok(/rest 0/.test(counts2) && /rest 2/.test(counts2), 'the other values of a facet with a selection stay selectable', counts2);
    ok(await S.page.evaluate(() => !!window.__xt.resultInfo && window.__xt.resultInfo.filtersKeys.indexOf('ps') >= 0), 'resultAction gets the filters including ps');
    // second facet: intersection
    await S.page.locator('.facet', { hasText: 'XT parity' }).locator('.f-row', { hasText: 'even' }).locator('input').check();
    await settle(S, 1200);
    const both = await countsOf(S);
    const truth2 = await S.page.evaluate(async () => { const r = await LnpSearch.search('lipid', { filters: {}, limit: 1, facets: false, snippets: false, all: true }); let n = 0; for (const p of r.all) if (p % 3 === 1 && p % 2 === 0) n++; return n; });
    ok(both.pat === truth2, 'two facets intersect (' + both.pat + ')', { both, truth2 });
    const h2 = await S.page.evaluate(() => location.hash);
    ok(/--fxtmod-3a1-xxtpar-3a0/.test(h2) || /--f.*xtmod.*xtpar/.test(h2), 'both selections in one list parameter', h2);
    // reload: state comes back from the route
    await S.page.reload(); await S.page.waitForSelector('.hrow', { timeout: 90000 }); await S.page.waitForFunction(() => window.__xt && window.__xt.allLen >= 0, null, { timeout: 30000 }); await settle(S, 800);
    const re = await countsOf(S), hash3 = await S.page.evaluate(() => location.hash);
    const checked = await S.page.evaluate(() => Array.from(document.querySelectorAll('.facet input:checked')).map((i) => i.parentElement.textContent));
    ok(hash3 === h2 && re.pat === both.pat && checked.some((t) => /rest 1/.test(t)) && checked.some((t) => /even/.test(t)), 'route reload restores selection, counts and result', { hash3, re, checked });
    // remove through the chip
    await S.page.locator('.s-active .chip', { hasText: 'XT parity' }).click(); await settle(S, 1200);
    const one = await countsOf(S);
    ok(one.pat === truth.mod1 && !/xtpar/.test(await S.page.evaluate(() => location.hash)), 'removing a chip drops that facet only', one);
    await S.page.locator('.s-active button', { hasText: 'Clear all filters' }).count();
    await S.page.locator('.facet', { hasText: 'XT mod 3' }).locator('.f-row', { hasText: 'rest 1' }).locator('input').uncheck(); await settle(S, 1000);
    ok(!/--f/.test(await S.page.evaluate(() => location.hash)) && (await countsOf(S)).pat === before.pat, 'unchecking restores the unfiltered route and result', await S.page.evaluate(() => location.hash));
    // saved search keeps the route but not the ps array
    await S.page.locator('.facet', { hasText: 'XT mod 3' }).locator('.f-row', { hasText: 'rest 2' }).locator('input').check(); await settle(S, 800);
    await S.page.evaluate(() => { document.querySelector('button[aria-label="Save search"]').click(); }); await S.page.waitForSelector('#save-name');
    await S.page.evaluate(() => { document.querySelector('#save-name').closest('.popover, div').querySelector('button.primary').click(); }); await settle(S, 600);
    const saved = await S.page.evaluate(async () => { const rows = await LnpStore.entries('searches'); const v = rows[rows.length - 1].value; return { hash: v.hash, ps: !!(v.filters && v.filters.ps) }; });
    ok(/--fxtmod/.test(saved.hash) && !saved.ps, 'saved search stores the route, not the patent index array', saved);
    await S.page.locator('.s-active .chip', { hasText: 'XT mod 3' }).click(); await settle(S, 600);
  });

  let T = null;
  await step('patent page: slots', async () => {
    T = await findTargets(S);
    ok(T.op && T.plain, 'found a patent with opposition and appeal and one without opposition in the build', T);
    await route(S, '#patent-' + T.op.pn, '.claim'); await S.page.waitForSelector('[data-ext-panel="legal"] .lg-it:not([hidden])', { timeout: 30000 }); await settle(S, 600);
    const d = await S.page.evaluate(() => {
      const acts = Array.from(document.querySelectorAll('.pt-actions > *')), meta = Array.from(document.querySelectorAll('.claim-meta')), main = document.querySelector('.pt-main'), secs = Array.from(main.children).map((e) => e.getAttribute('data-ext-panel') || (e.querySelector('h2') || {}).textContent || e.className);
      return { actTxt: acts.map((a) => a.textContent.trim()), lastAct: acts.length && acts[acts.length - 1].classList.contains('xt-act'), xtIdx: acts.findIndex((a) => a.classList.contains('xt-act')), nClaims: document.querySelectorAll('article.claim').length, nMeta: meta.length, nXt: meta.filter((m) => m.lastElementChild && m.lastElementChild.classList.contains('xt-claim')).length, secs,
        panel: (document.querySelector('[data-ext-panel="xtpanel"]') || {}).textContent, hidden: !!document.querySelector('[data-ext-panel="xthidden"]'), whenBoom: !!document.querySelector('[data-ext-panel="xtwhen"]'), renderBoom: !!document.querySelector('[data-ext-panel="xtrender"]'),
        links: Array.from(document.querySelectorAll('.links a')).map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')]),
        errs: LnpApp.errors.map((e) => e.where) };
    });
    // the build also carries the real tool extensions (context pack, expiry, similar): every extension node follows the four built-ins
    ok(d.actTxt.slice(0, 4).join('|') === 'Watch|Compare family|Check FTO|Number' && d.xtIdx >= 4 && d.actTxt.filter((t) => t === 'XT action').length === 1, 'patentAction node follows the built-in buttons', d.actTxt);
    ok(d.nClaims > 0 && d.nMeta === d.nClaims && d.nXt === d.nClaims, 'claimAction node in the meta row of every claim, after the built-in buttons (' + d.nXt + '/' + d.nClaims + ')', d);
    ok(/XT panel for/.test(d.panel || '') && /lang/.test(d.panel), 'patentPanel rendered with (P, el, ctx)', d.panel);
    const i1 = d.secs.indexOf('Claims') >= 0 ? d.secs.indexOf('Claims') : 0, iX = d.secs.indexOf('xtpanel'), iL = d.secs.indexOf('legal');
    ok(iX > i1 && iL > i1 && iL < iX && iX === d.secs.length - 1, 'extension panels come after the built-in sections, ordered by order', d.secs);
    ok(!d.hidden && !d.whenBoom && !d.renderBoom, 'panel with when()=false, throwing when() and throwing render() leave no section');
    const L = d.links.map((x) => x[0]);
    ok(L.indexOf('Espacenet') === 0 && L.indexOf('XT link') > L.indexOf('Espacenet') && L.indexOf('PATENTSCOPE') > 0 && L.indexOf('Lens') > 0 && L.indexOf('SureChEMBL') > 0, 'external links: built-in first, then extension links', L);
    ok(d.links.every((x) => x[0] === 'Espacenet' || x[0] === 'EP Register' || (x[2] === 'noopener noreferrer' && x[3] === '_blank')) && L.indexOf('XT evil') < 0, 'extension links open with rel=noopener noreferrer target=_blank; non-http link dropped', d.links);
    const href = (n) => (d.links.find((x) => x[0] === n) || [])[1];
    const num = T.op.pn.replace(/^EP(\d+).*$/, '$1');
    ok(href('PATENTSCOPE') === 'https://patentscope.wipo.int/search/en/result.jsf?query=PN%3AEP' + num && href('SureChEMBL').indexOf('/document/EP-' + num + '-') > 0 && href('Lens').indexOf('https://www.lens.org/lens/search/patent/list?q=EP' + num) === 0 && href('XT link') === 'https://example.org/p/' + T.op.pn, 'deep link hrefs', d.links);
    ok(['ext patentAction', 'ext claimAction', 'ext links', 'ext patentPanel xtwhen', 'ext patentPanel xtrender'].every((w) => d.errs.some((e) => e.indexOf(w) === 0)), 'throwing hooks are logged with App.logError and isolated', d.errs);
    await shot(S, 'ext-patent-1280-light');
  });

  await step('patent page: legal panel', async () => {
    const d = await S.page.evaluate(() => {
      const sec = document.querySelector('[data-ext-panel="legal"]'); if (!sec) return null;
      const its = Array.from(sec.querySelectorAll('.lg-it'));
      return { title: sec.querySelector('h2').textContent, n: its.length, hotWarn: its.filter((i) => i.classList.contains('warn')).map((i) => i.textContent), hotCrit: its.filter((i) => i.classList.contains('crit')).map((i) => i.textContent), pills: Array.from(sec.querySelectorAll('.lg-sum .pill')).map((p) => p.className + '|' + p.textContent),
        text: sec.textContent, link: (sec.querySelector('.lg-limits a') || {}).getAttribute && sec.querySelector('.lg-limits a').getAttribute('href'), dates: its.map((i) => i.querySelector('.lg-d').textContent) };
    });
    ok(d && d.title === 'Legal and prosecution timeline' && d.n >= 5, 'legal panel renders a timeline (' + (d && d.n) + ' entries)', d && d.n);
    ok(d.hotWarn.length >= 1 && d.hotCrit.length >= 1, 'opposition (warn) and appeal (crit) entries are highlighted', { w: d.hotWarn, c: d.hotCrit });
    ok(d.pills.some((p) => /pill warn\|Opposition filed/.test(p)) && d.pills.some((p) => /pill crit\|Appeal on record/.test(p)), 'summary pills for opposition and appeal', d.pills);
    ok(/Register snapshot of \d/.test(d.text) && /later events are not seen/.test(d.text) && /not a full file history/.test(d.text), 'as-of date and limits line', d.text.slice(-260));
    ok(d.link === '#legal-' + T.op.pn, 'link to the family view', d.link);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.locator('[data-ext-panel="legal"]').screenshot({ path: path.join(SHOTS, 'ext-legal-panel-1280-light.png') }); }
    const flat = await S.page.evaluate(() => Array.from(document.querySelectorAll('[data-ext-panel="legal"] .lg-it .lg-d')).filter((e) => !e.classList.contains('lg-nod')).map((e) => e.textContent));
    const ms = flat.map((t) => Date.parse(t + ' UTC'));
    ok(ms.every((v, i) => i === 0 || ms[i - 1] <= v), 'dated entries ascend', flat);
    // untrusted text never becomes markup
    ok(await S.page.evaluate(() => !document.querySelector('[data-ext-panel="legal"] script, [data-ext-panel="legal"] img')), 'no markup inside the panel');
    await route(S, '#patent-' + T.plain.pn, '.claim'); await settle(S, 800);
    ok(await S.page.evaluate(() => document.querySelectorAll('[data-ext-panel="legal"] .pill.warn').length === 0), 'a patent without opposition shows no opposition highlight');
    // WO: xtpanel has when false for WO; destroy functions run on unmount
    const dBefore = await S.page.evaluate(() => window.__xt.destroyed);
    await route(S, '#suche', '.hrow'); await settle(S, 300);
    const dAfter = await S.page.evaluate(() => window.__xt.destroyed);
    ok(dAfter > dBefore, 'panel destroy functions run on unmount (' + dBefore + ' -> ' + dAfter + ')');
  });

  await step('legal view', async () => {
    await route(S, '#legal-' + T.op.pn, '.lg-page .lg-tl'); await settle(S, 800);
    const d = await S.page.evaluate(() => ({ h1: document.querySelector('h1').textContent, rows: document.querySelectorAll('.lg-page table tbody tr').length, items: document.querySelectorAll('.lg-page .lg-it').length, chips: Array.from(document.querySelectorAll('.lg-chips .chip')).map((c) => c.textContent), hot: document.querySelectorAll('.lg-page .lg-it.hot').length, limits: document.querySelector('.lg-limits-box').textContent, asof: document.querySelector('.lg-asof').textContent, pn: document.querySelectorAll('.lg-m').length, parent: LnpApp.views.legal && LnpApp.views.legal.parent, rail: !!(LnpApp.views.legal && LnpApp.views.legal.rail), railLinks: Array.from(document.querySelectorAll('#rail a')).map((a) => a.getAttribute('href')) }));
    ok(d.rows === T.op.fam && d.items > 5 && d.hot >= 1, 'legal view shows the whole family (' + d.rows + ' members) and the merged timeline', d);
    ok(d.parent === 'suche' && d.rail === false && d.railLinks.indexOf('#legal') < 0, 'registered as rail:false, parent suche');
    ok(/not seen/.test(d.asof) && /Register snapshot of/.test(d.asof) && /Limits/.test(d.limits), 'as-of and limits line on the view', d.asof);
    await S.page.locator('.lg-chips .chip', { hasText: 'Opposition' }).first().click();
    const f = await S.page.evaluate(() => Array.from(document.querySelectorAll('.lg-page .lg-it')).every((i) => i.dataset.kind === 'opposition'));
    ok(f, 'kind filter chips restrict the list');
    await shot(S, 'ext-legal-1280-light');
    await route(S, '#legal-EP0000000000X9', '.empty'); ok(/not in the dataset|Not in dataset/i.test(await S.page.evaluate(() => document.querySelector('.empty').textContent)), 'unknown number: readable message');
  });

  await step('struktur: compound dialog', async () => {
    await route(S, '#struktur--cSCHEMBL881351', '.k-cdlg-top .x-links'); await settle(S, 500);
    const d = await S.page.evaluate(() => ({ xt: !!document.querySelector('.k-cdlg-top .k-row .xt-compound'), links: Array.from(document.querySelectorAll('.k-cdlg-top .x-links a')).map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')]), buttons: Array.from(document.querySelectorAll('.k-cdlg-top .k-row > button')).map((b) => b.textContent.trim()), label: (document.querySelector('.x-links-l') || {}).textContent }));
    ok(d.xt, 'compoundAction node in the compound dialog');
    ok(d.buttons.slice(0, 3).join('|') === 'Find similar|Same scaffold|SMILES', 'built-in dialog buttons unchanged and first', d.buttons);
    ok(d.label === 'External' && d.links.map((l) => l[0]).join() === 'PubChem,SureChEMBL,ChEMBL' && d.links.every((l) => l[2] === 'noopener noreferrer' && l[3] === '_blank'), 'External link row: PubChem, SureChEMBL, ChEMBL', d.links);
    ok(d.links[1][1] === 'https://www.surechembl.org/chemical/SCHEMBL881351' && /^https:\/\/pubchem\.ncbi\.nlm\.nih\.gov\/#query=/.test(d.links[0][1]) && /^https:\/\/www\.ebi\.ac\.uk\/chembl\//.test(d.links[2][1]), 'compound hrefs', d.links);
    await shot(S, 'ext-compound-1280-light');
  });

  await step('theme switch (dark) keeps the extension markup', async () => {
    await route(S, '#patent-' + T.op.pn, '[data-ext-panel="legal"] .lg-it:not([hidden])'); await S.page.emulateMedia({ colorScheme: 'dark' }); await settle(S, 500);
    const c = await S.page.evaluate(() => { const bg = getComputedStyle(document.body).backgroundColor, hot = document.querySelector('.lg-it.hot.warn'); return { bg, hotColor: hot && getComputedStyle(hot).boxShadow }; });
    ok(/rgb\(23, 18, 18\)/.test(c.bg) && !!c.hotColor, 'dark theme applied, highlight styled', c);
    await shot(S, 'ext-patent-1280-dark');
  });
  const errs = await S.page.evaluate(() => LnpApp.errors.map((e) => e.where + ': ' + e.message));
  const unexpected = errs.filter((e) => !/^ext (patentAction|claimAction|links|compoundAction|resultAction|patentPanel xtwhen|patentPanel xtrender|searchFacet xtbad)/.test(e));
  ok(unexpected.length === 0, 'App.errors holds only the deliberate hook failures', unexpected);
  cleanErrors(S, 'ext', []);
  await S.ctx.close();
  return T;
}

async function partNone(B, srv, T) {
  section('none: no extension registered (extension files blanked): views as before');
  const S = await openPage(B, srv, { blank: true });
  await go(S, '#suche-lipid', '.hrow'); await S.page.waitForSelector('.facets details.facet', { timeout: 30000 }); await settle(S, 800);
  const d = await S.page.evaluate(() => ({ titles: Array.from(document.querySelectorAll('.facets > *')).map((e) => e.tagName + ':' + (e.querySelector('summary') ? e.querySelector('summary').childNodes[0].textContent.trim() : '')), bar: Array.from(document.querySelectorAll('.s-bar > *')).length, has: Object.keys(LnpApp.ext).length, any: ['patentAction', 'claimAction', 'patentPanel', 'links', 'compoundAction', 'searchFacet', 'resultAction'].filter((k) => LnpApp.ext.has(k)), hash: location.hash }));
  ok(d.titles.length === 8 && d.titles.every((t) => /^DETAILS:/.test(t)) && d.any.indexOf('searchFacet') < 0 && d.any.indexOf('resultAction') < 0 && d.any.indexOf('links') < 0, 'search: eight built-in facet groups, no facet / result action registered, no extra wrapper', d);
  ok(d.bar === 7, 'result toolbar has its seven built-in controls', d.bar);
  ok(d.hash === '#suche-lipid', 'route unchanged by the extension code', d.hash);
  await route(S, '#patent-' + T.op.pn, '.claim'); await settle(S, 800);
  const p = await S.page.evaluate(() => ({ acts: Array.from(document.querySelectorAll('.pt-actions > *')).map((a) => a.textContent.trim()), links: Array.from(document.querySelectorAll('.links a')).map((a) => a.textContent.trim()), panels: document.querySelectorAll('[data-ext-panel]').length, legal: document.querySelectorAll('[data-ext-panel="legal"], [data-ext-panel="xtpanel"]').length, meta: Array.from(document.querySelectorAll('.claim-meta')).map((m) => m.children.length), secs: Array.from(document.querySelectorAll('.pt-main > section')).map((s) => s.querySelector('h2').textContent) }));
  ok(p.acts.length === 4 && p.legal === 0 && p.links.join() === 'Espacenet,EP Register,Google Patents' + (p.links.indexOf('USPTO') >= 0 ? ',USPTO' : ''), 'patent: four built-in actions, built-in links only, no extension panel', p);
  ok(p.meta.every((n) => n === 2 || n === 3), 'claim meta rows hold only the built-in controls', p.meta.slice(0, 6));
  await route(S, '#struktur--cSCHEMBL881351', '.k-cdlg-top'); await settle(S, 400);
  ok(await S.page.evaluate(() => document.querySelectorAll('.k-cdlg-top .k-row > *').length === 3 && !document.querySelector('.x-links')), 'compound dialog: three built-in buttons only');
  cleanErrors(S, 'none', []);
  await S.ctx.close();
}

async function partTags(B, srv) {
  section('tags: facets.js against a mock LnpTags (null capabilities pass)');
  const S = await openPage(B, srv, { init: MOCK_TAGS, claude: 'null', blankTags: true });
  await go(S, '#suche-lipid', '.hrow'); await S.page.waitForFunction(() => window.__tagsCalls.counts > 0, null, { timeout: 30000 }); await settle(S, 800);
  const cl = await S.page.evaluate(async () => ({ use: await window.claude.use('sample'), ai: !!LnpApp.ai() }));
  ok(cl.use === null && !cl.ai, 'claude.use() resolves null: no AI, page works', cl);
  const titles = await facetTitles(S);
  ok(titles.slice(8).join('|') === 'Payload|Route|Legal events|Assignee (normalised)', 'one facet per tag group plus Legal events and Assignee (normalised)', titles);
  const calls = await S.page.evaluate(() => window.__tagsCalls.counts);
  ok(calls <= 4, 'one counts() call serves all groups of an array (' + calls + ' calls)', calls);
  await openFacet(S, 'Payload');
  await S.page.locator('.facet', { hasText: 'Payload' }).locator('.f-row', { hasText: 'siRNA' }).locator('input').check(); await settle(S, 1500);
  const hash = await S.page.evaluate(() => location.hash), cnt = await countsOf(S);
  const truth = await S.page.evaluate(async () => { const r = await LnpSearch.search('lipid', { filters: {}, limit: 1, facets: false, snippets: false, all: true }); let n = 0; for (const p of r.all) if (p % 3 === 1) n++; return n; });
  ok(/--fpayload-3apayload-3asirna|--fpayload-3asirna/.test(hash) || hash.indexOf('payload') > 0, 'tag selection in the route', hash);
  ok(cnt.pat === truth && (await S.page.evaluate(() => window.__tagsCalls.ps.join())).indexOf('payload:sirna') >= 0, 'search restricted to LnpTags.ps(value) (' + cnt.pat + ')', { cnt, truth });
  const empty = await S.page.evaluate(() => Array.from(document.querySelectorAll('.facet')).map((d) => d.querySelector('summary').childNodes[0].textContent.trim()));
  ok(empty.indexOf('Legal events') >= 0, 'Legal events facet is drawn from the mock counts');
  cleanErrors(S, 'tags', []);
  await S.ctx.close();
  // LnpTags absent: facets.js registers nothing (covered by the "none" part); with available() false as well
  const S2 = await openPage(B, srv, { blankTags: true, init: "window.LnpTags = { available: function () { return false; }, list: function () { return ['payload']; }, counts: function () { return {}; }, ps: function () { return []; } };" });
  await go(S2, '#suche-lipid', '.hrow'); await settle(S2, 800);
  ok((await facetTitles(S2)).length === 8, 'LnpTags.available() false: no extension facet');
  await S2.ctx.close();
}

async function partRealTags(B, srv) {
  section('real tags: LnpTags of the build through the shell hook');
  const S = await openPage(B, srv, {});
  await go(S, '#suche-lipid', '.hrow'); await settle(S, 1500);
  const av = await S.page.evaluate(async () => { if (!window.LnpTags) return null; await LnpTags.init(); return { ok: LnpTags.available(), ids: LnpApp.ext.list('searchFacet').map((f) => f.id), groups: LnpTags.list().map((g) => g.id) }; });
  if (!av || !av.ok) { ok(true, 'no tags data in this build: no tag facet registered (' + JSON.stringify(av && av.ids) + ')'); ok(!av || av.ids.length === 0, 'nothing registered without tag data', av); await S.ctx.close(); return; }
  ok(av.ids.indexOf('legal') >= 0 && av.ids.indexOf('assignee') >= 0 && av.groups.every((g) => av.ids.indexOf(g.replace(/[^A-Za-z]/g, '')) >= 0), 'one facet per tag group plus legal and assignee', av);
  await S.page.waitForFunction(() => Array.from(document.querySelectorAll('.facet .f-row')).length > 40, null, { timeout: 30000 }).catch(() => { });
  const first = await S.page.evaluate(async () => {
    const all = (await LnpSearch.search('lipid', { filters: {}, limit: 1, facets: false, snippets: false, all: true })).all, rows = LnpTags.counts(all);
    const g = LnpTags.list()[0], v = (rows[g.id] || []).filter((x) => x.n > 0 && x.n < all.length)[0];
    if (!v) return null;
    const set = new Set(LnpTags.ps(v.value)); let n = 0; for (const p of all) if (set.has(p)) n++;
    return { group: g.id, title: g.title || g.label, label: v.label, value: v.value, n, total: all.length };
  });
  ok(!!first, 'a tag value with hits in the result exists', first);
  if (first) {
    await openFacet(S, first.title);
    await S.page.locator('.facet', { hasText: first.title }).locator('.f-row', { hasText: first.label }).first().locator('input').check(); await settle(S, 1800);
    const cnt = await countsOf(S), hash = await S.page.evaluate(() => location.hash);
    ok(cnt.pat === first.n && hash.indexOf('--f' + first.group.replace(/[^A-Za-z]/g, '')) >= 0, 'selecting "' + first.label + '" restricts the result to LnpTags.ps (' + cnt.pat + ' of ' + first.total + ')', { cnt, hash, first });
  }
  if (first) {
    // direct load of a facet hash: the facet registers after the first search; the result must end up filtered
    const S3 = await openPage(B, srv, {});
    const hv = '#suche-lipid--f' + first.group.replace(/[^A-Za-z]/g, '') + '-3a' + encodeURIComponent(first.value);
    await go(S3, hv, '.hrow'); await settle(S3, 6000);
    const c3 = await countsOf(S3);
    ok(c3.pat === first.n, 'direct load of a facet hash ends filtered (' + c3.pat + ' of ' + first.n + ')', { c3, first });
    cleanErrors(S3, 'real tags direct', []); await S3.ctx.close();
  }
  cleanErrors(S, 'real tags', []);
  await S.ctx.close();
}

async function partMobile(B, srv, T) {
  section('mobile: 390 px, dark, window.claude absent');
  const S = await openPage(B, srv, { init: TEST_EXT, w: 390, h: 844, scheme: 'dark', claude: 'absent' });
  await go(S, '#suche-lipid', '.hrow'); await S.page.waitForFunction(() => window.__xt && window.__xt.allLen >= 0, null, { timeout: 30000 }); await settle(S, 800);
  await noHScroll(S, 'search at 390 px');
  await S.page.locator('.f-toggle').click(); await settle(S, 300);
  ok(await S.page.evaluate(() => /XT mod 3/.test(document.querySelector('.facets').textContent)), 'extension facet reachable in the filter panel');
  await noHScroll(S, 'search with filters open at 390 px'); await shot(S, 'ext-suche-390-dark');
  await route(S, '#patent-' + T.op.pn, '[data-ext-panel="legal"] .lg-it:not([hidden])'); await settle(S, 800);
  await noHScroll(S, 'patent page with legal panel at 390 px');
  ok(await S.page.evaluate(() => { const e = document.querySelector('[data-ext-panel="legal"] .lg-it:not([hidden])'); const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; }), 'timeline entries stay inside the viewport');
  await shot(S, 'ext-patent-390-dark');
  await route(S, '#legal-' + T.op.pn, '.lg-page .lg-tl'); await settle(S, 800);
  await noHScroll(S, 'legal view at 390 px'); await shot(S, 'ext-legal-390-dark');
  await route(S, '#struktur--cSCHEMBL881351', '.k-cdlg-top .x-links'); await settle(S, 500);
  await noHScroll(S, 'compound dialog at 390 px'); await shot(S, 'ext-compound-390-dark');
  cleanErrors(S, 'mobile', []);
  await S.ctx.close();
}

async function partNullcaps(B, srv, T) {
  section('nullcaps: claude.use() resolves null');
  const S = await openPage(B, srv, { init: TEST_EXT, claude: 'null' });
  await go(S, '#patent-' + T.op.pn, '[data-ext-panel="legal"] .lg-it:not([hidden])'); await settle(S, 800);
  const d = await S.page.evaluate(async () => ({ use: await window.claude.use('db'), caps: LnpApp.caps, ai: !!LnpApp.ai(), claims: document.querySelectorAll('article.claim').length, ai_btn: document.querySelectorAll('.claim-meta .btn.quiet').length > 0, xt: document.querySelectorAll('.xt-claim').length }));
  ok(d.use === null && d.ai === false && d.claims > 0 && d.xt === d.claims, 'slots render with null capabilities', d);
  cleanErrors(S, 'nullcaps', []);
  await S.ctx.close();
}

/* ------------------------------------------------------------------------------------------ main */
(async () => {
  const t0 = Date.now();
  await unit();
  const pw = loadPlaywright();
  if (!pw) { ok(false, 'playwright is available'); process.exit(1); }
  let dist = arg('dist', null), scratch = arg('scratch', null), made = null;
  if (!dist) {
    scratch = scratch || fs.mkdtempSync(path.join(os.tmpdir(), 'lnp-hooks-'));
    dist = path.join(scratch, 'dist');
    console.log('\n.. building a scratch dist in ' + scratch + ' (--limit ' + LIMIT + ')');
    execFileSync('python3', ['-I', path.join(ROOT, 'pipeline/build_dist.py'), '--out', dist, '--build-dir', path.join(scratch, 'build'), '--budget-mb', '215', '--limit', LIMIT], { cwd: ROOT, stdio: 'ignore' });
    made = scratch;
  }
  const srv = await serve({ dist: path.resolve(dist), port: 0 });
  const B = await pw.chromium.launch();
  try {
    const T = await partExt(B, srv);
    if (T && T.op) {
      await partNone(B, srv, T);
      await partTags(B, srv);
      await partRealTags(B, srv);
      await partMobile(B, srv, T);
      await partNullcaps(B, srv, T);
    } else ok(false, 'remaining browser parts skipped: no target patent');
  } catch (e) { ok(false, 'browser run threw', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e)); }
  await B.close(); await srv.close();
  console.log('\n' + nOk + ' ok, ' + nFail + ' failed, ' + Math.round((Date.now() - t0) / 1000) + ' s' + (made ? '  (scratch dist kept in ' + made + ')' : ''));
  process.exit(nFail ? 1 : 0);
})();
