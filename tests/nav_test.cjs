/* Navigation bar test (web/engine/x-nav.js + web/app/x-nav.css): breadcrumbs, back / forward, keyboard, phone width, themes.
     node tests/nav_test.cjs [--site dist-pages] [--tmp <dir>] [--shots <dir>]
   Serves a scratch copy of a website build (default dist-pages/; data files are symlinked, never changed) with the new files copied
   over it and added to the manifest "files" list the way the build does (path -> [bytes, sha256]). Needs Playwright. Exit 1 on a failure. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SITE = path.resolve(ROOT, arg('site', 'dist-pages'));
const SHOTS = arg('shots', '') ? path.resolve(arg('shots')) : null;
const NEW_FILES = ['engine/x-nav.js', 'app/x-nav.css'];

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try { return require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch (e) { return null; }
}
function symlinkTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) symlinkTree(s, d); else fs.symlinkSync(s, d);
  }
}
function scratch() {
  const dir = fs.mkdtempSync(path.join(arg('tmp', os.tmpdir()), 'nav-site-'));
  for (const e of fs.readdirSync(SITE)) {
    if (e === 'data') continue;
    fs.cpSync(path.join(SITE, e), path.join(dir, e), { recursive: true });
  }
  symlinkTree(path.join(SITE, 'data'), path.join(dir, 'data'));
  const mp = path.join(dir, 'data/manifest.json');
  fs.rmSync(mp);
  const M = JSON.parse(fs.readFileSync(path.join(SITE, 'data/manifest.json'), 'utf8'));
  for (const f of NEW_FILES) {
    const buf = fs.readFileSync(path.join(ROOT, 'web', f));
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), buf);
    M.files[f] = [buf.length, crypto.createHash('sha256').update(buf).digest('hex')];
  }
  fs.writeFileSync(mp, JSON.stringify(M));
  return dir;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(dir) {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

let fails = 0, checks = 0;
function ok(cond, msg, extra) { checks++; if (!cond) { fails++; console.log('FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } else console.log('ok   ' + msg); }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, a); }

async function main() {
  const pw = loadPlaywright(); if (!pw) { console.error('playwright not found'); process.exit(2); }
  const dir = scratch(), srv = await serve(dir), base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await pw.chromium.launch();
  const errors = [];
  async function open(opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 854 }, reducedMotion: 'reduce', colorScheme: 'light' }, opts || {}));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app[data-state="ready"]', { timeout: 240000 });
    await page.waitForSelector('#xnav');
    await page.waitForTimeout(500);
    return { ctx, page };
  }
  const crumbs = (page) => page.$$eval('#xnav .xnav-list li', (l) => l.map((x) => x.textContent));
  const state = (page) => page.evaluate(() => ({ back: !document.getElementById('xnav-back').disabled, fwd: !document.getElementById('xnav-fwd').disabled, hash: location.hash }));
  const settle = (page, ms) => page.waitForTimeout(ms || 700);
  const goHash = async (page, h, ms) => { await page.evaluate((x) => { location.hash = x; }, h); await settle(page, ms || 900); };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

  /* ---- desktop walk: Search -> patent -> Tools -> Markush -> How to */
  let { ctx, page } = await open();
  eq(await crumbs(page), ['Search'], 'start: crumb "Search"');
  let s = await state(page); ok(!s.back && !s.fwd, 'start: back and forward disabled', s);
  eq(await page.$eval('#xnav nav', (n) => n.getAttribute('aria-label')), 'Breadcrumb', 'nav has aria-label Breadcrumb');
  ok(await page.$('#xnav nav > ol'), 'ordered list inside nav');
  eq(await page.$eval('#xnav-back', (b) => b.getAttribute('aria-label')), 'Back', 'back button aria-label');
  eq(await page.$eval('#xnav-fwd', (b) => b.getAttribute('aria-label')), 'Forward', 'forward button aria-label');
  eq(await page.$$eval('#xnav [aria-current="page"]', (l) => l.length), 1, 'exactly one aria-current');

  await goHash(page, '#suche-lipid-20nanoparticle');
  eq(await crumbs(page), ['Search', '“lipid nanoparticle”'], 'search text crumb');
  await goHash(page, '#patent-EP3350157B1', 1500);
  eq(await crumbs(page), ['Search', 'EP 3 350 157 B1'], 'patent crumbs');
  eq(await page.$$eval('#xnav a.xnav-c', (a) => a.map((x) => x.getAttribute('href'))), ['#suche-lipid-20nanoparticle'], 'Search crumb links back to the last query');
  eq(await page.$eval('#xnav [aria-current="page"]', (e) => e.tagName), 'SPAN', 'last crumb is not a link');
  s = await state(page); ok(s.back && !s.fwd, 'patent: back enabled, forward disabled', s);
  await page.click('#rail a[href="#tools"]'); await settle(page, 1200);
  eq(await crumbs(page), ['Tools'], 'tools crumbs');
  await goHash(page, '#markush-EP3350157B1--c1', 1800);
  eq(await crumbs(page), ['Tools', 'Markush check', 'EP 3 350 157 B1 claim 1'], 'markush crumbs');
  eq(await page.$$eval('#xnav a.xnav-c', (a) => a.map((x) => x.getAttribute('href'))), ['#tools', '#markush'], 'markush parent crumbs are links');
  await shot(page, 'desktop-markush-light');
  await page.click('#rail a[href="#howto"]'); await settle(page, 1200);
  await goHash(page, '#howto-markush', 1500);
  eq(await crumbs(page), ['How to', 'Markush check'], 'how to crumbs');
  await goHash(page, '#ai', 1500);
  eq(await crumbs(page), ['System', 'AI provider'], 'system / AI crumbs');
  await goHash(page, '#designs--nEP3350157B1--c2', 1500);
  eq(await crumbs(page), ['Tools', 'Design-around ideas', 'EP 3 350 157 B1 claim 2'], 'patent number from param n');
  await goHash(page, '#howto-markush', 1200);

  /* ---- back / forward restore the views */
  const title = () => page.evaluate(() => { const e = document.querySelector('#view h1, #view .page-title'); return e ? e.textContent.trim() : ''; });
  const t0 = await title();
  await page.click('#xnav-back'); await settle(page, 1200);
  eq(await crumbs(page), ['Tools', 'Design-around ideas', 'EP 3 350 157 B1 claim 2'], 'back restores designs');
  await page.click('#xnav-back'); await settle(page, 1200);
  eq(await crumbs(page), ['System', 'AI provider'], 'back restores AI');
  await page.click('#xnav-back'); await settle(page, 1200);
  eq(await crumbs(page), ['How to', 'Markush check'], 'back restores how to');
  await page.click('#xnav-back'); await settle(page, 1200);
  await page.click('#xnav-back'); await settle(page, 1200);
  eq(await crumbs(page), ['Tools', 'Markush check', 'EP 3 350 157 B1 claim 1'], 'back restores markush');
  ok((await page.$$eval('#view .page', (l) => l.length)) >= 1, 'markush view is mounted');
  s = await state(page); ok(s.back && s.fwd, 'middle of history: both enabled', s);
  await page.click('#xnav-fwd'); await settle(page, 1200);
  eq(await crumbs(page), ['How to'].length ? ['How to'] : [], 'forward restores how to (rail link)');
  for (let i = 0; i < 6; i++) { s = await state(page); if (!s.back) break; await page.click('#xnav-back'); await settle(page, 900); }
  s = await state(page); ok(!s.back && s.fwd, 'at the start: back disabled, forward enabled', s);
  eq(await crumbs(page), ['Search'], 'start page restored');
  ok(await page.$eval('#xnav-back', (b) => b.disabled), 'disabled attribute set on back');
  // new navigation after going back drops the forward branch
  await goHash(page, '#produkte', 1200);
  s = await state(page); ok(s.back && !s.fwd, 'new navigation clears forward', s);
  // crumb link
  await goHash(page, '#markush-EP3350157B1--c1', 1500);
  await page.click('#xnav a.xnav-c[href="#tools"]'); await settle(page, 1200);
  eq(await crumbs(page), ['Tools'], 'clicking a crumb navigates');
  s = await state(page); ok(s.back, 'crumb navigation is in history', s);

  /* ---- replace / silent router calls keep position and refresh crumbs */
  await goHash(page, '#markush-EP3350157B1--c1', 1500);
  const before = await page.evaluate(() => history.length);
  await page.evaluate(() => LnpApp.go({ view: 'markush', arg: 'EP3350157B1', params: { c: '3' } }, { replace: true, silent: true }));
  await settle(page, 300);
  eq(await crumbs(page), ['Tools', 'Markush check', 'EP 3 350 157 B1 claim 3'], 'replace updates the crumb');
  eq(await page.evaluate(() => history.length), before, 'replace adds no history entry');
  await page.click('#xnav-back'); await settle(page, 1000);
  eq(await crumbs(page), ['Tools'], 'back after replace goes to the previous entry');
  await page.click('#xnav-fwd'); await settle(page, 1000);
  eq(await crumbs(page), ['Tools', 'Markush check', 'EP 3 350 157 B1 claim 3'], 'forward returns to the replaced entry');

  /* ---- hooks and untrusted labels */
  await page.evaluate(() => {
    LnpApp.registerView({ id: 'zz', title: 'Zed', rail: false, parent: 'tools', crumb: (r) => '<img src=x onerror="window.__xss=1">' + r.arg, mount: (el) => { el.textContent = 'zz'; } });
    LnpApp.ext.crumb((r, v) => v.id === 'tools' ? 'Hooked <b>x</b>' : null);
  });
  await goHash(page, '#zz-' + 'LONG'.repeat(60), 900);
  const zz = await crumbs(page);
  ok(zz.length === 3 && zz[1] === 'Zed' && zz[2].indexOf('<img') === 0, 'view crumb option used, text kept as text', zz);
  eq(await page.$$eval('#xnav img, #xnav b', (l) => l.length), 0, 'no markup created from labels');
  eq(await page.evaluate(() => window.__xss || 0), 0, 'no script ran');
  ok(await page.$eval('#xnav [aria-current="page"]', (e) => e.getAttribute('title').length > 100 && e.scrollWidth > 0 && e.getBoundingClientRect().width < 600), 'long label truncated, full label in title');
  await goHash(page, '#tools', 900);
  eq(await crumbs(page), ['Tools', 'Hooked <b>x</b>'], 'ext.crumb hook adds an item');
  await ctx.close();

  /* ---- keyboard (Windows / Linux) */
  ({ ctx, page } = await open());
  await goHash(page, '#produkte', 1000); await goHash(page, '#landschaft', 1000);
  await page.keyboard.press('Alt+ArrowLeft'); await settle(page, 900);
  eq((await state(page)).hash, '#produkte', 'Alt+Left goes back');
  await page.keyboard.press('Alt+ArrowRight'); await settle(page, 900);
  eq((await state(page)).hash, '#landschaft', 'Alt+Right goes forward');
  await page.keyboard.press('Alt+ArrowLeft'); await settle(page, 600);
  await page.keyboard.press('Alt+ArrowLeft'); await settle(page, 600);
  await page.keyboard.press('Alt+ArrowLeft'); await settle(page, 600);
  eq((await state(page)).hash, '#suche', 'Alt+Left stops at the start');
  await goHash(page, '#suche', 300);
  const q = await page.$('#q');
  if (q) {
    await page.keyboard.press('Alt+ArrowRight'); await settle(page, 600);
    await goHash(page, '#produkte', 800);
    await page.click('#rail a[href="#suche"]'); await settle(page, 900);
    await page.focus('#q'); const h1 = (await state(page)).hash;
    await page.keyboard.press('Alt+ArrowLeft'); await settle(page, 700);
    eq((await state(page)).hash, h1, 'Alt+Left inside a text input is left alone');
  } else ok(false, 'search input #q exists');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await ctx.close();

  /* ---- keyboard (Mac) */
  ({ ctx, page } = await (async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 854 }, reducedMotion: 'reduce' });
    await c.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); });
    const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#app[data-state="ready"]', { timeout: 240000 }); await p.waitForSelector('#xnav'); await p.waitForTimeout(500);
    return { ctx: c, page: p };
  })());
  await goHash(page, '#produkte', 1000); await goHash(page, '#landschaft', 1000);
  await page.keyboard.press('Meta+BracketLeft'); await settle(page, 900);
  eq((await state(page)).hash, '#produkte', 'Cmd+[ goes back');
  await page.keyboard.press('Meta+BracketRight'); await settle(page, 900);
  eq((await state(page)).hash, '#landschaft', 'Cmd+] goes forward');
  eq(await page.$eval('#xnav-back', (b) => b.title), 'Back (⌘[)', 'Mac tooltip');
  await ctx.close();

  /* ---- phone width and themes */
  for (const scheme of ['light', 'dark']) {
    ({ ctx, page } = await open({ viewport: { width: 390, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true }));
    await goHash(page, '#patent-EP3350157B1', 1500);
    await goHash(page, '#markush-EP3350157B1--c1', 1800);
    const m = await page.evaluate(() => {
      const bar = document.getElementById('xnav'), r = bar.getBoundingClientRect(), lis = [...bar.querySelectorAll('li')].filter((l) => getComputedStyle(l).display !== 'none');
      const cs = getComputedStyle(bar), vb = document.getElementById('view').getBoundingClientRect(), band = document.getElementById('band').getBoundingClientRect(), rail = document.getElementById('rail').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, bw: bar.scrollWidth, bc: bar.clientWidth, right: r.right, vis: lis.map((l) => l.textContent), bg: cs.backgroundColor, top: r.top, bandB: band.bottom, viewTop: vb.top, barB: r.bottom, railTop: rail.top, barH: r.height };
    });
    ok(m.sw <= m.iw, scheme + ' 390px: no horizontal page scroll', m);
    ok(m.bw <= m.bc + 1 && m.right <= m.iw, scheme + ' 390px: bar fits', m);
    eq(m.vis, ['Markush check', 'EP 3 350 157 B1 claim 1'], scheme + ' 390px: last two crumbs only');
    ok(Math.abs(m.top - m.bandB) < 1.5 && Math.abs(m.viewTop - m.barB) < 1.5, scheme + ' 390px: bar sits between band and work area', m);
    ok(m.railTop >= m.viewTop, scheme + ' 390px: rail stays at the bottom', m);
    ok(scheme === 'dark' ? /^rgb\((2[0-9]|1[0-9]|[0-9]),/.test(m.bg) : /^rgb\(25[0-9]/.test(m.bg), scheme + ' theme background token', m.bg);
    await shot(page, 'phone-' + scheme);
    await ctx.close();
  }
  ({ ctx, page } = await open({ viewport: { width: 1366, height: 854 }, colorScheme: 'dark' }));
  await goHash(page, '#patent-EP3350157B1', 1500);
  await goHash(page, '#markush-EP3350157B1--c1', 1800);
  await shot(page, 'desktop-markush-dark');
  const sticky = await page.evaluate(() => { const v = document.getElementById('view'); v.scrollTop = 400; const r = document.getElementById('xnav').getBoundingClientRect(), b = document.getElementById('band').getBoundingClientRect(); return Math.abs(r.top - b.bottom) < 1.5; });
  ok(sticky, 'bar stays under the band while the work area scrolls');
  await ctx.close();

  ok(!errors.length, 'no page errors', errors);
  await browser.close(); srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (checks - fails) + '/' + checks + ' checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
