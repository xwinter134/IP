/* LNP Patent Desk: shared UI helpers (global LnpUI). Classic script, no dependencies.
   Rule of the house: corpus text is untrusted. Everything goes through textContent / createTextNode;
   nothing in this file or in the views assigns innerHTML. */
(function (g) {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------ DOM builder */
  // h('div.a.b', {attrs}, child, [children], 'text')  -> element. Strings become text nodes.
  function h(sel, attrs) {
    var parts = String(sel).split('.'), el = document.createElement(parts[0] || 'div'), i;
    if (parts.length > 1) el.className = parts.slice(1).join(' ');
    var start = 1;
    if (attrs && typeof attrs === 'object' && !attrs.nodeType && !Array.isArray(attrs)) {
      start = 2;
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'data') { for (var d in v) if (v[d] != null) el.dataset[d] = v[d]; }
        else if (k === 'style') { for (var s in v) el.style.setProperty(s, v[s]); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open' || k === 'selected' || k === 'indeterminate') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (i = start; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return el;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); return el; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function set(el) { clear(el); for (var i = 1; i < arguments.length; i++) add(el, arguments[i]); return el; }

  /* ------------------------------------------------------------ icons (own path data, 20 x 20) */
  var ICONS = {
    search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zM13.5 13.5 17 17',
    structure: 'M10 2.5 16.5 6.25v7.5L10 17.5 3.5 13.75v-7.5zM10 6.5v7M7 8.2l6 3.6',
    product: 'M7.5 3h5M8.5 3v4.2L4.3 14.6A1.6 1.6 0 0 0 5.7 17h8.6a1.6 1.6 0 0 0 1.4-2.4L11.5 7.2V3M6.4 12h7.2',
    fto: 'M10 2.5 16 5v4.6c0 3.6-2.4 6.6-6 7.9-3.6-1.3-6-4.3-6-7.9V5zM7.2 10l2 2 3.6-4',
    landscape: 'M3 17V3M3 17h14M6.5 13.5v-3M10 13.5V6.5M13.5 13.5v-5',
    star: 'M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z',
    system: 'M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
    sun: 'M10 13.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7 6 6M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3',
    moon: 'M16.5 11.6A7 7 0 0 1 8.4 3.5a7 7 0 1 0 8.1 8.1z',
    auto: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 3v14M10 6.5l4.5 4.5M10 10.5l3 3',
    copy: 'M7 7V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0 1 13 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15.5v-7A1.5 1.5 0 0 1 4.5 7z',
    link: 'M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1',
    ext: 'M11 3h6v6M17 3l-8 8M14 11.5v4A1.5 1.5 0 0 1 12.5 17h-8A1.5 1.5 0 0 1 3 15.5v-8A1.5 1.5 0 0 1 4.5 6h4',
    download: 'M10 3v10M6 9.5l4 4 4-4M3.5 16.5h13',
    save: 'M5 3h8l4 4v8.5A1.5 1.5 0 0 1 15.500 17h-11A1.5 1.5 0 0 1 3 15.500v-11A1.5 1.5 0 0 1 4.500 3zM6.500 3v4.500h6V3M6.500 17v-5.500h7V17',
    filter: 'M3 5h14M6 10h8M8.5 15h3',
    help: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM7.8 8a2.3 2.3 0 1 1 3.300 2.100c-.7.4-1.100.9-1.100 1.700M10 14.200v.1',
    x: 'M5 5l10 10M15 5 5 15',
    back: 'M11.5 4.500 6 10l5.500 5.500',
    rows: 'M3 5h14M3 10h14M3 15h14',
    rowsDense: 'M3 4h14M3 8h14M3 12h14M3 16h14',
    spark: 'M10 2.500l1.600 4.400 4.400 1.600-4.400 1.600L10 14.500 8.400 10.100 4 8.500l4.400-1.600zM15.500 13.500l.700 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7z',
    family: 'M10 3.500v5M10 8.500H5v3.500M10 8.500h5v3.500M3 12h4v4.500H3zM13 12h4v4.500h-4zM8 1.500h4v3H8z',
    check: 'M4 10.500l4 4 8-9',
    more: 'M4.500 10h.1M10 10h.1M15.500 10h.1',
    dot: 'M10 10h.01'
  };
  function icon(name, cls) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name] || ICONS.dot); s.appendChild(p);
    return s;
  }

  /* ------------------------------------------------------------ formatting */
  var nf = (function () { try { return new Intl.NumberFormat('en-GB'); } catch (e) { return { format: String }; } })();
  function num(n) { return n == null || isNaN(n) ? '–' : nf.format(n); }
  // yyyymmdd int | "yyyy-mm-dd" -> "26 Oct 2037"
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function date(d) {
    if (!d) return '–';
    var s = String(d).replace(/-/g, '');
    if (!/^\d{8}/.test(s)) return String(d);
    var mo = +s.slice(4, 6);
    if (mo < 1 || mo > 12) return String(d);
    return (+s.slice(6, 8)) + ' ' + MONTHS[mo - 1] + ' ' + s.slice(0, 4);
  }
  function year(d) { return d ? String(d).replace(/-/g, '').slice(0, 4) : ''; }
  function ymd(d) { return d ? Number(String(d).replace(/-/g, '').slice(0, 8)) : 0; }
  function today() { var t = new Date(); return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate(); }
  function bytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' kB' : (n || 0) + ' B'; }
  function pnPretty(pn) {
    var m = /^([A-Z]{2})(\d{4})?(\d+)([A-Z]\d?)?$/.exec(pn || '');
    if (!m) return pn || '';
    var cc = m[1], n = (m[2] || '') + m[3];
    if (cc === 'EP') n = n.replace(/^(\d)(\d{3})(\d{3})$/, '$1 $2 $3');
    else if (cc === 'WO') n = n.replace(/^(\d{4})(\d+)$/, '$1/$2');
    else if (cc === 'US' && n.length >= 11) n = n.replace(/^(\d{4})(\d+)$/, '$1/$2');
    else if (cc === 'US') n = n.replace(/\B(?=(\d{3})+$)/g, ',');
    return cc + ' ' + n + (m[4] ? ' ' + m[4] : '');
  }
  var STATUS = {
    granted: ['Granted', 'good'], pending: ['Pending', 'info'], lapsed: ['Lapsed', ''], revoked: ['Revoked', 'crit'],
    withdrawn: ['Withdrawn', ''], refused: ['Refused', 'crit'], expired: ['Expired', ''], unknown: ['Status open', 'hollow'], '': ['No legal status', 'hollow']
  };
  function statusLabel(code) { return (STATUS[code || ''] || STATUS['']) [0]; }
  function statusPill(code) { var s = STATUS[code || ''] || STATUS['']; return h('span.pill' + (s[1] ? '.' + s[1] : ''), { title: 'Legal status as per the dataset; not legal advice' }, s[0]); }
  function dePill(deIn) {
    return deIn === 1 ? h('span.pill.good', { title: 'EP Register: DE designated, not recorded as lapsed' }, 'DE in force')
      : deIn === 0 ? h('span.pill', { title: 'Not in force in DE according to the dataset' }, 'DE not in force') : null;
  }

  /* ------------------------------------------------------------ highlight pieces [[text, isMatch], ...] -> nodes */
  function pieces(el, ps) {
    for (var i = 0; i < (ps || []).length; i++) {
      var t = ps[i][0];
      if (!t) continue;
      if (ps[i][1]) el.appendChild(h('mark.hit', { text: t })); else el.appendChild(document.createTextNode(t));
    }
    return el;
  }

  /* ------------------------------------------------------------ timing helpers */
  function debounce(fn, ms) {
    var t = null;
    function d() { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { t = null; fn.apply(self, a); }, ms); }
    d.cancel = function () { clearTimeout(t); t = null; };
    d.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return d;
  }

  /* ------------------------------------------------------------ toasts */
  function toast(msg, o) {
    o = o || {};
    var box = document.getElementById('toasts');
    if (!box) return { close: function () { } };
    var el = h('div.toast' + (o.error ? '.err' : ''), null, h('span', { text: msg }));
    if (o.action) el.appendChild(h('button', { type: 'button', onclick: function () { try { o.action.run(); } finally { close(); } } }, o.action.label));
    if (o.node) el.appendChild(o.node);
    box.appendChild(el);
    var timer = setTimeout(close, o.ms || (o.error ? 7000 : 3600));
    function close() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
    return { close: close, el: el, update: function (m) { el.firstChild.textContent = m; } };
  }
  function errText(e) { return (e && (e.message || e.code)) ? String(e.message || e.code) : String(e); }

  /* ------------------------------------------------------------ popover and dialog */
  var openPop = null;
  function closePop() { if (openPop) { var p = openPop; openPop = null; p.close(); } }
  function popover(anchor, content, o) {
    o = o || {};
    if (openPop && openPop.anchor === anchor) { closePop(); return null; }
    closePop();
    var el = h('div.pop', { role: o.role || 'dialog' }, content);
    document.getElementById('overlays').appendChild(el);
    var r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(12, Math.min(o.align === 'right' ? r.right - w : r.left, vw - w - 12));
    var top = r.bottom + 6; if (top + hh > vh - 12) top = Math.max(12, r.top - hh - 6);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    function onDoc(ev) { if (!el.contains(ev.target) && !anchor.contains(ev.target)) closePop(); }
    function onKey(ev) { if (ev.key === 'Escape') { closePop(); try { anchor.focus(); } catch (e) { /* ignore */ } } }
    setTimeout(function () { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    var me = { anchor: anchor, el: el, close: function () { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); if (el.parentNode) el.parentNode.removeChild(el); if (openPop === me) openPop = null; if (o.onClose) o.onClose(); } };
    openPop = me;
    return me;
  }
  function dialog(title, body, o) {
    o = o || {};
    var prev = document.activeElement;
    var closeBtn = h('button.btn.quiet.icon.sm', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'));
    var dlg = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      o.bare ? null : h('div.dialog-head', null, h('h2', { text: title }), closeBtn), o.bare ? body : h('div.dialog-body', null, body));
    var scrim = h('div.scrim', { onmousedown: function (ev) { if (ev.target === scrim) close(); } }, dlg);
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
      else if (ev.key === 'Tab') {                      // keep the focus inside
        var f = dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    scrim.addEventListener('keydown', onKey);
    document.getElementById('overlays').appendChild(scrim);
    var foc = dlg.querySelector('input, textarea, select') || closeBtn; try { foc.focus(); } catch (e) { /* ignore */ }
    function close() { if (!scrim.parentNode) return; scrim.parentNode.removeChild(scrim); if (o.onClose) o.onClose(); try { if (prev && prev.focus) prev.focus(); } catch (e) { /* ignore */ } }
    return { close: close, el: dlg };
  }

  /* ------------------------------------------------------------ clipboard, files */
  function copy(text, okMsg) {
    function fallback() {
      var ta = h('textarea', { style: { position: 'fixed', left: '-999px', top: '0' } }); ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? (okMsg || 'Copied') : 'Copying is not supported here', { error: !ok });
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg || 'Copied'); }, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }
  // Save a generated file: downloads capability when granted, else a Blob link (works outside the viewer frame).
  function saveFile(filename, data, mime) {
    var caps = (g.LnpApp && g.LnpApp.caps) || {};
    function viaLink() {
      try {
        var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: filename }, 'Open file');
        toast(filename + ' created', { node: a, ms: 15000 });
        var c = h('a', { href: url, download: filename, style: { display: 'none' } }); document.body.appendChild(c); c.click(); document.body.removeChild(c);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return Promise.resolve({ via: 'link' });
      } catch (e) { toast('Could not create the file: ' + errText(e), { error: true }); return Promise.resolve({ via: 'none' }); }
    }
    if (!caps.downloads) return viaLink();
    return caps.downloads.save({ filename: filename, data: data }).then(function () { toast(filename + ' saved'); return { via: 'downloads' }; }, function (e) {
      var code = e && e.code;
      if (code === 'declined') { toast('Save cancelled'); return { via: 'declined' }; }
      if (code === 'rate_limited') { toast('A save dialog is still open. Please try again in a moment.', { error: true }); return { via: 'none' }; }
      if (code === 'rejected_extension' || code === 'extension_not_enabled' || code === 'too_large' || code === 'bad_request') { toast('Cannot save: ' + errText(e), { error: true }); return { via: 'none' }; }
      return viaLink();
    });
  }
  function csv(rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (c) {
        c = c == null ? '' : String(c);
        if (/^[=+\-@\t\r]/.test(c)) c = "'" + c;          // no formula injection from patent text
        return /[";\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(';');
    }).join('\r\n');
  }

  /* ------------------------------------------------------------ SVG from an engine string, sanitised */
  // LnpChem.svg returns markup generated by OpenChemLib. It is parsed as XML (never as HTML), scripts, foreign
  // content, event attributes and external references are dropped, and the nodes are imported.
  var SVG_OK = { svg: 1, g: 1, path: 1, line: 1, polyline: 1, polygon: 1, rect: 1, circle: 1, ellipse: 1, text: 1, tspan: 1, title: 1, defs: 1 };
  function svgNode(str) {
    try {
      var doc = new DOMParser().parseFromString(String(str), 'image/svg+xml'), root = doc.documentElement;
      if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
      (function walk(n) {
        for (var i = n.childNodes.length - 1; i >= 0; i--) {
          var c = n.childNodes[i];
          if (c.nodeType === 1) {
            if (!SVG_OK[c.localName]) { n.removeChild(c); continue; }
            for (var j = c.attributes.length - 1; j >= 0; j--) {
              var a = c.attributes[j], nm = a.name.toLowerCase();
              if (nm.slice(0, 2) === 'on' || nm === 'href' || nm === 'xlink:href' || nm === 'style' && /url\s*\(/i.test(a.value)) c.removeAttribute(a.name);
            }
            walk(c);
          } else if (c.nodeType !== 3) n.removeChild(c);
        }
      })(root);
      for (var k = root.attributes.length - 1; k >= 0; k--) if (root.attributes[k].name.toLowerCase().slice(0, 2) === 'on') root.removeAttribute(root.attributes[k].name);
      return document.importNode(root, true);
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ word diff (LCS) */
  function words(t) { return String(t || '').match(/\s+|[^\s]+/g) || []; }
  // -> {a: [[text, changed]], b: [[text, changed]], same: share of words of the longer side that match}
  function diffWords(ta, tb) {
    var A = words(ta).filter(function (w) { return /\S/.test(w); }), B = words(tb).filter(function (w) { return /\S/.test(w); });
    var n = A.length, m = B.length, i, j;
    if (n * m > 6e6) return { a: [[ta, false]], b: [[tb, false]], same: null, tooLarge: true };
    var key = function (w) { return w.replace(/^[("'\[]+|[.,;:)"'\]]+$/g, '').toLowerCase(); };
    var ka = A.map(key), kb = B.map(key), W = m + 1, L = new Uint16Array((n + 1) * W);
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i * W + j] = ka[i] === kb[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    var oa = [], ob = [];
    function push(o, t, ch) { var l = o[o.length - 1]; if (l && l[1] === ch) l[0] += ' ' + t; else o.push([t, ch]); }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { push(oa, A[i++], false); push(ob, B[j++], false); }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push(oa, A[i++], true);
      else push(ob, B[j++], true);
    }
    while (i < n) push(oa, A[i++], true);
    while (j < m) push(ob, B[j++], true);
    return { a: oa, b: ob, same: Math.max(n, m) ? L[0] / Math.max(n, m) : 1 };
  }
  function diffNodes(el, ps, tag) {
    for (var i = 0; i < ps.length; i++) {
      if (i) el.appendChild(document.createTextNode(' '));
      if (ps[i][1]) el.appendChild(h(tag, { text: ps[i][0] })); else el.appendChild(document.createTextNode(ps[i][0]));
    }
    return el;
  }

  g.LnpUI = {
    h: h, add: add, clear: clear, set: set, icon: icon, ICONS: ICONS,
    num: num, date: date, year: year, ymd: ymd, today: today, bytes: bytes, pnPretty: pnPretty,
    statusPill: statusPill, statusLabel: statusLabel, dePill: dePill, pieces: pieces,
    debounce: debounce, toast: toast, errText: errText, popover: popover, closePopover: closePop, dialog: dialog,
    copy: copy, saveFile: saveFile, csv: csv, svgNode: svgNode, diffWords: diffWords, diffNodes: diffNodes
  };
})(window);
