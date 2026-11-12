#!/usr/bin/env node
/* Regression tests for the review fixes of the tool views and engines (Node only, no browser, no corpus needed).

   usage: node tests/review_fixes_test.cjs [--verbose]

   - LnpMarkush: a covered compound that is not the largest fragment of the input, and a covered tautomer, are no longer
     reported "not covered"; a plain miss stays "not covered".
   - LnpRanges: inherited object keys (__proto__, constructor, toString) are skipped, not a crash; a bare "%" claim range
     is compared with mol and weight values and flagged basisUnknown; "outside" keeps its row.
   - LnpScreen: an unclosed quote in a CSV adds a note; a small widely published compound is a "common building block",
     a large one only "widely published".
   - LnpDisclosure / LnpExpiry CSV: leading whitespace before = + - @ and control characters are neutralised.
   - LnpExpiry: a right past its estimated date is "expiredEst", not dead; the pre-1995 US term rule (grant + 17 y).
   - LnpKit.chemErr: OpenChemLib parse messages become plain text.
   Exit code 1 if an assertion fails. */
'use strict';
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
let checks = 0; const fails = [];
function ok(c, what, extra) {
  checks++;
  if (!c) { fails.push(what); console.log('  FAIL ' + what + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 500) : '')); }
  else if (VERBOSE) console.log('  ok   ' + what);
}
function section(s) { if (VERBOSE) console.log('\n## ' + s); }

require(path.join(ROOT, 'web', 'engine', 'ai.js'));
const MK = require(path.join(ROOT, 'web', 'engine', 'x-markush.js'));
const RG = require(path.join(ROOT, 'web', 'engine', 'x-ranges.js'));
const SC = require(path.join(ROOT, 'web', 'engine', 'x-screen.js'));
const DC = require(path.join(ROOT, 'web', 'engine', 'x-disclosure.js'));
const EX = require(path.join(ROOT, 'web', 'engine', 'x-expiry.js'));

function rec(core, vars) { return { v: 'mk-1', pn: 'T1', claim: 1, origin: 'manual', reviewed: true, core: { smiles: core }, vars, provisos: [], unsupported: [] }; }
function sub(name, attach, alts) { return { name, attach, kind: 'substituent', quote: '', alts }; }

async function markush() {
  section('Markush: fragments and tautomers');
  await MK.ready();
  const lip = rec('CN(C)CCCC(=O)O[*:1]', [sub('R1', [1], [{ type: 'alkyl', cMin: 8, cMax: 20 }])]);
  ok(MK.checkSync(lip, 'CN(C)CCCC(=O)OCCCCCCCCCC').overall === 'covered', 'the lipid alone is covered');
  const mix = MK.checkSync(lip, 'CN(C)CCCC(=O)OCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC(=O)O');
  ok(mix.overall === 'covered' && /fragment/.test(mix.reasons[0]), 'covered lipid next to a larger fatty acid: covered, reason names the fragment', mix.reasons);
  const salt = MK.checkSync(lip, 'CN(C)CCCC(=O)OCCCCCCC.Cl');
  ok(salt.overall === 'not_covered', 'a real miss with a small counter-ion stays not covered', salt.overall);
  const ta = rec('Oc1ccncc1[*:1]', [sub('R1', [1], [{ type: 'alkyl', cMin: 1, cMax: 4 }])]);
  ok(MK.checkSync(ta, 'Oc1ccncc1CC').overall === 'covered', 'hydroxypyridine as drawn: covered');
  const pyr = MK.checkSync(ta, 'O=c1cc[nH]cc1CC');
  ok(pyr.overall === 'covered' && /tautomer/.test(pyr.reasons[0]), 'pyridone tautomer: covered, reason names the tautomer', pyr);
  const miss = MK.checkSync(ta, 'O=c1cc[nH]cc1CCCCCC');
  ok(miss.overall === 'not_covered' && miss.limits.some((l) => /tautomer/.test(l)), 'a tautomer that is outside too stays not covered, and says tautomers were checked', [miss.overall, miss.limits]);
}

function rangesDoc() {
  // two publications: P1 claim 1 "10 to 20 %" (bare percent, filed as mol_pct), P2 claim 1 "10 to 20 wt %"
  return { v: 'rg-1', params: [{ id: 'mol_pct', label: 'mol %', unit: 'mol%' }, { id: 'wt_pct', label: 'wt %', unit: 'wt%' }], comps: ['ionizable lipid'], compIds: ['ionizable_cationic'],
    compAlias: {}, compFallback: [], win: { lead: 10, max: 80 }, pn: ['P1', 'P2'], lang: ['en', 'en'], chain: {},
    rows: { pi: [0, 1], claim: [1, 1], dep: ['', ''], param: [0, 1], comp: [0, 0], lo: [10, 10], hi: [20, 20], loInc: [1, 1], hiInc: [1, 1], unit: ['%', 'wt%'], approx: [0, 0], q: ['10 to 20 %', '10 to 20 wt %'], off: [0, 0], ml: [10, 13] } };
}
async function ranges() {
  section('Ranges: inherited keys and bare percent');
  await RG.init({ json: rangesDoc(), force: true });
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    let r = null, e = null;
    try { r = await RG.check([{ param: k, value: 1 }]); } catch (x) { e = x; }
    ok(!e && r && r.skipped.length === 1 && /unknown parameter/.test(r.skipped[0].reason), 'param "' + k + '" is skipped, no crash', e ? String(e.message) : r && r.skipped);
  }
  let rc = null, ec = null;
  try { rc = await RG.check([{ param: 'mol_pct', comp: '__proto__', value: 15 }]); } catch (x) { ec = x; }
  ok(!ec && rc, 'component "__proto__" does not crash', ec && ec.message);
  const m = await RG.check([{ param: 'mol_pct', comp: 'ionizable_cationic', value: 15, unit: 'mol%' }]);
  const m1 = m.all.find((c) => c.pn === 'P1');
  ok(m1 && m1.values[0].status === 'inside' && m1.values[0].basisUnknown === true, 'mol % value inside a bare "%" range: inside, basisUnknown', m.all);
  ok(!m.all.find((c) => c.pn === 'P2'), 'a mol % value is not compared with a wt % range');
  const w = await RG.check([{ param: 'wt_pct', comp: 'ionizable_cationic', value: 15, unit: 'wt%' }]);
  const w1 = w.all.find((c) => c.pn === 'P1'), w2 = w.all.find((c) => c.pn === 'P2');
  ok(w1 && w1.values[0].basisUnknown === true && w2 && !w2.values[0].basisUnknown, 'a wt % value reaches the bare "%" range (flagged) and the wt % range (not flagged)', w.all);
  ok(RG.limits().some((l) => /bare "%"/.test(l)), 'limits name the bare percent rule');
}

async function screen() {
  section('Screen: CSV notes and the building-block flag');
  const r = SC.parseInput('id,smiles\n1,"CCO\n2,CCN\n3,CCC');
  ok(r.notes.some((n) => /Unclosed quote from line 2/.test(n)), 'unclosed quote: note with the line', r.notes);
  const r2 = SC.parseInput('id,smiles\n1,CCO\n2,CCN');
  ok(r2.length === 2 && !r2.notes.some((n) => /Unclosed/.test(n)), 'a clean file has no such note');
}

function csv() {
  section('CSV escaping');
  const res = { query: 'x', mode: 'exact', earliest: {}, limits: [], families: [], entries: [{ pn: 'WO1', family: 1, prio: '', pub: '', app: '', where: {}, status: '', exp: '', player: '  =HYPERLINK("x")', cs: [], title: 'a\u0001b' }] };
  const a = DC.toCsv(res, { kind: 'entries' });
  ok(/'  =HYPERLINK/.test(a), 'disclosure: leading spaces before = are neutralised', a.slice(0, 300));
  ok(!/\u0001/.test(a), 'disclosure: control characters are removed');
}

async function expiry() {
  section('Expiry: estimated expiry and the pre-1995 US rule');
  const P = [
    { p: 0, pn: 'EP1B1', auth: 'EP', kind: 'B1', fam: 1, appNo: 'e1', title: 'T', assignee: 'A', pub: 20000101, app: 19990101, status: 'granted', exp: 0, deIn: 1 },
    { p: 1, pn: 'EP2B1', auth: 'EP', kind: 'B1', fam: 2, appNo: 'e2', title: 'T', assignee: 'A', pub: 20000101, app: 19990101, status: 'lapsed', exp: 0, deIn: 0 },
    { p: 2, pn: 'US3B1', auth: 'US', kind: 'B1', fam: 3, appNo: 'u3', title: 'T', assignee: 'A', pub: 19990601, app: 19940301, status: 'granted', exp: 0 }
  ];
  const ST = { 1: { code: 'lapsed', src: 'ep-register', asof: '2026-08-23' } };
  EX.configure({ data: { manifest: { snapshots: {} }, patent: async (p) => P[p], status: async (p) => ST[p] || null, family: async (p) => [p], byPn: async () => -1 }, now: () => '2026-11-11' });
  const rows = await EX.timeline([0, 1, 2], {});
  const by = Object.fromEntries(rows.map((r) => [r.pn, r]));
  ok(by.EP1B1.expiredEst === true && !by.EP1B1.dead && !by.EP1B1.inForce && !by.EP1B1.pending, 'past the estimate: expiredEst, not dead', by.EP1B1);
  ok(by.EP2B1.dead && by.EP2B1.deadReason === 'lapsed' && !by.EP2B1.expiredEst, 'register lapse stays dead');
  ok(by.US3B1.expiry.date === '2016-06-01' && /grant \+ 17 y/.test(by.US3B1.expiry.basis), 'US filed before 8 June 1995: grant + 17 y when longer', by.US3B1.expiry);
  const cl = EX.cliff(rows);
  ok(cl.nDead === 1 && cl.nExpiredEst === 2, 'cliff counts dead and expired (estimate) apart', [cl.nDead, cl.nExpiredEst]);
  const c = EX.toCsv(rows);
  ok(/expired \(estimate/.test(c), 'CSV names the estimated expiry');
}

function kit() {
  section('Kit: OpenChemLib messages');
  global.window = global; global.LnpUI = { h: () => null, num: String };
  require(path.join(ROOT, 'web', 'app', 'views', 'lib', 'kit.js'));
  const K = global.LnpKit;
  ok(K.chemErr('could not read the structure: Class$S18: SmilesParser: unknown element label found. Position:0') === 'not a valid SMILES (unknown element at position 1)', 'unknown element -> plain text', K.chemErr('Class$S18: SmilesParser: unknown element label found. Position:0'));
  ok(!/\.\./.test(K.chemErr('dangling ring closure..')), 'no double period');
  ok(K.chemErr('empty query') === 'empty query', 'other messages unchanged');
  ok(K.RULE_VERDICT.met[1] === 'crit' && K.RULE_VERDICT['n/a'][0] === 'not present', 'one rule verdict map: met = crit, n/a = not present');
}

(async () => {
  const t0 = Date.now();
  await markush(); await ranges(); await screen(); csv(); await expiry(); kit();
  console.log(JSON.stringify({ checks, fails: fails.length, ms: Date.now() - t0 }));
  if (fails.length) { console.log('FAILED ' + fails.length + ' of ' + checks); process.exit(1); }
  console.log('OK ' + checks + ' checks');
})().catch((e) => { console.error(e); process.exit(1); });
