#!/usr/bin/env node
// Tests of the local MCP server (mcp/server.mjs): protocol, the seven tools, error handling, offline behaviour,
// the plain website build (--enc bin) and a base64 build. Prints timings and the peak resident memory of the server.
//
//   node tests/mcp_test.mjs [--pages DIR] [--b64 DIR] [--scratch DIR] [--no-build] [--only pages|b64]
//
//   --pages  website build made with: LNP_HOST_MAX_MB=950 python3 -I pipeline/build_dist.py --enc bin --out <DIR>
//            --build-dir <scratch>/build_pages --budget-mb 900 --max-files 3000 --target pages
//            (built here when missing, unless --no-build; needs data/work from the pipeline, 70-90 s, about 3 GB RAM)
//   --b64    a base64 (Artifact) build; default: <scratch>/b64 (built with --limit 2000 when missing), or an existing
//            full Artifact build of a sibling scratch directory when one is found
// Exit code 1 when a check fails.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);
const SCRATCH = path.resolve(arg('scratch', '/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/T11'));
const PAGES = path.resolve(arg('pages', path.join(SCRATCH, 'pages')));
const ONLY = arg('only', '');

let checks = 0; const fails = []; let section = 'setup';
function sec(n) { section = n; console.log('\n## ' + n); }
function ok(cond, what, extra) {
  checks++;
  if (!cond) { fails.push(section + ': ' + what); console.log('  FAIL ' + what + (extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500) : '')); }
  else console.log('  ok   ' + what);
  return !!cond;
}

// ------------------------------------------------------------------------------------------------ builds
function build(out, extra, label) {
  const bd = path.join(SCRATCH, 'build_' + label);
  const argv = ['-I', 'pipeline/build_dist.py', '--out', out, '--build-dir', bd, ...extra];
  console.log('building ' + label + ': python3 ' + argv.join(' '));
  const r = spawnSync('python3', argv, { cwd: ROOT, env: { ...process.env, LNP_HOST_MAX_MB: '950' }, stdio: ['ignore', 'inherit', 'inherit'] });
  return r.status === 0;
}
function hasBuild(d) { return fs.existsSync(path.join(d, 'data', 'manifest.json')); }

// ------------------------------------------------------------------------------------------------ client
class Client {
  constructor(distDir, extra = []) {
    this.dist = distDir; this.id = 0; this.waiters = new Map(); this.lines = []; this.badLines = 0; this.stderr = '';
    this.child = spawn('node', [SERVER, '--dist', distDir, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.exited = new Promise((r) => this.child.on('exit', (code, sig) => r({ code, sig })));
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch (e) { this.badLines++; return; }
      this.lines.push(m);
      const w = this.waiters.get(m.id); if (w) { this.waiters.delete(m.id); w(m); }
    });
  }
  raw(s) { this.child.stdin.write(s + '\n'); }
  notify(method, params) { this.raw(JSON.stringify({ jsonrpc: '2.0', method, params })); }
  rpc(method, params, timeoutMs = 180000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error(`timeout: ${method} ${JSON.stringify(params).slice(0, 100)}`)); }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); res(m); });
      this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp_test', version: '1' } });
    this.notify('notifications/initialized');
    return r;
  }
  // -> {ms, isError, data (parsed JSON), raw}
  async call(name, a) {
    const t = performance.now();
    const m = await this.rpc('tools/call', { name, arguments: a });
    const ms = Math.round(performance.now() - t);
    if (m.error) return { ms, rpcError: m.error };
    const text = (m.result.content || []).filter((c) => c.type === 'text').map((c) => c.text)[0] || '';
    let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { ms, isError: !!m.result.isError, data, text, content: m.result.content };
  }
  mem() {
    try {
      const s = fs.readFileSync(`/proc/${this.child.pid}/status`, 'utf8');
      const g = (k) => { const m = new RegExp(k + ':\\s+(\\d+) kB').exec(s); return m ? Math.round(+m[1] / 1024) : null; };
      return { hwmMb: g('VmHWM'), rssMb: g('VmRSS') };
    } catch (e) { return { hwmMb: null, rssMb: null }; }
  }
  async close() { const mem = this.mem(); this.child.stdin.end(); const ex = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r({ code: 'hung' }), 5000))]); if (ex.code === 'hung') this.child.kill('SIGKILL'); return { mem, exit: ex }; }
}

const timings = {};
const T = (label, ms) => { (timings[label] || (timings[label] = [])).push(ms); };

function hasLimits(r) { return r.data && Array.isArray(r.data.limits) && r.data.limits.length >= 2 && r.data.limits.every((x) => typeof x === 'string' && x.length > 10) && r.data.corpus && r.data.corpus.publications > 0; }

// ------------------------------------------------------------------------------------------------ the suite
async function runSuite(label, dist, o) {
  sec(`${label}: handshake and protocol`);
  const tStart = performance.now();
  const c = new Client(dist);
  let r = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp_test', version: '1' } });
  T(`${label} initialize`, Math.round(performance.now() - tStart));
  ok(r.result && r.result.protocolVersion === '2025-06-18' && r.result.serverInfo.name === 'lnp-patent-desk-mcp' && r.result.capabilities.tools, 'initialize echoes a supported protocol version and announces tools', r.result);
  ok(/pre-screening|not legal advice/i.test(r.result.instructions) && /untrusted/i.test(r.result.instructions), 'instructions carry the legal note and the untrusted-text warning');
  c.notify('notifications/initialized');
  r = await c.rpc('ping'); ok(r.result && Object.keys(r.result).length === 0, 'ping answers {}');
  const r2 = await c.rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  ok(r2.result && ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(r2.result.protocolVersion), 'unknown protocol version: the server answers with one it supports', r2.result && r2.result.protocolVersion);
  r = await c.rpc('tools/list');
  const names = (r.result.tools || []).map((t) => t.name);
  ok(JSON.stringify(names) === JSON.stringify(['search', 'get_patent', 'get_claims', 'chem_search', 'markush_check', 'ranges_check', 'expiry']), 'tools/list: the 7 tools', names);
  ok(r.result.tools.every((t) => t.description.length > 60 && t.inputSchema.type === 'object' && t.inputSchema.properties && Array.isArray(t.inputSchema.required) && t.annotations.readOnlyHint === true && t.annotations.openWorldHint === false), 'every tool has a description, an object schema with required[] and read-only / closed-world annotations');
  const sc = Object.fromEntries(r.result.tools.map((t) => [t.name, t.inputSchema]));
  ok(sc.search.properties.limit.maximum === 50 && sc.search.required.includes('query') && sc.chem_search.properties.mode.enum.join() === 'exact,sub,sim,scaffold' && sc.markush_check.required.join() === 'pn,claim,smiles' && sc.ranges_check.properties.values.items.required.join() === 'param,value' && sc.expiry.required.join() === 'pns', 'schemas: limit <= 50, modes, required fields');
  ok(JSON.stringify(r).length < 30000, 'tools/list is small', JSON.stringify(r).length);
  r = await c.rpc('resources/list'); ok(r.error && r.error.code === -32601, 'unknown method -> -32601');
  r = await c.rpc('tools/call', { name: 'nope', arguments: {} }); ok(r.error && r.error.code === -32602, 'unknown tool -> -32602');
  c.raw('{this is not json'); await new Promise((res) => setTimeout(res, 150));
  ok(c.lines.some((m) => m.error && m.error.code === -32700 && m.id === null), 'invalid JSON line -> -32700 with id null');
  c.raw(JSON.stringify({ id: 99, method: 'ping' })); await new Promise((res) => setTimeout(res, 150));
  ok(c.lines.some((m) => m.id === 99 && m.error && m.error.code === -32600), 'message without jsonrpc "2.0" -> -32600');
  const before = c.lines.length; c.notify('notifications/unknown'); r = await c.rpc('ping');
  ok(c.lines.length === before + 1, 'a notification gets no answer');
  const burst = await Promise.all([c.rpc('ping'), c.rpc('tools/list'), c.rpc('ping')]);
  ok(burst.every((m) => m.result), 'concurrent requests are all answered');
  r = await c.rpc('tools/call', { name: 'search', arguments: 'x' }); ok(r.result && r.result.isError, 'arguments that are not an object -> tool error');

  sec(`${label}: search`);
  let s = await c.call('search', { query: '"lipid nanoparticle" ionizable', limit: 5 }); T(`${label} search (cold, includes index start)`, s.ms);
  ok(!s.isError && s.data.total > 100 && s.data.hits.length === 5 && s.data.limit === 5 && s.data.has_more === true, 'hits and total', s.data && [s.data.total, s.data.hits && s.data.hits.length]);
  const h0 = s.data.hits[0];
  ok(h0 && /^[A-Z]{2}\d+[A-Z]\d?$/.test(h0.pn) && h0.title && 'assignee' in h0 && 'status' in h0 && h0.snippet && /«.+»/.test(h0.snippet.text) && h0.snippet.field, 'hit has pn, title, assignee, status and a snippet with marked matches', h0);
  ok(hasLimits(s) && /untrusted/i.test(s.data.notice), 'limits, corpus and the untrusted-text notice are present');
  const s2 = await c.call('search', { query: '"lipid nanoparticle" ionizable', limit: 5, offset: 5 }); T(`${label} search (page 2)`, s2.ms);
  ok(s2.data.offset === 5 && s2.data.hits.length === 5 && !s2.data.hits.some((h) => s.data.hits.some((x) => x.pn === h.pn)), 'offset pages without overlap');
  const sf = await c.call('search', { query: 'lipid', filters: { auth: ['US'], yearFrom: 2021, textOnly: true }, limit: 10, sort: 'date' }); T(`${label} search (filters)`, sf.ms);
  ok(!sf.isError && sf.data.hits.length > 0 && sf.data.hits.every((h) => h.pn.startsWith('US') && +h.published.slice(0, 4) >= 2021 && h.has_claim_text) && sf.data.hits.every((h, i, a) => !i || a[i - 1].published >= h.published), 'filters auth/yearFrom/textOnly and sort=date apply', sf.data.hits.map((h) => h.pn + ' ' + h.published));
  const sq = await c.call('search', { query: 'claims:(micelle OR liposome) NOT peg year:2019-2020 auth:EP', limit: 3 });
  ok(!sq.isError && sq.data.hits.every((h) => h.pn.startsWith('EP') && /^20(19|20)/.test(h.published)), 'query language: fields, NOT, year range, auth', sq.data && sq.data.hits.map((h) => h.pn + h.published));
  const sw = await c.call('search', { query: '"unbalanced', limit: 2 }); ok(!sw.isError && sw.data.total >= 0, 'an odd query does not fail');
  ok((await c.call('search', { query: 'x', limit: 51 })).isError, 'limit 51 -> invalid arguments');
  const bad = await c.call('search', { query: 'x', filters: { colour: 'red' } }); ok(bad.isError && /unknown property filters\.colour/.test(bad.data.message), 'unknown filter key -> clean error', bad.data);
  ok((await c.call('search', {})).isError && (await c.call('search', { query: '   ' })).isError && (await c.call('search', { query: 5 })).isError, 'missing / empty / wrong-typed query -> tool errors');
  const usPn = sf.data.hits[0].pn, usKind = sf.data.hits[0].kind;

  sec(`${label}: get_patent`);
  const SEED = 'EP3532103B1';
  let g = await c.call('get_patent', { pn: SEED }); T(`${label} get_patent`, g.ms);
  ok(!g.isError && g.data.biblio.pn === SEED && /Acuitas/i.test(g.data.biblio.assignee) && g.data.biblio.published === '2025-12-03' && g.data.biblio.filed === '2017-10-26' && g.data.biblio.cpc.length > 0, 'seed patent: biblio', g.data && g.data.biblio);
  ok(g.data.status_summary && g.data.status_summary.code === 'granted' && g.data.status_summary.expiry_estimate === '2037-10-26' && g.data.status_detail && g.data.status_detail.src, 'status summary and detail with source and snapshot date', g.data.status_summary);
  ok(g.data.family.members_in_build >= 1 && g.data.family.members.some((m) => m.pn === SEED) && g.data.links.espacenet && g.data.text.claims_in_build === true && g.data.text.independent_claims.includes(1), 'family, links, text summary');
  ok(hasLimits(g) && g.data.limits.some((x) => /snapshot/i.test(x)), 'limits mention the status snapshot');
  const gf = await c.call('get_patent', { pn: 'EP 3 532 103' }); ok(!gf.isError && gf.data.biblio.pn === SEED && /kind code/i.test(gf.data.resolved_note || ''), 'loose number form resolves; the note says so');
  const gu = await c.call('get_patent', { pn: usPn }); ok(!gu.isError && gu.data.biblio.authority === 'US' && gu.data.status_summary, 'US patent from the search', usPn);
  const g404 = await c.call('get_patent', { pn: 'EP9999999B1' }); ok(g404.isError && g404.data.error === 'not_found', 'unknown publication -> not_found', g404.data);
  const gbad = await c.call('get_patent', { pn: 'banana' }); ok(gbad.isError && gbad.data.error === 'bad_pn', 'not a number -> bad_pn', gbad.data);

  sec(`${label}: get_claims`);
  const cl = await c.call('get_claims', { pn: SEED, lang: 'en' }); T(`${label} get_claims`, cl.ms);
  ok(!cl.isError && cl.data.claims.length === 14 && cl.data.claims[0].n === 1 && cl.data.claims[0].independent === true && /^A lipid nanoparticle comprising: i\) from 47 to 48 mol percent of a cationic lipid/.test(cl.data.claims[0].text) && cl.data.claims.every((x) => x.lang === 'en'), 'claims verbatim, English only', cl.data && cl.data.claims && cl.data.claims[0]);
  ok(cl.data.claims.filter((x) => x.depends_on.length).every((x) => x.independent === false && x.root_claims.length >= 1), 'dependencies and root claims');
  ok(/untrusted/i.test(cl.data.notice) && hasLimits(cl), 'untrusted-text notice and limits');
  const ci = await c.call('get_claims', { pn: SEED, independent_only: true }); ok(!ci.isError && ci.data.claims.length >= 1 && ci.data.claims.every((x) => x.independent) && ci.data.total_claims_in_selection >= ci.data.returned, 'independent_only');
  const cd = await c.call('get_claims', { pn: SEED, lang: 'de' }); ok(!cd.isError && cd.data.claims.length > 0 && cd.data.claims.every((x) => x.lang === 'de'), 'German claims');
  const needle = cl.data.claims[0].text.slice(0, 60);
  const back = await c.call('search', { query: `pn:${SEED} "${needle.split(' ').slice(0, 6).join(' ')}"`, limit: 1 });
  ok(!back.isError && back.data.hits[0] && back.data.hits[0].pn === SEED, 'the text is the indexed text: the first words of claim 1 find the patent', back.data && back.data.total);
  const wo = await c.call('get_claims', { pn: 'WO2018081480A1' });
  ok(!wo.isError && (wo.data.claims.length === 0 ? wo.data.limits.some((x) => /no claim text|cut/i.test(x)) : true), 'a WO pamphlet without claims: empty list with an explanation', wo.data && wo.data.limits && wo.data.limits.slice(2));
  ok((await c.call('get_claims', { pn: 'EP9999999B1' })).isError, 'unknown publication -> error');

  sec(`${label}: chem_search`);
  let ch = await c.call('chem_search', { query: 'ALC-0315', mode: 'exact', limit: 5, patents_per_compound: 5 }); T(`${label} chem_search exact (cold, includes structure load)`, ch.ms);
  ok(!ch.isError && ch.data.query.kind === 'name' && ch.data.query.smiles && ch.data.total >= 1, 'reference lipid name resolved, exact hit', ch.data && ch.data.query);
  const c0 = ch.data.compounds[0];
  ok(c0 && c0.match === 'exact' && c0.in_claims === true && c0.patents > 0 && c0.patents_listed.length > 0 && c0.patents_listed.every((p) => /^[A-Z]{2}\d+/.test(p.pn)) && /^SCHEMBL\d+$/.test(c0.id) && c0.formula, 'compound record: id, formula, patents named in claims', c0);
  ok(c0.patents_listed.some((p) => p.pn === 'EP3368507B1') || c0.patents >= c0.patents_listed.length, 'patents listed (EP3368507B1 is a curated ALC-0315 claim)', c0.patents_listed.map((p) => p.pn));
  ok(hasLimits(ch), 'limits');
  const scid = c0.id;
  const byId = await c.call('chem_search', { query: scid, mode: 'exact', limit: 1 }); ok(!byId.isError && byId.data.compounds[0].id === scid, 'SCHEMBL id as query', byId.data && byId.data.query);
  const sim = await c.call('chem_search', { query: c0.smiles, mode: 'sim', min_sim: 0.8, limit: 10, patents_per_compound: 1 }); T(`${label} chem_search sim`, sim.ms);
  ok(!sim.isError && sim.data.compounds.length > 1 && sim.data.compounds[0].similarity >= sim.data.compounds[sim.data.compounds.length - 1].similarity && sim.data.compounds.every((x) => x.similarity >= 0.8), 'similarity: ranked, every hit above min_sim', sim.data && sim.data.compounds.map((x) => x.similarity));
  const sub = await c.call('chem_search', { query: 'CCCCCCCCC(CCCCCC)C(=O)OCCCCCCN(CCCCO)CCCCCC', mode: 'sub', limit: 5, patents_per_compound: 0 }); T(`${label} chem_search sub (selective)`, sub.ms);
  ok(!sub.isError && sub.data.total >= 1 && sub.data.compounds.every((x) => x.patents_listed.length === 0), 'substructure (selective query); patents_per_compound 0 lists none', sub.data && sub.data.total);
  const sub2 = await c.call('chem_search', { query: 'N(CC)(CC)CCOC(=O)', mode: 'sub', limit: 3, in_claims_only: true, patents_per_compound: 1 }); T(`${label} chem_search sub (broad)`, sub2.ms);
  ok(!sub2.isError && sub2.data.total > 50 && sub2.data.compounds.every((x) => x.in_claims), 'substructure (broad), in_claims_only', sub2.data && sub2.data.total);
  const sca = await c.call('chem_search', { query: c0.smiles, mode: 'scaffold', limit: 3, patents_per_compound: 0 }); ok(!sca.isError && sca.data.mode === 'scaffold' && sca.data.total >= 1, 'scaffold mode');
  const cb = await c.call('chem_search', { query: 'this is not a molecule', mode: 'sub' }); ok(cb.isError && cb.data.error === 'bad_query', 'unreadable query -> bad_query', cb.data);
  const cb2 = await c.call('chem_search', { query: 'C1CC(', mode: 'exact' }); ok(cb2.isError, 'unbalanced SMILES -> error', cb2.data && cb2.data.message);
  ok((await c.call('chem_search', { query: 'CCO', mode: 'fuzzy' })).isError && (await c.call('chem_search', { query: 'CCO', min_sim: 2 })).isError && (await c.call('chem_search', { query: 'CCO', limit: 0 })).isError, 'bad mode / min_sim / limit -> invalid arguments');
  const alc = c0.smiles;

  sec(`${label}: markush_check`);
  let mk = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: alc }); T(`${label} markush_check (curated)`, mk.ms);
  ok(!mk.isError && mk.data.result.overall === 'covered' && mk.data.record.origin === 'curated' && mk.data.record.reviewed === true && mk.data.result.core.matched === true, 'ALC-0315 is covered by the curated record of EP3368507B1 claim 1', mk.data && mk.data.result && mk.data.result.overall);
  ok(mk.data.result.groups.length > 3 && mk.data.result.groups.every((x) => (x.verdict === 'met' || x.verdict === 'n/a') && x.quote && x.quoteStatus === 'ok') && mk.data.result.groups.filter((x) => x.verdict === 'met').length >= 6, 'no group is not_met (n/a = optional and absent); every quote is verified against the claim text', mk.data.result.groups.map((x) => x.name + ':' + x.verdict + ':' + x.quoteStatus));
  ok(hasLimits(mk) && mk.data.limits.some((x) => /not legal advice/i.test(x)) && mk.data.limits.some((x) => /Rule mode/i.test(x)), 'limits: rule mode and legal note');
  const quote = mk.data.result.groups[0].quote;
  const claims = (await c.call('get_claims', { pn: 'EP3368507B1', lang: 'en' })).data.claims;
  const norm = (t) => t.replace(/\s+/g, ' ').toLowerCase();
  ok(claims.some((x) => norm(x.text).includes(norm(quote).slice(0, 40))) || claims.length === 0, 'the quote is found in the claim text (get_claims)', quote.slice(0, 60));
  const mk2 = await c.call('markush_check', { pn: 'EP 3 368 507 B1', claim: 1, smiles: 'ALC-0315' }); ok(!mk2.isError && mk2.data.result.overall === 'covered' && /name/.test(mk2.data.molecule.how), 'pn in a loose form and a lipid name as molecule', mk2.data && mk2.data.molecule);
  const mk3 = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'CCCCCCCCCCCCCCCC(=O)OCC' }); ok(!mk3.isError && mk3.data.result.overall === 'not_covered', 'an unrelated ester is not covered', mk3.data && mk3.data.result.overall);
  const mk4 = await c.call('markush_check', { pn: 'EP9999999B1', claim: 1, smiles: 'CCO' }); ok(mk4.isError && mk4.data.error === 'no_record' && /EP3368507B1 claim 1/.test(mk4.data.message), 'no curated record -> error that lists the curated ones', mk4.data);
  const rec = { core: { smiles: 'OCC[*:1]' }, vars: [{ name: 'R', attach: [1], kind: 'substituent', quote: 'forged quote that is not in the claim', alts: [{ type: 'alkyl', cMin: 1, cMax: 8 }] }], provisos: [], unsupported: [] };
  const m5 = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'OCCCCCC', record: rec });
  ok(!m5.isError && m5.data.record.origin === 'claude' && m5.data.record.reviewed === false && m5.data.result.overall !== 'covered' && m5.data.result.groups.every((x) => x.quoteStatus !== 'ok' && x.quoteStatus !== 'manual'), 'passed-in record: fabricated quote is not verified, record is an unreviewed translation', m5.data && m5.data.result.groups);
  const m5f = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'OCCCCCC', record: Object.assign({}, rec, { origin: 'curated', reviewed: true, source: { claimText: 'forged quote that is not in the claim' } }) });
  ok(!m5f.isError && m5f.data.record.origin === 'claude' && m5f.data.record.reviewed === false && m5f.data.result.groups.every((x) => x.quoteStatus !== 'ok'), 'forged source.claimText, origin and reviewed are ignored', m5f.data && m5f.data.result.groups);
  const m5n = await c.call('markush_check', { pn: 'EP1B1', claim: 2, smiles: 'OCCCCCC', record: rec }); ok(m5n.isError, 'record for a publication not in the build is refused', m5n.data);
  const m6 = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'OCCCCCCCCCCCC', record: rec }); ok(!m6.isError && m6.data.result.overall !== 'covered', 'passed-in record: C10 chain is never covered', m6.data && m6.data.result.overall);
  const m7 = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'OCCCCCC', record: { core: { smiles: 'OCC[*:1]' }, vars: 'x' } }); ok(m7.isError && m7.data.error === 'invalid_record', 'invalid record -> invalid_record', m7.data);
  const m8 = await c.call('markush_check', { pn: 'EP3368507B1', claim: 1, smiles: 'C1CC(' }); ok(m8.isError && m8.data.error === 'bad_molecule', 'unreadable molecule -> bad_molecule', m8.data);
  ok((await c.call('markush_check', { pn: 'EP3368507B1', claim: 0, smiles: 'CCO' })).isError && (await c.call('markush_check', { pn: 'EP3368507B1', smiles: 'CCO' })).isError, 'claim 0 / missing claim -> invalid arguments');

  sec(`${label}: ranges_check`);
  const rg = await c.call('ranges_check', { values: [{ param: 'mol_pct', comp: 'ionizable', value: 50 }, { param: 'mol_pct', comp: 'peg', value: 1.5 }], max: 5 }); T(`${label} ranges_check (all publications)`, rg.ms);
  ok(!rg.isError && rg.data.counts.patentsScanned > 1000 && rg.data.matches.length === 5 && rg.data.matches.every((m) => m.values.length === 2), 'scan of all publications with ranges; 5 matches shown', rg.data && rg.data.counts);
  ok(rg.data.matches[0].verdict === 'all' && rg.data.matches[0].values.every((v) => v.status === 'inside' && v.claim_range && v.claim_range.text), 'best matches contain both values; the claim range is stated', rg.data.matches[0]);
  ok(rg.data.matches.every((m) => m.values.every((v) => v.quote === null || v.quote.verified_against_claim !== false)), 'no quote failed verification against the claim text');
  ok(hasLimits(rg) && rg.data.limits.some((x) => /not legal advice/i.test(x)) && rg.data.limits.some((x) => /pattern rules/i.test(x)), 'limits: pattern rules, legal note');
  const pn1 = rg.data.matches[0].pn;
  const rs = await c.call('ranges_check', { values: [{ param: 'mol_pct', value: 50 }], pns: [pn1], max: 50 }); ok(!rs.isError && rs.data.matches.length > 0 && rs.data.matches.every((m) => m.pn === pn1), 'pns restricts the scan', rs.data && rs.data.counts);
  const ra = await c.call('ranges_check', { values: [{ param: 'size_nm', value: 85 }, { param: 'np_ratio', value: 6 }], mode: 'any', max: 3 }); ok(!ra.isError && ra.data.matches.length > 0 && ra.data.mode === 'any', 'mode any, other parameters');
  const rb2 = await c.call('ranges_check', { values: [{ param: 'mol_pct', comp: 'bogus', value: 50 }] }); ok(rb2.isError, 'unknown comp is refused by the schema');
  const rb3 = await c.call('ranges_check', { values: [{ param: 'mol_pct', comp: 'ionizable', value: 50, unit: 'nm' }] }); ok(rb3.isError && rb3.data.error === 'bad_values', 'unit that does not fit the parameter is refused', rb3.data);
  const rb4 = await c.call('ranges_check', { values: [{ param: 'mol_pct', value: 1e308 }] }); ok(rb4.isError, 'mol% above 100 is refused');
  const rd = await c.call('ranges_check', { values: [{ param: 'mol_pct', comp: 'ionizable', value: 47.5 }], pns: ['EP3532103B1', 'EP3532103'], max: 3 }); ok(!rd.isError && rd.data.counts.patentsScanned === 1, 'duplicate pns are collapsed', rd.data && rd.data.counts);
  const rpx = await c.call('search', JSON.parse('{"query":"lipid","__proto__":{"x":1}}')); ok(rpx.isError && /unknown property/.test(rpx.data.message), '__proto__ key is rejected as unknown property', rpx.data);
  const rbad = await c.call('ranges_check', { values: [{ param: 'colour', value: 1 }] }); ok(rbad.isError && rbad.data.error === 'bad_values' && /mol_pct/.test(rbad.data.message), 'unknown parameter -> error with the valid ids', rbad.data && rbad.data.message.slice(0, 120));
  ok((await c.call('ranges_check', { values: [] })).isError && (await c.call('ranges_check', { values: [{ param: 'mol_pct', value: 'fifty' }] })).isError, 'empty values / non-numeric value -> invalid arguments');
  const rnf = await c.call('ranges_check', { values: [{ param: 'mol_pct', value: 50 }], pns: ['EP9999999B1'] }); ok(rnf.isError && rnf.data.error === 'not_found', 'pns outside the build -> not_found');

  sec(`${label}: expiry`);
  const ex = await c.call('expiry', { pns: [SEED, usPn, 'WO2018081480A1', 'EP9999999B1'] }); T(`${label} expiry`, ex.ms);
  const rowE = !ex.isError && ex.data.rows.find((x) => x.pn === SEED);
  ok(rowE && rowE.expiry.date === '2037-10-26' && rowE.expiry.basis === 'filing + 20 y' && rowE.in_force === true && rowE.expiry.pte === 'not checked' && rowE.expiry.spc === 'not checked', 'seed EP patent: filing + 20 y = 2037-10-26, PTE / SPC not checked', rowE && rowE.expiry);
  ok(ex.data.rows.some((x) => x.pn === usPn) && ex.data.skipped_wo === 1 && ex.data.unknown_publications.includes('EP9999999B1'), 'US row present; WO skipped; unknown reported', [usPn, ex.data.skipped_wo, ex.data.unknown_publications]);
  ok(ex.data.cliff.jurisdictions.EP.lastExpiry && ex.data.cliff.years.length >= 1 && ex.data.cliff.caveats.length >= 2, 'cliff per jurisdiction with caveats');
  ok(hasLimits(ex) && ex.data.limits.some((x) => /not legal advice/i.test(x)) && ex.data.limits.some((x) => /SPC|PTE/.test(x)), 'limits: estimates, PTE/SPC, legal note');
  const ef = await c.call('expiry', { pns: [SEED], family: true, jurisdictions: ['EP'] }); ok(!ef.isError && ef.data.rows.length >= 1 && ef.data.rows.every((x) => x.jurisdictions.includes('EP')), 'family and jurisdictions options');
  ok((await c.call('expiry', { pns: ['NOPE'] })).isError && (await c.call('expiry', { pns: [] })).isError && (await c.call('expiry', { pns: ['EP9999999B1'] })).data.error === 'not_found', 'only unknown numbers / empty list -> errors');

  if (o.cancel) {
    sec(`${label}: cancellation and responsiveness`);
    const idc = ++c.id; let got = false;
    c.waiters.set(idc, () => { got = true; });
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: idc, method: 'tools/call', params: { name: 'chem_search', arguments: { query: 'C', mode: 'sub', limit: 50 } } }));
    await new Promise((res) => setTimeout(res, 120));
    const tp = performance.now(); const pg = await c.rpc('ping'); const pingMs = Math.round(performance.now() - tp);
    ok(pg.result && pingMs < 2500, `ping is answered while a substructure search runs (${pingMs} ms)`);
    c.notify('notifications/cancelled', { requestId: idc });
    await new Promise((res) => setTimeout(res, 3000));
    ok(!got, 'a cancelled request is not answered');
    const after = await c.call('search', { query: 'lipid', limit: 1 }); ok(!after.isError && after.data.hits.length === 1, 'the server works after a cancellation');
  }

  const sizes = c.lines.filter((m) => m.result && m.result.content).map((m) => m.result.content[0].text.length);
  ok(c.badLines === 0, 'stdout carries only JSON-RPC lines', c.badLines);
  ok(Math.max(...sizes) < 400000, 'no result is larger than 400 kB', Math.max(...sizes));
  const { mem, exit } = await c.close();
  ok(exit.code === 0, 'closing stdin ends the server with exit code 0', exit);
  const totalMs = Math.round(performance.now() - tStart);
  console.log(`  server stderr (${label}): ${c.stderr.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
  return { label, dist, peakRssMb: mem.hwmMb, rssMb: mem.rssMb, totalMs };
}

async function offlineAndStartup() {
  sec('offline guarantee and start-up errors');
  const code = `import('${path.join(ROOT, 'mcp', 'lib', 'env.mjs').replace(/\\/g, '/')}').then(async (m) => { m.createEnv({ dist: ${JSON.stringify(PAGES)} }); let a = 'none', b = 'none', c = 'none'; try { await fetch('https://example.com/'); a = 'fetched'; } catch (e) { a = e.name + ': ' + e.message; } try { const r = await fetch('data/manifest.json'); b = r.status; } catch (e) { b = 'err'; } try { const r = await fetch('../../etc/passwd'); c = r.status; } catch (e) { c = 'err'; } console.log(JSON.stringify({ a, b, c })); })`;
  const r = spawnSync('node', ['-e', code], { encoding: 'utf8' });
  let o = {}; try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { /* reported below */ }
  ok(/network access is disabled/.test(o.a || '') && o.b === 200 && o.c === 403, 'the engines can read the build and nothing else: http(s) is refused, paths outside the build give 403', r.stdout + r.stderr);
  const chk = spawnSync('node', [SERVER, '--dist', PAGES, '--check'], { encoding: 'utf8' });
  let cj = null; try { cj = JSON.parse(chk.stdout); } catch (e) { /* below */ }
  ok(chk.status === 0 && cj && cj.counts.patents > 1000 && cj.engines.includes('LnpRanges') && cj.engines.includes('LnpMarkush') && cj.engines.includes('LnpExpiry') && cj.chemistry, '--check lists the build contents', chk.stdout.slice(0, 300));
  const nb = spawnSync('node', [SERVER, '--dist', path.join(SCRATCH, 'does-not-exist')], { encoding: 'utf8' });
  ok(nb.status === 1 && /cannot start/.test(nb.stderr) && /build_pages|build_dist/.test(nb.stderr) && nb.stdout === '', 'missing build: exit 1, message on stderr, nothing on stdout', nb.stderr);
  const bo = spawnSync('node', [SERVER, '--bogus'], { encoding: 'utf8' }); ok(bo.status === 2 && /unknown option/.test(bo.stderr), 'unknown option: exit 2');
  const hp = spawnSync('node', [SERVER, '--help'], { encoding: 'utf8' }); ok(hp.status === 0 && /--dist/.test(hp.stdout), '--help');
  const gate = fs.mkdtempSync(path.join(SCRATCH, 'bad_'));
  fs.mkdirSync(path.join(gate, 'data')); fs.writeFileSync(path.join(gate, 'data', 'manifest.json'), '{"v":1}');
  const bm = spawnSync('node', [SERVER, '--dist', gate], { encoding: 'utf8' }); ok(bm.status === 1 && /lacks counts/.test(bm.stderr), 'a manifest that is not a Patent Desk build is refused', bm.stderr);
  fs.rmSync(gate, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ main
fs.mkdirSync(SCRATCH, { recursive: true });
const results = [];
(async () => {
  if (!hasBuild(PAGES)) {
    if (flag('no-build')) { console.log('website build missing: ' + PAGES); process.exit(2); }
    if (!build(PAGES, ['--enc', 'bin', '--budget-mb', '900', '--max-files', '3000', '--target', 'pages'], 'pages')) { console.log('build failed'); process.exit(2); }
  }
  let b64 = arg('b64', '');
  if (!b64) {
    const sib = path.join(path.dirname(SCRATCH), 'T9', 'dist');
    b64 = path.join(SCRATCH, 'b64');
    if (!hasBuild(b64) && hasBuild(sib) && !flag('own-b64')) b64 = sib;
  }
  b64 = path.resolve(b64);
  if (ONLY !== 'pages' && !hasBuild(b64)) {
    if (flag('no-build')) { console.log('b64 build missing: ' + b64); process.exit(2); }
    if (!build(b64, ['--enc', 'b64', '--limit', '2000', '--budget-mb', '215'], 'b64')) { console.log('b64 build failed'); process.exit(2); }
  }
  await offlineAndStartup();
  const man = JSON.parse(fs.readFileSync(path.join(PAGES, 'data', 'manifest.json'), 'utf8'));
  console.log(`\nwebsite build: ${PAGES} (${man.counts.patents} publications, ${man.counts.fulltext} with claim text, enc ${man.enc}, built ${man.built})`);
  if (ONLY !== 'b64') results.push(await runSuite('pages', PAGES, { cancel: true }));
  if (ONLY !== 'pages') {
    const m2 = JSON.parse(fs.readFileSync(path.join(b64, 'data', 'manifest.json'), 'utf8'));
    console.log(`\nbase64 build: ${b64} (${m2.counts.patents} publications, enc ${m2.enc}, text cut ${!!(m2.cut && m2.cut.applied)})`);
    results.push(await runSuite('b64', b64, { cancel: false }));
  }
  console.log('\n## timings (ms)');
  for (const [k, v] of Object.entries(timings)) console.log('  ' + k.padEnd(52) + v.join(', '));
  console.log('\n## memory of the server process');
  for (const r of results) console.log(`  ${r.label.padEnd(6)} peak RSS ${r.peakRssMb} MB, RSS at end ${r.rssMb} MB, session ${(r.totalMs / 1000).toFixed(1)} s`);
  console.log(`\n${checks - fails.length} / ${checks} checks passed`);
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.log('test run failed: ' + (e && e.stack || e)); process.exit(1); });
