/* LNP-FTO persistence (global LnpStore). Plain script, ASCII only. API: docs/ARCHITECTURE.md.
   Backends, first that works: "db" (Artifact db capability), "local" (localStorage), "memory".
   A document is {u: ISO time of the last write, v: value}. A value whose JSON is longer than PART characters
   is split: head {u, n: parts, len} in <kind>/<id>, parts {s: text} in <kind>-parts/<id>.<i>.
   The JSON is written ASCII-only (non-ASCII as \uXXXX), so characters = bytes; even if the store counts a part
   in its JSON-escaped form (at most twice as long) it stays below the 256 KiB limit of the db capability. */
(function (g) {
  'use strict';
  var KINDS = ['profiles', 'opinions', 'marks', 'searches', 'settings', 'diag'];
  var PART = 120000, PREFIX = 'lnp:';
  var S = { backend: null, db: null, ready: null, listeners: {}, mem: new Map(), log: [], readonly: false, session: new Map() };
  function mkErr(code, message) { return { code: code, message: message }; }
  function note(what, e) { S.log.push({ t: Date.now(), what: what, code: (e && e.code) || null, message: String((e && e.message) || e || '') }); if (S.log.length > 30) S.log.shift(); }
  function cleanId(id) {
    id = String(id == null ? '' : id).replace(/[^A-Za-z0-9_.~:@+-]/g, '_').slice(0, 150);
    if (!id || id === '.' || id === '..') id = '_' + id;
    return id;
  }
  function kindOk(kind) { if (KINDS.indexOf(kind) < 0) throw mkErr('bad_kind', 'unknown kind: ' + kind); return kind; }
  function asciiJson(v) {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); });
  }
  function emit(kind, ev) {
    var l = S.listeners[kind] || [];
    for (var i = 0; i < l.length; i++) { try { l[i](ev); } catch (e) { /* listener errors never break a write */ } }
  }
  function withTimeout(p, ms, fallback) {
    return new Promise(function (res) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; res(fallback); } }, ms);
      Promise.resolve(p).then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } }, function () { if (!done) { done = true; clearTimeout(t); res(fallback); } });
    });
  }

  /* ------------------------------------------------------------ backends: get/set/del/list of raw documents */
  var mem = {
    get: function (col, id) { var v = S.mem.get(col + '/' + id); return Promise.resolve(v ? JSON.parse(v) : null); },
    set: function (col, id, doc) { S.mem.set(col + '/' + id, JSON.stringify(doc)); return Promise.resolve(); },
    del: function (col, id) { S.mem.delete(col + '/' + id); return Promise.resolve(); },
    list: function (col) {
      var out = [];
      S.mem.forEach(function (v, k) { if (k.indexOf(col + '/') === 0) out.push({ id: k.slice(col.length + 1), doc: JSON.parse(v) }); });
      return Promise.resolve(out);
    }
  };
  var local = {
    get: function (col, id) {
      try { var t = g.localStorage.getItem(PREFIX + col + '/' + id); return Promise.resolve(t ? JSON.parse(t) : null); }
      catch (e) { return mem.get(col, id); }
    },
    set: function (col, id, doc) {
      try { g.localStorage.setItem(PREFIX + col + '/' + id, JSON.stringify(doc)); return Promise.resolve(); }
      catch (e) { note('local.set', e); return mem.set(col, id, doc); }       // quota or blocked storage: keep it for this visit
    },
    del: function (col, id) {
      try { g.localStorage.removeItem(PREFIX + col + '/' + id); } catch (e) { /* ignore */ }
      return mem.del(col, id);
    },
    list: function (col) {
      var out = [], seen = {};
      try {
        var pre = PREFIX + col + '/';
        for (var i = 0; i < g.localStorage.length; i++) {
          var k = g.localStorage.key(i);
          if (k && k.indexOf(pre) === 0) { try { out.push({ id: k.slice(pre.length), doc: JSON.parse(g.localStorage.getItem(k)) }); seen[k.slice(pre.length)] = 1; } catch (e2) { /* skip a broken entry */ } }
        }
      } catch (e) { /* ignore */ }
      return mem.list(col).then(function (m) { m.forEach(function (x) { if (!seen[x.id]) out.push(x); }); return out; });
    }
  };
  var remote = {
    get: function (col, id) { return S.db.collection(col).doc(id).get().then(function (s) { return s && s.exists ? s.data() : null; }); },
    set: function (col, id, doc) { return S.db.collection(col).doc(id).set(doc); },
    del: function (col, id) { return S.db.collection(col).doc(id).delete(); },
    list: function (col) { return S.db.collection(col).get().then(function (q) { return (q.docs || []).map(function (d) { return { id: d.id, doc: d.data() }; }); }); }
  };
  function be() { return S.backend === 'db' ? remote : S.backend === 'local' ? local : mem; }
  // one retry for a transient db error, then the write/read falls back to the local backend for this visit
  function run(op, args) {
    var b = be();
    if (b !== remote) return b[op].apply(b, args);
    return remote[op].apply(remote, args).catch(function (e) {
      if (e && e.code === 'unavailable') return new Promise(function (r) { setTimeout(r, 400 + Math.random() * 600); }).then(function () { return remote[op].apply(remote, args); });
      throw e;
    }).catch(function (e) {
      note('db.' + op, e);
      if (op === 'set' || op === 'del') { S.readonly = true; return local[op].apply(local, args); }
      return local[op].apply(local, args);
    });
  }

  /* ------------------------------------------------------------ init */
  function localWorks() {
    try { var k = PREFIX + 'probe'; g.localStorage.setItem(k, '1'); g.localStorage.removeItem(k); return true; } catch (e) { return false; }
  }
  function getDb(timeoutMs) {
    try {
      if (!g.claude || typeof g.claude.use !== 'function') return Promise.resolve(null);
      return withTimeout(g.claude.use('db'), timeoutMs, null);
    } catch (e) { return Promise.resolve(null); }
  }
  function init(o) {
    if (S.ready) return S.ready;
    o = o || {};
    S.ready = getDb(o.timeoutMs || 5000).then(function (db) {
      if (!db) return null;
      S.db = db;
      // the first real call decides (consent, grant and rules arrive on calls, never on use())
      return withTimeout(db.collection('settings').doc('app').get().then(function () { return true; }), 8000, false);
    }).then(function (ok) {
      S.backend = ok ? 'db' : localWorks() ? 'local' : 'memory';
      if (!ok) S.db = null;
      return { backend: S.backend };
    }, function (e) {
      note('init', e); S.db = null; S.backend = localWorks() ? 'local' : 'memory';
      return { backend: S.backend };
    });
    return S.ready;
  }
  function ready() { return S.ready || init(); }

  /* ------------------------------------------------------------ documents */
  function assemble(kind, id, doc) {
    if (!doc) return Promise.resolve(null);
    if (!doc.n) return Promise.resolve({ id: id, updated: doc.u || null, value: doc.v === undefined ? null : doc.v });
    var ps = [];
    for (var i = 0; i < doc.n; i++) ps.push(run('get', [kind + '-parts', id + '.' + i]));
    return Promise.all(ps).then(function (parts) {
      var t = '';
      for (var j = 0; j < parts.length; j++) { if (!parts[j] || typeof parts[j].s !== 'string') throw mkErr('incomplete', kind + '/' + id + ': part ' + j + ' is missing'); t += parts[j].s; }
      if (doc.len && t.length !== doc.len) throw mkErr('incomplete', kind + '/' + id + ': length mismatch');
      return { id: id, updated: doc.u || null, value: JSON.parse(t) };
    });
  }
  function get(kind, id) {
    return ready().then(function () { kindOk(kind); id = cleanId(id); return run('get', [kind, id]); })
      .then(function (doc) { return assemble(kind, id, doc); })
      .then(function (r) { return r ? r.value : null; });
  }
  function entry(kind, id) {
    return ready().then(function () { kindOk(kind); id = cleanId(id); return run('get', [kind, id]); }).then(function (doc) { return assemble(kind, id, doc); });
  }
  // entries(kind) -> [{id, updated, value}] newest first; {values: false} skips the bodies (value undefined, parts = n)
  function entries(kind, o) {
    o = o || {};
    return ready().then(function () { kindOk(kind); return run('list', [kind]); }).then(function (rows) {
      return Promise.all(rows.map(function (r) {
        if (!r.doc) return null;
        if (o.values === false) return { id: r.id, updated: r.doc.u || null, parts: r.doc.n || 0, value: r.doc.n ? undefined : r.doc.v };
        return assemble(kind, r.id, r.doc).catch(function (e) { note('list ' + kind + '/' + r.id, e); return null; });
      }));
    }).then(function (a) {
      a = a.filter(Boolean);
      a.sort(function (x, y) { return String(y.updated || '').localeCompare(String(x.updated || '')); });
      return a;
    });
  }
  // list(kind) -> the stored values, newest first. Plain objects are returned as shallow copies that carry the
  // document id as `id` when the value has none, and the write time as non-enumerable `_updated` / `_id`.
  function list(kind) {
    return entries(kind).then(function (rows) {
      return rows.map(function (r) {
        var v = r.value;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
        v = Object.assign({}, v);
        if (v.id === undefined) v.id = r.id;
        try { Object.defineProperty(v, '_id', { value: r.id, enumerable: false }); Object.defineProperty(v, '_updated', { value: r.updated, enumerable: false }); } catch (e) { /* ignore */ }
        return v;
      });
    });
  }
  function put(kind, id, value) {
    var u = new Date().toISOString();
    return ready().then(function () {
      kindOk(kind); id = cleanId(id);
      var json = asciiJson(value === undefined ? null : value);
      return run('get', [kind, id]).catch(function () { return null; }).then(function (old) {
        var oldN = (old && old.n) || 0, n = 0, w;
        if (json.length <= PART) w = run('set', [kind, id, { u: u, v: JSON.parse(json) }]);
        else {
          n = Math.ceil(json.length / PART);
          var ps = [];
          for (var i = 0; i < n; i++) ps.push(run('set', [kind + '-parts', id + '.' + i, { s: json.slice(i * PART, (i + 1) * PART) }]));
          // parts first, head last: a reader never sees a head that points at parts not yet written
          w = Promise.all(ps).then(function () { return run('set', [kind, id, { u: u, n: n, len: json.length }]); });
        }
        return w.then(function () {
          var del = [];
          for (var j = n; j < oldN; j++) del.push(run('del', [kind + '-parts', id + '.' + j]).catch(function () { }));
          return Promise.all(del);
        });
      });
    }).then(function () {
      S.session.set(kind + '/' + id, 1);
      emit(kind, { type: 'put', kind: kind, id: id, updated: u, value: value });
      return { id: id, updated: u, backend: S.backend };
    });
  }
  function remove(kind, id) {
    return ready().then(function () {
      kindOk(kind); id = cleanId(id);
      return run('get', [kind, id]).catch(function () { return null; }).then(function (old) {
        var del = [run('del', [kind, id])];
        for (var j = 0; j < ((old && old.n) || 0); j++) del.push(run('del', [kind + '-parts', id + '.' + j]).catch(function () { }));
        return Promise.all(del);
      });
    }).then(function () { emit(kind, { type: 'remove', kind: kind, id: id }); return true; });
  }
  function onChange(kind, fn) {
    kindOk(kind);
    (S.listeners[kind] = S.listeners[kind] || []).push(fn);
    return function () { var l = S.listeners[kind], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  }
  function diag() { return { backend: S.backend, readonly: S.readonly, log: S.log.slice(), kinds: KINDS.slice(), partChars: PART }; }
  function reset() { S.backend = null; S.db = null; S.ready = null; S.mem = new Map(); S.readonly = false; }

  g.LnpStore = { init: init, list: list, entries: entries, get: get, entry: entry, put: put, remove: remove, onChange: onChange, diag: diag, cleanId: cleanId, KINDS: KINDS, _reset: reset };
})(typeof self !== 'undefined' ? self : this);
