#!/usr/bin/env node
/* Chemistry build: SureChEMBL lipid candidates -> browser shards under data/work/chem/ (copied to dist/data/chem/).

   usage: node pipeline/chem_build.cjs [--threads 3] [--limit N] [--no-export] [--out DIR]

   1. python3 pipeline/chem_export.py   (parquet -> TSV under data/work/chem/_in/, joined with targets.parquet)
   2. per compound, with the vendored OpenChemLib 8.21.0 and web/engine/chemfp.js (the same code the browser runs):
      canonical idcode, FFP512 substructure index, count fingerprint, lipid descriptors, scaffold key, stereo-free hash,
      MW and cLogP. Results are cached in data/work/chem/_cache/calc-v<N>.jsonl keyed by compound id + SMILES hash, so a
      re-run only computes new or changed compounds (N = ChemFP.VERSION).
   3. assemble the shards (see docs/ARCHITECTURE.md, "Chemistry shards") and write chem.json.

   Pure JS, no network. Memory: a few hundred MB. About 6 minutes cold on 3 threads for 85k compounds, seconds when cached.
*/
'use strict';
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const OCL_PATH = path.join(ROOT, 'web', 'vendor', 'openchemlib-full.js');
const FP_PATH = path.join(ROOT, 'web', 'engine', 'chemfp.js');

if (!isMainThread) {
  const OCL = require(OCL_PATH);
  const F = require(FP_PATH);
  const names = F.COLS.map((c) => c[0]);
  parentPort.on('message', (batch) => {
    const out = [];
    for (const [id, smi] of batch) {
      const h = F.hashStr(smi);
      try {
        const m = OCL.Molecule.fromSmiles(smi); // with coordinates: without them OCL drops the stereo information from the idcode
        if (m.getAllAtoms() === 0) throw new Error('empty');
        const idc = m.getIDCode();
        const ffp = Int32Array.from(m.getIndex());
        const pk = F.fp(m).pk;
        const d = F.describe(m, { smiles: false });
        const r = F.row(d);
        const ns = F.noStereoHash(OCL, m);
        if (F.hashStr(idc) !== ns) r.flags |= 16;
        let lp = 0; try { lp = Math.round(new OCL.MoleculeProperties(m).logP * 100); } catch (e) { lp = 0; }
        out.push({ i: id, h, c: idc, f: Buffer.from(ffp.buffer).toString('base64'), k: Buffer.from(pk.buffer, pk.byteOffset, pk.byteLength).toString('base64'),
          s: F.scaffold(OCL, m).idcode, n: ns, m: +m.getMolecularFormula().relativeWeight.toFixed(3), lp: Math.max(-32768, Math.min(32767, lp)), r: names.map((k) => r[k]) });
      } catch (e) { out.push({ i: id, h, err: String(e && e.message || e).slice(0, 120) }); }
    }
    parentPort.postMessage(out);
  });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); }

async function main() {
  const t0 = Date.now();
  const F = require(FP_PATH);
  const OCL = require(OCL_PATH);
  const DATA = process.env.LNP_DATA || path.join(ROOT, 'data');
  const OUT = path.resolve(arg('out', path.join(DATA, 'work', 'chem')));
  const IN = path.join(OUT, '_in'), CACHE = path.join(OUT, '_cache');
  const threads = Math.max(1, +arg('threads', 3));
  const limit = +arg('limit', 0);
  fs.mkdirSync(CACHE, { recursive: true });
  if (!arg('no-export', false)) {
    const a = [path.join(ROOT, 'pipeline', 'chem_export.py'), '--out', OUT]; if (limit) a.push('--limit', String(limit));
    const r = require('node:child_process').spawnSync('python3', a, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    if (r.status !== 0) throw new Error('chem_export.py failed');
    console.log('export', String(r.stdout).trim());
  }
  // ---- compounds ----
  const comp = [];
  for (const line of fs.readFileSync(path.join(IN, 'compounds.tsv'), 'utf8').split('\n')) {
    if (!line) continue; const p = line.split('\t'); comp.push({ id: +p[0], smi: p[1], g: +p[4] || 0 });
  }
  console.log('compounds', comp.length);
  // ---- cache ----
  const cacheFile = path.join(CACHE, 'calc-v' + F.VERSION + '.jsonl');
  const calc = new Map();
  if (fs.existsSync(cacheFile)) {
    const rl = require('node:readline').createInterface({ input: fs.createReadStream(cacheFile), crlfDelay: Infinity });
    for await (const line of rl) { if (!line) continue; try { const o = JSON.parse(line); calc.set(o.i, o); } catch (e) { /* torn last line of an interrupted run */ } }
  }
  const todo = comp.filter((c) => { const o = calc.get(c.id); return !o || o.h !== F.hashStr(c.smi); });
  console.log('cached', comp.length - todo.length, 'to compute', todo.length, 'threads', threads);
  if (todo.length) {
    const fd = fs.openSync(cacheFile, 'a');
    let next = 0, done = 0, lastLog = 0; const B = 400;
    await new Promise((resolve, reject) => {
      let alive = 0;
      const feed = (w) => { if (next >= todo.length) { w.terminate(); if (--alive === 0) resolve(); return; } const b = todo.slice(next, next + B).map((c) => [c.id, c.smi]); next += B; w.postMessage(b); };
      for (let t = 0; t < Math.min(threads, Math.ceil(todo.length / B)); t++) {
        const w = new Worker(__filename); alive++;
        w.on('message', (rows) => {
          let s = ''; for (const o of rows) { calc.set(o.i, o); s += JSON.stringify(o) + '\n'; }
          fs.writeSync(fd, s); done += rows.length;
          if (done - lastLog >= 5000 || done === todo.length) { lastLog = done; console.log('computed', done, '/', todo.length, ((Date.now() - t0) / 1000).toFixed(0) + 's'); }
          feed(w);
        });
        w.on('error', reject);
        feed(w);
      }
    });
    fs.closeSync(fd);
  }
  // ---- unique structures, ordered by scaffold then weight ----
  let bad = 0, dup = 0; const byIdc = new Map(), rows = [], alias = new Map(), badList = [];
  for (const c of comp) {
    const o = calc.get(c.id);
    if (!o || o.err) { bad++; if (badList.length < 20) badList.push([c.id, o && o.err]); continue; }
    const prev = byIdc.get(o.c);
    if (prev) { dup++; alias.set(c.id, prev); prev.g = Math.max(prev.g, c.g); continue; }
    const r = { id: c.id, g: c.g, o }; byIdc.set(o.c, r); alias.set(c.id, r); rows.push(r);
  }
  const scafCount = new Map(); for (const r of rows) scafCount.set(r.o.s, (scafCount.get(r.o.s) || 0) + 1);
  const scafs = Array.from(scafCount.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const scafIdx = new Map(scafs.map((s, i) => [s, i]));
  rows.sort((a, b) => scafIdx.get(a.o.s) - scafIdx.get(b.o.s) || a.o.m - b.o.m || a.id - b.id);
  const N = rows.length; rows.forEach((r, i) => { r.c = i; });
  console.log('unique', N, 'duplicates merged', dup, 'unparsable', bad, 'scaffolds', scafs.length);
  // ---- publications and links ----
  const pn = [], fam = [];
  for (const line of fs.readFileSync(path.join(IN, 'pats.tsv'), 'utf8').split('\n')) { if (!line) continue; const p = line.split('\t'); pn.push(p[0]); fam.push(+p[1] || 0); }
  if (pn.length > 0xFFFFFF) throw new Error('too many publications for the 24-bit pn index');
  let keys = new Float64Array(1 << 20), nk = 0;
  {
    const rl = require('node:readline').createInterface({ input: fs.createReadStream(path.join(IN, 'map.tsv')), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue; const p = line.split('\t'); const r = alias.get(+p[0]); if (!r) continue;
      if (nk === keys.length) { const k2 = new Float64Array(nk * 2); k2.set(keys); keys = k2; }
      keys[nk++] = (r.c * 16777216 + (+p[1])) * 64 + (+p[2]);
    }
  }
  keys = keys.subarray(0, nk).sort();
  const mOff = new Uint32Array(N + 1); let mEnt = new Uint32Array(nk), ne = 0, lastCP = -1;
  const nPat = new Uint32Array(N), nClm = new Uint32Array(N), wb = new Uint8Array(N);
  for (let i = 0; i < nk; i++) {
    const k = keys[i], bits = k % 64, cp = (k - bits) / 64, pi = cp % 16777216, c = (cp - pi) / 16777216;
    if (cp === lastCP) { mEnt[ne - 1] |= bits; wb[c] |= bits; if ((bits & 1) && !(mEnt[ne - 1] & 256)) { /* counted below */ } continue; }
    lastCP = cp; mEnt[ne++] = (pi << 8) | bits; mOff[c + 1] = ne; nPat[c]++; wb[c] |= bits;
  }
  for (let c = 0; c < N; c++) if (mOff[c + 1] < mOff[c]) mOff[c + 1] = mOff[c];
  mEnt = mEnt.subarray(0, ne);
  const nFam = new Uint32Array(N); const linkedPats = new Uint8Array(pn.length);
  for (let c = 0; c < N; c++) {
    const fs2 = new Set(); let z = 0;
    for (let j = mOff[c]; j < mOff[c + 1]; j++) { const pi = mEnt[j] >>> 8; linkedPats[pi] = 1; if (mEnt[j] & 1) nClm[c]++; if (fam[pi]) fs2.add(fam[pi]); else z++; }
    nFam[c] = fs2.size + z;
  }
  // ---- shards ----
  const COLS = [['id', 'u32'], ['mw', 'f32'], ['logp', 'i16'], ['ns', 'u32'], ['scaf', 'u32'], ['nPat', 'u16'], ['nFam', 'u16'], ['nClm', 'u16'], ['nPatG', 'u32'], ['wbits', 'u8']].concat(F.COLS);
  const TA = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, f32: Float32Array };
  const cols = {}; for (const [k, t] of COLS) cols[k] = new TA[t](N);
  const fNames = F.COLS.map((c) => c[0]);
  const ffp = new Int32Array(N * 16); let tot = 0; const pks = new Array(N);
  for (const r of rows) {
    const o = r.o, c = r.c;
    cols.id[c] = r.id; cols.mw[c] = o.m; cols.logp[c] = o.lp; cols.ns[c] = o.n; cols.scaf[c] = scafIdx.get(o.s);
    cols.nPat[c] = Math.min(65535, nPat[c]); cols.nFam[c] = Math.min(65535, nFam[c]); cols.nClm[c] = Math.min(65535, nClm[c]); cols.nPatG[c] = r.g; cols.wbits[c] = wb[c];
    for (let j = 0; j < fNames.length; j++) cols[fNames[j]][c] = o.r[j];
    const fb = Buffer.from(o.f, 'base64'); ffp.set(new Int32Array(fb.buffer, fb.byteOffset, 16), c * 16);
    const kb = Buffer.from(o.k, 'base64'); const pk = new Uint16Array(kb.length / 2); for (let j = 0; j < pk.length; j++) pk[j] = kb.readUInt16LE(j * 2);
    pks[c] = pk; tot += pk.length;
  }
  const fpOff = new Uint32Array(N + 1), fpPk = new Uint16Array(tot); { let o = 0; for (let c = 0; c < N; c++) { fpOff[c] = o; fpPk.set(pks[c], o); o += pks[c].length; } fpOff[N] = o; }
  const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);
  const buf = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
  const colSpec = []; const colBufs = []; { let off = 0; for (const [k, t] of COLS) { const b = buf(cols[k]); const pad = (4 - (b.length % 4)) % 4; colSpec.push({ name: k, type: t, off }); colBufs.push(b); if (pad) colBufs.push(Buffer.alloc(pad)); off += b.length + pad; } }
  const payload = {
    'idc.gz.bin': Buffer.from(rows.map((r) => r.o.c).join('\n'), 'latin1'),
    'ffp.gz.bin': buf(ffp),
    'fp.gz.bin': Buffer.concat([u32(N, tot), buf(fpOff), buf(fpPk)]),
    'desc.gz.bin': Buffer.concat(colBufs),
    'scaf.gz.bin': Buffer.from(scafs.join('\n'), 'latin1'),
    'map.gz.bin': Buffer.concat([u32(N, ne), buf(mOff), buf(mEnt)]),
    'pat.gz.bin': Buffer.from(JSON.stringify({ pn, fam }), 'utf8')
  };
  const files = {}; let total = 0;
  for (const [name, raw] of Object.entries(payload)) {
    const gz = zlib.gzipSync(raw, { level: 9 });
    if (gz.length > 15 * 1024 * 1024) throw new Error(name + ' exceeds 15 MB gzipped: ' + gz.length);
    fs.writeFileSync(path.join(OUT, name), gz);
    files[name.split('.')[0]] = { file: name, bytes: gz.length, raw: raw.length }; total += gz.length;
  }
  // ---- reference names ----
  const refs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'ref_lipids_pubchem.json'), 'utf8'));
  const extra = require('./chem_names.cjs');
  const nsIndex = new Map(); for (let c = 0; c < N; c++) { const a = nsIndex.get(cols.ns[c]); if (a) a.push(c); else nsIndex.set(cols.ns[c], [c]); }
  const names = refs.map((r) => {
    const x = extra[r.name] || {}; const m = OCL.Molecule.fromSmiles(r.SMILES); const idc = m.getIDCode();
    const hit = byIdc.get(idc); const flat = F.flatIdcode(OCL, m);
    const variants = (nsIndex.get(F.hashStr(flat)) || []).filter((c) => F.flatIdcode(OCL, OCL.Molecule.fromIDCode(rows[c].o.c, false)) === flat);
    return { name: r.name, synonyms: x.synonyms || [], role: x.role || 'ionizable', note: x.note || null, smiles: r.SMILES, cid: r.CID, inchikey: r.InChIKey, idcode: idc, c: hit ? hit.c : -1, variants };
  });
  fs.writeFileSync(path.join(OUT, 'names.json'), JSON.stringify(names));
  total += fs.statSync(path.join(OUT, 'names.json')).size;
  // ---- manifest ----
  let exportInfo = {}; try { exportInfo = JSON.parse(fs.readFileSync(path.join(IN, 'export.json'), 'utf8')); } catch (e) { /* optional */ }
  const hist = (arr, cap) => { const h = {}; for (let i = 0; i < arr.length; i++) { const v = Math.min(cap, arr[i]); h[v] = (h[v] || 0) + 1; } return h; };
  const headHist = {}; for (let c = 0; c < N; c++) { const k = F.HEADS[cols.head[c]]; headHist[k] = (headHist[k] || 0) + 1; }
  let inClaims = 0; for (let c = 0; c < N; c++) if (nClm[c]) inClaims++;
  let nLinkedPats = 0; for (let i = 0; i < pn.length; i++) nLinkedPats += linkedPats[i];
  const manifest = {
    v: 1, built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), snapshot: exportInfo.snapshot || null, ocl: OCL.version, fpVersion: F.VERSION, fpBits: F.NB,
    n: N, nPat: pn.length, nLinks: ne, nScaf: scafs.length,
    files, names: 'names.json', publish: Object.values(files).map((f) => f.file).concat(['names.json', 'chem.json']),
    cols: colSpec, heads: F.HEADS, where: { clm: 1, desc: 2, abs: 4, ttl: 8, img: 16, mol: 32 },
    stats: { sourceCompounds: comp.length, duplicatesMerged: dup, unparsable: bad, compoundsWithPatents: Array.from(nPat).filter((x) => x > 0).length, compoundsInClaims: inClaims,
      publicationsLinked: nLinkedPats, avgFpFeatures: +(tot / N).toFixed(1), heads: headHist, nTails: hist(cols.nTails, 8), bytes: total }
  };
  fs.writeFileSync(path.join(OUT, 'chem.json'), JSON.stringify(manifest));
  total += fs.statSync(path.join(OUT, 'chem.json')).size; manifest.stats.bytes = total;
  if (total > 30 * 1024 * 1024) throw new Error('chemistry set exceeds 30 MB: ' + total);
  console.log(JSON.stringify({ n: N, pubs: pn.length, links: ne, scaffolds: scafs.length, dup, bad, badList, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.bytes])), totalBytes: total, refNames: names.map((x) => x.name + ':' + x.c + '/' + x.variants.length).join(' '), sec: +((Date.now() - t0) / 1000).toFixed(1) }, null, 1));
}
