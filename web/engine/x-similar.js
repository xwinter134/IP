/* LNP Patent Desk: similar patents / query by example (global LnpSimilar).
   Plain ASCII script, no eval, no network of its own. Code decides everything; no model is involved.

   API
     similar(pn | p | {text, smiles?}, {k = 25, weights, commonMax = 150, terms = 25, includeFamily = false, signal})
        -> Promise<hits[]>, hit = {p, pn, family, members[p], score (0..1), why: {text: {score, terms[]}, compounds: {shared, examples[{c, id, smiles, nPatGlobal}]},
                                   cpc: {score, shared[]}, family: false}, title, assignee, status}
        The array also carries: source {kind: 'patent'|'text', p, pn, title, terms[{term, tf, df, weight}], text {claims, abstract, via}, compounds {n, specific, used}, cpc[]},
        familyMembers [{p, pn, title, status}] (members of the source family, listed separately and never in the hits), weights, notes[], limits[], ms.
     Combined score (per patent family, 0..1):
        score = ( wT*text + wC*comp + wP*cpc ) / (sum of the weights of the parts that exist for this source)
        text  = BM25 score of the best family member for an OR query of the 25 most distinctive terms of the source, divided by the best score of the run
                (distinctive = tf-idf: (1 + ln tf) * ln(1 + (N - df + 0.5) / (df + 0.5)), df from the lexicon of the search index, N = number of indexed units)
        comp  = 1 - exp(-W / 2), W = sum over the shared specific compounds of 1 / (1 + log10(nPatGlobal)); a compound counts as specific when its SureChEMBL-wide
                publication count nPatGlobal is at most commonMax, so commodity lipids (cholesterol, DSPC, PEG-lipids ...) never create a link
        cpc   = Jaccard index of the full CPC codes (e.g. A61K9/5123) of the source and of the best-scoring member
        default weights {text: 0.6, compounds: 0.25, cpc: 0.15}; a part that cannot exist for the source (no text terms, no chemistry, no CPC codes) drops out
        and the remaining weights are renormalised. The family is the unit of the result: best member shown, `members` lists the others.
     Text mode (a pasted text, optional SMILES lines) uses the text part, and the compound part only for pasted structures.
     terms(text, {n = 25}) -> Promise<[{term, tf, df, weight}]>   (the term picker alone)
     jaccard(a[], b[]) -> 0..1;  combine(parts, weights) -> 0..1;  limits() -> text[];  configure({data, search, chem, tok, df}) for tests  */
(function (g) {
  'use strict';
  var S = { cfg: {} };
  function eng(n) { return S.cfg[n] || g['Lnp' + n.charAt(0).toUpperCase() + n.slice(1)] || null; }
  function str(x) { return x == null ? '' : String(x); }
  function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function configure(c) { S.cfg = c || {}; }
  function tok() { return S.cfg.tok || g.LnpTok || (typeof require !== 'undefined' ? require('./tok.js') : null); }

  var DEFAULT_W = { text: 0.6, compounds: 0.25, cpc: 0.15 };
  var LIMITS = [
    'Similarity by shared words, compounds and patent classes in this corpus. It is not a novelty, validity or infringement assessment.',
    'The text part compares the independent claims and the abstract of the source with the indexed claim, title and abstract text of the other publications; a publication without text in this build can only match through compounds or classes.',
    'Compounds come from the structure extraction of the dataset (SureChEMBL) and miss generic (Markush) formulae; widely used compounds are ignored.',
    'Corpus snapshot only; later filings, other jurisdictions and non-patent literature are not covered.'
  ];
  // words that carry no topic in claim language (the idf already pushes most of them down; these are dropped before the lookup)
  var GENERIC = {}; ('claim claims according wherein comprising comprises comprise comprised including includes include consisting consists selected group groups method methods composition compositions ' +
    'further wherein said use used using having has have being than least one two three more about between each other any all such thereof thereto herein formula compound compounds ' +
    'embodiment embodiments preferred preferably example examples containing contain contains mean means value values ranging range percent may can wherein whereby which where when then also not only without within into onto upon via per ratio amount amounts').split(' ').forEach(function (w) { GENERIC[w] = 1; });

  /* ------------------------------------------------------------------------------------------ pure helpers */
  function jaccard(a, b) {
    var sa = {}, sb = {}, inter = 0; arr(a).forEach(function (x) { sa[x] = 1; }); arr(b).forEach(function (x) { sb[x] = 1; });
    var ka = Object.keys(sa), kb = Object.keys(sb);
    ka.forEach(function (x) { if (sb[x]) inter++; });
    var uni = ka.length + kb.length - inter;
    return uni ? inter / uni : 0;
  }
  function sharedOf(a, b) { var sb = {}; arr(b).forEach(function (x) { sb[x] = 1; }); var seen = {}, out = []; arr(a).forEach(function (x) { if (sb[x] && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  // parts = {text, compounds, cpc} each a number in 0..1 or null (the part does not exist for this source)
  function combine(parts, weights) {
    var w = Object.assign({}, DEFAULT_W, weights || {}), num = 0, den = 0;
    ['text', 'compounds', 'cpc'].forEach(function (k) { if (parts[k] != null && w[k] > 0) { num += w[k] * parts[k]; den += w[k]; } });
    return den ? num / den : 0;
  }
  function compScore(ws) { var W = 0; arr(ws).forEach(function (x) { W += x; }); return 1 - Math.exp(-W / 2); }
  function compWeight(nPatGlobal) { return 1 / (1 + Math.log10(Math.max(1, +nPatGlobal || 1))); }

  /* ------------------------------------------------------------------------------------------ term picker */
  function dfOf(terms) {
    // -> Promise<{term: df}>; the search engine's lexicon through LnpSearch.suggest (prefix, most frequent first); S.cfg.df(term) overrides (tests)
    var out = {}, Se = eng('search');
    if (S.cfg.df) return Promise.all(terms.map(function (t) { return Promise.resolve(S.cfg.df(t)).then(function (d) { if (d > 0) out[t] = d; }); })).then(function () { return out; });
    if (!Se || !Se.suggest) return Promise.resolve(out);
    return Promise.all(terms.map(function (t) {
      return Promise.resolve(Se.suggest(t, 40)).then(function (list) {
        list = arr(list); if (!list.length) return;
        for (var i = 0; i < list.length; i++) if (list[i].term === t) { out[t] = list[i].df; return; }
        out[t] = Math.max(1, Math.floor(list[list.length - 1].df / 2));     // not among the 40 most frequent completions: the term is rarer than all of them
      }, function () { /* no lexicon: the term is left out */ });
    })).then(function () { return out; });
  }
  function unitsN() { var D = eng('data'); return (D && D.manifest && D.manifest.idx && D.manifest.idx.D) || S.cfg.N || 900000; }

  function terms(text, o) {
    o = o || {}; var T = tok(), n = o.n || 25, tf = {}, flat = T.tokenize(str(text), false), i;
    for (i = 0; i < flat.length; i += 2) {
      var t = flat[i];
      if (t.length < 3 || /^\d+$/.test(t) || GENERIC[t]) continue;
      tf[t] = (tf[t] || 0) + 1;
    }
    // only the most frequent / longest candidates are looked up (the lexicon call is per term)
    var cand = Object.keys(tf).sort(function (a, b) { return (tf[b] - tf[a]) || (b.length - a.length) || (a < b ? -1 : 1); }).slice(0, 150);
    return dfOf(cand).then(function (df) {
      var N = unitsN(), out = [];
      cand.forEach(function (t) {
        if (!df[t]) return;
        var idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
        out.push({ term: t, tf: tf[t], df: df[t], weight: (1 + Math.log(tf[t])) * idf });
      });
      out.sort(function (a, b) { return b.weight - a.weight || (a.term < b.term ? -1 : 1); });
      return out.slice(0, n);
    });
  }

  /* ------------------------------------------------------------------------------------------ source */
  function resolveSource(src) {
    var D = eng('data');
    if (typeof src === 'number') return Promise.resolve(src);
    if (typeof src === 'string') return Promise.resolve(D.byPn(src)).then(function (p) { if (!(p >= 0)) throw err('not_found', 'Publication not found in this corpus: ' + src); return p; });
    return Promise.reject(err('bad_input', 'Give a publication number or a text.'));
  }
  // independent claims (English preferred) + abstract of a publication; when it has no text of its own, the best family member with text
  function sourceText(p, T) {
    var D = eng('data'), Se = eng('search');
    function one(q) {
      return Promise.all([Promise.resolve(Se.claims(q)).then(function (c) { return arr(c); }, function () { return []; }), Promise.resolve(Se.abstract(q)).then(function (a) { return a || ''; }, function () { return ''; })]).then(function (r) {
        var cl = r[0], n = {}; cl.forEach(function (c) { n[c.lang] = (n[c.lang] || 0) + 1; });
        var lang = (n.en && n.en >= (n.de || 0)) ? 'en' : (n.de ? 'de' : Object.keys(n)[0]);
        var ind = cl.filter(function (c) { return c.lang === lang && c.indep; });
        if (!ind.length) ind = cl.filter(function (c) { return c.lang === lang && (!c.dep || !c.dep.length); });
        return { claims: ind.map(function (c) { return str(c.text); }), abstract: str(r[1]), lang: lang || '' };
      });
    }
    return one(p).then(function (x) {
      if (x.claims.length || x.abstract) { x.via = 'own'; return x; }
      return Promise.resolve(D.family(p)).then(function (fam) {
        var rest = arr(fam).filter(function (q) { return q !== p; });
        return rest.reduce(function (chain, q) {
          return chain.then(function (found) { if (found) return found; return one(q).then(function (y) { if (y.claims.length || y.abstract) { y.via = q; return y; } return null; }); });
        }, Promise.resolve(null)).then(function (y) { return y || { claims: [], abstract: '', lang: '', via: null }; });
      }, function () { return { claims: [], abstract: '', lang: '', via: null }; });
    });
  }

  /* ------------------------------------------------------------------------------------------ compounds */
  function compoundPart(srcCompounds, commonMax, o) {
    // -> Promise<{byP: {p: {ws: [], ex: []}}, used, specific}>; srcCompounds = [{c, id, smiles, nPatGlobal}]
    var Ch = eng('chem'), D = eng('data'), byP = {}, specific = srcCompounds.filter(function (c) { return !(c.nPatGlobal > commonMax); }).slice(0, 60);
    return specific.reduce(function (chain, c) {
      return chain.then(function () {
        return Promise.resolve(Ch.patentsOf(c.c)).then(function (list) {
          var seen = {};
          return Promise.all(arr(list).map(function (x) {
            if (x.p >= 0) return x.p;
            return Promise.resolve(D.byPn(x.pn)).then(function (q) { return q; }, function () { return -1; });
          })).then(function (ps) {
            ps.forEach(function (p) {
              if (!(p >= 0) || seen[p]) return; seen[p] = 1;
              var e = byP[p] || (byP[p] = { items: [] });
              e.items.push({ c: c.c, id: c.id, smiles: c.smiles, nPatGlobal: c.nPatGlobal, w: compWeight(c.nPatGlobal) });
            });
          });
        }, function (e) { if (e && e.code === 'cancelled') throw e; });
      });
    }, Promise.resolve()).then(function () { return { byP: byP, used: specific.length, specific: specific.length }; });
  }

  function pastedCompounds(smiles, commonMax) {
    var Ch = eng('chem'); smiles = arr(smiles).map(str).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 20);
    var out = [];
    return smiles.reduce(function (chain, s) {
      return chain.then(function () {
        return Promise.resolve(Ch.search({ query: s, mode: 'exact', limit: 5, maxPatents: 0 })).then(function (hits) { arr(hits).forEach(function (h) { if (h.match !== 'similar') out.push({ c: h.c, id: h.id, smiles: h.smiles, nPatGlobal: h.nPatGlobal }); }); }, function () { /* unreadable structure: ignored, reported by the caller */ });
      });
    }, Promise.resolve()).then(function () { return { list: out, n: smiles.length }; });
  }

  /* ------------------------------------------------------------------------------------------ similar */
  function similar(src, o) {
    o = o || {};
    var D = eng('data'), Se = eng('search'), Ch = eng('chem'), t0 = now(), k = o.k || 25, commonMax = o.commonMax > 0 ? o.commonMax : 150, nTerms = o.terms || 25, T = tok();
    if (!D || !Se) return Promise.reject(err('no_engine', 'The patent data and search engines are not available.'));
    var isText = src && typeof src === 'object' && typeof src.text === 'string';
    var notes = [], source = { kind: isText ? 'text' : 'patent', p: -1, pn: '', title: '', terms: [], text: { claims: 0, abstract: false, via: null }, compounds: { n: 0, specific: 0, used: 0 }, cpc: [] };
    var srcPat = null, famSet = {}, famId = null;

    var start = isText ? Promise.resolve({ claims: [], abstract: str(src.text), lang: '', via: 'pasted' }) : resolveSource(src).then(function (p) {
      source.p = p;
      return Promise.resolve(D.patent(p)).then(function (pat) {
        srcPat = pat; source.pn = pat.pn; source.title = str(pat.title); source.cpc = arr(pat.cpc); famId = pat.fam;
        return Promise.resolve(D.family(p)).then(function (fam) { arr(fam).forEach(function (q) { famSet[q] = 1; }); famSet[p] = 1; });
      }).then(function () { return sourceText(p, T); });
    });

    return start.then(function (tx) {
      source.text = { claims: tx.claims.length, abstract: !!tx.abstract, via: tx.via };
      if (!isText && tx.via && tx.via !== 'own') notes.push('The publication has no text of its own in this build; the text of a family member was used.');
      if (!isText && !tx.claims.length && !tx.abstract) notes.push('No claims or abstract text available for this publication, so the text part is empty; compounds and classes are still compared.');
      var body = tx.claims.concat([tx.abstract]).join('\n') + (isText ? '' : '\n' + str(source.title));
      return terms(body, { n: nTerms }).then(function (tm) {
        source.terms = tm;
        // text part: one OR query of the distinctive terms
        var textP = tm.length ? Promise.resolve(Se.search(tm.map(function (x) { return x.term; }).join(' OR '), { limit: 200, scope: 'patent', facets: false, snippets: false })).then(function (r) { return r; }) : Promise.resolve(null);
        // compound part
        var compP;
        if (!Ch) { notes.push('No chemistry data in this build: the compound part is left out.'); compP = Promise.resolve(null); }
        else if (isText) {
          compP = arr(src.smiles).length ? pastedCompounds(src.smiles, commonMax).then(function (r) {
            if (r.list.length < r.n) notes.push((r.n - r.list.length) + ' pasted structure(s) were not found in the extracted compounds or could not be read.');
            source.compounds = { n: r.list.length, specific: r.list.length, used: 0 };
            return compoundPart(r.list, Infinity, o).then(function (cp) { source.compounds.used = cp.used; return cp; });    // structures the user pasted are never dropped as commodity
          }, function () { return null; }) : Promise.resolve(null);
        } else {
          compP = Promise.resolve(Ch.compoundsOf(source.p, 200)).then(function (list) {
            list = arr(list); source.compounds = { n: list.length, specific: 0, used: 0 };
            return compoundPart(list, commonMax, o).then(function (cp) { source.compounds.specific = list.filter(function (c) { return !(c.nPatGlobal > commonMax); }).length; source.compounds.used = cp.used; return cp; });
          }, function (e) { if (e && e.code === 'no_chem') { notes.push('No chemistry data in this build: the compound part is left out.'); return null; } return null; });
        }
        return Promise.all([textP, compP]).then(function (r) { return { res: r[0], comp: r[1], tm: tm }; });
      });
    }).then(function (x) {
      var res = x.res, comp = x.comp, tm = x.tm;
      var textScore = {}, maxS = 0;
      if (res) arr(res.hits).forEach(function (h) { textScore[h.p] = h.score; if (h.score > maxS) maxS = h.score; });
      var pool = {};
      Object.keys(textScore).forEach(function (p) { pool[p] = 1; });
      if (comp) Object.keys(comp.byP).forEach(function (p) { pool[p] = 1; });
      var ps = Object.keys(pool).map(Number);
      return Promise.all(ps.map(function (p) { return Promise.resolve(D.patent(p)).then(function (pat) { return pat; }, function () { return null; }); })).then(function (pats) {
        var hasCpc = source.cpc.length > 0, parts = {};
        var fams = {};
        pats.forEach(function (pat) {
          if (!pat) return;
          if (!isText && (famSet[pat.p] || (famId != null && pat.fam === famId))) return;       // own family: listed separately
          if (pat.auth === 'WO' && !textScore[pat.p] && !(comp && comp.byP[pat.p])) return;
          var key = pat.fam, f = fams[key] || (fams[key] = { family: key, members: [], text: 0, items: {}, cpc: 0, cpcShared: [], best: null, bestKey: -1 });
          var t = maxS > 0 && textScore[pat.p] ? textScore[pat.p] / maxS : 0, cj = hasCpc ? jaccard(source.cpc, pat.cpc) : 0;
          f.members.push(pat.p); if (t > f.text) f.text = t;
          if (comp && comp.byP[pat.p]) comp.byP[pat.p].items.forEach(function (e) { f.items[e.c] = e; });     // compounds of all members of the family, each once
          if (cj > f.cpc) { f.cpc = cj; f.cpcShared = sharedOf(source.cpc, pat.cpc); }
          // best member: highest text score, then granted kinds, then text available
          var kk = t * 10 + (pat.text ? 2 : 0) + (/^B/.test(pat.kind) ? 1 : 0) + (pat.p / 1e9);
          if (kk > f.bestKey) { f.bestKey = kk; f.best = pat; }
        });
        var useText = tm.length > 0, useComp = !!comp && comp.used > 0;
        var w = Object.assign({}, DEFAULT_W, o.weights || {});
        var hits = Object.keys(fams).map(function (key) {
          var f = fams[key], items = Object.keys(f.items).map(function (c) { return f.items[c]; }).sort(function (a, b) { return b.w - a.w; });
          var pt = { text: useText ? f.text : null, compounds: useComp ? compScore(items.map(function (e) { return e.w; })) : null, cpc: hasCpc ? f.cpc : null };
          var score = combine(pt, w);
          return { p: f.best.p, pn: f.best.pn, family: f.family, members: f.members.slice().sort(function (a, b) { return a - b; }), score: score, title: str(f.best.title), assignee: str(f.best.assignee), status: str(f.best.status), auth: f.best.auth, kind: f.best.kind,
            parts: pt, why: { text: { score: pt.text == null ? null : f.text, terms: [] }, compounds: { shared: items.length, score: pt.compounds, examples: items.slice(0, 4).map(function (e) { return { c: e.c, id: e.id, smiles: e.smiles, nPatGlobal: e.nPatGlobal }; }) }, cpc: { score: pt.cpc, shared: f.cpcShared }, family: false } };
        });
        hits.sort(function (a, b) { return b.score - a.score || (a.pn < b.pn ? -1 : 1); });
        hits = hits.filter(function (h) { return h.score > 0; }).slice(0, k);
        return fillTerms(hits, tm, T).then(function () {
          hits.source = source; hits.weights = Object.keys(DEFAULT_W).reduce(function (a, kk) { a[kk] = (kk === 'text' ? useText : kk === 'compounds' ? useComp : hasCpc) ? w[kk] : 0; return a; }, {});
          hits.notes = notes; hits.limits = LIMITS.slice(); hits.ms = Math.round(now() - t0); hits.total = Object.keys(fams).length;
          hits.query = tm.map(function (t) { return t.term; }).join(' OR ');
          if (!isText) return Promise.all(Object.keys(famSet).map(Number).filter(function (q) { return q !== source.p; }).map(function (q) { return Promise.resolve(D.patent(q)).then(function (pt) { return pt; }, function () { return null; }); })).then(function (pts) {
            hits.familyMembers = pts.filter(Boolean).map(function (pt) { return { p: pt.p, pn: pt.pn, title: str(pt.title), status: str(pt.status), auth: pt.auth, kind: pt.kind }; });
            if (o.includeFamily) hits.familyMembers.forEach(function (m) { hits.push({ p: m.p, pn: m.pn, family: famId, members: [m.p], score: 1, title: m.title, assignee: '', status: m.status, parts: {}, why: { text: { score: null, terms: [] }, compounds: { shared: 0, score: null, examples: [] }, cpc: { score: null, shared: [] }, family: true } }); });
            return hits;
          });
          hits.familyMembers = []; return hits;
        });
      });
    });
  }

  // matched terms per hit: the source terms that occur in the claims / abstract of the hit (the top hits only; one text lookup each)
  function fillTerms(hits, tm, T) {
    var Se = eng('search'); if (!tm.length) return Promise.resolve();
    var set = {}; tm.forEach(function (t) { set[t.term] = t.weight; });
    return Promise.all(hits.map(function (h) {
      return Promise.all([Promise.resolve(Se.claims(h.p)).then(function (c) { return arr(c); }, function () { return []; }), Promise.resolve(Se.abstract(h.p)).then(function (a) { return a || ''; }, function () { return ''; })]).then(function (r) {
        var text = r[0].map(function (c) { return str(c.text); }).join('\n') + '\n' + r[1] + '\n' + str(h.title), flat = T.tokenize(text, false), seen = {}, out = [];
        for (var i = 0; i < flat.length; i += 2) { var w = flat[i]; if (set[w] != null && !seen[w]) { seen[w] = 1; out.push(w); } }
        out.sort(function (a, b) { return set[b] - set[a]; });
        h.why.text.terms = out;
      }, function () { /* no text for this hit */ });
    }));
  }

  var api = { similar: similar, terms: terms, jaccard: jaccard, combine: combine, limits: function () { return LIMITS.slice(); }, configure: configure, DEFAULT_WEIGHTS: DEFAULT_W, _compScore: compScore, _compWeight: compWeight };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpSimilar = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
