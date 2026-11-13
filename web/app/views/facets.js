/* LNP Patent Desk: extension facets for #suche from the tag engine (global LnpTags, engine/x-tags.js).
   Registers one LnpApp.ext.searchFacet per tag group, plus "Legal events" and "Assignee (normalised)". Nothing is
   registered when LnpTags is absent or reports that its data is not in this build, so the search view stays as it is.
   Interface used (nothing else):
     LnpTags.available()      -> boolean | Promise<boolean>
     LnpTags.list()           -> [group id | {id, title|label}]
     LnpTags.counts(allPs)    -> {group: [{value, label, n}]} | Promise of that;  allPs = Uint32Array of patent indexes
     LnpTags.ps(value)        -> Uint32Array | number[] | Promise of that
   The facet value is passed to LnpTags.ps unchanged, so values must be unique across groups (the engine's choice). */
(function (g) {
  'use strict';
  var EXTRA = [{ id: 'legal', title: 'Legal events', alts: ['legal', 'legal_events', 'legalEvents'] }, { id: 'assignee', title: 'Assignee (normalised)', alts: ['assignee', 'asg', 'assignees'] }];

  function titleCase(s) { s = String(s || '').replace(/[_-]+/g, ' ').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function groupsOf(T) {
    var raw = [];
    try { raw = T.list() || []; } catch (e) { raw = []; }
    var out = [], seen = {};
    raw.forEach(function (x) {
      var key = typeof x === 'string' ? x : x && (x.id || x.group || x.key);
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ key: String(key), title: (x && (x.title || x.label)) || titleCase(key), alts: [String(key)] });
    });
    EXTRA.forEach(function (e) {
      var have = out.some(function (o) { return e.alts.indexOf(o.key) >= 0 || o.title.toLowerCase() === e.title.toLowerCase(); });
      if (!have) out.push({ key: e.id, title: e.title, alts: e.alts });
    });
    return out;
  }

  function register(T) {
    var App = g.LnpApp;
    if (!App || !App.ext || typeof App.ext.searchFacet !== 'function') return 0;
    var cache = new WeakMap();                       // allPs array -> Promise of the counts of every group (one engine call serves all facets)
    function countsFor(all) {
      var hit = all && typeof all === 'object' ? cache.get(all) : null;
      if (hit) return hit;
      var p = Promise.resolve().then(function () { return T.counts(all); });
      if (all && typeof all === 'object') cache.set(all, p);
      return p;
    }
    var n = 0;
    groupsOf(T).forEach(function (grp, i) {
      var id = grp.key.replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Za-z]/.test(id)) id = 'g' + id;
      App.ext.searchFacet({
        id: id, title: grp.title, order: 100 + i,
        counts: function (all) {
          return countsFor(all).then(function (res) {
            res = res || {};
            for (var k = 0; k < grp.alts.length; k++) if (Array.isArray(res[grp.alts[k]])) return res[grp.alts[k]];
            return [];
          });
        },
        ps: function (value) { return Promise.resolve(T.ps(value)); }
      });
      n++;
    });
    return n;
  }

  var T = g.LnpTags;
  if (T && typeof T.list === 'function' && typeof T.counts === 'function' && typeof T.ps === 'function') {
    var avail;
    try { avail = typeof T.available === 'function' ? T.available() : true; } catch (e) { avail = false; }
    if (avail && typeof avail.then === 'function') avail.then(function (ok) { if (ok) register(T); }, function () { });
    else if (avail) register(T);
    else if (typeof T.init === 'function') {                         // the engine loads its data on init(); it may not have been asked yet
      try { Promise.resolve(T.init()).then(function () { try { if (T.available()) register(T); } catch (e) { /* tags stay unavailable */ } }, function () { }); } catch (e) { /* ignore */ }
    }
  }
  g.LnpFacets = { register: register, groupsOf: groupsOf };          // for tests
})(window);
