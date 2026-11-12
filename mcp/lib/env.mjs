// Node environment for the browser engines of the LNP Patent Desk (web/engine/*.js).
//
// The engines are plain scripts that talk to each other through globals (LnpTok, LnpLoader, LnpData, LnpSearch,
// LnpChem, LnpRanges, LnpMarkush, LnpExpiry). This module loads those very files in Node, so the MCP server uses
// the same code that runs in the page:
//   - the only file system access is a replacement of globalThis.fetch that reads files below the dist directory;
//     any http(s) URL is refused, so the server cannot reach the network through the engines;
//   - data.js and search.js have no module export: they run with vm.runInThisContext (local, repository code);
//   - everything else is required as CommonJS.
// Nothing here evaluates patent text.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createChemThreadCore } from './chem-thread.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export class EnvError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

const MIME = { '.json': 'application/json', '.txt': 'text/plain', '.js': 'text/javascript', '.bin': 'application/octet-stream' };

// A fetch() that only knows files below `root`. Relative URLs ("data/manifest.json") are resolved against it.
// Symbolic links are resolved before the prefix check, so a link inside the build cannot serve a file outside it.
function makeFileFetch(root) {
  let base = path.resolve(root);
  try { base = fs.realpathSync(base); } catch (e) { /* keep the resolved path */ }
  return async function fileFetch(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) {
      throw new TypeError('network access is disabled in the MCP server (' + url.split('?')[0].slice(0, 80) + ')');
    }
    let rel = url.replace(/^file:\/\//i, '').replace(/[?#].*$/, '');
    try { rel = decodeURIComponent(rel); } catch (e) { /* keep */ }
    let full = path.resolve(base, rel.replace(/^\/+/, ''));
    if (full !== base && !full.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
    try { full = fs.realpathSync(full); } catch (e) { return new Response('not found', { status: 404 }); }
    if (full !== base && !full.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
    let buf;
    try { buf = fs.readFileSync(full); } catch (e) { return new Response('not found', { status: 404 }); }
    return new Response(buf, { status: 200, headers: { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'content-length': String(buf.length) } });
  };
}

function runScript(file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(src, { filename: file });
}

/**
 * Prepares the global environment once per process.
 * @param {{dist: string, engines?: string}} o
 * @returns {Promise<object>} env with the engines and a few helpers
 */
export function createEnv(o) {
  const dist = path.resolve(o.dist);
  if (!isDir(dist)) throw new EnvError('no_dist', 'dist directory not found: ' + dist);
  const manifestFile = path.join(dist, 'data', 'manifest.json');
  if (!isFile(manifestFile)) throw new EnvError('no_manifest', 'not a Patent Desk build (data/manifest.json missing): ' + dist);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { throw new EnvError('bad_manifest', 'data/manifest.json is not valid JSON: ' + e.message); }
  if (!manifest || !manifest.counts || !manifest.pat || !manifest.idx) throw new EnvError('bad_manifest', 'data/manifest.json lacks counts / pat / idx: is this a Patent Desk build?');

  // Engine files: the ones shipped in the build (they match its data format), else the repository's web/engine.
  // They are executed in this process (vm.runInThisContext / require), so --dist must be a build you trust.
  const candidates = [o.engines, path.join(dist, 'engine'), path.join(REPO_ROOT, 'web', 'engine')].filter(Boolean).map((p) => path.resolve(p));
  const engDir = candidates.find((d) => isFile(path.join(d, 'search-worker.js')) && isFile(path.join(d, 'data.js')));
  if (!engDir) throw new EnvError('no_engines', 'engine files not found in ' + candidates.join(' or '));
  const ocl = [path.join(dist, 'vendor', 'openchemlib-full.js'), path.join(path.dirname(engDir), 'vendor', 'openchemlib-full.js'), path.join(REPO_ROOT, 'web', 'vendor', 'openchemlib-full.js')].find(isFile);

  // fixed, file-only fetch for every engine
  globalThis.fetch = makeFileFetch(dist);

  const E = (n) => path.join(engDir, n);
  require(E('tok.js'));
  require(E('loader.js'));
  require(E('search-worker.js'));          // global LnpSearchCore (search runs on the main thread, like mode "main" in the page)
  runScript(E('data.js'));                 // global LnpData
  runScript(E('search.js'));               // global LnpSearch

  const env = {
    dist, engDir, manifest, oclFile: ocl || null, engines: {}, notes: [],
    fileExists: (rel) => isFile(path.join(dist, rel)),
    has: (name) => isFile(E(name))
  };
  if (engDir !== path.join(dist, 'engine')) env.notes.push('engine files taken from ' + engDir + ' (the build has none)');
  // optional engines register their own globals; a missing file only disables the tool that needs it
  function opt(name, global) {
    if (!isFile(E(name))) return null;
    try { const m = require(E(name)); if (!globalThis[global]) globalThis[global] = m; env.engines[global] = globalThis[global]; return globalThis[global]; }
    catch (e) { env.notes.push(name + ' could not be loaded: ' + e.message); return null; }
  }
  env.OCL = ocl ? require(ocl) : null;
  if (isFile(E('chem.js')) && isFile(E('chem-worker.js')) && isFile(E('chemfp.js')) && env.OCL) {
    const chem = require(E('chem.js'));               // in Node chem.js only exports (isNode); the others find it by global
    globalThis.LnpChem = chem;
    env.engines.LnpChem = chem;
    // the structure search runs in a worker thread (mcp/lib/chem-thread.mjs) so that it cannot block the protocol loop;
    // LNP_MCP_CHEM_THREAD=0 runs it on the main thread as before
    if (process.env.LNP_MCP_CHEM_THREAD === '0') env.chemCore = { create: require(E('chem-worker.js')).create, OCL: env.OCL, ChemFP: require(E('chemfp.js')) };
    else {
      env.chemThread = createChemThreadCore({ workerFile: E('chem-worker.js'), oclFile: ocl, fpFile: E('chemfp.js') });
      env.chemCore = { create: env.chemThread.create, OCL: env.OCL, ChemFP: require(E('chemfp.js')) };
    }
  } else env.notes.push('chemistry engine or OpenChemLib missing: chem_search, markush_check by name are not available');
  opt('x-ranges.js', 'LnpRanges');
  opt('x-markush.js', 'LnpMarkush');
  opt('x-expiry.js', 'LnpExpiry');
  env.engines.LnpData = globalThis.LnpData; env.engines.LnpSearch = globalThis.LnpSearch;
  return env;
}

export { makeFileFetch };
