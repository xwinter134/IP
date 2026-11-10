// Stage 3a: text index.  corpus.jsonl.gz -> sharded static BM25 index + claim text shards + definition shards.
//
//   node --max-old-space-size=6000 pipeline/build_index.mjs --corpus data/work/corpus.jsonl.gz --out DIR
//        [--keep FILE] [--max-files 330] [--limit N] [--quiet]
//
// --keep FILE : one byte per corpus record (same order): 2 = claims + definitions, 1 = claims only, 0 = biblio only
//               (title, assignee and abstract stay searchable). Written by build_dist.py from the size budget.
//               Without it every record keeps everything it has.
// Output (DIR is wiped first):
//   DIR/idx/docs.gz.bin   [u32 D][u32 P][u32 first[P+1]][u16 len[D]][u16 no[D]][u8 flag[D]]
//                         unit = one searchable text: flag bit0 independent claim, bit1 German, bits 2-3 kind
//                         (0 claim, 1 title, 2 abstract, 3 assignee); units of patent p = first[p] .. first[p+1]-1
//   DIR/idx/p-NNN.gz.bin  postings  [u32 dictLen][dict JSON {t: terms, d: df, o: offsets[n+1]}][varint (unitDelta-1, tf) ...]
//   DIR/idx/q-NNN.gz.bin  positions [u32 dictLen][dict JSON {t, o}][per posting: tf position deltas as varints]
//   DIR/idx/t-NNN.gz.bin  claim text  [u32 n][u32 p[n]][u32 off[n+1]][n JSON blocks, UTF-8], block of patent p[i] =
//                         {"c": [[n, flags, dep[], text, img[]?], ...], "a": abstract|0, "td": German title|0}
//                         (the browser keeps the inflated bytes and parses only the block it needs)
//   DIR/idx/lex.gz.bin    JSON {t: [terms sorted], d: [df]}: the most frequent terms, for suggestions
//   DIR/df-NNN.gz.bin     definition paragraphs, same container, block = JSON array of paragraphs (own patent ranges)
//   DIR/index.json        the "idx" and "df" sections of manifest.json plus build statistics
// The tokenizer is web/engine/tok.js, the same file the browser uses.
// Memory: postings are kept as growing byte buffers (about 130 bytes per claim); text is streamed shard by shard.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import readline from 'node:readline';
import crypto from 'node:crypto';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOK = require(path.join(HERE, '..', 'web', 'engine', 'tok.js'));

const args = {}; { const a = process.argv.slice(2); for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); if (i + 1 < a.length && !a[i + 1].startsWith('--')) args[k] = a[++i]; else args[k] = true; } }
if (!args.corpus || !args.out) { console.error('usage: build_index.mjs --corpus FILE --out DIR [--keep FILE] [--max-files 330] [--limit N]'); process.exit(2); }
const MAXF = +(args['max-files'] || 330), LIMIT = args.limit ? +args.limit : Infinity, QUIET = !!args.quiet;
const keep = args.keep ? fs.readFileSync(args.keep) : null;
const out = args.out, idxDir = path.join(out, 'idx');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(idxDir, { recursive: true });
const t0 = Date.now(); const log = (...a) => { if (!QUIET) console.log(`[build_index ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); };
const levelOf = (i) => keep ? (i < keep.length ? keep[i] : 0) : 2;

function lines() {
  const src = fs.createReadStream(args.corpus);
  const inp = /\.gz$/.test(args.corpus) ? src.pipe(zlib.createGunzip()) : src;
  return readline.createInterface({ input: inp, crlfDelay: Infinity });
}
const claimList = (r) => { const c = r.claims || {}; return [c.en || [], c.de || []]; };

// ---------------------------------------------------------------- pass 1: sizes (to choose shard boundaries)
let rawClaims = 0, rawDefs = 0, P1 = 0;
{
  let i = 0;
  for await (const line of lines()) {
    if (!line) continue; if (i >= LIMIT) break;
    const r = JSON.parse(line), lv = levelOf(i); i++;
    if (lv >= 1 && r.text) for (const l of claimList(r)) for (const c of l) rawClaims += c.t.length;
    if (r.abstract) rawClaims += r.abstract.length;
    if (lv >= 2 && r.defs) for (const d of r.defs) rawDefs += d.length;
  }
  P1 = i;
}
if (keep && keep.length !== P1 && LIMIT === Infinity) { console.error(`keep file has ${keep.length} entries, corpus has ${P1} records`); process.exit(3); }
// file budget: 60 % text + definitions (definitions at most a third of that), 22 % postings, the rest positions
const nTD = Math.max(2, Math.floor(MAXF * 0.60)), nPmax = Math.max(1, Math.floor(MAXF * 0.22)), nQmax = Math.max(1, MAXF - 2 - nTD - nPmax);
const nDf = Math.min(Math.floor(nTD / 3), Math.max(1, Math.ceil(rawDefs / 3.0e6)));
const nT = Math.min(nTD - nDf, Math.max(1, Math.ceil(rawClaims / 1.0e6)));
const T_TARGET = Math.ceil(rawClaims / nT) + 1, D_TARGET = Math.ceil(rawDefs / nDf) + 1;
log(`pass 1: ${P1} records, claim+abstract chars ${rawClaims}, definition chars ${rawDefs}; text shards <= ${nT} of ~${(T_TARGET / 1e6).toFixed(2)} MB raw, definition shards <= ${nDf}`);

// ---------------------------------------------------------------- pass 2: tokenise, postings, text + definition shards
class Buf {
  constructor() { this.b = new Uint8Array(12); this.n = 0; }
  vint(v) {
    if (this.n + 5 > this.b.length) { const nb = new Uint8Array(this.b.length * 2); nb.set(this.b); this.b = nb; }
    while (v >= 128) { this.b[this.n++] = (v & 127) | 128; v >>>= 7; }
    this.b[this.n++] = v;
  }
}
const terms = new Map();           // term -> {p: Buf, q: Buf, last, df}
let cap = 1 << 16, uLen = new Uint16Array(cap), uNo = new Uint16Array(cap), uFlag = new Uint8Array(cap), D = 0;
const first = [];
const sumLen = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
const C = { claims: 0, claimsEn: 0, claimsDe: 0, indep: 0, textPatents: 0, abstracts: 0, defsPatents: 0, cutText: 0, cutDefs: 0, titleDe: 0, defChars: 0, claimChars: 0 };
function addUnit(text, no, flag) {
  if (D === cap) { cap *= 2; const a = new Uint16Array(cap); a.set(uLen); uLen = a; const b = new Uint16Array(cap); b.set(uNo); uNo = b; const c = new Uint8Array(cap); c.set(uFlag); uFlag = c; }
  const d = D++, tk = TOK.tokenize(text), per = new Map();
  for (let i = 0; i < tk.length; i += 2) { const a = per.get(tk[i]); if (a) a.push(tk[i + 1]); else per.set(tk[i], [tk[i + 1]]); }
  for (const [t, ps] of per) {
    let e = terms.get(t); if (!e) terms.set(t, e = { p: new Buf(), q: new Buf(), last: -1, df: 0 });
    e.p.vint(d - e.last - 1); e.p.vint(ps.length); e.last = d; e.df++;
    let lp = 0; for (const x of ps) { e.q.vint(x - lp); lp = x; }
  }
  const len = tk.length / 2, k = (flag >> 2) & 3;
  uLen[d] = Math.min(65535, len); uNo[d] = Math.min(65535, no); uFlag[d] = flag; sumLen[k] += len; cnt[k]++;
}
// gzip jobs run on the libuv pool (4 threads); at most 6 pending so memory stays flat
const jobs = new Set(); const written = {};
async function writeGz(rel, buf) {
  while (jobs.size >= 6) await Promise.race(jobs);
  const p = new Promise((res, rej) => zlib.gzip(buf, { level: 9 }, (e, gz) => { if (e) return rej(e); fs.writeFileSync(path.join(out, rel), gz); written[rel] = { bytes: gz.length, raw: buf.length }; res(); }));
  jobs.add(p); p.finally(() => jobs.delete(p)); return p;
}
const pad3 = (n) => String(n).padStart(3, '0');
// block container: [u32 n][u32 p[n]][u32 off[n+1]][blocks]
function container(ps, blocks) {
  const n = ps.length, head = Buffer.alloc(4 + 4 * n + 4 * (n + 1)); head.writeUInt32LE(n, 0); let off = 0;
  for (let i = 0; i < n; i++) { head.writeUInt32LE(ps[i], 4 + 4 * i); head.writeUInt32LE(off, 4 + 4 * n + 4 * i); off += blocks[i].length; }
  head.writeUInt32LE(off, 4 + 4 * n + 4 * n);
  return Buffer.concat([head, ...blocks]);
}
let tsh = { p: [], b: [] }, tBytes = 0, tStart = [], tFiles = [], dsh = { p: [], b: [] }, dBytes = 0, dStart = [], dFiles = [];
function flushText() {
  if (!tsh.p.length) return;
  const tf = `idx/t-${pad3(tFiles.length)}.gz.bin`; tStart.push(tsh.p[0]); tFiles.push(tf);
  writeGz(tf, container(tsh.p, tsh.b)); tsh = { p: [], b: [] }; tBytes = 0;
}
function flushDefs() {
  if (!dsh.p.length) return;
  const df = `df-${pad3(dFiles.length)}.gz.bin`; dStart.push(dsh.p[0]); dFiles.push(df);
  writeGz(df, container(dsh.p, dsh.b)); dsh = { p: [], b: [] }; dBytes = 0;
}
const pnHash = crypto.createHash('sha256');
let P = 0;
for await (const line of lines()) {
  if (!line) continue; if (P >= LIMIT) break;
  const r = JSON.parse(line), p = P++, lv = levelOf(p);
  pnHash.update(r.pn + '\n');
  first.push(D);
  const ti = r.title || {}, tEn = ti.en || '', tDe = ti.de || '';
  addUnit(tEn || tDe, 0, 1 << 2 | (tEn ? 0 : (tDe ? 2 : 0)));
  const hasTd = !!(tEn && tDe && tDe !== tEn);
  if (hasTd) { addUnit(tDe, 0, 1 << 2 | 2); C.titleDe++; }
  if (r.abstract) { addUnit(r.abstract, 0, 2 << 2); C.abstracts++; }
  addUnit((r.assignees || []).join(' ; '), 0, 3 << 2);
  const cl = [], hasText = !!r.text;
  if (hasText && lv >= 1) {
    const [en, de] = claimList(r);
    for (let li = 0; li < 2; li++) for (const c of (li ? de : en)) {
      const indep = !(c.dep && c.dep.length), fl = (indep ? 1 : 0) | (li ? 2 : 0);
      addUnit(c.t, c.n, fl);
      const row = [c.n, fl, c.dep || [], c.t]; if (c.img && c.img.length) row.push(c.img);
      cl.push(row); C.claims++; if (li) C.claimsDe++; else C.claimsEn++; if (indep) C.indep++; C.claimChars += c.t.length; tBytes += c.t.length;
    }
    C.textPatents++;
  } else if (hasText) C.cutText++;
  if (cl.length || r.abstract || hasTd) {
    tsh.p.push(p); tsh.b.push(Buffer.from(JSON.stringify({ c: cl, a: r.abstract || 0, td: hasTd ? tDe : 0 })));
    if (r.abstract) tBytes += r.abstract.length;
  }
  if (r.defs && r.defs.length) {
    if (lv >= 2) { dsh.p.push(p); dsh.b.push(Buffer.from(JSON.stringify(r.defs))); C.defsPatents++; for (const d of r.defs) { C.defChars += d.length; dBytes += d.length; } }
    else C.cutDefs++;
  }
  if (tBytes >= T_TARGET) flushText();
  if (dBytes >= D_TARGET) flushDefs();
  if (P % 20000 === 0) log(`pass 2: ${P} records, ${D} units, ${terms.size} terms`);
}
flushText(); flushDefs(); first.push(D);
if (P !== P1) { console.error(`corpus changed between the two passes (${P1} vs ${P} records)`); process.exit(4); }
log(`tokenised: ${P} patents, ${D} units (${C.claims} claims), ${terms.size} terms`);

// ---------------------------------------------------------------- docs
{
  const b = Buffer.alloc(8 + 4 * (P + 1) + 5 * D); b.writeUInt32LE(D, 0); b.writeUInt32LE(P, 4); let o = 8;
  for (let i = 0; i <= P; i++) b.writeUInt32LE(first[i], o + i * 4); o += 4 * (P + 1);
  for (let i = 0; i < D; i++) b.writeUInt16LE(uLen[i], o + i * 2); o += 2 * D;
  for (let i = 0; i < D; i++) b.writeUInt16LE(uNo[i], o + i * 2); o += 2 * D;
  for (let i = 0; i < D; i++) b[o + i] = uFlag[i];
  writeGz('idx/docs.gz.bin', b);
}
// ---------------------------------------------------------------- postings / positions shards (term-sorted)
const sorted = [...terms.keys()].sort();      // code unit order, the same order the browser compares with
async function writeShards(kind, get, withDf, targetBytes) {
  const list = []; let cur = [], curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    const dict = { t: cur, o: [] }; if (withDf) dict.d = cur.map((t) => terms.get(t).df);
    let off = 0; const parts = [];
    for (const t of cur) { const e = get(terms.get(t)); dict.o.push(off); parts.push(Buffer.from(e.b.buffer, 0, e.n)); off += e.n; }
    dict.o.push(off);
    const dj = Buffer.from(JSON.stringify(dict)), h = Buffer.alloc(4); h.writeUInt32LE(dj.length);
    const f = `idx/${kind}-${pad3(list.length)}.gz.bin`;
    list.push({ f, first: cur[0], n: cur.length });
    const pr = writeGz(f, Buffer.concat([h, dj, ...parts]));
    cur = []; curBytes = 0; return pr;
  };
  for (const t of sorted) {
    const n = get(terms.get(t)).n;
    if (curBytes && curBytes + n > targetBytes * 1.25) await flush();
    cur.push(t); curBytes += n + t.length + 12;
    if (curBytes >= targetBytes) await flush();
  }
  await flush(); return list;
}
let rawP = 0, rawQ = 0; for (const e of terms.values()) { rawP += e.p.n; rawQ += e.q.n; }
let dictBytes = 0; for (const t of sorted) dictBytes += t.length + 12;
const pTarget = Math.max(768 * 1024, Math.ceil((rawP + dictBytes) / (nPmax - 1 || 1)));
const qTarget = Math.max(1024 * 1024, Math.ceil((rawQ + dictBytes) / (nQmax - 1 || 1)));
const PL = await writeShards('p', (e) => e.p, true, pTarget);
const QL = await writeShards('q', (e) => e.q, false, qTarget);
// ---------------------------------------------------------------- lexicon for suggestions
{
  let cand = sorted.filter((t) => terms.get(t).df >= 3 && t.length >= 2);
  if (cand.length > 60000) { const byDf = cand.slice().sort((a, b) => terms.get(b).df - terms.get(a).df || (a < b ? -1 : 1)).slice(0, 60000); const s = new Set(byDf); cand = cand.filter((t) => s.has(t)); }
  writeGz('idx/lex.gz.bin', Buffer.from(JSON.stringify({ t: cand, d: cand.map((t) => terms.get(t).df) })));
}
await Promise.all([...jobs]);
while (jobs.size) await Promise.race(jobs);

// ---------------------------------------------------------------- index.json
const size = (rel) => written[rel].bytes;
const sumOf = (pred) => Object.entries(written).filter(([k]) => pred(k)).reduce((a, [, v]) => a + v.bytes, 0);
const rawOf = (pred) => Object.entries(written).filter(([k]) => pred(k)).reduce((a, [, v]) => a + v.raw, 0);
const base = (f) => f.replace(/^idx\//, '');
const comp = {
  postings: { files: PL.length, bytes: sumOf((k) => /^idx\/p-/.test(k)), raw: rawOf((k) => /^idx\/p-/.test(k)) },
  positions: { files: QL.length, bytes: sumOf((k) => /^idx\/q-/.test(k)), raw: rawOf((k) => /^idx\/q-/.test(k)) },
  text: { files: tFiles.length, bytes: sumOf((k) => /^idx\/t-/.test(k)), raw: rawOf((k) => /^idx\/t-/.test(k)) },
  docs: { files: 1, bytes: size('idx/docs.gz.bin'), raw: written['idx/docs.gz.bin'].raw },
  lex: { files: 1, bytes: size('idx/lex.gz.bin'), raw: written['idx/lex.gz.bin'].raw },
  defs: { files: dFiles.length, bytes: sumOf((k) => /^df-/.test(k)), raw: rawOf((k) => /^df-/.test(k)) }
};
const total = Object.values(comp).reduce((a, c) => a + c.bytes, 0);
const idx = {
  v: 3, tok: TOK.VERSION, D, P, nTerms: sorted.length, k1: 1.2, b: 0.75,
  avg: { claim: cnt[0] ? sumLen[0] / cnt[0] : 1, title: cnt[1] ? sumLen[1] / cnt[1] : 1, abstract: cnt[2] ? sumLen[2] / cnt[2] : 1, asg: cnt[3] ? sumLen[3] / cnt[3] : 1 },
  docs: 'docs.gz.bin', lex: 'lex.gz.bin',
  post: PL.map((s) => [base(s.f), s.first, size(s.f)]), pos: QL.map((s) => [base(s.f), s.first, size(s.f)]),
  text: { start: tStart, files: tFiles.map((f) => [base(f), size(f)]) },
  counts: { units: D, claims: C.claims, claimsEn: C.claimsEn, claimsDe: C.claimsDe, indep: C.indep, textPatents: C.textPatents, abstracts: C.abstracts, titleDe: C.titleDe }
};
const df = { start: dStart, files: dFiles.map((f) => [f, size(f)]), patents: C.defsPatents };
const stats = {
  built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), seconds: +((Date.now() - t0) / 1000).toFixed(1),
  patents: P, units: D, claims: C.claims, terms: sorted.length, pnSha: pnHash.digest('hex'),
  cut: { text: C.cutText, defs: C.cutDefs }, chars: { claims: C.claimChars, defs: C.defChars, textShardRaw: comp.text.raw },
  components: comp, totalBytes: total, files: Object.keys(written).length,
  bytesPerClaim: C.claims ? +((comp.postings.bytes + comp.positions.bytes + comp.text.bytes + comp.docs.bytes) / C.claims).toFixed(1) : null,
  maxFileBytes: Math.max(...Object.values(written).map((w) => w.bytes))
};
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ idx, df, stats, files: Object.fromEntries(Object.entries(written).map(([k, v]) => [k, v.bytes])) }));
log(`done: ${stats.files} files, ${(total / 1e6).toFixed(2)} MB (postings ${(comp.postings.bytes / 1e6).toFixed(2)}, positions ${(comp.positions.bytes / 1e6).toFixed(2)}, text ${(comp.text.bytes / 1e6).toFixed(2)}, docs ${(comp.docs.bytes / 1e6).toFixed(2)}, lex ${(comp.lex.bytes / 1e6).toFixed(2)}, defs ${(comp.defs.bytes / 1e6).toFixed(2)}), ${stats.bytesPerClaim} bytes/claim, largest file ${(stats.maxFileBytes / 1e6).toFixed(2)} MB`);
