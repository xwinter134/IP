/* LNP Patent Desk: app shell (global LnpApp). Classic script; needs ui.js, router.js and the engines.
   Boot -> capabilities -> data -> search index -> store -> views -> router.
   Views register themselves:  LnpApp.registerView({id, title, icon, mount(el, route, app)})
     mount may return nothing, a destroy function, or {update(route) -> true if handled, destroy()}.
   View files: app/views/<id>.js for the built-in ids below, plus every app/views/*.js, app/*.css and the optional
   engines (engine/ai.js, fto-prompts.js, fto-render.js, fto.js) that data/manifest.json lists under "files". */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  var RAIL = ['suche', 'struktur', 'produkte', 'fto', 'landschaft', 'merkliste', 'system'];
  var BUILTIN = ['suche', 'patent', 'familie', 'struktur', 'produkte', 'fto', 'landschaft', 'merkliste', 'system'];
  var OPTIONAL_ENGINES = ['engine/ai.js', 'engine/fto-prompts.js', 'engine/fto-render.js', 'engine/fto.js'];
  var t0 = (g.performance && performance.now) ? performance.now() : 0;
  function now() { return Math.round(((g.performance && performance.now) ? performance.now() : 0) - t0); }

  var App = {
    views: {}, caps: { sample: null, db: null, downloads: null, user: null }, capsState: {}, capsReady: null,
    manifest: null, seed: null, route: null, current: null, state: { lastQuery: '', lastParsed: null },
    timings: {}, errors: [], events: {}, booted: false, store: { backend: null }
  };
  App.on = function (ev, fn) { (App.events[ev] = App.events[ev] || []).push(fn); return function () { var l = App.events[ev], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; };
  App.emit = function (ev, data) { (App.events[ev] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { logError('event ' + ev, e); } }); };

  /* ------------------------------------------------------------ extension hooks (LnpApp.ext)
     Registries that extension files (engine/x-*.js, app/views/<id>.js) fill and the built-in views read when they mount.
     A hook registered after a view was mounted shows on the next mount. Every call into a hook is isolated: a throwing
     hook is logged (App.logError) and skipped. Contract: docs/TOOLS_PLAN.md 2.1.
       patentAction(fn(P, ctx) -> Node|Node[]|null)           claimAction(fn(P, claim, ctx) -> Node|null)
       patentPanel({id, title, over, order, when(P), render(P, el, ctx) -> destroy?})      links(fn(P) -> [{label, href, title}])
       compoundAction(fn(hit, ctx) -> Node|null)              resultAction(fn({query, parsed, filters, total, all}) -> Node|null)
       searchFacet({id, title, order, counts(allPs) -> Promise<[{value, label, n}]>, ps(value) -> Promise<Uint32Array|number[]>})
     Getters: ext.list(kind) (specs, panels and facets ordered), ext.nodes(kind, ...args) (DOM nodes of all function hooks),
     ext.linkItems(P) (sanitised link entries), ext.has(kind). Registering returns a function that removes the entry. */
  var EXT_FN = ['patentAction', 'claimAction', 'links', 'compoundAction', 'resultAction'], EXT_SPEC = ['patentPanel', 'searchFacet'];
  var extReg = {};
  var ext = App.ext = {};
  var extListeners = [];
  // ext.on(fn(kind, entry)): called when a spec hook (patentPanel, searchFacet) registers; returns an unsubscribe function
  ext.on = function (fn) { if (typeof fn !== 'function') return function () { }; extListeners.push(fn); return function () { var i = extListeners.indexOf(fn); if (i >= 0) extListeners.splice(i, 1); }; };
  // facet link for #suche (--f<id>:<value>), so other tools need not hand-roll the syntax
  ext.facetHref = function (id, value, q) { return R.build({ view: 'suche', arg: q || '', params: { f: [id + ':' + value] } }); };
  EXT_FN.concat(EXT_SPEC).forEach(function (kind) {
    extReg[kind] = [];
    ext[kind] = function (entry) {
      var isSpec = EXT_SPEC.indexOf(kind) >= 0;
      if (isSpec ? !(entry && typeof entry === 'object' && entry.id) : typeof entry !== 'function') return function () { };
      if (isSpec) {                                    // one entry per id: registering again replaces (a script loaded twice)
        extReg[kind] = extReg[kind].filter(function (x) { return x.id !== entry.id; });
      }
      extReg[kind].push(entry);
      if (isSpec) extListeners.slice().forEach(function (fn) { try { fn(kind, entry); } catch (e) { logError('ext on', e); } });
      return function () { var i = extReg[kind].indexOf(entry); if (i >= 0) extReg[kind].splice(i, 1); };
    };
  });
  ext.list = function (kind) {
    var a = (extReg[kind] || []).slice();
    if (EXT_SPEC.indexOf(kind) >= 0) a = a.map(function (x, i) { return { x: x, i: i }; }).sort(function (p, q) { return ((+p.x.order || 0) - (+q.x.order || 0)) || (p.i - q.i); }).map(function (p) { return p.x; });
    return a;
  };
  ext.has = function (kind) { return !!(extReg[kind] && extReg[kind].length); };
  // call every function hook of a kind with the same arguments; results are flattened, empty ones dropped
  var extLogged = {};                                  // a hook that fails for every claim is logged once, not once per call
  ext.call = function (kind) {
    var args = Array.prototype.slice.call(arguments, 1), out = [];
    (extReg[kind] || []).slice().forEach(function (fn, i) {
      if (typeof fn !== 'function') return;
      try {
        var r = fn.apply(null, args);
        (Array.isArray(r) ? r : [r]).forEach(function (x) { if (x != null && x !== false) out.push(x); });
      } catch (e) { var k = kind + '#' + i + ':' + String((e && e.message) || e); if (!extLogged[k]) { extLogged[k] = 1; logError('ext ' + kind + ' #' + i, e); } }
    });
    return out;
  };
  ext.nodes = function (kind) { return ext.call.apply(ext, arguments).filter(function (n) { return n && n.nodeType === 1; }); };
  // link entries with a plain http(s) address; anything else is dropped (patent text may have been used to build a URL)
  ext.linkItems = function (P) {
    return ext.call('links', P).filter(function (l) { return l && typeof l.href === 'string' && /^https?:\/\//i.test(l.href) && l.label; })
      .map(function (l) { return { label: String(l.label), href: l.href, title: l.title ? String(l.title) : '' }; });
  };

  /* ------------------------------------------------------------ errors */
  function logError(where, e) {
    var rec = { t: now(), where: where, code: (e && e.code) || null, message: String((e && (e.message || e.reason)) || e || '').slice(0, 300) };
    App.errors.push(rec); if (App.errors.length > 25) App.errors.shift();
    writeDiagSoon();
    return rec;
  }
  App.logError = logError;
  g.addEventListener('error', function (ev) { logError('window', { message: (ev && ev.message) || 'error', code: ev && ev.filename ? String(ev.filename).replace(/^.*\//, '') + ':' + ev.lineno : null }); });
  g.addEventListener('unhandledrejection', function (ev) { logError('promise', ev && ev.reason); });

  /* ------------------------------------------------------------ theme (auto / light / dark) */
  var THEMES = ['auto', 'light', 'dark'], THEME_LABEL = { auto: 'automatic', light: 'light', dark: 'dark' }, THEME_ICO = { auto: 'auto', light: 'sun', dark: 'moon' };
  function lsGet(k) { try { return g.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { g.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  var hostTheme = document.documentElement.getAttribute('data-theme');       // what the viewer chose, if anything
  App.theme = 'auto';
  App.setTheme = function (t, quiet) {
    if (THEMES.indexOf(t) < 0) t = 'auto';
    App.theme = t;
    var root = document.documentElement;
    if (t === 'auto') { if (hostTheme) root.setAttribute('data-theme', hostTheme); else root.removeAttribute('data-theme'); }
    else root.setAttribute('data-theme', t);
    lsSet('lnp.theme', t);
    var b = document.getElementById('theme-btn');
    if (b) { U.set(b, U.icon(THEME_ICO[t])); b.title = 'Appearance: ' + THEME_LABEL[t]; b.setAttribute('aria-label', 'Change appearance, currently ' + THEME_LABEL[t]); }
    if (!quiet) U.toast('Appearance: ' + THEME_LABEL[t]);
    App.emit('theme', t);
  };
  App.isDark = function () {
    var a = document.documentElement.getAttribute('data-theme');
    if (a) return a === 'dark';
    try { return g.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  };

  /* ------------------------------------------------------------ capabilities */
  function useCap(name) {
    try {
      if (!g.claude || typeof g.claude.use !== 'function') return Promise.resolve(null);
      return Promise.resolve(g.claude.use(name)).then(function (v) { return v || null; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function startCaps() {
    var names = ['sample', 'db', 'downloads', 'user'];
    App.capsReady = Promise.all(names.map(function (n) {
      return useCap(n).then(function (v) { App.caps[n] = v; App.capsState[n] = !!v; App.emit('caps', n); return v; });
    })).then(function () { writeDiagSoon(); return App.caps; });
  }
  // the AI engine is another agent's file; it is used only when it is there and says it can run
  App.ai = function () {
    var A = g.LnpAI;
    if (!A) return null;
    try { if (typeof A.available === 'function' && !A.available()) return null; } catch (e) { return null; }
    return A;
  };

  /* ------------------------------------------------------------ boot screen */
  var STEPS = [['data', 'Manifest and master data'], ['meta', 'Patent table'], ['index', 'Search index'], ['store', 'Storage'], ['views', 'Views']];
  var stepEl = {}, stepState = {};
  function bootDraw() {
    var ol = document.getElementById('boot-steps'); if (!ol) return;
    U.clear(ol);
    STEPS.forEach(function (s) {
      var li = h('li', { data: { s: 'wait' } }, h('span.st', { text: 'waiting' }), h('span', { text: s[1] }), h('span.info'));
      stepEl[s[0]] = li; stepState[s[0]] = 'wait'; ol.appendChild(li);
    });
  }
  function bootStep(id, state, info) {
    var li = stepEl[id]; stepState[id] = state;
    if (li) {
      li.dataset.s = state;
      li.children[0].textContent = state === 'run' ? 'loading' : state === 'ok' ? 'ready' : state === 'err' ? 'error' : 'waiting';
      if (info != null) li.children[2].textContent = info;
    }
    var done = 0; STEPS.forEach(function (s) { if (stepState[s[0]] === 'ok') done++; else if (stepState[s[0]] === 'run') done += .4; });
    var pct = Math.round(done / STEPS.length * 100), bar = document.getElementById('boot-bar'), fill = document.getElementById('boot-fill');
    if (fill) fill.style.width = pct + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
  }
  function bootNow(text) { var el = document.getElementById('boot-now'); if (el) el.textContent = text; }
  function onLoadProgress(ev) {
    if (App.booted || App.timings.failed || !ev || !ev.name) return;
    if (ev.type === 'progress' || ev.type === 'start') bootNow(ev.name + (ev.loaded ? '  ' + U.bytes(ev.loaded) + (ev.total ? ' of ' + U.bytes(ev.total) : '') : ''));
    else if (ev.type === 'done') bootNow(ev.name + '  loaded');
  }
  var HINTS = {
    http: 'The server did not deliver the file. It is missing next to the page (not published, wrong name) or the request was refused.',
    network: 'The request failed: connection interrupted or blocked by the page policy.',
    gzip: 'The file arrived but could not be decompressed. It is corrupt or was altered in transit.',
    no_gzip: 'This browser has no built-in gzip decompressor, and vendor/fflate.js could not be loaded.',
    b64: 'The Base64 variant of the file is corrupt.',
    parse: 'The file was loaded, but its content is not valid JSON.',
    script: 'A script of the page could not be loaded.',
    no_worker: 'No worker available; the main thread failed as well.'
  };
  function bootFail(step, e) {
    e = e || {};
    App.timings.failed = now();
    logError('boot ' + step, e);
    bootStep(step, 'err', e.code || 'Error');
    var boot = document.getElementById('boot'); if (!boot) return;
    var title = boot.querySelector('.boot-title'); if (title) title.textContent = 'Could not load the data';
    bootNow('');
    var old = document.getElementById('boot-diag'); if (old) old.parentNode.removeChild(old);
    var tried = Array.isArray(e.tried) ? e.tried : [];
    STEPS.forEach(function (s) { if (s[0] !== step && stepState[s[0]] === 'run') bootStep(s[0], 'wait', 'aborted'); });
    var dl = h('dl');
    function row(k, v) { if (v == null || v === '') return; dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: String(v) })); }
    row('Step', (STEPS.filter(function (s) { return s[0] === step; })[0] || [0, step])[1]);
    row('File', e.name || (step === 'data' ? 'data/manifest.json' : null));
    row('Address', e.url);
    row('Error type', e.code);
    row('HTTP status', e.status);
    row('Message', e.message || String(e));
    tried.forEach(function (t) { row('Mode ' + t.mode, t.ok ? 'ok' : (t.code ? t.code + ': ' : '') + (t.error || 'failed')); });
    row('Page', location.protocol + '//' + location.host + location.pathname);
    row('Decompressor', typeof DecompressionStream !== 'undefined' ? 'DecompressionStream' : 'fflate (fallback)');
    var box = h('div', { id: 'boot-diag', style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
      h('p.notice.err', { text: HINTS[e.code] || 'The dataset is stored as files next to the page. At least one of them could not be read.' }),
      h('div.diag', null, dl),
      h('div', { style: { display: 'flex', gap: '8px', 'flex-wrap': 'wrap' } },
        h('button.btn.primary', { type: 'button', onclick: function () { retryBoot(); } }, 'Try again'),
        h('button.btn', { type: 'button', onclick: function () { U.copy(JSON.stringify(diagDoc(), null, 1), 'Diagnostics copied'); } }, U.icon('copy'), 'Copy diagnostics')));
    boot.appendChild(box);
    writeDiagSoon();
  }
  function retryBoot() {
    try { if (g.LnpData && g.LnpData.reset) g.LnpData.reset(); } catch (e) { /* ignore */ }
    try { if (g.LnpSearch && g.LnpSearch.reset) g.LnpSearch.reset(); } catch (e2) { /* ignore */ }
    var old = document.getElementById('boot-diag'); if (old) old.parentNode.removeChild(old);
    var title = document.querySelector('#boot .boot-title'); if (title) title.textContent = 'Loading dataset';
    boot();
  }

  /* ------------------------------------------------------------ diagnostics document (LnpStore diag/boot) */
  function uaFamily() {
    var ua = (navigator.userAgent || ''), m, b = 'other', v = null;
    if ((m = /Edg\/(\d+)/.exec(ua))) { b = 'Edge'; v = +m[1]; }
    else if ((m = /Firefox\/(\d+)/.exec(ua))) { b = 'Firefox'; v = +m[1]; }
    else if ((m = /Chrome\/(\d+)/.exec(ua))) { b = 'Chrome'; v = +m[1]; }
    else if ((m = /Version\/(\d+).*Safari/.exec(ua))) { b = 'Safari'; v = +m[1]; }
    var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
    return { browser: b, major: v, os: os, mobile: /Mobi|Android|iPhone/.test(ua) };
  }
  var engineDiag = { data: null, search: null, chem: null };
  function diagDoc() {
    var M = App.manifest || {};
    return {
      v: 1, at: new Date().toISOString(), ok: App.booted, ms: App.timings,
      engines: engineDiag, enc: M.enc || null, built: M.built || null, snapshots: M.snapshots || null, counts: M.counts || null,
      gzip: typeof DecompressionStream !== 'undefined' ? 'native' : 'fflate',
      worker: typeof Worker !== 'undefined', store: (g.LnpStore && g.LnpStore.diag) ? g.LnpStore.diag() : null,
      caps: { claude: !!(g.claude && g.claude.use), sample: !!App.caps.sample, db: !!App.caps.db, downloads: !!App.caps.downloads, user: !!App.caps.user },
      ai: !!g.LnpAI, aiAvailable: !!App.ai(), fto: !!g.LnpFto, views: Object.keys(App.views), route: (App.route && App.route.view) || null,
      ua: uaFamily(), viewport: [g.innerWidth, g.innerHeight, g.devicePixelRatio || 1], theme: App.theme, dark: App.isDark(),
      errors: App.errors.slice(-20)
    };
  }
  App.diag = diagDoc;
  var diagTimer = null;
  function writeDiagSoon() {
    if (diagTimer) return;
    diagTimer = setTimeout(function () {
      diagTimer = null;
      if (!g.LnpStore) return;
      var doc = diagDoc();
      var collect = [];
      if (App.booted && g.LnpChem && g.LnpChem.diag && App.chemUsed) collect.push(Promise.resolve().then(function () { return g.LnpChem.diag(); }).then(function (d) { engineDiag.chem = slim(d); doc.engines = engineDiag; }, function () { }));
      Promise.all(collect).then(function () { return g.LnpStore.put('diag', 'boot', doc); }).catch(function () { /* diagnostics never break the app */ });
    }, 1500);
  }
  App.writeDiag = writeDiagSoon;
  function slim(d) { try { return JSON.parse(JSON.stringify(d, function (k, v) { return (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 40) ? '[object]' : v; })); } catch (e) { return null; } }

  /* ------------------------------------------------------------ script / css loading */
  function loadScript(url) {
    return new Promise(function (res) {
      var s = document.createElement('script'); s.src = url; s.async = false;
      s.onload = function () { res(true); };
      s.onerror = function () { logError('script', { code: 'script', message: 'could not be loaded: ' + url }); res(false); };
      document.head.appendChild(s);
    });
  }
  function loadCss(url) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l); }
  function loadExtras() {
    var files = (App.manifest && App.manifest.files) || {}, names = Object.keys(files), jobs = [], have = {};
    OPTIONAL_ENGINES.forEach(function (f) { if (files[f]) jobs.push(f); });
    // extension engines (engine/x-*.js) load before the views that use them, in name order
    names.filter(function (f) { return /^engine\/x-[a-z0-9._-]+\.js$/.test(f); }).sort().forEach(function (f) { jobs.push(f); });
    BUILTIN.forEach(function (id) { var f = 'app/views/' + id + '.js'; jobs.push(f); have[f] = 1; });
    names.filter(function (f) { return /^app\/views\/[a-z0-9._-]+\.js$/.test(f) && !have[f]; }).sort().forEach(function (f) { jobs.push(f); });
    names.filter(function (f) { return /^app\/[a-z0-9._-]+\.css$/.test(f) && f !== 'app/app.css'; }).sort().forEach(loadCss);
    return Promise.all(jobs.map(loadScript));
  }

  /* ------------------------------------------------------------ view registry, rail, mounting */
  App.registerView = function (v) {
    if (!v || !v.id || typeof v.mount !== 'function') return;
    App.views[v.id] = v;
    if (App.booted) { drawRail(); if (App.route && App.route.view === v.id) show(App.route, true); }
  };
  function railIds() {
    var ids = RAIL.filter(function (id) { return App.views[id]; });
    Object.keys(App.views).forEach(function (id) { if (App.views[id].rail && ids.indexOf(id) < 0) ids.push(id); });
    return ids;
  }
  function drawRail() {
    var rail = document.getElementById('rail'); if (!rail) return;
    U.clear(rail);
    var cur = App.route ? ((App.views[App.route.view] || {}).parent || App.route.view) : '';
    railIds().forEach(function (id) {
      var v = App.views[id];
      if (id === 'system') rail.appendChild(h('div.rail-sep'));
      var a = h('a', { href: '#' + id, 'aria-current': cur === id ? 'page' : null, title: v.title }, U.icon(v.icon || 'dot'), h('span', { text: v.title }));
      if (id === 'merkliste' && App.marks.count()) a.appendChild(h('span.rail-n', { text: String(App.marks.count()) }));
      rail.appendChild(a);
    });
    var M = App.manifest;
    if (M) rail.appendChild(h('div.rail-foot', null, 'As of ' + U.date((M.built || '').slice(0, 10)), h('br'), 'Storage: ' + ({ db: 'Artifact', local: 'Browser', memory: 'session only' }[App.store.backend] || '–')));
  }
  function destroyCurrent() {
    var c = App.current; App.current = null;
    if (!c) return;
    try { if (typeof c.inst === 'function') c.inst(); else if (c.inst && c.inst.destroy) c.inst.destroy(); } catch (e) { logError('destroy ' + c.id, e); }
  }
  function show(route, force) {
    var host = document.getElementById('view');
    if (!route.view) route.view = 'suche';
    App.route = route;
    U.closePopover();
    var v = App.views[route.view];
    if (!force && App.current && App.current.id === route.view && App.current.inst && App.current.inst.update) {
      var handled = false;
      try { handled = App.current.inst.update(route) !== false; } catch (e) { logError('update ' + route.view, e); }
      if (handled) { drawRail(); return; }
    }
    destroyCurrent();
    U.clear(host); host.scrollTop = 0;
    drawRail();
    if (!v) {
      host.appendChild(h('div.page', null, h('div.empty', null, h('p.overline', { text: 'Not found' }), h('h3', { text: 'This view does not exist' }),
        h('p', { text: 'The address points to "' + route.view + '". The sections are listed in the bar on the left.' }), h('p', null, h('a.btn', { href: '#suche' }, 'Go to Search')))));
      return;
    }
    var inst = null;
    try { inst = v.mount(host, route, App); }
    catch (e) {
      logError('mount ' + v.id, e);
      U.set(host, h('div.page', null, h('p.notice.err', { text: 'The view "' + v.title + '" could not be built: ' + U.errText(e) })));
    }
    App.current = { id: v.id, inst: inst };
  }
  App.go = function (r, o) { return R.go(r, o); };
  App.openPatent = function (pn, o) {
    o = o || {};
    var params = {};
    if (o.claim) params.c = String(o.claim);
    if (o.lang) params.l = o.lang;
    var q = o.q != null ? o.q : App.state.lastQuery; if (q) params.q = q;
    return R.go({ view: 'patent', arg: pn, params: params });
  };
  App.patentHref = function (pn, o) {
    o = o || {};
    var params = {};
    if (o.claim) params.c = String(o.claim);
    if (o.lang) params.l = o.lang;
    var q = o.q != null ? o.q : App.state.lastQuery; if (q) params.q = q;
    return R.build({ view: 'patent', arg: pn, params: params });
  };

  /* ------------------------------------------------------------ marks (watchlist + notes), settings, hand-over */
  var marks = new Map();
  App.marks = {
    get: function (pn) { return marks.get(pn) || null; },
    isStar: function (pn) { var m = marks.get(pn); return !!(m && m.star); },
    count: function () { var n = 0; marks.forEach(function (m) { if (m.star) n++; }); return n; },
    all: function () { return Array.from(marks.values()); },
    save: function (pn, patch) {
      var m = Object.assign({ pn: pn, star: false, tag: '', note: '' }, marks.get(pn) || {}, patch || {}, { ts: new Date().toISOString() });
      var empty = !m.star && !m.note && !m.tag;
      if (empty) marks.delete(pn); else marks.set(pn, m);
      App.emit('marks', { pn: pn, mark: empty ? null : m });
      drawRail();
      var p = empty ? g.LnpStore.remove('marks', pn) : g.LnpStore.put('marks', pn, m);
      return p.catch(function (e) { logError('marks', e); U.toast('Could not save the watchlist: ' + U.errText(e), { error: true }); });
    },
    toggle: function (pn, meta) {
      var on = !App.marks.isStar(pn);
      U.toast(on ? U.pnPretty(pn) + ' added to watchlist' : U.pnPretty(pn) + ' removed from watchlist');
      return App.marks.save(pn, Object.assign({ star: on }, meta || {}));
    }
  };
  function loadMarks() {
    return g.LnpStore.entries('marks').then(function (rows) { rows.forEach(function (r) { if (r.value && r.value.pn) marks.set(r.value.pn, r.value); }); }, function (e) { logError('marks list', e); });
  }
  // the selection handed to the FTO view: settings/fto-selection = {pns[], q, from, ts}
  App.handToFto = function (pns, meta) {
    var doc = Object.assign({ pns: pns.slice(0, 200), from: 'suche', ts: new Date().toISOString() }, meta || {});
    return g.LnpStore.put('settings', 'fto-selection', doc).then(function () { R.go('#fto'); }, function (e) { U.toast('Hand-over failed: ' + U.errText(e), { error: true }); });
  };

  /* ------------------------------------------------------------ band */
  function drawBand() {
    var M = App.manifest, c = (M && M.counts) || {}, box = document.getElementById('band-counts'); if (!box) return;
    U.clear(box);
    [['Patents', c.patents], ['Families', c.families], ['Full texts', c.fulltext], ['Claims', c.claims], ['Compounds', c.compounds]].forEach(function (x) {
      if (x[1] == null) return;
      box.appendChild(h('div', null, h('dt', { text: x[0] }), h('dd', { text: U.num(x[1]) })));
    });
  }

  /* ------------------------------------------------------------ command palette */
  var pal = null;
  App.palette = function (preset) {
    if (pal) { pal.close(); return; }
    var input = h('input.pal-input', { id: 'pal-input', type: 'text', placeholder: 'Patent number, search terms, view …', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Command or search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list' });
    var list = h('div.pal-list', { id: 'pal-list', role: 'listbox' });
    var foot = h('div.pal-foot', null, h('span', { text: '↑↓ select' }), h('span', { text: '↵ open' }), h('span', { text: 'Esc close' }));
    var items = [], sel = 0, seq = 0, saved = null;
    var dlg = U.dialog('Commands', h('div', { style: { display: 'flex', 'flex-direction': 'column', 'min-height': '0', flex: '1' } }, input, list, foot), { bare: true, onClose: function () { pal = null; } });
    pal = dlg;
    g.LnpStore.entries('searches').then(function (rows) { saved = rows; build(); }, function () { saved = []; });
    function item(group, title, sub, icon, run) { return { group: group, title: title, sub: sub, icon: icon, run: run }; }
    function build() {
      var q = input.value.trim(), ql = q.toLowerCase(), my = ++seq, out = [];
      if (q) {
        out.push(item('Search', 'Search for "' + q + '"', 'Full text, title, abstract', 'search', function () { R.go({ view: 'suche', arg: q }); }));
        if (/^(schembl\s*\d+|smarts:|[A-Za-z0-9@+\-\[\]()=#\\\/]{6,})$/i.test(q) && !/\s/.test(q)) out.push(item('Search', 'Search structure: ' + q, 'Name, SMILES or SCHEMBL number', 'structure', function () { R.go({ view: 'struktur', arg: q }); }));
      }
      railIds().forEach(function (id) {
        var v = App.views[id];
        if (!ql || v.title.toLowerCase().indexOf(ql) >= 0 || id.indexOf(ql) >= 0) out.push(item('Views', v.title, '', v.icon, function () { R.go('#' + id); }));
      });
      (saved || []).forEach(function (r) {
        var v = r.value || {}, name = v.name || v.q || r.id;
        if (!ql || String(name).toLowerCase().indexOf(ql) >= 0) out.push(item('Saved searches', name, v.q || '', 'save', function () { R.go(v.hash || { view: 'suche', arg: v.q || '' }); }));
      });
      THEMES.forEach(function (t) { if (!ql || ('appearance ' + THEME_LABEL[t] + ' theme ' + t).indexOf(ql) >= 0) out.push(item('Appearance', 'Appearance: ' + THEME_LABEL[t], App.theme === t ? 'active' : '', THEME_ICO[t], function () { App.setTheme(t); })); });
      if (!ql || 'keyboard shortcuts help'.indexOf(ql) >= 0) out.push(item('Help', 'Keyboard shortcuts', '?', 'help', function () { setTimeout(App.shortcuts, 0); }));
      items = out; sel = 0; draw();
      if (q && g.LnpData && q.replace(/\D/g, '').length >= 5) {
        g.LnpData.byPn(q).then(function (p) { return p >= 0 ? g.LnpData.patent(p) : null; }).then(function (pt) {
          if (!pt || my !== seq) return;
          items.unshift(item('Patent', U.pnPretty(pt.pn), pt.title, 'ext', function () { App.openPatent(pt.pn, { q: '' }); }));
          sel = 0; draw();
        }, function () { });
      }
    }
    function draw() {
      U.clear(list);
      var grp = null;
      items.forEach(function (it, i) {
        if (it.group !== grp) { grp = it.group; list.appendChild(h('div.pal-group.overline', { text: grp })); }
        var el = h('div.pal-item', { role: 'option', id: 'pal-i' + i, 'aria-selected': i === sel ? 'true' : 'false', onclick: function () { exec(i); }, onmousemove: function () { if (sel !== i) { sel = i; mark(); } } },
          U.icon(it.icon || 'dot'), h('span.t', { text: it.title }), it.sub ? h('span.s', { text: it.sub }) : null);
        list.appendChild(el);
      });
      if (!items.length) list.appendChild(h('div.pal-group.faint', { text: 'Nothing found' }));
      input.setAttribute('aria-activedescendant', items.length ? 'pal-i' + sel : '');
    }
    function mark() {
      var els = list.querySelectorAll('.pal-item');
      for (var i = 0; i < els.length; i++) els[i].setAttribute('aria-selected', i === sel ? 'true' : 'false');
      if (els[sel] && els[sel].scrollIntoView) els[sel].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', 'pal-i' + sel);
    }
    function exec(i) { var it = items[i]; if (!it) return; dlg.close(); try { it.run(); } catch (e) { logError('palette', e); } }
    input.addEventListener('input', U.debounce(build, 70));
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); exec(sel); }
    });
    if (preset) input.value = preset;
    build();
    input.focus();
  };
  App.shortcuts = function () {
    var rows = [['Ctrl / ⌘ + K', 'Commands: patent number, search, view'], ['/', 'Search box'], ['j  k', 'next / previous result'], ['↵', 'Open result'], ['x', 'Select result'], ['s', 'Add result to watchlist'], ['Esc', 'Close dialog'], ['?', 'This overview']];
    var t = h('table.data');
    rows.forEach(function (r) { t.appendChild(h('tr', null, h('td.mono', { text: r[0] }), h('td', { text: r[1] }))); });
    U.dialog('Keyboard shortcuts', h('div.table-wrap', null, t));
  };
  function typing(ev) {
    var t = ev.target, n = t && t.nodeName;
    return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || (t && t.isContentEditable);
  }
  function onKey(ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); if (App.booted) App.palette(); return; }
    if (!App.booted || ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev) || document.querySelector('.scrim')) return;
    if (ev.key === '/') {
      ev.preventDefault();
      var q = document.getElementById('q');
      if (q) { q.focus(); q.select(); } else { R.go('#suche'); setTimeout(function () { var q2 = document.getElementById('q'); if (q2) q2.focus(); }, 60); }
    } else if (ev.key === '?') { ev.preventDefault(); App.shortcuts(); }
    else App.emit('key', ev);
  }

  /* ------------------------------------------------------------ boot */
  function boot() {
    bootDraw(); delete App.timings.failed;
    var D = g.LnpData, S = g.LnpSearch, St = g.LnpStore;
    if (!D || !S || !St) { bootFail('data', { code: 'script', message: 'The scripts under engine/ were not loaded (LnpData, LnpSearch or LnpStore is missing).' }); return; }
    try { D.onProgress(onLoadProgress); S.onProgress(onLoadProgress); } catch (e) { /* progress is optional */ }
    bootStep('data', 'run'); bootStep('store', 'run');
    // the store does not depend on the data files: it starts at once, so a failed boot can still leave its diagnosis
    var storeP = St.init().then(function (r) { App.store = r; App.timings.store = now(); bootStep('store', 'ok', { db: 'Artifact database', local: 'Browser storage', memory: 'this session only' }[r.backend]); return loadMarks(); },
      function (e) { App.store = { backend: 'memory' }; bootStep('store', 'ok', 'this session only'); logError('store', e); });
    D.init('data/').then(function (M) {
      App.manifest = M; App.seed = D.seed; App.timings.data = now();
      bootStep('data', 'ok', U.num(M.counts.patents) + ' patents, as of ' + U.date((M.built || '').slice(0, 10)));
      drawBand();
      bootStep('meta', 'run'); bootStep('index', 'run');
      var metaP = D.meta().then(function (m) { App.timings.meta = now(); bootStep('meta', 'ok', U.num(m.P) + ' rows'); }, function (e) { e = e || {}; e.step = 'meta'; throw e; });
      var idxP = S.init().then(function (info) {
        App.timings.index = now();
        engineDiag.search = { mode: info.mode, gzip: info.gzip, enc: info.enc, ms: info.ms, D: info.D, P: info.P, tried: info.tried };
        bootStep('index', 'ok', U.num(info.claims || info.D) + ' claims, ' + (info.mode === 'main' ? 'main thread' : info.mode === 'blob' ? 'blob worker' : 'worker'));
      }, function (e) { e = e || {}; e.step = 'index'; throw e; });
      return Promise.all([metaP, idxP, storeP]);
    }).then(function () {
      try { Promise.resolve(g.LnpData.diag()).then(function (d) { engineDiag.data = slim(d); }, function () { }); } catch (e) { /* ignore */ }
      bootStep('views', 'run');
      return loadExtras();
    }).then(function (loaded) {
      // engine/ai.js resolves the sample capability itself; the views hear about it through the "caps" event
      try { if (g.LnpAI && typeof g.LnpAI.init === 'function') Promise.resolve(g.LnpAI.init()).then(function () { App.emit('caps', 'ai'); writeDiagSoon(); }, function () { }); } catch (e) { logError('ai init', e); }
      App.timings.views = now();
      bootStep('views', 'ok', Object.keys(App.views).length + ' views');
      App.booted = true; App.timings.ready = now();
      document.getElementById('app').dataset.state = 'ready';
      R.onChange(function (r) { show(r); });
      R.start();
      writeDiagSoon();
      App.emit('ready', App);
    }).catch(function (e) {
      if (App.booted) { logError('boot late', e); return; }
      bootFail((e && e.step) || (App.manifest ? 'views' : 'data'), e);
    });
  }

  function start() {
    var saved = lsGet('lnp.theme');
    App.setTheme(saved || 'auto', true);
    var tb = document.getElementById('theme-btn');
    if (tb) tb.addEventListener('click', function () { App.setTheme(THEMES[(THEMES.indexOf(App.theme) + 1) % THEMES.length]); });
    var jump = document.getElementById('jump');
    if (jump) jump.addEventListener('click', function () { if (App.booted) App.palette(); });
    var kbd = document.getElementById('jump-kbd');
    if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) kbd.textContent = '⌘ K';
    document.addEventListener('keydown', onKey);
    startCaps();
    boot();
  }

  g.LnpApp = App;
  start();
})(window);
