/* LNP Patent Desk: earliest disclosure view. Route: #disclosure[-<query>][--m<exact|stereo|sim>][--t<min similarity %>]
   query = SMILES, reference lipid name or SCHEMBL number. Shows where a structure first appears in the publications of this
   corpus: timeline of priority and publication dates (claims vs description), families, status, CSV. The engine is
   LnpDisclosure (engine/x-disclosure.js). The result indicates; it does not assess novelty, inventive step or validity. */
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

  var MODES = [['stereo', 'Exact + stereo variants', 'The same connectivity: the query and its stereo variants (SureChEMBL splits one lipid over several entries)'],
    ['exact', 'Exact only', 'Only the identical structure, stereochemistry included'], ['sim', 'Similar', 'Compounds with a count-fingerprint Tanimoto at or above the threshold (different structures)']];
  var SIMS = [80, 85, 90, 95];
  var MAX_LANES = 60, PAGE = 40;

  function engineMode(m) { return m === 'exact' ? 'exact' : m === 'sim' ? 'sim' : 'exact+stereo'; }

  function mount(host, route, App) {
    var K = g.LnpKit, D = g.LnpDisclosure, Ch = g.LnpChem;
    var st = { q: '', m: 'stereo', t: 90 }, dead = false, seq = 0, res = null, offs = [];
    App.chemUsed = true;

    function fromRoute(r) {
      st.q = r.arg || ''; var m = r.params.m; st.m = (m === 'exact' || m === 'sim') ? m : 'stereo';
      st.t = SIMS.indexOf(parseInt(r.params.t, 10)) >= 0 ? parseInt(r.params.t, 10) : 90;
    }
    function toRoute() { return { view: 'disclosure', arg: st.q, params: { m: st.m === 'stereo' ? '' : st.m, t: st.m === 'sim' && st.t !== 90 ? String(st.t) : '' } }; }
    function push(replace) { R.go(toRoute(), { silent: true, replace: !!replace }); }
    function cleanup() { offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); offs = []; K.tip.hide(); }

    /* ---------------------------------------------------------- skeleton */
    var qIn = h('input.input.mono', { id: 'dc-q', type: 'text', placeholder: 'SMILES, name (ALC-0315, SM-102, MC3 …) or SCHEMBL number', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Structure as SMILES, name or SCHEMBL number' });
    var form = h('form.k-qrow', { onsubmit: function (ev) { ev.preventDefault(); st.q = qIn.value.trim(); push(); run(); } }, qIn, h('button.btn.primary', { type: 'submit' }, U.icon('search'), 'Show timeline'));
    var examples = h('div.k-chips', { 'aria-label': 'Reference lipids as examples' });
    var modeSeg = h('div.seg', { role: 'group', 'aria-label': 'Match type' });
    var simSel = h('select.select', { id: 'dc-sim', 'aria-label': 'Minimum similarity' });
    SIMS.forEach(function (v) { simSel.appendChild(h('option', { value: String(v), text: (v / 100).toFixed(2) })); });
    var simBox = h('label.k-slider', { 'for': 'dc-sim' }, 'Minimum similarity', simSel);
    var preview = h('div.k-preview'), body = h('div.cm-body');
    var how = h('details.k-fold.k-limit', null, h('summary', null, U.icon('help'), h('span', { text: 'How to read this: an indication, not a novelty assessment' })),
      h('div.k-fold-body.k-prose', null,
        h('p', { text: 'The timeline shows the publications of this corpus in which a structure search found the compound, with their priority and publication dates. It can help to see where a lipid first appears when judging the validity of a third-party patent or the patentability of your own compound.' }),
        h('p', { text: 'It does not assess novelty or inventive step: it knows nothing about journals, conference papers, products, generic formulae or documents outside the corpus, and the earliest priority date is not the effective date of a disclosure in every jurisdiction. Take the documents themselves, and a professional opinion, before relying on a date.' })));
    var page = h('div.page.k-page.cm-page', null,
      K.head('Earliest disclosure', 'Where does a lipid', 'first appear in the corpus?', 'Priority and publication dates of every publication in which a structure was found, grouped by patent family, with the part of the document where it was found and the legal status. Indicates; does not assess novelty.'),
      h('div.k-struct', null, h('div.k-struct-q', null, form, examples, h('div.k-row', null, modeSeg, simBox), preview)),
      how, body);
    host.appendChild(page);
    MODES.forEach(function (m) { modeSeg.appendChild(h('button', { type: 'button', title: m[2], data: { m: m[0] }, onclick: function () { st.m = m[0]; syncControls(); push(); if (st.q) run(); } }, m[1])); });
    simSel.addEventListener('change', function () { st.t = Number(simSel.value); push(true); if (st.q) run(); });
    function syncControls() {
      qIn.value = st.q; simSel.value = String(st.t); simBox.hidden = st.m !== 'sim';
      Array.prototype.forEach.call(modeSeg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.m === st.m ? 'true' : 'false'); });
    }
    if (Ch) Ch.names().then(function (names) {
      if (dead) return;
      names.filter(function (n) { return n.c >= 0 && n.role === 'ionizable'; }).slice(0, 8).forEach(function (n) {
        examples.appendChild(h('button.chip', { type: 'button', title: n.note || n.name, onclick: function () { st.q = n.name; qIn.value = n.name; push(); run(); } }, n.name));
      });
    }, function () { /* no chemistry in this build: the run reports it */ });

    /* ---------------------------------------------------------- preview of the query */
    var prevSeq = 0;
    function drawPreview(q) {
      var my = ++prevSeq;
      if (!q || !Ch) { U.clear(preview); return; }
      Ch.parse(q).then(function (p) {
        if (my !== prevSeq || dead) return;
        if (!p || !p.ok) { U.set(preview, h('p.notice.err', { text: 'The input was not recognised as a structure' + (p && p.error ? ': ' + K.chemErr(p.error) : '') + '. Accepted are SMILES, the name of a reference lipid or a SCHEMBL number.' })); return; }
        var info = h('div.k-preview-info', null, h('p.k-sub', { text: (p.name ? p.name + ' · ' : p.id ? p.id + ' · ' : '') + (p.formula || '') + (p.mw ? ' · ' + U.num(Math.round(p.mw * 10) / 10) + ' g/mol' : '') }));
        U.set(preview, h('div.k-preview-box', null, K.mol(p.smiles || q, 260, 130, p.formula), info));
      }, function (e) { if (my === prevSeq && !dead) U.set(preview, K.errBox(e)); });
    }

    /* ---------------------------------------------------------- run */
    function run() {
      var my = ++seq; cleanup(); res = null;
      syncControls(); drawPreview(st.q);
      if (!st.q) { U.set(body, h('div.empty', null, h('p.overline', { text: 'Enter a structure' }), h('h3', { text: 'Name a lipid or paste a SMILES' }), h('p', { text: 'The timeline needs one structure. Pick a reference lipid above or type a SMILES, a name or a SCHEMBL number.' }))); return; }
      U.set(body, K.busy('Looking up the structure and its publications'));
      D.timeline(st.q, { mode: engineMode(st.m), minSim: st.t / 100 }).then(function (r) {
        if (my !== seq || dead) return;
        res = r; draw();
      }, function (e) {
        if (my !== seq || dead) return;
        // a structure that cannot be read is already explained under the input: say it once
        U.set(body, e && e.code === 'no_chem' ? h('p.notice', { text: 'This build contains no structure data, so no structure can be looked up.' })
          : e && e.code === 'bad_query' ? h('p.k-hint', { text: 'No timeline: the input above is not a structure that can be read.' }) : K.errBox(e, 'The timeline could not be built'));
      });
    }

    /* ---------------------------------------------------------- drawing */
    function dateCell(iso) { return iso ? U.date(iso) : '–'; }
    // stat tile whose small line may hold a link (K.stats takes text only)
    function tile(label, value, small) { return h('div.stat', null, h('dt', { text: label }), h('dd', null, value, small ? h('small', null, small) : null)); }
    function earliestTile(label, x, withPrio) {
      return tile(label, x ? U.date(x.date) : '\u2013', x ? [K.patentLink(x.pn, App), withPrio && x.prio ? h('span.faint', { text: ' \u00b7 priority ' + U.date(x.prio) }) : null] : 'no publication');
    }
    function priorityTile(E, r) {
      var pm = r.priorityMissing || {};
      if (!E.priority) return tile('Earliest priority', 'unknown', 'no priority date in the patent table');
      var t = earliestTile('Earliest priority', E.priority, false);
      if (pm.incomplete) t.querySelector('dd').appendChild(h('small.faint', { text: 'incomplete: ' + pm.entries + ' of ' + pm.entriesTotal + ' publications have no priority date; the earliest publication is older' }));
      else if (pm.entries) t.querySelector('dd').appendChild(h('small.faint', { text: 'among dated ones; ' + pm.entries + ' of ' + pm.entriesTotal + ' publications have no priority date' }));
      return t;
    }
    function statusPill(f) {
      if (f.inForce) return h('span.pill.good', { text: 'in force', title: f.statusSummary.text });
      var c = f.statusSummary.counts, keys = Object.keys(c);
      if (c.pending) return h('span.pill.warn', { text: 'pending', title: f.statusSummary.text });
      if (keys.length === 1 && keys[0] === 'unknown') return h('span.pill.hollow', { text: 'status open', title: 'No legal status information in the corpus' });
      return h('span.pill.hollow', { text: keys.filter(function (k) { return k !== 'unknown'; }).sort(function (a, b) { return c[b] - c[a]; })[0] || 'status open', title: f.statusSummary.text });
    }
    function draw() {
      cleanup();
      var r = res, E = r.earliest, nFam = r.families.length, nClaim = r.entries.filter(function (e) { return e.inClaims; }).length;
      if (!r.entries.length) {
        U.set(body, h('div.empty', null, h('p.overline', { text: 'No publication' }), h('h3', { text: 'No publication of the corpus contains this structure' }), h('p', { text: r.mode === 'sim' ? 'No compound reaches the similarity threshold. Lower it or switch to the exact match.' : 'The structure is not among the extracted compounds. Try the similar match, or the structure search for substructures.' }),
          h('p', null, h('a.btn', { href: R.build({ view: 'struktur', arg: st.q, params: { m: 'sim' } }) }, 'Open in structure search'))), limitsBox(r));
        return;
      }
      var stats = h('dl.stats.k-stats', null,
        earliestTile('Earliest publication', E.publication, true), priorityTile(E, r),
        E.claims ? earliestTile('Earliest in claims', E.claims, true) : tile('Earliest in claims', 'none', 'no publication with the structure in the claim text'),
        tile('Publications', U.num(r.entries.length), nClaim + ' with a match in claims'),
        tile('Patent families', U.num(nFam), U.num(r.compounds.length) + (r.compounds.length === 1 ? ' compound' : ' compounds') + (r.truncated ? ' of ' + U.num(r.compoundsTotal) : '')));
      var tlBox = h('div.cm-tlbox');
      var secT = K.sec('Timeline', 'Priority and publication dates by family', null, h('p.k-note', { text: 'Each lane is one patent family, the oldest on top. A ring marks the priority date, a diamond a publication with the structure in the claim text, a dot a publication that mentions it elsewhere (description, abstract, title, image). Marks open the patent.' }), tlBox);
      drawTimeline(tlBox, r);
      var tblBox = h('div.cm-tblbox');
      var actions = h('div.k-row', null,
        h('button.btn.sm', { type: 'button', onclick: function () { U.saveFile('disclosure-' + slug(r) + '-publications.csv', D.toCsv(r, { kind: 'entries' }), 'text/csv'); } }, U.icon('download'), 'Publications (CSV)'),
        h('button.btn.sm', { type: 'button', onclick: function () { U.saveFile('disclosure-' + slug(r) + '-families.csv', D.toCsv(r, { kind: 'families' }), 'text/csv'); } }, U.icon('download'), 'Families (CSV)'));
      var secF = K.sec('Families', 'Patent families, earliest date first', actions, tblBox);
      drawTable(tblBox, r);
      var secC = compoundsSec(r);
      U.set(body, stats, secT, secF, secC, limitsBox(r));
    }
    function slug(r) { return String(r.parsed && r.parsed.id || r.query || 'structure').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) + '-' + K.fileStamp(); }

    function limitsBox(r) {
      return h('section.cm-limits', { 'aria-label': 'Limits of this result' }, h('p.overline', { text: 'Limits' }),
        h('ul', null, r.limits.map(function (l) { return h('li', { text: l }); })),
        h('p.k-hint', { text: 'Pre-screening aid, not legal advice. Structure snapshot ' + (r.snapshot.surechembl || 'unknown') + '; computed in your browser in ' + r.ms + ' ms.' }));
    }

    function compoundsSec(r) {
      if (!r.compounds.length) return null;
      var list = h('div.cm-cmps');
      r.compounds.slice(0, 24).forEach(function (c) {
        list.appendChild(h('a.cm-cmp', { href: R.build({ view: 'struktur', arg: c.id, params: { m: 'exact', c: c.id } }), title: 'Open in structure search' },
          K.mol(c.c, 150, 70, c.id), h('span.mono', { text: c.id }), h('span.faint', { text: (c.match === 'stereo-variant' ? 'stereo variant' : c.match === 'similar' ? 'similarity ' + (c.sim != null ? c.sim.toFixed(2) : '') : 'exact') + ' · ' + U.num(c.nPat) + ' publ.' })));
      });
      return h('details.k-fold', null, h('summary', null, U.icon('structure'), h('span', { text: 'Compounds behind the result (' + U.num(r.compounds.length) + (r.compoundsTotal > r.compounds.length ? ' of ' + U.num(r.compoundsTotal) : '') + ')' })),
        h('div.k-fold-body', null, list, r.compounds.length > 24 ? h('p.k-hint', { text: 'The first 24 are drawn.' }) : null));
    }

    /* ---------------------------------------------------------- timeline of HTML marks */
    function tms(iso) { return Date.parse(iso + 'T00:00:00Z'); }
    function drawTimeline(box, r) {
      var fams = r.families, dates = [];
      r.entries.forEach(function (e) { if (e.prio) dates.push(e.prio); if (e.pub) dates.push(e.pub); });
      if (!dates.length) { box.appendChild(h('p.faint', { text: 'The publications carry no dates in the patent table.' })); return; }
      dates.sort();
      var y0 = +dates[0].slice(0, 4), y1 = +dates[dates.length - 1].slice(0, 4) + 1, span = Math.max(1, y1 - y0), narrow = (box.clientWidth || (g.innerWidth || 1000)) < 560;
      // fewer year ticks on a phone, so the labels do not run into each other
      var step = narrow ? (span <= 6 ? 1 : span <= 12 ? 2 : span <= 24 ? 4 : 10) : (span <= 8 ? 1 : span <= 16 ? 2 : 5);
      var a = tms(y0 + '-01-01'), b = tms(y1 + '-01-01');
      function pos(iso) { return Math.max(0, Math.min(100, (tms(iso) - a) / (b - a) * 100)); }
      var inner = h('div.cm-tl-in', { role: 'group', 'aria-label': 'Timeline of priority and publication dates, one lane per patent family' }), axis = h('div.cm-tl-row.cm-tl-axis', null, h('span.cm-tl-lab'));
      var ax = h('div.cm-tl-track');
      for (var y = Math.ceil(y0 / step) * step; y <= y1; y += step) ax.appendChild(h('span.cm-tl-y', { style: { left: (y - y0) / span * 100 + '%' }, text: String(y) }));
      axis.appendChild(ax); inner.appendChild(axis);
      var E = r.earliest, lanes = fams.slice(0, MAX_LANES);
      lanes.forEach(function (f) {
        var track = h('div.cm-tl-track');
        for (var yy = Math.ceil(y0 / step) * step; yy <= y1; yy += step) track.appendChild(h('i.cm-tl-grid', { style: { left: (yy - y0) / span * 100 + '%' } }));
        if (E.priority) track.appendChild(h('i.cm-tl-line.cm-l-prio', { style: { left: pos(E.priority.date) + '%' } }));
        if (E.publication) track.appendChild(h('i.cm-tl-line.cm-l-pub', { style: { left: pos(E.publication.date) + '%' } }));
        var last = f.members.reduce(function (m, e) { return e.pub && e.pub > m ? e.pub : m; }, ''), p0 = f.earliestPrio || f.earliestPub;
        if (p0 && last && last > p0) track.appendChild(h('i.cm-tl-span', { style: { left: pos(p0) + '%', width: Math.max(0, pos(last) - pos(p0)) + '%' } }));
        if (f.earliestPrio) track.appendChild(mark('cm-m.cm-prio', f.earliestPrio, null, null, f, 'Priority date', 'Priority ' + U.date(f.earliestPrio) + ' (earliest of the family)'));
        f.members.forEach(function (e) { if (e.pub) track.appendChild(mark('cm-m.' + (e.inClaims ? 'cm-claims' : 'cm-desc'), e.pub, e, e.pn, f)); });
        var first = f.members[0];
        inner.appendChild(h('div.cm-tl-row', null, h('a.cm-tl-lab.mono', { href: App.patentHref(first.pn, { q: '' }), title: f.members.map(function (e) { return e.pn; }).join(', ') }, U.pnPretty(first.pn), f.members.length > 1 ? h('span.faint', { text: ' +' + (f.members.length - 1) }) : null), track));
      });
      function mark(cls, iso, e, pn, f, label, tipText) {
        var el = h(e ? 'a.' + cls : 'span.' + cls, { style: { left: pos(iso) + '%' }, href: e ? App.patentHref(e.pn, { q: '' }) : null, tabindex: e ? null : '-1',
          'aria-label': e ? U.pnPretty(e.pn) + ', published ' + U.date(e.pub) + ', ' + (e.inClaims ? 'in the claims' : 'not in the claims') : tipText });
        function tip(ev) {
          if (e) K.tip.show(ev, U.pnPretty(e.pn), [['Published', U.date(e.pub), null], ['Priority', U.date(e.prio), null], ['Found in', K.whereText(e.where) || '–', null], ['Status', e.status || 'unknown', null]], e.title ? e.title.slice(0, 90) : null);
          else K.tip.show(ev, label, [['Date', U.date(iso), null]], null);
        }
        el.addEventListener('mousemove', tip); el.addEventListener('focus', tip); el.addEventListener('mouseleave', K.tip.hide); el.addEventListener('blur', K.tip.hide);
        return el;
      }
      var wrap = h('div.cm-tl', null, inner);
      box.appendChild(wrap);
      box.appendChild(h('div.cm-legend', null,
        h('span', null, h('i.cm-key.cm-prio'), 'priority date'), h('span', null, h('i.cm-key.cm-claims'), 'publication, structure in claims'), h('span', null, h('i.cm-key.cm-desc'), 'publication, structure elsewhere'),
        h('span', null, h('i.cm-key.cm-kl.cm-l-prio'), 'earliest priority'), h('span', null, h('i.cm-key.cm-kl.cm-l-pub'), 'earliest publication')));
      if (fams.length > lanes.length) box.appendChild(h('p.k-hint', { text: 'The first ' + lanes.length + ' of ' + U.num(fams.length) + ' families are drawn; the table and the CSV have all of them.' }));
    }

    /* ---------------------------------------------------------- family table */
    function drawTable(box, r) {
      var shown = 0, tb = h('tbody'), more = h('div.k-more');
      var table = h('table.data.cm-table', null, h('thead', null, h('tr', null, ['Earliest priority', 'Earliest publication', 'Publications with the structure', 'Where found', 'Status'].map(function (x) { return h('th', { text: x }); }))), tb);
      function rows() {
        r.families.slice(shown, shown + PAGE).forEach(function (f) {
          var mem = h('div.cm-mem');
          f.members.slice(0, 6).forEach(function (e) { mem.appendChild(h('span.cm-memi', null, K.patentLink(e.pn, App), h('span.faint', { text: ' ' + U.date(e.pub) }))); });
          if (f.members.length > 6) mem.appendChild(h('span.faint', { text: '+' + (f.members.length - 6) + ' more' }));
          var w = {}; f.members.forEach(function (e) { Object.keys(e.where).forEach(function (k) { if (e.where[k]) w[k] = true; }); });
          tb.appendChild(h('tr', null,
            h('td.mono.cm-nowrap', { text: f.earliestPrio ? U.date(f.earliestPrio) : 'priority unknown', title: f.earliestPrio ? '' : 'No priority date in the patent table for this family' }), h('td.mono.cm-nowrap', { text: dateCell(f.earliestPub) }),
            h('td', null, mem, f.size > f.sizeInTable ? h('span.k-hint', { text: f.sizeInTable + ' of ' + f.size + ' family publications in the table carry it' }) : null),
            h('td', null, h('span.cm-tags', null, f.inClaimsAny ? K.whereTags({ clm: true }) : h('span.tag', { text: 'not in claims', title: 'No publication of this family has the structure in the claim text' }), K.whereTags(Object.assign({}, w, { clm: false })))),
            h('td', null, statusPill(f))));
        });
        shown = Math.min(r.families.length, shown + PAGE);
        U.set(more, shown < r.families.length ? h('button.btn.sm', { type: 'button', onclick: rows }, 'Show ' + Math.min(PAGE, r.families.length - shown) + ' more (' + U.num(r.families.length - shown) + ' left)') : null);
      }
      rows();
      box.appendChild(h('div.table-wrap', null, table)); box.appendChild(more);
    }

    fromRoute(route); syncControls();
    run();
    return {
      update: function (rt) { var o = JSON.stringify(st); fromRoute(rt); if (JSON.stringify(st) !== o) { syncControls(); run(); } return true; },
      destroy: function () { dead = true; cleanup(); }
    };
  }

  g.LnpApp.registerView({ id: 'disclosure', title: 'Earliest disclosure', icon: 'landscape', rail: false, parent: 'tools', mount: g.LnpLazyView('disclosure', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });

  // entry from the compound dialog of the structure search
  try {
    if (g.LnpApp.ext && g.LnpApp.ext.compoundAction) {
      g.LnpApp.ext.compoundAction(function (hit) {
        if (!hit || !hit.id) return null;
        return h('a.btn.sm', { href: R.build({ view: 'disclosure', arg: hit.id }), title: 'Where this structure first appears in the corpus (indicates; does not assess novelty)' }, 'Earliest disclosure');
      });
    }
  } catch (e) { /* hook not available */ }
})(window);
