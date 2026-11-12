/* LNP Patent Desk: Markush check. Route: #markush[-<pn>][--c<claim>][--q<molecule>][--b1]
   Checks one molecule against the drawn general formula (Markush formula) of a claim. The rule record (engine
   x-markush.js, LnpMarkush) comes from a curated seed, from a Claude translation or from the manual rule editor;
   the verdict is computed by code and every variable shows its verbatim quote with the result of the quote check.
   b1 = batch tab. Also registers LnpApp.ext.claimAction ("Check Markush") and LnpApp.ext.compoundAction.
   Patent text is untrusted: it is only ever inserted as text, never as markup. */
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

  /* ------------------------------------------------------------ vocabulary */
  var VERDICT = { covered: ['Covered', 'crit'], not_covered: ['Not covered', 'good'], unclear: ['Unclear', 'warn'] };
  var GROUP = { met: ['met', 'crit'], not_met: ['not met', 'good'], unclear: ['unclear', 'warn'], 'n/a': ['not present', 'hollow'] };   // same as LnpKit.RULE_VERDICT (kit may load later)
  var QS = { ok: 'verified in the claim text', elided: 'elided quote, not verified', approx: 'wording differs, not verified', fail: 'not found in the claim text', empty: 'no quote', manual: 'your own rule', unverified: 'not verified' };
  var ORIGIN = { curated: ['curated', 'info'], claude: ['Claude', 'warn'], manual: ['manual', 'hollow'] };
  var KINDS = [['substituent', 'substituent'], ['divalent', 'divalent (linker)'], ['repeat', 'repeat unit']];
  var EFFECTS = [['', 'effect not stated'], ['broadens', 'broadens the claim'], ['narrows', 'narrows the claim'], ['unknown', 'unknown effect']];
  var NUMF = [['cMin', 'C min'], ['cMax', 'C max'], ['dblMin', 'C=C min'], ['dblMax', 'C=C max'], ['tripleMax', 'C#C max']];
  var NO_NUM = { H: 1, halogen: 1, smiles: 1, smarts: 1, any: 1 };

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function str(x) { return x == null ? '' : String(x); }
  function dummify(s) { return str(s).replace(/\[\*(?::(\d+))?\]|\*/g, function (m, n) { return n ? '[U:' + n + ']' : '[U]'; }); }
  function isImage(f) { return f && /^image\//.test(f.type || ''); }
  function qsNode(s) { return h('span.mk-qs', { data: { s: s }, text: QS[s] || s }); }
  function pill(map, key, extra) { var x = map[key] || [String(key || '').replace(/_/g, ' ') || '-', 'hollow']; return h('span.pill.' + x[1], { text: x[0] + (extra || '') }); }
  function fmtDate(d) { var s = str(d).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? U.date(s) : ''; }

  /* depiction of a core, fragment or alternative: attachment points are drawn as "U" atoms, then relabelled */
  function depict(smiles, w, hh, fallback) {
    var box = h('div.k-mol', { style: { height: hh + 'px' } });
    var s = str(smiles);
    if (!s || !g.LnpChem) { if (fallback) box.appendChild(h('span.faint.mono', { text: fallback })); return box; }
    Promise.resolve().then(function () { return g.LnpChem.svg(dummify(s), w, hh); }).then(function (svg) {
      svg = String(svg).replace(/>U</g, '>R<');
      var n = U.svgNode(svg);
      if (n) U.set(box, n); else U.set(box, h('span.faint.mono', { text: fallback || s }));
    }, function () { U.set(box, h('span.faint.mono', { text: fallback || 'no depiction' })); });
    return box;
  }

  /* the rule of one alternative in words (built from the record, not from the model's own wording) */
  function altText(a) {
    var t = a.type, s = [];
    if (t === 'H') return 'H';
    if (t === 'halogen') return 'halogen' + (a.hetero && a.hetero.length ? ' (' + a.hetero.join(', ') + ')' : '');
    if (t === 'smiles') return /^\*{1,2}$/.test(str(a.smiles)) && a.smiles === '**' ? 'direct bond' : 'exactly ' + str(a.smiles);
    if (t === 'smarts') return 'matches pattern ' + str(a.smarts);
    if (t === 'any') return 'any group';
    s.push(t);
    if (a.cMin != null && a.cMax != null) s.push(a.cMin === a.cMax ? 'C' + a.cMin : 'C' + a.cMin + '-C' + a.cMax);
    else if (a.cMin != null) s.push('at least C' + a.cMin); else if (a.cMax != null) s.push('up to C' + a.cMax);
    if (a.dblMin != null || a.dblMax != null) s.push((a.dblMin != null ? a.dblMin : 0) + (a.dblMax != null && a.dblMax !== a.dblMin ? '-' + a.dblMax : '') + ' C=C');
    if (a.tripleMax != null) s.push('up to ' + a.tripleMax + ' C#C');
    if (a.branched === true) s.push('branched'); else if (a.branched === false) s.push('linear');
    if (a.substituted === false) s.push('unsubstituted'); else if (a.substituted === true) s.push('substituted');
    if (a.hetero && a.hetero.length) s.push('hetero: ' + a.hetero.join(', '));
    return s.join(', ');
  }
  function ruleText(v) {
    if (!v) return '';
    if (v.kind === 'repeat') {
      var r = v.range || {};
      return 'n = ' + (r.min != null ? r.min : '?') + (r.max != null && r.max !== r.min ? '-' + r.max : '') + ' of ' + str(v.unit) + (v.optional ? ' (optional)' : '');
    }
    var alts = (v.alts || []).map(altText);
    return (alts.length ? alts.join(' | ') : 'no alternatives given') + (v.optional ? ' (optional)' : '');
  }

  function mount(host, route, App) {
    var K = g.LnpKit, Ch = g.LnpChem, D = g.LnpData, Mk = g.LnpMarkush, AI = g.LnpAI, Se = g.LnpSearch, St = g.LnpStore;
    var st = { q: '', parsed: null, pn: '', p: -1, P: null, claims: [], claim: null, defs: [], base: null, rec: null, dirty: false, uploads: [], coreMachine: false,
      result: null, tab: 'check', ai: false, aiLim: null, tctl: null, ocsr: {} };
    var dead = false, urls = [], seq = { mol: 0, pat: 0, chk: 0 }, editor = null, editorWanted = false, quietEditor = false, lastSmiles = '', docPaste = null;
    var bt = { ctl: null, results: [], queue: [], running: false };

    var urlMap = {};
    function url(blob, key) { if (key && urlMap[key]) return urlMap[key]; var u = URL.createObjectURL(blob); urls.push(u); if (key) urlMap[key] = u; return u; }
    function revokeAll() { urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }); urls = []; urlMap = {}; }
    function snapshotDate() { var b = D && D.manifest && D.manifest.built; return fmtDate(b) || str(b).slice(0, 10) || 'unknown'; }

    /* ---------------------------------------------------------- route <-> state */
    function toRoute() { return { view: 'markush', arg: st.pn || '', params: { c: st.claim != null ? String(st.claim) : '', q: st.q, b: st.tab === 'batch' ? '1' : '' } }; }
    function push() { R.go(toRoute(), { silent: true, replace: true }); }

    /* ---------------------------------------------------------- skeleton */
    var qIn = h('input.input.mono', { id: 'mk-q', type: 'text', placeholder: 'SMILES, reference lipid (SM-102, ALC-0315 ...) or SCHEMBL number', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Molecule as SMILES, name or SCHEMBL number' });
    var qForm = h('form.k-qrow', { onsubmit: function (ev) { ev.preventDefault(); setMolecule(qIn.value.trim()); } }, qIn, h('button.btn.primary', { type: 'submit' }, U.icon('check'), 'Check'));
    var chips = h('div.k-chips', { 'aria-label': 'Reference lipids as examples' });
    var molPrev = h('div.mk-molprev', { 'aria-live': 'polite' });
    var edHost = h('div.k-editor'), edState = h('p.k-hint', { text: 'The editor loads when opened.' });
    var edFold = h('details.k-fold', null, h('summary', null, U.icon('structure'), h('span', { text: 'Draw structure' })), h('div.k-fold-body', null, edHost, edState));
    edFold.addEventListener('toggle', function () { if (edFold.open) openEditor(); });

    var tabCheck = h('button', { type: 'button', onclick: function () { setTab('check'); } }, 'One claim'), tabBatch = h('button', { type: 'button', onclick: function () { setTab('batch'); } }, 'Batch');
    var tabs = h('div.seg.mk-tabs', { role: 'group', 'aria-label': 'Mode' }, tabCheck, tabBatch);

    // check tab
    var pnIn = h('input.input.mono', { id: 'mk-pn', type: 'text', placeholder: 'Publication number, e.g. EP3350157B1', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Publication number' });
    var pnForm = h('form.k-qrow', { onsubmit: function (ev) { ev.preventDefault(); loadPatent(pnIn.value.trim()); } }, pnIn, h('button.btn', { type: 'submit' }, U.icon('search'), 'Load'));
    var pickBox = h('div.mk-pick');
    var recBox = h('div.mk-rec');
    var edBox = h('div.mk-edbox');
    var resBox = h('div.mk-res', { 'aria-live': 'polite' });
    var left = h('div.mk-col', null,
      K.sec('Step 2', 'Patent and claim', null, pnForm, pickBox),
      K.sec('Step 3', 'Reading of the formula', null, recBox, edBox));
    var right = h('div.mk-col.mk-colr', null, K.sec('Step 4', 'Result', null, resBox));
    var checkView = h('div.mk-cols', null, left, right);
    var batchView = h('div.mk-batch', { hidden: true });

    var page = h('div.page.k-page.mk-page', null,
      K.head('Markush check', 'Is this molecule inside', 'the claimed formula?', 'Takes one molecule and the drawn general formula of a patent claim. The formula is read into rules (Claude, curated or by hand); code then checks the molecule against every variable and shows the claim text behind each rule.'),
      K.sec('Step 1', 'Molecule', null, qForm, chips, molPrev, edFold),
      tabs, checkView, batchView);
    host.appendChild(page);

    function setTab(t) {
      st.tab = t === 'batch' ? 'batch' : 'check';
      tabCheck.setAttribute('aria-pressed', st.tab === 'check' ? 'true' : 'false'); tabBatch.setAttribute('aria-pressed', st.tab === 'batch' ? 'true' : 'false');
      checkView.hidden = st.tab !== 'check'; batchView.hidden = st.tab !== 'batch';
      if (st.tab === 'batch') drawBatch();
      push();
    }

    /* ---------------------------------------------------------- molecule */
    Ch.names().then(function (names) {
      if (dead) return;
      names.forEach(function (n) { chips.appendChild(h('button.chip', { type: 'button', title: n.role || '', onclick: function () { setMolecule(n.name); } }, n.name)); });
    }, function () { /* the chips are optional */ });

    function setMolecule(q, quiet) {
      st.q = str(q).trim(); qIn.value = st.q;
      var my = ++seq.mol; st.parsed = null; U.clear(molPrev);
      if (!st.q) { st.molP = null; runCheck(); return Promise.resolve(); }
      if (!quiet) push();
      return (st.molP = Ch.parse(st.q)).then(function (p) {
        if (my !== seq.mol || dead) return;
        if (!p || !p.ok) { U.set(molPrev, h('p.notice.err', { text: 'The input was not recognised as a structure' + (p && p.error ? ': ' + K.chemErr(p.error) : '') + '. Accepted are SMILES, the name of a reference lipid or a SCHEMBL number.' })); runCheck(); return; }
        st.parsed = p;
        U.set(molPrev, h('div.mk-molbox', null, K.mol(p.smiles || st.q, 260, 120, p.formula), h('p.k-sub', { text: (p.name ? p.name + ' - ' : p.id ? p.id + ' - ' : '') + (p.formula || '') + (p.mw ? ' - ' + U.num(Math.round(p.mw * 10) / 10) + ' g/mol' : '') })));
        setEditorSmiles(p.smiles);
        runCheck(); if (st.tab === 'batch') drawBatch();
      }, function (e) { if (my === seq.mol && !dead) { U.set(molPrev, K.errBox(e)); runCheck(); } });
    }
    function openEditor() {
      if (editor || editorWanted) return;
      editorWanted = true; edState.textContent = 'Loading editor ...';
      Ch.editor(edHost, { smiles: '', onChange: U.debounce(function (s) {
        if (quietEditor || dead) return;
        if (s && !s.empty && s.smiles && s.smiles !== st.q) setMolecule(s.smiles);
      }, 500) }).then(function (ed) {
        if (dead) { ed.destroy(); return; }
        editor = ed; edState.textContent = 'The drawing replaces the molecule in the field above.'; setEditorSmiles(lastSmiles);
      }, function (e) { editorWanted = false; edState.textContent = 'The editor could not be loaded: ' + U.errText(e); });
    }
    function setEditorSmiles(s) {
      lastSmiles = s || '';
      if (!editor) return;
      quietEditor = true;
      try { editor.setSmiles(lastSmiles); } catch (e) { /* keep the drawing */ }
      setTimeout(function () { quietEditor = false; }, 700);
    }

    /* ---------------------------------------------------------- patent and claim picker */
    function loadPatent(text, wantClaim) {
      var my = ++seq.pat;
      st.pn = ''; st.p = -1; st.P = null; st.claims = []; st.claim = null; st.base = null; st.rec = null; st.dirty = false; st.defs = []; st.uploads = []; st.ocsr = {};
      U.clear(pickBox); U.clear(recBox); U.clear(edBox); st.result = null; drawResult();
      if (!text) { push(); return Promise.resolve(); }
      U.set(pickBox, K.busy('Loading the publication'));
      return Promise.resolve(D.byPn(text)).then(function (p) {
        if (my !== seq.pat || dead) return null;
        if (p < 0) { U.set(pickBox, h('p.notice.err', { text: 'This publication number is not in the dataset of this build.' })); return null; }
        return D.patent(p).then(function (P) {
          if (my !== seq.pat || dead) return null;
          st.p = p; st.P = P; st.pn = P.pn; pnIn.value = P.pn;
          return Promise.all([Mk.claimsWithFormula(p), Promise.resolve(Se.defs ? Se.defs(p) : []).then(function (d) { return d || []; }, function () { return []; })]).then(function (r) {
            if (my !== seq.pat || dead) return null;
            st.claims = r[0]; st.defs = r[1];
            var n = wantClaim != null && wantClaim !== '' ? Number(wantClaim) : (st.claims[0] ? st.claims[0].n : null);
            if (!st.claims.some(function (c) { return c.n === n; })) n = st.claims[0] ? st.claims[0].n : null;
            return selectClaim(n);
          });
        });
      }).then(null, function (e) { if (my === seq.pat && !dead) U.set(pickBox, K.errBox(e, 'The publication could not be loaded')); });
    }
    function curClaim() { for (var i = 0; i < st.claims.length; i++) if (st.claims[i].n === st.claim) return st.claims[i]; return null; }

    function selectClaim(n) {
      revokeAll(); st.claim = n; st.base = null; st.rec = null; st.dirty = false; st.uploads = []; st.ocsr = {}; st.coreMachine = false; st.result = null;
      push(); drawPicker();
      if (n == null) { drawRecord(); drawResult(); return Promise.resolve(); }
      var my = seq.pat;
      return Mk.get(st.pn, n).then(function (r) {
        if (dead || my !== seq.pat || st.claim !== n) return;
        st.base = r; st.rec = r ? clone(r) : null; st.dirty = false;
        drawRecord(); drawEditor(); runCheck();
      }, function (e) { drawRecord(); U.set(recBox, K.errBox(e, 'The stored record could not be read')); });
    }

    function allImages() { var c = curClaim(); return ((c && c.images) || []).concat(st.uploads); }
    function drawPicker() {
      U.clear(pickBox);
      if (st.P) pickBox.appendChild(h('p.k-sub', null, h('b.mono', { text: U.pnPretty ? U.pnPretty(st.P.pn) : st.P.pn }), ' ' + (st.P.title || ''), ' ', h('a', { href: App.patentHref(st.P.pn, { q: '' }), text: 'open the publication' })));
      if (!st.claims.length) {
        pickBox.appendChild(h('div.notice', null, h('p', { text: 'This publication has no independent claim with a formula in this build (no formula image and no "[chem]" placeholder in the claim text).' }), linksRow()));
        return;
      }
      var list = h('div.k-chips.mk-claims', { role: 'group', 'aria-label': 'Independent claims with a formula' });
      st.claims.forEach(function (c) {
        list.appendChild(h('button.chip' + (c.n === st.claim ? '.on' : ''), { type: 'button', 'aria-pressed': c.n === st.claim ? 'true' : 'false', onclick: function () { selectClaim(c.n); } }, 'Claim ' + c.n + (c.lang && c.lang !== 'en' ? ' (' + c.lang + ')' : '')));
      });
      pickBox.appendChild(list);
      var c = curClaim(); if (!c) return;
      var imgs = c.images || [];
      var textBox = h('div.mk-claimtext', null, h('p.overline', { text: 'Claim ' + c.n + ' (text)' }), h('pre.mk-pre', { text: str(c.text) }));
      var figs = h('div.mk-figs', null, h('p.overline', { text: 'Formula image' + (imgs.length + st.uploads.length === 1 ? '' : 's') }));
      imgs.forEach(function (im) { figs.appendChild(figure(im, false)); });
      st.uploads.forEach(function (im) { figs.appendChild(figure(im, true)); });
      if (!imgs.length) {
        figs.appendChild(h('p.notice', { text: 'formula image not in this build' + (c.placeholder ? ' (the claim text only has a placeholder where the formula was)' : '') + '. Add the image from the original publication by file or paste it, or enter the core by hand.' }));
      }
      figs.appendChild(uploadTools());
      figs.appendChild(linksRow());
      pickBox.appendChild(h('div.mk-claimgrid', null, textBox, figs));
    }
    function figure(im, uploaded) {
      var o = st.ocsr[im.id] || {};
      var fig = h('figure.mk-fig', null, h('img', { src: url(im.blob, (uploaded ? 'u:' : 'c:') + st.pn + ':' + st.claim + ':' + str(im.id)), alt: (uploaded ? 'Uploaded formula image' : 'Formula image from claim ' + st.claim + ' of ' + st.pn), loading: 'lazy' }),
        h('figcaption.mono', { text: (uploaded ? 'uploaded: ' : '') + str(im.id) + (im.w ? ' - ' + im.w + ' x ' + im.h + ' px' : '') }));
      if (st.ai) {
        var b = h('button.btn.sm', { type: 'button', disabled: !!o.busy, onclick: function () { runOcsr(im, b, note); } }, U.icon('spark'), 'Read structure with Claude');
        var note = h('div.mk-ocsr');
        fig.appendChild(b); fig.appendChild(note); if (o.node) note.appendChild(o.node);
      }
      return fig;
    }
    function linksRow() {
      var row = h('p.k-row.mk-links'), L = null;
      try { L = st.P && D.linksOf ? D.linksOf(st.P) : null; } catch (e) { L = null; }
      if (!L) return row;
      row.appendChild(h('span.k-hint', { text: 'Original:' }));
      [['espacenet', 'Espacenet'], ['google', 'Google Patents'], ['register', 'Register'], ['uspto', 'USPTO']].forEach(function (x) {
        if (L[x[0]] && /^https?:\/\//.test(L[x[0]])) row.appendChild(h('a', { href: L[x[0]], target: '_blank', rel: 'noopener noreferrer', text: x[1] }));
      });
      return row;
    }
    function uploadTools() {
      var zone = h('div.mk-paste', { tabindex: '0', role: 'group', 'aria-label': 'Paste an image here' }, h('span', { text: 'Paste an image here (Ctrl+V)' }));
      var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' }, 'aria-label': 'Choose a formula image' });
      file.addEventListener('change', function () { var f = file.files && file.files[0]; file.value = ''; addUpload(f); });
      zone.addEventListener('paste', function (ev) { onPaste(ev); });
      return h('div.mk-upload', null, h('button.btn.sm', { type: 'button', onclick: function () { file.click(); } }, U.icon('download'), 'Add image file'), file, zone);
    }
    function onPaste(ev) {
      var items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { ev.preventDefault(); addUpload(items[i].getAsFile()); return; }
    }
    docPaste = function (ev) {
      var t = ev.target && ev.target.tagName;
      if (dead || st.tab !== 'check' || st.claim == null || t === 'INPUT' || t === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
      onPaste(ev);
    };
    document.addEventListener('paste', docPaste);
    function addUpload(f) {
      if (!f) return;
      if (!isImage(f)) { U.toast('This is not an image file', { error: true }); return; }
      if (f.size > 5e6) { U.toast('The image is larger than 5 MB', { error: true }); return; }
      st.uploads.push({ id: 'upload-' + (st.uploads.length + 1), blob: f, w: 0, h: 0, uploaded: true });
      drawPicker(); drawRecord();
    }

    /* ---------------------------------------------------------- Claude: OCSR */
    function runOcsr(im, btn, note) {
      var my = st.claim;
      st.ocsr[im.id] = { busy: true }; btn.disabled = true; U.set(note, K.busy('Claude is reading the image (1 call, the image is sent)'));
      var c = curClaim();
      Mk.ocsr(im.blob, { hint: c ? 'Claim ' + c.n + ' of ' + st.pn : '' }).then(function (r) {
        if (dead || st.claim !== my) return;
        var node;
        if (!r.ok || !r.smiles) {
          node = h('div.notice.err', null, h('p', { text: 'The structure could not be read: ' + (r.errors && r.errors.length ? r.errors.join('; ') : 'no valid SMILES') + '. Enter the core by hand.' }));
        } else {
          node = h('div.mk-ocsr-ok', null, h('p', null, h('span.mk-machine', { text: 'machine-extracted' }), ' ', h('span.mono', { text: r.smiles })),
            h('p.k-hint', { text: 'Validated by OpenChemLib' + (r.formula ? ': ' + r.formula + (r.mw ? ', ' + r.mw + ' g/mol' : '') : '') + (r.dummies ? ', ' + r.dummies + ' attachment point(s)' : '') + '. Compare it with the image before you rely on it.' + (r.modelNote ? ' Claude noted: ' + r.modelNote : '') }));
          ensureRec();
          st.rec.core = st.rec.core || {}; st.rec.core.smiles = r.smiles; st.rec.core.note = 'machine-extracted from image ' + im.id + (r.modelNote ? ' (' + r.modelNote + ')' : '');
          st.coreMachine = true; st.dirty = true; drawRecord(); drawEditor(); runCheck();
        }
        st.ocsr[im.id] = { node: node }; U.set(note, node); btn.disabled = false;
      }, function (e) {
        if (dead || st.claim !== my) return;
        var node = h('p.notice.err', { text: msgOf(e) }); st.ocsr[im.id] = { node: node }; U.set(note, node); btn.disabled = false;
      });
    }
    function msgOf(e) { try { if (e && e.code && AI && AI.message && e.code !== 'molecule') return AI.message(e, 'en'); } catch (x) { /* fall through */ } return U.errText(e); }

    /* ---------------------------------------------------------- record header + actions */
    function ensureRec() {
      if (st.rec) return st.rec;
      var c = curClaim(), t = c ? str(c.text) : '';
      st.rec = { v: 'mk-1', pn: st.pn, claim: st.claim, lang: c && c.lang || 'en', origin: 'manual', reviewed: true,
        source: { images: ((c && c.images) || []).map(function (i) { return str(i.id); }), textHash: Mk._internal && Mk._internal.hash ? Mk._internal.hash(t) : '', claimText: t.slice(0, 20000), defsText: st.defs.length ? st.defs.join('\n').slice(0, 20000) : null },
        core: { smiles: '', note: null }, vars: [], provisos: [], unsupported: [] };
      st.dirty = true;
      return st.rec;
    }
    function aiNote() {
      var c = curClaim(), n = allImages().length, lim = st.aiLim, sendsImg = !!(lim && lim.images), len = c ? str(c.text).length : 0;
      return '1 call to Claude (plus 1 repair call only if the reply fails the checks). Sent: the claim text (' + U.num(len) + ' characters)' + (st.defs.length ? ', the definitions of the publication' : '') + (n && sendsImg ? ' and ' + n + ' formula image' + (n === 1 ? '' : 's') : '') + '.'
        + (n && !sendsImg ? ' Images cannot be sent in this session; the core will be a placeholder unless the text gives it.' : '');
    }
    function drawRecord() {
      U.clear(recBox);
      if (st.claim == null) { if (st.P) return; recBox.appendChild(h('p.k-hint', { text: 'Pick a publication and a claim first.' })); return; }
      var rec = st.rec, head = h('div.k-row.mk-rechead');
      if (rec) {
        head.appendChild(pill(ORIGIN, rec.origin, rec.origin === 'claude' ? (rec.reviewed ? ', reviewed' : ', not reviewed') : ''));
        if (rec.origin === 'claude' && !rec.reviewed) head.appendChild(h('span.pill.warn.hollow', { text: 'translation not reviewed' }));
        if (rec.origin === 'manual' && !rec.reviewed) head.appendChild(h('span.pill.hollow', { text: 'not reviewed' }));
        if (rec.updated) head.appendChild(h('span.k-hint', { text: 'updated ' + fmtDate(rec.updated) }));
        if (st.dirty) head.appendChild(h('span.pill.info.hollow', { text: 'unsaved changes' }));
        if (st.coreMachine) head.appendChild(h('span.mk-machine', { text: 'core machine-extracted' }));
        recBox.appendChild(head);
        if (rec.origin === 'curated') recBox.appendChild(h('p.k-hint', { text: 'Curated record: read from the claim image and claim text by hand. Saving an edited copy stores it as your own (manual) record.' }));
      } else {
        recBox.appendChild(h('p.k-sub', { text: 'No reading of this formula is stored yet.' }));
      }
      var row = h('div.k-row.mk-actions');
      if (st.ai) {
        var tb = h('button.btn' + (rec ? '' : '.primary'), { type: 'button', id: 'mk-translate', onclick: translate }, U.icon('spark'), rec ? 'Translate again with Claude' : 'Translate with Claude');
        row.appendChild(tb);
      }
      row.appendChild(h('button.btn', { type: 'button', id: 'mk-edit', onclick: function () { ensureRec(); drawRecord(); drawEditor(true); } }, U.icon('rows'), rec ? 'Edit by hand' : 'Enter rules by hand'));
      if (rec && st.dirty) row.appendChild(h('button.btn.primary', { type: 'button', id: 'mk-save', onclick: function () { save(false); } }, U.icon('save'), 'Save'));
      if (rec && rec.origin === 'claude' && !rec.reviewed) row.appendChild(h('button.btn', { type: 'button', id: 'mk-review', onclick: function () { st.rec.reviewed = true; save(true); } }, U.icon('check'), 'Mark as reviewed'));
      if (st.base && st.base.origin !== 'curated' && st.base.id) row.appendChild(h('button.btn.quiet', { type: 'button', onclick: removeRec }, U.icon('x'), 'Delete stored record'));
      recBox.appendChild(row);
      if (!st.ai) recBox.appendChild(h('p.notice.mk-manual', { id: 'mk-manual', text: 'Manual mode: Claude is not available in this session, so the formula cannot be translated automatically. Enter the core SMILES and the rules by hand.' }));
      else recBox.appendChild(h('p.k-hint', { text: aiNote() }));
      recBox.appendChild(h('div.mk-tstate', { id: 'mk-tstate', 'aria-live': 'polite' }));
    }
    function tstate(node) { var t = recBox.querySelector('#mk-tstate'); if (t) U.set(t, node); }

    function translate() {
      var c = curClaim(); if (!c || !st.ai) return;
      if (st.tctl) { try { st.tctl.abort(); } catch (e) { /* ignore */ } }
      var ctl = st.tctl = typeof AbortController !== 'undefined' ? new AbortController() : null, my = st.claim;
      var imgs = allImages();
      var cancel = h('button.btn.sm', { type: 'button', onclick: function () { if (ctl) ctl.abort(); } }, 'Cancel');
      tstate(h('div.k-row', null, K.busy('Claude is translating the claim (1 call)'), cancel));
      Mk.translate({ pn: st.pn, claim: st.claim, claimText: c.text, images: imgs.map(function (i) { return i.blob; }), imageIds: imgs.map(function (i) { return i.id; }), defs: st.defs, lang: c.lang || 'en', signal: ctl ? ctl.signal : undefined }).then(function (rec) {
        if (dead || st.claim !== my) return;
        st.rec = rec; st.dirty = true; st.coreMachine = false;
        drawRecord(); drawEditor(true); runCheck();
        tstate(h('p.notice', { text: 'Translation received (' + (rec.ai && rec.ai.calls ? rec.ai.calls + ' call' + (rec.ai.calls === 1 ? '' : 's') : '1 call') + (rec.ai && rec.ai.quoteProblems ? ', some quotes were not found in the claim text' : '') + '). It is a draft and not saved yet. Compare it with the claim before you rely on the verdict.' }));
      }, function (e) {
        if (dead || st.claim !== my) return;
        tstate(e && e.code === 'cancelled' ? h('p.k-hint', { text: 'Translation cancelled.' }) : h('p.notice.err', { text: msgOf(e) + ' You can still enter the rules by hand.' }));
        if (AI && AI.available && !AI.available()) { st.ai = false; drawRecord(); }
      });
    }
    function save(reviewed) {
      if (st.coreMachine && st.rec) { st.rec.origin = 'claude'; st.rec.reviewed = false; st.coreMachine = false; }
      var errs = Mk.validate(st.rec);
      if (errs.length) { U.toast('The record is not valid yet: ' + errs[0], { error: true }); return Promise.resolve(); }
      return Mk.put(st.rec).then(function (r) {
        if (dead) return;
        st.base = r; st.rec = clone(r); st.dirty = false; drawRecord(); drawEditor(); U.toast(reviewed ? 'Marked as reviewed and saved' : 'Record saved'); runCheck();
      }, function (e) { U.toast('The record could not be saved: ' + U.errText(e), { error: true }); });
    }
    function removeRec() {
      Mk.remove(st.pn, st.claim).then(function () { return Mk.get(st.pn, st.claim); }).then(function (r) {
        if (dead) return;
        st.base = r; st.rec = r ? clone(r) : null; st.dirty = false; drawRecord(); drawEditor(); runCheck(); U.toast('Stored record deleted');
      }, function (e) { U.toast(U.errText(e), { error: true }); });
    }

    /* ---------------------------------------------------------- rule editor */
    var edTab = 'form', painters = [], jsonTa = null, validBox = null, edOpen = false;
    function touch() {
      st.dirty = true;
      if (st.rec && st.rec.origin === 'manual') st.rec.reviewed = true;
      painters.forEach(function (f) { f(); });
      if (jsonTa && edTab === 'form') jsonTa.value = JSON.stringify(st.rec, null, 2);
      paintValid(); checkSoon();
      var sv = recBox.querySelector('#mk-save');
      if (!sv) drawRecord();
    }
    function qStatus(q) {
      var rec = st.rec, own = rec && rec.origin === 'manual';
      if (!str(q).trim()) return own ? 'manual' : 'empty';
      var src = [rec.source && rec.source.claimText, rec.source && rec.source.defsText].filter(Boolean);
      if (!src.length) return own ? 'manual' : 'unverified';
      var best = 'fail';
      src.forEach(function (t) { var r = Mk.verifyQuote(q, t); if (r.status === 'ok') best = 'ok'; else if (best !== 'ok' && r.status !== 'fail') best = r.status; });
      return best;
    }
    function qBox(obj, label) {
      var ta = h('textarea.textarea.mk-quote', { rows: '2', 'aria-label': label, value: str(obj.quote), placeholder: 'Verbatim text from the claim that defines this' });
      var badge = h('span.mk-qs');
      function paint() { var s = qStatus(obj.quote); badge.dataset.s = s; badge.textContent = QS[s] || s; }
      ta.addEventListener('input', function () { obj.quote = ta.value; paint(); touch(); });
      painters.push(paint); paint();
      return h('div.mk-qwrap', null, ta, badge);
    }
    function fld(label, control, cls) { return h('label.mk-f' + (cls ? '.' + cls : ''), null, h('span', { text: label }), control); }
    function txt(val, on, o) {
      o = o || {};
      var i = h('input.input' + (o.mono ? '.mono' : ''), { type: 'text', value: str(val), placeholder: o.ph || null, 'aria-label': o.label || null, autocomplete: 'off', spellcheck: 'false' });
      i.addEventListener('input', function () { on(i.value); }); return i;
    }
    function numIn(val, on, label) {
      var i = h('input.input.mk-num', { type: 'number', step: '1', value: val == null ? '' : String(val), 'aria-label': label });
      i.addEventListener('input', function () { on(i.value === '' ? null : Number(i.value)); }); return i;
    }
    function sel(opts, val, on, label) {
      var s = h('select.select', { 'aria-label': label });
      opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); });
      s.value = val; s.addEventListener('change', function () { on(s.value); }); return s;
    }
    function tri(v) { return v === true ? 'y' : v === false ? 'n' : ''; }
    function untri(s) { return s === 'y' ? true : s === 'n' ? false : null; }
    function setNum(o, k, v) { if (v == null || !isFinite(v)) delete o[k]; else o[k] = v; }

    function altRow(v, a, list) {
      var nums = h('div.mk-nums'), body = h('div.mk-altfields');
      NUMF.forEach(function (f) { nums.appendChild(fld(f[1], numIn(a[f[0]], function (x) { setNum(a, f[0], x); touch(); }, f[1]))); });
      var smi = fld('SMILES (attachment as *)', txt(a.smiles, function (x) { a.smiles = x; touch(); }, { mono: true, label: 'Alternative SMILES' }), 'mk-wide');
      var sma = fld('SMARTS', txt(a.smarts, function (x) { a.smarts = x; touch(); }, { mono: true, label: 'Alternative SMARTS' }), 'mk-wide');
      var br = fld('Branched', sel([['', 'either'], ['y', 'branched'], ['n', 'linear']], tri(a.branched), function (x) { a.branched = untri(x); touch(); }, 'Branched'));
      var su = fld('Substituents', sel([['', 'optional'], ['n', 'none (plain group)'], ['y', 'required']], tri(a.substituted), function (x) { a.substituted = untri(x); touch(); }, 'Substituted'));
      var he = fld('Hetero atoms', txt((a.hetero || []).join(','), function (x) { var l = x.split(/[,\s]+/).filter(Boolean); if (l.length) a.hetero = l; else delete a.hetero; touch(); }, { ph: 'O,N', label: 'Hetero atoms' }));
      body.appendChild(nums); body.appendChild(h('div.mk-nums', null, br, su, he)); body.appendChild(smi); body.appendChild(sma);
      function show() { var t = a.type; nums.hidden = !!NO_NUM[t]; smi.hidden = t !== 'smiles'; sma.hidden = t !== 'smarts'; br.hidden = su.hidden = he.hidden = !!NO_NUM[t] && t !== 'halogen'; if (t === 'halogen') { br.hidden = su.hidden = true; he.hidden = false; } }
      var ts = sel((Mk.ALT_TYPES || []).map(function (t) { return [t, t]; }), a.type || 'alkyl', function (x) { a.type = x; show(); touch(); }, 'Type of alternative');
      var del = h('button.btn.quiet.sm', { type: 'button', 'aria-label': 'Remove alternative', onclick: function () { var i = list.indexOf(a); if (i >= 0) list.splice(i, 1); touch(); drawEditor(); } }, U.icon('x'));
      show();
      return h('div.mk-alt', null, h('div.k-row', null, ts, del), body);
    }
    function varCard(v, i) {
      v.alts = v.alts || [];
      var altsBox = h('div.mk-alts'), repBox = h('div.mk-rep'), altHead = h('div');
      v.alts.forEach(function (a) { altsBox.appendChild(altRow(v, a, v.alts)); });
      var addAlt = h('button.btn.sm', { type: 'button', onclick: function () { v.alts.push({ type: 'alkyl' }); touch(); drawEditor(); } }, U.icon('check'), 'Add alternative');
      altHead.appendChild(h('p.overline', { text: 'Allowed alternatives (any one)' })); altHead.appendChild(altsBox); altHead.appendChild(addAlt);
      repBox.appendChild(fld('Repeat unit (SMILES)', txt(v.unit, function (x) { v.unit = x; touch(); }, { mono: true, label: 'Repeat unit' }), 'mk-wide'));
      v.range = v.range || {};
      repBox.appendChild(fld('n min', numIn(v.range.min, function (x) { setNum(v.range, 'min', x); touch(); }, 'n min')));
      repBox.appendChild(fld('n max', numIn(v.range.max, function (x) { setNum(v.range, 'max', x); touch(); }, 'n max')));
      function showKind() { repBox.hidden = v.kind !== 'repeat'; altHead.hidden = v.kind === 'repeat'; }
      var optc = h('input.chk', { type: 'checkbox', checked: !!v.optional, 'aria-label': 'Optional' });
      optc.addEventListener('change', function () { v.optional = optc.checked; touch(); });
      var del = h('button.btn.quiet.sm', { type: 'button', 'aria-label': 'Remove variable ' + str(v.name), onclick: function () { st.rec.vars.splice(i, 1); touch(); drawEditor(); } }, U.icon('x'), 'Remove');
      showKind();
      return h('details.k-fold.mk-var', { open: st.rec.vars.length <= 4 }, h('summary', null, h('span.mono.mk-vname', { text: str(v.name) || 'new variable' }), h('span.k-hint', { text: ruleText(v) })),
        h('div.k-fold-body', null,
          h('div.mk-vgrid', null,
            fld('Name', txt(v.name, function (x) { v.name = x; touch(); }, { mono: true, label: 'Variable name' })),
            fld('Kind', sel(KINDS, v.kind || 'substituent', function (x) { v.kind = x; showKind(); touch(); }, 'Kind')),
            fld('Attachment numbers', txt((v.attach || []).join(', '), function (x) { v.attach = x.split(/[,\s]+/).filter(Boolean).map(Number).filter(function (n) { return isFinite(n); }); touch(); }, { mono: true, ph: '1, 2', label: 'Attachment numbers' })),
            h('label.k-check', null, optc, 'optional (may be absent)')),
          fld('Quote from the claim', qBox(v, 'Quote for ' + str(v.name)), 'mk-wide'),
          repBox, altHead, h('div.k-row', null, del)));
    }
    function provisoCard(p, i) {
      var type = p.smiles != null ? 'smiles' : p.smarts != null ? 'smarts' : p.when ? 'when' : 'text';
      var val = type === 'smiles' ? p.smiles : type === 'smarts' ? p.smarts : type === 'when' ? JSON.stringify(p.when) : '';
      var vin = txt(val, function () { }, { mono: true, label: 'Proviso value' }), cur = type;
      function apply() {
        delete p.smiles; delete p.smarts; delete p.when;
        var x = vin.value;
        if (cur === 'smiles') p.smiles = x; else if (cur === 'smarts') p.smarts = x;
        else if (cur === 'when') { try { p.when = JSON.parse(x || '[]'); vin.removeAttribute('aria-invalid'); } catch (e) { vin.setAttribute('aria-invalid', 'true'); return; } }
        touch();
      }
      vin.addEventListener('input', apply);
      var ts = sel([['smiles', 'excluded compound (SMILES)'], ['smarts', 'excluded pattern (SMARTS)'], ['when', 'excluded combination (JSON)'], ['text', 'text only (not checked)']], type, function (x) { cur = x; vin.hidden = x === 'text'; apply(); }, 'Kind of proviso');
      vin.hidden = type === 'text';
      p.effect = 'exclude';
      return h('div.mk-prov', null, h('div.k-row', null, ts, vin, h('button.btn.quiet.sm', { type: 'button', 'aria-label': 'Remove proviso', onclick: function () { st.rec.provisos.splice(i, 1); touch(); drawEditor(); } }, U.icon('x'))), qBox(p, 'Quote of the proviso'));
    }
    function unsupRow(u, i) {
      var obj = typeof u === 'string' ? { text: u } : u;
      function write() {
        var vars = (obj.vars || []), eff = obj.effect || '';
        st.rec.unsupported[i] = (vars.length || eff) ? { text: obj.text || '', vars: vars, effect: eff || 'unknown' } : (obj.text || '');
        touch();
      }
      return h('div.mk-unsup', null,
        txt(obj.text, function (x) { obj.text = x; write(); }, { label: 'Part of the claim the format cannot express' }),
        txt((obj.vars || []).join(','), function (x) { obj.vars = x.split(/[,\s]+/).filter(Boolean); write(); }, { ph: 'variables, e.g. R8,R9', label: 'Affected variables' }),
        sel(EFFECTS, obj.effect || '', function (x) { obj.effect = x; write(); }, 'Effect'),
        h('button.btn.quiet.sm', { type: 'button', 'aria-label': 'Remove note', onclick: function () { st.rec.unsupported.splice(i, 1); touch(); drawEditor(); } }, U.icon('x')));
    }
    function paintValid() {
      if (!validBox) return;
      var errs = []; try { errs = Mk.validate(st.rec); } catch (e) { errs = [U.errText(e)]; }
      U.clear(validBox);
      if (!errs.length) validBox.appendChild(h('p.k-row', null, h('span.pill.good', { text: 'valid' }), h('span.k-hint', { text: 'The record is valid.' })));
      else validBox.appendChild(h('div.notice.err', null, h('p', { text: errs.length + ' problem' + (errs.length === 1 ? '' : 's') + ' in the record' }), h('ul', null, errs.slice(0, 12).map(function (m) { return h('li', { text: m }); }))));
    }
    function drawEditor(open) {
      if (open) edOpen = true;
      var keep = edBox.querySelector('details.mk-editor'); if (keep && !open) edOpen = keep.open;
      U.clear(edBox); painters = []; jsonTa = null; validBox = null;
      if (!st.rec) return;
      var rec = st.rec;
      var coreIn = txt(rec.core && rec.core.smiles, function (x) {
        rec.core = rec.core || {}; rec.core.smiles = x;
        if (st.coreMachine) { st.coreMachine = false; if (/^machine-extracted/.test(str(rec.core.note))) rec.core.note = null; var m = recBox.querySelector('.mk-machine'); if (m) m.remove(); }
        coreDep(); touch();
      }, { mono: true, ph: 'e.g. CCN(C[*:1])C[*:2]', label: 'Core SMILES with attachment points' });
      coreIn.id = 'mk-core';
      var coreBox = h('div.mk-coredep');
      var cdSeq = 0;
      function coreDep() { var my = ++cdSeq; setTimeout(function () { if (my !== cdSeq || dead) return; U.set(coreBox, str(rec.core && rec.core.smiles) && !/^\[?\*\]?$/.test(str(rec.core.smiles).trim()) ? depict(rec.core.smiles, 280, 120, rec.core.smiles) : null); }, 250); }
      coreDep();
      var coreSec = h('div.mk-coresec', null, fld('Core SMILES (each variable position is [*:n], n unique)', coreIn, 'mk-wide'), st.coreMachine ? h('p.k-hint', null, h('span.mk-machine', { text: 'machine-extracted' }), ' Read from the image by Claude; check it against the image. ', h('button.btn.sm', { type: 'button', id: 'mk-core-confirm', onclick: function () { st.coreMachine = false; if (/^machine-extracted/.test(str(rec.core.note))) rec.core.note = 'machine-extracted, checked against the image by the user'; drawRecord(); drawEditor(true); runCheck(); } }, 'I checked the core against the image')) : null, coreBox,
        fld('Note on the core', txt(rec.core && rec.core.note, function (x) { rec.core = rec.core || {}; rec.core.note = x || null; touch(); }, { label: 'Note on the core' })));
      var varsBox = h('div.mk-vars'); rec.vars = rec.vars || [];
      rec.vars.forEach(function (v, i) { varsBox.appendChild(varCard(v, i)); });
      var provBox = h('div.mk-provs'); rec.provisos = rec.provisos || [];
      rec.provisos.forEach(function (p, i) { provBox.appendChild(provisoCard(p, i)); });
      var unBox = h('div.mk-unsups'); rec.unsupported = rec.unsupported || [];
      rec.unsupported.forEach(function (u, i) { unBox.appendChild(unsupRow(u, i)); });
      validBox = h('div.mk-valid');
      var form = h('div.mk-form', null,
        coreSec,
        h('h3.mk-h3', { text: 'Variables' }), varsBox, h('button.btn.sm', { type: 'button', id: 'mk-addvar', onclick: function () { rec.vars.push({ name: 'R' + (rec.vars.length + 1), kind: 'substituent', attach: [], optional: false, quote: '', alts: [{ type: 'alkyl' }] }); touch(); drawEditor(); } }, U.icon('check'), 'Add variable'),
        h('h3.mk-h3', { text: 'Provisos (excluded compounds)' }), provBox, h('button.btn.sm', { type: 'button', onclick: function () { rec.provisos.push({ quote: '', effect: 'exclude', smiles: '' }); touch(); drawEditor(); } }, U.icon('check'), 'Add proviso'),
        h('h3.mk-h3', { text: 'Not expressible (shown, not checked)' }), h('p.k-hint', { text: 'Parts of the claim the rule format cannot express, e.g. "R8 and R9 form a ring together". A note that names variables makes those variables unclear.' }), unBox, h('button.btn.sm', { type: 'button', onclick: function () { rec.unsupported.push(''); touch(); drawEditor(); } }, U.icon('check'), 'Add note'));
      jsonTa = h('textarea.textarea.mono.mk-json', { rows: '16', spellcheck: 'false', 'aria-label': 'Record as JSON', value: JSON.stringify(rec, null, 2) });
      var jsonMsg = h('div.mk-jsonmsg');
      var jsonBox = h('div.mk-jsonbox', null, jsonTa, jsonMsg, h('div.k-row', null, h('button.btn', { type: 'button', id: 'mk-json-apply', onclick: applyJson }, U.icon('check'), 'Apply JSON')));
      function jsonCheck() {
        var o; try { o = JSON.parse(jsonTa.value); } catch (e) { U.set(jsonMsg, h('p.notice.err', { text: 'Not valid JSON: ' + e.message })); return null; }
        var errs = []; try { errs = Mk.validate(o); } catch (e2) { errs = [U.errText(e2)]; }
        if (errs.length) U.set(jsonMsg, h('div.notice.err', null, h('p', { text: 'JSON is well-formed but the record is not valid:' }), h('ul', null, errs.slice(0, 10).map(function (m) { return h('li', { text: m }); }))));
        else U.set(jsonMsg, h('p.k-row', null, h('span.pill.good', { text: 'valid' }), h('span.k-hint', { text: 'Apply it to use it.' })));
        return errs.length ? null : o;
      }
      jsonTa.addEventListener('input', U.debounce(jsonCheck, 300));
      function applyJson() {
        var o = jsonCheck(); if (!o) return;
        o.pn = st.pn; o.claim = st.claim;
        /* the source text, origin and review state come from the build and the current record, never from pasted JSON */
        var cc = curClaim(), t0 = cc ? str(cc.text) : '';
        o.origin = rec.origin === 'claude' ? 'claude' : 'manual';
        o.reviewed = o.origin === 'claude' ? !!rec.reviewed : true;
        o.source = { images: ((cc && cc.images) || []).map(function (i) { return str(i.id); }), textHash: Mk._internal && Mk._internal.hash ? Mk._internal.hash(t0) : '', claimText: t0.slice(0, 20000), defsText: st.defs.length ? st.defs.join('\n').slice(0, 20000) : null };
        st.rec = o; st.dirty = true; st.coreMachine = false; drawRecord(); drawEditor(true); runCheck();
      }
      var tf = h('button', { type: 'button', 'aria-pressed': edTab === 'form' ? 'true' : 'false', onclick: function () { setEd('form'); } }, 'Form'), tj = h('button', { type: 'button', id: 'mk-tab-json', 'aria-pressed': edTab === 'json' ? 'true' : 'false', onclick: function () { setEd('json'); } }, 'JSON');
      function setEd(t) { edTab = t; tf.setAttribute('aria-pressed', t === 'form' ? 'true' : 'false'); tj.setAttribute('aria-pressed', t === 'json' ? 'true' : 'false'); form.hidden = t !== 'form'; jsonBox.hidden = t !== 'json'; if (t === 'json') { jsonTa.value = JSON.stringify(st.rec, null, 2); jsonCheck(); } }
      form.hidden = edTab !== 'form'; jsonBox.hidden = edTab !== 'json';
      var det = h('details.k-fold.mk-editor', { open: edOpen || !st.base }, h('summary', null, U.icon('rows'), h('span', { text: 'Rule editor' })),
        h('div.k-fold-body', null, h('div.k-row', null, h('div.seg', { role: 'group', 'aria-label': 'Editor view' }, tf, tj)), form, jsonBox, validBox,
          h('div.k-row', null, h('button.btn.primary', { type: 'button', id: 'mk-save2', onclick: function () { save(false); } }, U.icon('save'), 'Save record'),
            h('button.btn', { type: 'button', onclick: function () { st.rec = st.base ? clone(st.base) : null; st.dirty = false; st.coreMachine = false; drawRecord(); drawEditor(); runCheck(); } }, 'Discard changes'),
            h('span.k-hint', { text: 'Saved in this browser (or in your Claude account when the host stores it).' }))));
      det.addEventListener('toggle', function () { edOpen = det.open; });
      edBox.appendChild(det);
      paintValid();
    }

    /* ---------------------------------------------------------- check + result */
    var checkSoon = U.debounce(function () { runCheck(); }, 450);
    function runCheck() {
      var my = ++seq.chk;
      if (!st.rec || !st.parsed || !st.parsed.ok) { st.result = null; st.err = null; drawResult(); return Promise.resolve(); }
      return Mk.ready().then(function () {
        var errs = Mk.validate(st.rec);
        if (errs.length) { if (my === seq.chk && !dead) { st.result = null; drawResult({ invalid: errs }); } return null; }
        var recIn = st.rec;
        if (st.coreMachine) { recIn = clone(st.rec); recIn.origin = 'claude'; recIn.reviewed = false; } /* a core read by the model alone is unreviewed AI output: the engine then holds 'not covered' as unclear */
        return Mk.check(recIn, st.parsed.smiles || st.q).then(function (res) { if (my === seq.chk && !dead) { st.result = res; drawResult(); } }, function (e) { if (my === seq.chk && !dead) { st.result = null; drawResult({ error: e }); } });
      }, function (e) { if (my === seq.chk && !dead) drawResult({ error: e }); });
    }
    function drawResult(o) {
      U.clear(resBox); o = o || {};
      var res = st.result;
      if (o.invalid) { resBox.appendChild(h('div.notice.err', null, h('p', { text: 'The rule record is not valid, so no check was run:' }), h('ul', null, o.invalid.slice(0, 8).map(function (m) { return h('li', { text: m }); })))); resBox.appendChild(limitsBox()); return; }
      if (o.error) { resBox.appendChild(h('p.notice.err', { text: (o.error.code === 'molecule' ? 'The molecule cannot be checked: ' : 'The check failed: ') + U.errText(o.error) })); resBox.appendChild(limitsBox()); return; }
      if (!res) {
        var why = !st.parsed ? 'Enter a molecule (step 1).' : st.claim == null ? 'Pick a publication and a claim with a formula (step 2).' : !st.rec ? 'Translate the claim with Claude or enter the rules by hand (step 3).' : 'Checking ...';
        resBox.appendChild(h('p.k-sub', { id: 'mk-empty', text: why })); resBox.appendChild(limitsBox()); return;
      }
      var raw = res.raw && res.raw !== res.overall ? res.raw : null;
      var head = h('div.k-row.mk-verdict', null, h('span', { id: 'mk-overall', data: { v: res.overall } }, pill(VERDICT, res.overall)),
        res.caveat === 'translation_not_reviewed' ? h('span.pill.warn.hollow', { id: 'mk-caveat', text: 'translation not reviewed' }) : res.caveat === 'no_core' ? h('span.pill.warn.hollow', { id: 'mk-caveat', text: 'core not available' }) : null,
        pill(ORIGIN, res.origin || (st.rec && st.rec.origin), ''), h('span.k-hint', { text: (res.ms != null ? Math.round(res.ms) + ' ms' : '') }));
      resBox.appendChild(head);
      // a met claim is the natural starting point of a design-around (#designs); only offered for "covered"
      if (res.overall === 'covered' && st.pn && st.claim != null && st.parsed && st.parsed.smiles) resBox.appendChild(h('p.k-row.mk-next', null,
        h('a.btn.sm', { id: 'mk-designs', href: R.build({ view: 'designs', params: { n: st.pn, c: String(st.claim), q: st.parsed.smiles } }) }, U.icon('spark'), 'Design-around ideas'),
        h('span.k-hint', { text: 'Variants just outside the met rules, re-checked by code. Ideas for counsel, not advice.' })));
      if (st.coreMachine) resBox.appendChild(h('p.notice.warn', { id: 'mk-machine-note', text: 'The core was read from the image by Claude and is not confirmed. A "not covered" result is held as unclear until you check the core against the image and confirm it (button in the core section) or enter it by hand.' }));
      if (raw && res.caveat === 'translation_not_reviewed') resBox.appendChild(h('p.k-hint', { text: 'Code result before the caveat: ' + String(raw).replace(/_/g, ' ') + '. An unreviewed Claude translation never reports "not covered", because a translation error could hide a covered molecule.' }));
      if ((res.reasons || []).length) resBox.appendChild(h('ul.mk-reasons', null, res.reasons.map(function (r) { return h('li', { text: r }); })));
      var c = res.core || {};
      resBox.appendChild(h('div.mk-core', null, h('h3.mk-h3', { text: 'Core' }),
        c.placeholder ? h('p.notice', { text: 'No core was available (placeholder). Nothing was compared; enter the core SMILES.' }) :
          h('div.mk-corerow', null, c.matched && c.smiles ? depict(c.smiles, 260, 110, c.smiles) : null,
            h('div', null, h('p', null, h('b', { text: c.matched ? 'Core found in the molecule' : 'Core not found in the molecule' }), c.matched ? ' - ' + (c.nMatches || 0) + ' mapping' + (c.nMatches === 1 ? '' : 's') + (c.oclVerified ? ', confirmed by OpenChemLib' : '') : ''),
              c.smiles ? h('p.mono.mk-smi', { text: str(c.smiles) }) : null,
              c.mapping && c.mapping.length ? h('p.k-hint', { text: c.mapping.length + ' core atoms matched to atoms of the molecule (first mapping; the concrete core is the drawn core with the repeat and linker choices of this reading).' }) : null))));
      resBox.appendChild(groupsTable(res));
      if ((res.provisos || []).length) {
        resBox.appendChild(h('h3.mk-h3', { text: 'Provisos' }));
        resBox.appendChild(h('ul.mk-provlist', null, res.provisos.map(function (p) {
          return h('li', null, h('span.pill.' + (p.matched ? 'crit' : 'hollow'), { text: p.matched ? 'excludes' : 'does not apply' }), ' ', h('span', { text: str(p.why) }), p.quote ? h('blockquote.mk-q', null, h('span', { text: str(p.quote) }), ' ', qsNode(p.quoteStatus || 'unverified')) : null);
        })));
      }
      resBox.appendChild(limitsBox(res));
    }
    function groupsTable(res) {
      var byName = {}; ((st.rec && st.rec.vars) || []).forEach(function (v) { byName[v.name] = v; });
      var tb = h('tbody');
      (res.groups || []).forEach(function (gr) {
        var v = byName[gr.name], na = gr.verdict === 'n/a';
        var frag = gr.value != null && !gr.fragment ? h('span.mono', { text: 'n = ' + gr.value }) : gr.fragment ? h('div.mk-frag', null, depict(gr.fragment, 120, 56, gr.fragment), h('span.mono.mk-smi', { text: gr.value != null ? 'n = ' + gr.value + ' ' + gr.fragment : gr.fragment })) : h('span.faint', { text: na ? '-' : 'H / none' });
        tb.appendChild(h('tr.mk-grow', { data: { v: gr.verdict, name: gr.name } },
          h('td', { data: { l: 'Variable' } }, h('b.mono', { text: str(gr.name) }), h('span.k-hint', { text: ' ' + str(gr.kind || '') })),
          h('td', { data: { l: 'Verdict' } }, pill((g.LnpKit && g.LnpKit.RULE_VERDICT) || GROUP, gr.verdict)),
          h('td', { data: { l: 'Your fragment' } }, frag),
          h('td', { data: { l: 'Rule' } }, h('span', { text: ruleText(v) || '-' })),
          h('td', { data: { l: 'Why' } }, h('span', { text: str(gr.why) + (gr.relaxed ? ' (explanation only, not part of the verdict)' : '') })),
          h('td', { data: { l: 'Claim text' } }, gr.quote ? h('blockquote.mk-q', null, h('span', { text: str(gr.quote) }), ' ', qsNode(gr.quoteStatus || 'unverified')) : h('span.k-row', null, qsNode(gr.quoteStatus || 'empty')))));
      });
      return h('div.mk-tablewrap', null, h('table.mk-table', { id: 'mk-groups' }, h('thead', null, h('tr', null, ['Variable', 'Verdict', 'Your fragment', 'Rule', 'Why', 'Claim text'].map(function (t) { return h('th', { scope: 'col', text: t }); }))), tb));
    }
    function limitsBox(res) {
      // the translation sentence follows the record's origin: only a Claude translation that nobody reviewed needs the warning
      var origin = (res && res.origin) || (st.rec && st.rec.origin) || '', reviewed = !!((res && res.reviewed) || (st.rec && st.rec.reviewed));
      var tr = origin === 'curated' ? 'The rules are a curated reading of the claim; claim construction is for a patent attorney.'
        : origin === 'manual' ? 'The rules were entered by hand; check them against the original claim.'
          : reviewed ? 'The formula was translated by Claude and marked as reviewed; the quotes show what each rule is based on.'
            : 'The formula translated by Claude must be checked against the original; the quotes show what each rule is based on.';
      var trShort = origin === 'curated' ? 'curated reading of the claim' : origin === 'manual' ? 'rules entered by hand' : reviewed ? 'reviewed Claude translation' : 'formula translated by Claude must be checked against the original';
      var items = ['Pre-screening, not legal advice.', tr, 'Stereochemistry, salts, charges, tautomers, extra fragments and claim interpretation are not fully assessed: where they could matter, the check says "unclear" rather than "not covered".', 'Corpus snapshot ' + snapshotDate() + '.'];
      var extra = (res && res.limits) || [];
      var ul = h('ul', null, items.map(function (t) { return h('li', { text: t }); }), extra.filter(function (t) { return !/legal advice/i.test(t); }).map(function (t) { return h('li', { text: str(t) }); }));
      return h('div.mk-limits', { id: 'mk-limits' }, h('p.mk-limits-t', null, U.icon('help'), h('span', { text: 'Pre-screening, not legal advice; ' + trShort + '; stereo, salts, charges, tautomers, extra fragments and claim interpretation not fully assessed; corpus snapshot ' + snapshotDate() })), h('details', null, h('summary', { text: 'All limits of this check' }), ul));
    }

    /* ---------------------------------------------------------- batch */
    var bSrc = 'fto', bPaste = null, bStatus = h('div.mk-bstatus', { 'aria-live': 'polite' }), bResBox = h('div.mk-bres'), bQueueBox = h('div.mk-bqueue');
    var bRunBtn = null, bCancel = null;
    function drawBatch() {
      U.clear(batchView);
      var sources = [['fto', 'Current FTO selection'], ['marks', 'Watchlist'], ['paste', 'Pasted list of numbers'], ['cache', 'All records in the cache']];
      var srcSel = sel(sources, bSrc, function (x) { bSrc = x; paste.hidden = x !== 'paste'; srcInfo(); }, 'Candidate set');
      var paste = h('textarea.textarea.mono', { id: 'mk-bpaste', rows: '4', placeholder: 'One publication number per line (or separated by commas)', 'aria-label': 'Pasted publication numbers', hidden: bSrc !== 'paste' });
      if (bPaste != null) paste.value = bPaste; paste.addEventListener('input', function () { bPaste = paste.value; });
      var info = h('p.k-hint');
      function srcInfo() {
        if (bSrc === 'fto') Promise.resolve(St ? St.get('settings', 'fto-selection') : null).then(function (v) { info.textContent = v && v.pns && v.pns.length ? v.pns.length + ' publication(s) in the FTO selection.' : 'The FTO selection is empty. Select publications in the FTO view first.'; }, function () { info.textContent = 'The FTO selection could not be read.'; });
        else if (bSrc === 'marks') info.textContent = marksPns().length + ' starred publication(s) in the watchlist.';
        else if (bSrc === 'cache') info.textContent = 'Every curated record and every record stored in this browser. No new translations are made.';
        else info.textContent = 'Numbers are looked up in the dataset; publications without an independent claim with a formula are skipped.';
      }
      srcInfo();
      bRunBtn = h('button.btn.primary', { type: 'button', id: 'mk-brun', onclick: function () { runBatch(); } }, U.icon('search'), 'Check the molecule against all claims');
      bCancel = h('button.btn', { type: 'button', id: 'mk-bcancel', hidden: !bt.running, onclick: function () { if (bt.ctl) bt.ctl.abort(); } }, 'Cancel');
      var csvBtn = h('button.btn', { type: 'button', id: 'mk-bcsv', onclick: exportCsv }, U.icon('download'), 'Export CSV');
      batchView.appendChild(K.sec('Batch', 'One molecule against many claims', null,
        h('p.k-sub.mk-bmol', null, 'Molecule: ', st.parsed && st.parsed.ok ? h('b.mono', { text: st.parsed.name || st.parsed.id || (st.parsed.smiles || st.q).slice(0, 60) }) : h('span.faint', { text: 'none yet, enter it in step 1' })),
        h('div.mk-bform', null, fld('Candidate set', srcSel), paste, info),
        h('div.k-row', null, bRunBtn, bCancel, csvBtn),
        bStatus, bResBox, bQueueBox,
        limitsBox()));
      drawBResults(); drawQueue();
    }
    function marksPns() { try { return App.marks.all().filter(function (m) { return m.star; }).map(function (m) { return m.pn; }); } catch (e) { return []; } }
    function readPns() {
      if (bSrc === 'fto') return Promise.resolve(St ? St.get('settings', 'fto-selection') : null).then(function (v) { return (v && v.pns) || []; });
      if (bSrc === 'marks') return Promise.resolve(marksPns());
      var t = bPaste != null ? bPaste : ''; var ta = batchView.querySelector('#mk-bpaste'); if (ta) t = ta.value;
      return Promise.resolve(t.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean));
    }
    function runBatch() {
      if (bt.running) return;
      Promise.resolve(st.molP).then(runBatchNow, runBatchNow);
    }
    function runBatchNow() {
      if (bt.running || dead) return;
      if (!st.parsed || !st.parsed.ok) { U.set(bStatus, h('p.notice.err', { text: 'Enter a valid molecule in step 1 first.' })); return; }
      var ctl = bt.ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, mol = st.parsed.smiles || st.q;
      bt.running = true; bt.index = null; bt.results = []; bt.queue = []; bt.skipped = []; bt.mol = mol; bt.molName = st.parsed.name || st.parsed.id || '';
      bRunBtn.disabled = true; bCancel.hidden = false; drawBResults(); drawQueue();
      var collect = function (ev) { if (ev && ev.last) { bt.results.push(ev.last); drawBResults(); U.set(bStatus, K.busy('Checked ' + ev.done + ' of ' + ev.total + ' claims')); } };
      var prep;
      if (bSrc === 'cache') prep = Promise.resolve('all-cached');
      else prep = readPns().then(function (pns) { return targetsOf(pns, ctl); });
      prep.then(function (targets) {
        if (targets !== 'all-cached' && !targets.length) { U.set(bStatus, h('p.notice', { text: 'No claim with a formula was found in the candidate set.' + (bt.skipped.length ? ' ' + bt.skipped.length + ' publication(s) were skipped.' : '') })); return null; }
        U.set(bStatus, K.busy('Checking ' + (targets === 'all-cached' ? 'all cached records' : targets.length + ' claims')));
        var index = bt.index = {}; if (targets !== 'all-cached') targets.forEach(function (t) { index[t.pn + '--c' + t.claim] = t; });
        return Mk.batch(mol, targets, { signal: ctl ? ctl.signal : undefined, onProgress: collect }).then(function (rs) {
          bt.results = rs;
          rs.forEach(function (r) { if (r.reason === 'no_record' && index[r.pn + '--c' + r.claim]) bt.queue.push({ t: index[r.pn + '--c' + r.claim], state: 'wait' }); });
          bt.results = rs.filter(function (r) { return !(r.reason === 'no_record'); });
          var nq = bt.queue.length;
          U.set(bStatus, h('p.k-sub', null, h('b', { text: bt.results.length + ' claim' + (bt.results.length === 1 ? '' : 's') + ' checked' }), nq ? ', ' + nq + ' without a translation yet' : '', bt.skipped.length ? ', ' + bt.skipped.length + ' publication(s) skipped (' + bt.skipped.slice(0, 5).join(', ') + (bt.skipped.length > 5 ? ' ...' : '') + ')' : '', '.'));
        });
      }).then(null, function (e) {
        var ix = bt.index || {}; bt.results.forEach(function (r) { if (r.reason === 'no_record' && ix[r.pn + '--c' + r.claim]) bt.queue.push({ t: ix[r.pn + '--c' + r.claim], state: 'wait' }); });
        bt.results = bt.results.filter(function (r) { return r.reason !== 'no_record'; });
        if (e && e.code === 'cancelled') U.set(bStatus, h('p.notice', { text: 'Cancelled. ' + bt.results.length + ' result' + (bt.results.length === 1 ? '' : 's') + ' so far are kept.' }));
        else U.set(bStatus, K.errBox(e, 'The batch failed'));
      }).then(function () { bt.running = false; if (bRunBtn) bRunBtn.disabled = false; if (bCancel) bCancel.hidden = true; if (!dead) { drawBResults(); drawQueue(); } });
    }
    function targetsOf(pns, ctl) {
      var out = [], i = 0;
      pns = pns.filter(function (x, k) { return pns.indexOf(x) === k; }).slice(0, 300);
      function step() {
        if (i >= pns.length) return Promise.resolve(out);
        if (ctl && ctl.signal.aborted) return Promise.reject({ code: 'cancelled', message: 'cancelled' });
        var pn = pns[i++]; U.set(bStatus, K.busy('Reading publication ' + i + ' of ' + pns.length));
        return Promise.resolve(D.byPn(pn)).then(function (p) {
          if (p < 0) { bt.skipped.push(pn + ' (not in this build)'); return null; }
          return D.patent(p).then(function (P) {
            return Mk.claimsWithFormula(p).then(function (cl) {
              if (!cl.length) bt.skipped.push(P.pn + ' (no formula claim)');
              cl.forEach(function (c) { out.push({ pn: P.pn, claim: c.n, text: c.text, lang: c.lang, images: c.images, p: p }); });
            });
          });
        }).then(step, function (e) { if (e && e.code === 'cancelled') throw e; bt.skipped.push(pn + ' (error)'); return step(); });
      }
      return step();
    }
    var ORDER = { covered: 0, unclear: 1, not_covered: 2 };
    function rowOf(r) {
      var res = r.result, v = res ? res.overall : null;
      var bad = res ? (res.groups || []).filter(function (g2) { return g2.verdict === 'not_met' || g2.verdict === 'unclear'; }).map(function (g2) { return g2.name + ' ' + (g2.verdict === 'not_met' ? 'not met' : 'unclear'); }) : [];
      return { pn: r.pn, claim: r.claim, v: v, caveat: res && res.caveat || '', origin: r.origin || (res && res.origin) || '', reason: r.reason, detail: res ? (res.core && !res.core.matched ? 'core not found' : bad.join('; ')) : (r.reason === 'invalid_record' ? 'record not valid' : r.message || r.reason || ''), reasons: res ? (res.reasons || []).join(' / ') : '' };
    }
    function drawBResults() {
      U.clear(bResBox);
      if (!bt.results.length) return;
      var rows = bt.results.map(rowOf).sort(function (a, b) { return (a.v in ORDER ? ORDER[a.v] : 3) - (b.v in ORDER ? ORDER[b.v] : 3) || (a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : a.claim - b.claim); });
      var tb = h('tbody');
      rows.forEach(function (r) {
        tb.appendChild(h('tr.mk-brow', { data: { v: r.v || 'none', pn: r.pn } },
          h('td', { data: { l: 'Publication' } }, h('a.mono', { href: App.patentHref(r.pn, { q: '' }), text: U.pnPretty ? U.pnPretty(r.pn) : r.pn })),
          h('td', { data: { l: 'Claim' } }, h('a', { href: R.build({ view: 'markush', arg: r.pn, params: { c: String(r.claim), q: bt.mol || st.q } }), text: 'claim ' + r.claim })),
          h('td', { data: { l: 'Verdict' } }, r.v ? pill(VERDICT, r.v) : h('span.pill.hollow', { text: 'no result' }), r.caveat === 'translation_not_reviewed' ? h('span.pill.warn.hollow', { text: 'not reviewed' }) : null),
          h('td', { data: { l: 'Record' } }, r.origin ? pill(ORIGIN, r.origin) : '-'),
          h('td', { data: { l: 'Detail' } }, r.detail || '')));
      });
      bResBox.appendChild(h('div.mk-tablewrap', null, h('table.mk-table.mk-btable', { id: 'mk-btable' }, h('thead', null, h('tr', null, ['Publication', 'Claim', 'Verdict', 'Record', 'Detail'].map(function (t) { return h('th', { scope: 'col', text: t }); }))), tb)));
    }
    function drawQueue() {
      U.clear(bQueueBox);
      if (!bt.queue.length) return;
      var pending = bt.queue.filter(function (q) { return q.state === 'wait' || q.state === 'error'; }).length;
      var head = h('div.k-row', null, h('h3.mk-h3', { text: 'No translation yet (' + bt.queue.length + ')' }));
      bQueueBox.appendChild(head);
      bQueueBox.appendChild(h('p.k-hint', { text: st.ai ? 'Each translation is one call to Claude (claim text and formula image are sent). The result is stored as an unreviewed Claude translation and checked at once.' : 'Claude is not available in this session. Open a claim and enter its rules by hand.' }));
      if (st.ai) {
        var all = h('button.btn', { type: 'button', id: 'mk-tall', disabled: bt.tbusy || !pending, onclick: translateAll }, U.icon('spark'), 'Translate all (' + pending + ' call' + (pending === 1 ? '' : 's') + ')');
        var can = h('button.btn', { type: 'button', id: 'mk-tcancel', hidden: !bt.tbusy, onclick: function () { if (bt.tctl) bt.tctl.abort(); } }, 'Cancel');
        head.appendChild(all); head.appendChild(can);
        if (bt.tbusy) bQueueBox.appendChild(K.busy('Translating ' + (bt.tdone || 0) + ' of ' + (bt.ttotal || 0)));
      }
      var ul = h('ul.mk-queue');
      bt.queue.forEach(function (q) {
        var b = st.ai ? h('button.btn.sm', { type: 'button', disabled: bt.tbusy || q.state === 'done' || q.state === 'busy', onclick: function () { translateOne(q).then(drawAfterQueue, drawAfterQueue); } }, U.icon('spark'), q.state === 'done' ? 'Translated' : 'Translate') : null;
        var qc = st.ai && q.state === 'busy' && q.ctl && !bt.tbusy ? h('button.btn.sm', { type: 'button', onclick: function () { try { q.ctl.abort(); } catch (e) { /* ignore */ } } }, 'Cancel') : null;
        ul.appendChild(h('li.mk-qitem', { data: { s: q.state } }, h('a.mono', { href: R.build({ view: 'markush', arg: q.t.pn, params: { c: String(q.t.claim), q: bt.mol || st.q } }), text: (U.pnPretty ? U.pnPretty(q.t.pn) : q.t.pn) + ' claim ' + q.t.claim }),
          h('span.k-hint', { text: q.state === 'busy' ? 'translating ...' : q.state === 'error' ? q.err : q.state === 'done' ? 'done' : 'no record' }), b, qc));
      });
      bQueueBox.appendChild(ul);
    }
    function drawAfterQueue() { if (dead) return; drawBResults(); drawQueue(); }
    function translateOne(q, ctl) {
      if (!ctl) { ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; if (!bt.tbusy) bt.tctl = ctl; }
      q.ctl = ctl; q.state = 'busy'; drawQueue();
      var imgs = q.t.images || [];
      return Promise.resolve(D.patent(q.t.p)).then(function () { return Promise.resolve(Se.defs ? Se.defs(q.t.p) : []).then(function (d) { return d || []; }, function () { return []; }); }).then(function (defs) {
        return Mk.translate({ pn: q.t.pn, claim: q.t.claim, claimText: q.t.text, images: imgs.map(function (i) { return i.blob; }), imageIds: imgs.map(function (i) { return i.id; }), defs: defs, lang: q.t.lang || 'en', signal: ctl ? ctl.signal : undefined });
      }).then(function (rec) { return Mk.put(rec); }).then(function (rec) {
        return Mk.check(rec, bt.mol).then(function (res) { bt.results.push({ pn: q.t.pn, claim: q.t.claim, result: res, reason: null, origin: rec.origin }); q.state = 'done'; });
      }).then(null, function (e) {
        if (e && e.code === 'cancelled') { q.state = 'wait'; throw e; }
        q.state = 'error'; q.err = msgOf(e);
        if (AI && AI.isFatal && AI.isFatal(e)) { st.ai = false; if (!dead) { drawRecord(); drawPicker(); } }
      });
    }
    function translateAll() {
      if (bt.tbusy) return;
      var ctl = bt.tctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var todo = bt.queue.filter(function (q) { return q.state === 'wait' || q.state === 'error'; });
      bt.tbusy = true; bt.tdone = 0; bt.ttotal = todo.length; drawQueue();
      var i = 0;
      function next() {
        if (i >= todo.length || !st.ai) return Promise.resolve();
        var q = todo[i++];
        return translateOne(q, ctl).then(function () { bt.tdone = i; drawAfterQueue(); return next(); });
      }
      next().then(null, function () { /* cancelled */ }).then(function () { bt.tbusy = false; drawAfterQueue(); });
    }
    function exportCsv() {
      var rows = [['Publication', 'Claim', 'Verdict', 'Caveat', 'Record origin', 'Detail', 'Reasons', 'Molecule', 'Molecule SMILES', 'Corpus snapshot', 'Note']];
      var data = bt.results.map(rowOf).sort(function (a, b) { return (a.v in ORDER ? ORDER[a.v] : 3) - (b.v in ORDER ? ORDER[b.v] : 3) || (a.pn < b.pn ? -1 : 1); });
      data.forEach(function (r) { rows.push([r.pn, r.claim, r.v || 'no result', r.caveat, r.origin, r.detail, r.reasons, bt.molName, bt.mol, snapshotDate(), 'Pre-screening, not legal advice']); });
      bt.queue.filter(function (q) { return q.state !== 'done'; }).forEach(function (q) { rows.push([q.t.pn, q.t.claim, 'no translation yet', '', '', '', '', bt.molName, bt.mol, snapshotDate(), 'Pre-screening, not legal advice']); });
      if (rows.length === 1) { U.toast('There are no results to export yet', { error: true }); return; }
      U.saveFile('markush-batch-' + K.fileStamp() + '.csv', U.csv(rows), 'text/csv;charset=utf-8');
    }

    /* ---------------------------------------------------------- start */
    function applyRoute(r, first) {
      var pn = r.arg || '', c = r.params && r.params.c, q = r.params && r.params.q ? String(r.params.q) : '', tab = r.params && r.params.b ? 'batch' : 'check';
      var jobs = [];
      if (first || q !== st.q) jobs.push(setMolecule(q, true));
      if (first ? !!pn : (pn && (pn !== st.pn || (c && Number(c) !== st.claim)))) jobs.push(pn === st.pn && st.P ? selectClaim(Number(c) || st.claim) : loadPatent(pn, c));
      if (tab !== st.tab || first) setTabQuiet(tab);
      return Promise.all(jobs);
    }
    function setTabQuiet(t) {
      st.tab = t;
      tabCheck.setAttribute('aria-pressed', t === 'check' ? 'true' : 'false'); tabBatch.setAttribute('aria-pressed', t === 'batch' ? 'true' : 'false');
      checkView.hidden = t !== 'check'; batchView.hidden = t !== 'batch'; if (t === 'batch') drawBatch();
    }
    setTabQuiet(route.params && route.params.b ? 'batch' : 'check');
    drawResult(); drawRecord();
    var aiP = Promise.resolve(AI && AI.init ? AI.init() : false).then(function () { st.ai = !!(AI && AI.available && AI.available()); return Promise.resolve(AI && AI.limits ? AI.limits() : null).then(function (l) { st.aiLim = l; }, function () { }); }, function () { st.ai = false; });
    Promise.all([Mk.ready().then(null, function (e) { U.set(resBox, K.errBox(e, 'The chemistry engine could not be loaded')); }), aiP]).then(function () {
      if (dead) return;
      return applyRoute(route, true);
    }).then(function () { if (!dead) { runCheck(); if (st.tab === 'batch') drawBatch(); } });

    return {
      update: function (r) { route = r; if (r.view !== 'markush') return false; applyRoute(r, false); return true; },
      destroy: function () {
        dead = true; ++seq.mol; ++seq.pat; ++seq.chk;
        if (docPaste) document.removeEventListener('paste', docPaste);
        try { if (st.tctl) st.tctl.abort(); if (bt.ctl) bt.ctl.abort(); if (bt.tctl) bt.tctl.abort(); } catch (e) { /* ignore */ }
        try { if (editor) editor.destroy(); } catch (e2) { /* ignore */ }
        revokeAll();
      }
    };
  }

  /* ------------------------------------------------------------ hooks */
  function hasFormula(c) { return !!c && (c.indep !== false && !(c.dep && c.dep.length)) && ((c.img && c.img.length) || /\[(?:chem|str)\]/i.test(String(c.text || ''))); }
  var ext = g.LnpApp.ext;
  if (ext) {
    try {
      if (ext.claimAction) ext.claimAction(function (P, c) {
        if (!P || !hasFormula(c)) return null;
        return h('a.btn.quiet', { href: R.build({ view: 'markush', arg: P.pn, params: { c: String(c.n) } }), title: 'Check a molecule against the formula of this claim' }, U.icon('structure'), 'Check Markush');
      });
      if (ext.compoundAction) ext.compoundAction(function (hit) {
        var s = hit && (hit.smiles || hit.id);
        if (!s) return null;
        return h('a.btn', { href: R.build({ view: 'markush', arg: '', params: { q: String(s) } }), title: 'Check this compound against the formula of a claim' }, U.icon('structure'), 'Markush check');
      });
    } catch (e) { if (g.LnpApp.logError) g.LnpApp.logError('markush hooks', e); }
  }
  g.LnpApp.registerView({ id: 'markush', title: 'Markush check', icon: 'structure', rail: false, parent: 'tools', mount: g.LnpLazyView('markush', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
