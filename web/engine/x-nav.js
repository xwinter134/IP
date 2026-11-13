/* LNP Patent Desk: navigation bar (extension). Back / forward arrows and a breadcrumb trail above the work area.
   Needs LnpApp, LnpRouter and LnpUI (loaded before engine/x-*.js). Styles: app/x-nav.css. No capability, no data.
   History: the router writes every state into location.hash, so the browser history is the app history. The History API does
   not say where the current entry sits, so this file keeps its own list of the entries it has seen (each is marked in
   history.state, which survives replaceState) and derives the position from that; back and forward call
   history.back() / history.forward(). The buttons are disabled at the ends of that list (a page that was open before this
   one loaded is not part of the list).
   Crumbs: [parent chain from the registered views (view.parent)] + [view title] + [item]. The item comes from, in order:
     1. the view option  crumb(route, view)                       (registerView({..., crumb: function (route) { return 'label'; }}))
     2. LnpApp.ext.crumb(fn(route, view))                         hooks of other extensions; first non-null answer wins
     3. built-in rules: patent number in the route (arg or param n, plus "claim N"), search text, How to topic title.
   A hook returns a string, {label, href?}, an array of those (several crumbs), false (no item) or null/undefined (ask the next).
   Labels are inserted with textContent only; patent text is never HTML. */
(function (g) {
  'use strict';
  var App = g.LnpApp, R = g.LnpRouter, U = g.LnpUI;
  if (!App || !R || !U || App.nav) return;
  var h = U.h, doc = g.document;

  // arrow icons (own path data, 20 x 20); "back" exists in the shell, "forward" is added here
  if (U.ICONS && !U.ICONS.forward) U.ICONS.forward = 'M8.500 4.500 14 10l-5.500 5.500';
  if (U.ICONS && !U.ICONS.back) U.ICONS.back = 'M11.500 4.500 6 10l5.500 5.500';

  /* ------------------------------------------------------------ history position */
  var SES = Math.random().toString(36).slice(2, 8), seq = 0, entries = [], idx = -1, markOk = true;
  function hashNow() { return g.location.hash || ''; }
  function readMark() { try { var s = g.history.state, m = s && s.lnpNav; return m && m.s === SES ? m.i : null; } catch (e) { return null; } }
  function writeMark(i) {
    try {
      var s = g.history.state; s = s && typeof s === 'object' ? Object.assign({}, s) : {};
      s.lnpNav = { s: SES, i: i }; g.history.replaceState(s, '', g.location.href); return true;
    } catch (e) { return false; }
  }
  function find(id) { for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return i; return -1; }
  function push(hash) {
    entries.length = idx + 1;
    var e = { id: ++seq, hash: hash }; entries.push(e); idx = entries.length - 1;
    if (!writeMark(e.id)) markOk = false;
  }
  // called after every hash change and after every router.go that changes the state without an event
  function sync() {
    var hh = hashNow(), m = readMark(), k;
    if (m != null && (k = find(m)) >= 0) { idx = k; entries[k].hash = hh; return; }       // a known entry (traversal or replace)
    if (idx >= 0 && !markOk) {                                                              // no marks possible: compare neighbours
      if (entries[idx].hash === hh) return;
      if (idx > 0 && entries[idx - 1].hash === hh) { idx--; return; }
      if (idx + 1 < entries.length && entries[idx + 1].hash === hh) { idx++; return; }
    }
    push(hh);
  }
  function canBack() { return idx > 0; }
  function canForward() { return idx >= 0 && idx < entries.length - 1; }
  function back() { if (canBack()) { try { g.history.back(); } catch (e) { App.logError('nav back', e); } } }
  function forward() { if (canForward()) { try { g.history.forward(); } catch (e) { App.logError('nav forward', e); } } }

  /* ------------------------------------------------------------ crumbs */
  var hooks = [];
  App.ext.crumb = function (fn) {
    if (typeof fn !== 'function') return function () { };
    hooks.push(fn);
    return function () { var i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); };
  };
  var PN = /^[A-Z]{2}\d{4,}[A-Z]?\d?$/;
  function safe(fn, route, v) { try { return fn(route, v); } catch (e) { App.logError('crumb hook', e); return null; } }
  function norm(x) {
    var a = Array.isArray(x) ? x : [x], out = [];
    a.forEach(function (c) {
      if (c == null || c === false || c === '') return;
      if (typeof c === 'object') { if (c.label != null && String(c.label)) out.push({ label: String(c.label), href: typeof c.href === 'string' && c.href.charAt(0) === '#' ? c.href : '' }); }
      else out.push({ label: String(c), href: '' });
    });
    return out;
  }
  function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function builtinItem(route, v) {
    var p = route.params || {}, arg = route.arg || '';
    if (v.id === 'suche' || v.id === 'struktur') return arg ? '“' + clip(arg, 80) + '”' : null;
    if (v.id === 'howto') {
      var D = g.LnpHowtoData, t = D && D.tutorials && arg ? D.tutorials.filter(function (x) { return x.id === arg; })[0] : null;
      return t ? (t.short || t.title || t.id) : null;
    }
    var pn = PN.test(arg) ? arg : (typeof p.n === 'string' && PN.test(p.n) ? p.n : '');
    if (!pn) return null;
    var c = typeof p.c === 'string' && /^\d{1,4}$/.test(p.c) ? p.c : '';
    return U.pnPretty(pn) + (c ? ' claim ' + c : '');
  }
  function itemCrumbs(route, v) {
    var r = typeof v.crumb === 'function' ? safe(v.crumb, route, v) : null;
    for (var i = 0; (r == null) && i < hooks.length; i++) r = safe(hooks[i], route, v);
    if (r === false) return [];
    if (r == null) r = builtinItem(route, v);
    return norm(r);
  }
  var SKIP_TITLE = { patent: 1 };                      // the item is the patent number itself
  function parentHref(id) { return id === 'suche' && App.state && App.state.lastQuery ? R.build({ view: 'suche', arg: App.state.lastQuery }) : '#' + id; }
  function trail(route) {
    var id = route.view || 'suche', v = App.views[id], out = [];
    if (!v) return [{ label: 'Not found', href: '' }];
    var chain = [], p = v.parent, guard = 0;
    while (p && App.views[p] && guard++ < 4) { chain.unshift(p); p = App.views[p].parent; }
    chain.forEach(function (pid) { out.push({ label: App.views[pid].title || pid, href: parentHref(pid) }); });
    var items = itemCrumbs(route, v);
    if (!(SKIP_TITLE[id] && items.length)) out.push({ label: v.title || id, href: '#' + id });
    return out.concat(items);
  }
  App.nav = { back: back, forward: forward, canBack: canBack, canForward: canForward, trail: trail, refresh: function () { render(); } };

  /* ------------------------------------------------------------ DOM */
  var bar, btnB, btnF, list, timers = [];
  function build() {
    var view = doc.getElementById('view'); if (!view || !view.parentNode || doc.getElementById('xnav')) return;
    var mac = /Mac|iPhone|iPad/.test(g.navigator.platform || g.navigator.userAgent || '');
    btnB = h('button.xnav-btn', { type: 'button', id: 'xnav-back', 'aria-label': 'Back', title: 'Back (' + (mac ? '⌘[' : 'Alt+←') + ')', 'aria-keyshortcuts': mac ? 'Meta+[' : 'Alt+ArrowLeft', onclick: back }, U.icon('back'));
    btnF = h('button.xnav-btn', { type: 'button', id: 'xnav-fwd', 'aria-label': 'Forward', title: 'Forward (' + (mac ? '⌘]' : 'Alt+→') + ')', 'aria-keyshortcuts': mac ? 'Meta+]' : 'Alt+ArrowRight', onclick: forward }, U.icon('forward'));
    list = h('ol.xnav-list');
    bar = h('div.xnav', { id: 'xnav' }, h('div.xnav-btns', null, btnB, btnF), h('nav.xnav-nav', { 'aria-label': 'Breadcrumb' }, list));
    view.parentNode.insertBefore(bar, view);
  }
  function render(route) {
    if (!bar) build();
    if (!bar) return;
    var r = route || R.current(), t = trail(r);
    U.clear(list);
    t.forEach(function (c, i) {
      var last = i === t.length - 1, full = c.label;
      var node = last || !c.href ? h('span.xnav-c', { title: full, 'aria-current': last ? 'page' : null, text: full }) : h('a.xnav-c', { href: c.href, title: full, text: full });
      list.appendChild(h('li', null, node));
    });
    btnB.disabled = !canBack(); btnF.disabled = !canForward();
    App.emit('nav', { route: r, trail: t, back: canBack(), forward: canForward() });
  }
  // a lazily loaded view (How to) may know its labels only a moment after the route change
  function later() { timers.forEach(clearTimeout); timers = [350, 1400].map(function (ms) { return setTimeout(function () { render(); }, ms); }); }
  function change(route) { sync(); render(route); later(); }

  /* ------------------------------------------------------------ keyboard */
  var MAC = /Mac|iPhone|iPad/.test(g.navigator.platform || g.navigator.userAgent || '');
  function typing(ev) { var t = ev.target, n = t && t.nodeName; return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || !!(t && t.isContentEditable); }
  function onKey(ev) {
    if (!App.booted || ev.defaultPrevented || ev.shiftKey) return;
    var dir = 0;
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey) dir = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
    else if (MAC && ev.metaKey && !ev.ctrlKey && !ev.altKey) dir = (ev.key === '[' || ev.code === 'BracketLeft') ? -1 : (ev.key === ']' || ev.code === 'BracketRight') ? 1 : 0;
    if (!dir || typing(ev) || doc.querySelector('.scrim')) return;       // text fields keep the arrows for word / caret movement
    ev.preventDefault();                                                  // also stops the browser from stepping back on its own
    if (dir < 0) back(); else forward();
  }

  /* ------------------------------------------------------------ wiring */
  sync();                                                                 // the entry this page was opened on
  g.addEventListener('hashchange', function () { change(); });
  R.onChange(function (r) { change(r); });
  var go0 = R.go;
  // router.go with replace / silent changes the address without an event: re-read the position and the crumbs
  R.go = function (r, o) { var out = go0.apply(R, arguments); if (o && (o.silent || o.replace)) { try { sync(); render(); } catch (e) { App.logError('nav go', e); } } return out; };
  doc.addEventListener('keydown', onKey);
  build(); render();
})(window);
