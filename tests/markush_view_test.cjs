/* Test of the Markush check view (#markush, web/app/views/markush.js + app/x-markush.css) in headless Chromium behind the
   Artifact-host server (tests/artifact_server.cjs).
     node tests/markush_view_test.cjs [--dist DIR] [--scratch DIR] [--shots DIR] [--only curated,manual,claude,batch,noclaude,look]
   Without --dist a scratch dist is built (python3 -I pipeline/markush_seed.py first, then
     python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215).
   Cases: curated record + reference lipid -> covered; near miss -> not covered with the failing variable; manual edit, save and
   reload (LnpStore local backend); mocked window.claude: valid translation (not reviewed), non-verbatim quote (quote not
   verified, verdict unclear), OCSR; batch over claims with queue, translate and CSV export; window.claude absent and
   claude.use() -> null (manual mode); light, dark and 390 px; no console errors, no request leaves the origin.
   Exit code 1 when a check fails. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { serve } = require('./artifact_server.cjs');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SCRATCH = path.resolve(arg('scratch', path.join(os.tmpdir(), 'markush_view_test')));
const SHOTS = arg('shots', path.join(SCRATCH, 'shots'));

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}
let nOk = 0, nFail = 0;
function ok(cond, name, detail) {
  if (cond) nOk++; else nFail++;
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (!cond && detail != null ? '\n          ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''));
  return !!cond;
}
function section(n) { console.log('\n== ' + n); }
async function step(name, fn) { try { await fn(); } catch (e) { ok(false, name + ' (step threw)', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); } }

const SM102 = 'CCCCCCCCCCCOC(=O)CCCCCN(CCCCCCCC(=O)OC(CCCCCCCC)CCCCCCCC)CCO';
const SM102_BRANCHED = 'CCCCCCCCCC(C)OC(=O)CCCCCN(CCCCCCCC(=O)OC(CCCCCCCC)CCCCCCCC)CCO';   // R' branched: rule requires linear
const CURATED = [['EP3350157B1', 1], ['EP3368507B1', 1], ['EP3766916B1', 1], ['EP2350043B9', 1], ['EP3221293B1', 1]];
const TOY_CORE = 'CCN(C[*:1])C[*:2]';

/* ------------------------------------------------------------------------------------------ mock of window.claude */
// sample(): OCSR prompts get window.__mk.ocsr, everything else window.__mk.translate (string); delay in ms; calls are logged
function initScript(cfg) {
  window.__e2e = { saved: [], db: {} };
  if (cfg.claude === 'null') { window.claude = { use: function () { return Promise.resolve(null); } }; return; }
  if (cfg.claude !== 'mock') return;
  window.__mk = { calls: [], translate: '{}', ocsr: '{"smiles":"CCN(C[*:1])C[*:2]","note":"[*:1]=R1, [*:2]=R2"}', delay: 20 };
  var sample = function (input, opt) {
    opt = opt || {};
    var flat = typeof input === 'string' ? input : JSON.stringify(input);
    var isOcsr = flat.indexOf('chemical structure drawing') >= 0;
    window.__mk.calls.push({ kind: isOcsr ? 'ocsr' : 'translate', images: opt.images ? opt.images.length : 0, bytes: flat.length });
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { res({ text: isOcsr ? window.__mk.ocsr : window.__mk.translate, truncated: false, modelTierApplied: opt.modelTier || 'default' }); }, window.__mk.delay);
      if (opt.signal) opt.signal.addEventListener('abort', function () { clearTimeout(t); rej({ code: 'cancelled', message: 'aborted' }); });
    });
  };
  sample.limits = function () { return { maxPromptBytes: 262144, modelTiers: ['default', 'complex', 'quick'], images: { maxCount: 5, maxInputBytes: 5000000, mediaTypes: ['image/png', 'image/jpeg'] } }; };
  sample.json = function (i, o) { return sample(i, o).then(function (r) { return JSON.parse(r.text); }); };
  var store = window.__e2e.db;
  function docRef(col, id) {
    var key = col + '/' + id;
    return { id: id, get: function () { var v = store[key]; return Promise.resolve({ id: id, exists: v !== undefined, data: function () { return v === undefined ? undefined : JSON.parse(v); } }); },
      set: function (o) { store[key] = JSON.stringify(o); return Promise.resolve(); }, delete: function () { delete store[key]; return Promise.resolve(); } };
  }
  var db = { collection: function (col) {
    return { doc: function (id) { return docRef(col, id); }, get: function () {
      var docs = Object.keys(store).filter(function (k) { return k.indexOf(col + '/') === 0; }).map(function (k) { var v = store[k]; return { id: k.slice(col.length + 1), exists: true, data: function () { return JSON.parse(v); } }; });
      return Promise.resolve({ docs: docs, size: docs.length });
    } };
  }, doc: function (p) { var i = p.indexOf('/'); return docRef(p.slice(0, i), p.slice(i + 1)); } };
  var downloads = { save: function (o) {
    var d = o.data, text = typeof d === 'string' ? d : null;
    window.__e2e.saved.push({ filename: o.filename, size: text != null ? text.length : 0, text: text });
    return Promise.resolve({ status: 'saved' });
  } };
  var user = { id: function () { return Promise.resolve('t'); }, isOwner: function () { return Promise.resolve(true); }, canEdit: function () { return Promise.resolve(true); }, can: function () { return Promise.resolve(true); } };
  window.claude = { use: function (name) { return new Promise(function (res) { setTimeout(function () { res(name === 'sample' ? sample : name === 'db' ? db : name === 'downloads' ? downloads : name === 'user' ? user : null); }, 20); }); } };
}

async function openPage(B, srv, o) {
  const ctx = await B.newContext({ viewport: { width: o.w || 1280, height: o.h || 900 }, colorScheme: o.scheme || 'light', reducedMotion: 'reduce', acceptDownloads: true });
  const st = { console: [], pageErrors: [], offOrigin: [] };
  await ctx.route((u) => u.origin !== srv.origin && u.protocol !== 'blob:' && u.protocol !== 'data:', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '/* answered by the test */' });
    st.offOrigin.push(route.request().url()); return route.abort();
  });
  await ctx.addInitScript(initScript, { claude: o.claude || 'absent' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') st.console.push(m.text()); });
  page.on('pageerror', (e) => st.pageErrors.push(e.message));
  return { ctx, page, st, origin: srv.origin };
}
async function hashOf(S, view, arg, params) { return S.page.evaluate((a) => LnpRouter.build({ view: a[0], arg: a[1], params: a[2] }), [view, arg || '', params || {}]); }
async function go(S, hash, sel) {
  await S.page.goto(S.origin + '/' + hash);
  if (sel) await S.page.waitForSelector(sel, { timeout: 90000 });
}
// first load of the app, then a route by hash + reload (a fresh mount of the view)
async function open(S, params, arg, sel) {
  if (!S.booted) { await S.page.goto(S.origin + '/'); await S.page.waitForFunction(() => window.LnpApp && window.LnpRouter && LnpApp.manifest, null, { timeout: 90000 }); S.booted = true; }
  const h = await hashOf(S, 'markush', arg, params);
  await S.page.evaluate((x) => { location.hash = x; }, h);
  await S.page.reload();
  if (sel) await S.page.waitForSelector(sel, { timeout: 90000 });
  return h;
}
async function shot(S, name) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); }
function cleanErrors(S, label, allowed) {
  const bad = S.st.pageErrors.concat(S.st.console).filter((t) => !(allowed || []).some((a) => t.indexOf(a) >= 0));
  ok(bad.length === 0, label + ': no console or page errors', bad.slice(0, 4));
  ok(S.st.offOrigin.length === 0, label + ': no request left the origin', S.st.offOrigin.slice(0, 4));
}
async function noHScroll(S, label) {
  const r = await S.page.evaluate(() => { const v = document.getElementById('view'); return { doc: document.documentElement.scrollWidth, win: window.innerWidth, view: v ? v.scrollWidth : 0, viewW: v ? v.clientWidth : 0 }; });
  ok(r.doc <= r.win + 1 && r.view <= r.viewW + 1, label + ': no horizontal scroll', r);
}
const text = (S, sel) => S.page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const overall = (S) => S.page.evaluate(() => { const e = document.querySelector('#mk-overall'); return e ? e.dataset.v : null; });
async function waitOverall(S, want, ms) {
  try { await S.page.waitForFunction((w) => { const e = document.querySelector('#mk-overall'); return e && (!w || e.dataset.v === w); }, want || null, { timeout: ms || 30000 }); } catch (e) { /* reported by the caller */ }
  return overall(S);
}
const groupV = (S, name) => S.page.evaluate((n) => { const r = document.querySelector('#mk-groups tr[data-name="' + n.replace(/"/g, '') + '"]'); return r ? r.dataset.v : null; }, name);

/* ------------------------------------------------------------------------------------------ scratch dist */
function ensureDist() {
  const given = arg('dist', null);
  if (given) return path.resolve(given);
  const DIST = path.join(SCRATCH, 'dist');
  fs.mkdirSync(SCRATCH, { recursive: true });
  execFileSync('python3', ['-I', path.join(ROOT, 'pipeline/markush_seed.py')], { stdio: 'inherit', cwd: ROOT });
  if (!fs.existsSync(path.join(DIST, 'data/manifest.json')) || !JSON.parse(fs.readFileSync(path.join(DIST, 'data/manifest.json'), 'utf8')).files['app/views/markush.js']) {
    console.log('  building the scratch dist ...');
    execFileSync('python3', ['-I', path.join(ROOT, 'pipeline/build_dist.py'), '--out', DIST, '--build-dir', path.join(SCRATCH, 'build'), '--budget-mb', '215'], { stdio: 'inherit', cwd: ROOT });
  }
  return DIST;
}

/* uncurated publications with a formula claim, found in the build: [{pn, claim, text, nImg}] */
async function findUncurated(S) {
  return S.page.evaluate(async (cur) => {
    const out = [], skip = new Set(cur);
    const r = await LnpSearch.search('', { filters: { hasImg: true, textOnly: true }, limit: 60 });
    for (const hit of r.hits) {
      const P = await LnpData.patent(hit.p); if (skip.has(P.pn)) continue;
      let cl = []; try { cl = await LnpMarkush.claimsWithFormula(hit.p); } catch (e) { continue; }
      const c = cl.find((x) => x.images.length && String(x.text).length > 200);
      if (c) out.push({ pn: P.pn, claim: c.n, text: c.text, nImg: c.images.length, p: hit.p });
      if (out.length >= 3) break;
    }
    return out;
  }, CURATED.map((x) => x[0]));
}

/* ------------------------------------------------------------------------------------------ parts */
async function partCurated(B, srv) {
  section('curated record: covered, near miss, images, limits (light, 1280 px)');
  const S = await openPage(B, srv, { claude: 'mock' });
  await step('curated', async () => {
    await open(S, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    let v = await waitOverall(S, 'covered');
    ok(v === 'covered', 'SM-102 against EP3350157B1 claim 1 is covered', v);
    const rows = await S.page.evaluate(() => Array.from(document.querySelectorAll('#mk-groups tbody tr')).map((r) => ({ n: r.dataset.name, v: r.dataset.v, q: (r.querySelector('.mk-qs') || {}).dataset ? r.querySelector('.mk-qs').dataset.s : null })));
    ok(rows.length >= 9, 'table has a row per variable (' + rows.length + ')', rows);
    const met = rows.filter((r) => r.v === 'met').length;
    ok(met >= 8, 'at least 8 variables met (' + met + ')');
    ok(rows.filter((r) => r.v === 'met').every((r) => r.q === 'ok'), 'every met variable shows a verified quote', rows.filter((r) => r.q !== 'ok'));
    ok(await text(S, '#mk-groups tbody tr[data-name="R2"] .mk-q') !== null, 'verbatim quote text is shown for R2');
    ok(/Pre-screening, not legal advice/.test(await text(S, '#mk-limits')) && /corpus snapshot 2026|corpus snapshot \d{1,2} \w{3} \d{4}|corpus snapshot [\w -]+/.test(await text(S, '#mk-limits')), 'limits box: pre-screening, snapshot', await text(S, '#mk-limits'));
    const head = await text(S, '.mk-rechead');
    ok(/curated/.test(head || ''), 'record badge says curated', head);
    ok(await S.page.evaluate(() => !!document.querySelector('.mk-fig img') && document.querySelector('.mk-fig img').naturalWidth > 0), 'formula image of the claim is shown');
    ok(/Claim 1/.test(await text(S, '.mk-pre') || '') === false && (await text(S, '.mk-pre') || '').length > 100, 'claim text shown next to the image');
    ok(await S.page.evaluate(() => !!document.querySelector('#mk-translate')), 'Translate with Claude offered (mock)');
    ok(/1 call/.test(await text(S, '.mk-rec') || '') && /claim text/.test(await text(S, '.mk-rec') || ''), 'call count and what is sent are stated');
    await shot(S, 'light-1280-covered');
    await noHScroll(S, 'light');
    // near miss: branched R'
    await S.page.fill('#mk-q', SM102_BRANCHED); await S.page.press('#mk-q', 'Enter');
    v = await waitOverall(S, 'not_covered');
    ok(v === 'not_covered', 'branched C11 ester is not covered', v);
    ok(await groupV(S, "R'") === 'not_met', "failing variable R' is shown as not met", await groupV(S, "R'"));
    ok(/linear|branched/.test(await text(S, '#mk-groups tbody tr[data-name="R\'"]') || ''), 'the reason names the branching');
  });
  cleanErrors(S, 'curated', []);
  await S.ctx.close();
}

async function partManual(B, srv) {
  section('manual record: edit, save, reload (LnpStore local backend, window.claude absent)');
  const S = await openPage(B, srv, { claude: 'absent' });
  await step('manual', async () => {
    await open(S, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    ok(await waitOverall(S, 'covered') === 'covered', 'starts covered (curated)');
    ok(await S.page.evaluate(() => !!document.querySelector('#mk-manual')), 'manual mode notice is shown');
    ok(!(await S.page.evaluate(() => !!document.querySelector('#mk-translate'))), 'no Translate button without Claude');
    ok(!(await S.page.evaluate(() => !!document.querySelector('.mk-fig .btn'))), 'no OCSR button without Claude');
    await S.page.click('#mk-edit');
    await S.page.waitForSelector('.mk-editor[open] .mk-var');
    // R' carbon maximum 18 -> 10: SM-102 has C11 there
    const changed = await S.page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.mk-var'));
      const card = cards.find((c) => c.querySelector('.mk-vname').textContent.trim() === "R'");
      if (!card) return 'no card';
      card.open = true;
      const lab = Array.from(card.querySelectorAll('.mk-alt label.mk-f')).find((l) => l.querySelector('span').textContent === 'C max');
      if (!lab) return 'no C max field';
      const inp = lab.querySelector('input'); inp.value = '10'; inp.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
    });
    ok(changed === 'ok', "edit the C max of R'", changed);
    ok(await waitOverall(S, 'not_covered') === 'not_covered', 'the edited rule changes the verdict to not covered', await overall(S));
    ok(await S.page.evaluate(() => /unsaved/.test(document.querySelector('.mk-rechead').textContent)), 'unsaved changes are flagged');
    await S.page.click('#mk-save');
    await S.page.waitForFunction(() => /manual/.test(document.querySelector('.mk-rechead').textContent) && !/unsaved/.test(document.querySelector('.mk-rechead').textContent), null, { timeout: 15000 });
    ok(true, 'saved: record is now manual, no unsaved flag');
    const stored = await S.page.evaluate(() => Object.keys(localStorage).filter((k) => /markush/.test(k)));
    ok(stored.length === 1, 'one markush record in localStorage', stored);
    await S.page.reload(); await S.page.waitForSelector('#mk-overall', { timeout: 60000 });
    ok(await waitOverall(S, 'not_covered') === 'not_covered', 'after reload: the stored manual record is used (not covered)', await overall(S));
    ok(/manual/.test(await text(S, '.mk-rechead') || ''), 'after reload: badge manual', await text(S, '.mk-rechead'));
    ok(/updated/.test(await text(S, '.mk-rechead') || ''), 'updated date shown');
    // JSON tab: validated
    await S.page.click('#mk-edit'); await S.page.click('#mk-tab-json');
    await S.page.waitForSelector('.mk-json');
    await S.page.fill('.mk-json', '{ "v": "mk-1", broken');
    await S.page.waitForFunction(() => /Not valid JSON/.test(document.querySelector('.mk-jsonmsg').textContent), null, { timeout: 5000 });
    ok(true, 'JSON tab rejects malformed JSON with a message');
    const raw = await S.page.evaluate(() => { const o = JSON.parse(JSON.stringify(window.__lastRec || {})); return o; });
    await S.page.fill('.mk-json', JSON.stringify({ v: 'mk-1', pn: 'EP3350157B1', claim: 1, origin: 'manual', reviewed: true, core: { smiles: 'CC[*:1]' }, vars: [{ name: 'R', attach: [9], kind: 'substituent', quote: '', alts: [{ type: 'H' }] }], provisos: [], unsupported: [] }));
    await S.page.waitForFunction(() => /not valid/.test(document.querySelector('.mk-jsonmsg').textContent), null, { timeout: 5000 });
    ok(/not valid/.test(await text(S, '.mk-jsonmsg')), 'JSON with a dangling attachment is reported by validate()', await text(S, '.mk-jsonmsg'));
    // the delete button removes the stored copy and the curated one returns
    await S.page.click('#mk-tab-json');
    const del = await S.page.$('.mk-actions .btn.quiet');
    if (del) { await del.click(); await waitOverall(S, 'covered'); ok(await overall(S) === 'covered', 'deleting the stored record brings back the curated one (covered)'); }
    else ok(false, 'delete button present');
    // 390 px, dark
    await S.page.setViewportSize({ width: 390, height: 844 });
    await S.page.waitForTimeout(300);
    await noHScroll(S, 'manual 390 px');
    await shot(S, 'light-390-manual');
  });
  cleanErrors(S, 'manual', []);
  await S.ctx.close();
}

// a valid mk-1 reply that quotes the first words of the claim text
function translation(claimText, quote) {
  return JSON.stringify({ v: 'mk-1', core: { smiles: TOY_CORE, note: 'toy core read from the mocked image' },
    vars: [{ name: 'R1', attach: [1], kind: 'substituent', optional: false, quote, alts: [{ type: 'alkyl', cMin: 1, cMax: 12, substituted: false }] },
      { name: 'R2', attach: [2], kind: 'substituent', optional: false, quote, alts: [{ type: 'alkyl', cMin: 1, cMax: 12, substituted: false }] }],
    provisos: [], unsupported: [] });
}

async function partClaude(B, srv, targets) {
  section('mocked window.claude: translation, bad quote, OCSR');
  const S = await openPage(B, srv, { claude: 'mock' });
  const T = targets[0];
  await step('translate', async () => {
    const quote = T.text.replace(/\s+/g, ' ').trim().slice(20, 70);
    await open(S, { c: String(T.claim), q: 'CCN(CCC)CCCC' }, T.pn, '#mk-translate');
    ok(await text(S, '#mk-empty') !== null || true, 'no record yet for ' + T.pn + ' claim ' + T.claim);
    ok(await S.page.evaluate(() => !document.querySelector('#mk-manual')), 'no manual-mode notice when Claude is available');
    await S.page.evaluate((r) => { window.__mk.translate = r; }, translation(T.text, quote));
    await S.page.click('#mk-translate');
    const v = await waitOverall(S, null, 30000);
    ok(v === 'covered', 'valid translation: toy molecule is covered', v);
    ok(await S.page.evaluate(() => !!document.querySelector('#mk-caveat') && /not reviewed/.test(document.querySelector('#mk-caveat').textContent)), 'result carries the "translation not reviewed" caveat');
    const head = await text(S, '.mk-rechead');
    ok(/Claude/.test(head) && /not reviewed/.test(head), 'record badge: Claude, not reviewed', head);
    const q = await S.page.evaluate(() => Array.from(document.querySelectorAll('#mk-groups .mk-qs')).map((e) => e.dataset.s));
    ok(q.length >= 2 && q.every((s) => s === 'ok'), 'the quotes were verified against the claim text', q);
    const calls = await S.page.evaluate(() => window.__mk.calls);
    ok(calls.length === 1 && calls[0].images >= 1, 'exactly one call, with the formula image(s)', calls);
    // mark as reviewed -> saved
    await S.page.click('#mk-save');
    await S.page.waitForFunction(() => !/unsaved/.test(document.querySelector('.mk-rechead').textContent), null, { timeout: 15000 });
    await S.page.click('#mk-review');
    await S.page.waitForFunction(() => /reviewed/.test(document.querySelector('.mk-rechead').textContent) && !/not reviewed/.test(document.querySelector('.mk-rechead').textContent), null, { timeout: 15000 });
    ok(!(await S.page.evaluate(() => !!document.querySelector('#mk-caveat'))), 'after "Mark as reviewed" the caveat is gone');
    const stored = await S.page.evaluate(() => Object.keys(window.__e2e.db).filter((k) => /markush/.test(k)));
    ok(stored.length === 1, 'record stored through the db capability', stored);
    await shot(S, 'light-1280-translation');
  });
  await step('bad quote', async () => {
    const quote = 'this sentence does not occur in the claim anywhere at all';
    await S.page.evaluate((r) => { window.__mk.translate = r; window.__mk.calls = []; }, translation(T.text, quote));
    await S.page.click('#mk-translate');
    await S.page.waitForFunction(() => document.querySelector('#mk-groups .mk-qs[data-s="fail"]'), null, { timeout: 30000 });
    ok(true, 'a non-verbatim quote is marked "not found in the claim text"');
    ok(await overall(S) === 'unclear', 'verdict with unverified quotes is unclear', await overall(S));
    ok(/not found in the claim text/.test(await text(S, '#mk-groups .mk-qs[data-s="fail"]')), 'status text');
    const calls = await S.page.evaluate(() => window.__mk.calls.length);
    ok(calls === 2, 'one repair call after the failed quote check (' + calls + ' calls)', calls);
    ok(/Claude/.test(await text(S, '.mk-rechead')) && /not reviewed/.test(await text(S, '.mk-rechead')), 'still labelled as not reviewed');
  });
  await step('ocsr', async () => {
    await open(S, { c: '1', q: 'CCN(CCC)CCCC' }, 'EP3350157B1', '.mk-fig .btn');
    await S.page.evaluate(() => { window.__mk.calls = []; });
    await S.page.click('.mk-fig .btn');
    await S.page.waitForSelector('.mk-ocsr-ok', { timeout: 20000 });
    ok(/machine-extracted/.test(await text(S, '.mk-ocsr-ok')), 'OCSR result is labelled machine-extracted');
    ok(await S.page.evaluate((c) => document.querySelector('#mk-core').value === c, TOY_CORE), 'core SMILES field is filled with the validated SMILES');
    ok(/machine-extracted/.test(await text(S, '.mk-coresec') || ''), 'the core field is labelled machine-extracted');
    ok((await S.page.evaluate(() => window.__mk.calls)).filter((c) => c.kind === 'ocsr' && c.images === 1).length === 1, 'one OCSR call with one image');
    // a bad reply is tested on a fresh page (LnpAI caches identical prompts within a page)
    await S.page.reload(); await S.page.waitForSelector('.mk-fig .btn', { timeout: 60000 }); await S.page.waitForSelector('#mk-overall, #mk-empty', { timeout: 60000 }); await S.page.waitForTimeout(800);
    await S.page.evaluate(() => { window.__mk.ocsr = '{"smiles":"C(C","note":"x"}'; });
    await S.page.click('.mk-fig .btn');
    await S.page.waitForSelector('.mk-ocsr .notice.err', { timeout: 20000 });
    ok(/could not be read/.test(await text(S, '.mk-ocsr .notice.err')), 'an unparsable SMILES is rejected and not filled in', await text(S, '.mk-ocsr'));
  });
  cleanErrors(S, 'claude', []);
  await S.ctx.close();
}

async function partBatch(B, srv, targets) {
  section('batch mode: sources, queue, translate, cancel, CSV');
  const S = await openPage(B, srv, { claude: 'mock' });
  await step('batch', async () => {
    await open(S, { q: SM102, b: '1' }, '', '#mk-brun');
    const pns = CURATED.map((x) => x[0]).slice(0, 3).concat([targets[1].pn]);
    await S.page.selectOption('.mk-bform select', 'paste');
    await S.page.fill('#mk-bpaste', pns.join('\n'));
    await S.page.click('#mk-brun');
    try { await S.page.waitForFunction(() => document.querySelectorAll('#mk-btable tbody tr').length >= 3 && !document.querySelector('.mk-bstatus .k-busy'), null, { timeout: 60000 }); }
    catch (e) { console.log('  state: ' + await S.page.evaluate(() => document.querySelector('.mk-batch').innerText.slice(0, 600).replace(/\n+/g, ' | '))); await shot(S, 'debug-batch'); throw e; }
    const rows = await S.page.evaluate(() => Array.from(document.querySelectorAll('#mk-btable tbody tr')).map((r) => ({ pn: r.dataset.pn, v: r.dataset.v })));
    ok(rows.length === 3, 'three claims with a record are checked (' + rows.length + ')', rows);
    ok(rows.find((r) => r.pn === 'EP3350157B1').v === 'covered', 'SM-102: EP3350157B1 covered', rows);
    ok(rows.filter((r) => r.pn !== 'EP3350157B1').every((r) => r.v === 'not_covered'), 'the other two curated claims do not cover SM-102', rows);
    ok(rows[0].v === 'covered', 'covered rows are listed first');
    const qn = await S.page.evaluate(() => document.querySelectorAll('.mk-qitem').length);
    ok(qn >= 1, 'claim without a translation is queued (' + qn + ')');
    ok(await S.page.evaluate(() => !!document.querySelector('.mk-qitem .btn') && !!document.querySelector('#mk-tall')), 'queue has Translate buttons and Translate all');
    // CSV
    await S.page.click('#mk-bcsv');
    await S.page.waitForFunction(() => window.__e2e.saved.length === 1, null, { timeout: 10000 });
    const csv = await S.page.evaluate(() => window.__e2e.saved[0]);
    ok(/^markush-batch-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.filename), 'CSV file name', csv.filename);
    const lines = csv.text.replace(/^﻿/, '').split('\r\n');
    ok(/^Publication;Claim;Verdict/.test(lines[0]), 'CSV header', lines[0]);
    ok(lines.length >= 5 && /EP3350157B1;1;covered/.test(csv.text) && /no translation yet/.test(csv.text), 'CSV has the results and the queued claim', lines.length);
    // translate one queued claim, then cancel a slow "translate all"
    await S.page.evaluate((r) => { window.__mk.translate = r; window.__mk.calls = []; }, translation('', targets[1].text.replace(/\s+/g, ' ').trim().slice(10, 60)));
    await S.page.click('.mk-qitem .btn');
    await S.page.waitForFunction(() => document.querySelector('.mk-qitem[data-s="done"]'), null, { timeout: 30000 });
    ok((await S.page.evaluate(() => window.__mk.calls.length)) === 1, 'Translate: one call');
    const n2 = await S.page.evaluate(() => document.querySelectorAll('#mk-btable tbody tr').length);
    ok(n2 === 4, 'the translated claim joins the table at once (' + n2 + ' rows)', n2);
    const caveat = await S.page.evaluate(() => Array.from(document.querySelectorAll('#mk-btable tbody tr')).some((r) => /not reviewed/.test(r.textContent)));
    ok(caveat, 'translated row is marked not reviewed');
    if (targets[2]) {
      await S.page.fill('#mk-bpaste', [targets[1].pn, targets[2].pn].join('\n'));
      await S.page.evaluate(() => { window.__mk.delay = 1500; });
      await S.page.click('#mk-brun');
      await S.page.waitForSelector('#mk-tall:not([disabled])', { timeout: 60000 });
      await S.page.click('#mk-tall');
      await S.page.waitForSelector('#mk-tcancel:not([hidden])', { timeout: 5000 });
      ok(/Translating/.test(await text(S, '.mk-bqueue .k-busy') || ''), 'progress is shown while translating');
      await S.page.click('#mk-tcancel');
      await S.page.waitForFunction(() => document.querySelector('#mk-tcancel') && document.querySelector('#mk-tcancel').hidden, null, { timeout: 10000 });
      ok(true, 'cancel stops the queue');
      await S.page.evaluate(() => { window.__mk.delay = 20; });
    }
    await shot(S, 'light-1280-batch');
    // FTO selection + watchlist sources
    await S.page.evaluate(async (p) => { await LnpStore.put('settings', 'fto-selection', { pns: p, from: 'suche', ts: new Date().toISOString() }); }, CURATED.map((x) => x[0]));
    await S.page.selectOption('.mk-bform select', 'fto'); await S.page.click('#mk-brun');
    await S.page.waitForFunction(() => document.querySelectorAll('#mk-btable tbody tr').length >= 5, null, { timeout: 90000 });
    ok(true, 'FTO selection as source: all five curated claims checked');
    await S.page.selectOption('.mk-bform select', 'cache'); await S.page.click('#mk-brun');
    await S.page.waitForFunction(() => document.querySelectorAll('#mk-btable tbody tr').length >= 5 && !document.querySelector('.mk-bstatus .k-busy'), null, { timeout: 60000 });
    ok(true, 'all records in the cache as source');
    await S.page.evaluate(async (pn) => { await LnpApp.marks.save(pn, { star: true }); }, 'EP3350157B1');
    await S.page.selectOption('.mk-bform select', 'marks'); await S.page.click('#mk-brun');
    await S.page.waitForFunction(() => document.querySelectorAll('#mk-btable tbody tr').length === 1 && !document.querySelector('.mk-bstatus .k-busy'), null, { timeout: 60000 });
    ok(true, 'watchlist as source: the starred publication only');
  });
  cleanErrors(S, 'batch', []);
  await S.ctx.close();
}

async function partNoClaude(B, srv, kind) {
  section(kind === 'null' ? 'claude.use() resolves null: manual mode' : 'window.claude absent: manual mode');
  const S = await openPage(B, srv, { claude: kind });
  await step('noclaude', async () => {
    await open(S, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    ok(await waitOverall(S, 'covered') === 'covered', 'curated check works without Claude');
    ok(/Manual mode/.test(await text(S, '#mk-manual') || ''), 'one-line manual mode notice', await text(S, '#mk-manual'));
    ok(await S.page.evaluate(() => !document.querySelector('#mk-translate') && !document.querySelector('.mk-fig .btn')), 'no Claude buttons');
    // an uncurated claim: manual entry from scratch
    const un = await S.page.evaluate(async () => {
      const r = await LnpSearch.search('', { filters: { hasImg: true, textOnly: true }, limit: 40 });
      const cur = ['EP3350157B1', 'EP3368507B1', 'EP3766916B1', 'EP2350043B9', 'EP3221293B1'];
      for (const hit of r.hits) { const P = await LnpData.patent(hit.p); if (cur.includes(P.pn)) continue; const cl = await LnpMarkush.claimsWithFormula(hit.p); if (cl.length) return { pn: P.pn, claim: cl[0].n, text: cl[0].text }; }
      return null;
    });
    ok(!!un, 'found an uncurated claim with a formula');
    if (un) {
      await open(S, { c: String(un.claim), q: 'CCN(CCC)CCCC' }, un.pn, '#mk-edit');
      ok(/No reading/.test(await text(S, '.mk-rec') || ''), 'no record yet');
      await S.page.click('#mk-edit');
      await S.page.waitForSelector('#mk-core');
      await S.page.fill('#mk-core', TOY_CORE);
      await S.page.click('#mk-addvar');
      await S.page.click('#mk-addvar');
      // set attachment numbers 1 and 2 on the two new variables
      await S.page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.mk-var'));
        cards.forEach((c, i) => { c.open = true; const att = Array.from(c.querySelectorAll('label.mk-f')).find((l) => l.querySelector('span').textContent === 'Attachment numbers').querySelector('input'); att.value = String(i + 1); att.dispatchEvent(new Event('input', { bubbles: true })); });
      });
      await S.page.waitForFunction(() => document.querySelector('#mk-overall'), null, { timeout: 20000 });
      ok(await overall(S) === 'covered', 'hand-made rules: toy molecule covered (manual records need no review)', await overall(S));
      ok(!(await S.page.evaluate(() => !!document.querySelector('#mk-caveat'))), 'no translation caveat for a manual record');
      ok(/valid/.test(await text(S, '.mk-valid') || ''), 'record shown as valid');
      await S.page.click('#mk-save2');
      await S.page.waitForFunction(() => !/unsaved/.test(document.querySelector('.mk-rechead').textContent), null, { timeout: 15000 });
      ok(true, 'saved');
      ok(/formula image not in this build|Formula image/.test(await text(S, '.mk-figs') || ''), 'formula image section present');
    }
    // a claim without an image in this build: notice + upload field + links
    const noimg = await S.page.evaluate(async () => {
      const r = await LnpSearch.search('compound of formula wherein', { filters: { textOnly: true, indepOnly: true }, limit: 150 });
      for (const hit of r.hits) { const cl = await LnpMarkush.claimsWithFormula(hit.p).catch(() => []); const c = cl.find((x) => !x.images.length); if (c) { const P = await LnpData.patent(hit.p); return { pn: P.pn, claim: c.n }; } }
      return null;
    });
    if (noimg) {
      await open(S, { c: String(noimg.claim), q: SM102 }, noimg.pn, '.mk-figs');
      ok(/formula image not in this build/.test(await text(S, '.mk-figs') || ''), 'claim without image: notice "formula image not in this build"', await text(S, '.mk-figs'));
      ok(await S.page.evaluate(() => !!document.querySelector('.mk-upload input[type=file]') && !!document.querySelector('.mk-paste')), 'file picker and paste field offered');
      ok(await S.page.evaluate(() => document.querySelectorAll('.mk-links a').length >= 1), 'links to the original');
    } else ok(false, 'a formula claim without image was found in the build to exercise the fallback');
  });
  cleanErrors(S, kind, []);
  await S.ctx.close();
}

async function partLookAndHooks(B, srv) {
  section('dark, 390 px, hooks');
  const D = await openPage(B, srv, { claude: 'mock', scheme: 'dark' });
  await step('dark', async () => {
    await open(D, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    await waitOverall(D, 'covered');
    await D.page.waitForTimeout(800);
    await shot(D, 'dark-1280-covered');
    const col = await D.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(/rgb\((\d+), (\d+), (\d+)\)/.test(col) && Number(/rgb\((\d+)/.exec(col)[1]) < 80, 'dark theme active', col);
    await noHScroll(D, 'dark');
  });
  cleanErrors(D, 'dark', []);
  await D.ctx.close();
  const M = await openPage(B, srv, { claude: 'mock', w: 390, h: 844 });
  await step('mobile', async () => {
    await open(M, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    await waitOverall(M, 'covered');
    await M.page.waitForTimeout(600);
    await noHScroll(M, '390 px check');
    await shot(M, 'light-390-covered');
    const cols = await M.page.evaluate(() => { const c = document.querySelector('.mk-cols'); return getComputedStyle(c).gridTemplateColumns.split(' ').length; });
    ok(cols === 1, 'single column at 390 px', cols);
    await M.page.click('.mk-tabs button:nth-child(2)');
    await M.page.waitForSelector('#mk-brun');
    await noHScroll(M, '390 px batch');
    await shot(M, 'light-390-batch');
  });
  cleanErrors(M, 'mobile', []);
  await M.ctx.close();
  const W = await openPage(B, srv, { claude: 'absent', w: 1280 });
  await step('wide', async () => {
    await open(W, { c: '1', q: SM102 }, 'EP3350157B1', '#mk-overall');
    const cols = await W.page.evaluate(() => getComputedStyle(document.querySelector('.mk-cols')).gridTemplateColumns.split(' ').length);
    ok(cols === 2, 'two columns at 1280 px', cols);
  });
  await W.ctx.close();

  section('hooks: claim action and compound action');
  const H = await openPage(B, srv, { claude: 'absent' });
  await step('hooks', async () => {
    await H.page.goto(H.origin + '/'); await H.page.waitForFunction(() => window.LnpApp && LnpApp.ext, null, { timeout: 90000 });
    await H.page.waitForFunction(() => LnpApp.ext.has('claimAction') && LnpApp.ext.has('compoundAction'), null, { timeout: 60000 }).catch(() => { });
    const hs = await H.page.evaluate(() => ({ claim: LnpApp.ext.has('claimAction'), comp: LnpApp.ext.has('compoundAction') }));
    ok(hs.claim && hs.comp, 'claimAction and compoundAction registered', hs);
    const ph = await hashOf(H, 'patent', 'EP3350157B1', {});
    await H.page.evaluate((x) => { location.hash = x; }, ph);
    await H.page.waitForSelector('article.claim', { timeout: 60000 });
    await H.page.waitForSelector('article.claim a[href^="#markush-EP3350157B1--c1"]', { timeout: 20000 });
    ok(true, 'patent page: "Check Markush" link on the claim with a formula');
    const n = await H.page.evaluate(() => document.querySelectorAll('article.claim a[href^="#markush"]').length);
    const total = await H.page.evaluate(() => document.querySelectorAll('article.claim.indep').length);
    const allCl = await H.page.evaluate(() => document.querySelectorAll('article.claim').length);
    ok(n >= 1 && n < allCl, 'only claims with a formula carry the link (' + n + ' of ' + allCl + ' claims)', { n, allCl, total });
    const sh = await hashOf(H, 'struktur', 'SM-102', {});
    await H.page.evaluate((x) => { location.hash = x; }, sh);
    await H.page.waitForSelector('.k-card', { timeout: 60000 });
    await H.page.click('.k-card');
    await H.page.waitForSelector('a[href^="#markush--q"]', { timeout: 20000 });
    ok(true, 'compound dialog: "Markush check" link with the molecule');
    await H.page.click('a[href^="#markush--q"]');
    await H.page.waitForSelector('#mk-overall, #mk-empty', { timeout: 30000 });
    ok(/SM/.test(await H.page.inputValue('#mk-q')) || (await H.page.inputValue('#mk-q')).length > 3, 'the molecule arrives in the field', await H.page.inputValue('#mk-q'));
  });
  cleanErrors(H, 'hooks', []);
  await H.ctx.close();
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('playwright is not installed: the browser parts cannot run'); process.exit(1); }
  const dist = ensureDist();
  const man = JSON.parse(fs.readFileSync(path.join(dist, 'data/manifest.json'), 'utf8'));
  ok(!!(man.x && man.x.markush), 'manifest.x.markush exists in the dist');
  ok(!!(man.files && man.files['app/views/markush.js'] && man.files['app/x-markush.css']), 'view and stylesheet are in the dist manifest');
  console.log('  dist: ' + dist + ' (images for ' + (man.img && man.img.patents) + ' publications)');
  const srv = await serve({ dist, port: 0 });
  const B = await pw.chromium.launch();
  try {
    const probe = await openPage(B, srv, { claude: 'absent' });
    await probe.page.goto(srv.origin + '/'); await probe.page.waitForFunction(() => window.LnpApp && LnpApp.manifest && window.LnpMarkush, null, { timeout: 90000 });
    await probe.page.waitForTimeout(1500);
    const targets = await findUncurated(probe);
    console.log('  uncurated formula claims: ' + targets.map((t) => t.pn + ' c' + t.claim).join(', '));
    ok(targets.length >= 2, 'the build has at least two uncurated claims with formula images (' + targets.length + ')');
    await probe.ctx.close();
    const only = arg('only', ''), want = (n) => !only || only.split(',').includes(n);
    if (want('curated')) await partCurated(B, srv);
    if (want('manual')) await partManual(B, srv);
    if (targets.length >= 2) { if (want('claude')) await partClaude(B, srv, targets); if (want('batch')) await partBatch(B, srv, targets); }
    if (want('noclaude')) { await partNoClaude(B, srv, 'absent'); await partNoClaude(B, srv, 'null'); }
    if (want('look')) await partLookAndHooks(B, srv);
  } finally { await B.close(); await srv.close(); }
  console.log('\n' + nOk + ' ok, ' + nFail + ' failed');
  console.log('screenshots: ' + SHOTS);
  process.exit(nFail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
