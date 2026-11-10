#!/usr/bin/env node
/* Tests for the chemistry engine (web/engine/chem*.js) against the built shards in data/work/chem/.

   usage: node tests/chem_test.cjs [--no-browser] [--no-brute] [--json FILE]

   Part 1 (Node, engine on the main thread with injected OpenChemLib): names, exact / substructure / similarity /
     scaffold queries for the reference lipids, descriptors, depiction, compound <-> publication map against the
     exported TSV, and substructure results against an independent brute-force SSSearcher loop without pre-screen.
   Part 2 (headless Chromium via Playwright, static server with a strict CSP: no eval, no wasm, no inline script):
     the same queries in worker, blob-worker and main-thread mode, base64 shards, timings, the structure editor.
   Exit code 1 if an assertion fails. Prints a JSON summary at the end.
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const ROOT = path.resolve(__dirname, '..');
const CHEM = path.join(process.env.LNP_DATA || path.join(ROOT, 'data'), 'work', 'chem');
const ENGINE = path.join(ROOT, 'web', 'engine');
const VENDOR = path.join(ROOT, 'web', 'vendor');
const args = process.argv.slice(2);
const fails = []; let checks = 0;
function ok(cond, what) { checks++; if (!cond) { fails.push(what); console.log('  FAIL ' + what); } return !!cond; }
function log() { console.log.apply(console, arguments); }

const QUERIES = [
  { key: 'MC3', q: 'DLin-MC3-DMA' },
  { key: 'ALC-0315', q: 'ALC-0315' },
  { key: 'SM-102', q: 'SM-102' }
];
const SUBS = [
  { key: 'MC3 (whole molecule)', q: 'DLin-MC3-DMA' },
  { key: 'ALC-0315 (whole molecule)', q: 'ALC-0315' },
  { key: 'SM-102 (whole molecule)', q: 'SM-102' },
  { key: 'MC3 head: dimethylaminobutanoate', q: 'CN(C)CCCC(=O)OC' },
  { key: 'tertiary amine diester core', q: 'CC(=O)OCCN(C)CCOC(=O)C' },
  { key: 'amino-alcohol with two ester arms (SM-102 type)', q: 'OCCN(CCCCCC(=O)OC)CCCCCCCC(=O)OC' },
  { key: 'any carboxylic ester (worst case)', q: 'CC(=O)OC' },
  { key: 'trialkylamine + filter ester>=2, tertiary amine', q: 'CCN(CC)CC', filters: { ester: [2, 99], nTert: [1, 99] } }
];

async function nodePart(summary) {
  log('== Part 1: Node ==');
  const OCL = require(path.join(VENDOR, 'openchemlib-full.js'));
  const ChemFP = require(path.join(ENGINE, 'chemfp.js'));
  const Core = require(path.join(ENGINE, 'chem-worker.js'));
  const L = require(path.join(ENGINE, 'chem.js'));
  const man = JSON.parse(fs.readFileSync(path.join(CHEM, 'chem.json'), 'utf8'));
  const loader = (f) => f.endsWith('.json') ? JSON.parse(fs.readFileSync(path.join(CHEM, f), 'utf8')) : new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(CHEM, f))));
  const d = await L.init({ manifest: man, loader, core: { OCL, ChemFP, create: Core.create } });
  summary.build = { n: man.n, publications: man.nPat, links: man.nLinks, scaffolds: man.nScaf, snapshot: man.snapshot, built: man.built, stats: man.stats,
    files: Object.fromEntries(Object.entries(man.files).map(([k, v]) => [v.file, { gz: v.bytes, raw: v.raw }])) };
  // --- shard sizes ---
  let total = 0, biggest = 0;
  for (const f of man.publish) { const s = fs.statSync(path.join(CHEM, f)).size; total += s; biggest = Math.max(biggest, s); ok(/^[a-z0-9._-]+$/.test(f), 'file name charset ' + f); }
  summary.build.totalBytes = total; summary.build.biggestFile = biggest;
  ok(biggest <= 15 * 1024 * 1024, 'every chemistry file <= 15 MB'); ok(total <= 30 * 1024 * 1024, 'chemistry set <= 30 MB (' + total + ')');
  ok(d.mode === 'main' && d.n === man.n, 'init in node');
  log('  shards', JSON.stringify(summary.build.files), 'total', total);

  // --- names ---
  const names = await L.names();
  ok(names.length >= 18, 'reference names loaded');
  for (const [alias, name] of [['mc3', 'DLin-MC3-DMA'], ['ALC0315', 'ALC-0315'], ['sm 102', 'SM-102'], ['Lipid H', 'SM-102'], ['dotap', 'DOTAP'], ['1,2-dioleyloxy-N,N-dimethyl-3-aminopropane', 'DODMA'], ['PEG2000-DMG', 'DMG-PEG 2000']]) {
    const p = await L.parse(alias); ok(p.ok && p.name === name, 'name "' + alias + '" -> ' + name);
  }
  ok((await L.parse('C1CC')).ok === false, 'bad SMILES rejected');
  ok((await L.parse('no such lipid')).ok === false, 'unknown name rejected');
  const pm = await L.parse('CCCCC/C=C\\C/C=C\\CCCCCCCCC(OC(=O)CCCN(C)C)CCCCCCCC/C=C\\C/C=C\\CCCCC');
  const pn2 = await L.parse('MC3'); ok(pm.ok && pm.idcode === pn2.idcode, 'SMILES and name give the same idcode');
  const molfile = OCL.Molecule.fromSmiles(names.find((n) => n.name === 'SM-102').smiles).toMolfile();
  const pmf = await L.parse(molfile); ok(pmf.ok && pmf.kind === 'molfile' && pmf.idcode === (await L.parse('SM-102')).idcode, 'molfile input');
  const sid = await L.parse('SCHEMBL18641839'); ok(sid.ok && sid.kind === 'id', 'SCHEMBL id input');
  summary.names = names.map((n) => ({ name: n.name, role: n.role, synonyms: n.synonyms.length, c: n.c, stereoVariants: n.variants.length }));
  summary.namesNotInSet = names.filter((n) => n.c < 0 && !n.variants.length).map((n) => n.name);

  // --- exact / sim / scaffold for the three lipids ---
  summary.node = { exact: {}, sim: {}, scaffold: {}, sub: {} };
  for (const { key, q } of QUERIES) {
    const ex = await L.search({ query: q, mode: 'exact' });
    ok(ex.length >= 1 && ex[0].match === 'exact' && ex[0].sim === 1, key + ' exact hit');
    ok(ex[0].patents.length > 0 && ex[0].patents[0].pn && ex[0].patents[0].where, key + ' exact hit has publications with where-found');
    ok(ex[0].nPat === (await L.patentsOf(ex[0].c)).length, key + ' nPat equals patentsOf length');
    summary.node.exact[key] = { ms: ex.ms, total: ex.total, id: ex[0].id, nPat: ex[0].nPat, nFam: ex[0].nFam, nClaims: ex[0].nClaims, where: ex[0].where, stereoVariants: ex.filter((h) => h.match === 'stereo-variant').map((h) => h.id + ':' + h.nPat) };
    const t = Date.now(); const sm = await L.search({ query: q, mode: 'sim', limit: 50, minSim: 0.5 });
    ok(sm.length > 1 && sm[0].sim === 1 && sm[0].c === ex[0].c, key + ' similarity: itself first');
    ok(sm.every((h, i) => i === 0 || h.sim <= sm[i - 1].sim), key + ' similarity sorted');
    ok(sm.every((h) => h.sim >= 0.5), key + ' similarity respects minSim');
    summary.node.sim[key] = { ms: sm.ms, wall: Date.now() - t, above05: sm.total, top: sm.slice(1, 4).map((h) => h.id + ' ' + h.sim) };
    const sc = await L.search({ query: q, mode: 'scaffold', limit: 500 });
    ok(sc.total >= 1 && sc.some((h) => h.c === ex[0].c), key + ' scaffold group contains the lipid');
    summary.node.scaffold[key] = { total: sc.total, scaffold: sc.stats.scaffold.smiles };
  }
  // similarity must separate chain variants (the reason for the custom fingerprint)
  const s5 = await L.search({ query: 'SM-102', mode: 'sim', limit: 2000, minSim: 0.3 });
  const l5 = (await L.search({ query: 'Lipid 5', mode: 'exact' }))[0], alc = (await L.search({ query: 'ALC-0315', mode: 'exact' }))[0];
  const simOf = (c) => { const h = s5.find((x) => x.c === c); return h ? h.sim : 0; };
  ok(simOf(l5.c) > simOf(alc.c) && simOf(l5.c) < 1 && simOf(l5.c) > 0.6, 'SM-102 ~ Lipid 5 (' + simOf(l5.c) + ') > SM-102 ~ ALC-0315 (' + simOf(alc.c) + ')');
  summary.node.simPairs = { 'SM-102~Lipid 5': simOf(l5.c), 'SM-102~ALC-0315': simOf(alc.c) };

  // --- filters ---
  const f1 = await L.search({ query: 'CCN(CC)CC', mode: 'sub', limit: 20, filters: { ester: [2, 99], nTert: [1, 99], inClaims: true, head: ['hydroxyalkyl-tert-amine'] } });
  ok(f1.length > 0 && f1.every((h) => h.desc.linkers.ester >= 2 && h.desc.amines.tertiary >= 1 && h.inClaims && h.desc.head === 'hydroxyalkyl-tert-amine'), 'filters applied to substructure hits');
  const f2 = await L.search({ query: 'SM-102', mode: 'sim', limit: 30, minSim: 0.3, filters: { pns: ['WO2017049245A2'] } });
  summary.node.filterPn = { pn: 'WO2017049245A2', hits: f2.total };
  let badFilter = false; try { await L.search({ query: 'CCO', mode: 'sub', filters: { nosuch: 1 } }); } catch (e) { badFilter = e.code === 'bad_filter'; }
  ok(badFilter, 'unknown filter rejected');

  // --- descriptors ---
  const dm = await L.descriptors('MC3'), ds = await L.descriptors('SM-102'), da = await L.descriptors('ALC-0315'), dd = await L.descriptors('DOTAP'), dk = await L.descriptors('DLin-KC2-DMA');
  ok(dm.head === 'dimethylamino' && dm.amine.class === 'tertiary' && dm.links.ester === 1 && dm.tailDoubleBonds === 4 && dm.tails[0].arms.join() === '18,18' && dm.headgroup.nCarbonsToAmine === 3 && dm.formula === 'C43H79NO2', 'MC3 descriptors');
  ok(ds.head === 'hydroxyalkyl-tert-amine' && ds.links.ester === 2 && ds.nTails === 2 && ds.nChainEnds === 3 && ds.tails[0].nC === 17 && ds.tails[0].branched && ds.tails[1].nC === 11 && ds.headgroup.hasOH && ds.biodegradable, 'SM-102 descriptors');
  ok(da.links.ester === 2 && da.nChainEnds === 4 && da.tails.every((t) => t.acyl && t.nC === 16 && t.branched && t.branchPosition === 2 && t.arms.join() === '8,6'), 'ALC-0315 descriptors');
  ok(dd.head === 'quaternary' && dd.amine.class === 'quaternary' && dd.charge === 1 && dd.tails.every((t) => t.nC === 18 && t.nDoubleBonds === 1), 'DOTAP descriptors');
  ok(dk.links.ketal === 1 && dk.links.ether === 0 && dk.head === 'dimethylamino', 'KC2 descriptors');
  ok(typeof dm.logPest === 'number' && dm.scaffold.index >= 0 && dm.tails[0].smiles.length > 10, 'descriptor extras');
  summary.descriptors = { MC3: brief(dm), 'SM-102': brief(ds), 'ALC-0315': brief(da) };

  // --- depiction ---
  const svg = await L.svg('SM-102', 320, 200), svgC = await L.svg(alc.c, { w: 200, h: 120, mono: true });
  ok(svg.startsWith('<svg') && svg.includes('currentColor') && !/rgb\(0,0,0\)/.test(svg) && !/<style|<script| id=/.test(svg), 'svg themed with currentColor, no style/script/id');
  ok(svgC.includes('currentColor') && !/#[0-9a-f]{6}/.test(svgC), 'mono svg has no fixed colours');
  summary.svgBytes = svg.length;

  // --- compound <-> publication map against the exported TSV ---
  const want = new Map(); const pick = new Set();
  const compLines = fs.readFileSync(path.join(CHEM, '_in', 'compounds.tsv'), 'utf8').split('\n').filter(Boolean);
  for (let i = 0; i < compLines.length; i += Math.floor(compLines.length / 300)) pick.add(+compLines[i].split('\t')[0]);
  const pats = fs.readFileSync(path.join(CHEM, '_in', 'pats.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  for (const line of fs.readFileSync(path.join(CHEM, '_in', 'map.tsv'), 'utf8').split('\n')) { if (!line) continue; const p = line.split('\t'); if (pick.has(+p[0])) { if (!want.has(+p[0])) want.set(+p[0], new Map()); want.get(+p[0]).set(pats[+p[1]], +p[2]); } }
  let mapChecked = 0, mapBad = 0, merged = 0;
  for (const [id, m] of want) {
    const c = await L.byId(id); if (c < 0) { merged++; continue; }
    const got = await L.patentsOf(c); const gm = new Map(got.map((x) => [x.pn, (x.where.clm ? 1 : 0) | (x.where.desc ? 2 : 0) | (x.where.abs ? 4 : 0) | (x.where.ttl ? 8 : 0) | (x.where.img ? 16 : 0) | (x.where.mol ? 32 : 0)]));
    mapChecked++; for (const [pn, bits] of m) if ((gm.get(pn) & bits) !== bits) { mapBad++; break; }
    if (gm.size < m.size) mapBad++;
  }
  ok(mapChecked > 250 && mapBad === 0, 'compound -> publication map equals the source rows for ' + mapChecked + ' sampled compounds (' + merged + ' sampled ids merged into duplicates)');
  const co = await L.compoundsOf('WO2017049245A2', 300), co2 = await L.compoundsOf('WO-2017/049245 A2', 5);
  ok(co.total > 0 && co2.total === co.total, 'compoundsOf by publication number (' + co.total + ' compounds)');
  let invOk = true; for (const x of co.slice(0, 40)) { const pl = await L.patentsOf(x.c); if (!pl.some((y) => y.pn === 'WO2017049245A2')) invOk = false; }
  ok(invOk, 'publication -> compounds is the inverse of compound -> publications');
  summary.map = { sampledCompounds: mapChecked, 'WO2017049245A2': { compounds: co.total, inClaims: co.filter((x) => x.where.clm).length } };

  // --- substructure: engine vs independent brute force ---
  const idc = new TextDecoder('latin1').decode(zlib.gunzipSync(fs.readFileSync(path.join(CHEM, 'idc.gz.bin')))).split('\n');
  const mols = args.includes('--no-brute') ? null : idc; // brute force parses every idcode per query (about 8 s each)
  for (const s of SUBS) {
    let first = null, events = 0;
    const r = await L.search({ query: s.q, mode: 'sub', limit: 25, all: true, filters: s.filters, onProgress: (e) => { events++; if (e.partial && first === null) first = e.ms; } });
    const rec = { hits: r.total, ms: r.ms, firstPreviewMs: first, firstHitMs: r.stats.firstHitMs, tested: r.stats.tested, progressEvents: events };
    ok(r.all.length === r.total && r.length === Math.min(25, r.total), s.key + ': result shape');
    if (mols && !s.filters) {
      const q = OCL.Molecule.fromSmiles((await L.parse(s.q)).smiles); q.setFragment(true); const ss = new OCL.SSSearcher(); ss.setFragment(q);
      const t = Date.now(); const brute = [];
      for (let i = 0; i < mols.length; i++) { ss.setMolecule(OCL.Molecule.fromIDCode(mols[i], false)); if (ss.isFragmentInMolecule()) brute.push(i); }
      rec.bruteMs = Date.now() - t; rec.bruteHits = brute.length;
      const same = brute.length === r.all.length && brute.every((c, i) => c === r.all[i]);
      rec.identical = same; ok(same, s.key + ': pre-screened hits identical to brute force (' + r.all.length + ' vs ' + brute.length + ')');
    }
    summary.node.sub[s.key] = rec; log('  sub', s.key, JSON.stringify(rec));
  }
  // whole-molecule substructure query must contain the exact compound
  const exS = (await L.search({ query: 'SM-102', mode: 'exact' }))[0]; const subS = await L.search({ query: 'SM-102', mode: 'sub', all: true, limit: 1 });
  ok(Array.from(subS.all).includes(exS.c), 'substructure hits of SM-102 include SM-102');
  // cancel
  const ac = new AbortController(); let cancelled = false; setTimeout(() => ac.abort(), 30);
  try { await L.search({ query: 'CC(=O)OC', mode: 'sub', signal: ac.signal }); } catch (e) { cancelled = e.code === 'cancelled'; }
  ok(cancelled, 'substructure search can be cancelled');
  return summary;
}
function brief(d) { return { formula: d.formula, mw: d.mw, head: d.head, amine: d.amine, linkers: d.linkers, nTails: d.nTails, nChainEnds: d.nChainEnds, tails: d.tails.map((t) => ({ nC: t.nC, acyl: t.acyl, db: t.nDoubleBonds, branched: t.branched, pos: t.branchPosition, arms: t.arms })), headgroup: d.headgroup, logPest: d.logPest, scaffold: d.scaffold.smiles }; }

/* ---------- static checks on the shipped scripts ---------- */
function staticPart(summary) {
  log('== static checks ==');
  const res = {};
  for (const f of [path.join(ENGINE, 'chem.js'), path.join(ENGINE, 'chem-worker.js'), path.join(ENGINE, 'chemfp.js'), path.join(VENDOR, 'openchemlib-full.js')]) {
    const t = fs.readFileSync(f, 'utf8'); const name = path.basename(f);
    const code = name === 'openchemlib-full.js' ? t : t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const c = (re) => (code.match(re) || []).length;
    res[name] = { bytes: t.length, nonAscii: (t.match(/[^\x00-\x7f]/g) || []).length, eval: c(/\beval\s*\(/g), newFunction: c(/new\s+Function\b/g), functionCtor: c(/[^.\w$]Function\s*\(/g), wasm: c(/WebAssembly/g), importScripts: c(/importScripts/g), xhr: c(/XMLHttpRequest/g), fetch: c(/\bfetch\s*\(/g), stringTimer: c(/set(Timeout|Interval)\s*\(\s*['"]/g), absUrls: Array.from(new Set(code.match(/https?:\/\/[a-z0-9.\/_-]+/gi) || [])) };
    ok(res[name].nonAscii === 0, name + ' is ASCII only');
    ok(res[name].eval === 0 && res[name].newFunction === 0 && res[name].functionCtor === 0 && res[name].wasm === 0 && res[name].stringTimer === 0, name + ' has no eval / Function constructor / WebAssembly / string timers');
  }
  ok(res['openchemlib-full.js'].fetch === 0 && res['openchemlib-full.js'].xhr === 0 && res['openchemlib-full.js'].importScripts === 0, 'OpenChemLib makes no network calls');
  summary.static = res;
}

/* ---------- Part 2: Chromium ---------- */
function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.txt': 'text/plain' };
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>chem test</title></head><body style="background:#111;color:#eee">' +
    '<div id="ed" style="width:640px;height:420px;background:#fff"></div><div id="out"></div><script src="engine/chem.js"></script></body></html>';
  const log404 = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname);
    const ref = req.headers.referer || ''; const dest = req.headers['sec-fetch-dest'] || '';
    const send = (code, body, type, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' }, extra || {})); res.end(body); };
    if (p === '/page.html') {
      const blob = u.searchParams.get('csp') === 'noblob' ? '' : ' blob:';
      const csp = "default-src 'none'; script-src 'self'" + blob + "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src https://fonts.gstatic.com; connect-src 'self'; worker-src 'self'" + blob;
      return send(200, page, types['.html'], { 'Content-Security-Policy': csp });
    }
    let file = null;
    if (p.startsWith('/engine/')) file = path.join(ENGINE, p.slice(8));
    else if (p.startsWith('/vendor/')) file = path.join(VENDOR, p.slice(8));
    else if (p.startsWith('/data/chem/')) file = path.join(CHEM, p.slice(11));
    else if (p.startsWith('/b64/chem/')) {
      const name = p.slice(10);
      if (name.endsWith('.b64.txt')) { const src = path.join(CHEM, name.replace(/\.b64\.txt$/, '.bin')); if (fs.existsSync(src)) return send(200, fs.readFileSync(src).toString('base64'), types['.txt']); }
      else if (name.endsWith('.json')) file = path.join(CHEM, name);
    }
    // "nw" in the page URL: the dedicated worker script cannot be loaded as a worker (forces the blob fallback)
    if (file && /chem-worker\.js$/.test(file) && dest === 'worker' && /[?&]nw=1/.test(ref)) file = null;
    if (!file || file.includes('..') || path.basename(file).startsWith('_') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { log404.push(p); return send(404, 'not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, log404 })));
}

async function browserPart(summary) {
  log('== Part 2: Chromium ==');
  let chromium; try { chromium = require('playwright').chromium; } catch (e) { summary.browser = { skipped: 'playwright not available: ' + e.message }; ok(false, 'playwright available'); return; }
  const { srv, port, log404 } = await serve();
  const browser = await chromium.launch();
  const out = {};
  const runs = [
    { name: 'worker', url: 'page.html', init: {}, expect: 'worker', full: true },
    { name: 'blob', url: 'page.html?nw=1', init: {}, expect: 'blob' },
    { name: 'main', url: 'page.html?nw=1&csp=noblob', init: {}, expect: 'main' },
    { name: 'worker-b64', url: 'page.html', init: { base: 'b64/chem/', enc: 'b64' }, expect: 'worker', light: true },
    { name: 'worker-b64-auto', url: 'page.html', init: { base: 'b64/chem/' }, expect: 'worker', light: true }
  ];
  try {
    for (const run of runs) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } }); const page = await ctx.newPage();
      const reqs = [], errs = [];
      page.on('request', (r) => reqs.push(r.url())); page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
      await page.goto('http://127.0.0.1:' + port + '/' + run.url);
      const r = await page.evaluate(async ({ run, QUERIES, SUBS }) => {
        const L = window.LnpChem, res = { queries: {}, sub: {} };
        const t0 = performance.now(); await L.init(run.init); res.initMs = Math.round(performance.now() - t0);
        res.diag = await L.diag(); res.poolMs = Math.round(performance.now() - t0);
        if (run.light) { const h = await L.search({ query: 'SM-102', mode: 'exact' }); res.exact = h.length && h[0].id; return res; }
        for (const { key, q } of QUERIES) {
          const ex = await L.search({ query: q, mode: 'exact' }); const sm = await L.search({ query: q, mode: 'sim', limit: 50 }); const sm2 = await L.search({ query: q, mode: 'sim', limit: 50 });
          res.queries[key] = { exactMs: ex.ms, exact: ex.length ? ex[0].id : null, exactTotal: ex.total, simMs: sm.ms, simMsWarm: sm2.ms, simTotal: sm.total, simTop: sm.slice(0, 3).map((h) => h.id + ' ' + h.sim) };
        }
        for (const s of SUBS) {
          let first = null, events = 0; const t = performance.now();
          const r = await L.search({ query: s.q, mode: 'sub', limit: 25, all: true, filters: s.filters, onProgress: (e) => { events++; if (e.partial && first === null) first = Math.round(performance.now() - t); } });
          const rec = { hits: r.total, ms: r.ms, wallMs: Math.round(performance.now() - t), firstPreviewMs: first, firstHitMs: r.stats.firstHitMs, tested: r.stats.tested, workers: r.stats.workers, events: events, top: r.slice(0, 2).map((h) => h.id), hash: Array.from(r.all).reduce((a, c) => (Math.imul(a, 31) + c) >>> 0, 7) };
          if (run.full && !s.filters) { const b = await L.search({ query: s.q, mode: 'sub', limit: 1, all: true, brute: true }); rec.bruteMs = b.ms; rec.bruteIdentical = b.all.length === r.all.length && b.all.every((c, i) => c === r.all[i]); }
          res.sub[s.key] = rec;
        }
        const svg = await L.svg('ALC-0315', 300, 200); document.getElementById('out').innerHTML = svg; // OCL-generated, themed
        const el = document.querySelector('#out svg'); res.svg = { ok: !!el, currentColor: svg.includes('currentColor'), strokeComputed: el ? getComputedStyle(el.querySelector('line')).stroke : null, bytes: svg.length };
        const d = await L.descriptors('SM-102'); res.desc = d.head + '/' + d.nTails + '/' + d.links.ester;
        const co = await L.compoundsOf('WO2017049245A2', 10); res.compoundsOf = co.total;
        return res;
      }, { run, QUERIES, SUBS });
      if (run.full) {
        // structure editor: no wasm, no eval, no extra requests; programmatic API and a real mouse interaction
        const before = reqs.length;
        r.editor = await page.evaluate(async () => {
          const changes = []; const ed = await window.LnpChem.editor(document.getElementById('ed'), { smiles: 'CN(C)CCCC(=O)OC', onChange: (s) => changes.push(s.smiles) });
          window.__ed = ed; window.__changes = changes;
          const s1 = ed.getSmiles(); ed.setSmiles('OCCN(CC)CC');
          return { initial: s1, afterSet: ed.getSmiles(), molfile: ed.getMolfile().length, changes: changes.length, tags: Array.from(new Set(Array.from(document.querySelectorAll('#ed *')).map((e) => e.tagName.toLowerCase()))).join(',') };
        });
        await page.evaluate(() => window.__ed.clear());
        const box = await page.locator('#ed').boundingBox();
        await page.mouse.click(box.x + 20, box.y + 123); await page.waitForTimeout(150);            // toolbar: single bond tool
        await page.mouse.click(box.x + 300, box.y + 220); await page.waitForTimeout(150);           // new bond in the empty canvas
        await page.mouse.click(box.x + 20, box.y + 272); await page.waitForTimeout(150);            // toolbar: N
        await page.mouse.click(box.x + 300, box.y + 220); await page.waitForTimeout(300);           // turn the first atom into nitrogen
        r.editor.drawn = await page.evaluate(() => ({ smiles: window.__ed.getSmiles(), changes: window.__changes.length }));
        r.editor.search = await page.evaluate(async () => { window.__ed.setSmiles('CN(C)CCCC(=O)OC'); const h = await window.LnpChem.search({ query: { molfile: window.__ed.getMolfile() }, mode: 'sub', limit: 3 }); return h.total; });
        r.editor.extraRequests = reqs.slice(before).map((x) => x.replace('http://127.0.0.1:' + port, ''));
        await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'lnp-chem-editor.png') });
      }
      r.external = reqs.filter((x) => !x.startsWith('http://127.0.0.1:' + port + '/') && !x.startsWith('blob:http://127.0.0.1:' + port + '/'));
      r.requests = reqs.length; r.errors = errs;
      out[run.name] = r;
      ok(r.diag.mode === run.expect, run.name + ': engine mode is ' + run.expect + ' (got ' + r.diag.mode + ')');
      ok(r.external.length === 0, run.name + ': no request leaves the origin');
      // expected noise: the blocked worker script (blob, main), the blocked blob worker (main), the .bin probes (b64 auto)
      const allow = { blob: /404|Failed to load resource/, main: /404|Failed to load resource|Content Security Policy/, 'worker-b64-auto': /404|Failed to load resource/ }[run.name];
      const unexpected = errs.filter((e) => !(allow && allow.test(e)));
      ok(unexpected.length === 0, run.name + ': no console errors (' + unexpected.slice(0, 2).join(' | ') + ')');
      log('  ' + run.name, 'init', r.initMs, 'ms, mode', r.diag.mode, 'workers', r.diag.workers, JSON.stringify(r.diag.ms));
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  summary.browser = out; summary.browser404 = Array.from(new Set(log404));
  // cross checks and the performance targets (worker mode)
  const w = out.worker, n = summary.node;
  if (w && n) {
    for (const s of SUBS) {
      const a = w.sub[s.key], b = n.sub[s.key];
      ok(a.hits === b.hits, 'browser and node agree on "' + s.key + '" (' + a.hits + ' vs ' + b.hits + ')');
      if (a.bruteIdentical !== undefined) ok(a.bruteIdentical, 'browser: "' + s.key + '" identical to brute force');
      ok(a.wallMs < 6000, 'worker mode: all results of "' + s.key + '" in < 6 s (' + a.wallMs + ' ms)');
      ok(a.hits === 0 || (a.firstPreviewMs !== null && a.firstPreviewMs < 1500), 'worker mode: first results of "' + s.key + '" in < 1.5 s (' + a.firstPreviewMs + ' ms)');
      for (const m of ['blob', 'main']) if (out[m]) ok(out[m].sub[s.key].hash === a.hash, m + ' mode gives the same hits for "' + s.key + '"');
    }
    for (const { key } of QUERIES) {
      ok(w.queries[key].simMs < 500 && w.queries[key].simMsWarm < 500, 'worker mode: similarity for ' + key + ' < 500 ms (' + w.queries[key].simMs + '/' + w.queries[key].simMsWarm + ')');
      ok(w.queries[key].exact === n.exact[key].id, 'browser and node agree on the exact hit for ' + key);
    }
    ok(w.editor && w.editor.initial && w.editor.afterSet && w.editor.changes >= 1, 'editor: programmatic API works');
    ok(w.editor && w.editor.extraRequests.every((x) => /openchemlib-full\.js$/.test(x)), 'editor: only OpenChemLib itself is requested');
    ok(w.editor && w.editor.drawn.smiles.length > 0, 'editor: drawing with the mouse produced a structure (' + (w.editor && w.editor.drawn.smiles) + ')');
    ok(w.svg.ok && w.svg.currentColor && /238/.test(w.svg.strokeComputed || ''), 'svg follows the page colour (computed stroke ' + w.svg.strokeComputed + ')');
    ok(out['worker-b64'] && out['worker-b64'].exact === n.exact['SM-102'].id, 'base64 shards work (enc given)');
    ok(out['worker-b64-auto'] && out['worker-b64-auto'].exact === n.exact['SM-102'].id, 'base64 shards work (found by fallback)');
  }
}

(async () => {
  const summary = {};
  if (!fs.existsSync(path.join(CHEM, 'chem.json'))) { console.error('no chemistry build in ' + CHEM + ' - run: node pipeline/chem_build.cjs'); process.exit(2); }
  staticPart(summary);
  await nodePart(summary);
  if (!args.includes('--no-browser')) await browserPart(summary);
  summary.checks = checks; summary.failed = fails;
  const j = args.indexOf('--json'); if (j >= 0 && args[j + 1]) fs.writeFileSync(args[j + 1], JSON.stringify(summary, null, 1));
  log('\n== summary ==\n' + JSON.stringify(summary, null, 1));
  log('\n' + checks + ' checks, ' + fails.length + ' failed');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
