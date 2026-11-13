/* Screenshots for the "How to" tutorials (web/app/howto/<tutorial>-<n>.jpg).
     node tests/howto_shots.cjs [--base http://localhost:8000/] [--out web/app/howto] [--only getting,search] [--quality 78]
   --base  URL of a served build of the website (dist-pages/, e.g. `python3 -m http.server 8000` inside dist-pages)
   --out   target directory (default web/app/howto)
   Viewport 1366x854, scale 1, light theme, JPEG. Waits for the boot of the app (data-state="ready" on #app).
   Every shot is checked for loaders and error notices; a shot that shows one is reported and the run exits with 1.
   Rerun after UI changes. Inputs are fixed on purpose (SM-102, EP3350157B1, EP3532103B1) so the pictures stay comparable. */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:8765/').replace(/\/?$/, '/');
const OUT = path.resolve(arg('out', path.join(ROOT, 'web/app/howto')));
const ONLY = arg('only', '') ? arg('only').split(',') : null;
const QUALITY = +arg('quality', 78);

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}

// reference inputs (SMILES of SM-102 from data/seed/ref_lipids_pubchem.json)
const SM102 = 'CCCCCCCCCCCOC(=O)CCCCCN(CCCCCCCC(=O)OC(CCCCCCCC)CCCCCCCC)CCO';
const MC3 = 'CCCCC/C=C\\C/C=C\\CCCCCCCCC(OC(=O)CCCN(C)C)CCCCCCCC/C=C\\C/C=C\\CCCCC';
const ALC = 'CCCCCCCCC(CCCCCC)C(=O)OCCCCCCN(CCCCCCOC(=O)C(CCCCCC)CCCCCCCC)CCCCO';
const PN = 'EP3532103B1', MK_PN = 'EP3350157B1';

const problems = [];
const made = [];

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.error('playwright not found'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 854 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  await page.addInitScript(() => { try { localStorage.setItem('lnp.theme', 'light'); } catch (e) { /* ignore */ } });
  await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app[data-state="ready"]', { timeout: 180000 });
  // the pictures show no toasts and no empty selection bar
  await page.addStyleTag({ content: '#toasts{display:none!important} .selbar[hidden]{display:none!important}' });
  await page.waitForTimeout(1200);

  const go = async (hash, wait) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(wait || 1800); };
  const top = () => page.evaluate(() => { const v = document.getElementById('view'); if (v) v.scrollTop = 0; window.scrollTo(0, 0); });
  // scroll the first element (any depth) whose own text starts with `text` to the top of the work area
  const scrollText = async (re) => {
    const ok = await page.evaluate((src) => {
      const rx = new RegExp(src);
      const el = [...document.querySelectorAll('#view *')].find((e) => !e.children.length && rx.test(e.textContent.trim()));
      if (!el) return false;
      el.scrollIntoView({ block: 'start' }); const v = document.getElementById('view'); if (v) v.scrollTop -= 60; return true;
    }, re);
    if (!ok) problems.push('scroll text not found: ' + re);
    await page.waitForTimeout(400);
  };
  // scroll the heading (or any selector / text) of a section to the top of the work area
  const scrollTo = async (sel, text) => {
    const ok = await page.evaluate(({ sel, text }) => {
      const els = [...document.querySelectorAll(sel)].filter((e) => !text || e.textContent.trim().indexOf(text) === 0);
      const el = els[0]; if (!el) return false;
      el.scrollIntoView({ block: 'start' });
      const v = document.getElementById('view'); if (v) v.scrollTop -= 24;
      return true;
    }, { sel, text });
    if (!ok) problems.push('scroll target not found: ' + sel + (text ? ' "' + text + '"' : ''));
    await page.waitForTimeout(400);
  };
  const shot = async (name, note) => {
    await page.waitForTimeout(350);
    // no loaders, no error notices unless the caller says so
    const bad = await page.evaluate(() => {
      const v = document.getElementById('view'); const out = [];
      if (!v) return ['no #view'];
      if (v.querySelector('.k-busy, .spin, .boot')) out.push('loader visible');
      if (v.querySelector('.notice.err')) out.push('error notice: ' + v.querySelector('.notice.err').textContent.slice(0, 120));
      return out;
    });
    if (bad.length && !(note && note.allow)) problems.push(name + ': ' + bad.join('; '));
    const buf = await page.screenshot({ type: 'jpeg', quality: QUALITY });
    const f = path.join(OUT, name + '.jpg'); fs.writeFileSync(f, buf); made.push([name, buf.length]);
    console.log('  ' + name + '.jpg  ' + Math.round(buf.length / 1024) + ' KB');
  };
  const group = (id) => !ONLY || ONLY.indexOf(id) >= 0;
  const click = async (sel) => { await page.click(sel); await page.waitForTimeout(500); };
  const type = async (sel, v) => { await page.fill(sel, v); };

  /* ------------------------------------------------------------ getting started */
  if (group('start')) {
    console.log('start');
    await go('#suche'); await top(); await shot('start-1');
    await page.keyboard.press('Control+K'); await page.waitForTimeout(500);
    await page.keyboard.type('ionizable', { delay: 20 }); await page.waitForTimeout(900);
    await shot('start-2');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }

  /* ------------------------------------------------------------ search */
  if (group('search')) {
    console.log('search');
    await go('#suche'); await top();
    await type('#q', 'ionizable lipid mRNA'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    await top(); await shot('search-1');
    // a facet: legal status "Granted"
    await page.evaluate(() => { const l = [...document.querySelectorAll('#view label')].find((x) => /^\s*Granted/.test(x.textContent)); if (l) l.click(); });
    await page.waitForTimeout(1500); await top(); await shot('search-2');
    // field search with chips: title + assignee
    await type('#q', 'title:"lipid nanoparticle" asg:Moderna'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    await page.evaluate(() => { const l = [...document.querySelectorAll('#view label')].find((x) => /^\s*Granted/.test(x.textContent)); const c = l && l.querySelector('input'); if (c && c.checked) l.click(); });
    await page.waitForTimeout(1200); await top(); await shot('search-3');
  }

  /* ------------------------------------------------------------ patent page */
  if (group('patent')) {
    console.log('patent');
    await go('#patent-' + PN, 3000); await top(); await shot('patent-1');
    await scrollTo('#view h2', 'Claims'); await shot('patent-2');
    await scrollTo('#view h2', 'Legal and prosecution timeline'); await shot('patent-3');
  }

  /* ------------------------------------------------------------ structure search */
  if (group('structure')) {
    console.log('structure');
    await go('#struktur'); await top();
    await type('#st-q', 'SM-102'); await page.keyboard.press('Enter'); await page.waitForTimeout(3500);
    await page.evaluate(() => { const d = document.getElementById('st-edfold'); if (d) d.open = false; }); await top(); await shot('structure-1');
    await page.evaluate(() => { const b = [...document.querySelectorAll('#view button')].find((x) => x.textContent.trim() === 'Substructure'); if (b) b.click(); });
    await page.waitForTimeout(3500); await page.evaluate(() => { const d = document.getElementById('st-edfold'); if (d) d.open = false; }); await top(); await shot('structure-2');
  }

  /* ------------------------------------------------------------ FTO */
  if (group('fto')) {
    console.log('fto');
    await go('#fto'); await top(); await shot('fto-1', { allow: true });
  }

  /* ------------------------------------------------------------ Markush */
  if (group('markush')) {
    console.log('markush');
    await go('#markush'); await top();
    await type('#mk-q', SM102); await click('#view button:has-text("Check")'); await page.waitForTimeout(800);
    await type('#mk-pn', MK_PN); await click('#view button:has-text("Load")'); await page.waitForTimeout(3500);
    await scrollTo('#view h2', 'Molecule'); await shot('markush-1');
    await scrollTo('#view h2', 'Result'); await shot('markush-2');
    await page.evaluate(() => { const t = document.querySelector('#view table'); if (t) t.scrollIntoView({ block: 'start' }); const v = document.getElementById('view'); if (v) v.scrollTop -= 24; });
    await shot('markush-3');
  }

  /* ------------------------------------------------------------ library screen */
  if (group('screen')) {
    console.log('screen');
    await go('#screen'); await top();
    await type('#sc-input', [SM102, ALC, MC3, 'CCCCCCCCCCCCCCCCCCCC(=O)OCC(COC(=O)CCCCCCCCCCCCCCCCC)N(C)C'].join('\n'));
    await page.waitForTimeout(600); await shot('screen-1');
    await click('#sc-run'); await page.waitForTimeout(9000);
    await scrollTo('#sc-run'); await shot('screen-2');
  }

  /* ------------------------------------------------------------ range check */
  if (group('ranges')) {
    console.log('ranges');
    await go('#ranges'); await top();
    const rows = [['mol_pct', 'ionizable_cationic', '50'], ['mol_pct', 'phospholipid_helper', '10'], ['mol_pct', 'sterol', '38.5'], ['mol_pct', 'peg', '1.5'], ['size_nm', '', '80']];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) { await page.click('#view button:has-text("Add value")'); await page.waitForTimeout(250); }
      const n = i + 1;
      await page.selectOption('#rg-p' + n, rows[i][0]);
      if (rows[i][0] === 'mol_pct') await page.selectOption('#rg-c' + n, rows[i][1]);
      await type('#rg-v' + n, rows[i][2]);
    }
    await page.waitForTimeout(400); await shot('ranges-1');
    await click('#view button:has-text("Check claims")'); await page.waitForTimeout(5000);
    await scrollTo('#view h2', 'Claims with all values inside'); await shot('ranges-2');
  }

  /* ------------------------------------------------------------ design-around */
  if (group('designs')) {
    console.log('designs');
    await go('#designs'); await top();
    await type('#da-q', SM102); await type('#da-pn', MK_PN); await type('#da-c', '1');
    await click('#view button:has-text("Generate ideas")'); await page.waitForTimeout(9000);
    await scrollText('^\\d+ of \\d+ variants'); await shot('designs-1');
  }

  /* ------------------------------------------------------------ disclosure + white space */
  if (group('disclosure')) {
    console.log('disclosure');
    await go('#disclosure'); await top();
    await type('#dc-q', 'SM-102'); await click('#view button:has-text("Show timeline")'); await page.waitForTimeout(5000);
    await top(); await shot('disclosure-1');
    await go('#whitespace', 5000); await top(); await shot('disclosure-2');
  }

  /* ------------------------------------------------------------ expiry */
  if (group('expiry')) {
    console.log('expiry');
    await go('#expiry'); await top();
    await page.getByRole('button', { name: 'List', exact: true }).click(); await page.waitForTimeout(500);
    await page.waitForTimeout(400);
    await page.evaluate((pns) => { const t = document.getElementById('ex-text') || document.querySelector('#view textarea'); if (t) { t.value = pns; t.dispatchEvent(new Event('input', { bubbles: true })); } }, [PN, 'EP2788006B1', 'US12589078B2', 'EP3350157B1'].join('\n'));
    await shot('expiry-1');
    await click('#ex-run'); await page.waitForTimeout(4000);
    await scrollTo('#ex-run'); await shot('expiry-2');
  }

  /* ------------------------------------------------------------ similar */
  if (group('similar')) {
    console.log('similar');
    await go('#similar'); await top();
    await type('#sm-pn', PN); await click('#sm-go'); await page.waitForTimeout(4000);
    await top(); await shot('similar-1');
  }

  /* ------------------------------------------------------------ watchlist */
  if (group('watchlist')) {
    console.log('watchlist');
    await go('#suche'); await top();
    await type('#q', 'lipid nanoparticle'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    const stars = await page.$$('#view .star');
    for (let i = 0; i < Math.min(3, stars.length); i++) { await stars[i].click(); await page.waitForTimeout(200); }
    await top(); await shot('watchlist-1');
    await go('#merkliste', 2500); await top(); await shot('watchlist-2');
    // leave no trace in the profile of this browser context
    await page.evaluate(() => { document.querySelectorAll('#view .star[aria-pressed="true"]').forEach((b) => b.click()); });
  }

  /* ------------------------------------------------------------ own AI */
  if (group('ownai')) {
    console.log('ownai');
    await go('#tools', 2500);
    await type('#tl-pns', PN); await click('#tl-go'); await page.waitForTimeout(2500);
    await scrollTo('#tl-ai'); await shot('ownai-1');
  }

  await browser.close();
  const total = made.reduce((a, b) => a + b[1], 0);
  console.log('\n' + made.length + ' images, ' + (total / 1024 / 1024).toFixed(2) + ' MB in ' + OUT);
  if (problems.length) { console.log('PROBLEMS:\n  ' + problems.join('\n  ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
