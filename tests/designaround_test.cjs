/* Tests for the design-around assistant (web/engine/x-designaround.js, LnpDesign) and the #designs view.
   Node unit tests run always; the Playwright pass runs against a scratch dist (T7_DIST or a scratchpad dist) and is
   skipped only when playwright or the dist are missing; once a dist exists, any error fails the run. Run: node tests/designaround_test.cjs [--verbose] [--no-ui]
   Build for the UI pass (once): python3 -I pipeline/markush_seed.py && python3 -I pipeline/ranges_build.py &&
     python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215 [--limit 3000] */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var ROOT = path.join(__dirname, '..');
var M = require(path.join(ROOT, 'web/engine/x-markush.js'));
var D = require(path.join(ROOT, 'web/engine/x-designaround.js'));
var VERBOSE = process.argv.indexOf('--verbose') >= 0, NO_UI = process.argv.indexOf('--no-ui') >= 0;
var SEED = path.join(ROOT, 'data/seed/markush');
var pass = 0, fail = 0, notes = [];
function ok(cond, msg) { if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + msg); } else { fail++; console.log(' FAIL ' + msg); } }
function section(s) { if (VERBOSE) console.log('\n# ' + s); }

function curatedRecords() {
  return fs.readdirSync(SEED).filter(function (f) { return /\.json$/.test(f); }).map(function (f) { return JSON.parse(fs.readFileSync(path.join(SEED, f), 'utf8')); });
}

(async function () {
  await M.ready();
  await D.ready();
  var recs = curatedRecords();
  M.configure({ curated: recs });

  // ---------------------------------------------------------------- 1. design space default matches the seed file
  section('design space');
  var fileSpace = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/design_space.json'), 'utf8'));
  var def = D._internal.DEFAULT_SPACE;
  function stripNotes(x) { if (Array.isArray(x)) return x.map(stripNotes); if (x && typeof x === 'object') { var o = {}; Object.keys(x).forEach(function (k) { if (k === 'note' || k === 'v') return; o[k] = stripNotes(x[k]); }); return o; } return x; }
  ok(JSON.stringify(stripNotes(fileSpace)) === JSON.stringify(stripNotes(def)),
    'embedded DEFAULT_SPACE matches data/seed/design_space.json (ignoring notes)');
  ok(fileSpace.v === 'ds-1', 'design_space.json carries a version');

  // ---------------------------------------------------------------- 2. per curated record: generate + verify
  section('variants per curated record');
  for (var ri = 0; ri < recs.length; ri++) {
    var rec = recs[ri], name = rec.ref ? rec.ref.name : rec.pn;
    var res = M.checkSync(rec, rec.ref.smiles);
    ok(res.overall === 'covered', name + ': reference lipid is covered by its own claim (baseline)');
    var start = await D.fromMarkush(rec.ref.smiles, rec, res);
    ok(start.overall === 'covered' && start.met.some(function (m) { return m.verdict === 'met'; }), name + ': fromMarkush records the met variables');
    var out = await D.variants(start, { max: 40 });
    ok(out.variants.length > 0, name + ': generated at least one design-around variant');
    ok(out.variants.length <= 40, name + ': the cap (40) is respected (' + out.variants.length + ')');
    // dedupe by idcode
    var idset = {}, dup = false; out.variants.forEach(function (v) { if (idset[v.idcode]) dup = true; idset[v.idcode] = 1; });
    ok(!dup, name + ': variants are deduplicated by idcode');
    // every variant is a valid molecule and sits outside the claim (verified by LnpMarkush.check)
    var allValid = true, allOutside = true, startIdc = D._internal.parse(rec.ref.smiles, false).getIDCode();
    out.variants.forEach(function (v) {
      var m = D._internal.parse(v.smiles, false); if (!m) { allValid = false; return; }
      if (v.idcode === startIdc) allOutside = false;
      var r = M.checkSync(rec, v.smiles); if (r.overall === 'covered') allOutside = false;
    });
    ok(allValid, name + ': every variant is a valid OCL molecule');
    ok(allOutside, name + ': every variant is outside its own claim (LnpMarkush.check != covered) and not the start');
    // verified variants fail their targeted rule (or the whole claim); unverified ones are labelled and never called "outside"
    var verOk = true, verBad = [];
    out.variants.forEach(function (v) {
      var r = M.checkSync(rec, v.smiles);
      var tv = v.move.type === 'combination' ? v.move.parts.map(function (x) { return x.var; }).filter(Boolean) : (v.move.var ? [v.move.var] : []);
      var tNot = r.groups.some(function (x) { return tv.indexOf(x.name) >= 0 && x.verdict === 'not_met'; });
      if (v.verified === true) { if (!(r.overall === 'not_covered' || tNot)) { verOk = false; verBad.push(v.moveLabel); } }
      else if (v.verified === false) { if (r.overall !== 'unclear' || /^outside/i.test(v.sourceReason || '') || !/unclear/.test(v.sourceReason || '')) { verOk = false; verBad.push('unverified ' + v.moveLabel); } }
      else { verOk = false; verBad.push('no verified flag ' + v.moveLabel); }
    });
    ok(verOk, name + ': verified variants fail the targeted rule; unverified ones are flagged as unclear (' + verBad.slice(0, 3).join(' | ') + ')');
    // combinations are made of two labelled single moves on different variables
    ok(out.variants.filter(function (v) { return v.move.type === 'combination'; }).every(function (v) { var a = v.move.parts[0], b = v.move.parts[1]; return !(a.var && b.var && a.var === b.var); }), name + ': combinations join moves on different variables');
    if (VERBOSE) notes.push(name + ' by type ' + JSON.stringify(out.generatedByType) + ' kept ' + JSON.stringify(out.variants.reduce(function (m, v) { m[v.move.type] = (m[v.move.type] || 0) + 1; return m; }, {})) + ' unverified ' + out.unverified);
    // the reported move type is one of the known transformations
    var goodMoves = out.variants.every(function (v) { return /^(chain|unsaturation|branching|linker|head|combination)$/.test(v.move.type); });
    ok(goodMoves, name + ': every variant is tagged with a known move type');
    if (VERBOSE) notes.push(name + ': ' + out.variants.length + ' variants, ' + out.invalidDropped + ' invalid dropped');
  }

  // ---------------------------------------------------------------- 3. chain-length variant fails the targeted rule
  section('chain-length moves fail the targeted rule');
  var alc = recs.filter(function (r) { return r.pn === 'EP3368507B1'; })[0];
  var alcRes = M.checkSync(alc, alc.ref.smiles);
  var alcStart = await D.fromMarkush(alc.ref.smiles, alc, alcRes);
  var alcVars = (await D.variants(alcStart, { max: 60 })).variants;
  var chainVars = alcVars.filter(function (v) { return v.move.type === 'chain'; });
  ok(chainVars.length > 0, 'ALC-0315: chain-length variants were generated');
  var chainFails = chainVars.every(function (v) {
    var r = M.checkSync(alc, v.smiles);
    if (r.overall === 'covered') return false;
    // the targeted tail variable must no longer be "met"
    var g = r.groups.filter(function (x) { return x.name === v.move.var; })[0];
    return !g || g.verdict !== 'met';
  });
  ok(chainFails, 'ALC-0315: every chain-length variant makes its targeted variable not "met"');
  var longer = chainVars.filter(function (v) { return v.move.dir === 'longer'; })[0];
  ok(longer && longer.move.to > longer.move.from, 'ALC-0315: a "lengthen" move increases the carbon count past the rule');

  // ---------------------------------------------------------------- 4. linker swaps: valid, with the intended group
  section('linker swaps');
  var sm = recs.filter(function (r) { return r.pn === 'EP3350157B1'; })[0];
  var smRes = M.checkSync(sm, sm.ref.smiles);
  var smStart = await D.fromMarkush(sm.ref.smiles, sm, smRes);
  var smVars = (await D.variants(smStart, { max: 60 })).variants;
  var linkerVars = smVars.filter(function (v) { return v.move.type === 'linker'; });
  ok(linkerVars.length > 0, 'SM-102: linker-swap variants were generated');
  // the SMILES of each linker-swap variant must contain the pattern of the target linker class
  var space = D.space();
  var linkerGroupOk = linkerVars.every(function (v) {
    var toL = space.linkers.filter(function (l) { return l.label === v.move.to; })[0]; if (!toL) return false;
    var frag = D._internal.parse(toL.smiles, true); if (!frag) return false;
    var mol = D._internal.parse(v.smiles, false); if (!mol) return false;
    var ms = D._internal.matchFrag(D._internal.graph(frag), D._internal.graph(mol), 1);
    return ms.length > 0;
  });
  ok(linkerGroupOk, 'SM-102: every linker-swap variant actually contains the intended replacement linker');
  // a linker swap never proposes a class the record already lists for that position
  var noSelf = linkerVars.every(function (v) { return v.move.from !== v.move.to; });
  ok(noSelf, 'SM-102: a linker swap never maps a class to itself');
  var smAll = await D.variants(smStart, { max: 200 });
  var amideOr = {}; smAll.variants.forEach(function (v) { if (v.move.type === 'linker' && v.move.to === 'amide') amideOr[v.move.orient] = 1; });
  ok(amideOr[0] && amideOr[1], 'SM-102: an asymmetric linker (amide) is tried in both orientations');
  // no linker "found" inside a larger group: SM-102 has esters but no plain ether, so no swap may start from an ether
  ok(linkerVars.every(function (v) { return v.move.from !== 'ether'; }), 'SM-102: the O of an ester is never treated as an ether linker');

  // ---------------------------------------------------------------- 5. head-group swaps (dimethylamino -> ring amine)
  section('head-group swaps');
  var kc2 = recs.filter(function (r) { return r.pn === 'EP2350043B9'; })[0];
  var kc2Res = M.checkSync(kc2, kc2.ref.smiles);
  var kc2Start = await D.fromMarkush(kc2.ref.smiles, kc2, kc2Res);
  var kc2Vars = (await D.variants(kc2Start, { max: 60 })).variants;
  var headVars = kc2Vars.filter(function (v) { return v.move.type === 'head'; });
  ok(headVars.length > 0, 'DLin-KC2-DMA: head-group swap variants were generated (dimethylamino present)');
  var ringSwap = headVars.some(function (v) { return /pyrrolidin|piperidin|piperazin|morpholin/.test(v.move.to); });
  ok(ringSwap, 'DLin-KC2-DMA: at least one head swap proposes a cyclic amine (e.g. pyrrolidine/piperazine)');
  var kc2Out = await D.variants(kc2Start, { max: 60 });
  ok((kc2Out.generatedByType.unsaturation || 0) > 0, 'DLin-KC2-DMA: the alkenyl dblMin rule yields reduce-C=C candidates (' + (kc2Out.generatedByType.unsaturation || 0) + ')');

  // ---------------------------------------------------------------- 6. combinations of two moves (capped)
  section('combinations');
  var combos = smVars.filter(function (v) { return v.move.type === 'combination'; });
  ok(combos.every(function (v) { return (v.move.moves || []).length === 2; }), 'SM-102: combination variants carry exactly two moves');
  // the cap is balanced over move types: a prolific type (PEG ether swaps on ALC-0159) does not crowd out the others
  var peg = recs.filter(function (r) { return r.ref && /0159/.test(r.ref.name || ''); })[0];
  if (peg) {
    var pegRes = M.checkSync(peg, peg.ref.smiles), pegStart = await D.fromMarkush(peg.ref.smiles, peg, pegRes), pegOut = await D.variants(pegStart, { max: 60 });
    var types = {}; pegOut.variants.forEach(function (v) { types[v.move.type] = (types[v.move.type] || 0) + 1; });
    var gen = Object.keys(pegOut.generatedByType).filter(function (t) { return pegOut.generatedByType[t] > 0; });
    ok(Object.keys(types).length >= Math.min(2, gen.length) && (types.linker || 0) < pegOut.variants.length || gen.length <= 1, 'ALC-0159: the variant cap is shared across move types ' + JSON.stringify(types));
  }

  // ---------------------------------------------------------------- 7. risk formula is monotonic and 0..4
  section('risk formula');
  var sp = D.space().risk;
  function score(findings) { return D._internal.scoreRisk(findings, sp).risk; }
  var base = score({ patents: [], simHigh: [] });
  ok(base === 0, 'risk with no findings is 0');
  var pend = score({ patents: [{ src: {}, markush: 'covered', right: { pending: true, live: true } }], simHigh: [] });
  var grant = score({ patents: [{ src: {}, markush: 'covered', right: { granted: true, live: true } }], simHigh: [] });
  ok(grant >= pend && grant >= 2, 'covered by a granted in-force claim scores at least as high as pending (>= 2)');
  // adding a covered in-force claim never lowers the score (monotonic)
  var mono = true;
  for (var t = 0; t < 20; t++) {
    var pats = [];
    for (var k = 0; k < (t % 5); k++) pats.push({ src: { sim_claim: k % 2 === 0 }, markush: k % 2 ? 'unclear' : null, right: { live: true, granted: k % 3 === 0 } });
    var before = score({ patents: pats.slice(), simHigh: [] });
    var after = score({ patents: pats.concat([{ src: { exact_claim: true }, markush: 'covered', right: { granted: true, live: true } }]), simHigh: [] });
    if (after < before) mono = false;
  }
  ok(mono, 'adding a covered in-force claim never lowers the remaining-risk score');
  var clamped = score({ patents: [{ src: { exact_claim: true, sim_claim: true }, markush: 'covered', right: { granted: true, live: true } }, { src: { exact_claim: true }, markush: 'unclear', right: { granted: true, live: true } }, { src: { sim_claim: true }, markush: 'covered', right: { granted: true, live: true } }], simHigh: [{ patents: [{ where: { clm: true } }] }] });
  ok(clamped >= 0 && clamped <= 4, 'the score is clamped to 0..4 (' + clamped + ')');

  // ---------------------------------------------------------------- 7b. multi-claim Markush verdicts and failing engines
  section('assess: per-claim verdicts and unknowns');
  function fakeData() { return { byPn: function () { return Promise.resolve(0); }, patent: function () { return Promise.resolve({ status: 'granted', exp: '20990101' }); } }; }
  function fakeMk(rows) { return { batch: function () { return Promise.resolve(rows); }, checkSync: M.checkSync, ready: M.ready }; }
  var okChem = { search: function () { return Promise.resolve([]); } };
  var probeV = { smiles: 'CCCCCCN(C)C', verified: true };
  var rows1 = [{ pn: 'EP1', claim: 1, result: { overall: 'covered' } }, { pn: 'EP1', claim: 7, result: { overall: 'not_covered' } }];
  D.configure({ chem: okChem, markush: fakeMk(rows1), data: fakeData() });
  var rA = (await D.assess(Object.assign({}, probeV))).assessment.risk;
  D.configure({ markush: fakeMk(rows1.slice().reverse()) });
  var rB = (await D.assess(Object.assign({}, probeV))).assessment.risk;
  ok(rA === 2 && rB === 2, 'a covered claim counts even when another claim of the same patent is not covered, in either order (' + rA + ', ' + rB + ')');
  var rejectAll = { search: function () { return Promise.reject({ code: 'no_chem', message: 'no chem' }); } };
  D.configure({ chem: rejectAll, markush: { batch: function () { return Promise.reject({ code: 'x', message: 'batch failed' }); }, checkSync: M.checkSync, ready: M.ready } });
  var aFail = (await D.assess(Object.assign({}, probeV))).assessment;
  ok(aFail.risk === null && aFail.notAssessed, 'all engines failing -> risk null ("not assessed"), never 0');
  D.configure({ chem: rejectAll, markush: fakeMk([]) });
  var aPart = (await D.assess(Object.assign({}, probeV))).assessment;
  ok(aPart.risk >= 1 && aPart.unknown.length >= 1, 'a failed structure search adds an "unknown" point (' + aPart.risk + ')');
  D.configure({ chem: okChem, markush: fakeMk([{ pn: 'EP9', claim: 1, result: null, reason: 'error' }]) });
  var aRow = (await D.assess(Object.assign({}, probeV))).assessment;
  ok(aRow.risk >= 1 && /could not be checked/.test(JSON.stringify(aRow.unknown)), 'a Markush record that could not be checked raises the score');
  D.configure({ chem: okChem, markush: fakeMk([]) });
  var aUnv = (await D.assess({ smiles: 'CCCCCCN(C)C', verified: false })).assessment;
  ok(aUnv.risk === 1, 'an unverified (unclear) variant carries one extra risk point');
  // similarity hits in the claims of a dead patent do not count as "live"
  var spR = D.space().risk;
  var dead = D._internal.scoreRisk({ patents: [{ pn: 'EPD', src: { sim_claim: true }, right: { live: false } }], simHigh: [{ sim: 0.95, patents: [{ pn: 'EPD', where: { clm: true } }] }] }, spR).risk;
  ok(dead === 0, 'a similar compound in the claims of a dead patent adds nothing');
  D.configure({ chem: null, markush: null, data: null });

  // ---------------------------------------------------------------- 8. assess + rank (no corpus engines in Node)
  section('assess + rank');
  var assessed = [];
  for (var ai = 0; ai < Math.min(smVars.length, 12); ai++) { assessed.push(await D.assess(smVars[ai], { markushRecords: 'all-cached' })); }
  ok(assessed.every(function (v) { return v.assessment && typeof v.assessment.risk === 'number'; }), 'assess() attaches a numeric risk to every variant');
  ok(assessed.every(function (v) { return v.assessment.unknown.some(function (u) { return /search/.test(u.check); }) && v.assessment.risk >= 1; }), 'without a structure search engine every variant reports the unknown and scores >= 1');
  await D.withDistance(smStart.molecule.smiles, assessed);
  ok(assessed.every(function (v) { return typeof v.distance === 'number' && v.distance >= 0 && v.distance <= 1; }), 'withDistance() gives each variant a 0..1 structural distance');
  ok(new Set(assessed.map(function (v) { return v.distance.toFixed(3); })).size > 1, 'distances differ between variants (no placeholder value)');
  var ranked = await D.rank(assessed);
  var sortedOk = true;
  for (var i = 1; i < ranked.length; i++) { var a = ranked[i - 1], b = ranked[i]; var ra = a.rank.risk, rb = b.rank.risk; if (ra < rb) { sortedOk = false; break; } if (ra === rb && a.distance - 1e-9 > b.distance) { sortedOk = false; break; } }
  ok(sortedOk, 'rank() sorts by remaining risk (desc) then by distance to the start (asc)');
  // the Claude explanation can never change a rank or a risk number
  var before = ranked.map(function (v) { return v.rank.risk + '/' + v.assessment.risk; }).join(',');
  var expl = await D.explain(smStart, ranked, {});
  ok(expl.skipped === true, 'explain() is skipped when Claude is unavailable (manual/offline build)');
  var after = ranked.map(function (v) { return v.rank.risk + '/' + v.assessment.risk; }).join(',');
  ok(before === after, 'the (skipped) explanation leaves every rank and risk number unchanged');

  // ---------------------------------------------------------------- 9. formulation variants from a range result
  section('formulation variants');
  var rangeResult = {
    values: [{ param: 'mol_pct', comp: 'ionizable', compLabel: 'ionizable lipid', value: 50, unit: 'mol%', paramLabel: 'Molar fraction (mol %)' }],
    matches: [
      { pn: 'EP111', claim: 1, values: [{ param: 'mol_pct', comp: 'ionizable lipid', status: 'inside', row: { lo: 40, hi: 60 } }] },
      { pn: 'EP222', claim: 2, values: [{ param: 'mol_pct', comp: 'ionizable lipid', status: 'inside', row: { lo: 45, hi: 55 } }] }
    ]
  };
  // a fake range engine over claim rows (same interval rules as LnpRanges): EP111 40-60, EP222 45-55, EP333 >= 30 (open), EP444 0-100
  var corpusRows = [{ pn: 'EP111', claim: 1, lo: 40, hi: 60 }, { pn: 'EP222', claim: 2, lo: 45, hi: 55 }, { pn: 'EP333', claim: 1, lo: 30, hi: null }, { pn: 'EP444', claim: 3, lo: 0, hi: 100 }];
  var fakeRanges = { available: function () { return true; }, check: function (vals) { var x = vals[0].value; return Promise.resolve({ matches: corpusRows.filter(function (r) { return (r.lo == null || x >= r.lo) && (r.hi == null || x <= r.hi); }).map(function (r) { return { pn: r.pn, claim: r.claim }; }) }); } };
  function rr(rows) { return { values: rangeResult.values, matches: rows.map(function (r) { return { pn: r.pn, claim: r.claim, values: [{ param: 'mol_pct', comp: 'ionizable lipid', status: 'inside', row: { lo: r.lo, hi: r.hi, loInc: true, hiInc: true } }] }; }) }; }
  var fout = await D.fromRanges({ name: 'Test LNP' }, rr(corpusRows.slice(0, 2)), { ranges: fakeRanges });
  var tos = fout.variants.map(function (v) { return v.to; }).sort(function (a, b) { return a - b; });
  ok(tos.indexOf(39) >= 0 && tos.indexOf(61) >= 0, 'fromRanges moves below the lowest lo and above the highest hi (' + tos.join(',') + ')');
  ok(fout.variants.every(function (v) { return v.leaves.length >= 1 && v.rechecked; }), 'every formulation move leaves at least one range and was re-checked');
  var v61 = fout.variants.filter(function (v) { return v.to === 61; })[0];
  ok(v61 && v61.stillInside.some(function (x) { return x.pn === 'EP333'; }) && v61.stillInside.some(function (x) { return x.pn === 'EP444'; }), 'the re-check lists corpus claims that still contain the new value (open range EP333, 0-100 EP444)');
  var f100 = await D.fromRanges({}, rr([corpusRows[3]]), { ranges: fakeRanges });
  ok(f100.variants.length === 0 && f100.dropped.length === 2, 'a 0-100 mol % range gives no move (no clamping back inside); both drops are reported');
  var fOpen = await D.fromRanges({}, rr([corpusRows[2]]), { ranges: fakeRanges });
  ok(fOpen.variants.length === 1 && fOpen.variants[0].dir === 'below' && fOpen.variants[0].to === 29, 'an open upper bound gives no "above" move, only below (29)');
  var fNo = await D.fromRanges({}, rr(corpusRows.slice(0, 1)), { ranges: null });
  ok(fNo.variants.length && fNo.variants.every(function (v) { return v.rechecked === false; }) && /not re-checked/.test(fNo.limits.join(' ')), 'without the range engine the moves are marked not re-checked');
  ok(fout.limits.join(' ').toLowerCase().indexOf('not advice') >= 0, 'formulation output carries the "not advice" disclaimer');

  // ---------------------------------------------------------------- 10. start + disclaimer
  section('disclaimers');
  ok(smStart.limits.join(' ').toLowerCase().indexOf('equivalence') >= 0, 'the starting point names equivalence (doctrine of equivalents) as an open question');
  ok(smStart.limits.join(' ').toLowerCase().indexOf('not advice') >= 0, 'the starting point says it is not advice');

  // ---------------------------------------------------------------- 11. save/load round-trip (in-memory store)
  section('store (kind designs)');
  var mem = {};
  D.configure({ store: { put: function (k, id, v) { mem[k + '/' + id] = JSON.stringify(v); return Promise.resolve({ id: id }); }, get: function (k, id) { return Promise.resolve(mem[k + '/' + id] ? JSON.parse(mem[k + '/' + id]) : null); }, list: function (k) { return Promise.resolve(Object.keys(mem).filter(function (x) { return x.indexOf(k + '/') === 0; }).map(function (x) { return JSON.parse(mem[x]); })); }, remove: function (k, id) { delete mem[k + '/' + id]; return Promise.resolve(); } } });
  var session = { start: smStart, variants: ranked };
  var saved = await D.save(session);
  ok(saved.id && saved.v === 'da-1', 'save() writes a da-1 session with an id');
  ok(JSON.stringify(saved).length <= 100000, 'the saved session is <= 100 kB');
  var loaded = await D.load(saved.id);
  ok(loaded && Array.isArray(loaded.variants) && loaded.variants.length > 0, 'load() returns the saved session with its variants');
  var s2 = await D.save({ id: 'test-s2', start: smStart, variants: [{ smiles: 'CC', move: { type: 'head' }, verified: false, assessment: { risk: 2, markush: [{ pn: 'EP1', claim: 1, overall: 'covered' }], patents: [{ pn: 'EP1', markush: 'covered', mk: [{ claim: 1, overall: 'covered' }], src: {}, right: { live: true, granted: true } }] } }] });
  var l2 = await D.load(s2.id), p2 = l2.variants[0].assessment.patents[0];
  ok(p2.right && p2.right.granted === true && l2.variants[0].assessment.markush.length === 1 && l2.variants[0].verified === false, 'a saved session keeps the legal status, the Markush verdicts and the verified flag');
  await D.remove(s2.id);
  var listed = await D.list();
  ok(listed.length === 1, 'list() returns the saved session');
  await D.remove(saved.id);
  ok((await D.list()).length === 0, 'remove() deletes the session');
  D.configure({ store: null });

  // ---------------------------------------------------------------- summary
  if (VERBOSE && notes.length) console.log('\n' + notes.join('\n'));
  console.log('\nUnit: ' + pass + ' ok, ' + fail + ' fail');

  if (!NO_UI) { await uiPass(); }
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e && e.stack || e); process.exit(1); });

/* ---------------------------------------------------------------- Playwright pass
   Skipped (not failed) only when playwright or a scratch dist is missing; once a dist exists every error is a failure. */
async function uiPass() {
  console.log('\n# UI pass (Playwright)');
  var playwright; try { playwright = require('playwright'); } catch (e) { console.log('  SKIP: playwright not installed'); return; }
  var scratch = process.env.T7_DIST || findDist();
  if (!scratch || !fs.existsSync(path.join(scratch, 'index.html'))) { console.log('  SKIP: no scratch dist found (build one, see the header) - UI pass not run'); return; }
  var server = cp.spawn('node', [path.join(ROOT, 'tests/artifact_server.cjs'), '--dist', scratch, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  var port = await new Promise(function (res) { var s = ''; server.stdout.on('data', function (d) { s += d; var m = /http:\/\/[^:]+:(\d+)/.exec(s); if (m) res(Number(m[1])); }); setTimeout(function () { res(0); }, 8000); });
  ok(!!port, 'UI: the artifact server reports a port');
  if (!port) { try { server.kill(); } catch (e) {} return; }
  var base = 'http://localhost:' + port + '/';
  var refmol = 'CCCCCCCCCCCOC(=O)CCCCCN(CCCCCCCC(=O)OC(CCCCCCCC)CCCCCCCC)CCO';
  var COMMENT = 'Lengthening the tail pushes it past the claimed carbon range.\n\nThis is an idea generator, not legal advice.';
  var browser;
  try {
    browser = await playwright.chromium.launch();
    for (var theme of ['light', 'dark']) {
      for (var vw of [1280, 390]) {
        var tag = 'UI ' + theme + '/' + vw + ': ';
        var withClaude = (theme === 'light' && vw === 1280);
        var ctx = await browser.newContext({ viewport: { width: vw, height: 900 }, colorScheme: theme, acceptDownloads: true });
        var page = await ctx.newPage();
        var offOrigin = [], pageErrors = [];
        var FONT_HOSTS = { 'fonts.googleapis.com': 1, 'fonts.gstatic.com': 1 };
        page.on('request', function (r) { try { var u = new URL(r.url()); if (u.origin !== 'http://localhost:' + port && u.protocol !== 'data:' && u.protocol !== 'blob:' && !FONT_HOSTS[u.hostname]) offOrigin.push(r.url()); } catch (e) {} });
        page.on('pageerror', function (e) { pageErrors.push(e.message); });
        // Claude mock: claude.use('sample') resolves to a FUNCTION (the shape LnpAI.init accepts); other runs have no Claude
        await page.addInitScript(function (arg) {
          if (!arg.use) { window.claude = { use: function () { return Promise.resolve(null); } }; return; }
          window.claude = { use: function (cap) {
            if (cap !== 'sample') return Promise.resolve(null);
            var f = function (input) { window.__daPrompt = input; return Promise.resolve({ text: arg.text }); };
            f.limits = function () { return Promise.resolve({}); };
            return Promise.resolve(f);
          } };
        }, { use: withClaude, text: COMMENT });
        await page.goto(base + '#designs', { waitUntil: 'load' });
        await page.waitForSelector('.da-page', { timeout: 30000 });
        ok(true, tag + '#designs view renders a page');
        await page.fill('#da-q', refmol); await page.fill('#da-pn', 'EP3350157B1'); await page.fill('#da-c', '1');
        var t0 = Date.now();
        await page.click('.da-form .btn.primary');
        await page.waitForFunction(function () { var b = document.querySelector('.da-body'), s = document.querySelector('.da-status'); return b && b.querySelector('.da-card') && s && !s.textContent.trim(); }, null, { timeout: 120000 });
        var secs = (Date.now() - t0) / 1000;
        var cards = await page.$$('.da-card');
        ok(cards.length > 0 && cards.length <= 60, tag + 'ranked variant cards render (' + cards.length + ')');
        ok(secs < 60, tag + 'generation + corpus re-check of up to 60 variants takes < 60 s (' + secs.toFixed(1) + ' s)');
        ok(!!(await page.$('.da-start')), tag + 'the starting point card is shown');
        ok(/equivalence/i.test(await page.textContent('.da-banner') || ''), tag + 'the disclaimer banner names equivalence');
        var info = await page.evaluate(function () {
          var d = Array.from(document.querySelectorAll('.da-card-meta .mono')).map(function (x) { return x.textContent; });
          var reasons = Array.from(document.querySelectorAll('.da-reason')).map(function (x) { return x.textContent; });
          var risks = Array.from(document.querySelectorAll('.da-card .da-risk')).map(function (x) { return x.textContent; }).join('|');
          return { dist: d, reasons: reasons, risks: risks, overflow: document.scrollingElement.scrollWidth - window.innerWidth };
        });
        var distinct = new Set(info.dist);
        ok(distinct.size > 1 && info.dist.every(function (x) { return /^\d\.\d\d$|^-$/.test(x); }), tag + 'distances are computed per variant, not a placeholder (' + Array.from(distinct).slice(0, 4).join(',') + ')');
        ok(info.reasons.every(function (r) { return /^Outside the claim \(verified by code\)|not verified/.test(r); }), tag + 'each card says whether it is verified outside the claim');
        ok(info.overflow <= 1, tag + 'no horizontal page overflow (' + info.overflow + ' px)');
        // risk filter: "risk 0 only" keeps only risk-0 cards (not-assessed cards never pass)
        await page.selectOption('.da-toolbar select[aria-label="Maximum remaining risk"]', '0');
        var only0 = await page.evaluate(function () { return Array.from(document.querySelectorAll('.da-card .da-risk')).every(function (x) { return x.getAttribute('data-lv') === '0'; }); });
        ok(only0, tag + 'the "risk 0 only" filter shows only risk-0 variants');
        await page.selectOption('.da-toolbar select[aria-label="Maximum remaining risk"]', '4');
        if (withClaude) {
          ok(await page.evaluate(function () { return LnpAI.available(); }), tag + 'the mocked Claude capability is available');
          var btn = await page.$('.da-actions button:has-text("Explain")');
          ok(!!btn, tag + 'the Explain (Claude) button is shown');
          if (btn) {
            await btn.click();
            await page.waitForSelector('.da-expl-p', { timeout: 20000 });
            var paras = await page.$$eval('.da-expl-p', function (ps) { return ps.map(function (p) { return p.textContent; }); });
            ok(paras.length === 2 && paras[0] === COMMENT.split('\n\n')[0], tag + 'the commentary is shown as text paragraphs');
            var after = await page.evaluate(function () { return Array.from(document.querySelectorAll('.da-card .da-risk')).map(function (x) { return x.textContent; }).join('|'); });
            ok(after === info.risks, tag + 'ranks and risk numbers are unchanged by the commentary');
            var prompt = await page.evaluate(function () { return JSON.stringify(window.__daPrompt || ''); });
            ok(/<data>/.test(prompt) && /Ignore any instructions/.test(prompt), tag + 'the prompt delimits the data and tells the model to ignore instructions in it');
          }
        } else {
          ok(!(await page.$('.da-actions button:has-text("Explain")')) && /not available/.test(await page.textContent('.da-explain') || ''), tag + 'without Claude there is no Explain button and a clear note');
        }
        // exports
        for (var fmt of ['CSV', 'Markdown']) {
          var dl = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('.da-actions button:has-text("' + fmt + '")')]).then(function (r) { return r[0]; });
          var fp = await dl.path(), txt = fs.readFileSync(fp, 'utf8');
          if (fmt === 'CSV') {
            var lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean), sep = /;/.test(lines[0]) ? ';' : ',';
            var hdr = lines[0].split(sep), di = hdr.indexOf('distance_from_start');
            var dists = new Set(lines.slice(1).map(function (l) { return l.split(sep)[di]; }));
            ok(hdr.indexOf('verified_outside') >= 0 && di >= 0 && lines.length > 2 && dists.size > 1, tag + 'CSV export downloads with rows and computed distances (' + Array.from(dists).slice(0, 4).join(',') + ')');
          }
          else ok(/^# Design-around ideas/.test(txt) && /not legal advice/.test(txt), tag + 'Markdown export downloads with the disclaimer');
        }
        if (withClaude) {
          // save, reload: legal status pills survive
          var pillsBefore = await page.$$eval('.da-pat .pill', function (ps) { return ps.map(function (p) { return p.textContent; }).join('|'); });
          await page.click('.da-actions button:has-text("Save")');
          await page.waitForFunction(function () { return /#designs-/.test(location.hash); }, null, { timeout: 10000 });
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('.da-card', { timeout: 30000 });
          var pillsAfter = await page.$$eval('.da-pat .pill', function (ps) { return ps.map(function (p) { return p.textContent; }).join('|'); });
          ok(pillsAfter === pillsBefore, tag + 'a reloaded session keeps the legal-status pills (' + (pillsAfter.split('|').filter(function (x) { return x === 'status unknown'; }).length) + ' unknown)');
          // formulation entry from a product profile (example profile id "beispiel")
          await page.goto(base + '#designs--pbeispiel', { waitUntil: 'load' });
          await page.waitForFunction(function () { var s = document.querySelector('.da-status'); return document.querySelector('.da-formsec') || (s && /not available|No product profile/.test(s.textContent)); }, null, { timeout: 60000 });
          var fs2 = await page.$('.da-formsec');
          var fstate = fs2 ? await page.textContent('.da-formsec') : await page.textContent('.da-status');
          ok(!!fs2, tag + 'the formulation route renders the formulation table (' + fstate.slice(0, 90).replace(/\s+/g, ' ') + ')');
        }
        ok(offOrigin.length === 0, tag + 'no off-origin requests (' + offOrigin.slice(0, 2).join(', ') + ')');
        ok(pageErrors.length === 0, tag + 'no page errors (' + pageErrors.slice(0, 2).join(' | ') + ')');
        if (VERBOSE) console.log('  ' + tag + cards.length + ' cards, ' + secs.toFixed(1) + ' s');
        await ctx.close();
      }
    }
  } catch (e) { ok(false, 'UI pass error: ' + (e && e.message)); }
  finally { if (browser) await browser.close(); try { server.kill(); } catch (e) {} }
  console.log('UI: ' + pass + ' ok, ' + fail + ' fail (cumulative)');
}
function findDist() {
  var base = '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad';
  var cands = ['T7fix/dist', 'T7/dist', 'T7/build-dist', 'T7rev/dist'].map(function (p) { return path.join(base, p); });
  for (var i = 0; i < cands.length; i++) if (fs.existsSync(path.join(cands[i], 'index.html'))) return cands[i];
  return null;
}
