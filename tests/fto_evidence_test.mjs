// Tests for the app-computed evidence in the FTO chain (web/engine/fto.js, fto-render.js with x-markush.js, x-ranges.js).
//   node tests/fto_evidence_test.mjs
// Same harness style as tests/fto_test.mjs: fake LnpData / LnpSearch / LnpChem, LnpAI with a mocked sample, the real
// LnpMarkush (OpenChemLib in Node) with the curated seed records, the real LnpRanges on a small rg-1 document.
// The baseline (engines absent) is compared with the committed versions of fto.js / fto-render.js (git HEAD).
// No network, no Claude call. Exit code 1 when a check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENG = path.join(ROOT, 'web/engine');
import os from 'node:os';
const SCRATCH = process.env.FTO_EV_SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'fto-evidence-'));
process.on('exit', () => { if (!process.env.FTO_EV_SCRATCH) try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

let passed = 0, failed = 0;
function ok(cond, name, detail) { if (cond) passed++; else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, 'got ' + JSON.stringify(a).slice(0, 300) + ' want ' + JSON.stringify(b).slice(0, 300)); }
function section(t) { console.log('== ' + t); }
globalThis.self = globalThis;
const NOW = Date.parse('2026-11-10T12:00:00Z');

// ------------------------------------------------------------------------------------------------ engines
function fresh(file) { const f = path.isAbsolute(file) ? file : path.join(ENG, file); delete require.cache[require.resolve(f)]; return require(f); }
/* the committed fto.js / fto-render.js as the baseline "before" */
fs.mkdirSync(SCRATCH, { recursive: true });
const BASE = {};
for (const f of ['fto.js', 'fto-render.js']) {
  const out = path.join(SCRATCH, 'head-' + f);
  try { fs.writeFileSync(out, cp.execFileSync('git', ['show', 'HEAD:web/engine/' + f], { cwd: ROOT, maxBuffer: 1 << 26 })); BASE[f] = out; } catch (e) { BASE[f] = null; }
}
function engines(o = {}) {
  const AI = fresh('ai.js'), P = fresh('fto-prompts.js');
  const R = o.head ? fresh(BASE['fto-render.js']) : fresh('fto-render.js'), F = o.head ? fresh(BASE['fto.js']) : fresh('fto.js');
  return { AI, P, R, F };
}
const MK = fresh('x-markush.js');
const OCL = require(path.join(ROOT, 'web/vendor/openchemlib-full.js'));
const CURATED = fs.readdirSync(path.join(ROOT, 'data/seed/markush')).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/markush', f), 'utf8')));
MK.configure({ OCL, curated: CURATED });
const REC = CURATED.find((r) => r.pn === 'EP3368507B1' && r.claim === 1);
const RG = fresh('x-ranges.js');

// ------------------------------------------------------------------------------------------------ fake corpus
const SMILES = REC.ref.smiles; // ALC-0315, the reference compound of the curated record
const CT = REC.source.claimText;
const CLAIMS = {
  EP3368507B1: [{ n: 1, dep: [], text: CT }, { n: 2, dep: [1], text: 'A lipid nanoparticle comprising the compound of claim 1 and an mRNA.' }],
  EP1000008B1: [{ n: 1, dep: [], text: 'A lipid nanoparticle comprising an ionizable lipid at from 30 mol % to 40 mol % of the total lipid and a PEG-lipid.' }, { n: 2, dep: [1], text: 'The lipid nanoparticle of claim 1 having a mean diameter of 60 nm to 120 nm.' }],
  EP1000009B1: [{ n: 1, dep: [], text: 'A lipid nanoparticle comprising an ionizable lipid at 40 to 60 mol % and a PEG-lipid at 1 to 2 mol %.' }],
  US20250000006A1: [{ n: 1, dep: [], text: CT.replace('[chem]', 'as drawn') }]  // no image placeholder: no "formula missing" floor
};
const B = (o) => ({ auth: o.pn.slice(0, 2), kind: /([A-Z]\d?)$/.exec(o.pn)[1], pub: 20200101, app: 20160601, prio: 20150601, grant: 20200101, appNo: '1', fam: 2000 + o.p, title: 'TITLE ' + o.pn, assignee: 'Assignee ' + o.p, player: null, playerIdx: -1, cpc: [], tier: 1, seedTier: 0, seedFam: '', text: true, hasDefs: false, hasImg: false, hasCompounds: true, hasStatus: true, textCut: false, defsCut: false, status: 'granted', exp: 20360601, deIn: 1, wo: '', ...o });
const PATS = [B({ p: 0, pn: 'EP3368507B1' }), B({ p: 1, pn: 'EP1000008B1' }), B({ p: 2, pn: 'EP1000009B1' }), B({ p: 3, pn: 'US20250000006A1', status: 'pending', grant: 0 })];
const ST = (code) => ({ src: 'ep-register', asof: '2026-08-23', code, text: code, expiry_est: '2036-06-01', lapsed_in: [], in_force_de: true, events: [] });
const STATUS = { EP3368507B1: ST('granted'), EP1000008B1: ST('granted'), EP1000009B1: ST('granted'), US20250000006A1: { src: 'us-calc', asof: '2026-11-10', code: 'pending', text: 'pending application', expiry_est: '2036-06-01', events: [] } };
function fake() {
  const data = {
    manifest: { snapshots: { ep_register: '2026-08-23', ep_text: '2026-11-10', us_text: '2026-11-10', corpus: 'T' }, counts: { patents: PATS.length }, x: { ranges: { v: 'rg-1', built: '2026-11-11T22:20:40Z' } } },
    patent: async (p) => ({ ...PATS[p] }), patents: async (ps) => ps.map((p) => (PATS[p] ? { ...PATS[p] } : null)),
    byPn: async (s) => PATS.findIndex((x) => x.pn === String(s).replace(/[\s,]/g, '')), family: async (p) => [p], status: async (p) => STATUS[PATS[p].pn] || null
  };
  const search = {
    claims: async (p) => (CLAIMS[PATS[p].pn] || []).map((c) => ({ n: c.n, lang: 'en', indep: !c.dep.length, dep: c.dep, text: c.text, children: [], roots: [] })),
    defs: async () => [], claimImages: async () => [],
    // the text route finds only the two range patents; the Markush patent is found by the Markush route alone
    search: async (q, so = {}) => { if (q === '') return { total: 0, hits: [], parsed: { warnings: [] } }; const ps = PATS.filter((x) => x.p === 1 || x.p === 2); return { total: ps.length, hits: ps.map((x, i) => ({ p: x.p, score: 5 - i, best: { n: 1, field: 'claim' } })), parsed: { warnings: [] } }; }
  };
  const chem = {
    parse: async (q) => (q === SMILES || q === 'ALC-0315' ? { ok: true, kind: q === SMILES ? 'smiles' : 'name', name: 'ALC-0315', smiles: SMILES, idcode: 'IDX', formula: 'C48H95NO5', mw: 766.3 } : { ok: false, error: 'unknown' }),
    descriptors: async () => ({ formula: 'C48H95NO5', mw: 766.3, tails: [], linkers: [] }), names: async () => [], search: async () => Object.assign([], { total: 0 })
  };
  return { data, search, chem };
}
function memStore() {
  const m = new Map();
  return { m, init: async () => ({ backend: 'memory' }), get: async (k, id) => (m.has(k + '/' + id) ? JSON.parse(m.get(k + '/' + id)) : null), put: async (k, id, o) => { m.set(k + '/' + id, JSON.stringify(o)); return true; },
    remove: async (k, id) => { m.delete(k + '/' + id); return true; }, list: async (k) => [...m.entries()].filter(([key]) => key.startsWith(k + '/')).map(([key, v]) => ({ id: key.slice(k.length + 1), ...JSON.parse(v) })) };
}
const FORM = { name: 'Evidence test LNP', lipids: [{ role: 'ionizable', name: 'ALC-0315', smiles: SMILES, molPct: 46.3 }, { role: 'helper', name: 'DSPC', molPct: 9.4 }, { role: 'sterol', name: 'cholesterol', molPct: 42.7 }, { role: 'peg', name: 'ALC-0159', molPct: 1.6, pegMw: 2000 }],
  ratioBasis: 'nominal', np: 6, payload: { type: 'mRNA' }, particle: { sizeNm: 80, pdi: 0.1 }, process: { mixing: 'T-junction' }, markets: ['DE', 'EP', 'US'], launchDate: '2029-01-01' };

// ------------------------------------------------------------------------------------------------ rg-1 fixture
const XSS = '<script>alert(1)</script>';
function rgDoc() {
  const params = ['mol_pct', 'molar_ratio', 'weight_ratio', 'wt_pct', 'np_ratio', 'size_nm', 'pdi', 'pka', 'encaps_pct', 'temp_c', 'ph', 'chain_c', 'peg_mw', 'conc'].map((id) => ({ id, label: id.replace('_', ' '), unit: { mol_pct: 'mol%', size_nm: 'nm', peg_mw: 'Da', conc: 'mg/mL', temp_c: 'C', wt_pct: 'wt%' }[id] || '' }));
  const pidx = {}; params.forEach((p, i) => { pidx[p.id] = i; });
  const R = { pi: [], claim: [], dep: [], param: [], comp: [], lo: [], hi: [], loInc: [], hiInc: [], unit: [], approx: [], q: [], off: [], ml: [] };
  const add = (pi, claim, dep, param, comp, lo, hi, q) => { R.pi.push(pi); R.claim.push(claim); R.dep.push(dep); R.param.push(pidx[param]); R.comp.push(comp); R.lo.push(lo); R.hi.push(hi); R.loInc.push(1); R.hiInc.push(1); R.unit.push(params[pidx[param]].unit); R.approx.push(0); R.q.push(q); R.off.push(10); R.ml.push(5); };
  // EP1000008B1: claim 1 ionizable 30-40 mol % (product 46.3: outside), claim 2 (dep 1) size 60-120 nm (inside)
  add(0, 1, '', 'mol_pct', 0, 30, 40, 'an ionizable lipid at from 30 mol % to 40 mol % ' + XSS); add(0, 2, '1', 'size_nm', -1, 60, 120, 'a mean diameter of 60 nm to 120 nm');
  // EP1000009B1: claim 1 ionizable 40-60 and PEG 1-2 mol % (both inside)
  add(1, 1, '', 'mol_pct', 0, 40, 60, 'an ionizable lipid at 40 to 60 mol %'); add(1, 1, '', 'mol_pct', 1, 1, 2, 'a PEG-lipid at 1 to 2 mol %');
  return { v: 'rg-1', params, comps: ['ionizable / cationic lipid', 'PEG lipid', 'sterol', 'phospholipid / helper lipid', 'payload / nucleic acid', 'total'], compIds: ['ionizable_cationic', 'peg', 'sterol', 'phospholipid_helper', 'payload', 'total'], compFallback: [5],
    compAlias: { ionizable: 'ionizable_cationic', cationic: 'ionizable_cationic', helper: 'phospholipid_helper', peg: 'peg', sterol: 'sterol' }, win: { lead: 40, max: 140 }, pn: ['EP1000008B1', 'EP1000009B1'], lang: ['en', 'en'], chain: { 0: '2<1' }, rows: R };
}

// ------------------------------------------------------------------------------------------------ canned model output
const feat = (id, quote, verdict) => ({ feature_id: id, claim_quote: quote, paraphrase: 'p', auslegung: { definition_quote: null, definition_para: null, weite_auslegung: 'broad', enge_auslegung: null, ergebnis_abhaengig_von_auslegung: false },
  product_refs: ['P1'], product_value: 'v', verdict, begruendung: 'Reasoning ' + id, annahme: null, klaerung: verdict === 'unklar' ? 'Measurement' : null, konfidenz: 'hoch' });
const claimObj = (no, merkmale, literal) => ({ claim_no: no, kategorie: 'stoff', betroffene_akte: ['herstellen'], merkmale, literal_ergebnis: literal, tragende_merkmale: merkmale.filter((m) => m.verdict === 'nicht_erfuellt').map((m) => m.feature_id), robustheit: 'robust', konfidenz: 'mittel' });
const gesamt = (risiko) => ({ literal_ergebnis_schlechtester_fall: 'wortsinngemaess_moeglich', kritischster_anspruch: 1, risiko, risiko_begruendung: 'because', modifikatoren: [], rolle_des_nutzers: { unmittelbar: 'ja', mittelbar_par10_patg_oder_271bc: 'offen', erlaeuterung: 'Role' },
  ausnahmen: { versuchsprivileg_par11_nr2: 'offen', zulassungsprivileg_par11_nr2b: 'ja', us_safe_harbor_271e1: 'entfaellt', kipppunkt: 'k', erlaeuterung: 'A' }, umgehungsloesungen: [], offene_fragen: ['Question?'], fuer_unteransprueche: [], konfidenz: 'mittel', hinweise: [] });
const chartObj = (id, claims, g) => ({ schema_version: 'cc-1', patent_id: id, jurisdiction: id.slice(0, 2), claims_version: 'as granted', textqualitaet: { quelle: 'original', probleme: [] }, claims, gesamt: g });
const q = (t, a, b) => t.slice(a, b).trim();
/* the model under-rates the Markush patent: a verified quote marked "not met" and risk "low" */
const CHARTS = {
  EP3368507B1: () => chartObj('EP3368507B1', [claimObj(1, [feat('M1', q(CT, 0, 40), 'erfuellt'), feat('M2', 'R1 and R2 are each independently C6-C24 alkyl or C6-C24 alkenyl', 'nicht_erfuellt')], 'wortsinngemaess_nicht_erfuellt')], gesamt('2_gering')),
  US20250000006A1: () => chartObj('US20250000006A1', [claimObj(1, [feat('M1', q(CT, 0, 40), 'erfuellt'), feat('M2', 'R1 and R2 are each independently C6-C24 alkyl or C6-C24 alkenyl', 'nicht_erfuellt')], 'wortsinngemaess_nicht_erfuellt')], gesamt('2_gering')),
  EP1000008B1: () => chartObj('EP1000008B1', [claimObj(1, [feat('M1', 'A lipid nanoparticle comprising an ionizable lipid', 'erfuellt'), feat('M2', 'from 30 mol % to 40 mol % of the total lipid', 'unklar')], 'wortsinngemaess_moeglich')], gesamt('4_hoch')),
  EP1000009B1: () => chartObj('EP1000009B1', [claimObj(1, [feat('M1', 'A lipid nanoparticle comprising an ionizable lipid at 40 to 60 mol %', 'erfuellt'), feat('M2', 'a PEG-lipid at 1 to 2 mol %', 'erfuellt')], 'wortsinngemaess_erfuellt')], gesamt('5_sehr_hoch'))
};
const rtObj = (id, risiko, nos) => ({ schema_version: 'rt-1', patent_id: id, claims: nos.map((n) => ({ claim_no: n, vollstaendigkeit: { fehlende_merkmale: [], zitatfehler: [], uebersehene_alternativen: [] }, angriffe: [], gegenfehler: [], literal_ergebnis_revidiert: 'wortsinngemaess_nicht_erfuellt' })),
  weitere_angriffswege: [], ausnahmen_pruefung: [], revidiert: { risiko, eskalation: false, herabstufung_wegen_fehler: false, begruendung: 'rt' }, zu_klaeren: [], konfidenz: 'mittel' });
const opObj = (ids) => ({ schema_version: 'op-1', output_language: 'en', titel: 'T', gesamtrisiko: [], zusammenfassung: 'S', gegenstand: 'G', recherche: 'R', einzelbewertungen: ids.map((id) => ({ patent_id: id, risiko: '3_mittel', kurzfazit: 'K', text: 'T' })), anhaengige_anmeldungen: '', querschnitt: '', zeitachse: [], ausnahmen: '', umgehungsloesungen: [], gegenpruefung: '', offene_fragen: [], naechste_schritte: [] });
/* per-test overrides of the canned model: triage class per patent, B step failing for a patent */
const HOOK = { rel: {}, bFail: new Set() };
function makeMock() {
  const calls = [];
  const fn = async (input) => {
    const prompt = Array.isArray(input) ? input[0].content : input;
    const step = (/\n\nSTEP ([ATBCED]) /.exec(prompt) || [])[1] || '?', id = (/<biblio>\{"patent_id":"([^"]+)"/.exec(prompt) || [])[1] || null;
    calls.push({ step, id });
    switch (step) {
      case 'T': { const ids = [...prompt.matchAll(/<patent id="([^"]+)"/g)].map((m) => m[1]); return { schema_version: 'tr-1', ergebnisse: ids.map((x) => ({ patent_id: x, relevanz: HOOK.rel[x] || 'A', anspruch_naechstliegend: 1, entscheidendes_merkmal: null, grund: 'G ' + x, markush_pruefung_noetig: false, konfidenz: 'mittel' })) }; }
      case 'B': if (HOOK.bFail.has(id)) throw Object.assign(new Error('mock failure'), { code: 'bad_output' }); return CHARTS[id]();
      case 'C': return { schema_version: 'da-1', patent_id: id, abhaengigkeiten: [], unteransprueche: [], rueckzugspositionen: [], auslegungshinweise: [], revision_empfohlen: [], konfidenz: 'mittel' };
      case 'E': return rtObj(id, '1_sehr_gering', [...prompt.matchAll(/<claim no="(\d+)" independent="true"/g)].map((m) => Number(m[1])));
      case 'D': { const ids = [...new Set([...prompt.slice(prompt.lastIndexOf('<digests>[')).matchAll(/"patent_id":"([^"]+)"/g)].map((m) => m[1]))]; return opObj(ids); }
      default: return 'plain';
    }
  };
  return { fn, calls };
}
/* opt.ev: true = evidence engines on, false = configured off; opt.head = committed fto.js */
function setup(opt = {}) {
  const E = engines({ head: opt.head }), f = fake(), store = opt.store || memStore(), mock = makeMock();
  E.AI.mock(mock.fn, { limits: { maxPromptBytes: 262144 } }); E.AI.configure({ search: f.search, data: f.data });
  const c = { data: f.data, search: f.search, chem: f.chem, store, ai: E.AI, prompts: E.P, render: E.R, now: () => NOW };
  if (!opt.head) { c.markush = opt.ev ? MK : false; c.ranges = opt.ev ? RG : false; }
  E.F.configure(c);
  return { ...E, f, store, mock };
}
async function profileOf(S) { const save = S.AI; S.F.configure({ ai: { init: async () => false } }); const p = await S.F.normalizeProfile(FORM, {}); S.F.configure({ ai: save }); return p; }
/* new engines without any markush / ranges key in configure(): the globals decide (deleted by withoutGlobals) */
function setupNoKeys() {
  const E = engines(), f = fake(), mock = makeMock();
  E.AI.mock(mock.fn, { limits: { maxPromptBytes: 262144 } }); E.AI.configure({ search: f.search, data: f.data });
  E.F.configure({ data: f.data, search: f.search, chem: f.chem, store: memStore(), ai: E.AI, prompts: E.P, render: E.R, now: () => NOW });
  return { ...E, f, mock };
}
const strip = (op) => { const o = JSON.parse(JSON.stringify(op)); delete o.created; delete o.finished; delete o.usage; delete o.run; if (o.profile && o.profile._app) delete o.profile._app.created; return o; };
const withoutGlobals = async (fn) => { const a = globalThis.LnpMarkush, b = globalThis.LnpRanges; delete globalThis.LnpMarkush; delete globalThis.LnpRanges; try { return await fn(); } finally { globalThis.LnpMarkush = a; globalThis.LnpRanges = b; } };

async function main() {
  await MK.ready();
  await RG.init({ json: rgDoc() });

  section('1 candidates: code-verified Markush route from curated records');
  const S = setup({ ev: true }), profile = await profileOf(S);
  ok(profile._app.lipids[0].ok && profile._app.lipids[0].smiles === SMILES, 'profile carries the ALC-0315 structure');
  const cands = await S.F.candidates(profile, {});
  const mc = cands.find((c) => c.pn === 'EP3368507B1');
  ok(mc && mc.routes.includes('markush'), 'curated record covering the profile lipid adds the patent with route "markush"', JSON.stringify(cands.map((c) => [c.pn, c.routes])));
  ok(mc && mc.why.includes('Markush check: ALC-0315 covered by claim 1 (code-verified, translation reviewed)'), 'why text names the claim and the review state', mc && mc.why.join(' | '));
  const mr = cands.record.markush;
  ok(mr && mr.records === CURATED.length && mr.lipids === 1 && mr.checked === CURATED.length && mr.covered.length === 1 && mr.covered[0].pn === 'EP3368507B1' && mr.covered[0].reviewed === true, 'search record holds the Markush route (records, checks, covered)', JSON.stringify(mr));
  ok(!cands.find((c) => c.pn === 'US20250000006A1'), 'no record for a publication -> no Markush hit for it');
  // unreviewed Claude translation
  const recC = { ...JSON.parse(JSON.stringify(REC)), origin: 'claude', reviewed: false }; await MK.put(recC);
  const cU = (await S.F.candidates(profile, {})).find((c) => c.pn === 'EP3368507B1');
  ok(cU && cU.why.some((w) => w === 'Markush check: ALC-0315 covered by claim 1 (code-verified, translation not reviewed)'), 'unreviewed Claude translation: why says "translation not reviewed"', cU && cU.why.join(' | '));
  // unclear result: an unsupported part naming no variable keeps "covered" at "unclear"
  const recQ = { ...JSON.parse(JSON.stringify(REC)), origin: 'manual', unsupported: ['a condition the schema cannot express'] }; await MK.put(recQ);
  const cQ = await S.F.candidates(profile, {});
  ok(!cQ.find((c) => c.pn === 'EP3368507B1') && cQ.record.markush.unclear.length === 1 && cQ.record.markush.covered.length === 0, 'unclear result adds no weight and no patent; it is recorded', JSON.stringify(cQ.record.markush));
  await MK.remove('EP3368507B1', 1);
  const S0 = setup({ ev: false }), cands0 = await S0.F.candidates(await profileOf(S0), {});
  ok(!cands0.find((c) => c.pn === 'EP3368507B1') && cands0.record.markush === undefined, 'engine off: no Markush route, no record key');

  section('2 risk floors from Markush evidence (raised, never lowered)');
  const op = await S.F.run(profile, { patents: cands, depth: 'quick', persist: false });
  const pm = op.patents.find((p) => p.pn === 'EP3368507B1');
  ok(pm && pm.app && pm.app.evidence && pm.app.evidence.markush.results.some((r) => r.claim === 1 && r.overall === 'covered' && r.reviewed), 'charted patent carries app.evidence.markush with the covered result');
  const g1 = pm.app.evidence.markush.results[0].groups;
  ok(g1.length > 3 && g1.every((g) => g.name && g.verdict && 'quote' in g) && g1.some((g) => g.quoteStatus === 'ok'), 'per-variable verdicts with verbatim quotes and quote states', JSON.stringify(g1.slice(0, 2)));
  ok(pm.chart.app.risk_model === '2_gering' && pm.risk.final === '5_sehr_hoch' && pm.risk.b === '5_sehr_hoch', 'reviewed covered on an independent claim of a granted in-force right -> floor 5 (as literally met)', JSON.stringify(pm.risk));
  ok(pm.flags.includes('markush_covered') && pm.flags.includes('markush_contradicts_chart'), 'flags markush_covered and markush_contradicts_chart', pm.flags.join(','));
  ok(pm.chart.app.notes.some((n) => /^Risk raised from cannot be assessed to very high \(5\): Markush check: ALC-0315 covered by claim 1/.test(n)), 'the raise is explained in the app notes');
  ok(pm.chart.claims[0].app.literal === 'wortsinngemaess_nicht_erfuellt' && pm.chart.claims[0].merkmale[1].app.verdict === 'nicht_erfuellt', 'feature verdicts are not changed by the evidence');
  ok(pm.digest && pm.digest.offene_fragen.some((x) => /code-verified Markush check/.test(x)), 'question for counsel reaches the digest');
  // standard depth: the red team argues "very low", the floor holds
  const opS = await S.F.run(profile, { patents: cands.filter((c) => c.pn === 'EP3368507B1'), depth: 'standard', persist: false });
  ok(opS.patents[0].risk.e === '1_sehr_gering' && opS.patents[0].risk.final === '5_sehr_hoch', 'red team "very low" does not undo the floor', JSON.stringify(opS.patents[0].risk));
  // unreviewed translation -> at least "possible" (medium)
  await MK.put(recC);
  const opU = await S.F.run(profile, { patents: ['EP3368507B1'], depth: 'quick', persist: false });
  ok(opU.patents[0].risk.final === 'nicht_beurteilbar' && opU.patents[0].flags.includes('markush_covered_unreviewed') && opU.patents[0].app.evidence.applied.some((a) => a.rule === 'markush_covered_unreviewed' && a.to === 'nicht_beurteilbar'), 'unreviewed covered: floor medium (3) does not replace "cannot be assessed" (formula image missing)', JSON.stringify(opU.patents[0].risk));
  const uC = { claims: [], app: { risk: '2_gering', notes: [] } }, eU = { right: { granted: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 1, lipid: 'X', overall: 'covered', reviewed: false }] }, ranges: null, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(uC, eU, { byNo: { 1: { indep: true } } });
  ok(uC.app.risk === '3_mittel' && eU.flags.includes('markush_covered_unreviewed'), 'unreviewed covered on a low chart -> floor medium (3)');
  // application with a reviewed record -> floor as "a claim of the application reads on the product" (3)
  await MK.remove('EP3368507B1', 1);
  await MK.put({ ...JSON.parse(JSON.stringify(REC)), pn: 'US20250000006A1', origin: 'manual' });
  const opA = await S.F.run(profile, { patents: ['US20250000006A1'], depth: 'quick', persist: false });
  ok(opA.patents[0].risk.final === '3_mittel' && opA.patents[0].app.evidence.applied.some((a) => a.rule === 'markush_covered_reviewed' && a.to === '3_mittel'), 'pending application: floor medium (3)', JSON.stringify(opA.patents[0].risk));
  await MK.remove('US20250000006A1', 1);
  // a floor below the current risk changes nothing
  const fakeChart = { claims: [], app: { risk: '5_sehr_hoch', notes: [] } }, eFake = { right: { granted: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 1, lipid: 'X', overall: 'covered', reviewed: false }] }, ranges: null, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(fakeChart, eFake, { byNo: { 1: { indep: true } } });
  ok(fakeChart.app.risk === '5_sehr_hoch' && eFake.app.evidence.applied[0].to === '5_sehr_hoch', 'applyEvidence never lowers (5 stays 5 with an unreviewed hit)');
  const nb = { claims: [], app: { risk: 'nicht_beurteilbar', notes: [] } }, eNb = { right: { granted: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 1, lipid: 'X', overall: 'unclear', reviewed: true }, { claim: 2, lipid: 'X', overall: 'not_covered', reviewed: true }] }, ranges: null, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(nb, eNb, { byNo: { 1: { indep: true }, 2: { indep: true } } });
  ok(nb.app.risk === 'nicht_beurteilbar' && !eNb.flags.length, '"unclear" and "not covered" Markush results change nothing (cannot be assessed stays)');
  const dep = { claims: [], app: { risk: '2_gering', notes: [] } }, eDep = { right: { granted: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 2, lipid: 'X', overall: 'covered', reviewed: true }] }, ranges: null, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(dep, eDep, { byNo: { 2: { indep: false } } });
  ok(dep.app.risk === '2_gering' && /not an independent claim/.test(eDep.app.evidence.applied[0].text), 'covered on a dependent claim: flag only, no floor');
  const dead = { claims: [], app: { risk: '2_gering', notes: [] } }, eDead = { right: { granted: true, dead: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 1, lipid: 'X', overall: 'covered', reviewed: true }] }, ranges: null, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(dead, eDead, { byNo: { 1: { indep: true } } });
  ok(dead.app.risk === '2_gering', 'right not in force: no floor');

  section('3 ranges: per-claim evidence, outside never lowers the risk');
  const p8 = op.patents.find((p) => p.pn === 'EP1000008B1'), p9 = op.patents.find((p) => p.pn === 'EP1000009B1');
  const op0 = await S0.F.run(profile, { patents: cands, depth: 'quick', persist: false });
  const p8b = op0.patents.find((p) => p.pn === 'EP1000008B1'), p9b = op0.patents.find((p) => p.pn === 'EP1000009B1');
  const rc1 = p8.app.evidence.ranges.claims.find((c) => c.claim === 1), rc2 = p8.app.evidence.ranges.claims.find((c) => c.claim === 2);
  const v1 = rc1 && rc1.values.find((v) => v.param === 'mol_pct' && /ionizable/.test(v.comp));
  ok(v1 && v1.status === 'outside' && v1.range === '30 to 40 mol%' && v1.quote && v1.quote.includes('30 mol % to 40 mol %') && rc1.verdict === 'outside', 'claim 1: ionizable 46.3 mol % outside 30-40, with the verbatim quote', JSON.stringify(rc1));
  const v2 = rc2 && rc2.values.find((v) => v.param === 'size_nm');
  ok(v2 && v2.status === 'inside' && rc2.values.find((v) => v.param === 'mol_pct' && /ionizable/.test(v.comp)).status === 'outside' && rc2.verdict === 'partial', 'claim 2 (dependent): size inside, inherited ionizable range outside', JSON.stringify(rc2 && rc2.values.map((v) => [v.param, v.comp, v.status])));
  ok(p8.flags.includes('range_outside') && p8.app.evidence.questions.some((x) => /^Claim 1: product value 46.3 mol% .* is outside the claimed range 30 to 40 mol%.*Not used to lower the risk/.test(x)), 'flag range_outside and a question for counsel', JSON.stringify(p8.app.evidence.questions));
  ok(p8.risk.final === p8b.risk.final && p8.risk.final === '4_hoch' && p8.chart.app.risk === p8b.chart.app.risk, 'outside range: risk identical to the run without evidence (high stays high)', p8.risk.final + ' vs ' + p8b.risk.final);
  ok(p9.flags.includes('ranges_all_inside') && p9.app.evidence.ranges.claims[0].verdict === 'all_inside' && p9.risk.final === p9b.risk.final, 'all values inside: flag ranges_all_inside, no risk change');
  ok(p8.app.evidence.limits.some((l) => /pattern rules/.test(l)) && p8.app.evidence.limits.some((l) => /never lowers a risk/.test(l)), 'evidence carries the verbatim limits (ranges + app)');
  // a "low" chart with an outside range stays low; a value outside never turns "unclear" into "not met"
  ok(p8.chart.claims[0].merkmale[1].app.verdict === 'unklar', '"unclear" feature stays "unclear" next to an outside range');
  const lowC = { claims: [], app: { risk: '2_gering', notes: [] } }, eLow = { right: { granted: true }, flags: [], app: { evidence: { markush: null, ranges: { claims: [{ claim: 1, indep: true, verdict: 'outside', values: [{ param: 'mol_pct', label: 'mol', value: 46, unit: 'mol%', status: 'outside', range: '30 to 40' }] }] }, applied: [], flags: [], questions: [] } } };
  S.F.applyEvidence(lowC, eLow, { byNo: { 1: { indep: true } } });
  ok(lowC.app.risk === '2_gering' && eLow.flags.includes('range_outside'), 'range evidence alone never changes the risk level');

  section('4 opinion id reflects the evidence inputs');
  const st1 = memStore(), A1 = setup({ ev: true, store: st1 });
  const opP1 = await A1.F.run(profile, { patents: cands, depth: 'quick' });
  const opP2 = await A1.F.run(profile, { patents: cands, depth: 'quick' });
  ok(opP1.id === opP2.id && opP2.run.resumedSteps > 0, 'same inputs -> same id, saved steps reused', opP1.id + ' ' + opP2.id);
  await MK.put({ ...JSON.parse(JSON.stringify(REC)), origin: 'manual' });
  const opP3 = await A1.F.run(profile, { patents: cands, depth: 'quick' });
  ok(opP3.id !== opP1.id, 'a changed Markush record (id + updated) -> new opinion id', opP3.id);
  await MK.remove('EP3368507B1', 1);
  const opP4 = await A1.F.run(profile, { patents: cands, depth: 'quick' });
  ok(opP4.id === opP1.id, 'record removed again -> the original id');
  A1.f.data.manifest.x.ranges.built = '2026-12-01T00:00:00Z';
  const opP5 = await A1.F.run(profile, { patents: cands, depth: 'quick' });
  ok(opP5.id !== opP1.id, 'a rebuilt range dataset -> new opinion id');
  const evIn = await S.F.evidenceInputs({});
  ok(evIn && evIn.markush.length === CURATED.length && evIn.ranges.built === '2026-11-11T22:20:40Z', 'evidenceInputs lists record ids + updated and the range build', JSON.stringify(evIn).slice(0, 200));

  section('5 rendering: evidence block, escaping, limits');
  if (process.env.FTO_DUMP_OPINION) fs.writeFileSync(process.env.FTO_DUMP_OPINION, JSON.stringify(op, null, 1));
  const md = S.F.render(op, 'md'), html = S.F.render(op, 'html'), js = JSON.parse(S.F.render(op, 'json'));
  ok((md.match(/#### Evidence computed by the app/g) || []).length === op.patents.length, 'md: one evidence block per charted patent');
  ok(md.includes('Markush check (code-verified; stored and curated records)') && md.includes('| 1 | ALC-0315 | covered | reviewed |') && md.includes('Numeric ranges in the claims (compared by code)'), 'md: Markush table and range table');
  ok(md.includes('Limits of this evidence') && md.includes('- Pre-screening, not legal advice.') && md.includes('Ranges were found by pattern rules in the claim text'), 'md: verbatim limits of the evidence');
  ok(md.includes('Markush route (stored and curated records, code-verified)'), 'md: Markush route in the search record');
  ok(md.startsWith(op.limits) && md.endsWith(op.limits), 'md: still starts and ends with the limits block');
  ok(html.includes('<h4>Evidence computed by the app</h4>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !/<script/i.test(html), 'html: evidence block, the quote with markup is escaped');
  ok(html.includes('product value outside a claimed range (risk not lowered)'), 'html: flag label in English');
  const jp = js.patents.find((p) => p.pn === 'EP1000008B1');
  ok(js.hinweis === op.limits && jp.app.evidence.ranges.claims.length === 2 && jp.app.evidence.limits.length > 3, 'json: evidence with limits in the patent entry');
  const one = await S.F.chartOne(profile, 'EP1000008B1', {});
  ok(one.app && one.app.evidence && one.flags.includes('range_outside') && one.risk.final === '4_hoch', 'chartOne attaches the same evidence');

  section('6 engines absent: behaviour identical to before');
  if (!BASE['fto.js'] || !BASE['fto-render.js']) ok(false, 'git HEAD versions of fto.js / fto-render.js readable');
  else {
    let lastPlain = null;
    await withoutGlobals(async () => {
      for (const variant of ['configured off', 'globals absent']) {
        const H = setup({ head: true }), N = variant === 'configured off' ? setup({ ev: false }) : setupNoKeys();
        const pH = await profileOf(H), pN = await profileOf(N);
        eq(strip(pN), strip(pH), variant + ': profile identical');
        const cH = await H.F.candidates(pH, {}), cN = await N.F.candidates(pN, {});
        eq({ l: cN, r: cN.record }, { l: cH, r: cH.record }, variant + ': candidates and search record identical');
        const oH = await H.F.run(pH, { patents: cH, depth: 'standard' }), oN = await N.F.run(pN, { patents: cN, depth: 'standard' });
        lastPlain = oN;
        ok(oH.id === oN.id, variant + ': opinion id identical (' + oH.id + ')');
        eq(strip(oN), strip(oH), variant + ': opinion identical');
        ok(N.F.render(oN, 'md') === H.F.render(oH, 'md') && N.F.render(oN, 'json') === H.F.render(oH, 'json'), variant + ': md / json identical (the HTML design differs from HEAD on purpose)');
        eq(N.mock.calls, H.mock.calls, variant + ': same model calls');
        const xH = await H.F.chartOne(pH, 'EP1000008B1', {}), xN = await N.F.chartOne(pN, 'EP1000008B1', {});
        eq(strip(xN), strip(xH), variant + ': chartOne identical');
      }
    });
    ok(lastPlain && !S.F.render(lastPlain, 'md').includes('Evidence computed by the app') && S.F.render(op, 'md').includes('Evidence computed by the app'), 'renderer: the evidence block appears only when evidence exists');
  }
  section('7 code-verified Markush hit: not dropped by triage, depth or a failed model step');
  {
    const S7 = setup({ ev: true }), pr7 = await profileOf(S7), c7 = await S7.F.candidates(pr7, {});
    const reset = () => { HOOK.rel = {}; HOOK.bFail = new Set(); };
    try {
      // triage C from the model for the Markush patent
      HOOK.rel = { EP3368507B1: 'C' };
      const o1 = await S7.F.run(pr7, { patents: c7, depth: 'quick', persist: false });
      const m1 = o1.patents.find((p) => p.pn === 'EP3368507B1');
      ok(m1 && !o1.notCharted.some((n) => n.pn === 'EP3368507B1'), 'triage C does not drop a code-verified covered right', JSON.stringify(o1.notCharted.map((n) => [n.pn, n.reason])));
      ok(m1 && m1.rel === 'B' && /^Triage C overridden by the code result \(ALC-0315 covered by claim 1 \(code-verified, translation reviewed\)\); model reason: G EP3368507B1$/.test(m1.relWhy) && m1.flags.includes('triage_c_ueberstimmt'), 'relevance raised to B; the model verdict is kept in the reason', m1 && m1.relWhy);
      ok(m1 && m1.risk.final === '5_sehr_hoch' && m1.flags.includes('markush_covered'), 'floor 5 applies after a triage C', JSON.stringify(m1 && m1.risk));
      ok(o1.search.triage.C === 0 && o1.search.triage.B === 1, 'triage counts show the final classes', JSON.stringify(o1.search.triage));
      ok(S7.F.render(o1, 'md').includes('triage C overridden by a code-verified Markush hit'), 'md: flag label for the override');
      // depth limit smaller than the candidate count; the Markush patent sorts last by triage
      HOOK.rel = { EP3368507B1: 'B' };
      const save = S7.F.DEPTH.quick.n; S7.F.DEPTH.quick.n = 1;
      let o2; try { o2 = await S7.F.run(pr7, { patents: c7, depth: 'quick', persist: false }); } finally { S7.F.DEPTH.quick.n = save; }
      const cut2 = o2.notCharted.filter((n) => n.reason === 'depth_limit').map((n) => n.pn);
      ok(o2.patents[0] && o2.patents[0].pn === 'EP3368507B1' && o2.patents[0].risk.final === '5_sehr_hoch', 'depth 1: the code-verified hit is analysed first', JSON.stringify(o2.patents.map((p) => p.pn)));
      ok(o2.patents.length === 1 && cut2.length === c7.length - 1 && !cut2.includes('EP3368507B1'), 'depth 1: only the other rights are cut', JSON.stringify(cut2));
      reset();
      // B step fails: the code floor still applies
      HOOK.bFail = new Set(['EP3368507B1']);
      const o3 = await S7.F.run(pr7, { patents: ['EP3368507B1'], depth: 'quick', persist: false }), m3 = o3.patents[0];
      ok(m3 && m3.failed && m3.flags.includes('analyse_fehlgeschlagen') && m3.risk.final === '5_sehr_hoch' && m3.risk.b === '5_sehr_hoch', 'B step failed: floor 5 from the reviewed Markush hit', JSON.stringify(m3 && m3.risk));
      ok(m3 && m3.flags.includes('markush_covered') && m3.app.evidence.applied.some((a) => a.rule === 'markush_covered_reviewed' && a.from === 'nicht_beurteilbar' && a.to === '5_sehr_hoch'), 'B step failed: flag and applied rule recorded', JSON.stringify(m3 && m3.app.evidence.applied));
      ok(S7.F.render(o3, 'md').includes('Rules applied'), 'B step failed: the rule is shown in the report');
      const one3 = await S7.F.chartOne(pr7, 'EP3368507B1', {});
      ok(one3.failed && one3.risk.final === '5_sehr_hoch' && one3.flags.includes('markush_covered'), 'chartOne, B step failed: floor 5', JSON.stringify(one3.risk));
      reset();
      // no claim text in the corpus (claim set empty): independence cannot be checked, floor as a precaution
      const keep = CLAIMS.EP3368507B1; CLAIMS.EP3368507B1 = [];
      let o4; try { o4 = await S7.F.run(pr7, { patents: ['EP3368507B1'], depth: 'quick', persist: false }); } finally { CLAIMS.EP3368507B1 = keep; }
      const m4 = o4.patents[0];
      ok(m4 && m4.failed && m4.failed.code === 'no_claims' && m4.risk.final === '5_sehr_hoch' && m4.app.evidence.applied.some((a) => /cannot be checked \(no claim text in the corpus\), floor applied as a precaution/.test(a.text)), 'no claim text: floor 5 as a precaution, stated in the rule text', JSON.stringify(m4 && [m4.risk, m4.app.evidence.applied]));
      // patent flagged as biblio-only: not dropped by the text gate
      PATS[0].text = false; CLAIMS.EP3368507B1 = [];
      let o5; try { o5 = await S7.F.run(pr7, { patents: ['EP3368507B1'], depth: 'quick', persist: false }); } finally { PATS[0].text = true; CLAIMS.EP3368507B1 = keep; }
      ok(o5.patents[0] && o5.patents[0].risk.final === '5_sehr_hoch' && !o5.notCharted.length, 'biblio-only right with a code-verified hit is kept with its floor', JSON.stringify(o5.notCharted));
      // dead right: no floor even when the chart fails
      const fe = { right: { granted: true, dead: true }, flags: [], app: { evidence: { markush: { results: [{ claim: 1, lipid: 'X', overall: 'covered', reviewed: true }] }, ranges: null, applied: [], flags: [], questions: [] } } };
      const fc = { claims: [], app: { risk: 'nicht_beurteilbar', notes: [] } }; S7.F.applyEvidence(fc, fe, null);
      ok(fc.app.risk === 'nicht_beurteilbar', 'no claim set and right not in force: no floor');
      // AI not available: the code result is listed per patent under "not analysed"
      const S8 = setup({ ev: true }); S8.F.configure({ ai: { init: async () => false } });
      const o6 = await S8.F.run(pr7, { patents: c7, depth: 'quick', persist: false }), n6 = o6.notCharted.find((n) => n.pn === 'EP3368507B1');
      ok(!o6.patents.length && n6 && n6.reason === 'no_ai' && /Code result \(Markush\): ALC-0315 covered by claim 1 \(code-verified, translation reviewed\)/.test(n6.text) && n6.markushCovered.length === 1 && n6.evidence && n6.evidence.markush.results.length, 'no AI: the not-analysed entry carries the code result', JSON.stringify(n6 && n6.text));
      ok(S8.F.render(o6, 'md').includes('Code result (Markush): ALC-0315 covered by claim 1'), 'no AI: the code result is in the report');
      ok(!o6.notCharted.find((n) => n.pn === 'EP1000008B1').markushCovered, 'no AI: rights without a hit carry no code result');
    } finally { reset(); }
    // digest: code-verified questions come first and survive the cut to 10
    const g = { claims: [], app: { flags: [], quotes: { failed: 0 }, literal_worst: 'x' }, gesamt: { offene_fragen: Array.from({ length: 12 }, (_, i) => 'model q' + i), modifikatoren: [] } };
    const de = S7.F.buildDigest({ pn: 'X', right: { modifiers: [], jurisdiction: 'EP', expiry: {}, granted: true }, risk: { b: '3_mittel', e: null, final: '3_mittel' }, chart: g, app: { evidence: { questions: ['code q'] } } });
    ok(de.offene_fragen.length === 10 && de.offene_fragen[0] === 'code q', 'digest: evidence questions first, within the 10 slots', JSON.stringify(de.offene_fragen));
  }

  for (const f of ['fto.js', 'fto-render.js']) ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(ENG, f), 'utf8')), f + ' is ASCII only');

  console.log('\n' + passed + ' checks passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
