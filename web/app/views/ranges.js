/* LNP Patent Desk: range check. Route: #ranges[--p<profile id>]
   Compares values (manual grid or a stored product profile) with the numeric ranges that pattern rules found in the claim
   text (engine x-ranges.js, data xdata "ranges"). No model is involved: code decides, the quotes are verbatim claim text.
   Also registers the patent-page panel "Numeric ranges in claims" when the shell offers LnpApp.ext.patentPanel. */
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

  var PAGE = 40;
  // "outside" is neutral, not an all-clear: ranges the rules do not read, "about" and equivalents can still apply
  var STATUS = { inside: ['inside', 'crit'], outside: ['outside', 'hollow'], no_range_in_claim: ['no range in claim', 'hollow'] };

  /* ------------------------------------------------------------ shared pieces */
  // quote node: text before / <mark> / text after, built from text nodes (claim text is never parsed as HTML)
  function quoteNode(q) {
    var box = h('blockquote.rg-q');
    if (!q || !q.text) { box.appendChild(h('span.rg-q-none', { text: 'The claim text is not part of this build, so the quote cannot be shown.' })); return box; }
    var s = Math.max(0, Math.min(q.start, q.text.length)), e = Math.max(s, Math.min(q.start + q.len, q.text.length));
    box.appendChild(document.createTextNode((q.cutStart ? '…' : '') + q.text.slice(0, s)));
    if (e > s) { var m = document.createElement('mark'); m.className = 'hit'; m.textContent = q.text.slice(s, e); box.appendChild(m); }
    box.appendChild(document.createTextNode(q.text.slice(e) + (q.cutEnd ? '…' : '')));
    if (q.verified === true) box.appendChild(h('span.rg-q-ok', { text: 'checked against the claim text', title: 'The quote was compared with the claim text in this build' }));
    else if (q.verified === false) box.appendChild(h('span.rg-q-bad', { text: 'differs from the claim text in this build', title: 'The claim text in this build is not the text the ranges were read from' }));
    return box;
  }
  function loadQuote(r, box) {
    g.LnpRanges.quote(r).then(function (q) { if (box.isConnected !== false) box.replaceWith(quoteNode(q)); }, function () { /* keep the placeholder */ });
  }
  function rangeLine(r) {
    var parts = [r.text || g.LnpRanges.rangeText(r)];
    if (r.approx) parts.push('"about"');
    return parts.join(' ');
  }
  function limitsBox(extra) {
    var Rg = g.LnpRanges, info = Rg.info() || {};
    var items = Rg.limits().map(function (t) { return h('li', { text: t }); });
    if (extra) extra.forEach(function (t) { items.push(h('li', { text: t })); });
    var d = h('details.rg-limits', null, h('summary', null, U.icon('help'), h('span', { text: 'Limits of this check' })), h('ul', null, items));
    if (info.rows) d.appendChild(h('p.rg-meta', { text: 'Range data: ' + U.num(info.rows) + ' ranges in ' + U.num(info.patents) + ' publications (patterns applied to claim text of the dataset snapshot).' }));
    return d;
  }

  /* ------------------------------------------------------------ patent panel */
  var panelDone = false;
  function registerPanel() {
    var E = g.LnpApp && g.LnpApp.ext;
    if (panelDone || !E || typeof E.patentPanel !== 'function') return;
    panelDone = true;
    try {
      E.patentPanel({
        id: 'ranges', title: 'Numeric ranges in claims', over: 'Ranges', order: 60,
        when: function (P) { var Rg = g.LnpRanges, D = g.LnpData, inBuild = !!(D && D.manifest && D.manifest.x && D.manifest.x.ranges); return !!P && !!Rg && (!Rg.available() ? (!Rg.settled() && inBuild) : Rg.has(P.pn)); },
        render: function (P, el) {
          var Rg = g.LnpRanges, dead = false, body = h('div.rg-panel');
          el.appendChild(body);
          var showInh = false, tableData = null;
          function draw() {
            U.clear(body);
            if (!tableData || !tableData.length) { body.appendChild(h('p.rg-meta', { text: 'No numeric ranges were found in the claims of this publication by the pattern rules. Ranges in formula images or tables are not seen.' })); return; }
            var ctl = h('label.rg-check', null, h('input', { type: 'checkbox', checked: showInh, onchange: function (ev) { showInh = ev.target.checked; draw(); } }), 'also show ranges inherited from parent claims');
            body.appendChild(ctl);
            var shown = 0;
            tableData.forEach(function (c) {
              var rows = [];
              Object.keys(c.params).forEach(function (pk) { Object.keys(c.params[pk]).forEach(function (ck) { c.params[pk][ck].forEach(function (r) { if (showInh || !r.inherited) rows.push(r); }); }); });
              if (!rows.length) return;
              shown++;
              var head = h('div.rg-pc-head', null, h('span.mono', { text: 'Claim ' + c.claim }), h('span.tag', { text: c.indep ? 'independent' : 'dependent on ' + c.deps.join(', ') }));
              var list = h('div.rg-pc-rows');
              rows.forEach(function (r) {
                var line = h('div.rg-pc-row', null, h('span.rg-pc-p', { text: r.paramLabel }), h('span.rg-pc-c', { text: r.compLabel || '' }), h('span.rg-pc-r.mono', { text: rangeLine(r) }),
                  r.inherited ? h('span.tag', { text: 'from claim ' + r.fromClaim }) : null);
                var qb = h('div.rg-pc-q', { hidden: true }), btn = h('button.btn.quiet.sm', { type: 'button' }, 'Quote');
                btn.addEventListener('click', function () {
                  if (!qb.hidden) { qb.hidden = true; return; }
                  qb.hidden = false;
                  if (!qb.firstChild) { var ph = h('blockquote.rg-q', { text: 'Loading …' }); qb.appendChild(ph); Rg.quote(r).then(function (q) { U.set(qb, quoteNode(q)); }, function () { U.set(qb, quoteNode(null)); }); }
                });
                list.appendChild(h('div.rg-pc-item', null, line, btn, qb));
              });
              body.appendChild(h('div.rg-pc', null, head, list));
            });
            if (!shown) body.appendChild(h('p.rg-meta', { text: 'Only inherited ranges exist for this publication. Tick the box above to see them.' }));
            body.appendChild(h('p.rg-meta', null, 'Found by pattern rules in claim text (units normalised, "about" read as the stated number, component by the nearest component word). ', h('a', { href: '#ranges', text: 'Check your own values against all claims' }), '.'));
          }
          body.appendChild(h('p.rg-meta', { text: 'Loading ranges …' }));
          Rg.init().then(function () { return Rg.forPatent(P.pn); }).then(function (t) { if (dead) return; tableData = t; draw(); }, function (e) { if (!dead) U.set(body, h('p.rg-meta', { text: 'Range data: ' + (e && e.message ? e.message : 'not available') })); });
          return function () { dead = true; };
        }
      });
    } catch (e) { if (g.LnpApp && g.LnpApp.logError) g.LnpApp.logError('ranges panel', e); }
  }

  /* ------------------------------------------------------------ view */
  function mount(host, route, App) {
    var K = g.LnpKit, Rg = g.LnpRanges, St = g.LnpStore;
    var dead = false, seq = 0, nextId = 1;
    var st = { vals: [], mode: 'all', strict: false, pid: '', pname: '', res: null, busy: false, errors: {} };
    registerPanel();

    var page = h('div.page.k-page.rg-page');
    host.appendChild(page);
    var head = K.head('Range check', 'Do the claimed numbers', 'cover your values?', 'Compare the values of a product or a candidate with the numeric ranges that pattern rules found in the claim text: mol %, ratios, particle size, pKa, temperatures and more. The result is a pre-screening, not legal advice.');
    var gridBox = h('div.rg-grid'), profBox = h('div.rg-prof'), actions = h('div.k-row'), resBox = h('div.rg-res', { 'aria-live': 'polite' });
    page.appendChild(head);

    function newVal(o) { o = o || {}; return { id: nextId++, param: o.param || 'mol_pct', comp: o.comp == null ? '' : o.comp, value: o.value == null ? '' : o.value }; }
    function paramMeta(id) { var ps = Rg.params(); for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return { id: id, label: id, unit: '' }; }

    /* ---------- grid */
    function drawGrid() {
      U.clear(gridBox);
      if (!st.vals.length) gridBox.appendChild(h('p.k-hint', { text: 'No values yet. Add a value or take them from a product profile.' }));
      st.vals.forEach(function (v, i) {
        var ps = h('select.select', { id: 'rg-p' + v.id, 'aria-label': 'Parameter of value ' + (i + 1) });
        Rg.params().forEach(function (p) { ps.appendChild(h('option', { value: p.id, text: p.label, selected: p.id === v.param })); });
        var cs = h('select.select', { id: 'rg-c' + v.id, 'aria-label': 'Component of value ' + (i + 1) });
        cs.appendChild(h('option', { value: '', text: 'any component', selected: v.comp === '' }));
        Rg.comps().forEach(function (c) { cs.appendChild(h('option', { value: c.id, text: c.label, selected: c.id === v.comp })); });
        var inp = h('input.input.mono', { id: 'rg-v' + v.id, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'value', value: v.value, 'aria-label': 'Value ' + (i + 1), 'aria-invalid': st.errors[v.id] ? 'true' : null });
        var unit = h('span.rg-unit.mono', { text: paramMeta(v.param).unit || '' });
        ps.addEventListener('change', function () { v.param = ps.value; unit.textContent = paramMeta(v.param).unit || ''; });
        cs.addEventListener('change', function () { v.comp = cs.value; });
        inp.addEventListener('input', function () { v.value = inp.value; delete st.errors[v.id]; inp.removeAttribute('aria-invalid'); });
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
        var del = h('button.btn.quiet.icon.sm', { type: 'button', title: 'Remove this value', 'aria-label': 'Remove value ' + (i + 1), onclick: function () { st.vals = st.vals.filter(function (x) { return x !== v; }); drawGrid(); } }, U.icon('x'));
        gridBox.appendChild(h('div.rg-row', null, K.field('Parameter', ps), K.field('Component', cs), h('div.k-field.rg-val', null, h('label', { 'for': inp.id, text: 'Value' }), h('div.rg-valbox', null, inp, unit)), h('div.rg-del', null, del)));
      });
    }
    function drawProfiles() {
      U.clear(profBox);
      var sel = h('select.select', { id: 'rg-prof', 'aria-label': 'Product profile' });
      sel.appendChild(h('option', { value: '', text: 'Take values from a profile …' }));
      var list = (st.profiles || []);
      list.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name || p.id, selected: p.id === st.pid })); });
      sel.appendChild(h('option', { value: 'beispiel', text: 'Example profile (generic MC3 siRNA)', selected: st.pid === 'beispiel' }));
      sel.addEventListener('change', function () { if (sel.value) { st.pid = sel.value; loadProfile(sel.value, true); R.go({ view: 'ranges', params: { p: sel.value } }, { silent: true }); } });
      profBox.appendChild(h('div.rg-profrow', null, K.field('Product profile', sel, 'The profile stays unchanged; its values are copied into the grid below and can be edited.'),
        st.pname ? h('span.pill.hollow', { text: 'from: ' + st.pname }) : null));
    }
    function loadProfile(id, run0) {
      var p = id === 'beispiel' ? Promise.resolve(g.LnpProfile && g.LnpProfile.example ? g.LnpProfile.example() : null) : St.get('profiles', id).then(null, function () { return null; });
      return p.then(function (form) {
        if (dead) return;
        if (!form) { U.toast('The profile "' + id + '" was not found.', { error: true }); return; }
        var pv = Rg.profileValues(form);
        st.pid = id; st.pname = form.name || id; st.vals = pv.values.map(function (v) { return newVal({ param: v.param, comp: v.comp ? Rg.compId(v.comp) : '', value: v.value }); });
        st.notes = pv.skipped;
        drawProfiles(); drawGrid(); if (run0) run();
      });
    }

    /* ---------- run + results */
    function readValues() {
      var out = [], bad = false;
      st.errors = {};
      st.vals.forEach(function (v) {
        var t = String(v.value == null ? '' : v.value).trim().replace(',', '.');
        if (t === '') return;           // empty rows are ignored
        var x = Number(t);
        if (!isFinite(x)) { st.errors[v.id] = 1; bad = true; return; }
        out.push({ param: v.param, comp: v.comp || null, value: x, unit: paramMeta(v.param).unit || '' });
      });
      return { values: out, bad: bad };
    }
    function run() {
      if (!Rg.available()) return;
      var rv = readValues();
      if (rv.bad) { drawGrid(); U.toast('A value is not a number.', { error: true }); return; }
      if (!rv.values.length) { U.set(resBox, h('p.k-hint', { text: 'Enter at least one value.' })); return; }
      var my = ++seq;
      // the values, the mode and the option travel in the URL, so a result can be shared, bookmarked and reloaded
      st.vkey = rv.values.map(function (v) { return v.param + ':' + (v.comp || '') + ':' + v.value; });
      R.go({ view: 'ranges', params: { v: st.vkey, m: st.mode === 'any' ? 'any' : '', s: st.strict ? '1' : '', p: st.pid || '' } }, { silent: true, replace: true });
      st.busy = true; U.set(resBox, K.busy('Comparing with the claim ranges …'));
      // give the busy line a chance to paint before the scan
      setTimeout(function () {
        Rg.check(rv.values, { mode: st.mode, strict: st.strict }).then(function (res) {
          if (dead || my !== seq) return;
          st.busy = false; st.res = res; drawResults();
        }, function (e) { if (dead || my !== seq) return; st.busy = false; U.set(resBox, K.errBox(e, 'The check failed')); });
      }, 30);
    }
    function claimCard(c, App) {
      var pills = [h('span.pill.' + (c.verdict === 'all' ? 'crit' : 'warn'), { text: c.verdict === 'all' ? 'all values inside' : c.nInside + ' of ' + c.nValues + ' inside' }), h('span.tag', { text: c.indep ? 'independent' : 'dependent' })];
      if (c.inheritedAny) pills.push(h('span.tag', { title: 'At least one range comes from a claim this claim refers to', text: 'inherited range' }));
      var link = h('a.mono.k-pn', { href: App.patentHref(c.pn, { claim: c.claim, q: '' }), text: U.pnPretty(c.pn) + ' / claim ' + c.claim });
      var vl = h('ul.rg-vals');
      c.values.forEach(function (v) {
        var s = STATUS[v.status] || STATUS.no_range_in_claim;
        var li = h('li.rg-val-item', null,
          h('div.rg-val-head', null, h('span.rg-val-name', { text: v.paramLabel + (v.comp ? ' · ' + v.comp : '') }), h('span.rg-val-num.mono', { text: U.num(v.value) + (v.unit ? ' ' + v.unit : '') }), h('span.pill.' + s[1], { text: s[0] })));
        if (v.row) {
          li.appendChild(h('div.rg-val-range', null, h('span.faint', { text: v.status === 'inside' ? 'claimed range ' : 'nearest claimed range ' }), h('span.mono', { text: rangeLine(v.row) }),
            v.row.compLabel ? h('span.faint', { text: ' · ' + v.row.compLabel }) : (v.compUnknown ? h('span.tag', { title: 'The claim does not name a component next to this range, or the rules could not tell which', text: 'component not identified' }) : null), v.row.inherited ? h('span.tag.rg-inh', { text: 'from claim ' + v.row.fromClaim }) : null,
            v.basisUnknown ? h('span.tag', { title: 'The claim gives a bare "%": it does not say whether the range is by mol or by weight', text: 'basis not stated (mol or weight)' }) : null,
            v.row.approx && v.status !== 'inside' ? h('span.tag', { title: '"About" was read as the stated number; a court may read the range somewhat wider', text: '"about" can widen the range' }) : null));
          var ph = h('blockquote.rg-q', { text: 'Loading quote …' });
          li.appendChild(ph); loadQuote(v.row, ph);
        }
        vl.appendChild(li);
      });
      return h('article.rg-claim', null, h('div.rg-claim-head', null, link, h('span.rg-pills', null, pills)), vl);
    }
    function list(title, items, note) {
      var box = h('section.sec.rg-list', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: note }), h('h2.sec-title', { text: title + ' (' + U.num(items.length) + ')' }))));
      var holder = h('div.rg-cards'), more = h('div.k-more');
      box.appendChild(holder); box.appendChild(more);
      var shown = 0;
      function draw() {
        items.slice(shown, shown + PAGE).forEach(function (c) { holder.appendChild(claimCard(c, App)); });
        shown = Math.min(items.length, shown + PAGE);
        U.clear(more);
        if (shown < items.length) more.appendChild(h('button.btn', { type: 'button', onclick: draw }, 'Show ' + Math.min(PAGE, items.length - shown) + ' more of ' + U.num(items.length - shown)));
      }
      if (!items.length) holder.appendChild(h('p.k-hint', { text: 'None.' })); else draw();
      return box;
    }
    function csvRows(res) {
      var rows = [['publication', 'claim', 'independent', 'verdict', 'parameter', 'component', 'your value', 'unit', 'status', 'claimed range', 'range component', 'inherited from claim', 'quote (claim text)']];
      res.all.concat(res.partial).forEach(function (c) {
        c.values.forEach(function (v) {
          var r = v.row;
          rows.push([c.pn, c.claim, c.indep ? 'yes' : 'no', c.verdict === 'all' ? 'all inside' : 'partially inside', v.paramLabel, v.comp, v.value, v.unit, v.status + (v.compUnknown ? ' (component not identified)' : '') + (v.basisUnknown ? ' (basis not stated: mol or weight)' : ''), r ? rangeLine(r) : '', r ? r.compLabel : '', r && r.inherited ? r.fromClaim : '', r ? r.q : '']);
        });
      });
      return rows;
    }
    function drawResults() {
      var res = st.res; U.clear(resBox);
      if (!res) return;
      var cn = res.counts, any = st.mode === 'any';
      var n1 = any ? res.matches.length : res.all.length;
      resBox.appendChild(K.stats([['Claims, all values inside', U.num(res.counts.claimsAll)], ['Claims, partly inside', U.num(cn.claimsPartial)], ['Publications', U.num(cn.patents)], ['Values checked', U.num(res.values.length)]]));
      var csvBtn = h('button.btn.sm', { type: 'button', onclick: function () { U.saveFile('claim-range-check-' + K.fileStamp() + '.csv', U.csv(csvRows(res)), 'text/csv;charset=utf-8'); } }, U.icon('download'), 'Export CSV');
      resBox.appendChild(h('div.k-row.rg-tools', null, csvBtn, res.truncated ? h('span.k-hint', { text: 'Truncated: ' + [res.counts.claimsAll > res.all.length ? 'only the first ' + U.num(res.all.length) + ' of ' + U.num(res.counts.claimsAll) + ' claims with all values inside' : '', res.counts.claimsPartial > res.partial.length ? 'only the first ' + U.num(res.partial.length) + ' of ' + U.num(res.counts.claimsPartial) + ' partly inside' : ''].filter(Boolean).join(' and ') + ' are listed (list cap per kind); narrow the values or restrict the publications.' }) : null,
        res.skipped && res.skipped.length ? h('span.k-hint', { text: res.skipped.length + ' value(s) skipped: ' + res.skipped.map(function (s) { return s.reason; }).join('; ') }) : null));
      if (st.notes && st.notes.length) resBox.appendChild(h('p.notice', { text: st.notes.join(' ') }));
      if (!res.all.length && !res.partial.length) {
        resBox.appendChild(h('div.empty.rg-empty', null, h('p.overline', { text: 'No claim found' }), h('h3', { text: 'No claim states a range that contains these values' }),
          h('p', { text: 'That does not mean the values are free to use: claims whose ranges sit in formula images or tables, in words ("about half") or in ranges the rules do not read are not seen, and other claim features may apply.' })));
      } else {
        resBox.appendChild(list(any ? 'Claims with at least one value inside' : 'Claims with all values inside', any ? res.matches : res.all, any ? 'At least one value' : 'All values'));
        if (!any) resBox.appendChild(list('Claims with some values inside', res.partial, 'Partly inside'));
      }
      resBox.appendChild(limitsBox((st.res.mode === 'any' ? ['Mode "any value": a claim is listed when at least one of your values lies inside one of its ranges.'] : []).concat(st.res.strict ? ['Only ranges attributed to the value\'s component were used (option on): claims whose ranges have no identified component are not listed.'] : ['When a claim has no range attributed to a value\'s component, its ranges with no identified component were compared and are marked "component not identified": the range may belong to another component.'])));
    }

    /* ---------- controls */
    var modeSeg = h('div.seg', { role: 'group', 'aria-label': 'Match mode' });
    [['all', 'All values inside', 'A claim is listed first when each of your values lies inside a range of that claim'], ['any', 'Any value inside', 'List every claim in which at least one value lies inside a range']].forEach(function (m) {
      modeSeg.appendChild(h('button', { type: 'button', title: m[2], 'aria-pressed': String(st.mode === m[0]), data: { m: m[0] }, onclick: function () { st.mode = m[0]; Array.prototype.forEach.call(modeSeg.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === st.mode)); }); if (st.res) run(); } }, m[1]));
    });
    var looseChk = h('input.chk', { id: 'rg-loose', type: 'checkbox', checked: st.strict, onchange: function (ev) { st.strict = ev.target.checked; if (st.res) run(); } });
    var looseLbl = h('label.k-check.rg-loose', { 'for': 'rg-loose', title: 'By default, ranges whose component the rules could not identify (no component word nearby) are also compared when the claim has no range for the value\'s component. Tick to use only ranges attributed to the component.' }, looseChk, 'only ranges with identified component');
    var addBtn = h('button.btn.sm', { type: 'button', onclick: function () { st.vals.push(newVal()); drawGrid(); var el = gridBox.querySelector('.rg-row:last-child select'); if (el) el.focus(); } }, 'Add value');
    var exBtn = h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.pid = ''; st.pname = ''; st.vals = [newVal({ param: 'mol_pct', comp: 'ionizable_cationic', value: 50 }), newVal({ param: 'mol_pct', comp: 'peg', value: 1.5 }), newVal({ param: 'np_ratio', value: 6 }), newVal({ param: 'size_nm', value: 80 }), newVal({ param: 'pdi', value: 0.1 })]; drawProfiles(); drawGrid(); } }, 'Fill an example');
    var clrBtn = h('button.btn.quiet.sm', { type: 'button', onclick: function () { st.vals = [newVal()]; st.res = null; st.pname = ''; st.notes = []; drawProfiles(); drawGrid(); U.clear(resBox); } }, 'Clear');
    var goBtn = h('button.btn.primary', { type: 'button', onclick: run }, U.icon('search'), 'Check claims');
    // order of work: edit the values, set the options, then run
    var editRow = h('div.k-row.rg-edit', null, addBtn, exBtn, clrBtn);
    actions.appendChild(modeSeg); actions.appendChild(looseLbl); actions.appendChild(goBtn);

    function build() {
      if (!Rg.available()) {
        page.appendChild(h('div.empty.rg-empty', null, h('p.overline', { text: 'Not available' }), h('h3', { text: 'The range data is not part of this build' }),
          h('p', { text: 'Reason: ' + (Rg.reason() || 'not in this build') + '. The check needs the file with the numeric ranges of the claims. The other views are not affected.' })));
        return;
      }
      page.appendChild(K.sec('Your values', 'What should be compared', null, profBox, gridBox, editRow, actions));
      page.appendChild(resBox);
      st.vals = [newVal()];
      drawProfiles(); drawGrid();
      if (fromRoute(route)) return;
      var pid = route.params && route.params.p;
      if (pid) loadProfile(String(pid), true);
    }
    // #ranges--v<param:comp:value>-x...--m<any>--s<1>: restore the grid and run
    function fromRoute(r) {
      var P = (r && r.params) || {}, vs = R.list(P.v).map(String);
      if (!vs.length) return false;
      var known = {}; Rg.params().forEach(function (p) { known[p.id] = 1; });
      var vals = vs.map(function (x) { var a = x.split(':'); return a.length === 3 && Object.prototype.hasOwnProperty.call(known, a[0]) && a[2] !== '' && isFinite(Number(a[2])) ? newVal({ param: a[0], comp: a[1], value: a[2] }) : null; }).filter(Boolean);
      if (!vals.length) return false;
      st.vals = vals; st.mode = P.m === 'any' ? 'any' : 'all'; st.strict = P.s === '1'; st.pid = P.p ? String(P.p) : ''; st.pname = '';
      looseChk.checked = st.strict;
      Array.prototype.forEach.call(modeSeg.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === st.mode)); });
      st.vkey = vs;
      drawProfiles(); drawGrid(); run();
      return true;
    }
    // profiles for the select (kind "profiles"); a missing store just leaves the list empty
    var pre = St && St.list ? St.list('profiles').then(function (l) { st.profiles = (l || []).filter(function (p) { return p && Array.isArray(p.lipids); }); }, function () { st.profiles = []; }) : Promise.resolve();
    page.appendChild(K.busy('Loading the range data …'));
    var ready = Promise.all([Rg.init(), pre]).then(function () {
      if (dead) return;
      var busy = page.querySelector('.k-busy'); if (busy) busy.remove();
      build();
    }, function (e) { if (!dead) { var b = page.querySelector('.k-busy'); if (b) b.remove(); page.appendChild(K.errBox(e, 'Range data')); } });

    return {
      update: function (r) {
        route = r;
        if (!Rg.available()) return true;
        var vs = R.list(r.params && r.params.v).map(String);
        if (vs.length && vs.join('|') !== (st.vkey || []).join('|')) { fromRoute(r); return true; }
        if (vs.length) return true;
        var pid = r.params && r.params.p;
        if (pid && String(pid) !== st.pid && Rg.available()) { loadProfile(String(pid), true); return true; }
        return true;
      },
      destroy: function () { dead = true; seq++; }
    };
  }

  // the patent-page panel is registered as soon as this file runs; the range data is loaded lazily (on the first render of the panel or a visit to #ranges)
  registerPanel();
  g.LnpApp.registerView({ id: 'ranges', title: 'Range check', icon: 'filter', rail: false, parent: 'tools', mount: g.LnpLazyView('ranges', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
