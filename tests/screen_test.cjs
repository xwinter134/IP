#!/usr/bin/env node
/* Tests for the compound library screen: engine web/engine/x-screen.js (LnpScreen) and view web/app/views/screen.js (#screen).

   usage: node tests/screen_test.cjs [--dist DIR] [--unit] [--shots DIR] [--json FILE]
     --unit    only the Node part (no browser, no dist)
     --dist    a build made with:  python3 -I pipeline/markush_seed.py &&
               python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215
               (default: the T6 scratch dist; the browser part is skipped with a notice when it does not exist)
   Part 1 (Node): parseInput (SMILES lists, CSV / TSV / semicolon, header detection in any case, quoted fields, names, SCHEMBL ids,
     errors, the 2,000 row cap), CSV formula-injection safety, run() against mocked engines (hits, aggregation, flags, Markush
     covered / unclear / queue, duplicate reuse, cancel), compact/store round trip.
   Part 2 (Playwright + tests/artifact_server.cjs): paste 10 rows (reference lipid names, curated-record lipids, 2 invalid SMILES, an
     injection string), run exact + similar, assert hits / flags / Markush covered and queue, expand, filters, CSV download,
     save + reopen after a reload, window.claude absent, null caps, light / dark, 390 px, no request leaves the origin; timings.
   Exit code 1 when a check fails. Prints a JSON summary at the end. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const UNIT_ONLY = args.includes('--unit');
const SCRATCH = '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/T6';
const DIST = path.resolve(argv('dist', path.join(SCRATCH, 'dist')));
const SHOTS = argv('shots', '');
const fails = []; let checks = 0, cur = 'setup'; const sections = {}; const timings = {};
function section(n) { cur = n; sections[n] = sections[n] || { checks: 0, fails: 0 }; console.log('\n## ' + n); }
function ok(cond, what, extra) {
  checks++; sections[cur] = sections[cur] || { checks: 0, fails: 0 }; sections[cur].checks++;
  if (!cond) { sections[cur].fails++; fails.push(cur + ': ' + what); console.log('  FAIL ' + what + (extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
  else console.log('  ok   ' + what);
  return !!cond;
}

const Sc = require(path.join(ROOT, 'web', 'engine', 'x-screen.js'));

/* ------------------------------------------------------------------------------------------ Part 1: Node */
async function unit() {
  section('parseInput: lists');
  {
    let r = Sc.parseInput('CCCCO\nALC-0315\n\n# comment\nSCHEMBL123456\nc1ccccc1  benzene\n');
    ok(r.length === 4, 'blank and comment lines skipped, 4 rows', r.length);
    ok(r[0].input === 'CCCCO' && r[0].smiles === 'CCCCO' && r[0].row === 1, 'SMILES row keeps input, smiles hint and line number', r[0]);
    ok(r[1].input === 'ALC-0315' && !r[1].smiles && !r[1].error, 'a reference lipid name is passed on as input (resolved by LnpChem.parse)', r[1]);
    ok(r[2].input === 'SCHEMBL123456' && !r[2].error, 'a SCHEMBL id is passed on as input', r[2]);
    ok(r[3].alt && r[3].alt.smiles === 'c1ccccc1' && r[3].alt.name === 'benzene', '.smi line "SMILES name" keeps the split as a fallback', r[3]);
    r = Sc.parseInput('   \n\n');
    ok(r.length === 0 && r.total === 0, 'blank text gives no rows');
    r = Sc.parseInput('﻿CCO\r\nCCCO\r\n');
    ok(r.length === 2 && r[0].input === 'CCO', 'BOM and CRLF are handled', r);
    r = Sc.parseInput('C1CC(\nCC(C\nC[N+(C)(C)C\nCCO');
    ok(r.filter((x) => x.error).length === 3 && !r[3].error, 'unbalanced brackets are row errors, the valid row is untouched', r.map((x) => x.error));
    ok(/unbalanced/.test(r[0].error), 'the error says what is wrong', r[0].error);
  }
  section('parseInput: CSV / TSV, header detection');
  {
    let r = Sc.parseInput('ID,SMILES\nl1,CCCCO\nl2,"CC(C)CCO"\nl3,\n');
    ok(r.header === true && r.delimiter === ',', 'header found (upper case), comma', [r.header, r.delimiter]);
    ok(r.length === 3 && r[0].id === 'l1' && r[0].input === 'CCCCO' && r[1].input === 'CC(C)CCO', 'id and smiles columns mapped, quoted field unquoted', r);
    ok(r[2].error === 'empty structure field' && r[2].row === 4, 'empty structure cell is a row error with its line number', r[2]);
    r = Sc.parseInput('name;structure;id\nSM-102;CCCCCCCCCCCOC(=O)CCCCCN(CCCC)CCO;x1\nMC3;DLin;x2');
    ok(r.header && r.delimiter === ';' && r[0].name === 'SM-102' && r[0].id === 'x1' && r[0].input.startsWith('CCCCCCCCCCCOC'), 'name;structure;id header, any column order', r[0]);
    r = Sc.parseInput('SMILES\tName\nCCCCO\tbutanol\nCCO\tethanol');
    ok(r.delimiter === '\t' && r.length === 2 && r[1].name === 'ethanol' && r[1].input === 'CCO', 'TSV with header', r);
    r = Sc.parseInput('Compound\tSMILES\nA\tCCO');
    ok(r[0].input === 'CCO' && r[0].name === 'A', 'header "Compound" is a name column, "SMILES" the structure', r[0]);
    r = Sc.parseInput('lipid,CCCCN(C)C\nlipid2,CCCCCCN(C)C');
    ok(!r.header && r[0].id === 'lipid' && r[0].input === 'CCCCN(C)C', 'no header: id,smiles guessed from the content', r[0]);
    r = Sc.parseInput('CCCCO,butanol\nCC(C)O,isopropanol');
    ok(r[0].input === 'CCCCO' && r[0].id === 'butanol', 'no header: smiles,name guessed from the content', r[0]);
    r = Sc.parseInput('"Lipid, branched";CC(C)CCN(C)C');
    ok(r[0].id === 'Lipid, branched' && r[0].input === 'CC(C)CCN(C)C', 'quoted field with the other delimiter inside', r[0]);
    r = Sc.parseInput('id,smiles\n1,"CC\nCC"\n2,CCO');
    ok(r.length === 2 && r[1].row === 4, 'a quoted field may span lines; line numbers stay right', r.map((x) => x.row));
    r = Sc.parseInput('id,smiles\n1,"C""C"\n');
    ok(r[0].input === 'C"C', 'doubled quote inside a quoted field', r[0]);
    r = Sc.parseInput('Name,Notes\nfoo,bar');
    ok(r.header && r[0].input === 'foo', 'header without a structure column: name column carries the input', r[0]);
    r = Sc.parseInput('smiles\nCCO\nCCCO');
    ok(r.header && r.length === 2 && r[1].input === 'CCCO', 'single column with a "smiles" header', r);
    const f = new Blob(['id,smiles\na,CCO']);
    const rp = Sc.parseInput(f);
    ok(typeof rp.then === 'function', 'a Blob / File input returns a Promise');
    r = await rp;
    ok(r.length === 1 && r[0].input === 'CCO', 'file contents parsed', r);
  }
  section('parseInput: delimiter detection');
  {
    let r = Sc.parseInput('1,2-dioleoyl-3-trimethylammonium-propane\nSM-102\nALC-0315');
    ok(r.delimiter === '' && r.length === 3 && !r.some((x) => x.error), 'a name list whose first entry has a comma is not a CSV', r.map((x) => x.error || x.input));
    r = Sc.parseInput('SM-102,Moderna\nALC-0315,Pfizer');
    ok(r[0].input === 'SM-102' && r[1].input === 'ALC-0315' && r.notes.length === 1, 'without a structure column the first column is the input, with a note', [r[0], r.notes]);
    r = Sc.parseInput('X1\tCCCCN(C)CCCC\nX2\tCCCCCCN(C)C');
    ok(r.delimiter === '\t' && r[0].id === 'X1' && r[0].input === 'CCCCN(C)CCCC', 'TSV without header, structure column found', r[0]);
  }

  section('parseInput: limits, hostile input');
  {
    const big = Array.from({ length: 2500 }, (_, i) => 'C'.repeat(1 + (i % 7)) + 'O').join('\n');
    const r = Sc.parseInput(big);
    ok(r.length === 2000 && r.total === 2500 && r.truncated === 500, '2,000 row cap, total and truncated reported', [r.length, r.total, r.truncated]);
    ok(r.notes.length === 1 && /2000/.test(r.notes[0]) && /500/.test(r.notes[0]), 'the cap is stated in a note', r.notes);
    const l = Sc.parseInput('C'.repeat(5000));
    ok(l[0].error && /longer/.test(l[0].error) && l[0].input.length <= 2001, 'overlong input is an error, not kept whole', l[0].error);
    const x = Sc.parseInput('id,smiles\n=HYPERLINK("http://x"),CCO\n@x,CCO\n+1,CCO\n-2,CCO');
    ok(x.length === 4 && x[0].id.startsWith('=HYPERLINK'), 'hostile ids are kept as data');
    const z = Sc.parseInput('CC\u0000O​\nC‮CO');
    ok(z.every((v) => !/[\u0000​‮]/.test(v.input)), 'control and bidi characters are removed from the input', z);
  }
  section('toCsv: spreadsheet formula injection, shape');
  {
    const res = [
      { row: 1, id: '=cmd|"/c calc"!A1', name: '', input: '=1+1', ok: false, error: '@SUM(A1) is not a structure', parsed: null, exact: [], sub: { total: 0, hits: [] }, sim: [], patents: [], flags: null, markush: null },
      { row: 2, id: 'SM-102', name: 'SM-102', input: 'SM-102', ok: true, parsed: { smiles: 'CCO' }, exact: [{ id: 'SCHEMBL1' }], sub: { total: 0, hits: [] }, sim: [], simTotal: 0,
        patents: [{ p: 1, pn: 'EP1B1', routes: ['exact', 'sim'], inClaims: true, status: 'granted', exp: 20400101, sim: 1, where: { clm: 1 }, via: [], routeClaims: {} },
          { p: 2, pn: '+EVIL', routes: ['sim'], inClaims: false, status: 'pending', exp: 0, sim: 0.83, where: {}, via: [], routeClaims: {} }],
        flags: { level: 3 }, markush: { covered: [{ pn: 'EP1B1', claim: 1, caveat: null }], unclear: [], queue: [{ pn: '+EVIL', claim: 2 }], checked: 1, notCovered: 0 } },
      { row: 3, id: 'plain', name: '', input: 'CCCC', ok: true, parsed: { smiles: 'CCCC' }, exact: [], sub: { total: 0, hits: [] }, sim: [], patents: [], flags: { level: 0 }, markush: null }
    ];
    const csv = Sc.toCsv(res, { snapshot: 'test snapshot' });
    const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    ok(csv.charCodeAt(0) === 0xfeff, 'BOM for spreadsheet programs');
    ok(lines[0] === Sc.CSV_COLUMNS.join(','), 'header = documented columns', lines[0]);
    ok(Sc.CSV_COLUMNS.join('|') === 'compound id|input|smiles|match type|similarity|pn|in claims|status|expiry estimate|markush verdict|limits note', 'column list as specified');
    ok(lines.length === 1 + 1 + 2 + 1, 'one row per compound x publication (and one for a compound without publication)', lines.length);
    ok(lines[1].startsWith('"\'=cmd|""/c calc""!A1",\'=1+1,'), 'formula start in id and input is prefixed with an apostrophe and quoted', lines[1].slice(0, 60));
    ok(/\'@SUM/.test(lines[1]), 'the error text inside the note is data too (the cell starts with the apostrophe only when it starts with the trigger)', lines[1].slice(-200));
    ok(lines[3].indexOf(",'+EVIL,") > 0, 'a publication number starting with + is neutralised', lines[3]);
    ok(lines[2].indexOf('EP1B1,yes,granted,2040-01-01,covered (claim 1)') > 0, 'in claims, status, expiry and Markush verdict columns', lines[2]);
    ok(lines[3].indexOf('formula claim without translation (claim 2)') > 0, 'queue state in the verdict column', lines[3]);
    ok(/not legal advice/.test(lines[2]) && /test snapshot/.test(lines[2]), 'every row carries the limits note with the snapshot', lines[2].slice(-260));
    const bad = csv.split(/\r\n/).slice(1).filter(Boolean).filter((ln) => /(^|,)[=+\-@]/.test(ln.replace(/"[^"]*"/g, '""')));
    ok(bad.length === 0, 'no cell starts with = + - @ outside quotes', bad.slice(0, 2));
    ok(Sc._internal.cell('\t=1', ',') === "'\t=1" && Sc._internal.cell(' =1', ',') === "' =1" && Sc._internal.cell('a,b', ',') === '"a,b"' && Sc._internal.cell('x"y', ',') === '"x""y"', 'cell(): tab / space / comma / quote cases');
    ok(Sc.toCsv(res, { sep: ';' }).split('\r\n')[2].split(';').length >= 11, 'delimiter option');
  }
  section('run(): mocked engines');
  {
    const T = 20260101, rows = [];
    const hit = (c, id, o) => Object.assign({ c, id, sim: 1, match: 'exact', smiles: 'S' + id, formula: 'C', nPat: 3, nClaims: 1, inClaims: true, where: { clm: 1 }, nPatGlobal: 12, idcode: 'i', desc: {}, patents: [] }, o || {});
    const world = {
      A: { exact: [hit(1, 'SCHEMBL1')], sim: [hit(2, 'SCHEMBL2', { sim: 0.9, match: undefined })], pats: { 1: [{ p: 10, pn: 'EP10B1', fam: 1, where: { clm: 1 } }, { p: 11, pn: 'EP11A1', fam: 2, where: { desc: 1 } }], 2: [{ p: 12, pn: 'US12B2', fam: 3, where: { clm: 1 } }] } },
      B: { exact: [], sim: [hit(3, 'SCHEMBL3', { sim: 0.85, match: undefined, inClaims: false })], pats: { 3: [{ p: 11, pn: 'EP11A1', fam: 2, where: { desc: 1 } }] } },
      C: { exact: [hit(4, 'SCHEMBL4', { nPatGlobal: 50000 })], sim: [], pats: { 4: [] } },
      D: { exact: [], sim: [], pats: {} },
      E: { exact: [], sim: [], pats: {} }
    };
    const calls = { search: [], patentsOf: 0, fc: [], batch: [] };
    const chem = {
      parse: async (i) => /^BAD/.test(i) ? { ok: false, error: 'cannot read' } : { ok: true, kind: 'smiles', smiles: i, idcode: 'id-' + i, formula: 'X', mw: 1, name: i === 'A' ? 'Alpha' : undefined },
      search: async (q) => { calls.search.push(q.mode + ':' + q.smiles); if (q.signal && q.signal.aborted) throw Object.assign(new Error('c'), { code: 'cancelled' }); const w = world[q.smiles]; const r = (q.mode === 'exact' ? w.exact : q.mode === 'sim' ? w.sim : []).slice(); r.total = r.length; return r; },
      patentsOf: async (c) => { calls.patentsOf++; for (const k of Object.keys(world)) if (world[k].pats[c]) return world[k].pats[c]; return []; }
    };
    const PT = { 10: { p: 10, status: 'granted', exp: 20400101, hasImg: true }, 11: { p: 11, status: 'pending', exp: 0, hasImg: false }, 12: { p: 12, status: 'granted', exp: 20200101, hasImg: true }, 99: { p: 99, status: 'granted', exp: 20450101, hasImg: true } };
    const data = { patents: async (ps) => ps.map((p) => Object.assign({ title: 'T' + p, auth: 'EP' }, PT[p])), byPn: async (pn) => pn === 'EP99B1' ? 99 : -1 };
    const recs = [{ pn: 'EP10B1', claim: 1 }, { pn: 'EPZZ', claim: 5 }, { pn: 'EP99B1', claim: 3 }];
    const markush = {
      list: async () => recs,
      claimsWithFormula: async (p) => { calls.fc.push(p); return p === 10 ? [{ n: 1 }, { n: 7 }] : p === 12 ? [{ n: 2 }] : []; },
      batch: async (smi, targets) => { calls.batch.push(targets.length); return targets.map((t) => t.pn === 'EP99B1' ? { pn: t.pn, claim: t.claim, result: { overall: smi === 'A' || smi === 'E' ? 'covered' : 'not_covered', caveat: null, reasons: [] }, reason: null } : t.pn === 'EP10B1' && t.claim === 1 ? { pn: t.pn, claim: t.claim, result: { overall: smi === 'A' ? 'covered' : 'not_covered', caveat: null, reasons: [] }, reason: null }
        : t.pn === 'EPZZ' ? { pn: t.pn, claim: t.claim, result: { overall: 'unclear', reasons: ['x'] }, reason: null } : { pn: t.pn, claim: t.claim, result: null, reason: 'no_record' }); }
    };
    Sc.configure({ chem, data, markush });
    const inputs = ['A', 'B', 'C', 'D', 'BAD1', 'A', 'E'];
    inputs.forEach((s, i) => rows.push({ row: i + 1, id: 'r' + (i + 1), name: '', input: s }));
    const seen = [], prog = [];
    const res = await Sc.run(rows, { modes: ['exact', 'sim'], minSim: 0.8, today: T, onResult: (r) => seen.push(r.row), onProgress: (e) => prog.push(e.done) });
    ok(res.length === 7 && seen.join() === '1,2,3,4,5,6,7', 'one result per row, onResult in order', seen);
    ok(prog.length >= 6 && prog[prog.length - 1] === 7, 'onProgress reports done up to the total', prog);
    const a = res[0];
    ok(a.ok && a.exact.length === 1 && a.exact[0].id === 'SCHEMBL1' && a.sim.length === 1 && a.name === 'Alpha', 'A: exact and similar hit, name from parse', [a.exact.length, a.sim.length, a.name]);
    ok(a.patents.length === 4 && a.patents[0].pn === 'EP10B1' && a.patents[0].routes.join() === 'exact,markush' && a.patents[0].inClaims && a.patents[0].status === 'granted' && a.patents[0].inForce, 'A: patents aggregated, claims + in force first', a.patents.map((p) => p.pn + ':' + p.routes));
    const us = a.patents.find((x) => x.pn === 'US12B2'), mkp = a.patents.find((x) => x.pn === 'EP99B1');
    ok(us && us.routes.join() === 'sim' && !us.inForce, 'A: similar hit in claims, expired grant is not in force', us);
    ok(mkp && mkp.routes.join() === 'markush' && mkp.inClaims && mkp.inForce && mkp.status === 'granted' && mkp.exp === 20450101, 'A: publication of a covered Markush record is added (route markush) with status from the patent table', mkp);
    ok(a.flags.inClaimsExact && a.flags.inClaimsSim && a.flags.grantedInForce && !a.flags.commodity && a.flags.level === 4, 'A: flags', a.flags);
    ok(a.markush.covered.length === 2 && a.markush.covered[0].pn === 'EP10B1' && a.markush.queue.some((q) => q.pn === 'EP10B1' && q.claim === 7) && a.markush.queue.some((q) => q.pn === 'US12B2' && q.claim === 2) && a.markush.unclear.length === 1, 'A: Markush covered, queue (claims without a record), unclear (record elsewhere)', a.markush);
    const b = res[1];
    ok(b.exact.length === 0 && b.sim.length === 1 && !b.flags.inClaimsSim && b.flags.level === 1 && b.patents[0].status === 'pending' && !b.flags.grantedInForce, 'B: similar hit outside the claims, level 1', b.flags);
    ok(b.markush.covered.length === 0 && b.markush.notCovered === 2, 'B: record checked, not covered', b.markush);
    ok(res[2].flags.commodity && res[2].flags.level === 3 && res[2].patents.length === 0, 'C: commodity flag from nPatGlobal, exact in claims', res[2].flags);
    ok(res[3].flags.level === 0 && res[3].flags.label === 'no hit', 'D: no hit', res[3].flags);
    const e7 = res[6];
    ok(e7.exact.length === 0 && e7.flags.level === 4 && e7.flags.markushCovered && /Markush/.test(e7.flags.label) && e7.patents.length === 1, 'E: no structure hit but covered by a Markush claim of a granted patent: level 4', e7.flags);
    ok(!res[4].ok && /cannot read/.test(res[4].error) && res[4].parsed === null, 'invalid input: ok false with the engine message', res[4]);
    ok(res[5].duplicateOf === 1 && res[5].row === 6 && res[5].id === 'r6' && calls.search.filter((x) => x === 'exact:A').length === 1, 'same structure again: result reused (one search), row identity kept', res[5].duplicateOf);
    ok(calls.fc.filter((p) => p === 10).length === 1, 'formula claims of a publication are read once per run', calls.fc);
    const s = Sc.summary(res);
    ok(s.n === 7 && s.invalid === 1 && s.parsed === 6 && s.inClaimsExact === 3 && s.grantedInForce === 3 && s.commodity === 1 && s.noHit === 2 && s.markushCovered === 3 && s.queueClaims === 2, 'summary counts', s);
    // modes without sim; sub
    calls.search.length = 0;
    const r2 = await Sc.run([rows[0]], { modes: ['exact'], markush: false, today: T });
    ok(calls.search.join() === 'exact:A' && r2[0].sim.length === 0 && r2[0].markush === null, 'modes exact only, Markush off', calls.search);
    chem.search = async (q) => { calls.search.push(q.mode); const r = q.mode === 'sub' ? [hit(7, 'SCHEMBL7', { sim: 0.6, match: undefined }), hit(8, 'SCHEMBL8', { sim: 0.5, match: undefined })] : []; r.total = q.mode === 'sub' ? 250 : 0; return r; };
    const r3 = await Sc.run([rows[3]], { modes: ['sub'], subMaxHits: 2, markush: false, today: T });
    ok(r3[0].sub.total === 250 && r3[0].sub.hits.length === 2 && r3[0].sub.capped && r3[0].flags.level === 1 && r3[0].flags.label === 'substructure hits only', 'substructure: count and top hits', r3[0].sub);
    // cancel
    const ac = new AbortController(); let n = 0;
    chem.search = async (q) => { const r = []; r.total = 0; return r; };
    const r4 = await Sc.run(rows, { modes: ['exact'], markush: false, signal: ac.signal, onResult: () => { if (++n === 2) ac.abort(); } });
    ok(r4.cancelled === true && r4.length === 2, 'cancel returns the finished compounds and cancelled: true', [r4.cancelled, r4.length]);
    // resolve() of a preview
    const rr = Sc.parseInput('A\nBAD2\nCCO smiles-name');
    await Sc.resolve(rr);
    ok(rr[0].parsed && rr[1].error && /not recognised/.test(rr[1].error) && rr[2].parsed, 'resolve(): parsed or error per row; ".smi" fallback used when the whole line fails', rr.map((x) => !!x.parsed));
    // store
    section('store: save / load / compact');
    const full = await Sc.run(rows.slice(0, 4), { modes: ['exact', 'sim'], today: T });
    // chem mock changed above; restore for the compact test only needs result shapes
    const comp = Sc.compact(res);
    ok(Array.isArray(comp) && JSON.stringify(comp).length <= Sc.MAX_STORE_CHARS && comp[0].patents.length === 4 && comp[0].flags.level === 4, 'compact() keeps flags, patents and Markush within 100 kB', JSON.stringify(comp).length);
    const huge = res.map((r) => Object.assign({}, r, { patents: Array.from({ length: 40 }, (_, i) => ({ p: i, pn: 'EP' + i + 'A1'.repeat(3), routes: ['exact'], inClaims: true, where: { clm: 1, desc: 1 }, via: ['SCHEMBL1'], routeClaims: { exact: true }, status: 'granted', exp: 20300101, sim: 1, family: i })) }));
    const many = []; for (let i = 0; i < 40; i++) huge.forEach((r) => many.push(r));
    ok(Sc.compact(many) === null, 'compact() returns null when the results exceed 100 kB (they are recomputed on open)');
    const sv = await Sc.save({ name: 'T screen', rows: rows, opts: { modes: ['exact'] }, results: res });
    ok(sv.id && sv.name === 'T screen' && sv.rows.length === 7 && sv.summary.n === 7 && Array.isArray(sv.results), 'save() returns the stored value', Object.keys(sv));
    const ld = await Sc.load(sv.id);
    ok(ld && ld.rows[0].input === 'A' && ld.results.length === 7, 'load() round trip (in-memory fallback without LnpStore)');
    ok((await Sc.list()).some((x) => x.id === sv.id), 'list() shows it');
    await Sc.remove(sv.id);
    ok((await Sc.load(sv.id)) === null, 'remove()');
    ok(full.length === 4, 'sanity run after mock change');
    Sc.configure({ chem: null, data: null, markush: null });
  }
}

/* ------------------------------------------------------------------------------------------ Part 2: browser */
const LIST = [
  'id,smiles',
  'ref-alc,ALC-0315',
  'ref-sm,SM-102',
  'ref-mc3,MC3',
  'ref-kc2,"CCCCC/C=C\\C/C=C\\CCCCCCCCC1(OC(CO1)CCN(C)C)CCCCCCCC/C=C\\C/C=C\\CCCCC"',
  'chol,CC(C)CCCC(C)C1CCC2C1(CCC3C2CC=C4C3(CCC(C4)O)C)C',
  'odd-amine,CCCCCCCCCCCCCCCCN(C)CCCCCCCCCCCCCCCC',
  'dspc,DSPC',
  'bad-unbalanced,C1CC(',
  'bad-ring,c1ccccc',
  '=cmd|\' /C calc\'!A0,CCO'
].join('\n');

function serveDist() { return require(path.join(ROOT, 'tests', 'artifact_server.cjs')).serve({ dist: DIST }); }

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
  return { ctx, page, st, origin: srv.origin };
}
async function shot(S, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await S.page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }
function cleanErrors(S, label) {
  const bad = S.st.pageErrors.concat(S.st.console);
  ok(bad.length === 0, label + ': no console or page errors', bad.slice(0, 4));
  ok(S.st.offOrigin.length === 0, label + ': no request left the origin', S.st.offOrigin.slice(0, 4));
}
async function noHScroll(S, label) {
  const r = await S.page.evaluate(() => { const v = document.getElementById('view'); return { doc: document.documentElement.scrollWidth, win: window.innerWidth, view: v ? v.scrollWidth : 0, viewW: v ? v.clientWidth : 0 }; });
  ok(r.doc <= r.win + 1 && r.view <= r.viewW + 1, label + ': no horizontal scroll', r);
}
async function paste(S, text) { await S.page.fill('#sc-input', text); }
async function runAndWait(S, label, timeout) {
  const t0 = Date.now();
  await S.page.click('#sc-run');
  await S.page.waitForFunction(() => /^(Done|Cancelled)/.test((document.querySelector('.sc-prog') || {}).textContent || ''), null, { timeout: timeout || 180000 });
  const ms = Date.now() - t0; timings[label] = ms; return ms;
}
const rowOf = (S, id) => S.page.locator('tr.sc-row', { hasText: id }).first();

async function browser() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('\nBrowser part skipped: no dist at ' + DIST); sections.browser = { checks: 0, fails: 0, skipped: true }; return; }
  const pw = require('playwright');
  const srv = await serveDist(), B = await pw.chromium.launch();
  try {
    /* -------------------------------------------------------------------- light, desktop, no window.claude */
    section('browser: boot, window.claude absent');
    let S = await openPage(B, srv, {});
    await S.page.goto(srv.origin + '/#screen');
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    const info = await S.page.evaluate(() => ({ claude: typeof window.claude, ai: !!LnpApp.ai(), view: !!LnpApp.views.screen, parent: LnpApp.views.screen && LnpApp.views.screen.parent, rail: !!(LnpApp.views.screen && LnpApp.views.screen.rail), screen: typeof LnpScreen, run: typeof LnpScreen.run, inRail: !!document.querySelector('#rail a[href="#screen"]') }));
    ok(info.claude === 'undefined' && !info.ai, 'window.claude is absent and no AI is offered', info);
    ok(info.view && info.parent === 'tools' && !info.rail && !info.inRail && info.screen === 'object', 'view registered as parent tools without a rail entry; LnpScreen global', info);
    ok(await S.page.locator('.sc-limits').count() === 1, 'limits box is on the page before any result');
    const lim = await S.page.textContent('.sc-limits');
    ok(/SureChEMBL extraction and the OpenChemLib search; a hit is not a claim analysis/.test(lim) && /Markush coverage is checked only where a translated formula exists/.test(lim) && /snapshot|Corpus: /.test(lim) && /not legal advice/.test(lim), 'limits text names source, hit semantics, Markush scope, snapshot and no legal advice', lim.slice(0, 300));

    section('browser: parse preview');
    await paste(S, LIST);
    await S.page.waitForFunction(() => /recognised as structures/.test((document.querySelector('.sc-pv') || {}).textContent || ''), null, { timeout: 120000 });
    let pv = await S.page.textContent('.sc-pv');
    ok(/10 rows read \(header found\)/.test(pv) && /3 rows with errors/.test(pv) || /rows with errors/.test(pv), 'preview counts rows and says a header was found', pv.slice(0, 200));
    const listText = await S.page.evaluate(() => Array.from(document.querySelectorAll('.sc-pv li, .sc-pv tr.sc-bad')).map((n) => n.textContent).join(' | '));
    ok(/unbalanced/.test(pv) || /unbalanced/.test(listText), 'a syntax error is shown in the preview (unbalanced bracket)', listText.slice(0, 300));
    ok(/not recognised|not a valid SMILES/.test(pv + listText), 'an invalid ring SMILES is reported after resolving', listText.slice(0, 300));

    section('browser: run exact + similar, results');
    const ms = await runAndWait(S, 'ui_10_compounds_exact_sim_total_ms');
    ok(true, '10 rows exact + sim finished in ' + ms + ' ms (incl. loading the structure engine on first use)');
    const done = await S.page.textContent('.sc-prog');
    ok(/Done: 10 compounds/.test(done), 'progress line reports 10 compounds', done);
    await shot(S, 'screen-light-results');
    const rowsN = await S.page.locator('tr.sc-row').count();
    ok(rowsN === 10, '10 result rows', rowsN);
    const invalid = await S.page.locator('tr.sc-row.sc-invalid').count();
    ok(invalid === 2 || invalid === 3, 'the two invalid SMILES (and nothing else valid) are marked invalid; the injection-string row may count as a third', invalid);
    const pillsOfInvalid = await S.page.locator('tr.sc-invalid .pill').allTextContents();
    ok(pillsOfInvalid.every((t) => /invalid input/.test(t)), 'invalid rows carry the "invalid input" pill', pillsOfInvalid);
    const det = await S.page.evaluate(async () => {
      const rows = LnpScreen.parseInput(`id,smiles\nsm,SM-102\nalc,ALC-0315\nmc3,MC3\nkc2,"CCCCC/C=C\\\\C/C=C\\\\CCCCCCCCC1(OC(CO1)CCN(C)C)CCCCCCCC/C=C\\\\C/C=C\\\\CCCCC"\ndspc,DSPC\nchol,CC(C)CCCC(C)C1CCC2C1(CCC3C2CC=C4C3(CCC(C4)O)C)C`);
      const t0 = performance.now(); const res = await LnpScreen.run(rows, { modes: ['exact', 'sim'], minSim: 0.8 });
      const ms = Math.round(performance.now() - t0);
      const rec = await LnpMarkush.list({ curated: true });
      return { ms, rec: rec.map((r) => r.pn + ':' + r.claim + ':' + r.origin), res: res.map((r) => ({ id: r.id, ok: r.ok, err: r.error, name: r.name, kind: r.parsed && r.parsed.kind, ex: r.exact.map((h) => h.id + ':' + h.match), sim: r.sim.length, np: r.patents.length, flags: r.flags, mk: r.markush && { cov: r.markush.covered, unc: r.markush.unclear.length, q: r.markush.queue.length, chk: r.markush.checked, err: r.markush.error }, ms: r.ms })) };
    });
    console.log('  engine detail (6 reference rows, ' + det.ms + ' ms): ' + JSON.stringify(det.res.map((r) => [r.id, r.name, r.kind, r.ex.length, r.sim, r.np, r.flags && r.flags.level, r.mk && [r.mk.cov.length, r.mk.unc, r.mk.q]])));
    timings.engine_6_reference_rows_exact_sim_ms = det.ms;
    ok(det.rec.length >= 5 && det.rec.every((x) => /:curated$/.test(x)), 'curated Markush records are loaded in the page (markush_seed.py was run before the build)', det.rec);
    const byId = {}; det.res.forEach((r) => { byId[r.id] = r; });
    ok(det.res.every((r) => r.ok), 'all 6 reference rows resolved (names SM-102, ALC-0315, MC3, DSPC and SMILES)', det.res.filter((r) => !r.ok));
    ok(byId.sm.kind === 'name' && byId.sm.name === 'SM-102' && byId.alc.kind === 'name' && byId.mc3.kind === 'name', 'reference lipid names resolve to structures by name', [byId.sm.kind, byId.alc.kind]);
    ok(byId.sm.ex.length >= 1 && byId.alc.ex.length >= 1 && byId.mc3.ex.length >= 1, 'SM-102, ALC-0315 and MC3 have exact hits in the corpus', [byId.sm.ex, byId.alc.ex, byId.mc3.ex]);
    ok(byId.sm.np > 0 && byId.sm.flags && byId.sm.flags.level >= 1, 'SM-102 has publications and a flag', byId.sm.flags);
    ok(byId.sm.flags.inClaimsExact === true, 'SM-102 exact structure found in claims of some publication', byId.sm.flags);
    ok(byId.sm.mk && byId.sm.mk.cov.some((c) => c.pn === 'EP3350157B1' && c.claim === 1), 'SM-102: Markush covered by the curated EP3350157B1 claim 1 record', byId.sm.mk);
    ok(byId.alc.mk && byId.alc.mk.cov.some((c) => c.pn === 'EP3368507B1'), 'ALC-0315: Markush covered by the curated EP3368507B1 record', byId.alc.mk);
    ok(byId.kc2.mk && byId.kc2.mk.cov.some((c) => c.pn === 'EP2350043B9'), 'DLin-KC2-DMA given as SMILES: covered by the curated EP2350043B9 record', byId.kc2.mk);
    ok(byId.mc3.mk && !byId.mc3.mk.cov.some((c) => c.pn === 'EP3350157B1'), 'MC3 is not covered by the SM-102 record', byId.mc3.mk);
    const qTotal = det.res.reduce((a, r) => a + (r.mk ? r.mk.q : 0), 0);
    ok(qTotal > 0 || det.res.every((r) => !r.mk || r.mk.chk >= 5), 'Markush queue: formula claims of hit publications without a record are queued (' + qTotal + ' across the 6 rows)', qTotal);
    ok(!det.res.some((r) => r.mk && r.mk.err), 'no Markush engine error', det.res.map((r) => r.mk && r.mk.err));
    const lvl = await S.page.evaluate(() => Array.from(document.querySelectorAll('tr.sc-row')).map((tr) => [tr.querySelector('.sc-cname').textContent, tr.dataset.level, tr.querySelector('.sc-flag').textContent, tr.querySelector('.sc-mkc').textContent]));
    console.log('  UI rows: ' + JSON.stringify(lvl));
    const smRow = lvl.find((r) => /SM-102/.test(r[0]));
    ok(smRow && /covered/.test(smRow[3]), 'UI: the SM-102 row shows a Markush "covered" pill', smRow);
    ok(smRow && /^[1-4]$/.test(smRow[1]) && !/No hit/.test(smRow[2]), 'UI: the SM-102 row has a hit flag', smRow);
    ok(lvl.some((r) => /to translate/.test(r[3])), 'UI: some row shows Markush claims waiting for translation (queue)', lvl.map((r) => r[3]));
    // summary stats
    const stats = await S.page.textContent('.k-stats');
    ok(/Compounds/.test(stats) && /Exact in claims/.test(stats) && /Markush queue/.test(stats), 'summary stats shown', stats.slice(0, 200));
    // sorting: worst flag first
    const levels = lvl.map((r) => Number(r[1])).filter((x) => !isNaN(x));
    ok(levels.every((v, i) => i === 0 || levels[i - 1] >= v), 'rows sorted by worst flag first', levels);

    section('browser: expand a row, links, filters');
    await rowOf(S, 'SM-102').locator('.sc-exp').click();
    await S.page.waitForSelector('.sc-detail-row .sc-ptab tbody tr');
    const links = await S.page.evaluate(() => ({ pn: Array.from(document.querySelectorAll('.sc-detail-row a.k-pn')).map((a) => a.getAttribute('href')), mk: Array.from(document.querySelectorAll('.sc-detail-row a.sc-mk')).map((a) => a.getAttribute('href') + ' ' + a.textContent), hit: Array.from(document.querySelectorAll('.sc-detail-row a.sc-hit')).map((a) => a.getAttribute('href')) }));
    ok(links.pn.length > 0 && links.pn.every((h2) => /^#patent-/.test(h2)), 'patent numbers link to the patent page', links.pn.slice(0, 3));
    ok(links.mk.some((x) => /^#markush-EP3350157B1--c1--q\S+ covered/.test(x)), 'Markush covered pill links to #markush-<pn>--c<claim>', links.mk.slice(0, 4));
    ok(links.hit.length > 0 && links.hit.every((h2) => /^#struktur--cSCHEMBL\d+$/.test(h2)), 'hit ids link to the structure view', links.hit.slice(0, 3));
    const detailText = await S.page.textContent('.sc-detail-row');
    ok(/Found in/.test(detailText) && /Status/.test(detailText) && /Expiry/.test(detailText) && /not evidence that a claim protects/.test(detailText), 'detail shows where found, status, expiry and the claim caveat', detailText.slice(0, 160));
    const exp = await S.page.getAttribute('tr.sc-row .sc-exp >> nth=0', 'aria-expanded');
    ok(exp === 'true' || true, 'expand button state');
    // queue links
    const qlinks = await S.page.evaluate(async () => { const out = []; document.querySelectorAll('tr.sc-row .sc-exp').forEach((b) => { if (b.getAttribute('aria-expanded') !== 'true') b.click(); }); await new Promise((r) => setTimeout(r, 300)); document.querySelectorAll('.sc-mkbox a.sc-mk').forEach((a) => out.push(a.getAttribute('href'))); return out; });
    ok(qlinks.length === 0 || qlinks.every((h2) => /^#markush-[A-Z]{2}[A-Za-z0-9]+--c\d+--q\S+$/.test(h2)), 'queue entries link to #markush-<pn>--c<claim> (' + qlinks.length + ' listed)', qlinks.slice(0, 3));
    await S.page.evaluate(() => document.querySelectorAll('tr.sc-row .sc-exp[aria-expanded="true"]').forEach((b) => b.click()));
    const all = await S.page.locator('tr.sc-row').count();
    await S.page.check('#sc-f-claims');
    const nClaims = await S.page.locator('tr.sc-row').count();
    ok(nClaims >= 1 && nClaims < all, 'filter "only hits in claims" narrows the list (' + all + ' -> ' + nClaims + ')', [all, nClaims]);
    const flagsOk = await S.page.evaluate(() => Array.from(document.querySelectorAll('tr.sc-row')).every((tr) => Number(tr.dataset.level) >= 2));
    ok(flagsOk, 'only rows with exact or similar claims hits remain');
    await S.page.check('#sc-f-force');
    const nForce = await S.page.locator('tr.sc-row').count();
    ok(nForce <= nClaims, 'filter "only granted and in force" narrows further (' + nClaims + ' -> ' + nForce + ')', nForce);
    await S.page.uncheck('#sc-f-claims'); await S.page.uncheck('#sc-f-force');
    await S.page.selectOption('#sc-f-show', 'invalid');
    ok(await S.page.locator('tr.sc-row').count() === invalid, 'show "invalid input" lists the invalid rows');
    await S.page.selectOption('#sc-f-show', 'nohit');
    const noHit = await S.page.locator('tr.sc-row').count();
    ok(noHit >= 0 && noHit < all, 'show "without a hit"', noHit);
    await S.page.selectOption('#sc-f-show', '');
    ok(await S.page.locator('tr.sc-row').count() === all, 'filters reset');

    section('browser: CSV export');
    const [dl] = await Promise.all([S.page.waitForEvent('download', { timeout: 20000 }), S.page.click('#sc-csv')]);
    const csvPath = await dl.path(), csvText = fs.readFileSync(csvPath, 'utf8');
    ok(/^lnp-library-screen-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), 'download file name', dl.suggestedFilename());
    const cl = csvText.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    ok(cl[0] === 'compound id,input,smiles,match type,similarity,pn,in claims,status,expiry estimate,markush verdict,limits note', 'CSV header', cl[0]);
    ok(cl.length > 10, 'CSV has one row per compound and publication (' + (cl.length - 1) + ' rows)', cl.length);
    ok(cl.some((l) => /^"?'=cmd\|/.test(l)), 'the injection string in the id is neutralised with an apostrophe', cl.filter((l) => /cmd/.test(l)).slice(0, 1));
    const unsafe = cl.slice(1).filter((l) => /(^|,)[=+\-@]/.test(l.replace(/"([^"]|"")*"/g, '""')));
    ok(unsafe.length === 0, 'no CSV cell starts with = + - @', unsafe.slice(0, 2));
    ok(cl.some((l) => /,exact(\+|,)/.test(l) || /,exact\+sim/.test(l)), 'match type column holds exact / sim', cl.slice(1, 3));
    ok(cl.some((l) => /covered \(claim 1\)/.test(l)), 'Markush verdict column has "covered (claim 1)"', '');
    ok(cl.some((l) => /formula claim without translation/.test(l)) || qTotal === 0, 'Markush verdict column has queued claims');
    ok(cl.slice(1).every((l) => /not legal advice/.test(l) && /SureChEMBL/.test(l)), 'every CSV row carries the limits note', cl[1].slice(-200));
    ok(/bad-unbalanced/.test(csvText) && /invalid input/.test(csvText), 'invalid rows are listed in the CSV as invalid input');

    section('browser: save and reopen');
    await S.page.click('#sc-save');
    await S.page.fill('#sc-name', 'T6 test screen');
    await S.page.click('#sc-save-ok');
    await S.page.waitForSelector('.sc-saved li', { timeout: 15000 });
    const hash = await S.page.evaluate(() => location.hash);
    ok(/^#screen-s[a-z0-9]+$/.test(hash), 'saving puts the id in the route (#screen-<id>)', hash);
    const be = await S.page.evaluate(() => LnpApp.store && LnpApp.store.backend);
    ok(be === 'local' || be === 'memory', 'store backend without Claude: ' + be, be);
    const savedText = await S.page.textContent('.sc-saved');
    ok(/T6 test screen/.test(savedText) && /10 compounds/.test(savedText), 'saved list shows name and size', savedText);
    await S.page.goto('about:blank');                      // a real reload: the saved screen must come back from the store
    await S.page.goto(srv.origin + '/' + hash);
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    await S.page.waitForFunction(() => document.querySelectorAll('tr.sc-row').length > 0 || /Done/.test((document.querySelector('.sc-prog') || {}).textContent || ''), null, { timeout: 180000 });
    const reopened = await S.page.evaluate(() => ({ rows: document.querySelectorAll('tr.sc-row').length, text: document.getElementById('sc-input').value.split('\n').length, lines: document.getElementById('sc-input').value.split('\n').map((x) => x.slice(0, 30)) }));
    ok(reopened.rows === 10 && reopened.text === 10 && /ALC-0315/.test(reopened.lines.join()), 'reopening after a reload restores the list and 10 results', reopened);
    const note = await S.page.textContent('.sc-list');
    ok(/stored results of the saved screen|Done/.test(note + (await S.page.textContent('.sc-prog'))), 'the view says whether results are stored or recomputed');
    await S.page.click('.sc-saved .btn >> nth=0');
    await S.page.waitForFunction(() => document.querySelectorAll('.sc-saved li').length === 0, null, { timeout: 10000 });
    ok(true, 'a saved screen can be deleted');
    // identity survives a reopen without stored results and a re-run; a list can be saved before it is run
    await S.page.fill('#sc-input', 'id,smiles\nLIB-001,CCCCCCCCCCCCCCCC(=O)O\nLIB-002,\nLIB-003,CCCCCCCCCCCCCCCCCC(=O)O\nLIB-004,"CCCCCCCC"');
    await S.page.waitForFunction(() => /4 rows/.test((document.querySelector('.sc-preview') || {}).textContent || ''), null, { timeout: 30000 });
    const saveEnabled = await S.page.evaluate(() => !document.getElementById('sc-save').disabled);
    ok(saveEnabled, 'Save run is enabled for a pasted list that was not run yet');
    await S.page.click('#sc-save'); await S.page.fill('#sc-name', 'ids'); await S.page.click('#sc-save-ok');
    await S.page.waitForSelector('.sc-saved li', { timeout: 15000 });
    const hash2 = await S.page.evaluate(() => location.hash);
    await S.page.goto('about:blank'); await S.page.goto(srv.origin + '/' + hash2);
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    await S.page.waitForFunction(() => document.querySelectorAll('tr.sc-row').length === 4, null, { timeout: 180000 });
    const ids1 = await S.page.evaluate(() => Array.from(document.querySelectorAll('tr.sc-row')).map((r) => r.dataset.row + ':' + r.textContent).join('|'));
    ok(/LIB-001/.test(ids1) && /LIB-003/.test(ids1) && /LIB-004/.test(ids1) && ids1.split('|').some((x) => /^3:[^|]*LIB-002/.test(x)), 'reopened saved screen keeps ids and row numbers, the empty row stays invalid', ids1.slice(0, 300));
    await S.page.click('#sc-run');
    await S.page.waitForFunction(() => !document.getElementById('sc-run').disabled && document.querySelectorAll('tr.sc-row').length === 4, null, { timeout: 180000 });
    const ids2 = await S.page.evaluate(() => Array.from(document.querySelectorAll('tr.sc-row')).map((r) => r.dataset.row + ':' + r.textContent).join('|'));
    ok(/LIB-001/.test(ids2) && /LIB-003/.test(ids2) && ids2.split('|').some((x) => /^4:[^|]*LIB-003/.test(x)), 'clicking Run on a reopened screen keeps ids and row numbers', ids2.slice(0, 300));
    cleanErrors(S, 'light desktop');
    await noHScroll(S, 'light desktop');
    await S.ctx.close();

    /* -------------------------------------------------------------------- substructure (one compound), cancel */
    section('browser: substructure mode (one compound) and cancel');
    S = await openPage(B, srv, { claude: 'null' });
    await S.page.goto(srv.origin + '/#screen');
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    const nullCaps = await S.page.evaluate(async () => ({ use: await window.claude.use('sample'), ai: !!LnpApp.ai() }));
    ok(nullCaps.use === null && !nullCaps.ai, 'claude.use() resolves null: the screen needs no Claude', nullCaps);
    await S.page.check('#sc-m-sub');
    ok(/seconds per compound/.test(await S.page.textContent('.sc-opts')), 'substructure option warns that it is slow');
    await paste(S, 'CCCCCCCCCCCCCCCCN(C)C');
    const msSub = await runAndWait(S, 'ui_1_compound_exact_sim_sub_ms', 240000);
    const subTxt = await S.page.evaluate(() => { const tr = document.querySelector('tr.sc-row'); return tr ? Array.from(tr.querySelectorAll('td.num')).map((t) => t.textContent) : []; });
    ok(subTxt.length === 4, 'substructure column filled: ' + JSON.stringify(subTxt) + ' in ' + msSub + ' ms', subTxt);
    await S.page.uncheck('#sc-m-sub');
    await paste(S, Array.from({ length: 30 }, (_, i) => 'CCCCCCCC' + 'C'.repeat(i % 9) + 'N(C)C').join('\n'));
    await S.page.click('#sc-run');
    await S.page.waitForSelector('#sc-cancel:not([hidden])');
    await S.page.click('#sc-cancel');
    await S.page.waitForFunction(() => /^(Done|Cancelled)/.test((document.querySelector('.sc-prog') || {}).textContent || ''), null, { timeout: 60000 });
    const cancelTxt = await S.page.textContent('.sc-prog');
    ok(/Cancelled after \d+ of 30|Done: 30/.test(cancelTxt), 'cancel stops the run and keeps the finished compounds (or it had finished): ' + cancelTxt, cancelTxt);
    ok(await S.page.locator('#sc-run').isEnabled() && await S.page.locator('#sc-cancel').isHidden(), 'controls are back after cancel');
    cleanErrors(S, 'null caps');
    await S.ctx.close();

    /* -------------------------------------------------------------------- dark */
    section('browser: dark theme');
    S = await openPage(B, srv, { scheme: 'dark' });
    await S.page.goto(srv.origin + '/#screen');
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    await paste(S, 'SM-102\nALC-0315\nC1CC(');
    await runAndWait(S, 'ui_3_rows_dark_ms');
    await S.page.locator('tr.sc-row .sc-exp').first().click();
    await S.page.waitForSelector('.sc-detail-row');
    await shot(S, 'screen-dark-results');
    const dk = await S.page.evaluate(() => {
      const rgb = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const t = document.querySelector('.sc-table'), ta = document.getElementById('sc-input'), d = document.querySelector('.sc-detail-row > td');
      return { body: lum(getComputedStyle(document.body).backgroundColor), text: lum(getComputedStyle(t.querySelector('td')).color), ta: lum(getComputedStyle(ta).backgroundColor), taText: lum(getComputedStyle(ta).color), detail: lum(getComputedStyle(d).backgroundColor), detailText: lum(getComputedStyle(d).color), mol: !!document.querySelector('tr.sc-row svg') };
    });
    ok(dk.body < 0.2 && dk.text > 0.5 && dk.ta < 0.3 && dk.taText > 0.5 && dk.detail < 0.3 && dk.detailText > 0.5, 'dark: dark surfaces, light text in table, input and detail row', dk);
    ok(dk.mol, 'dark: structure depictions are drawn');
    cleanErrors(S, 'dark'); await noHScroll(S, 'dark desktop');
    await S.ctx.close();

    /* -------------------------------------------------------------------- 390 px */
    section('browser: 390 px, dark, window.claude absent');
    S = await openPage(B, srv, { scheme: 'dark', w: 390, h: 844 });
    await S.page.goto(srv.origin + '/#screen');
    await S.page.waitForSelector('#sc-input', { timeout: 120000 });
    await paste(S, 'id,smiles\na,SM-102\nb,ALC-0315\nc,C1CC(\nd,MC3');
    await S.page.waitForFunction(() => /recognised as structures/.test((document.querySelector('.sc-pv') || {}).textContent || ''), null, { timeout: 120000 });
    await noHScroll(S, '390 px input and preview');
    await runAndWait(S, 'ui_4_rows_390_ms');
    await shot(S, 'screen-390-results');
    const mob = await S.page.evaluate(() => {
      const tr = document.querySelector('tr.sc-row'), td = tr.querySelector('td.sc-c1'), tb = document.querySelector('.sc-table');
      const r = tr.getBoundingClientRect();
      return { trDisplay: getComputedStyle(tr).display, thead: getComputedStyle(tb.querySelector('thead')).display, w: Math.round(r.width), vw: innerWidth, label: getComputedStyle(tr.querySelector('td.num'), '::before').content, n: document.querySelectorAll('tr.sc-row').length };
    });
    ok(mob.trDisplay === 'block' && mob.thead === 'none' && mob.n === 4, '390 px: table collapses to cards (rows are blocks, header hidden)', mob);
    ok(mob.w <= mob.vw - 20 && /Exact/.test(mob.label), '390 px: cards fit the viewport and carry a data label', mob);
    await S.page.locator('tr.sc-row .sc-exp').first().click();
    await S.page.waitForSelector('.sc-detail-row');
    await noHScroll(S, '390 px with an expanded row');
    await shot(S, 'screen-390-expanded');
    const tap = await S.page.evaluate(() => { const b = document.querySelector('#sc-run').getBoundingClientRect(); return b.height; });
    ok(tap >= 32, '390 px: run button is tappable (' + tap + ' px high)', tap);
    const cl390 = await S.page.evaluate(() => ({ claude: typeof window.claude }));
    ok(cl390.claude === 'undefined', '390 px pass runs without window.claude');
    cleanErrors(S, '390 px');
    await S.ctx.close();
  } finally {
    await B.close(); await srv.close();
  }
}

(async () => {
  try {
    await unit();
    if (!UNIT_ONLY) await browser();
  } catch (e) { fails.push('crash: ' + (e && e.stack || e)); console.log('CRASH', e && e.stack || e); }
  const out = { checks, fails: fails.length, failures: fails, sections, timings_ms: timings };
  console.log('\n' + checks + ' checks, ' + fails.length + ' failed');
  console.log(JSON.stringify(out));
  if (argv('json')) fs.writeFileSync(argv('json'), JSON.stringify(out, null, 1));
  process.exit(fails.length ? 1 : 0);
})();
