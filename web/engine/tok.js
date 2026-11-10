/* LNP-FTO shared tokenizer. The offline index build (pipeline/build_index.mjs) and the browser engines MUST use this
   exact file: NFKD, combining marks removed, lower case, sharp s -> ss, tokens = [a-z0-9]+.
   Stop words are not indexed but still consume a position, so phrases across stop words keep working.
   Tokens longer than 40 characters are dropped (they also consume a position).
   Works in Node (require), in a window and in a Worker (global LnpTok). ASCII only. */
(function (g) {
  var STOP = new Set(('the of a an and or to in is are be for with by on as at which that said wherein from it its this ' +
    'der die das und oder ein eine einer eines einem einen nach mit von zu in ist sind fur bei auf als den dem des wobei dass sich wird werden im zur zum').split(' '));
  function fold(s) { return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss'); }
  // -> flat array [term, position, term, position, ...]; stop words consume a position but are not emitted
  function tokenize(text, keepStop) {
    var out = [], re = /[a-z0-9]+/g, f = fold(text), m, pos = 0;
    while ((m = re.exec(f))) { var t = m[0]; if (t.length <= 40 && (keepStop || !STOP.has(t))) out.push(t, pos); pos++; }
    return out;
  }
  // Number of token positions of a text (= BM25 length basis is the number of emitted tokens, see build_index.mjs).
  // spans(text) -> flat array [term, position, start, end, ...] with character offsets into the ORIGINAL text.
  // Stop words and over-long tokens are included (callers skip them); positions equal those of tokenize().
  function spans(text) {
    var f = '', map = [], i = 0, n = text.length;
    while (i < n) {
      var c = text.charCodeAt(i), len = (c >= 0xd800 && c < 0xdc00 && i + 1 < n) ? 2 : 1;
      var piece = c < 128 ? (c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text.charAt(i)) : fold(text.substr(i, len));
      for (var k = 0; k < piece.length; k++) { f += piece.charAt(k); map.push(i); }
      i += len;
    }
    map.push(n);
    var out = [], re = /[a-z0-9]+/g, m, pos = 0;
    while ((m = re.exec(f))) {
      var s = map[m.index], last = map[m.index + m[0].length - 1], e = last + 1;
      if (e < n) { var cl = text.charCodeAt(last); if (cl >= 0xd800 && cl < 0xdc00) e++; }
      // swallow combining marks that follow the last character of the token
      while (e < n) { var cc = text.charCodeAt(e); if (cc >= 0x300 && cc <= 0x36f) e++; else break; }
      out.push(m[0], pos, s, e); pos++;
    }
    return out;
  }
  // ---- publication numbers -------------------------------------------------------------------------------------
  // pn(input) -> {cc, num, kind, bases: [candidate "CC+number" strings], full: [candidates with kind]} | null
  // Tolerant of blanks, commas, dots, slashes, dashes and a missing kind code or country:
  // "EP 3 532 103 B1", "US 8,058,069", "US 2017/0210697 A1", "WO2017/075531", "WO 17/075531", "EP1765289", "8058069".
  function pn(input) {
    var s = String(input == null ? '' : input).toUpperCase().replace(/[\s,. '_]/g, '');
    if (!s) return null;
    var m = /^([A-Z]{2})?[-\/]?(RE|PP|D|H|T)?[-\/]?(\d[\d\/-]*\d|\d)[-\/]?([A-Z]\d?)?$/.exec(s);
    if (!m) return null;
    var cc = m[1] || '', pre = m[2] || '', raw = m[3], kind = m[4] || '', digits = raw.replace(/[\/-]/g, ''), bases = [];
    function add(c, n) { var b = c + n; if (bases.indexOf(b) < 0) bases.push(b); }
    function forCc(c) {
      if (c === 'WO') {
        var sl = /^(\d{2}|\d{4})[\/-](\d{1,6})$/.exec(raw), y, ser;
        if (sl) { y = sl[1]; ser = sl[2]; }
        else if (digits.length >= 9 && /^(19|20)/.test(digits)) { y = digits.slice(0, 4); ser = digits.slice(4); }
        else if (digits.length >= 6) { y = digits.slice(0, 2); ser = digits.slice(2); }
        if (y) {
          if (y.length === 2) y = (+y >= 78 ? '19' : '20') + y;
          while (ser.length < 6) ser = '0' + ser;
          if (ser.length > 6 && /^0+/.test(ser)) ser = ser.replace(/^0+/, '').padStart(6, '0');
          add('WO', y + ser);
        }
        add('WO', digits);
      } else if (c === 'EP') {
        var d = digits.replace(/^0+/, ''); while (d.length < 7) d = '0' + d; add('EP', d); add('EP', digits);
      } else if (c === 'US') {
        if (pre) add('US', pre + digits.replace(/^0+/, ''));
        else {
          add('US', digits);
          if (digits.length === 10 && /^(19|20)\d\d/.test(digits)) add('US', digits.slice(0, 4) + '0' + digits.slice(4));  // 2017/123456 -> 20170123456
          if (/^0/.test(digits)) add('US', digits.replace(/^0+/, ''));
        }
      } else add(c, pre + digits);
    }
    if (cc) forCc(cc); else { forCc('EP'); forCc('US'); if (digits.length >= 9) forCc('WO'); }
    var full = []; if (kind) for (var i = 0; i < bases.length; i++) full.push(bases[i] + kind);
    return { cc: cc, num: pre + digits, kind: kind, bases: bases, full: full };
  }
  // base of a canonical publication number: "EP3532103B1" -> "EP3532103"
  function pnBase(canon) { var m = /^([A-Z]{2}(?:RE|PP|D|H|T)?\d+)([A-Z]\d?)?$/.exec(canon); return m ? m[1] : canon; }
  var api = { STOP: STOP, fold: fold, tokenize: tokenize, spans: spans, pn: pn, pnBase: pnBase, MAXLEN: 40, VERSION: 1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpTok = api;
})(typeof self !== 'undefined' ? self : globalThis);
