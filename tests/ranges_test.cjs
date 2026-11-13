/* Engine and view tests for the range check.
   node tests/ranges_test.cjs [--no-browser] [--scratch <dir>] [--port N] [--verify-corpus]
   1. LnpRanges unit tests on a small synthetic rg-1 document (inheritance, components, statuses, profile mapping, units, quotes).
   2. The same engine against the built file data/work/xdata/ranges (sanity of the real data; optional quote check against the corpus).
   3. Playwright on a scratch dist (python3 -I pipeline/build_dist.py --out <scratch>/dist ... --limit 3000; the ranges data and the new web
      files are copied into the scratch dist and listed in its manifest by hand): view with manual values, light / dark / 390 px,
      no request leaves the origin, no console errors, window.claude absent, patent panel through a stub of LnpApp.ext.
   The scratch dist is reused when it exists. Nothing is written to dist/ or dist-pages/. */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SCRATCH = opt('--scratch', '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/T2');
let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A === B) pass++; else { fail++; console.log('  FAIL: ' + m + '\n     got      ' + A + '\n     expected ' + B); } }
function section(t) { console.log('\n== ' + t); }
function fresh() { delete require.cache[require.resolve('../web/engine/x-ranges.js')]; return require('../web/engine/x-ranges.js'); }

/* ---------------------------------------------------------------- synthetic document */
function synth() {
  const params = ['mol_pct', 'molar_ratio', 'weight_ratio', 'wt_pct', 'np_ratio', 'size_nm', 'pdi', 'pka', 'encaps_pct', 'temp_c', 'ph', 'chain_c', 'peg_mw', 'conc'].map((id) => ({ id, label: id, unit: { mol_pct: 'mol%', size_nm: 'nm', peg_mw: 'Da', conc: 'mg/mL', temp_c: 'C', wt_pct: 'wt%' }[id] || '' }));
  const pidx = {}; params.forEach((p, i) => { pidx[p.id] = i; });
  const compIds = ['ionizable_cationic', 'peg', 'sterol', 'phospholipid_helper', 'payload', 'total'];
  const R = { pi: [], claim: [], dep: [], param: [], comp: [], lo: [], hi: [], loInc: [], hiInc: [], unit: [], approx: [], q: [], off: [], ml: [] };
  function add(pi, claim, dep, param, comp, lo, hi, o) {
    o = o || {};
    R.pi.push(pi); R.claim.push(claim); R.dep.push(dep); R.param.push(pidx[param]); R.comp.push(comp); R.lo.push(lo); R.hi.push(hi);
    R.loInc.push(o.loInc === 0 ? 0 : 1); R.hiInc.push(o.hiInc === 0 ? 0 : 1); R.unit.push(o.unit != null ? o.unit : params[pidx[param]].unit); R.approx.push(o.approx ? 1 : 0);
    R.q.push(o.q || ('quote ' + param + ' ' + lo + '-' + hi)); R.off.push(o.off != null ? o.off : 10); R.ml.push(o.ml != null ? o.ml : 5);
  }
  // P1: 1 indep (ionizable 30-60, size 50-150), 2 dep 1 (ionizable 40-50), 3 dep 2 (nothing), 4 dep 1 (pH 4-5)
  add(0, 1, '', 'mol_pct', 0, 30, 60); add(0, 1, '', 'size_nm', -1, 50, 150); add(0, 2, '1', 'mol_pct', 0, 40, 50); add(0, 4, '1', 'ph', -1, 4, 5);
  // P2: 1 indep: peg 0.5-3 mol%, pdi < 0.2, ratio comp -1 mol_pct 1-10; claim 2 dep 1 inherits
  add(1, 1, '', 'mol_pct', 1, 0.5, 3); add(1, 1, '', 'pdi', -1, null, 0.2, { hiInc: 0 }); add(1, 1, '', 'mol_pct', -1, 1, 10); add(1, 1, '', 'conc', -1, 0.1, 1);
  // P3: one multi-dependent claim 3 on claims 1 and 2 (parents hold different ranges); claim 1 np 3-10, claim 2 size 80-120
  add(2, 1, '', 'np_ratio', -1, 3, 10); add(2, 1, '', 'pka', -1, 6, 6.8); add(2, 2, '', 'size_nm', -1, 80, 120);
  const chain = { 0: '2<1;3<2;4<1', 1: '2<1', 2: '3<1,2' };
  return { v: 'rg-1', params, comps: ['ionizable / cationic lipid', 'PEG lipid', 'sterol', 'phospholipid / helper lipid', 'payload / nucleic acid', 'total'], compIds, compFallback: [5], compAlias: { ionizable: 'ionizable_cationic', cationic: 'ionizable_cationic', helper: 'phospholipid_helper', peg: 'peg', sterol: 'sterol' },
    win: { lead: 40, max: 140 }, pn: ['EP1000001A1', 'US2000002B2', 'WO3000003A1'], lang: ['en', 'en', 'en'], chain, rows: R };
}
const ids = (arr) => arr.map((c) => c.pn + '/' + c.claim).sort();

async function unit() {
  section('engine, availability');
  const A = fresh();
  const s0 = await A.init();
  ok(A.available() === false && /not in this build/.test(A.reason()), 'without data: unavailable, reason "not in this build" (' + A.reason() + ')');
  ok(A.has('EP1') === false, 'has() false when unavailable');
  let rejected = false; try { await A.check([{ param: 'mol_pct', value: 5 }]); } catch (e) { rejected = /not in this build/.test(e.message); }
  ok(rejected, 'check() rejects with the reason when unavailable');

  section('engine, synthetic document');
  const E = fresh(); await E.init({ json: synth() });
  ok(E.available() && E.info().rows === 11, 'loaded 11 rows');
  ok(E.params().length === 14 && E.comps()[0].id === 'ionizable_cationic', 'params / comps');
  ok(E.has('EP1000001A1') && !E.has('EP9'), 'has()');

  let rows = await E.forClaim('EP1000001A1', 3);
  eq(rows.map((r) => [r.param, r.lo, r.hi, r.inherited, r.fromClaim]).sort(), [['mol_pct', 40, 50, true, 2], ['size_nm', 50, 150, true, 1]].sort(), 'claim 3 inherits narrower mol % of claim 2 and size of claim 1 through the chain');
  rows = await E.forClaim('EP1000001A1', 2, { own: true });
  eq(rows.map((r) => [r.param, r.inherited]), [['mol_pct', false]], 'own rows only');
  rows = await E.forClaim('EP1000001A1', 2);
  eq(rows.map((r) => [r.param, r.fromClaim, r.inherited]).sort(), [['mol_pct', 2, false], ['size_nm', 1, true]], 'own mol % shadows the parent one');
  eq(await E.forClaim('EP9', 1), [], 'unknown patent');
  rows = await E.forClaim('WO3000003A1', 3);
  eq(rows.map((r) => r.param).sort(), ['np_ratio', 'pka', 'size_nm'], 'multi-dependent claim takes the ranges of both parents');
  const pt = await E.forPatent('EP1000001A1');
  eq(pt.map((c) => [c.claim, c.indep, c.n]), [[1, true, 2], [2, false, 2], [3, false, 2], [4, false, 3]], 'forPatent claim table incl. claims without own rows');
  ok(pt[2].params.mol_pct['ionizable / cationic lipid'][0].inherited === true, 'forPatent keeps the component label and the inherited flag');
  ok(pt[0].params.size_nm.unassigned.length === 1, 'comp -1 is listed as "unassigned"');

  // check: single value
  let r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 55 }]);
  eq(ids(r.all), ['EP1000001A1/1', 'EP1000001A1/4'], 'ionizable 55 mol %: claims 1 and 4 (claim 2 / 3 narrowed to 40-50, 55 is outside)');
  ok(r.partial.length === 0 && r.counts.claimsAll === 2, 'counts');
  ok(r.all[0].values[0].status === 'inside' && r.all[0].values[0].row.q === 'quote mol_pct 30-60', 'inside value carries the quote of the deciding range');
  ok(/mol_pct|mol_pct/.test(r.all[0].values[0].paramLabel), 'param label');
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 45 }]);
  eq(ids(r.all), ['EP1000001A1/1', 'EP1000001A1/2', 'EP1000001A1/3', 'EP1000001A1/4'], 'ionizable 45 mol %: all four claims (3 inherits 40-50)');
  const c3 = r.all.filter((c) => c.claim === 3)[0];
  ok(c3.inheritedAny === true && c3.values[0].row.inherited === true && c3.values[0].row.fromClaim === 2, 'claim 3 flagged inherited, from claim 2');
  ok(c3.indep === false && r.all.filter((c) => c.claim === 1)[0].indep === true, 'indep flag');

  // all vs partial, no_range
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 55 }, { param: 'size_nm', value: 100 }]);
  eq(ids(r.all), ['EP1000001A1/1', 'EP1000001A1/4'], 'two values: claims 1 and 4 all inside');
  eq(ids(r.partial), ['EP1000001A1/2', 'EP1000001A1/3', 'WO3000003A1/2', 'WO3000003A1/3'], 'claims 2 and 3: size inside, mol % outside = partial (WO claims: size inside, mol % no range)');
  const p2 = r.partial.filter((c) => c.claim === 2 && c.pn === 'EP1000001A1')[0];
  eq(p2.values.map((v) => v.status), ['outside', 'inside'], 'per-value status outside / inside');
  ok(p2.values[0].row.lo === 40 && p2.values[0].row.hi === 50, 'outside value shows the nearest range');
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 45 }, { param: 'ph', value: 4.5 }]);
  eq(ids(r.all), ['EP1000001A1/4'], 'claim 4 has own pH and inherits mol %: all inside');
  eq(ids(r.partial), ['EP1000001A1/1', 'EP1000001A1/2', 'EP1000001A1/3'], 'claims 1, 2, 3 have mol % only (pH: no range) = partial; claim 3 descends from claim 2, not from the pH claim');
  const p1 = r.partial.filter((c) => c.claim === 1)[0];
  eq(p1.values.map((v) => v.status), ['inside', 'no_range_in_claim'], 'no_range_in_claim status');
  ok(p1.values[1].row === null, 'no row for no_range_in_claim');
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 45 }, { param: 'ph', value: 4.5 }], { mode: 'any' });
  ok(r.matches.length === 4 && r.mode === 'any', 'mode any: every claim with at least one value inside (' + r.matches.length + ')');
  r = await E.check([{ param: 'ph', value: 7 }]);
  ok(r.all.length === 0 && r.partial.length === 0, 'outside everywhere: nothing listed');

  // components
  r = await E.check([{ param: 'mol_pct', comp: 'peg', value: 1 }]);
  eq(ids(r.all), ['US2000002B2/1', 'US2000002B2/2'], 'peg 1 mol %: the claim with a peg range and its dependent claim, not the ionizable ones');
  r = await E.check([{ param: 'mol_pct', comp: 'peg', value: 5 }]);
  eq(ids(r.all), [], 'peg 5 mol %: the claim states a peg range (0.5-3); the unassigned 1-10 range is not used when a range for the component exists');
  r = await E.check([{ param: 'mol_pct', comp: 'sterol', value: 5 }]);
  eq(ids(r.all), ['US2000002B2/1', 'US2000002B2/2'], 'sterol 5 mol %, default: the unassigned 1-10 range (comp -1) is compared when the component has no range (contract)');
  eq(r.all[0].values[0].row.compLabel, '', 'the unassigned range is shown as such');
  ok(r.all[0].values[0].compUnknown === true && r.all[0].values[0].status === 'inside', 'and it is flagged compUnknown, not "no range"');
  r = await E.check([{ param: 'mol_pct', comp: 'sterol', value: 5 }], { strict: true });
  eq(ids(r.all), [], 'sterol 5 mol %, strict: ranges of unknown component are not used');
  r = await E.check([{ param: 'mol_pct', comp: 'peg', value: 5 }]);
  eq(ids(r.all), [], 'peg 5 mol %: a range for the component exists (0.5-3), so the unassigned one is not used');
  ok(!r.partial.length, 'peg 5 mol %: nothing partial');
  r = await E.check([{ param: 'mol_pct', comp: 'sterol', value: 50 }]);
  eq(ids(r.all), [], 'sterol 50: outside the unassigned 1-10 range, other components do not count');
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 45 }, { param: 'size_nm', value: 100 }]);
  ok(ids(r.all).indexOf('EP1000001A1/1') >= 0 && !r.all.some((c) => c.pn === 'EP1000001A1' && c.values[0].compUnknown), 'ionizable 45: exact ranges are used, no unknown flag');
  r = await E.check([{ param: 'mol_pct', value: 45 }]);
  eq(ids(r.all), ['EP1000001A1/1', 'EP1000001A1/2', 'EP1000001A1/3', 'EP1000001A1/4'], 'no component given: any component');
  r = await E.check([{ param: 'mol_pct', comp: 'PEG lipid', value: 1 }]);
  eq(ids(r.all), ['US2000002B2/1', 'US2000002B2/2'], 'component by label');

  // inclusivity, open range, approx, units
  r = await E.check([{ param: 'pdi', value: 0.2 }]);
  eq(ids(r.all), [], 'pdi < 0.2: 0.2 is outside (open end)');
  r = await E.check([{ param: 'pdi', value: 0.19999 }]);
  eq(ids(r.all), ['US2000002B2/1', 'US2000002B2/2'], 'pdi < 0.2: 0.19999 inside');
  r = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 60 }]);
  ok(ids(r.all).includes('EP1000001A1/1'), 'upper bound inclusive');
  r = await E.check([{ param: 'conc', value: 0.5, unit: 'mg/mL' }]);
  eq(ids(r.all), ['US2000002B2/1', 'US2000002B2/2'], 'conc 0.5 mg/mL inside 0.1-1 mg/mL');
  r = await E.check([{ param: 'conc', value: 0.5, unit: 'ug/mL' }]);
  eq(ids(r.all), [], 'a value in another unit is not compared with the range (no silent conversion)');
  r = await E.check([{ param: 'conc', value: 0.5, unit: 'mM' }]);
  eq(ids(r.all), [], 'value in mM does not match a mg/mL range');
  r = await E.check([{ param: 'nope', value: 1 }, { param: 'mol_pct', value: 'x' }]);
  eq(r.skipped.length, 2, 'unknown parameter and non-numeric value are skipped, not guessed');
  r = await E.check([{ param: 'size_nm', value: 100 }], { pns: ['WO3000003A1'] });
  eq(ids(r.all), ['WO3000003A1/2', 'WO3000003A1/3'], 'restricted to one publication: claim 2 and its multi-dependent child');
  r = await E.check([{ param: 'size_nm', value: 100 }, { param: 'np_ratio', value: 5 }], { pns: ['WO3000003A1'] });
  eq(ids(r.all), ['WO3000003A1/3'], 'multi-dependent claim 3: both ranges inherited from different parents = all inside');
  ok(r.limits.length >= 5 && r.limits.some((l) => /formula images or tables/.test(l)) && r.limits.some((l) => /not legal advice/.test(l)), 'limits[] present');

  // profile
  const form = { name: 'P', lipids: [{ role: 'ionizable', molPct: 45, pka: 6.4 }, { role: 'helper', molPct: 10 }, { role: 'sterol', molPct: 38.5 }, { role: 'peg', molPct: 1.5, pegMw: 2000 }, { role: 'other', molPct: 5 }], np: 6, particle: { sizeNm: 100, pdi: 0.15, encapsulationPct: 90 }, process: { ph: 4.5, tempC: 20 } };
  const pv = E.profileValues(form);
  const byKey = {}; pv.values.forEach((v) => { byKey[v.param + '/' + (v.comp || '')] = v.value; });
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort());
  eq(sortKeys(byKey), sortKeys({ 'mol_pct/ionizable': 45, 'mol_pct/helper': 10, 'mol_pct/sterol': 38.5, 'mol_pct/peg': 1.5, 'pka/': 6.4, 'peg_mw/peg': 2000, 'np_ratio/': 6, 'size_nm/': 100, 'pdi/': 0.15, 'encaps_pct/': 90, 'ph/': 4.5, 'temp_c/': 20 }), 'profile form -> values (role other is not checked)');
  ok(pv.skipped.length === 2 && /role "other"/.test(pv.skipped[0]) && /mixing/.test(pv.skipped[1]), 'skipped notes: role other; pH and temperature are mixing conditions');
  r = await E.checkProfile({ lipids: [{ role: 'ionizable', pka: 6.5 }] });
  eq(ids(r.all), ['WO3000003A1/1', 'WO3000003A1/3'], 'profile pKa 6.5 matches a pKa range whose component is unknown (no component filter for pKa)');
  const pw = E.profileValues({ ratioBasis: 'weight', lipids: [{ role: 'sterol', molPct: 30 }] });
  ok(pw.values[0].param === 'wt_pct' && pw.values[0].unit === 'wt%' && /by weight/.test(pw.skipped[0]), 'ratioBasis weight maps to wt_pct with a note');
  r = await E.checkProfile(form);
  ok(r.mapped.length === 12 && r.partial.length + r.all.length > 0, 'checkProfile runs check on the mapped values (' + r.all.length + ' all, ' + r.partial.length + ' partial)');
  const form2 = { lipids: [{ role: 'ionizable', molPct: 25 }, { role: 'ionizable', molPct: 20 }] };
  eq(E.profileValues(form2).values[0].value, 45, 'two lipids of one role are summed (as LnpFto does)');
  r = await E.checkProfile({ lipids: [{ role: 'ionizable', molPct: 25 }, { role: 'ionizable', molPct: 20 }], particle: { sizeNm: 100 } });
  eq(ids(r.all), ['EP1000001A1/1', 'EP1000001A1/2', 'EP1000001A1/3', 'EP1000001A1/4'], 'profile: ionizable 45 + size 100 = claims 1-4 of P1');

  // quotes
  let q = await E.quote(r.all[0].values[0].row);
  ok(q.source === 'file' && q.text.startsWith('quote ') && q.start === 10 && q.len === 5, 'quote from the file: window start and match length');
  const E2 = fresh(); const d2 = synth(); d2.rows.q = undefined; delete d2.rows.q; await E2.init({ json: d2 });
  const rr = (await E2.forClaim('EP1000001A1', 1))[0];
  q = await E2.quote(rr);
  ok(q.source === 'none' && q.text === '', 'no quote and no claim text: source "none" (the view says so)');
  // quote cut from claim text through stubs
  const text = 'z'.repeat(100) + ' the nanoparticle comprises about 30 to about 60 mol % of lipid ' + 'y'.repeat(300);
  const off = text.indexOf('about 30');
  global.LnpData = { byPn: async () => 7 }; global.LnpSearch = { claims: async () => [{ n: 1, text }] };
  const d3 = synth(); delete d3.rows.q; d3.rows.off[0] = off; d3.rows.ml[0] = 26; const E3 = fresh(); await E3.init({ json: d3 });
  const r3 = (await E3.forClaim('EP1000001A1', 1)).filter((x) => x.param === 'mol_pct')[0];
  q = await E3.quote(r3);
  ok(q.source === 'claim' && q.verified === true && q.text.length <= 140 && q.text.slice(q.start, q.start + q.len) === 'about 30 to about 60 mol %', 'quote cut from the claim text, highlight = the match');
  const d4 = synth(); d4.rows.off[0] = off; d4.rows.ml[0] = 26; d4.rows.q[0] = text.slice(Math.max(0, off - 40), Math.max(0, off - 40) + 140); const E4 = fresh(); await E4.init({ json: d4 });
  const r4 = (await E4.forClaim('EP1000001A1', 1)).filter((x) => x.param === 'mol_pct')[0];
  q = await E4.quote(r4);
  ok(q.source === 'file' && q.verified === true && q.text.slice(q.start, q.start + q.len) === 'about 30 to about 60 mol %', 'file quote verified against the claim text');
  d4.rows.q[0] = 'something else entirely'; const E5 = fresh(); await E5.init({ json: d4 });
  q = await E5.quote((await E5.forClaim('EP1000001A1', 1)).filter((x) => x.param === 'mol_pct')[0]);
  ok(q.verified === false, 'a quote that differs from the claim text is reported as not verified');
  delete global.LnpData; delete global.LnpSearch;
}

/* ---------------------------------------------------------------- real data */
async function real() {
  section('engine, built data');
  const dir = path.join(ROOT, 'data/work/xdata/ranges'), file = path.join(dir, 'ranges.gz.bin');
  if (!fs.existsSync(file)) { console.log('  (skipped: ' + file + ' does not exist; run python3 -I pipeline/ranges_build.py)'); return null; }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'xdata.json'), 'utf8'));
  const sz = fs.statSync(file).size;
  ok(sz <= 3e6, 'ranges.gz.bin <= 3 MB gzip (' + (sz / 1e6).toFixed(2) + ' MB, base64 ' + (sz * 4 / 3 / 1e6).toFixed(2) + ' MB)');
  const E = fresh(); const t0 = Date.now();
  await E.init({ file });
  const ms = Date.now() - t0;
  ok(E.available(), 'built file loads (' + ms + ' ms incl. gunzip + parse)');
  const info = E.info();
  ok(info.rows > 100000 && info.patents > 5000, 'rows ' + info.rows + ', publications ' + info.patents);
  eq(info.v, 'rg-1', 'format rg-1');
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const R = doc.rows, n = R.pi.length;
  ok(Object.keys(R).sort().join() === 'approx,claim,dep,comp,hi,hiInc,lo,loInc,ml,off,param,pi,q,unit'.split(',').sort().join(), 'columns of rg-1 (+ ml)');
  let bad = 0, openBoth = 0, qs = 0;
  for (let i = 0; i < n; i++) {
    if (R.lo[i] != null && R.hi[i] != null && R.lo[i] > R.hi[i]) bad++;
    if (R.lo[i] == null && R.hi[i] == null) openBoth++;
    if (R.q[i]) { qs++; if (R.q[i].length > 160) bad++; }
    if (i && R.pi[i] < R.pi[i - 1]) bad++;
  }
  ok(bad === 0 && openBoth === 0, 'rows well formed (lo <= hi, quotes <= 160 chars, sorted by publication)');
  console.log('  info: rows ' + n + ', rows with a quote in the main file ' + qs + ', quotes dropped for ' + JSON.stringify(meta.counts.quotesDroppedFor) + ', load ' + ms + ' ms');
  // a real claim: first row with a pH or mol % in a dependent claim chain
  // (the quote is not required: as the corpus grows the builder drops more quote columns from the main file and the engine cuts them from the claim text)
  let k = -1; for (let i = 0; i < n; i++) { if (doc.params[R.param[i]].id === 'mol_pct' && R.lo[i] != null && R.hi[i] != null && R.comp[i] >= 0) { k = i; break; } }
  ok(k >= 0, 'the built file has a mol % row with both bounds and a lipid component');
  const pn = doc.pn[R.pi[k]], mid = (R.lo[k] + R.hi[k]) / 2;
  const compId = doc.compIds[R.comp[k]];
  const t1 = Date.now();
  const res = await E.check([{ param: 'mol_pct', comp: compId, value: mid }]);
  const dt = Date.now() - t1;
  ok(res.all.some((c) => c.pn === pn && c.claim === R.claim[k]), 'check() finds the claim a range was read from (' + pn + ' claim ' + R.claim[k] + ', ' + compId + ' ' + mid + ' mol %)');
  ok(res.counts.claimsAll > 0, 'check over the whole corpus: ' + res.counts.claimsAll + ' claims, ' + dt + ' ms');
  const t2 = Date.now();
  const res2 = await E.check([{ param: 'mol_pct', comp: 'ionizable', value: 50 }, { param: 'mol_pct', comp: 'peg', value: 1.5 }, { param: 'mol_pct', comp: 'sterol', value: 38.5 }, { param: 'mol_pct', comp: 'helper', value: 10 }, { param: 'np_ratio', value: 6 }, { param: 'size_nm', value: 80 }]);
  console.log('  info: 6-value check: all ' + res2.counts.claimsAll + ', partial ' + res2.counts.claimsPartial + ', ' + (Date.now() - t2) + ' ms; example top claim ' + (res2.all[0] || res2.partial[0] || {}).pn);
  const pt = await E.forPatent(pn);
  ok(pt.length > 0 && pt.every((c) => c.n > 0), 'forPatent for a real publication');
  // dependent claims: at least one claim has inherited rows
  let inh = 0; for (const pp of doc.pn.slice(0, 400)) { for (const c of await E.forPatent(pp)) { if (Object.values(c.params).some((m) => Object.values(m).some((a) => a.some((r) => r.inherited)))) inh++; } }
  ok(inh > 0, 'real data contains claims with inherited ranges (' + inh + ' in the first 400 publications)');
  // quote check against the corpus (slow): flag --verify-corpus
  if (flag('--verify-corpus')) {
    const want = new Map(); const rnd = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
    for (let j = 0; j < 3000; j++) { const i = Math.floor(rnd() * n); if (R.q[i]) { const p = doc.pn[R.pi[i]]; if (!want.has(p)) want.set(p, []); want.get(p).push(i); } }
    const rl = require('readline').createInterface({ input: fs.createReadStream(path.join(ROOT, 'data/work/corpus.jsonl.gz')).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let checked = 0, wrong = 0;
    for await (const line of rl) {
      const m = /"pn": ?"([A-Z0-9]+)"/.exec(line.slice(0, 200)); if (!m || !want.has(m[1])) continue;
      const rec = JSON.parse(line), lang = doc.lang[doc.pn.indexOf(m[1])], cl = (rec.claims[lang] || []);
      for (const i of want.get(m[1])) {
        const c = cl.find((x) => x.n === R.claim[i]); if (!c) { wrong++; continue; }
        const a = Math.max(0, R.off[i] - doc.win.lead); checked++;
        if (c.t.slice(a, a + R.q[i].length) !== R.q[i]) { wrong++; if (flag('--debug')) console.log('   wrong:', m[1], R.claim[i], R.off[i], JSON.stringify(R.q[i].slice(0, 80)), JSON.stringify(c.t.slice(a, a + 80))); }
      }
    }
    ok(checked > 100 && wrong === 0, 'quotes are verbatim claim text at the stated offset (' + checked + ' sampled, ' + wrong + ' wrong)');
  }
  return meta;
}

/* ---------------------------------------------------------------- browser */
async function browser(meta) {
  section('browser (scratch dist)');
  const DIST = path.join(SCRATCH, 'dist');
  if (!fs.existsSync(path.join(DIST, 'data/manifest.json'))) {
    console.log('  building the scratch dist (about 90 s) ...');
    cp.execFileSync('python3', ['-I', path.join(ROOT, 'pipeline/build_dist.py'), '--out', DIST, '--build-dir', path.join(SCRATCH, 'build'), '--budget-mb', '215', '--limit', '3000'], { stdio: 'inherit', cwd: ROOT });
  }
  // scratch manifest by hand: ranges data + the new web files
  const mp = path.join(DIST, 'data/manifest.json'); const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const rdir = path.join(DIST, 'data/x/ranges'); fs.mkdirSync(rdir, { recursive: true });
  const src = path.join(ROOT, 'data/work/xdata/ranges'), files = {};
  for (const f of ['ranges.gz.bin']) { const b = fs.readFileSync(path.join(src, f)); const out = man.enc === 'bin' ? f : f.replace(/\.bin$/, '.b64.txt'); fs.writeFileSync(path.join(rdir, out), man.enc === 'bin' ? b : b.toString('base64')); files[f] = b.length; }
  man.x = Object.assign({}, man.x, { ranges: { v: 'rg-1', built: meta.built, files, counts: meta.counts } });
  const webFiles = ['engine/x-ranges.js', 'app/views/ranges.js', 'app/x-ranges.css'];
  for (const f of webFiles) { const to = path.join(DIST, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'web', f), to); man.files = man.files || {}; man.files[f] = fs.statSync(to).size; }
  fs.writeFileSync(mp, JSON.stringify(man));
  console.log('  scratch manifest: enc=' + man.enc + ', x.ranges, files +' + webFiles.length);
  // a stub of the patent-panel hook is injected by the test page (the real hook comes from another task)
  const { chromium } = require('playwright');
  const { serve } = require(path.join(ROOT, 'tests/artifact_server.cjs'));
  const port = Number(opt('--port', 0)) || 8900 + Math.floor(Math.random() * 90);
  const log = [];
  const srv = await serve({ dist: DIST, port, log });
  const base = 'http://127.0.0.1:' + (srv.port || port);
  const br = await chromium.launch();
  async function session(label, o) {
    o = o || {};
    const ctx = await br.newContext({ viewport: o.viewport || { width: 1280, height: 900 }, colorScheme: o.scheme || 'light' });
    if (o.initScript) await ctx.addInitScript(o.initScript);
    const page = await ctx.newPage(); const errors = [], foreign = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('request', (r) => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) foreign.push(u); });
    return { ctx, page, errors, foreign, label };
  }
  function done(s, extraIgnore) {
    const errs = s.errors.filter((e) => !/fonts\.g|ERR_|Failed to load resource.*(fonts|gstatic)|CSP|Content Security/.test(e) && !(extraIgnore || []).some((r) => r.test(e)));
    ok(errs.length === 0, s.label + ': no console errors' + (errs.length ? ' ' + JSON.stringify(errs.slice(0, 3)) : ''));
    const fo = s.foreign.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
    ok(fo.length === 0, s.label + ': no request leaves the origin' + (fo.length ? ' ' + JSON.stringify(fo.slice(0, 3)) : ''));
  }
  const shots = path.join(SCRATCH, 'shots'); fs.mkdirSync(shots, { recursive: true });
  try {
    /* --- manual values, light, no window.claude */
    let s = await session('light desktop');
    await s.page.goto(base + '/#ranges', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-page .rg-row', { timeout: 60000 });
    ok(await s.page.evaluate(() => typeof window.claude === 'undefined'), 'window.claude is absent');
    ok(await s.page.evaluate(() => window.LnpRanges && window.LnpRanges.available()), 'LnpRanges available in the page');
    await s.page.click('button:has-text("Fill an example")');
    await s.page.waitForSelector('.rg-row input[type=text]');
    const nrows = await s.page.locator('.rg-row').count();
    ok(nrows === 5, 'example fills 5 value rows (' + nrows + ')');
    await s.page.click('button:has-text("Check claims")');
    await s.page.waitForSelector('.rg-claim, .rg-empty', { timeout: 60000 });
    const nClaims = await s.page.locator('.rg-claim').count();
    ok(nClaims > 0, 'result cards rendered (' + nClaims + ')');
    const qTxt = await s.page.locator('.rg-q mark.hit').first().textContent().catch(() => null);
    console.log('  info: first highlighted span: ' + JSON.stringify(qTxt) + '; claim cards on the first page: ' + nClaims);
    const stats = await s.page.locator('.k-stats').first().innerText();
    console.log('  info: stats: ' + stats.replace(/\s+/g, ' '));
    // textContent only: no element inside the quotes except mark and the note spans
    ok(await s.page.evaluate(() => Array.from(document.querySelectorAll('.rg-q *')).every((e) => e.tagName === 'MARK' || e.tagName === 'SPAN')), 'quotes contain only text, <mark> and note spans');
    ok(await s.page.locator('a.k-pn[href^="#patent-"]').count() > 0, 'patent links');
    ok(await s.page.locator('details.rg-limits').count() === 1, 'limits box');
    await s.page.screenshot({ path: path.join(shots, 'ranges-light.png'), fullPage: false });
    // CSV
    const dl = await Promise.all([s.page.waitForEvent('download', { timeout: 10000 }).catch(() => null), s.page.click('button:has-text("Export CSV")')]);
    ok(!!dl[0], 'CSV export triggers a download (blob link)');
    if (dl[0]) { const p = await dl[0].path(); const t = fs.readFileSync(p, 'utf8'); ok(/publication;claim;independent;verdict/.test(t) && t.split('\n').length > 2, 'CSV has a header and rows (' + t.split('\n').length + ' lines)'); }
    // invalid value
    await s.page.locator('.rg-row input[type=text]').first().fill('abc');
    await s.page.click('button:has-text("Check claims")');
    ok(await s.page.locator('.rg-row input[aria-invalid="true"]').count() === 1, 'non-numeric value is marked invalid');
    // no result: a value far outside
    await s.page.click('button:has-text("Clear")');
    await s.page.locator('.rg-row select').first().selectOption('ph');
    await s.page.locator('.rg-row input[type=text]').first().fill('13.9');
    await s.page.click('button:has-text("Check claims")');
    await s.page.waitForSelector('.rg-claim, .rg-empty', { timeout: 60000 });
    console.log('  info: pH 13.9 -> cards ' + await s.page.locator('.rg-claim').count());
    // profile route (example profile, no store entries needed)
    await s.page.goto(base + '/#ranges--pbeispiel', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-row', { timeout: 30000 });
    await s.page.waitForSelector('.rg-claim, .rg-empty', { timeout: 60000 });
    ok(await s.page.locator('.rg-row').count() >= 8, 'profile route fills the grid from the profile (' + await s.page.locator('.rg-row').count() + ' rows)');
    await s.page.screenshot({ path: path.join(shots, 'ranges-profile-light.png'), fullPage: true });
    // dark
    await s.page.emulateMedia({ colorScheme: 'dark' });
    await s.page.waitForTimeout(300);
    await s.page.screenshot({ path: path.join(shots, 'ranges-dark.png'), fullPage: false });
    done(s); await s.ctx.close();

    /* --- 390 px, dark */
    s = await session('390px dark', { viewport: { width: 390, height: 800 }, scheme: 'dark' });
    await s.page.goto(base + '/#ranges', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-page .rg-row', { timeout: 60000 });
    await s.page.click('button:has-text("Fill an example")');
    await s.page.click('button:has-text("Check claims")');
    await s.page.waitForSelector('.rg-claim, .rg-empty', { timeout: 60000 });
    const sw = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, body: document.body.scrollWidth, view: (document.getElementById('view') || {}).scrollWidth, viewC: (document.getElementById('view') || {}).clientWidth }));
    ok(sw.sw <= sw.cw + 1, '390 px: no horizontal page scroll (' + JSON.stringify(sw) + ')');
    const over = await s.page.evaluate(() => Array.from(document.querySelectorAll('.rg-page *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).map((e) => e.className || e.tagName).slice(0, 5));
    ok(over.length === 0, '390 px: nothing in the view is wider than the viewport ' + JSON.stringify(over));
    await s.page.screenshot({ path: path.join(shots, 'ranges-390-dark.png'), fullPage: false });
    await s.page.evaluate(() => window.scrollTo(0, 0));
    done(s); await s.ctx.close();

    /* --- null capabilities: claude.use() resolves null */
    s = await session('null caps', { initScript: () => { window.claude = { use: async () => null }; } });
    await s.page.goto(base + '/#ranges', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-page .rg-row', { timeout: 60000 });
    await s.page.click('button:has-text("Fill an example")');
    await s.page.click('button:has-text("Check claims")');
    await s.page.waitForSelector('.rg-claim, .rg-empty', { timeout: 60000 });
    ok(await s.page.locator('.rg-claim').count() > 0, 'null capabilities: the check works without Claude');
    done(s); await s.ctx.close();

    /* --- data missing: view says so */
    s = await session('no ranges data');
    await s.page.route('**/data/manifest.json', async (route) => { const r = await route.fetch(); const j = JSON.parse(await r.text()); delete j.x; await route.fulfill({ response: r, body: JSON.stringify(j) }); });
    await s.page.goto(base + '/#ranges', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-empty, .notice', { timeout: 60000 });
    ok(/not part of this build/.test(await s.page.locator('.rg-empty').first().innerText()), 'without data/x/ranges: "not part of this build"');
    done(s); await s.ctx.close();

    /* --- patent panel through a stub of the hook */
    s = await session('patent panel', { initScript: () => { window.__panels = []; Object.defineProperty(window, '__ext', { value: true }); } });
    await s.page.addInitScript(() => {
      // the shell of this scratch dist has no LnpApp.ext yet: define it when LnpApp appears (the real hook is built by another task)
      let app; Object.defineProperty(window, 'LnpApp', { configurable: true, get() { return app; }, set(v) { app = v; if (v && !v.ext) v.ext = { patentPanel(spec) { window.__panels.push(spec); } }; } });
    });
    await s.page.goto(base + '/#ranges', { waitUntil: 'load' });
    await s.page.waitForSelector('.rg-page .rg-row', { timeout: 60000 });
    const reg = await s.page.evaluate(() => window.__panels.map((p) => p.id + '|' + p.title));
    eq(reg, ['ranges|Numeric ranges in claims'], 'the panel is registered through LnpApp.ext.patentPanel');
    const pn = await s.page.evaluate(async () => { const R = window.LnpRanges; const pns = (await R.check([{ param: 'mol_pct', value: 50 }], { max: 5 })).all.map((c) => c.pn); return pns[0]; });
    const out = await s.page.evaluate(async (pn) => {
      const spec = window.__panels[0], el = document.createElement('div'); document.body.appendChild(el);
      const w = spec.when({ pn }); const dead = spec.render({ pn }, el, {});
      await new Promise((r) => setTimeout(r, 1500));
      const rows = el.querySelectorAll('.rg-pc').length, items = el.querySelectorAll('.rg-pc-item').length; const noPanel = spec.when({ pn: 'EP0000000A1' });
      el.querySelector('.rg-pc-item button') && el.querySelector('.rg-pc-item button').click();
      await new Promise((r) => setTimeout(r, 800));
      return { w, rows, items, noPanel, q: (el.querySelector('.rg-pc-q .rg-q') || {}).textContent || '', typeofDestroy: typeof dead };
    }, pn);
    ok(out.w === true && out.rows > 0 && out.items > 0, 'panel renders the per-claim feature table for ' + pn + ' (' + out.rows + ' claims, ' + out.items + ' ranges)');
    ok(out.noPanel === false, 'when() is false for a publication without ranges');
    ok(out.typeofDestroy === 'function', 'render returns a destroy function');
    console.log('  info: panel quote: ' + JSON.stringify(out.q.slice(0, 100)));
    done(s); await s.ctx.close();
  } finally { await br.close(); try { srv.close && srv.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  await unit();
  const meta = await real();
  if (!flag('--no-browser') && meta) await browser(meta);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
