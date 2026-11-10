// Tests of the text search stack: pipeline/build_dist.py + pipeline/build_index.mjs + web/engine/{tok,loader,data,search,search-worker}.js
//
//   node tests/search_test.mjs [--work DIR] [--corpus FILE] [--no-browser] [--perf DIST_DIR] [--keep] [--only node|browser|perf]
//
// What it does (nothing is written into the repo; work files go to --work, default <tmp>/lnp-search-test):
//   1. builds dist/ twice from data/work/corpus.jsonl.gz (--enc bin and --enc b64, with two fake claim images) and a
//      third, deliberately too small one (--limit, tight --budget-mb) to exercise the budget cut;
//   2. reads the same corpus snapshot and scans it brute force (own tokenizer, own evaluator, no index) and compares
//      the complete document set of every query with the engine (Node, main-thread core) for both encodings;
//   3. recomputes BM25 scores for ranking, checks highlight offsets, snippets, claims trees, facets, grouping,
//      publication number parsing, suggestions, definitions, images, manifest / batches / limits of dist;
//   4. Playwright (Chromium) against a static server: LnpSearch and LnpData in the modes worker, blob and main,
//      the automatic fallback chain, the fflate fallback and the base64 encoding;
//   5. --perf DIST_DIR: cold / warm timings on a (full-scale) dist, in Node and in the browser, against the limits
//      1500 ms cold and 150 ms warm.
// Exit code 0 = all checks passed.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import zlib from 'node:zlib'; import http from 'node:http';
import readline from 'node:readline'; import { execFileSync } from 'node:child_process'; import crypto from 'node:crypto';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENG = path.join(ROOT, 'web', 'engine');
const TOK = require(path.join(ENG, 'tok.js')); const LD = require(path.join(ENG, 'loader.js')); const SC = require(path.join(ENG, 'search-worker.js'));

const args = {}; { const a = process.argv.slice(2); for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); if (i + 1 < a.length && !a[i + 1].startsWith('--')) args[k] = a[++i]; else args[k] = true; } }
const WORK = path.resolve(args.work || path.join(os.tmpdir(), 'lnp-search-test'));
const CORPUS = path.resolve(args.corpus || path.join(ROOT, 'data', 'work', 'corpus.jsonl.gz'));
const ONLY = args.only || null;
fs.mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------------------------------------ tiny test harness
const T0 = Date.now(); const R = { pass: 0, fail: 0, failures: [], sections: {}, numbers: {} }; let SECTION = '';
function section(name) { SECTION = name; R.sections[name] = { pass: 0, fail: 0 }; console.log(`\n== ${name} (${((Date.now() - T0) / 1000).toFixed(1)}s)`); }
function ok(cond, name, detail) {
  if (cond) { R.pass++; R.sections[SECTION].pass++; }
  else { R.fail++; R.sections[SECTION].fail++; R.failures.push(`[${SECTION}] ${name}${detail ? ': ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); }
  return !!cond;
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)?.slice(0, 300)} expected ${JSON.stringify(b)?.slice(0, 300)}`);
const note = (...a) => console.log('  ' + a.join(' '));

// ------------------------------------------------------------------------------------------------ builds
function build(name, extra) {
  const out = path.join(WORK, 'dist_' + name), bd = path.join(WORK, 'bd_' + name);
  const cmd = ['-I', path.join(ROOT, 'pipeline', 'build_dist.py'), '--corpus', CORPUS, '--out', out, '--build-dir', bd, ...extra];
  const t = Date.now();
  const log = execFileSync('python3', cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(WORK, `build_${name}.log`), log);
  note(`built ${name} in ${((Date.now() - t) / 1000).toFixed(1)} s -> ${out}`);
  return { out, bd, log };
}
function fakeImages(dir, pns) {
  // two tiny valid-looking PNG files per publication (the builder only checks the signature)
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const lines = [], made = {};
  for (const pn of pns) {
    fs.mkdirSync(path.join(dir, pn), { recursive: true }); made[pn] = [];
    for (let k = 1; k <= 2; k++) {
      const body = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.createHash('sha256').update(pn + k).digest(), Buffer.alloc(40 * k, k)]);
      const id = 'imgb000' + k; fs.writeFileSync(path.join(dir, pn, id + '.png'), body);
      lines.push(JSON.stringify({ pn, img: id, claim: k, w: 100 * k, h: 50 * k, bytes: body.length })); made[pn].push({ id, claim: k, w: 100 * k, h: 50 * k, sha: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length });
    }
  }
  fs.writeFileSync(path.join(dir, 'index.jsonl'), lines.join('\n') + '\n');
  return made;
}

// ------------------------------------------------------------------------------------------------ brute-force reference
// Own tokenizer (does not use tok.js): NFKD, combining marks removed, lower case, sharp s -> ss, [a-z0-9]+;
// stop words and tokens over 40 characters keep their position but never match.
const STOP = new Set(('the of a an and or to in is are be for with by on as at which that said wherein from it its this ' +
  'der die das und oder ein eine einer eines einem einen nach mit von zu in ist sind fur bei auf als den dem des wobei dass sich wird werden im zur zum').split(' '));
const rfold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split('ß').join('ss');
const rwords = (s) => rfold(s).match(/[a-z0-9]+/g) || [];
const ST_CODES = ['', 'granted', 'pending', 'lapsed', 'revoked', 'withdrawn', 'refused', 'expired', 'unknown'];
// family ids outside the signed 32-bit range are folded by build_dist.py (fam_id)
const famId = (v) => v == null ? 0 : (v >= -(2 ** 31) && v < 2 ** 31) ? v : -1100000000 - (Math.abs(v) % 1000000000);
const ymd = (s) => (s && s.length >= 10) ? (+s.slice(0, 4)) * 10000 + (+s.slice(5, 7)) * 100 + (+s.slice(8, 10)) : 0;

async function loadRef(bd, limit) {
  const snap = path.join(bd, 'corpus.snap.jsonl.gz'), keep = fs.existsSync(path.join(bd, 'keep.bin')) ? fs.readFileSync(path.join(bd, 'keep.bin')) : null;
  const statusExtra = new Map();
  const sf = path.join(ROOT, 'data', 'work', 'status.jsonl.gz');
  if (fs.existsSync(sf)) { try { for (const l of zlib.gunzipSync(fs.readFileSync(sf)).toString('utf8').split('\n')) { if (l) { const o = JSON.parse(l); statusExtra.set(o.pn, o); } } } catch (e) { /* partly written: ignore */ } }
  const vocab = new Map(), terms = [];
  const ref = { P: 0, rec: [], first: [], uPat: [], uKind: [], uIndep: [], uDe: [], uNo: [], uTok: [], uText: [], vocab, terms, claims: 0, keep };
  const idOf = (w) => { let i = vocab.get(w); if (i === undefined) { i = terms.length; vocab.set(w, i); terms.push(w); } return i; };
  const addUnit = (p, text, kind, indep, de, no, keepText) => {
    const w = rwords(text), ids = new Int32Array(w.length);
    for (let i = 0; i < w.length; i++) ids[i] = (w[i].length <= 40 && !STOP.has(w[i])) ? idOf(w[i]) : -1;
    ref.uPat.push(p); ref.uKind.push(kind); ref.uIndep.push(indep ? 1 : 0); ref.uDe.push(de ? 1 : 0); ref.uNo.push(no); ref.uTok.push(ids); ref.uText.push(keepText ? text : null);
  };
  const rl = readline.createInterface({ input: fs.createReadStream(snap).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue; if (limit && ref.P >= limit) break;
    const r = JSON.parse(line), p = ref.P++, lv = keep ? keep[p] : 2;
    const st = r.status || statusExtra.get(r.pn) || null, cl = r.claims || {}, en = cl.en || [], de = cl.de || [];
    const hasText = !!r.text && (en.length + de.length) > 0, textKept = hasText && lv >= 1;
    const code = st ? (ST_CODES.includes(st.code || '') ? (st.code || '') : 'unknown') : '';
    ref.rec.push({ pn: r.pn, auth: r.auth, kind: r.kind || '', pub: ymd(r.pub_date), year: +(r.pub_date || '0').slice(0, 4), prioYear: +(r.priority_date || '0').slice(0, 4), cpc: r.cpc || [], player: r.player || null,
      tier: r.tier | 0, seedTier: r.seed_tier | 0, fam: famId(r.family), st: code, deIn: st && st.in_force_de != null ? (st.in_force_de ? 1 : 0) : 2, exp: ymd(st && st.expiry_est),
      hasText, textKept, lv, title: (r.title && (r.title.en || r.title.de)) || '', asg: (r.assignees || []).join('; '),
      claims: textKept ? { en, de } : null, defs: (lv >= 2 && r.defs && r.defs.length) ? r.defs : [], hasDefs: !!(r.defs && r.defs.length), abstract: r.abstract || null, img: !!r.has_chem_img });
    ref.first.push(ref.uPat.length);
    const ti = r.title || {}, tEn = ti.en || '', tDe = ti.de || '';
    addUnit(p, tEn || tDe, 1, 0, !tEn && !!tDe, 0, true);
    if (tEn && tDe && tDe !== tEn) addUnit(p, tDe, 1, 0, 1, 0, true);
    if (r.abstract) addUnit(p, r.abstract, 2, 0, 0, 0, true);
    addUnit(p, (r.assignees || []).join(' ; '), 3, 0, 0, 0, true);
    if (r.text && lv >= 1) {
      for (const c of en) { addUnit(p, c.t, 0, !(c.dep && c.dep.length), 0, c.n, true); ref.claims++; }
      for (const c of de) { addUnit(p, c.t, 0, !(c.dep && c.dep.length), 1, c.n, true); ref.claims++; }
    }
  }
  ref.first.push(ref.uPat.length); ref.D = ref.uPat.length;
  return ref;
}
// reference query nodes
function mk(ref) {
  const idq = (w) => { const i = ref.vocab.get(w); return i === undefined ? -2 : i; };
  const one = (w) => { const ws = rwords(w); if (ws.length !== 1) throw new Error('T() needs one word: ' + w); return ws[0]; };
  const N = {
    T: (w) => ({ k: 't', id: idq(one(w)) }),
    PRE: (w) => { const pre = one(w), fl = new Uint8Array(ref.terms.length); for (let i = 0; i < ref.terms.length; i++) if (ref.terms[i].startsWith(pre)) fl[i] = 1; return { k: 'pre', fl }; },
    PH: (s) => { const w = rwords(s), ids = [], off = []; for (let i = 0; i < w.length; i++) if (!STOP.has(w[i])) { ids.push(idq(w[i])); off.push(i); } if (!ids.length) throw new Error('empty phrase'); const o0 = off[0]; return ids.length === 1 ? { k: 't', id: ids[0] } : { k: 'ph', ids, off: off.map((x) => x - o0) }; },
    NEAR: (a, b, n = 5) => ({ k: 'near', a, b, n }),
    AND: (...xs) => ({ k: 'and', xs }), OR: (...xs) => ({ k: 'or', xs }), NOT: (x) => ({ k: 'not', x }),
    F: (f, x) => ({ k: 'f', f, x }), SAME: (x) => ({ k: 'same', x }), META: (fn) => ({ k: 'meta', fn }), ALL: () => ({ k: 'meta', fn: () => true })
  };
  return N;
}
function occ(ref, n, u) {          // start positions of a positional node in unit u (ascending, unique)
  const a = ref.uTok[u], out = [];
  if (n.k === 't') { for (let i = 0; i < a.length; i++) if (a[i] === n.id) out.push(i); return out; }
  if (n.k === 'pre') { for (let i = 0; i < a.length; i++) if (a[i] >= 0 && n.fl[a[i]]) out.push(i); return out; }
  if (n.k === 'ph') { for (let i = 0; i < a.length; i++) { if (a[i] !== n.ids[0]) continue; let good = true; for (let k = 1; k < n.ids.length && good; k++) if (a[i + n.off[k]] !== n.ids[k]) good = false; if (good) out.push(i); } return out; }
  if (n.k === 'or') { const s = new Set(); for (const x of n.xs) for (const p of occ(ref, x, u)) s.add(p); return [...s].sort((x, y) => x - y); }
  if (n.k === 'near') {
    const A = occ(ref, n.a, u), B = occ(ref, n.b, u), s = new Set();
    for (const pa of A) for (const pb of B) if (pa !== pb && Math.abs(pa - pb) <= n.n) { s.add(pa); s.add(pb); }
    return [...s].sort((x, y) => x - y);
  }
  throw new Error('not positional: ' + n.k);
}
function pred(ref, f, u, ctx) {
  const k = ref.uKind[u], ind = ref.uIndep[u];
  let good = f === 'claims' ? k === 0 : f === 'indep' ? (k === 0 && ind === 1) : f === 'dep' ? (k === 0 && ind === 0) : f === 'title' ? k === 1 : f === 'abstract' ? k === 2 : f === 'asg' ? k === 3 : k !== 3;
  if (good && k !== 3) {
    if (ctx.indepOnly && (k === 0 ? !ind : f === 'all')) good = false;
    if (ctx.lang === 'de' && !ref.uDe[u]) good = false;
    if (ctx.lang === 'en' && ref.uDe[u]) good = false;
  }
  return good;
}
const POS = { t: 1, pre: 1, ph: 1, near: 1 };
function evU(ref, n, u, f, ctx) {
  if (POS[n.k]) return pred(ref, f, u, ctx) && occ(ref, n, u).length > 0;
  switch (n.k) {
    case 'and': return n.xs.every((x) => evU(ref, x, u, f, ctx));
    case 'or': return n.xs.some((x) => evU(ref, x, u, f, ctx));
    case 'not': return !evU(ref, n.x, u, f, ctx) && pred(ref, f, u, ctx);
    case 'f': return evU(ref, n.x, u, n.f, ctx);
    case 'same': return evU(ref, n.x, u, f, ctx);
    case 'meta': return !!n.fn(ref.rec[ref.uPat[u]], ref.uPat[u]);
  }
  throw new Error('bad node ' + n.k);
}
function evP(ref, n, p, f, ctx) {
  if (POS[n.k]) { for (let u = ref.first[p]; u < ref.first[p + 1]; u++) if (pred(ref, f, u, ctx) && occ(ref, n, u).length) return true; return false; }
  switch (n.k) {
    case 'and': return n.xs.every((x) => evP(ref, x, p, f, ctx));
    case 'or': return n.xs.some((x) => evP(ref, x, p, f, ctx));
    case 'not': return !evP(ref, n.x, p, f, ctx);
    case 'f': return evP(ref, n.x, p, n.f, ctx);
    case 'same': { for (let u = ref.first[p]; u < ref.first[p + 1]; u++) if (evU(ref, n.x, u, f, ctx)) return true; return false; }
    case 'meta': return !!n.fn(ref.rec[p], p);
  }
  throw new Error('bad node ' + n.k);
}
function bruteForce(ref, node, ctx = {}, filterFn = null, scope = 'patent') {
  const out = [];
  for (let p = 0; p < ref.P; p++) {
    if (filterFn && !filterFn(ref.rec[p], p)) continue;
    let hit;
    if (!node) hit = true;
    else if (scope === 'claim') { hit = false; for (let u = ref.first[p]; u < ref.first[p + 1] && !hit; u++) hit = evU(ref, node, u, 'all', ctx); }
    else hit = evP(ref, node, p, 'all', ctx);
    if (hit) out.push(p);
  }
  return out;
}
// independent BM25 (same constants as the index: k1 1.2, b 0.75, field weights) for flat AND/OR of terms and phrases
function refScores(ref, leaves, resultSet, avg, ctx = {}) {
  const k1 = 1.2, b = 0.75, D = ref.D, acc = new Float64Array(D), W = (u) => { const k = ref.uKind[u]; return k === 1 ? 1.6 : k === 2 ? 0.9 : k === 3 ? 1.0 : ref.uIndep[u] ? 1.3 : 1.0; };
  const ulen = (u) => { let n = 0; const a = ref.uTok[u]; for (let i = 0; i < a.length; i++) if (a[i] >= 0) n++; return n; };
  const avgOf = (u) => [avg.claim, avg.title, avg.abstract, avg.asg][ref.uKind[u]];
  for (const leaf of leaves) {
    const tfs = new Map(); let dfAll = 0, dfField = 0;
    for (let u = 0; u < D; u++) { const o = occ(ref, leaf, u).length; if (!o) continue; dfAll++; if (pred(ref, 'all', u, ctx)) { tfs.set(u, o); dfField++; } }
    const df = leaf.k === 't' ? dfAll : dfField, boost = leaf.k === 'ph' ? leaf.ids.length : 1;
    const idf = Math.log(1 + (D - df + 0.5) / (df + 0.5)) * boost;
    for (const [u, tf] of tfs) acc[u] += W(u) * idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * ulen(u) / avgOf(u)));
  }
  const score = new Map();
  for (const p of resultSet) {
    let best = 0, sum = 0, bu = -1;
    for (let u = ref.first[p]; u < ref.first[p + 1]; u++) if (acc[u] > 0) { sum += acc[u]; if (acc[u] > best) { best = acc[u]; bu = u; } }
    const rest = sum - best; score.set(p, { s: best + 0.1 * Math.min(rest, 2 * best), bu });
  }
  return score;
}

// ------------------------------------------------------------------------------------------------ engine in Node
function nodeCore(dist) {
  const fetchFs = async (u) => { const p = path.join(dist, u); if (!fs.existsSync(p)) return new Response('not found', { status: 404 }); return new Response(fs.readFileSync(p)); };
  const core = SC.create({ fetch: fetchFs });
  return core.init({ base: 'data/', fetch: fetchFs }).then((info) => ({ core, info }));
}
const sameSet = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
function diffSets(a, b) { const sa = new Set(a), sb = new Set(b); return { onlyEngine: a.filter((x) => !sb.has(x)).slice(0, 5), onlyRef: b.filter((x) => !sa.has(x)).slice(0, 5) }; }

// the query set: [name, query string, opts, reference node builder, reference ctx, reference filter, scope]
function querySet(ref, N, pick) {
  const { T, PRE, PH, NEAR, AND, OR, NOT, F, SAME, META } = N;
  const yr = (a, b) => META((r) => r.year >= a && r.year <= b && r.year > 0);
  const Q = [];
  const add = (q, node, o = {}) => Q.push({ q, node, opts: o.opts || {}, ctx: o.ctx || {}, filter: o.filter || null, scope: o.scope || 'patent', op: o.op || '', min: o.min == null ? 1 : o.min });
  add('lipid', T('lipid'), { op: 'term' });
  add('lipid nanoparticle', AND(T('lipid'), T('nanoparticle')), { op: 'implicit AND' });
  add('lipid AND nanoparticle', AND(T('lipid'), T('nanoparticle')), { op: 'AND' });
  add('cholesterol OR sterol', OR(T('cholesterol'), T('sterol')), { op: 'OR' });
  add('mRNA NOT siRNA', AND(T('mrna'), NOT(T('sirna'))), { op: 'NOT' });
  add('mRNA -siRNA', AND(T('mrna'), NOT(T('sirna'))), { op: '-x' });
  add('NOT lipid', NOT(T('lipid')), { op: 'NOT alone' });
  add('(cholesterol OR sterol) (PEG OR polyethylene) -liposome', AND(OR(T('cholesterol'), T('sterol')), OR(T('peg'), T('polyethylene')), NOT(T('liposome'))), { op: 'parentheses' });
  add('mRNA AND (cholesterol OR (sterol AND NOT (PEG OR siRNA)))', AND(T('mrna'), OR(T('cholesterol'), AND(T('sterol'), NOT(OR(T('peg'), T('sirna')))))), { op: 'nested parentheses' });
  add('(lipid', T('lipid'), { op: 'unbalanced parenthesis' });
  add('"lipid nanoparticle"', PH('lipid nanoparticle'), { op: 'phrase' });
  add('"nucleic acid" lipid', AND(PH('nucleic acid'), T('lipid')), { op: 'phrase + term' });
  add('"selected from the group consisting of"', PH('selected from the group consisting of'), { op: 'phrase across stop words' });
  add('"molar ratio of"', PH('molar ratio of'), { op: 'phrase ending in a stop word' });
  add('"Lipid-Nanopartikel"', PH('Lipid-Nanopartikel'), { op: 'German phrase', min: 0 });
  add('DLin-MC3-DMA', PH('DLin-MC3-DMA'), { op: 'hyphenated word = phrase', min: 0 });
  add('C12-200 OR "1,2-dioleoyl"', OR(PH('C12-200'), PH('1,2-dioleoyl')), { op: 'word with digits', min: 0 });
  add('ioniz*', PRE('ioniz'), { op: 'prefix' });
  add('lipid* nano*', AND(PRE('lipid'), PRE('nano')), { op: 'two prefixes' });
  add('Nukleinsäure* OR nucleic', OR(PRE('nukleinsaure'), T('nucleic')), { op: 'prefix with umlaut' });
  add('ioniz* NEAR/3 lipid', NEAR(PRE('ioniz'), T('lipid'), 3), { op: 'NEAR/n prefix' });
  add('cationic NEAR lipid', NEAR(T('cationic'), T('lipid'), 5), { op: 'NEAR default' });
  add('"nucleic acid" NEAR/5 lipid', NEAR(PH('nucleic acid'), T('lipid'), 5), { op: 'NEAR with phrase' });
  add('cholesterol NEAR/10 (PEG OR phospholipid)', NEAR(T('cholesterol'), OR(T('peg'), T('phospholipid')), 10), { op: 'NEAR with OR group' });
  add('(ionizable NEAR/2 lipid) NEAR/20 cholesterol', NEAR(NEAR(T('ionizable'), T('lipid'), 2), T('cholesterol'), 20), { op: 'nested NEAR' });
  add('lipid NEAR/1 lipid', NEAR(T('lipid'), T('lipid'), 1), { op: 'NEAR same word', min: 0 });
  add('claims:cholesterol', F('claims', T('cholesterol')), { op: 'claims:' });
  add('indep:cholesterol', F('indep', T('cholesterol')), { op: 'indep:' });
  add('dep:cholesterol', F('dep', T('cholesterol')), { op: 'dep:' });
  add('title:liposome', F('title', T('liposome')), { op: 'title:' });
  add('title:(lipid OR liposome) -abstract:mRNA', AND(F('title', OR(T('lipid'), T('liposome'))), NOT(F('abstract', T('mrna')))), { op: 'field group' });
  add('abstract:"lipid nanoparticle"', F('abstract', PH('lipid nanoparticle')), { op: 'abstract: phrase' });
  add('indep:("molar ratio" OR mol) claims:cholesterol', AND(F('indep', OR(PH('molar ratio'), T('mol'))), F('claims', T('cholesterol'))), { op: 'indep group' });
  add('asg:moderna', F('asg', PRE('moderna')), { op: 'asg:' });
  add('asg:"modernatx inc"', F('asg', PH('modernatx inc')), { op: 'asg: phrase', min: 0 });
  add('asg:(pfizer OR biontech) mRNA', AND(F('asg', OR(T('pfizer'), T('biontech'))), T('mrna')), { op: 'asg group', min: 0 });
  add('cpc:A61K9/51 lipid', AND(META((r) => r.cpc.some((c) => c.startsWith('A61K9/51'))), T('lipid')), { op: 'cpc:' });
  add('cpc:C07C|C07D -cpc:A61K', AND(META((r) => r.cpc.some((c) => c.startsWith('C07C') || c.startsWith('C07D'))), NOT(META((r) => r.cpc.some((c) => c.startsWith('A61K'))))), { op: 'cpc list' });
  add('auth:EP cationic', AND(META((r) => r.auth === 'EP'), T('cationic')), { op: 'auth:' });
  add('year:2015-2020 liposome', AND(yr(2015, 2020), T('liposome')), { op: 'year range' });
  add('year:2019 mRNA', AND(yr(2019, 2019), T('mrna')), { op: 'year' });
  add('year:2021- "lipid nanoparticle"', AND(yr(2021, 9999), PH('lipid nanoparticle')), { op: 'open year range' });
  add('prio:2010-2012 siRNA', AND(META((r) => r.prioYear >= 2010 && r.prioYear <= 2012), T('sirna')), { op: 'prio:' });
  add('exp:2030-2040 mRNA', AND(META((r) => { const y = (r.exp / 10000) | 0; return y >= 2030 && y <= 2040; }), T('mrna')), { op: 'exp:', min: 0 });
  add('player:acuitas', META((r) => !!r.player && rfold(r.player).includes('acuitas')), { op: 'player:' });
  add('status:granted "cationic lipid"', AND(META((r) => r.st === 'granted'), PH('cationic lipid')), { op: 'status:', min: 0 });
  add('kind:B1 title:lipid', AND(META((r) => r.kind.startsWith('B1')), F('title', T('lipid'))), { op: 'kind:' });
  add('tier:1 seed:1', AND(META((r) => r.tier === 1), META((r) => r.seedTier > 0)), { op: 'tier: seed:' });
  add('seedtier:1 -text:1', AND(META((r) => r.seedTier === 1), NOT(META((r) => r.textKept))), { op: 'seedtier: text:', min: 0 });
  add('text:1 -claims:lipid', AND(META((r) => r.textKept), NOT(F('claims', T('lipid')))), { op: 'text:' });
  add('inforce:1 lipid', AND(META((r) => r.deIn === 1), T('lipid')), { op: 'inforce:', min: 0 });
  add(`pn:"${pick.pnSpaced}"`, META((r, p) => p === pick.p), { op: 'pn: with blanks' });
  add(`pn:${pick.pnBase} OR pn:${pick.pn2}`, META((r, p) => pick.baseSet.has(p) || p === pick.p2), { op: 'pn: without kind' });
  add(`fam:${pick.fam}`, META((r) => r.fam === pick.fam), { op: 'fam:' });
  add('same:(PEG cholesterol phospholipid)', SAME(AND(T('peg'), T('cholesterol'), T('phospholipid'))), { op: 'same:' });
  add('same:(lipid -cholesterol) claims:mRNA', AND(SAME(AND(T('lipid'), NOT(T('cholesterol')))), F('claims', T('mrna'))), { op: 'same: with NOT' });
  add('same:(indep:(cationic OR ionizable) "molar ratio")', SAME(AND(F('indep', OR(T('cationic'), T('ionizable'))), PH('molar ratio'))), { op: 'same: with field', min: 0 });
  add('indep:1 cholesterol', T('cholesterol'), { op: 'indep:1 switch', ctx: { indepOnly: true } });
  add('lang:de lipid', T('lipid'), { op: 'lang:de', ctx: { lang: 'de' } });
  add('lang:en verbindung OR compound', OR(T('verbindung'), T('compound')), { op: 'lang:en', ctx: { lang: 'en' } });
  add('verbindung OR compound', OR(T('verbindung'), T('compound')), { op: 'German + English' });
  add('Zusammensetzung umfassend', AND(T('zusammensetzung'), T('umfassend')), { op: 'German terms', min: 0 });
  add('-title:lipid -abstract:lipid claims:(ionizable OR cationic)', AND(NOT(F('title', T('lipid'))), NOT(F('abstract', T('lipid'))), F('claims', OR(T('ionizable'), T('cationic')))), { op: 'negated fields' });
  add('the', null, { op: 'stop word only', warn: true });
  add('xqzzyqx', T('xqzzyqx'), { op: 'unknown term', min: 0 });
  add('xqzzy* OR "xqzzy lipid"', OR(PRE('xqzzy'), PH('xqzzy lipid')), { op: 'unknown prefix / phrase', min: 0 });
  // filters given as options
  add('lipid', T('lipid'), { op: 'filters auth + years', opts: { filters: { auth: ['US'], yearFrom: 2018, yearTo: 2022 } }, filter: (r) => r.auth === 'US' && r.year >= 2018 && r.year <= 2022 });
  add('cholesterol', T('cholesterol'), { op: 'filter indepOnly', opts: { filters: { indepOnly: true } }, ctx: { indepOnly: true } });
  add('', null, { op: 'empty query + filters', opts: { filters: { players: ['Moderna'], textOnly: true } }, filter: (r) => r.player === 'Moderna' && r.textKept, min: 0 });
  add('mRNA', T('mrna'), { op: 'filters status + deInForce', opts: { filters: { status: ['granted'], deInForce: true } }, filter: (r) => r.st === 'granted' && r.deIn === 1, min: 0 });
  add('lipid', T('lipid'), { op: 'filters cpc + tiers', opts: { filters: { cpc: ['C07C'], tiers: [1, 2] } }, filter: (r) => r.cpc.some((c) => c.startsWith('C07C')) && (r.tier === 1 || r.tier === 2) });
  add('lipid', T('lipid'), { op: 'filters seedOnly + expAfter', opts: { filters: { seedOnly: true, expAfter: 20300101 } }, filter: (r) => r.seedTier > 0 && r.exp > 20300101, min: 0 });
  add('lipid', T('lipid'), { op: 'filter ps', opts: { filters: { ps: pick.ps } }, filter: (r, p) => pick.psSet.has(p), min: 0 });
  add('lipid', T('lipid'), { op: 'filter lang', opts: { filters: { lang: 'de' } }, ctx: { lang: 'de' } });
  add('lipid', AND(T('lipid'), F('asg', PRE('modern'))), { op: 'filter asg', opts: { filters: { asg: 'modern' } }, min: 0 });
  add('cholesterol PEG', AND(T('cholesterol'), T('peg')), { op: 'scope claim', opts: { scope: 'claim' }, scope: 'claim' });
  add('scope:claim lipid -cholesterol', AND(T('lipid'), NOT(T('cholesterol'))), { op: 'scope:claim inline', scope: 'claim' });
  return Q;
}
function picks(ref) {
  // a full-text EP B publication, another publication, a family, a list of patent indexes
  let p = -1, p2 = -1;
  for (let i = 0; i < ref.P; i++) { const r = ref.rec[i]; if (p < 0 && r.auth === 'EP' && /^B/.test(r.kind) && r.textKept && /^EP\d{7}B\d$/.test(r.pn)) p = i; else if (p2 < 0 && r.auth === 'US' && /^US\d{7,8}B\d$/.test(r.pn)) p2 = i; if (p >= 0 && p2 >= 0) break; }
  const pn = ref.rec[p].pn, base = pn.replace(/[A-Z]\d?$/, ''), m = /^EP(\d)(\d{3})(\d{3})(B\d)$/.exec(pn);
  const baseSet = new Set(); for (let i = 0; i < ref.P; i++) if (ref.rec[i].pn.replace(/[A-Z]\d?$/, '') === base && /^EP/.test(ref.rec[i].pn)) baseSet.add(i);
  const ps = []; for (let i = 0; i < ref.P; i += 97) ps.push(i);
  return { p, pn, p2, pn2: ref.rec[p2].pn, pnSpaced: `EP ${m[1]} ${m[2]} ${m[3]} ${m[4]}`, pnBase: base, baseSet, fam: ref.rec[p].fam, ps, psSet: new Set(ps) };
}

async function runQueries(label, core, ref, Q, opts = {}) {
  let n = 0, bad = 0; const ops = new Set(), rows = [];
  for (const t of Q) {
    const want = bruteForce(ref, t.node, t.ctx, t.filter, t.scope);
    const r = await core.search(t.q, Object.assign({ limit: 0, all: true, facets: false, snippets: false }, t.opts));
    const got = Array.from(r.all);
    const good = sameSet(got, want) && r.total === want.length;
    if (!good) { bad++; const d = diffSets(got, want); ok(false, `${label} [${t.op}] ${t.q || '(empty)'}`, `engine ${got.length} ref ${want.length}; only engine ${JSON.stringify(d.onlyEngine.map((p) => ref.rec[p].pn))} only ref ${JSON.stringify(d.onlyRef.map((p) => ref.rec[p].pn))}`); }
    else ok(true, t.q);
    if (opts.strictMin !== false && want.length < t.min) ok(false, `${label} [${t.op}] ${t.q}`, `reference finds nothing: the query does not test anything on this corpus`);
    n++; ops.add(t.op); rows.push({ op: t.op, q: t.q, total: want.length, ms: r.ms });
  }
  note(`${label}: ${n} queries, ${n - bad} identical document sets, ${ops.size} operator cases`);
  return rows;
}

// ------------------------------------------------------------------------------------------------ node part
async function nodePart() {
  section('build');
  // images: pick two publications with full text for the fake image set (needs a first look at the corpus)
  const first = []; {
    const rl = readline.createInterface({ input: fs.createReadStream(CORPUS).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) { if (line.includes('"text": true') || line.includes('"text":true')) { const r = JSON.parse(line); if (r.text && r.claims && (r.claims.en || []).length) first.push(r.pn); } if (first.length >= 2) break; }
    rl.close();
  }
  const imgDir = path.join(WORK, 'img'), made = fakeImages(imgDir, first);
  const B = build('bin', ['--img-dir', imgDir]), B64 = build('b64', ['--enc', 'b64', '--img-dir', imgDir]);
  const man = JSON.parse(fs.readFileSync(path.join(B.out, 'data', 'manifest.json'), 'utf8')), man64 = JSON.parse(fs.readFileSync(path.join(B64.out, 'data', 'manifest.json'), 'utf8'));

  section('dist layout and manifest');
  for (const [name, dir, m] of [['bin', B.out, man], ['b64', B64.out, man64]]) {
    const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(path.relative(dir, f).split(path.sep).join('/')); } })(dir);
    const total = files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
    ok(files.length <= 500, `${name}: at most 500 files`, String(files.length));
    ok(total <= 240e6, `${name}: at most 240 MB`, String(total));
    ok(files.every((f) => fs.statSync(path.join(dir, f)).size <= 15e6), `${name}: every file at most 15 MB`);
    ok(files.every((f) => /^[a-z0-9._\/-]+$/.test(f)), `${name}: file names [a-z0-9._-/]`, files.filter((f) => !/^[a-z0-9._\/-]+$/.test(f)).join(' '));
    eq(m.enc, name, `${name}: manifest.enc`);
    ok(name === 'bin' ? !files.some((f) => /\.b64\.txt$/.test(f)) : !files.some((f) => /\.bin$/.test(f)), `${name}: binaries are ${name === 'bin' ? '.bin' : '.b64.txt'} only`);
    // manifest lists every file except itself and publish_batches.json, with size and sha256
    const listed = Object.keys(m.files).sort(), onDisk = files.filter((f) => f !== 'data/manifest.json' && f !== 'publish_batches.json').sort();
    eq(listed, onDisk, `${name}: manifest.files = files on disk`);
    let shaOk = true, sizeOk = true;
    for (const f of listed) { const b = fs.readFileSync(path.join(dir, f)); if (b.length !== m.files[f][0]) sizeOk = false; if (crypto.createHash('sha256').update(b).digest('hex') !== m.files[f][1]) shaOk = false; }
    ok(sizeOk, `${name}: sizes in the manifest`); ok(shaOk, `${name}: sha256 in the manifest`);
    const batches = JSON.parse(fs.readFileSync(path.join(dir, 'publish_batches.json'), 'utf8'));
    const inB = batches.flatMap((b) => b.files).sort();
    eq(inB, files.filter((f) => f !== 'publish_batches.json').sort(), `${name}: publish batches cover every file once`);
    ok(batches.every((b) => b.files.length <= 240 && b.bytes <= 60e6 && b.bytes === b.files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0)), `${name}: batches <= 240 files and <= 60 MB`);
    ok(m.snapshots && m.snapshots.surechembl && 'ep_register' in m.snapshots && 'ep_text' in m.snapshots && 'us_text' in m.snapshots, `${name}: snapshot dates`);
    ok(m.counts.patents > 0 && m.counts.claims > 0 && m.counts.ep + m.counts.us + m.counts.wo === m.counts.patents, `${name}: counts`);
    ok(m.cut && m.cut.applied === false, `${name}: no budget cut on the real corpus`, JSON.stringify(m.cut && m.cut.text));
    for (const f of ['engine/tok.js', 'engine/loader.js', 'engine/data.js', 'engine/search.js', 'engine/search-worker.js', 'vendor/fflate.js', 'data/seed.json', 'data/img.json']) ok(files.includes(f), `${name}: ${f} present`);
    R.numbers['dist_' + name] = { files: files.length, bytes: total, sizes: m.sizes, bytesPerClaim: m.bytesPerClaim, counts: m.counts };
  }
  ok(Math.abs(R.numbers.dist_b64.bytes / R.numbers.dist_bin.bytes - 1.3) < 0.1, 'b64 dist is about 4/3 of the binary one', (R.numbers.dist_b64.bytes / R.numbers.dist_bin.bytes).toFixed(3));
  // every .gz.bin really is gzip; b64 decodes to the same bytes
  { let same = true, n = 0; for (const f of Object.keys(man.files)) if (/\.bin$/.test(f)) { const a = fs.readFileSync(path.join(B.out, f)), b = Buffer.from(fs.readFileSync(path.join(B64.out, f.replace(/\.bin$/, '.b64.txt')), 'latin1'), 'base64'); if (/^data\/(idx\/|df-)/.test(f)) { if (!zlib.gunzipSync(a).equals(zlib.gunzipSync(b))) same = false; } else if (!a.equals(b)) same = false; n++; } ok(same, `base64 files decode to the binary files (${n} files)`); }
  // re-run: nothing rewritten (incremental), text index from cache
  { const again = build('bin', ['--img-dir', imgDir]); const mw = /(\d+) files written, (\d+) unchanged/.exec(again.log); ok(mw && +mw[1] <= 1 && +mw[2] > 50, 're-run rewrites nothing but the manifest', mw ? mw[0] : 'no summary line'); ok(/cache hit/.test(again.log), 're-run reuses the text index'); }

  section('reference corpus');
  const ref = await loadRef(B.bd, 0), N = mk(ref), pick = picks(ref);
  note(`reference: ${ref.P} publications, ${ref.D} units, ${ref.claims} claims, ${ref.terms.length} terms; RSS ${(process.memoryUsage().rss / 1e6) | 0} MB`);
  eq(man.counts.patents, ref.P, 'patent count'); eq(man.counts.claims, ref.claims, 'claim count'); eq(man.idx.D, ref.D, 'unit count');
  eq(man.idx.nTerms, ref.terms.length, 'number of index terms = reference vocabulary');
  eq(man.counts.fulltext, ref.rec.filter((r) => r.textKept).length, 'full text count');
  // tok.js against the reference tokenizer on real text
  { let bad = 0, n = 0; for (let u = 0; u < ref.D; u += 37) { const t = ref.uText[u], a = TOK.tokenize(t), ids = ref.uTok[u]; let k = 0; for (let i = 0; i < ids.length; i++) if (ids[i] >= 0) { if (a[k] !== ref.terms[ids[i]] || a[k + 1] !== i) { bad++; break; } k += 2; } if (k !== a.length) bad++; n++; } ok(bad === 0, `tok.js = reference tokenizer on ${n} texts`, bad + ' differ'); }

  section('correctness vs brute force (bin)');
  const { core, info } = await nodeCore(B.out);
  eq([info.D, info.P], [ref.D, ref.P], 'engine init sizes');
  const Q = querySet(ref, N, pick);
  ok(Q.length >= 40, 'at least 40 queries', String(Q.length));
  const rows = await runQueries('bin', core, ref, Q);
  R.numbers.queries = rows.length; R.numbers.queryTotals = rows.map((r) => `${r.op}: ${r.q || '(empty)'} -> ${r.total}`);
  { const r = await core.search('the', { limit: 1 }); ok(r.parsed.warnings.some((w) => w.code === 'stop_word'), 'stop word query gives a warning'); }
  { const r = await core.search('(lipid', { limit: 1 }); ok(r.parsed.warnings.some((w) => w.code === 'paren'), 'unbalanced parenthesis gives a warning'); }
  { const r = await core.search('year:abc lipid', { limit: 1 }); ok(r.parsed.warnings.some((w) => w.code === 'bad_value') && r.total === 0, 'bad year gives a warning'); }
  { const r = await core.search('a* lipid', { limit: 1 }); ok(r.parsed.warnings.some((w) => w.code === 'short_prefix'), 'one-letter prefix gives a warning'); }

  section('correctness vs brute force (b64)');
  const c64 = await nodeCore(B64.out);
  eq(c64.info.enc, 'b64', 'engine reads manifest.enc = b64');
  await runQueries('b64', c64.core, ref, Q);

  section('ranking');
  const avg = man.idx.avg;
  { // average lengths of the index against the reference
    const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0]; for (let u = 0; u < ref.D; u++) { let n = 0; const a = ref.uTok[u]; for (let i = 0; i < a.length; i++) if (a[i] >= 0) n++; sum[ref.uKind[u]] += n; cnt[ref.uKind[u]]++; }
    ok(Math.abs(sum[0] / cnt[0] - avg.claim) < 1e-6 && Math.abs(sum[1] / cnt[1] - avg.title) < 1e-6 && Math.abs(sum[2] / cnt[2] - avg.abstract) < 1e-6 && Math.abs(sum[3] / cnt[3] - avg.asg) < 1e-6, 'average field lengths');
  }
  const rankCases = [
    ['cholesterol', [N.T('cholesterol')], N.T('cholesterol'), {}],
    ['ionizable lipid', [N.T('ionizable'), N.T('lipid')], N.AND(N.T('ionizable'), N.T('lipid')), {}],
    ['"lipid nanoparticle" mRNA', [N.PH('lipid nanoparticle'), N.T('mrna')], N.AND(N.PH('lipid nanoparticle'), N.T('mrna')), {}],
    ['PEG OR pegylated', [N.T('peg'), N.T('pegylated')], N.OR(N.T('peg'), N.T('pegylated')), {}],
    ['indep:1 cationic', [N.T('cationic')], N.T('cationic'), { indepOnly: true }]
  ];
  for (const [q, leaves, node, ctx] of rankCases) {
    const set = bruteForce(ref, node, ctx), sc = refScores(ref, leaves, set, avg, ctx);
    const r = await core.search(q, { limit: 25, facets: false, snippets: false });
    let good = r.hits.length === Math.min(25, set.length), worst = 0;
    for (const h of r.hits) { const w = sc.get(h.p); if (!w) { good = false; continue; } const d = Math.abs(w.s - h.score) / Math.max(1e-9, w.s); if (d > worst) worst = d; }
    ok(good && worst < 2e-3, `BM25 scores of the top 25 = independent computation: ${q}`, `max relative difference ${worst.toExponential(2)}`);
    const sortedRef = [...sc.values()].map((x) => x.s).sort((a, b) => b - a), kth = sortedRef[Math.min(24, sortedRef.length - 1)];
    ok(r.hits.every((h) => h.score >= kth * (1 - 2e-3)), `engine top 25 are the 25 best of the whole result set: ${q}`);
    ok(r.hits.every((h, i) => i === 0 || r.hits[i - 1].score >= h.score), `scores descend: ${q}`);
    // best unit = the unit with the highest score of the reference
    let bu = 0; for (const h of r.hits) { const w = sc.get(h.p); if (w && h.best && ref.uNo[w.bu] === h.best.n && (ref.uIndep[w.bu] === 1) === h.best.indep && ['claim', 'title', 'abstract', 'assignee'][ref.uKind[w.bu]] === h.best.field) bu++; }
    ok(bu >= r.hits.length - 1, `best unit per hit: ${q}`, `${bu}/${r.hits.length}`);
  }
  { // independent claims get a boost: same statistics, indep unit scores 1.3 x the dependent one
    const r = await core.search('cholesterol', { limit: 200, facets: false, snippets: false, perHit: 50 });
    let seen = 0, good = 0;
    for (const h of r.hits) { const a = h.top.find((t) => t.field === 'claim' && t.indep), b = h.top.find((t) => t.field === 'claim' && !t.indep); if (a && b) { seen++; } }
    const set = bruteForce(ref, N.T('cholesterol')), sc = refScores(ref, [N.T('cholesterol')], set, avg);
    const noBoost = (() => { const save = ref.uIndep; ref.uIndep = save.map(() => 0); const s = refScores(ref, [N.T('cholesterol')], set, avg); ref.uIndep = save; return s; })();
    for (const p of set) { const a = sc.get(p), b = noBoost.get(p); if (a.bu >= 0 && ref.uKind[a.bu] === 0 && ref.uIndep[a.bu] && a.s > b.s) good++; }
    ok(good > 0 && seen >= 0, 'independent-claim boost changes scores', `${good} publications score higher through an independent claim`);
  }
  { // sort by date / expiry, offset paging, family grouping
    const r = await core.search('lipid', { limit: 50, sort: 'date', facets: false, snippets: false });
    ok(r.hits.every((h, i) => i === 0 || ref.rec[r.hits[i - 1].p].pub >= ref.rec[h.p].pub), 'sort by date');
    const e = await core.search('lipid', { limit: 50, sort: 'expiry', facets: false, snippets: false });
    const key = (p) => ref.rec[p].exp ? ref.rec[p].exp : 99999999;
    ok(e.hits.every((h, i) => i === 0 || key(e.hits[i - 1].p) <= key(h.p)), 'sort by expiry (earliest first, unknown last)');
    const a = await core.search('lipid nanoparticle', { limit: 30, facets: false, snippets: false }), b1 = await core.search('lipid nanoparticle', { limit: 10, offset: 10, facets: false, snippets: false });
    eq(b1.hits.map((h) => h.p), a.hits.slice(10, 20).map((h) => h.p), 'offset paging');
    const em = await core.search('', { filters: { auth: ['EP'], yearFrom: 2020 }, limit: 40, facets: false });
    ok(em.hits.length > 0 && em.hits.every((h, i) => i === 0 || ref.rec[em.hits[i - 1].p].pub >= ref.rec[h.p].pub) && em.hits.every((h) => ref.rec[h.p].auth === 'EP' && ref.rec[h.p].year >= 2020), 'empty query with filters lists by date');
    const g = await core.search('lipid nanoparticle', { limit: 20, group: 'family', facets: false, snippets: false });
    const set = bruteForce(ref, N.AND(N.T('lipid'), N.T('nanoparticle'))), fams = new Map(); for (const p of set) { const f = ref.rec[p].fam; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(p); }
    eq(g.totalFamilies, fams.size, 'family grouping: number of families');
    ok(g.hits.every((h) => sameSet(h.members.slice().sort((x, y) => x - y), fams.get(ref.rec[h.p].fam)) && h.members[0] === h.p), 'family grouping: members complete, representative first');
    ok(new Set(g.hits.map((h) => ref.rec[h.p].fam)).size === g.hits.length, 'family grouping: one hit per family');
  }

  section('facets');
  for (const [q, node, o, filter] of [['lipid', N.T('lipid'), {}, null], ['', null, { filters: { auth: ['EP'] } }, (r) => r.auth === 'EP'], ['"lipid nanoparticle"', N.PH('lipid nanoparticle'), {}, null]]) {
    const set = bruteForce(ref, node, {}, filter), r = await core.search(q, Object.assign({ limit: 1, snippets: false }, o));
    const f = { auth: {}, year: {}, player: {}, status: {}, tier: {}, cpc4: {} }, inc = (o2, k) => { o2[k] = (o2[k] || 0) + 1; };
    for (const p of set) { const x = ref.rec[p]; inc(f.auth, x.auth); if (x.year) inc(f.year, x.year); if (x.player) inc(f.player, x.player); if (x.st) inc(f.status, x.st); inc(f.tier, x.tier); for (const c of new Set(x.cpc.map((c2) => c2.slice(0, 4)))) inc(f.cpc4, c); }
    for (const k of Object.keys(f)) eq(Object.fromEntries(Object.entries(r.facets[k]).sort()), Object.fromEntries(Object.entries(f[k]).sort()), `facet ${k}: ${q || '(empty)'}`);
    eq(r.facets.text, set.filter((p) => ref.rec[p].textKept).length, `facet text: ${q || '(empty)'}`);
    eq(r.facets.deInForce, set.filter((p) => ref.rec[p].deIn === 1).length, `facet deInForce: ${q || '(empty)'}`);
  }

  section('highlight and snippets');
  const hl = (text, q) => SC.highlightText(text, SC.parse(q, TOK).ast, TOK);
  eq(hl('A lipid nanoparticle comprising an ionizable lipid.', 'lipid'), [['A ', false], ['lipid', true], [' nanoparticle comprising an ionizable ', false], ['lipid', true], ['.', false]], 'term');
  eq(hl('A lipid nanoparticle comprising an ionizable lipid.', '"ionizable lipid"'), [['A lipid nanoparticle comprising an ', false], ['ionizable lipid', true], ['.', false]], 'phrase marks only the phrase');
  eq(hl('Ionisierbares Lipid für Nukleinsäuren, Größe 80 nm', 'nukleinsaur* grosse'), [['Ionisierbares Lipid für ', false], ['Nukleinsäuren', true], [', ', false], ['Größe', true], [' 80 nm', false]], 'umlaut, sharp s, prefix: offsets in the original text');
  eq(hl('Nukleinsäure und Lipid', 'nukleinsaure'), [['Nukleinsäure', true], [' und Lipid', false]], 'combining mark inside a word');
  eq(hl('pKa 🧪 of the lipid 𝐀 is 6', 'lipid 6'), [['pKa 🧪 of the ', false], ['lipid', true], [' 𝐀 is ', false], ['6', true]], 'surrogate pairs before a match');
  eq(hl('the ﬁrst lipid', 'first'), [['the ', false], ['ﬁrst', true], [' lipid', false]], 'ligature expands under NFKD');
  eq(hl('a cationic lipid and a neutral lipid', 'cationic NEAR/1 lipid'), [['a ', false], ['cationic', true], [' ', false], ['lipid', true], [' and a neutral lipid', false]], 'NEAR marks only close pairs');
  eq(hl('lipid and mRNA', 'lipid -mRNA'), [['lipid', true], [' and mRNA', false]], 'negated terms are not marked');
  eq(hl('selected from the group consisting of DSPC', '"selected from the group"'), [['selected from the group', true], [' consisting of DSPC', false]], 'phrase across stop words');
  eq(hl('', 'lipid'), [], 'empty text'); eq(hl('no match here', 'lipid'), [['no match here', false]], 'no match');
  { // on real claims: pieces concatenate to the text, every marked piece consists of query terms
    let n = 0, bad = 0;
    for (const q of ['ioniz* lipid', '"nucleic acid" NEAR/5 lipid', 'cholesterol OR "polyethylene glycol"', 'lang:de lipid* nukleinsaure']) {
      const parsed = SC.parse(q, TOK), r = await core.search(q, { limit: 40, facets: false, perHit: 2 });
      for (const h of r.hits) for (const t of h.top) {
        n++;
        const u = (() => { for (let x = ref.first[h.p]; x < ref.first[h.p + 1]; x++) if (ref.uNo[x] === t.n && ['claim', 'title', 'abstract', 'assignee'][ref.uKind[x]] === t.field && (ref.uDe[x] ? 'de' : 'en') === t.lang) return x; return -1; })();
        if (u < 0) { bad++; continue; }
        const text = ref.uText[u], full = await core.highlight(text, parsed);
        if (full.map((s) => s[0]).join('') !== text || !full.some((s) => s[1])) { bad++; continue; }
        const snip = t.snippet, mid = snip.filter((s, i) => !((i === 0 && s[0] === '... ') || (i === snip.length - 1 && s[0] === ' ...'))).map((s) => s[0]).join('');
        if (!text.includes(mid) || !snip.some((s) => s[1]) || mid.length > 330) bad++;
        const terms = new Set(); (function walk(a) { if (!a) return; if (a.t) terms.add(a.t); if (a.ts) a.ts.forEach((x) => terms.add(x)); if (a.xs) a.xs.forEach(walk); if (a.a) walk(a.a); if (a.b) walk(a.b); })(parsed.ast);
        for (const s of full) if (s[1]) for (const w of rwords(s[0])) if (!STOP.has(w) && ![...terms].some((x) => w === x || w.startsWith(x))) { bad++; break; }
      }
    }
    ok(bad === 0 && n > 50, `snippets and highlights of ${n} best units are consistent with the claim text`, bad + ' bad');
  }

  section('claims, definitions, abstract, images, suggest');
  { let n = 0, bad = 0, tree = 0, withDefs = 0;
    for (let p = 0; p < ref.P && n < 150; p++) {
      const r = ref.rec[p]; if (!r.textKept) continue; if ((p * 7919) % 5) continue; n++;
      const cl = await core.claims(p), want = [...r.claims.en.map((c) => ['en', c]), ...r.claims.de.map((c) => ['de', c])];
      if (cl.length !== want.length) { bad++; continue; }
      for (let i = 0; i < cl.length; i++) { const [l, c] = want[i], g = cl[i]; if (g.n !== c.n || g.lang !== l || g.text !== c.t || g.indep !== !(c.dep && c.dep.length) || JSON.stringify(g.dep) !== JSON.stringify(c.dep || [])) { bad++; break; } }
      // dependency tree: children and roots
      for (const l of ['en', 'de']) { const list = r.claims[l], by = new Map(list.map((c) => [c.n, c]));
        const roots = (c, seen = new Set()) => { if (!(c.dep && c.dep.length)) return [c.n]; const o = new Set(); for (const d of c.dep) { const par = by.get(d); if (!par || seen.has(d)) continue; seen.add(d); for (const x of roots(par, seen)) o.add(x); } return [...o].sort((a, b) => a - b); };
        for (const c of list) { const g = cl.find((x) => x.lang === l && x.n === c.n), kids = list.filter((x) => (x.dep || []).includes(c.n)).map((x) => x.n); if (!g || JSON.stringify(g.children.slice().sort((a, b) => a - b)) !== JSON.stringify([...new Set(kids)].sort((a, b) => a - b)) || JSON.stringify(g.roots) !== JSON.stringify(roots(c))) tree++; } }
      const en = await core.claims(p, 'en'); if (en.length !== r.claims.en.length) bad++;
      const d = await core.defs(p); if (JSON.stringify(d) !== JSON.stringify(r.defs)) bad++; if (r.defs.length) withDefs++;
      const ab = await core.abstract(p); if ((ab || null) !== (r.abstract || null)) bad++;
    }
    ok(bad === 0 && n >= 100, `claims / definitions / abstract of ${n} publications = corpus`, bad + ' differ'); ok(tree === 0, 'dependency tree (children, roots)', tree + ' claims differ'); ok(withDefs > 10, 'definition paragraphs present', String(withDefs));
    const biblio = ref.rec.findIndex((r) => !r.textKept); eq(await core.claims(biblio), [], 'biblio-only publication has no claims'); eq(await core.defs(biblio), [], 'biblio-only publication has no definitions');
  }
  { const s = await core.suggest('ioni');
    ok(s.length > 0 && s.length <= 10 && s.every((x) => x.term.startsWith('ioni')) && s.every((x, i) => i === 0 || s[i - 1].df >= x.df), 'suggest: prefix, at most 10, by frequency', JSON.stringify(s.slice(0, 3)));
    let df = 0; const id = ref.vocab.get(s[0].term); for (let u = 0; u < ref.D; u++) if (ref.uTok[u].includes(id)) df++;
    eq(s[0].df, df, 'suggest: document frequency'); eq(await core.suggest(''), [], 'suggest: empty prefix'); eq((await core.suggest('Lipid nanop')).every((x) => x.term.startsWith('nanop')), true, 'suggest completes the last word'); }
  { for (const pn of first) { const p = ref.rec.findIndex((r) => r.pn === pn), im = await core.claimImages(p); let good = im.length === 2;
      for (let k = 0; good && k < 2; k++) { const b = Buffer.from(await im[k].blob.arrayBuffer()), w = made[pn][k]; good = im[k].id === w.id && im[k].claim === w.claim && im[k].w === w.w && im[k].h === w.h && im[k].blob.type === 'image/png' && crypto.createHash('sha256').update(b).digest('hex') === w.sha; }
      ok(good, `claim images of ${pn}`); }
    eq(await core.claimImages(ref.rec.findIndex((r) => !first.includes(r.pn))), [], 'no images -> empty list');
    const i64 = await c64.core.claimImages(ref.rec.findIndex((r) => r.pn === first[0])); ok(i64.length === 2 && i64[0].blob.size === made[first[0]][0].bytes, 'claim images from the base64 dist'); }

  section('publication numbers');
  const pnCases = [['EP 3 532 103 B1', 'EP3532103', 'B1'], ['EP3532103', 'EP3532103', ''], ['ep 3532103 b1', 'EP3532103', 'B1'], ['EP-3532103-B1', 'EP3532103', 'B1'], ['EP 1 765 289', 'EP1765289', ''], ['EP0430149B1', 'EP0430149', 'B1'],
    ['US 8,058,069', 'US8058069', ''], ['US8058069B2', 'US8058069', 'B2'], ['US 8,058,069 B2', 'US8058069', 'B2'], ['US-8058069-B2', 'US8058069', 'B2'], ['US 2017/0210697 A1', 'US20170210697', 'A1'], ['US20170210697', 'US20170210697', ''], ['US 2017/210697', 'US20170210697', ''],
    ['US RE45,678 E1', 'USRE45678', 'E1'], ['WO2017/075531', 'WO2017075531', ''], ['WO 2017/075531 A1', 'WO2017075531', 'A1'], ['WO 17/075531', 'WO2017075531', ''], ['WO2017075531A1', 'WO2017075531', 'A1'], ['WO 99/39741', 'WO1999039741', ''], ['wo2017/75531', 'WO2017075531', ''], ['8,058,069', 'US8058069', ''], ['3532103', 'EP3532103', '']];
  for (const [inp, base, kind] of pnCases) { const r = TOK.pn(inp); ok(r && r.bases.includes(base) && r.kind === kind && (!kind || r.full.includes(base + kind)), `pn("${inp}") -> ${base}${kind}`, JSON.stringify(r)); }
  for (const bad of ['', '   ', 'lipid', 'EP', 'EP12AB34']) ok(TOK.pn(bad) === null, `pn("${bad}") is rejected`);
  eq(TOK.pnBase('EP3532103B1'), 'EP3532103', 'pnBase'); eq(TOK.pnBase('USRE45678E1'), 'USRE45678', 'pnBase reissue');
  { // every style of writing a number finds the publication through the engine (pn: field)
    let n = 0, bad = 0; const fmt = (pn) => { const m = /^([A-Z]{2})(\d+)([A-Z]\d?)$/.exec(pn); if (!m) return []; const [, cc, num, kd] = m, out = [`${cc} ${num} ${kd}`, `${cc}-${num}-${kd}`, `${cc.toLowerCase()}${num}${kd.toLowerCase()}`];
      if (cc === 'EP' && num.length === 7) out.push(`EP ${num[0]} ${num.slice(1, 4)} ${num.slice(4)} ${kd}`);
      if (cc === 'US' && num.length <= 8) out.push(`US ${Number(num).toLocaleString('en-US')} ${kd}`);
      if (cc === 'US' && num.length === 11) out.push(`US ${num.slice(0, 4)}/${num.slice(4)} ${kd}`, `US${num.slice(0, 4)}/${num.slice(5)}${kd}`);
      if (cc === 'WO' && num.length === 10) out.push(`WO${num.slice(0, 4)}/${num.slice(4)}`, `WO ${num.slice(2, 4)}/${num.slice(4)} ${kd}`, `WO ${num.slice(0, 4)}/${num.slice(4)} ${kd}`);
      return out; };
    const byBase = new Map(); ref.rec.forEach((r, p) => { const b = r.pn.replace(/[A-Z]\d?$/, ''); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(p); });
    for (let p = 0; p < ref.P; p += 211) { const pn = ref.rec[p].pn;
      for (const s of fmt(pn)) { n++; const r = await core.search('', { filters: { pn: [s] }, limit: 0, all: true, facets: false }); const got = Array.from(r.all), hasKind = /[A-Za-z]\d?$/.test(s.trim());
        const good = hasKind ? (got.length === 1 && got[0] === p) : sameSet(got, byBase.get(pn.replace(/[A-Z]\d?$/, '')));
        if (!good) { bad++; if (bad <= 5) note(`pn style "${s}" for ${pn} -> ${JSON.stringify(got.map((x) => ref.rec[x].pn))}`); } } }
    ok(bad === 0 && n > 1500, `${n} written forms of real publication numbers resolve to the publication`, bad + ' failed');
    R.numbers.pnForms = n;
  }

  section('budget cut (small corpus, tight budget)');
  { const LIM = 30000, big = build('lim', ['--limit', String(LIM), '--no-chem', '--budget-mb', '200']);
    const rep = JSON.parse(fs.readFileSync(path.join(big.bd, 'dist_report_bin.json'), 'utf8')), s = rep.sizes, idxB = (s['claim text'] || 0) + (s.postings || 0) + (s.positions || 0) + (s.definitions || 0) + (s['index other'] || 0);
    const budget = +((rep.bytes - idxB * 0.5) / 1e6).toFixed(2);
    const cutB = build('cut', ['--limit', String(LIM), '--no-chem', '--budget-mb', String(budget)]);
    const m = JSON.parse(fs.readFileSync(path.join(cutB.out, 'data', 'manifest.json'), 'utf8')), rep2 = JSON.parse(fs.readFileSync(path.join(cutB.bd, 'dist_report_bin.json'), 'utf8'));
    ok(rep2.bytes <= budget * 1e6, `dist stays under the budget of ${budget} MB`, (rep2.bytes / 1e6).toFixed(2) + ' MB');
    ok(rep2.bytes >= budget * 1e6 * 0.93, 'budget is used (at least 93 %)', (rep2.bytes / 1e6).toFixed(2) + ' MB');
    ok(m.cut.applied && m.cut.text.cut > 0 && m.cut.text.kept + m.cut.text.cut === m.cut.text.available, 'manifest records the cut', JSON.stringify(m.cut.text));
    ok(/BUDGET CUT/.test(cutB.log) && fs.existsSync(path.join(cutB.bd, 'cut.jsonl')), 'cut is logged and listed in cut.jsonl');
    const refC = await loadRef(cutB.bd, LIM), NC = mk(refC), cc = await nodeCore(cutB.out);
    const cutList = fs.readFileSync(path.join(cutB.bd, 'cut.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    eq(cutList.filter((c) => c.lost !== 'defs').map((c) => c.pn).sort(), refC.rec.filter((r) => r.hasText && !r.textKept).map((r) => r.pn).sort(), 'cut.jsonl lists exactly the publications without claims');
    eq(m.cut.text.cut, refC.rec.filter((r) => r.hasText && !r.textKept).length, 'manifest cut count');
    // priority: seed families keep everything; every kept publication ranks before every cut one
    const key = (r) => [r.seedTier || 9, r.tier, -r.pub, r.pn], lt = (a, b) => { for (let i = 0; i < 4; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };
    const kept = refC.rec.filter((r) => r.hasText && r.textKept && !r.seedTier), cut = refC.rec.filter((r) => r.hasText && !r.textKept);
    ok(refC.rec.every((r) => !r.seedTier || !r.hasText || (r.textKept && (r.lv >= 2 || !r.hasDefs))), 'seed families keep claims and definitions');
    const maxKept = kept.reduce((a, r) => (a && lt(key(r), a)) ? a : key(r), null), minCut = cut.reduce((a, r) => (a && lt(a, key(r))) ? a : key(r), null);
    ok(maxKept && minCut && lt(maxKept, minCut), 'kept claims are a priority prefix (seed tier, tier, newest first)', JSON.stringify([maxKept, minCut]));
    // definitions: kept ones form a priority prefix among the publications that kept their claims
    const dk = refC.rec.filter((r) => r.hasDefs && r.lv >= 2 && !r.seedTier), dc = refC.rec.filter((r) => r.hasDefs && r.lv < 2 && r.textKept);
    const maxDk = dk.reduce((a, r) => (a && lt(key(r), a)) ? a : key(r), null), minDc = dc.reduce((a, r) => (a && lt(a, key(r))) ? a : key(r), null);
    ok(!maxDk || !minDc || lt(maxDk, minDc), 'kept definitions are a priority prefix', JSON.stringify([maxDk, minDc]));
    note(`cut build: ${m.cut.text.kept}/${m.cut.text.available} full texts kept, definitions kept for ${m.cut.defs.kept}/${m.cut.defs.available}`);
    // flags and searches on the cut dist
    const chunk0 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cutB.out, 'data', 'pat-000.gz.bin'))).toString('utf8'));
    let fl = 0; for (let i = 0; i < chunk0.pn.length; i++) { const r = refC.rec[i]; if (((chunk0.flags[i] & 1) === 1) !== r.textKept || ((chunk0.flags[i] & 32) === 32) !== (r.hasText && !r.textKept) || ((chunk0.flags[i] & 2) === 2) !== (r.defs.length > 0) || ((chunk0.flags[i] & 64) === 64) !== (r.hasDefs && r.lv < 2)) fl++; }
    ok(fl === 0, 'patent flags (text, defs, textCut, defsCut) match the cut', fl + ' rows differ');
    const pk = picks(refC), QC = querySet(refC, NC, pk);
    await runQueries('cut', cc.core, refC, QC, { strictMin: false });
    const cp = refC.rec.findIndex((r) => r.hasText && !r.textKept); eq(await cc.core.claims(cp), [], 'a cut publication has no claims'); ok((await cc.core.search('', { filters: { pn: [refC.rec[cp].pn] }, limit: 1 })).total === 1, 'a cut publication stays in the patent table');
    R.numbers.cut = { budgetMb: budget, bytes: rep2.bytes, text: m.cut.text, defs: m.cut.defs, attempts: m.cut.attempts };
  }
  return { B, B64, ref, pick, first, made, core };
}

// ------------------------------------------------------------------------------------------------ static server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain', '.bin': 'application/octet-stream', '.css': 'text/css' };
const PAGE = '<!doctype html><meta charset="utf-8"><title>t</title><script src="engine/tok.js"></script><script src="engine/loader.js"></script><script src="engine/data.js"></script><script src="engine/search.js"></script><body>test</body>';
function serve(roots) {
  const log = [], missed = [];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const m = /^\/([a-z0-9]+)\/(.*)$/.exec(u);
    if (!m || !roots[m[1]]) { res.writeHead(404); return res.end('nf'); }
    if (m[2] === '__t.html') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(PAGE); }
    const f = path.join(roots[m[1]], m[2]);
    if (!f.startsWith(roots[m[1]]) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (m[2] !== 'favicon.ico') missed.push(u); res.writeHead(404); return res.end('nf'); }
    log.push(u);
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-length': fs.statSync(f).size, 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, log, missed })));
}
function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}

// runs inside the page
async function pageRun(a) {
  const out = { errors: [] };
  const S = window.LnpSearch, D = window.LnpData;
  S.reset(); D.reset();
  const t0 = performance.now();
  try {
    out.dataInit = !!(await D.init(Object.assign({ base: 'data/' }, a.init)));
    out.dataDiag = await D.diag();
    out.info = await S.init(Object.assign({}, a.init)); out.initMs = performance.now() - t0;
    out.diag = await S.diag();
    out.results = [];
    for (const q of a.queries) { const r = await S.search(q.q, Object.assign({ limit: 10, all: true }, q.opts)); out.results.push({ total: r.total, top: r.hits.map((h) => h.p), scores: r.hits.map((h) => h.score), all: Array.from(r.all), facetAuth: r.facets && r.facets.auth, best: r.hits[0] && r.hits[0].best, warnings: r.parsed.warnings.length }); }
    const cl = await S.claims(a.p); out.claims = cl.map((c) => [c.n, c.lang, c.indep, c.dep, c.text.length, c.roots]);
    out.claimsEn = (await S.claims(a.p, 'en')).length;
    out.defs = (await S.defs(a.p)).map((d) => d.length);
    out.suggest = await S.suggest('ioni');
    out.highlight = await S.highlight('A lipid nanoparticle comprising an ionizable lipid.', (await S.parse('"ionizable lipid"')));
    out.highlightStr = await S.highlight('ionizable lipid', 'lipid');
    const im = await S.claimImages(a.p); out.images = [];
    for (const x of im) { const b = new Uint8Array(await x.blob.arrayBuffer()); out.images.push({ claim: x.claim, id: x.id, w: x.w, h: x.h, type: x.blob.type, size: b.length, head: Array.from(b.slice(0, 8)) }); }
    // LnpData
    out.patent = await D.patent(a.p); out.patents = (await D.patents([0, a.p, a.p2])).map((x) => x.pn);
    out.byPn = []; for (const s of a.pnInputs) out.byPn.push(await D.byPn(s));
    out.family = await D.family(a.p); out.status = await D.status(a.sp); out.statusNone = await D.status(a.np);
    out.links = await D.links(a.p); out.links2 = await D.links(a.p2);
    const all = await D.all(); out.all = { n: all.n, pnA: all.pn[a.p], pubA: all.pub[a.p], famA: all.fam[a.p], flagsA: all.flags[a.p], last: all.pn[all.n - 1], types: [all.pub.constructor.name, all.flags.constructor.name] };
    out.manifest = { enc: D.manifest.enc, patents: D.manifest.counts.patents }; out.seed = !!(D.seed && D.seed.families && D.seed.families.length);
    try { await D.patent(-1); out.rangeErr = null; } catch (e) { out.rangeErr = e && e.code; }
    out.dataDiag2 = await D.diag();
  } catch (e) { out.errors.push((e && (e.code + ': ' + e.message)) || String(e)); }
  return out;
}
async function pagePerf(a) {
  const S = window.LnpSearch, rows = [];
  for (const q of a.queries) {
    S.reset(); const t0 = performance.now(); await S.init({ mode: a.mode }); const init = performance.now() - t0;
    const t1 = performance.now(); const r = await S.search(q, { limit: 25 }); const cold = performance.now() - t1;
    const warm = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await S.search(q, { limit: 25 }); warm.push(performance.now() - t); } warm.sort((x, y) => x - y);
    const tg = performance.now(); await S.search(q, { limit: 25, group: 'family' }); const fam = performance.now() - tg;
    rows.push({ q, total: r.total, init: Math.round(init), cold: Math.round(cold), warm: +warm[2].toFixed(1), warmMax: +warm[4].toFixed(1), family: +fam.toFixed(1), engineMs: r.ms });
  }
  return { rows, mode: (await S.diag()).mode };
}

async function browserPart(ctx) {
  section('browser: engine modes (Playwright, Chromium)');
  const pw = loadPlaywright();
  if (!ok(!!pw, 'Playwright is available')) return;
  const { B, B64, ref, pick, first, made, core } = ctx;
  const { srv, port, log, missed } = await serve({ bin: B.out, b64: B64.out });
  const browser = await pw.chromium.launch();
  try {
    const queries = [{ q: 'lipid nanoparticle' }, { q: '"ionizable lipid" cholesterol' }, { q: 'ioniz* NEAR/3 lipid' }, { q: 'title:liposome year:2015-2020 -cpc:C07C' }, { q: 'asg:moderna indep:(mRNA)' }, { q: 'same:(PEG cholesterol phospholipid)' },
      { q: `pn:"${pick.pnSpaced}"` }, { q: '', opts: { filters: { auth: ['EP'], yearFrom: 2021 } } }, { q: 'lang:de lipid* nukleinsäure' }, { q: 'cholesterol', opts: { group: 'family', filters: { indepOnly: true } } }];
    const expect = []; for (const q of queries) { const r = await core.search(q.q, Object.assign({ limit: 10, all: true }, q.opts)); expect.push({ total: r.total, top: r.hits.map((h) => h.p), all: Array.from(r.all), scores: r.hits.map((h) => h.score) }); }
    const pImg = ref.rec.findIndex((r) => r.pn === first[0]), sp = ref.rec.findIndex((r) => r.st !== ''), np = ref.rec.findIndex((r) => r.st === '' && r.deIn === 2);
    const us = ref.rec[pick.p2].pn, usNum = /^US(\d+)/.exec(us)[1];
    const wo = ref.rec.find((r) => /^WO\d{10}A1$/.test(r.pn)).pn, usA = ref.rec.find((r) => /^US\d{11}A1$/.test(r.pn)).pn;
    const pnInputs = [ref.rec[pImg].pn, pick.pnSpaced, pick.pnBase, `US ${Number(usNum).toLocaleString('en-US')}`, us, `${wo.slice(0, 6)}/${wo.slice(6, 12)}`, `WO ${wo.slice(4, 6)}/${wo.slice(6, 12)} A1`, `US ${usA.slice(2, 6)}/${usA.slice(6, 13)} A1`, 'EP 3 532 103 B1', 'US 8,058,069', 'WO2017/075531', 'EP9999999', 'nonsense'];
    const pnWant = [(r) => r === pImg, (r) => r === pick.p, (r) => pick.baseSet.has(r), (r) => ref.rec[r] && ref.rec[r].pn.startsWith('US' + usNum), (r) => r === pick.p2, (r) => ref.rec[r] && ref.rec[r].pn.startsWith(wo.slice(0, 12)), (r) => ref.rec[r] && ref.rec[r].pn === wo, (r) => ref.rec[r] && ref.rec[r].pn === usA,
      (r) => ref.rec[r] && ref.rec[r].pn === 'EP3532103B1', (r) => ref.rec[r] && ref.rec[r].pn.startsWith('US8058069'), (r) => ref.rec[r] && ref.rec[r].pn.startsWith('WO2017075531'), (r) => r === -1, (r) => r === -1];
    const a = { queries, p: pImg, p2: pick.p2, sp, np, pnInputs };
    const wantClaims = await core.claims(pImg), wantDefs = await core.defs(pImg);
    async function check(label, root, init, pre, wantMode, wantDataMode) {
      const page = await browser.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      if (pre) await page.addInitScript(pre);
      const before = log.length, before404 = missed.length;
      await page.goto(`http://127.0.0.1:${port}/${root}/__t.html`);
      const o = await page.evaluate(pageRun, Object.assign({}, a, { init }));
      const reqs = log.slice(before);
      await page.close();
      if (!ok(o.errors.length === 0 && o.info, `${label}: runs`, o.errors.join(' | ') + ' ' + errs.join(' | '))) return o;
      eq(o.info.mode, wantMode, `${label}: search engine mode`); eq(o.dataDiag.mode, wantDataMode || wantMode, `${label}: data mode`);
      eq([o.info.D, o.info.P], [ref.D, ref.P], `${label}: index size`);
      let good = true; for (let i = 0; i < queries.length; i++) { const g = o.results[i], w = expect[i]; if (g.total !== w.total || !sameSet(g.all, w.all) || JSON.stringify(g.top) !== JSON.stringify(w.top) || JSON.stringify(g.scores) !== JSON.stringify(w.scores)) { good = false; note(`${label}: query ${i} "${queries[i].q}" differs: ${g.total} vs ${w.total}`); } }
      ok(good, `${label}: ${queries.length} queries = Node engine (totals, complete sets, top 10, scores)`);
      eq(o.claims, wantClaims.map((c) => [c.n, c.lang, c.indep, c.dep, c.text.length, c.roots]), `${label}: claims`); eq(o.claimsEn, wantClaims.filter((c) => c.lang === 'en').length, `${label}: claims(lang)`);
      eq(o.defs, wantDefs.map((d) => d.length), `${label}: defs`);
      ok(o.suggest.length > 0 && o.suggest[0].term.startsWith('ioni'), `${label}: suggest`);
      eq(o.highlight, [['A lipid nanoparticle comprising an ', false], ['ionizable lipid', true], ['.', false]], `${label}: highlight`); eq(o.highlightStr, [['ionizable ', false], ['lipid', true]], `${label}: highlight with a query string`);
      eq(o.images.map((x) => [x.claim, x.id, x.w, x.h, x.type, x.size]), made[first[0]].map((x) => [x.claim, x.id, x.w, x.h, 'image/png', x.bytes]), `${label}: claim images`); ok(o.images.every((x) => x.head.join() === '137,80,78,71,13,10,26,10'), `${label}: image bytes are PNG`);
      const r = ref.rec[pImg];
      ok(o.patent.pn === r.pn && o.patent.auth === r.auth && o.patent.kind === r.kind && o.patent.pub === r.pub && o.patent.fam === r.fam && o.patent.title === r.title && o.patent.assignee === r.asg && o.patent.text === true && o.patent.tier === r.tier && o.patent.seedTier === r.seedTier && JSON.stringify(o.patent.cpc) === JSON.stringify(r.cpc) && o.patent.status === r.st && o.patent.exp === r.exp && o.patent.deIn === r.deIn && o.patent.player === r.player && o.patent.hasDefs === (r.defs.length > 0) && o.patent.hasImg === r.img, `${label}: LnpData.patent`, JSON.stringify(o.patent).slice(0, 400));
      eq(o.patents, [ref.rec[0].pn, r.pn, ref.rec[pick.p2].pn], `${label}: LnpData.patents`);
      for (let i = 0; i < pnInputs.length; i++) ok(pnWant[i](o.byPn[i]), `${label}: byPn("${pnInputs[i]}")`, `-> ${o.byPn[i]} ${ref.rec[o.byPn[i]] ? ref.rec[o.byPn[i]].pn : ''}`);
      const fam = []; ref.rec.forEach((x, i) => { if (x.fam === r.fam) fam.push(i); }); eq(o.family.slice().sort((x, y) => x - y), fam, `${label}: family`);
      ok(o.status && o.status.pn === ref.rec[sp].pn && typeof o.status.code === 'string', `${label}: status detail`, JSON.stringify(o.status).slice(0, 200)); eq(o.statusNone, null, `${label}: status of a publication without status`);
      ok(/^https:\/\/worldwide\.espacenet\.com\//.test(o.links.espacenet) && o.links.espacenet.includes(r.pn) && o.links.google === `https://patents.google.com/patent/${r.pn}/en` && (r.auth !== 'EP' || /^https:\/\/register\.epo\.org\//.test(o.links.register)) && (r.auth === 'EP' ? o.links.uspto === null : true), `${label}: links (EP)`, JSON.stringify(o.links));
      ok(o.links2.register === null && /^https:\/\/ppubs\.uspto\.gov\//.test(o.links2.uspto) && o.links2.uspto.includes(usNum), `${label}: links (US)`, JSON.stringify(o.links2));
      ok(o.all.n === ref.P && o.all.pnA === r.pn && o.all.pubA === r.pub && o.all.famA === r.fam && (o.all.flagsA & 1) === 1 && o.all.last === ref.rec[ref.P - 1].pn && o.all.types.join() === 'Int32Array,Uint8Array', `${label}: LnpData.all`, JSON.stringify(o.all));
      eq(o.rangeErr, 'range', `${label}: clear error for a bad index`); ok(o.seed, `${label}: seed.json loaded`);
      ok(reqs.every((u) => u.startsWith(`/${root}/`)), `${label}: only relative same-origin requests`);
      ok(missed.length === before404, `${label}: no request for a file that does not exist`, missed.slice(before404).join(' '));
      ok(errs.length === 0, `${label}: no page errors`, errs.join(' | '));
      note(`${label}: mode ${o.info.mode}/${o.dataDiag.mode}, gzip ${o.info.gzip}, enc ${o.info.enc}, init ${o.initMs | 0} ms, ${reqs.length} requests`);
      return o;
    }
    for (const mode of ['worker', 'blob', 'main']) {
      const o = await check(`bin ${mode}`, 'bin', { mode }, null, mode); if (o.info) { eq(o.info.gzip, 'native', `bin ${mode}: native gzip`); eq(o.info.enc, 'bin', `bin ${mode}: enc`); }
      const f = await check(`bin ${mode} fflate`, 'bin', { mode, gzip: 'fflate' }, null, mode); if (f.info) { eq(f.info.gzip, 'fflate', `bin ${mode}: bundled inflate used`); eq(f.dataDiag.gzip, 'fflate', `bin ${mode}: bundled inflate used by LnpData`); }
      const b = await check(`b64 ${mode}`, 'b64', { mode }, null, mode); if (b.info) { eq(b.info.enc, 'b64', `b64 ${mode}: enc`); eq(b.manifest.enc, 'b64', `b64 ${mode}: manifest.enc`); }
    }
    // automatic chain
    const a1 = await check('auto', 'bin', {}, null, 'worker'); if (a1.info) eq(a1.info.tried.map((t) => [t.mode, t.ok]), [['worker', true]], 'auto: worker first');
    const noFile = () => { const W = window.Worker; window.Worker = function (u, o) { if (!/^blob:/.test(String(u))) throw new Error('file workers are blocked in this test'); return new W(u, o); }; };
    const a2 = await check('auto, file workers blocked', 'bin', {}, noFile, 'blob'); if (a2.info) eq(a2.info.tried.map((t) => [t.mode, t.ok]), [['worker', false], ['blob', true]], 'auto: falls back to the blob worker');
    const a3 = await check('auto, no workers', 'bin', {}, () => { delete window.Worker; window.Worker = undefined; }, 'main'); if (a3.info) eq(a3.info.tried.map((t) => [t.mode, t.ok]), [['worker', false], ['blob', false], ['main', true]], 'auto: falls back to the main thread');
    const dead = () => { window.Worker = function () { const w = { postMessage() {}, terminate() {}, onmessage: null, onerror: null }; return w; }; };
    const a4 = await check('auto, workers never answer', 'bin', { timeoutMs: 300 }, dead, 'main');
    if (a4.info) ok(a4.info.tried.length === 3 && /did not answer/.test(a4.info.tried[0].error || ''), 'auto: a silent worker times out and the chain goes on', JSON.stringify(a4.info.tried));
    const noDS = () => { delete window.DecompressionStream; window.DecompressionStream = undefined; };
    const a5 = await check('main without DecompressionStream', 'bin', { mode: 'main' }, noDS, 'main'); if (a5.info) eq([a5.info.gzip, a5.dataDiag.gzip], ['fflate', 'fflate'], 'fflate is used when DecompressionStream is missing');
    const a6 = await check('auto, b64, no workers, no DecompressionStream', 'b64', {}, () => { window.Worker = undefined; window.DecompressionStream = undefined; }, 'main'); if (a6.info) eq([a6.info.gzip, a6.info.enc], ['fflate', 'b64'], 'worst case: main thread + fflate + base64');
    // error objects
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/bin/__t.html`);
    const e1 = await page.evaluate(async () => { try { await window.LnpSearch.init({ base: 'nothing-here/', mode: 'main' }); return null; } catch (e) { return { code: e.code, message: e.message, status: e.status, tried: e.tried && e.tried.length }; } });
    ok(e1 && e1.code === 'http' && e1.status === 404 && /manifest\.json/.test(e1.message), 'missing data gives a clear error object', JSON.stringify(e1));
    const e2 = await page.evaluate(async () => { const L = window.LnpLoader.create({ base: 'data/' }); const ev = []; L.on((e) => ev.push(e.type)); const b = await L.get('idx/docs.gz.bin'); const again = await L.get('idx/docs.gz.bin'); let err = null; try { await L.get('idx/none.gz.bin'); } catch (e) { err = e.code + ':' + e.status; } const d = L.diag(); return { bytes: b.byteLength, same: b === again, ev: [...new Set(ev)], err, fetches: d.fetches, cached: d.cached }; });
    ok(e2.bytes > 1000 && e2.same && e2.fetches === 1 && e2.cached === 1 && e2.err === 'http:404' && ['start', 'progress', 'done', 'error'].every((t) => e2.ev.includes(t)), 'loader: inflates, caches (LRU), emits progress events, clear 404 error', JSON.stringify(e2));
    await page.close();
  } finally { await browser.close(); srv.close(); }
}

// ------------------------------------------------------------------------------------------------ performance
const PERF_Q = ['lipid', 'lipid nanoparticle', 'cholesterol', 'composition comprising', '"lipid nanoparticle"', '"ionizable lipid" cholesterol PEG', 'ioniz* NEAR/3 lipid', 'mRNA AND (cholesterol OR sterol) NOT siRNA',
  '"pharmaceutical composition" lipid cationic', 'lipid* nano*', 'title:liposome year:2015-2022', 'asg:moderna mRNA', 'same:(PEG cholesterol phospholipid)', 'indep:("molar ratio") lipid', 'cpc:A61K9/51 lipid nanoparticle',
  'verbindung OR compound', '"nucleic acid" NEAR/5 lipid', 'auth:EP status:granted cationic lipid', 'compound formula alkyl', ''];
async function perfPart(dist) {
  section('performance (' + dist + ')');
  const man = JSON.parse(fs.readFileSync(path.join(dist, 'data', 'manifest.json'), 'utf8'));
  note(`corpus: ${man.counts.patents} publications, ${man.counts.fulltext} with full text, ${man.counts.claims} claims, ${man.idx.D} units, ${man.idx.nTerms} terms`);
  const rows = [];
  for (const q of PERF_Q) {
    const fetchFs = async (u) => new Response(fs.readFileSync(path.join(dist, u)));
    const core = SC.create({ fetch: fetchFs }); const t0 = performance.now(); await core.init({ base: 'data/', fetch: fetchFs }); const init = performance.now() - t0;
    const t1 = performance.now(); const c = await core.search(q, { limit: 25 }); const cold = performance.now() - t1;
    const w = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await core.search(q, { limit: 25 }); w.push(performance.now() - t); } w.sort((x, y) => x - y);
    const tg = performance.now(); await core.search(q, { limit: 25, group: 'family' }); const fam = performance.now() - tg;
    rows.push({ q: q || '(empty)', total: c.total, init: Math.round(init), cold: Math.round(cold), warm: +w[2].toFixed(1), warmMax: +w[4].toFixed(1), family: +fam.toFixed(1) });
  }
  console.table(rows);
  ok(rows.every((r) => r.cold < 1500), 'Node: every cold query < 1500 ms', rows.filter((r) => r.cold >= 1500).map((r) => `${r.q} ${r.cold}`).join('; '));
  ok(rows.every((r) => r.warm < 150), 'Node: every warm query < 150 ms (median of 5)', rows.filter((r) => r.warm >= 150).map((r) => `${r.q} ${r.warm}`).join('; '));
  ok(rows.every((r) => r.family < 150), 'Node: warm query grouped by family < 150 ms', rows.filter((r) => r.family >= 150).map((r) => `${r.q} ${r.family}`).join('; '));
  R.numbers.perfNode = { maxCold: Math.max(...rows.map((r) => r.cold)), maxWarm: Math.max(...rows.map((r) => r.warm)), maxInit: Math.max(...rows.map((r) => r.init)), rssMb: (process.memoryUsage().rss / 1e6) | 0, rows };
  if (args['no-browser']) return;
  const pw = loadPlaywright(); if (!ok(!!pw, 'Playwright is available')) return;
  const { srv, port } = await serve({ perf: dist }); const browser = await pw.chromium.launch();
  try {
    for (const mode of ['worker', 'main']) {
      const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/perf/__t.html`);
      const o = await page.evaluate(pagePerf, { queries: PERF_Q, mode }); await page.close();
      console.log(`  browser, mode ${o.mode}:`); console.table(o.rows.map((r) => Object.assign({}, r, { q: r.q || '(empty)' })));
      ok(o.rows.every((r) => r.cold < 1500), `browser ${mode}: every cold query < 1500 ms`, o.rows.filter((r) => r.cold >= 1500).map((r) => `${r.q} ${r.cold}`).join('; '));
      ok(o.rows.every((r) => r.warm < 150), `browser ${mode}: every warm query < 150 ms (median of 5)`, o.rows.filter((r) => r.warm >= 150).map((r) => `${r.q} ${r.warm}`).join('; '));
      R.numbers['perfBrowser_' + mode] = { maxCold: Math.max(...o.rows.map((r) => r.cold)), maxWarm: Math.max(...o.rows.map((r) => r.warm)), maxInit: Math.max(...o.rows.map((r) => r.init)), rows: o.rows };
    }
  } finally { await browser.close(); srv.close(); }
}

// ------------------------------------------------------------------------------------------------ main
let ctx = null;
if (!ONLY || ONLY === 'node' || ONLY === 'browser') ctx = await nodePart();
if ((!ONLY || ONLY === 'browser') && !args['no-browser']) await browserPart(ctx);
if (args.perf && (!ONLY || ONLY === 'perf')) await perfPart(path.resolve(args.perf));
console.log(`\n${R.fail ? 'FAILED' : 'OK'}: ${R.pass} checks passed, ${R.fail} failed, ${((Date.now() - T0) / 1000).toFixed(1)} s`);
for (const [k, v] of Object.entries(R.sections)) console.log(`  ${v.fail ? 'FAIL' : 'ok  '} ${k}: ${v.pass} passed${v.fail ? ', ' + v.fail + ' failed' : ''}`);
if (R.failures.length) { console.log('\nfailures:'); for (const f of R.failures.slice(0, 60)) console.log('  ' + f); }
fs.writeFileSync(path.join(WORK, 'search_test_result.json'), JSON.stringify(R, null, 1));
if (!args.keep && !R.fail) for (const d of ['dist_lim', 'bd_lim', 'dist_cut', 'bd_cut']) fs.rmSync(path.join(WORK, d), { recursive: true, force: true });
process.exit(R.fail ? 1 : 0);
