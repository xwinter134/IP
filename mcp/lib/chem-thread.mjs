// Chemistry engine (web/engine/chem-worker.js) in a worker thread, so a long structure search cannot block the server's
// event loop: ping, notifications/cancelled and the per-call timeout keep working while it runs, and a cancelled or
// timed-out search is stopped by terminating the thread.
//
// createChemThreadCore({workerFile, oclFile, fpFile}) -> {create, abort, close, stats}
//   create() returns an object with the methods of the chem-worker core (load, resolve, sss, sim, ...); every method
//   posts one message to the thread and returns a Promise. chem.js wraps it like its own in-page core ("given" mode).
//   abort(): if a call is running, the thread is terminated, pending calls fail with code "cancelled", and the next call
//   starts a new thread and reloads the structure set from the bytes kept in this thread (one copy, about 40 MB).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

if (!isMainThread && parentPort && workerData && workerData.lnpChemThread) {
  // ---------------------------------------------------------------- thread side
  const require = createRequire(SELF);
  const OCL = require(workerData.oclFile), FP = require(workerData.fpFile), core = require(workerData.workerFile).create(OCL, FP);
  parentPort.on('message', (m) => {
    let r;
    try {
      if (typeof core[m.op] !== 'function') throw new Error('unknown op ' + m.op);
      r = core[m.op](m.a || {});
      parentPort.postMessage({ id: m.id, ok: true, r });
    } catch (e) {
      parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 500), code: e && e.code });
    }
  });
}

export function createChemThreadCore(o) {
  let w = null, seq = 0, loadArgs = null, booting = null;
  const pending = new Map();
  const stats = { threads: 0, aborted: 0 };
  function fail(e) { for (const [, p] of pending) p.rej(e); pending.clear(); }
  function spawn() {
    w = new Worker(SELF, { workerData: { lnpChemThread: true, oclFile: o.oclFile, fpFile: o.fpFile, workerFile: o.workerFile } });
    stats.threads++;
    w.unref();
    w.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.ok) p.res(m.r); else p.rej(Object.assign(new Error(m.error), { code: m.code || 'chem' })); });
    w.on('error', (e) => { fail(Object.assign(new Error('chemistry thread failed: ' + ((e && e.message) || e)), { code: 'worker' })); w = null; booting = null; });
    w.on('exit', () => { w = null; booting = null; });
  }
  function post(op, a) {
    return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); w.postMessage({ id, op, a }); });
  }
  // a fresh thread needs the structure set again
  function ensure() {
    if (w && !booting) return Promise.resolve();
    if (booting) return booting;
    spawn();
    if (!loadArgs) return Promise.resolve();
    booting = post('load', loadArgs).then(() => { booting = null; }, (e) => { booting = null; throw e; });
    return booting;
  }
  function call(op, a) {
    if (op === 'load') { loadArgs = a; if (!w) spawn(); return post('load', a); }
    return ensure().then(() => post(op, a));
  }
  const core = new Proxy({}, { get: (t, op) => (typeof op === 'string' && op !== 'then') ? (a) => call(op, a) : undefined });
  return {
    create: () => core,
    abort() {
      if (!w || !pending.size) return false;
      stats.aborted++;
      const dead = w; w = null; booting = null;
      fail(Object.assign(new Error('search cancelled'), { code: 'cancelled' }));
      dead.terminate().catch(() => {});
      return true;
    },
    close() { if (w) { w.terminate().catch(() => {}); w = null; } },
    stats: () => Object.assign({ busy: pending.size }, stats)
  };
}
