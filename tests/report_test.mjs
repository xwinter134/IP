// Tests for the FTO report export: the HTML design of web/engine/fto-render.js (render(op, "html")) and its print/PDF form.
//   node tests/report_test.mjs                  checks on the fixture opinion (English-only content: tests/english_test.mjs) (tests/fixtures/fto-opinion.json), then a Chromium
//                                               pass (PDF + screenshots in a temp folder) when Playwright is installed
//   node tests/report_test.mjs --write-samples  also writes docs/samples/fto-report-sample.{html,pdf} (fixture data only)
//   node tests/report_test.mjs --no-browser     skip the Chromium pass
// No network. Exit code 1 when a check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let passed = 0, failed = 0;
const ok = (c, name, detail) => { if (c) passed++; else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); } };
const section = (t) => console.log('== ' + t);

const R = require(path.join(ROOT, 'web/engine/fto-render.js'));
const op = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/fto-opinion.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

section('1 structure of the HTML report');
const html = R.render(op, 'html');
{
  ok(!/<script/i.test(html) && !/<iframe|<object|<embed|<link|<img|<form/i.test(html), 'no script, frame, link, image or form element');
  ok(!/<[^>]*\son[a-z]+\s*=/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'no event-handler attribute');
  const bodyNoCss = html.replace(/<style>[\s\S]*?<\/style>/, '');
  ok(!/https?:\/\//i.test(html) && !/\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(bodyNoCss), 'no http(s) or protocol-relative URL anywhere');
  ok(!/<[^>]*\ssrc\s*=/i.test(html) && [...html.matchAll(/<[^>]*\shref\s*=\s*"([^"]*)"/gi)].every((m) => m[1].startsWith('#')), 'only in-page anchors in href, no src');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  ok(!/url\s*\(/i.test(css) && !/@import|@font-face/i.test(css), 'CSS has no url(), @import or @font-face (no remote or embedded fonts)');
  ok(/"Inter"/.test(css) && /"Martian Mono"/.test(css) && /system-ui/.test(css) && /--band-a:#473f96/.test(css) && /--band-e:#b0412a/.test(css) && /linear-gradient\(120deg,var\(--band-a\)/.test(css), 'app tokens: font stacks with system fallbacks, header-band gradient #473f96 to #b0412a');
  ok(/class="cover"/.test(html) && /<strong>LNP<\/strong> <span>Patent Desk<\/span>/.test(html), 'cover block with the wordmark "LNP Patent Desk"');
  ok(!/amass|logo/i.test(html), 'no logo and no third-party brand name');
  ok(/<nav class="toc"/.test(html) && /<a href="#s1">/.test(html) && /id="s1"/.test(html) && /<a href="#r1">/.test(html) && /id="r1"/.test(html), 'table of contents with working anchors for sections and per-right sections');
  ok((html.match(/<section class="right r\d"/g) || []).length === op.patents.length, 'one section per analysed patent right', String((html.match(/<section class="right/g) || []).length));
  ok(/<div class="hero r5"><span class="lab">Overall risk<\/span><span class="lvl">very high \(5\)<\/span>/.test(html) && /class="pips" aria-hidden="true"/.test(html), 'executive summary: overall risk as text level (and pips), not colour alone');
  ok(/class="rk r4"><span class="pips"[^>]*>[^<]*<\/span><span>high \(4\)<\/span>/.test(html) && /class="rk r0"><span>cannot be assessed<\/span>/.test(html), 'risk chips carry their text label; "cannot be assessed" is its own neutral state');
  ok(/class="qm ok"><span class="g" aria-hidden="true">✔<\/span>found verbatim in the claim/.test(html) && /class="qm bad"><span class="g" aria-hidden="true">✖<\/span>NOT VERIFIED/.test(html), 'verified-quote markers: symbol plus text for verified and unverified quotes');
  ok(/<table class="chart">/.test(html) && /<table class="matrix">/.test(html) && /<td class="q">/.test(html), 'claim chart and risk matrix tables');
  ok(/class="vd met"/.test(html) && /class="vd not"|class="vd unc"/.test(html), 'verdict markers (met / not met / unclear) in the claim charts');
  const htmlEv = R.render(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/fto-opinion-evidence.json'), 'utf8')), 'html');
  ok(/class="co evidence"/.test(htmlEv) && /Markush check/.test(htmlEv) && /Numeric ranges in the claims/.test(htmlEv) && /class="co openq"/.test(html) && /class="co redteam"/.test(html), 'evidence (risk floors, Markush, ranges), open questions and red-team blocks are set apart');
  ok(/<aside class="about"/.test(html) && /Risk scale/.test(html) && /Method/.test(html), 'reading guide with the risk scale, markers and method');
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).trim();
  const lim = op.limits.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  ok(body.startsWith('<pre class="limits">' + lim + '</pre>') && body.endsWith('<pre class="limits">' + lim + '</pre>'), 'the verbatim limits block is the first and the last element');
  ok(/not legal advice/i.test(op.limits) && /not legal advice/i.test(html) && /Pre-screening, not legal advice/.test(html), 'the "not legal advice" statement is in the limits block and on the cover');
  ok(/Status snapshot 2026-08-23/.test(html), 'the page footer text names the status snapshot date');
}

section('2 print CSS');
{
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  ok(/@page\{size:A4;margin:/.test(css), '@page size A4 with margins');
  ok(/@page\{@bottom-left\{content:"[^"]*not legal advice[^"]*Status snapshot 2026-08-23"/.test(css) && /@bottom-right\{content:"Page " counter\(page\) " of " counter\(pages\)/.test(css), 'running footer (snapshot date) and page numbers in the page margin boxes');
  ok(/@media print\{/.test(css), '@media print block');
  ok(/thead\{display:table-header-group\}/.test(css) && /tr\{break-inside:avoid/.test(css), 'tables split by row with a repeated header');
  ok(/h2,h3,h4,h5\{[^}]*break-after:avoid/.test(css) && /\.rhead\{[^}]*break-after:avoid/.test(css), 'no orphaned headings');
  ok(/print-color-adjust:exact/.test(css), 'colours and the gradient are kept in print');
  ok(/@media screen and \(prefers-color-scheme:dark\)/.test(css), 'optional dark theme is screen only; print stays light');
}

section('3 untrusted text is escaped, in the new design as well');
{
  const bad = clone(op), X = '<script>alert(7)</script> "q" \'s\' <img src=x onerror=alert(8)> </style><b>x</b>';
  bad.title = 'T ' + X; bad.profile.bezeichnung = X; bad.matrix[0].notes = X;
  bad.patents[0].title = X; bad.patents[0].assignee = X;
  bad.patents[0].chart.claims[0].merkmale[0].claim_quote = X; bad.patents[0].chart.claims[0].merkmale[0].begruendung = X;
  bad.synthesis.offene_fragen = [X]; bad.snapshot = { ep_text: X }; bad.statusSnapshot = '2";}*{x:y';
  bad.patents[0].risk = { ...bad.patents[0].risk }; bad.matrix[0].pn = X;
  const h = R.render(bad, 'html');
  ok(!/<script/i.test(h) && !/<img/i.test(h) && !/<b>x<\/b>/.test(h) && !/<[^>]*\sonerror=/.test(h), 'no tag from patent text or model output reaches the document');
  ok(h.includes('&lt;script&gt;alert(7)&lt;/script&gt;') && h.includes('&quot;q&quot;') && h.includes('&#39;s&#39;'), 'the text is still there, escaped');
  const css = h.match(/<style>([\s\S]*?)<\/style>/)[1];
  ok(!/script|alert|</.test(css) && !css.includes('}*{x:y') && /content:"[^"]*Status snapshot 2x:y"/.test(css), 'text from the data cannot leave the footer CSS string (snapshot date is reduced to safe characters)');
  const tags = [...h.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[1].toLowerCase());
  const allowed = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'strong', 'br', 'header', 'nav', 'section', 'aside', 'span', 'a']);
  ok(tags.every((t) => allowed.has(t)), 'fixed set of structural tags only', [...new Set(tags.filter((t) => !allowed.has(t)))].join(','));
  const md = R.render(op, 'md'), js = R.render(op, 'json');
  ok(md.startsWith(op.limits) && md.endsWith(op.limits) && JSON.parse(js).hinweis === op.limits && JSON.parse(js).patents.length === op.patents.length, 'Markdown and JSON exports unchanged in shape (limits first and last)');
}

section('4 English only, and fragment');
{
  const de = clone(op); de.lang = 'de';
  const h = R.render(de, 'html');
  ok(h === html && /<html lang="en">/.test(h) && !/Vorpr\u00fcfung|Gesamtrisiko|Rechtsstand/.test(h), 'an opinion stored with lang "de" renders exactly like the English one (no German mode)');
  const f = R.fragment(op); ok(f.startsWith('<pre class="limits">') && !/<html/.test(f), 'fragment() still returns the body without the document frame');
}

section('5 Chromium: PDF and screenshots');
let pw = null; try { pw = require('playwright'); } catch (e) { /* not installed */ }
if (args.includes('--no-browser') || !pw) console.log('  skipped (' + (pw ? '--no-browser' : 'playwright not installed') + ')');
else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fto-report-'));
  const file = path.join(tmp, 'report.html'); fs.writeFileSync(file, html);
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
    const external = []; page.on('request', (r) => { if (!/^(file|data|about|blob):/.test(r.url())) external.push(r.url()); });
    await page.goto('file://' + file);
    ok(external.length === 0, 'rendering makes no network request', external.join(' '));
    const info = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, iw: innerWidth, bg: getComputedStyle(document.body).backgroundColor, cover: getComputedStyle(document.querySelector('.cover')).backgroundImage.slice(0, 40), font: getComputedStyle(document.body).fontFamily.slice(0, 20) }));
    ok(info.w <= info.iw + 1 && /linear-gradient/.test(info.cover), 'desktop: no horizontal overflow, gradient cover', JSON.stringify(info));
    await page.screenshot({ path: path.join(tmp, 'screen-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 800 });
    const m = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(m <= 1, 'phone width 390: no horizontal page scroll', String(m));
    await page.screenshot({ path: path.join(tmp, 'screen-phone.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1000, height: 900 });
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(dark === 'rgb(23, 18, 18)', 'dark theme on screen', dark);
    await page.emulateMedia({ colorScheme: 'light', media: 'print' });
    const printBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(printBg === 'rgb(255, 255, 255)', 'print media is light', printBg);
    await page.emulateMedia({ media: null });
    const pdfPath = path.join(tmp, 'report.pdf');
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
    const pdf = fs.readFileSync(pdfPath), nPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok(pdf.slice(0, 5).toString() === '%PDF-' && nPages >= 5, 'PDF written (A4 pages: ' + nPages + ')');
    ok(/\/MediaBox\s*\[\s*0\s+0\s+59[45]\.\d+\s+841\.\d+\s*\]/.test(pdf.toString('latin1')), 'PDF page size is A4');
    console.log('  files: ' + tmp);
    if (args.includes('--write-samples')) {
      const dir = path.join(ROOT, 'docs/samples'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'fto-report-sample.html'), html); fs.copyFileSync(pdfPath, path.join(dir, 'fto-report-sample.pdf'));
      console.log('  samples written to docs/samples/');
    }
  } finally { await browser.close(); }
}
console.log('\n' + passed + ' checks passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
