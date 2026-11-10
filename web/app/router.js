/* LNP Patent Desk: hash router (global LnpRouter). Classic script.
   The Artifact host only carries a plain "#name" of letters, digits and hyphens between the page and its link,
   so every state is written in that alphabet:
     #<view>[-<arg>][--<k><value>]...        view: letters only; <k>: one lower-case letter
   Values: [A-Za-z0-9] as they are, every other byte of the UTF-8 text as "-hh" (hex), list items joined by "-x".
   "--" separates the parts (it cannot occur inside a value). Examples:
     #suche-lipid-20nanoparticle--aEP-xUS--sdate      #patent-EP3532103B1--c12--lde      #familie-EP3532103B1
   An <arg> that starts with an escaped character is written as the part "--A<arg>" (upper-case A is reserved). */
(function (g) {
  'use strict';
  var enc8 = new TextEncoder(), dec8 = new TextDecoder();
  function enc(s) {
    var b = enc8.encode(String(s)), out = '';
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += String.fromCharCode(c);
      else out += '-' + (c < 16 ? '0' : '') + c.toString(16);
    }
    return out;
  }
  function dec(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 45) { var v = parseInt(s.substr(i + 1, 2), 16); if (!isNaN(v)) out.push(v); i += 2; }
      else out.push(c & 255);
    }
    try { return dec8.decode(new Uint8Array(out)); } catch (e) { return ''; }
  }
  function encVal(v) { return Array.isArray(v) ? v.map(enc).join('-x') : enc(v); }
  function decVal(s) { return s.indexOf('-x') >= 0 ? s.split('-x').map(dec) : dec(s); }

  // route = {view, arg, params: {k: string | string[]}}
  function build(r) {
    var s = '#' + (r.view || 'suche');
    // an argument whose first character needs escaping would put "--" right after the view name (the part
    // separator), so it travels as the reserved part "--A<arg>" instead: #suche--A-22lipid-20nanoparticle-22
    if (r.arg != null && r.arg !== '') { var ea = enc(r.arg); s += ea.charAt(0) === '-' ? '--A' + ea : '-' + ea; }
    var p = r.params || {}, ks = Object.keys(p).sort();
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i], v = p[k];
      if (!/^[a-z]$/.test(k) || v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      s += '--' + k + encVal(v);
    }
    return s;
  }
  function parse(hash) {
    var s = String(hash || '').replace(/^#/, ''), parts = s.split('--'), head = parts[0] || '';
    var m = /^([A-Za-z]+)(?:-(.*))?$/.exec(head), r = { view: m ? m[1].toLowerCase() : '', arg: m && m[2] != null ? dec(m[2]) : '', params: {} };
    for (var i = 1; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (parts[i].charAt(0) === 'A') r.arg = dec(parts[i].slice(1));
      else r.params[parts[i].charAt(0)] = decVal(parts[i].slice(1));
    }
    return r;
  }
  function list(v) { return v == null || v === '' ? [] : Array.isArray(v) ? v : [v]; }

  var listeners = [], last = null;
  function current() { return parse(location.hash); }
  function fire() {
    var h = location.hash;
    if (h === last) return;
    last = h;
    var r = parse(h);
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](r); } catch (e) { if (g.console) console.error(e); } }
  }
  // go(route | hash, {replace, silent}): silent = the caller has already rendered that state
  function go(r, o) {
    o = o || {};
    var h = typeof r === 'string' ? (r.charAt(0) === '#' ? r : '#' + r) : build(r);
    if (h === location.hash) { if (!o.silent) { last = null; fire(); } return h; }
    if (o.silent) last = h;
    if (o.replace) {
      try { history.replaceState(history.state, '', h); if (!o.silent) fire(); return h; } catch (e) { /* fall through to location.hash */ }
    }
    location.hash = h;          // fires hashchange -> fire(); a silent change is swallowed by the "last" check
    return h;
  }
  function onChange(fn) { listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  function start() { window.addEventListener('hashchange', fire); last = null; fire(); }

  g.LnpRouter = { enc: enc, dec: dec, build: build, parse: parse, list: list, current: current, go: go, onChange: onChange, start: start };
})(window);
