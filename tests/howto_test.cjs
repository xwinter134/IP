/* Checks of the "How to" tutorials.
     node tests/howto_test.cjs                       static checks (no browser, no build needed)
     node tests/howto_test.cjs --base URL            plus a browser run against a served website build that contains the view
                                                     (every tutorial opens, pictures load, no horizontal scroll at 390 px, deep link, enlarge)
   Static checks: every picture named in the data and in docs/TUTORIALS.md exists as a JPEG, is made by tests/howto_shots.cjs and the
   total stays within the budget; every route of a tutorial is a registered view; ids, alt text and limits are present;
   docs/TUTORIALS.md is in step with the data; README links the document; the view file only uses textContent. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const BASE = argv.indexOf('--base') >= 0 ? argv[argv.indexOf('--base') + 1].replace(/\/?$/, '/') : null;
const D = require(path.join(ROOT, 'web/app/views/lib/howto-data.js'));
const IMG = path.join(ROOT, 'web/app/howto');
const BUDGET = 4 * 1024 * 1024;
let fails = 0, checks = 0;
function ok(c, msg) { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// registered view ids: web/app/views/*.js (registerView({ id: '...' })) and the router's own alphabet
const views = new Set();
fs.readdirSync(path.join(ROOT, 'web/app/views')).filter((f) => /\.js$/.test(f)).forEach((f) => {
  const m = /registerView\(\{\s*id:\s*'([a-z]+)'/.exec(read('web/app/views/' + f)); if (m) views.add(m[1]);
});
ok(views.has('howto'), 'the view howto registers itself');
const viewSrc = read('web/app/views/howto.js');
ok(/id:\s*'howto'[^}]*rail:\s*true/.test(viewSrc), 'howto registers with rail: true');
ok(/icon:\s*'help'/.test(viewSrc) && /help:\s*'/.test(read('web/app/ui.js')), 'icon help exists in ui.js');
ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(viewSrc + read('web/app/views/lib/howto-data.js')), 'no HTML insertion in the view or the data');

const shotsSrc = read('tests/howto_shots.cjs');
const shotNames = new Set(); shotsSrc.replace(/shot\('([a-z0-9-]+)'/g, (a, n) => { shotNames.add(n); return a; });

const ids = new Set(), used = new Set();
D.tutorials.forEach((t) => {
  ok(/^[a-z0-9]+$/.test(t.id) && !ids.has(t.id), 'tutorial id is unique and fits the router: ' + t.id);
  ids.add(t.id);
  ok(t.title && t.summary && t.steps.length >= 1, t.id + ': title, summary and steps');
  ok(t.limits && t.limits.length >= 1, t.id + ': has its own limits note');
  const routes = [t.route].concat(t.steps.map((s) => s.route)).filter(Boolean);
  routes.forEach((r) => { const v = /^#([a-z]+)/.exec(r); ok(v && views.has(v[1]), t.id + ': route ' + r + ' is a registered view'); });
  t.steps.forEach((s, i) => {
    ok(s.text && s.text.length > 20, t.id + ' step ' + (i + 1) + ': text');
    if (!s.img) return;
    ok(new RegExp('^' + t.id + '-\\d+$').test(s.img), 'image name follows <tutorial>-<n>: ' + s.img);
    ok(s.alt && s.alt.length > 15, s.img + ': alt text');
    ok(!used.has(s.img), s.img + ': used once'); used.add(s.img);
    ok(shotNames.has(s.img), s.img + ': made by tests/howto_shots.cjs');
  });
});
ok(D.tutorials.length >= 14, 'at least 14 tutorials');
['start', 'search', 'patent', 'structure', 'fto', 'markush', 'screen', 'ranges', 'designs', 'disclosure', 'expiry', 'similar', 'watchlist', 'ownai'].forEach((id) => ok(ids.has(id), 'tutorial present: ' + id));
ok(/not legal advice/i.test(D.common.join(' ')) && /Artifact/.test(D.common.join(' ')) && /snapshot/i.test(D.common.join(' ')), 'common limits name the snapshot, legal advice and the Artifact-only Claude features');
ok(/pre-screening/i.test(D.tutorials.find((t) => t.id === 'fto').limits.join(' ')), 'FTO limits say pre-screening');
shotNames.forEach((n) => ok(used.has(n), 'shot ' + n + ' is used by a tutorial'));
// "About the data" is the last entry, text only, and links docs/DATA.md (which must exist)
const dataT = D.tutorials[D.tutorials.length - 1];
ok(dataT.id === 'data', 'the last tutorial is "About the data"');
ok(dataT.steps.every((s) => !s.img), 'About the data has no screenshots');
ok(dataT.steps.some((s) => s.link && s.link.href === 'https://github.com/xwinter134/IP/blob/lnp-tools/docs/DATA.md'), 'About the data links docs/DATA.md on GitHub');
ok(fs.existsSync(path.join(ROOT, 'docs/DATA.md')), 'docs/DATA.md exists');
D.tutorials.forEach((t) => t.steps.forEach((s) => {
  if (s.table) ok(Array.isArray(s.table.cols) && s.table.rows.every((r) => r.length === s.table.cols.length && r.every((c) => typeof c === 'string')), t.id + ': table rows match the columns and hold plain strings');
  if (s.list) ok(s.list.every((x) => typeof x === 'string' && x.length > 5), t.id + ': list items are plain strings');
  if (s.link) ok(/^https:\/\//.test(s.link.href) && s.link.label, t.id + ': link is https with a label');
}));

// files
const files = fs.existsSync(IMG) ? fs.readdirSync(IMG).filter((f) => /\.jpg$/.test(f)) : [];
let total = 0;
used.forEach((n) => {
  const p = path.join(IMG, n + '.jpg');
  if (!fs.existsSync(p)) { ok(false, 'image exists: ' + n + '.jpg'); return; }
  const b = fs.readFileSync(p); total += b.length;
  ok(b[0] === 0xff && b[1] === 0xd8, n + '.jpg is a JPEG');
  // JPEG size: scan for the SOF marker
  let w = 0, hgt = 0; for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) { hgt = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + b.readUInt16BE(i + 2); }
  ok(w === 1366 && hgt === 854, n + '.jpg is 1366x854 (is ' + w + 'x' + hgt + ')');
  ok(b.length > 30 * 1024, n + '.jpg is not nearly empty (' + b.length + ' bytes)');
});
files.forEach((f) => ok(used.has(f.replace(/\.jpg$/, '')), 'no unused image: ' + f));
ok(total < BUDGET, 'images total ' + (total / 1048576).toFixed(2) + ' MB, budget 4 MB');
ok(used.size >= 20 && used.size <= 30, 'about 20 to 28 images (' + used.size + ')');

// the markdown
const md = read('docs/TUTORIALS.md');
(md.match(/\(\.\.\/web\/app\/howto\/[^)]+\)/g) || []).forEach((m) => { const f = m.slice(1, -1).replace('../', ''); ok(fs.existsSync(path.join(ROOT, f)), 'TUTORIALS.md image exists: ' + f); });
ok((md.match(/!\[/g) || []).length === used.size, 'TUTORIALS.md shows every image once');
try { require('./howto_docs.cjs'); ok(require('./howto_docs.cjs').render() === md, 'docs/TUTORIALS.md is in step with the data (node tests/howto_docs.cjs)'); } catch (e) { ok(false, 'howto_docs: ' + e.message); }
ok(/docs\/TUTORIALS\.md/.test(read('README.md')), 'README links docs/TUTORIALS.md');
ok(/x-howto\.css/.test(viewSrc), 'the view loads x-howto.css');

async function browser() {
  let pw = null;
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(c); break; } catch (e) { /* next */ } }
  if (!pw) { ok(false, 'playwright not found'); return; }
  const b = await pw.chromium.launch();
  const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + 'index.html#howto', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app[data-state="ready"]', { timeout: 180000 });
  await page.waitForSelector('.hw-title', { timeout: 20000 });
  for (const t of D.tutorials) {
    await page.evaluate((h) => { location.hash = h; }, '#howto-' + t.id); await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      document.querySelectorAll('.hw-shot img').forEach((i) => { i.loading = 'eager'; });
      return { title: (document.querySelector('.hw-title') || {}).textContent, sw: document.documentElement.scrollWidth, vw: document.getElementById('view').scrollWidth, cw: document.getElementById('view').clientWidth, n: document.querySelectorAll('.hw-step').length, limits: !!document.querySelector('.hw-limits li') };
    });
    ok(r.title === t.title, t.id + ': deep link opens "' + t.title + '" (got ' + r.title + ')');
    ok(r.n === t.steps.length, t.id + ': all steps drawn');
    ok(r.sw <= 390 && r.vw <= r.cw, t.id + ': no horizontal scroll at 390 px (' + r.sw + ', ' + r.vw + '/' + r.cw + ')');
    ok(r.limits, t.id + ': limits shown');
    await page.waitForTimeout(700);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.hw-shot img')].filter((i) => !(i.complete && i.naturalWidth > 0)).length);
    ok(bad === 0, t.id + ': all pictures load (' + bad + ' failed)');
    ok(await page.evaluate(() => [...document.querySelectorAll('.hw-try')].every((a) => /^#[a-z]/.test(a.getAttribute('href')))), t.id + ': Try it links are routes');
  }
  await page.evaluate(() => { location.hash = '#howto-markush'; }); await page.waitForTimeout(500);
  await page.click('.hw-shot'); await page.waitForSelector('.hw-lb img');
  ok(true, 'enlarge opens');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(!(await page.$('.hw-lb')), 'Escape closes the enlarged picture');
  ok(!errs.length, 'no page errors: ' + errs.join('; '));
  await b.close();
}

(async () => {
  if (BASE) await browser();
  console.log((fails ? 'FAILED ' + fails + ' of ' : 'ok: ') + checks + ' checks' + (BASE ? ' (with browser)' : ' (static only; --base URL adds the browser run)'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
