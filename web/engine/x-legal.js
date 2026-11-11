/* LNP Patent Desk: legal and prosecution timeline (global LnpLegal). Classic script, ASCII.
   Merges what the dataset holds about one publication and its family (LnpData.patent + LnpData.status of every member
   from LnpData.family) into one dated list. No model, no fetch.
     LnpLegal.timeline(p, opts)   -> Promise<[{date, kind, text, src, pn[], hot}]>   p = patent index or LnpData.patent object
        kind: filing | priority | publication | grant | opposition | appeal | fee | lapse | revocation | unitary | expiry_est | event
        date: 'YYYY-MM-DD' or null (facts the register states without a date, e.g. "appeal pending"; they sort last)
        src: where the entry comes from; pn: the family members it was found on; hot: true for opposition / appeal / revocation
        opts: {family: true (default), today}
     LnpLegal.summary(p, opts)    -> Promise<{opposed, outcome, appealed, lapsedIn[{cc, date}], lapsedCc[], asof, stale, unitary, code, hasStatus}>
        opts: {family: false (default: this publication only), today}; stale = snapshot older than 6 months
     LnpLegal.build(members, opts) -> sync core: members = [{P, st}] (P = patent object, st = status detail | null) -> timeline
     LnpLegal.summarise(P, st, opts) -> sync core of summary
     LnpLegal.limits() -> text lines for a limits box; LnpLegal.KINDS -> {kind: label}
   Limits: the register data is a snapshot (asof); later events and renewal fees due after it are not seen; the register
   event list holds the 12 newest events per application, so early events can be missing; this is not a file history. */
(function (g) {
  'use strict';
  var KINDS = { filing: 'Filing', priority: 'Priority', publication: 'Publication', grant: 'Grant', opposition: 'Opposition', appeal: 'Appeal', fee: 'Renewal fees', lapse: 'Lapse', revocation: 'Revocation', unitary: 'Unitary effect', expiry_est: 'Expiry (estimate)', event: 'Register event' };
  var HOT = { opposition: 1, appeal: 1, revocation: 1 };
  var OUTCOME = { maintained_amended: 'patent maintained as amended', revoked: 'patent revoked', rejected: 'opposition rejected', pending: 'proceedings pending' };
  var SRC = { 'ep-register': 'EP Register', 'ep-xml': 'EP patent document', 'us-calc': 'calculated from USPTO data', seed: 'key list (secondary source)', pct: 'PCT publication' };
  var DAY = 86400000;

  function iso(d) {                       // 20210415 | '2021-04-15' | '20210415' -> '2021-04-15' | null
    if (d == null || d === '' || d === 0) return null;
    var s = String(d);
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }
  function ms(d) { var t = Date.parse(d + 'T00:00:00Z'); return isNaN(t) ? null : t; }
  function today(o) { return (o && o.today) ? iso(o.today) : new Date().toISOString().slice(0, 10); }

  // register event text -> kind (the wording is the register's; unknown wording stays "event")
  function kindOf(text) {
    var t = String(text || '').toLowerCase();
    if (/^no (opposition|appeal)|intention to grant/.test(t)) return 'event';   // negative or preliminary wording is not the event itself
    if (/unitary/.test(t)) return 'unitary';
    if (/oppos/.test(t)) return 'opposition';
    if (/appeal/.test(t)) return 'appeal';
    if (/revo[ck]|revocation/.test(t)) return 'revocation';
    if (/maintained|limitation/.test(t)) return 'opposition';
    if (/lapse/.test(t)) return 'lapse';
    if (/renewal|fee/.test(t)) return 'fee';
    if (/unitary/.test(t)) return 'unitary';
    if (/grant/.test(t)) return 'grant';
    if (/publication|published/.test(t)) return 'publication';
    return 'event';
  }
  function srcOf(st) { return st ? (SRC[st.src] || st.src || 'register') + (st.asof ? ' (as of ' + st.asof + ')' : '') : 'dataset'; }

  // one timeline from the records of the members; identical entries on several members (A1/B1/B2 of one application
  // carry the same register events) are merged and list their numbers
  function build(members, opts) {
    var map = new Map(), order = 0;
    function add(date, kind, text, src, pn) {
      date = iso(date);
      var key = (date || '-') + '|' + kind + '|' + text, e = map.get(key);
      if (e) { if (pn && e.pn.indexOf(pn) < 0) e.pn.push(pn); return e; }
      e = { date: date, kind: kind, text: text, src: src, pn: pn ? [pn] : [], hot: !!HOT[kind], _o: order++ };
      map.set(key, e);
      return e;
    }
    (members || []).forEach(function (m) {
      var P = m && m.P, st = m && m.st; if (!P) return;
      var pn = P.pn, src = srcOf(st);
      if (iso(P.prio)) add(P.prio, 'priority', 'Earliest priority date', 'patent table', pn);
      if (iso(P.app) || (st && iso(st.filing))) add(P.app || st.filing, 'filing', 'Application filed' + (P.appNo ? ' (no. ' + P.appNo + ')' : ''), 'patent table', pn);
      if (iso(P.pub)) add(P.pub, 'publication', 'Published as ' + pn + (P.kind ? ' (kind code ' + P.kind + ')' : ''), 'patent table', pn);
      var grant = iso(P.grant) || (st && iso(st.grant));
      if (grant) add(grant, 'grant', 'Patent granted (publication of the grant)', st && st.grant ? src : 'patent table', pn);
      if (!st) return;
      var op = st.opposition;
      if (op && op.filed) {
        var who = (op.opponents || []).slice(0, 6).join('; ');
        // the register also lists a bare "Opposition filed" event (a few days later); with the first filing date known it is redundant
        add(op.date_first_filed, 'opposition', 'Opposition filed' + (who ? ' by ' + who + ((op.opponents || []).length > 6 ? ' and others' : '') : ''), src, pn);
        if (op.outcome && OUTCOME[op.outcome]) {
          // the dated outcome is usually one of the register events (B2 publication, revocation); this entry carries the wording
          var oe = (st.events || []).filter(function (e) { return kindOf(e.text) === 'opposition' && !/filed/i.test(e.text) || kindOf(e.text) === 'revocation'; })[0];
          add(oe ? oe.date : null, op.outcome === 'revoked' ? 'revocation' : 'opposition', 'Opposition outcome: ' + OUTCOME[op.outcome] + (op.note ? ' (' + op.note + ')' : ''), src, pn);
        } else if (op.note) add(null, 'opposition', 'Opposition: ' + op.note, src, pn);
      }
      var seenAp = {};
      (st.appeal_detail || []).forEach(function (a) {
        if (!a) return;
        var k = (a.num || '') + '|' + (a.result || '') + '|' + (a.result_date || ''); if (seenAp[k]) return; seenAp[k] = 1;
        var num = String(a.num || '').replace(/-\d+$/, '');
        add(a.result_date, 'appeal', 'Appeal ' + (num || '') + (a.result ? ': ' + String(a.result).toLowerCase() : ' pending (no decision date in the register data)'), src, pn);
      });
      if (st.appeal && !(st.appeal_detail || []).length) add(null, 'appeal', 'Appeal on record (no details in the register data)', src, pn);
      // lapses: one entry per date, the contracting states listed; the generic register lines are then redundant
      var byDate = {};
      (st.lapsed_in || []).forEach(function (l) { if (l && l.cc) (byDate[l.date || ''] = byDate[l.date || ''] || []).push(l.cc); });
      Object.keys(byDate).forEach(function (d) { var cc = byDate[d].sort(); add(d || null, 'lapse', 'Lapsed in ' + cc.length + (cc.length === 1 ? ' state: ' : ' states: ') + cc.join(', '), src, pn); });
      (st.events || []).forEach(function (e) {
        if (!e || !e.text) return;
        var k = kindOf(e.text);
        if (k === 'lapse' && (st.lapsed_in || []).length) return;
        if (k === 'opposition' && /^opposition filed$/i.test(String(e.text).trim()) && op && op.filed && iso(op.date_first_filed)) return;
        add(e.date, k, String(e.text), src, pn);
      });
      if (st.fees_paid_years && st.fees_paid_years.length) {
        var y = st.fees_paid_years.slice().sort(function (a, b) { return a - b; });
        add(st.last_fee_date, 'fee', 'Renewal fees recorded for year' + (y.length > 1 ? 's ' + y[0] + ' to ' + y[y.length - 1] : ' ' + y[0]) + (st.last_fee_date ? '' : ' (no payment date)'), src, pn);
      }
      if (st.unitary) add(null, 'unitary', 'Unitary effect ' + st.unitary + ' (no date in the register data)', src, pn);
      var exp = iso(st.expiry_est) || iso(P.exp);
      if (exp) add(exp, 'expiry_est', 'Estimated expiry' + (st.pta_days ? ' (including ' + st.pta_days + ' days of patent term adjustment)' : '') + ': filing date + 20 years; an estimate, not a legal determination', st.expiry_est ? src : 'patent table', pn);
    });
    var out = Array.from(map.values());
    out.sort(function (a, b) {
      if ((a.date === null) !== (b.date === null)) return a.date === null ? 1 : -1;
      return a.date === b.date ? a._o - b._o : (a.date < b.date ? -1 : 1);
    });
    out.forEach(function (e) { delete e._o; e.pn.sort(); });
    return out;
  }

  function summarise(P, st, opts) {
    var s = { hasStatus: !!st, opposed: false, outcome: null, appealed: false, lapsedIn: [], lapsedCc: [], asof: null, stale: false, unitary: null, code: null };
    if (!st) return s;
    var op = st.opposition;
    s.opposed = !!(op && op.filed);
    s.outcome = (op && op.outcome) || null;
    s.appealed = !!(st.appeal || (st.appeal_detail && st.appeal_detail.length));
    s.lapsedIn = (st.lapsed_in || []).map(function (l) { return { cc: l.cc, date: l.date || null }; });
    s.lapsedCc = s.lapsedIn.map(function (l) { return l.cc; }).sort();
    s.asof = st.asof || null; s.unitary = st.unitary || null; s.code = st.code || null;
    var a = s.asof && ms(iso(s.asof)), t = ms(today(opts));
    s.stale = !!(a != null && t != null && t - a > 183 * DAY);
    return s;
  }

  /* ---- data access (LnpData); a plain object with patent/status/family functions can be passed as opts.data (tests) */
  function dataOf(o) { var D = (o && o.data) || g.LnpData; if (!D) throw new Error('LnpData is not loaded'); return D; }
  function asPatent(D, p) { return (p && typeof p === 'object') ? Promise.resolve(p) : D.patent(p); }
  function timeline(p, opts) {
    opts = opts || {};
    var D;
    try { D = dataOf(opts); } catch (e) { return Promise.reject(e); }
    return asPatent(D, p).then(function (P) {
      var ids = opts.family === false ? Promise.resolve([P.p]) : Promise.resolve(D.family(P.p)).then(function (a) { return a && a.length ? a : [P.p]; });
      return ids.then(function (ps) {
        ps = ps.slice(0, 60);
        return Promise.all(ps.map(function (q) {
          return Promise.all([q === P.p ? Promise.resolve(P) : D.patent(q), D.status(q).catch(function () { return null; })]).then(function (r) { return { P: r[0], st: r[1] || null }; });
        }));
      }).then(function (members) { return build(members, opts); });
    });
  }
  function summary(p, opts) {
    opts = opts || {};
    var D;
    try { D = dataOf(opts); } catch (e) { return Promise.reject(e); }
    return asPatent(D, p).then(function (P) {
      if (!opts.family) return D.status(P.p).then(function (st) { return summarise(P, st, opts); });
      return Promise.resolve(D.family(P.p)).then(function (ps) {
        return Promise.all((ps || [P.p]).slice(0, 60).map(function (q) { return D.status(q).catch(function () { return null; }); }));
      }).then(function (sts) {
        var all = sts.filter(Boolean).map(function (st) { return summarise(P, st, opts); });
        if (!all.length) return summarise(P, null, opts);
        var rank = { revoked: 4, maintained_amended: 3, rejected: 2, pending: 1 };
        var out = all[0], seen = {};
        out = { hasStatus: true, opposed: false, outcome: null, appealed: false, lapsedIn: [], lapsedCc: [], asof: null, stale: false, unitary: null, code: null };
        all.forEach(function (s) {
          out.opposed = out.opposed || s.opposed; out.appealed = out.appealed || s.appealed;
          if (s.outcome && (!out.outcome || (rank[s.outcome] || 0) > (rank[out.outcome] || 0))) out.outcome = s.outcome;
          s.lapsedIn.forEach(function (l) { var k = l.cc + '|' + l.date; if (!seen[k]) { seen[k] = 1; out.lapsedIn.push(l); } });
          if (s.asof && (!out.asof || s.asof < out.asof)) out.asof = s.asof;        // the oldest snapshot decides staleness
          out.unitary = out.unitary || s.unitary; out.code = out.code || s.code;
        });
        out.lapsedCc = out.lapsedIn.map(function (l) { return l.cc; }).filter(function (c, i, a) { return a.indexOf(c) === i; }).sort();
        var a = out.asof && ms(iso(out.asof)), t = ms(today(opts));
        out.stale = !!(a != null && t != null && t - a > 183 * DAY);
        return out;
      });
    });
  }
  function limits() {
    return ['Register snapshot: later events, decisions and renewal fees that fell due after the snapshot date are not seen.',
      'Not a full file history: the register data holds at most the 12 newest events per application, so early prosecution steps can be missing.',
      'Lapse lists show states recorded as lapsed in the register, not states where a fee is merely overdue.',
      'Expiry is an estimate (filing date + 20 years, plus term adjustment for US); extensions (SPC, PTE) are not checked. Pre-screening, not legal advice.'];
  }

  var L = { timeline: timeline, summary: summary, build: build, summarise: summarise, limits: limits, kindOf: kindOf, KINDS: KINDS, OUTCOME: OUTCOME, iso: iso, version: 1 };
  g.LnpLegal = L;
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof self !== 'undefined' ? self : this);
