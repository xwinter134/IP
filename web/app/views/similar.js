/* LNP Patent Desk: similar patents / query by example. Route: #similar-<publication number> | #similar--mtext (pasted text, kept only in the page)
   Finds the publications of the corpus that resemble a given publication (or a pasted text) by shared words (BM25 more-like-this over the
   independent claims and the abstract), shared specific compounds and shared patent classes (CPC). Every hit says why. The engine is
   LnpSimilar (engine/x-similar.js). It is a similarity aid, not a novelty, validity or infringement assessment.
   Also registers the patent-page button "Similar patents" through LnpApp.ext.patentAction. */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  if (!g.LnpLazyView) g.LnpLazyView = (function () {
    var reg = {};
    function one(n) {
      return reg[n] || (reg[n] = new Promise(function (res, rej) {
        var el;
        if (/\.css$/.test(n)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = n; el.onload = el.onerror = function () { res(true); }; }
        else { el = document.createElement('script'); el.src = n; el.async = false; el.onload = function () { res(true); }; el.onerror = function () { delete reg[n]; rej({ code: 'script', message: 'could not be loaded: ' + n }); }; }
        document.head.appendChild(el);
      }));
    }
    return function (id, need, real) {
      return function (host, route, App) {
        var inst = null, dead = false;
        need.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()).then(function () { if (!dead) inst = real(host, route, App); }).catch(function (e) {
          App.logError('view ' + id, e);
          if (!dead) g.LnpUI.set(host, g.LnpUI.h('div.page', null, g.LnpUI.h('p.notice.err', { text: 'The view could not be built: ' + g.LnpUI.errText(e) })));
        });
        return { update: function (r) { return inst && inst.update ? inst.update(r) : false; }, destroy: function () { dead = true; try { if (typeof inst === 'function') inst(); else if (inst && inst.destroy) inst.destroy(); } catch (e) { App.logError('destroy ' + id, e); } } };
      };
    };
  })();

  var PARTS = [['text', 'Words', 'var(--s1)', 'Shared distinctive words of the independent claims and the abstract (BM25 more-like-this)'], ['compounds', 'Compounds', 'var(--s3)', 'Shared specific compounds (commodity compounds ignored)'], ['cpc', 'Classes', 'var(--s4)', 'Overlap of the CPC codes (Jaccard index)']];
  var MAX_TEXT = 20000;

  function mount(host, route, App) {
    var K = g.LnpKit, L = g.LnpSimilar, D = g.LnpData;
    var st = { mode: 'patent', pn: '', text: '', smiles: '' }, dead = false, seq = 0, res = null;

    function fromRoute(r) { st.mode = r.params.m === 'text' ? 'text' : 'patent'; st.pn = st.mode === 'patent' ? decArg(r.arg || '') : st.pn; }
    function decArg(a) { try { return decodeURIComponent(a); } catch (e) { return a; } }
    function goPn(pn) { R.go({ view: 'similar', arg: pn }); }

    /* ---------------------------------------------------------- skeleton */
    var modeSeg = h('div.seg', { role: 'group', 'aria-label': 'What to compare' });
    var qBox = h('div.sm-q'), body = h('div.sm-body');
    var page = h('div.page.k-page.sm-page', null,
      K.head('Similar patents', 'Which publications resemble', 'this one?', 'Query by example: the publications that share the most distinctive words, specific compounds and patent classes with a publication or a pasted text. Every hit says why. A similarity aid, not a novelty or infringement assessment.'),
      h('div.sm-pick', null, modeSeg, qBox), body);
    host.appendChild(page);
    [['patent', 'Publication'], ['text', 'Pasted text']].forEach(function (m) {
      modeSeg.appendChild(h('button', { type: 'button', data: { m: m[0] }, onclick: function () { if (m[0] === 'text') R.go({ view: 'similar', params: { m: 'text' } }); else R.go({ view: 'similar', arg: st.pn }); } }, m[1]));
    });

    function drawQuery() {
      Array.prototype.forEach.call(modeSeg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.m === st.mode ? 'true' : 'false'); });
      U.clear(qBox);
      if (st.mode === 'patent') {
        var inp = h('input.input.mono', { id: 'sm-pn', type: 'text', placeholder: 'Publication number, e.g. EP3532103B1 or US 10,000,445', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Publication number' });
        inp.value = st.pn;
        qBox.appendChild(h('form.k-qrow', { onsubmit: function (ev) { ev.preventDefault(); var v = inp.value.trim(); if (!v) return; Promise.resolve(D.byPn(v)).then(function (p) { return p >= 0 ? D.patent(p) : null; }).then(function (pt) { goPn(pt && pt.pn ? pt.pn : v); }, function () { goPn(v); }); } }, inp, h('button.btn.primary', { type: 'submit', id: 'sm-go' }, U.icon('search'), 'Find similar')));
      } else {
        var ta = h('textarea.textarea', { id: 'sm-text', rows: '6', maxlength: String(MAX_TEXT), spellcheck: 'false', 'aria-label': 'Text to compare', placeholder: 'Paste a claim, an abstract or a paragraph. Patent text is only compared, never executed or sent anywhere.' }); ta.value = st.text;
        var sm = h('textarea.textarea.mono', { id: 'sm-smiles', rows: '2', maxlength: '4000', spellcheck: 'false', 'aria-label': 'SMILES, optional', placeholder: 'Optional: SMILES of compounds of interest, one per line (matched exactly against the extracted compounds)' }); sm.value = st.smiles;
        ta.addEventListener('input', function () { st.text = ta.value; }); sm.addEventListener('input', function () { st.smiles = sm.value; });
        qBox.appendChild(ta); qBox.appendChild(sm);
        qBox.appendChild(h('div.k-row', null, h('button.btn.primary', { type: 'button', id: 'sm-go', onclick: run }, U.icon('search'), 'Find similar'), h('span.k-hint', { text: 'Text mode compares words (and the structures you paste); classes need a publication.' })));
      }
    }

    /* ---------------------------------------------------------- run */
    function run() {
      var my = ++seq; res = null;
      var src;
      if (st.mode === 'text') {
        if (st.text.trim().length < 20) { U.set(body, h('div.empty', null, h('p.overline', { text: 'Text needed' }), h('h3', { text: 'Paste at least a sentence' }), h('p', { text: 'A claim or an abstract works best.' }))); return; }
        src = { text: st.text.slice(0, MAX_TEXT), smiles: st.smiles.split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean) };
      } else {
        if (!st.pn) { U.set(body, h('div.empty', null, h('p.overline', { text: 'Choose a publication' }), h('h3', { text: 'Enter a publication number' }), h('p', { text: 'The independent claims and the abstract of the publication are compared with the rest of the corpus. Or switch to pasted text.' }))); return; }
        src = st.pn;
      }
      U.set(body, K.busy(st.mode === 'text' ? 'Comparing the text with the corpus' : 'Comparing with the corpus: words, compounds and classes'));
      L.similar(src, { k: 25 }).then(function (hits) { if (my !== seq || dead) return; res = hits; draw(); }, function (e) {
        if (my !== seq || dead) return;
        U.set(body, e && e.code === 'not_found' ? h('div.empty', null, h('p.overline', { text: 'Not found' }), h('h3', { text: 'This publication is not in the corpus' }), h('p', { text: e.message })) : K.errBox(e, 'The comparison failed'));
      });
    }

    /* ---------------------------------------------------------- drawing */
    function statusLine(x) { return x.status ? U.statusPill(x.status) : null; }
    function limitsBox(r) {
      return h('section.sm-limits', { 'aria-label': 'Limits of this result' }, h('p.overline', { text: 'Limits' }),
        h('p', { text: 'Similarity by shared words, compounds and classes in this corpus; not a novelty or infringement assessment.' }),
        h('ul', null, r.limits.map(function (l) { return h('li', { text: l }); })),
        h('p.k-hint', { text: 'Corpus snapshot ' + U.date(String(((App.manifest || {}).built || '')).slice(0, 10)) + '. Computed in your browser in ' + r.ms + ' ms; ' + U.num(r.total) + ' patent families compared.' }));
    }
    function sourceCard(r) {
      var s = r.source, el = h('div.sm-src');
      var head = s.kind === 'patent' ? h('div.sm-src-h', null, K.patentLink(s.pn, App), h('span.sm-src-t', { text: s.title || '' })) : h('div.sm-src-h', null, h('b', { text: 'Pasted text' }), h('span.faint', { text: U.num(st.text.length) + ' characters' }));
      el.appendChild(head);
      var kv = [];
      if (s.kind === 'patent') {
        kv.push(['Text compared', s.text.claims + (s.text.claims === 1 ? ' independent claim' : ' independent claims') + (s.text.abstract ? ' and the abstract' : '') + (s.text.via && s.text.via !== 'own' ? ' (of a family member)' : '')]);
        kv.push(['Compounds', s.compounds.n ? U.num(s.compounds.n) + ' extracted, ' + U.num(s.compounds.specific) + ' specific (used for matching)' : 'none extracted']);
        kv.push(['CPC codes', s.cpc.length ? s.cpc.slice(0, 10).join(', ') + (s.cpc.length > 10 ? ' (+' + (s.cpc.length - 10) + ')' : '') : 'none']);
      } else kv.push(['Structures', st.smiles.trim() ? U.num(s.compounds.n) + ' of the pasted structures found in the extracted compounds' : 'none pasted']);
      el.appendChild(K.kv(kv));
      var tm = h('div.k-chips.sm-terms', { 'aria-label': 'Distinctive terms of the source' });
      s.terms.slice(0, 25).forEach(function (t) { tm.appendChild(h('span.chip.sm-term', { title: 'weight ' + t.weight.toFixed(1) + ', in ' + U.num(t.df) + ' indexed units, ' + t.tf + 'x in the source', text: t.term })); });
      el.appendChild(h('div.sm-terms-wrap', null, h('p.overline', { text: 'Distinctive terms used for the search' }), s.terms.length ? tm : h('p.k-hint', { text: 'No distinctive terms: the source has no text in this build.' })));
      if (r.familyMembers && r.familyMembers.length) {
        var fm = h('div.k-chips', { 'aria-label': 'Other members of the source family' });
        r.familyMembers.slice(0, 20).forEach(function (m) { fm.appendChild(h('a.chip.mono', { href: App.patentHref(m.pn, { q: '' }), title: m.title || m.pn, text: U.pnPretty(m.pn) })); });
        el.appendChild(h('div', null, h('p.overline', { text: 'Same family (not listed as similar)' }), fm));
      }
      return el;
    }
    function scoreBar(x, weights) {
      var den = 0; PARTS.forEach(function (p) { if (x.parts[p[0]] != null && weights[p[0]] > 0) den += weights[p[0]]; });
      var bar = h('div.sm-bar', { role: 'img', 'aria-label': 'Score ' + x.score.toFixed(2) + ': ' + PARTS.map(function (p) { return p[1] + ' ' + (x.parts[p[0]] == null ? 'n/a' : x.parts[p[0]].toFixed(2)); }).join(', ') });
      PARTS.forEach(function (p) {
        var v = x.parts[p[0]]; if (v == null || !(weights[p[0]] > 0) || !den) return;
        var share = weights[p[0]] * v / den; if (share <= 0) return;
        bar.appendChild(h('span', { style: { width: (share * 100).toFixed(2) + '%', background: p[2] }, title: p[1] + ': ' + v.toFixed(2) + ' x weight ' + weights[p[0]] }));
      });
      return bar;
    }
    function hitCard(x, i, r) {
      var why = x.why, chips = h('div.k-chips.sm-why');
      if (why.text.terms.length) why.text.terms.slice(0, 8).forEach(function (t) { chips.appendChild(h('span.chip.sm-term', { title: 'term shared with the source', text: t })); });
      var comp = why.compounds.shared ? h('div.sm-comp', null, h('b', { text: why.compounds.shared + (why.compounds.shared === 1 ? ' shared specific compound' : ' shared specific compounds') }),
        why.compounds.examples.map(function (e) { return h('a.chip.mono', { href: R.build({ view: 'struktur', arg: e.smiles || '' }), title: 'Search this structure; found in ' + (e.nPatGlobal || '?') + ' publications worldwide', text: e.id || 'compound' }); })) : null;
      var cpc = why.cpc.shared.length ? h('div.sm-cpc', null, h('b', { text: 'Shared classes' }), why.cpc.shared.slice(0, 6).map(function (c) { return h('span.tag', { text: c }); }), why.cpc.shared.length > 6 ? h('span.faint', { text: '+' + (why.cpc.shared.length - 6) }) : null) : null;
      var score = h('div.sm-score', null, h('span.sm-n.mono', { text: x.score.toFixed(2) }), scoreBar(x, r.weights));
      return h('li.sm-hit', { data: { pn: x.pn } },
        h('div.sm-hit-h', null, h('span.sm-rank.mono', { text: String(i + 1) }), h('div.sm-hit-t', null, h('div.k-row', null, K.patentLink(x.pn, App), statusLine(x), x.members.length > 1 ? h('span.faint.k-small', { text: x.members.length + ' publications in the family' }) : null), h('div.sm-title', { text: x.title || '(no title)' }), x.assignee ? h('div.faint.k-small', { text: x.assignee }) : null), score),
        why.text.terms.length ? h('div.sm-line', null, h('span.sm-lab', { text: 'Words' }), chips) : null, comp, cpc,
        h('div.k-row.sm-acts', null, h('a.btn.sm', { href: App.patentHref(x.pn, { q: '' }) }, 'Open'), h('a.btn.sm', { href: R.build({ view: 'similar', arg: x.pn }) }, 'More like this'), h('a.btn.sm', { href: R.build({ view: 'familie', arg: x.pn }) }, U.icon('family'), 'Family')));
    }
    function draw() {
      var r = res, parts = [sourceCard(r)];
      (r.notes || []).forEach(function (n) { parts.push(h('p.notice', { text: n })); });
      var wtxt = PARTS.filter(function (p) { return r.weights[p[0]] > 0; }).map(function (p) { return r.weights[p[0]] + ' x ' + p[1].toLowerCase(); }).join(' + ');
      var legend = h('div.k-legend', null, PARTS.map(function (p) { return h('span', { title: p[3] }, h('i', { style: { background: p[2] } }), p[1]); }));
      if (!r.length) {
        parts.push(h('div.empty', null, h('p.overline', { text: 'No similar publication' }), h('h3', { text: 'Nothing resembles this source in the corpus' }), h('p', { text: 'The source has no distinctive terms, compounds or classes in common with other families, or no text in this build.' })));
      } else {
        var list = h('ol.sm-list'); r.forEach(function (x, i) { list.appendChild(hitCard(x, i, r)); });
        parts.push(K.sec('Results', K.plural(r.length, 'similar patent family', 'similar patent families'), null,
          h('p.k-note', { text: 'Score ' + (wtxt ? '= (' + wtxt + ') / total weight' : '') + '. The bar shows how much each part adds; a part that does not exist for the source drops out. One result per patent family (best member shown).' }), legend, list));
      }
      parts.push(limitsBox(r));
      U.set(body, parts);
    }

    fromRoute(route); drawQuery();
    if (st.mode === 'patent' && st.pn) run();
    else if (st.mode === 'patent') U.set(body, h('div.empty', null, h('p.overline', { text: 'Choose a publication' }), h('h3', { text: 'Which publication should be the example?' }), h('p', { text: 'Enter a publication number, or open a patent and use its "Similar patents" button. Pasted text works too.' })));
    else U.set(body, h('div.empty', null, h('p.overline', { text: 'Text mode' }), h('h3', { text: 'Paste a claim or an abstract' }), h('p', { text: 'The words of the text are compared with the claims, titles and abstracts of the corpus.' })));
    return {
      update: function (r) { var m = r.params.m === 'text' ? 'text' : 'patent'; if (m === st.mode && (m === 'text' || (r.arg || '') === st.pn)) return true; fromRoute(r); drawQuery(); if (st.mode === 'patent') run(); else { ++seq; U.set(body, h('div.empty', null, h('p.overline', { text: 'Text mode' }), h('h3', { text: 'Paste a claim or an abstract' }), h('p', { text: 'The words of the text are compared with the claims, titles and abstracts of the corpus.' }))); } return true; },
      destroy: function () { dead = true; }
    };
  }

  g.LnpApp.registerView({ id: 'similar', title: 'Similar patents', icon: 'search', rail: false, parent: 'tools', mount: g.LnpLazyView('similar', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });

  if (g.LnpApp.ext && typeof g.LnpApp.ext.patentAction === 'function') {
    g.LnpApp.ext.patentAction(function (P) {
      if (!P || !P.pn) return null;
      return h('a.btn.sm', { href: R.build({ view: 'similar', arg: P.pn }), title: 'Publications with similar claims, compounds and classes' }, U.icon('search'), 'Similar patents');
    });
  }
})(window);
