/* LNP Patent Desk: Design-around assistant. Route: #designs[-<id>][--q<molecule>][--n<pn>][--c<claim>] or #designs--p<profile id>
   (formulation: values of a stored product profile moved outside the claimed numeric ranges, re-checked with LnpRanges).
   Code (engine x-designaround.js, LnpDesign) generates candidate structures that sit just OUTSIDE one claimed Markush
   rule, verifies each against LnpMarkush.check, re-checks every variant across the corpus and ranks what remains by a
   remaining-risk score computed in code. This is an IDEA GENERATOR for discussion with counsel, never advice: a variant
   outside the literal claim may still infringe by equivalence or under other claims / patents. The optional Claude text
   is commentary only and can never change a rank or a risk number.
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

  var BANNER = 'Idea generator for discussion with counsel. Not advice; a variant outside the literal claim may still infringe by equivalence (doctrine of equivalents) or under other claims or patents outside this corpus.';
  var MOVE_TYPES = [['', 'All move types'], ['chain', 'Chain length'], ['unsaturation', 'Unsaturation'], ['branching', 'Branching'], ['linker', 'Linker class'], ['head', 'Head group'], ['combination', 'Combinations']];
  var RISKWORD = ['very low', 'low', 'medium', 'high', 'very high'];
  function str(x) { return x == null ? '' : String(x); }
  function dummify(s) { return str(s).replace(/\[\*(?::(\d+))?\]|\*/g, function (m, n) { return n ? '[U:' + n + ']' : '[U]'; }); }

  function riskPill(r) {
    if (r == null || r < 0) return h('span.da-risk', { data: { lv: '-1' }, title: 'Remaining risk could not be assessed' }, h('span.da-risk-bar', { 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(function () { return h('i'); })), h('span', { text: 'not assessed' }));
    var lv = Math.max(0, Math.min(4, r));
    return h('span.da-risk', { data: { lv: String(lv) }, title: 'Remaining-risk score of the pre-screen (0-4), computed in code. Not legal advice.' },
      h('span.da-risk-bar', { 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(function (i) { return h('i' + (i <= lv ? '.on' : '')); })),
      h('span', { text: lv + '/4 ' + RISKWORD[lv] }));
  }
  function verdictPill(v) {
    var map = { covered: ['covered', 'crit'], not_covered: ['not covered', 'good'], unclear: ['unclear', 'warn'] };
    var x = map[v] || [str(v).replace(/_/g, ' ') || '-', 'hollow'];
    return h('span.pill.' + x[1], { text: x[0] });
  }
  // depiction box for a full-molecule variant; attachment-free, so plain K.mol
  function depict(smiles, w, hh) {
    var box = h('div.k-mol.da-mol', { style: { height: hh + 'px' } });
    if (!smiles || !g.LnpChem) { box.appendChild(h('span.faint.mono', { text: smiles ? 'no depiction' : '-' })); return box; }
    Promise.resolve().then(function () { return g.LnpChem.svg(smiles, w, hh); }).then(function (svg) {
      var n = U.svgNode(svg); if (n) U.set(box, n); else U.set(box, h('span.faint.mono', { text: 'no depiction' }));
    }, function () { U.set(box, h('span.faint.mono', { text: 'no depiction' })); });
    return box;
  }

  function mount(host, route, App) {
    var K = g.LnpKit, Ch = g.LnpChem, D = g.LnpData, Mk = g.LnpMarkush, Dz = g.LnpDesign, AI = g.LnpAI, St = g.LnpStore;
    var dead = false, seq = 0;
    var st = { q: '', pn: '', claim: '', id: '', pid: '', start: null, variants: null, form: null, maxRisk: 4, moveType: '', busy: false, phase: '', explain: null, loadedId: '' };
    App.chemUsed = true;

    var page = h('div.page.k-page.da-page');
    host.appendChild(page);
    var head = K.head('Design-around ideas', 'Ideas outside', 'the claimed scope', 'Code generates candidate structures that sit just outside one claimed Markush rule, verifies each against the claim, re-checks it across the corpus and ranks what remains by a risk score.');
    page.appendChild(head);
    page.appendChild(h('p.da-banner', null, U.icon('help'), h('span', { text: BANNER })));

    // ---- input row ----
    var qIn = h('input.input.mono', { id: 'da-q', type: 'text', placeholder: 'Molecule: SMILES, name (SM-102 …) or SCHEMBL number', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Starting molecule' });
    var pnIn = h('input.input.mono', { id: 'da-pn', type: 'text', placeholder: 'Patent (EP…)', autocomplete: 'off', 'aria-label': 'Patent number of the claim' });
    var cIn = h('input.input.mono', { id: 'da-c', type: 'text', inputmode: 'numeric', placeholder: 'Claim', style: { maxWidth: '7em' }, 'aria-label': 'Claim number' });
    var goBtn = h('button.btn.primary', { type: 'submit' }, U.icon('spark'), 'Generate ideas');
    var form = h('form.da-form', { onsubmit: function (ev) { ev.preventDefault(); st.pid = ''; st.form = null; st.q = qIn.value.trim(); st.pn = pnIn.value.trim(); st.claim = cIn.value.trim(); st.id = ''; push(); run(); } },
      K.field('Starting molecule', qIn), K.field('Claim patent', pnIn), K.field('Claim no.', cIn), h('div.da-go', null, goBtn));
    page.appendChild(form);

    var statusBox = h('div.da-status', { 'aria-live': 'polite' });
    var body = h('div.da-body');
    page.appendChild(statusBox);
    page.appendChild(body);

    /* ---------- route <-> state ---------- */
    function fromRoute(r) {
      st.id = r.arg || '';
      var p = r.params || {};
      st.q = p.q ? String(p.q) : st.q; st.pn = p.n ? String(p.n) : st.pn; st.claim = p.c ? String(p.c) : st.claim;
      st.pid = p.p ? String(p.p) : '';
      if (st.pid) { st.q = ''; st.pn = ''; st.claim = ''; }
      qIn.value = st.q; pnIn.value = st.pn; cIn.value = st.claim;
    }
    function toRoute() { return { view: 'designs', arg: st.id || '', params: st.id ? {} : st.pid ? { p: st.pid } : { q: st.q, n: st.pn, c: st.claim } }; }
    function push(replace) { R.go(toRoute(), { silent: true, replace: !!replace }); }

    function setStatus(node) { U.set(statusBox, node || h('span')); }
    function busy(text) { st.busy = true; setStatus(K.busy(text)); }
    function clearBusy() { st.busy = false; setStatus(null); }

    /* ---------- run the pipeline ---------- */
    function run() {
      if (!Dz) { setStatus(K.errBox({ message: 'the design-around engine is not loaded' })); return; }
      if (st.pid && !st.q) { runFormulation(); return; }
      if (!st.q || !st.pn || !st.claim) { U.clear(body); setStatus(h('p.k-hint', { text: 'Enter a molecule, the claim’s patent number and the claim number, then generate ideas. You usually arrive here from a Markush result. For formulation ideas, open #designs--p<profile id> (a product profile from Products).' })); return; }
      var my = ++seq; st.explain = null; st.variants = null; st.start = null; st.form = null; U.clear(body);
      busy('Reading the claim and the molecule …');
      Dz.ready().then(function () { return Ch ? Ch.parse(st.q) : { ok: true, smiles: st.q }; }).then(function (pm) {
        if (my !== seq || dead) return;
        if (pm && pm.ok === false) throw { message: 'the molecule was not recognised (' + (K.chemErr(pm.error) || 'parse error') + '). Give a SMILES, a reference-lipid name or a SCHEMBL number.' };
        var smiles = (pm && pm.smiles) || st.q;
        return Mk.get(st.pn, Number(st.claim)).then(function (rec) {
          if (my !== seq || dead) return;
          if (!rec) { noRecord(); return; }
          busy('Checking the molecule against the claim …');
          return Mk.check(rec, smiles).then(function (res) {
            if (my !== seq || dead) return;
            if (res.overall === 'unclear') { unclearStart(res, rec, smiles); return; }
            if (res.overall !== 'covered') { notCovered(res, rec, smiles); return; }
            busy('Generating variants outside the claimed scope …');
            return Dz.fromMarkush(smiles, rec, res).then(function (start) {
              st.start = start;
              return Dz.variants(start, { max: 60 }).then(function (out) {
                if (my !== seq || dead) return;
                st.variants = out.variants;
                return assessAll(out.variants, start, my);
              });
            });
          });
        });
      }).catch(function (e) { if (my === seq && !dead) { clearBusy(); U.clear(body); setStatus(K.errBox(e, 'Design-around')); } });
    }

    function assessAll(variants, start, my) {
      if (!variants.length) { clearBusy(); render(); return; }
      var i = 0, t0 = Date.now();
      function step() {
        if (my !== seq || dead) return Promise.resolve();
        if (i >= variants.length) return Dz.withDistance(start.molecule.smiles, variants).then(function () { return Dz.rank(variants); }).then(function (r) { st.variants = r; });
        busy('Re-checking variant ' + (i + 1) + ' of ' + variants.length + ' across the corpus …');
        return Dz.assess(variants[i++], { markushRecords: 'all-cached' }).then(step, step);
      }
      return step().then(function () { if (my === seq && !dead) { st.assessMs = Date.now() - t0; clearBusy(); render(); } });
    }

    /* ---------- formulation: a stored product profile -> LnpRanges.checkProfile -> values moved outside, re-checked ---------- */
    function runFormulation() {
      var my = ++seq, Rg = g.LnpRanges; st.start = null; st.variants = null; st.form = null; st.explain = null; U.clear(body);
      if (!Rg) { setStatus(h('p.k-hint', { text: 'The range engine is not part of this build, so formulation ideas cannot be computed.' })); return; }
      busy('Reading the product profile …');
      var pf = st.pid === 'beispiel' ? Promise.resolve(g.LnpProfile && g.LnpProfile.example ? g.LnpProfile.example() : null)
        : (St && St.get ? Promise.resolve(St.get('profiles', st.pid)).then(null, function () { return null; }) : Promise.resolve(null));
      pf.then(function (form) {
        if (my !== seq || dead) return;
        if (!form) { clearBusy(); setStatus(h('p.k-hint', { text: 'No product profile with the id "' + st.pid + '" was found. Create one under Products.' })); return; }
        return Promise.resolve(Rg.init()).then(function () {
          if (my !== seq || dead) return;
          if (Rg.available && !Rg.available()) { clearBusy(); setStatus(h('p.k-hint', { text: 'Numeric claim ranges are not available in this build (' + (Rg.reason ? Rg.reason() : 'not loaded') + ').' })); return; }
          busy('Checking the profile against the claimed ranges …');
          return Rg.checkProfile(form, { mode: 'any' }).then(function (res) {
            if (my !== seq || dead) return;
            busy('Moving values outside and re-checking them across the corpus …');
            return Dz.fromRanges(form, res).then(function (out) { if (my !== seq || dead) return; out.profileName = form.name || st.pid; st.form = out; clearBusy(); render(); });
          });
        });
      }).catch(function (e) { if (my === seq && !dead) { clearBusy(); setStatus(K.errBox(e, 'Formulation ideas')); } });
    }

    function noRecord() {
      clearBusy(); U.clear(body);
      body.appendChild(h('div.empty.da-empty', null, h('p.overline', { text: 'No rule record' }), h('h3', { text: 'No Markush rule is stored for this claim' }),
        h('p', null, 'The design-around assistant needs a machine-readable reading of the claim’s general formula. Create or translate one in the ',
          h('a', { href: R.build({ view: 'markush', arg: st.pn, params: { c: st.claim } }), text: 'Markush checker' }), ', then come back.')));
    }
    function notCovered(res, rec, smiles) {
      clearBusy(); U.clear(body);
      body.appendChild(h('div.empty.da-empty', null, h('p.overline', { text: 'Already outside' }), h('h3', { text: 'The molecule is already not covered by this claim' }),
        h('p', { text: 'LnpMarkush.check reports "' + res.overall + '" for this molecule against ' + U.pnPretty(st.pn) + ' claim ' + st.claim + '. There is no literal scope to design around here. This is a pre-screening, not legal advice: equivalence and other claims remain for counsel.' }),
        h('p', null, h('a', { href: R.build({ view: 'markush', arg: st.pn, params: { c: st.claim, q: smiles } }), text: 'See the full Markush analysis' }))));
    }

    // "unclear" is not "outside": code could not decide, so nothing is said about the scope
    function unclearStart(res, rec, smiles) {
      clearBusy(); U.clear(body);
      var why = [];
      (res.groups || []).forEach(function (gr) { if (gr.verdict === 'unclear') why.push(str(gr.name) + ': ' + str(gr.why || 'unclear')); });
      (res.reasons || []).forEach(function (r) { var t = str(r); if (t && why.indexOf(t) < 0) why.push(t); });
      body.appendChild(h('div.empty.da-empty', null, h('p.overline', { text: 'Unclear' }), h('h3', { text: 'Code could not decide whether the molecule is inside this claim' }),
        h('p', { text: 'The Markush check of ' + U.pnPretty(st.pn) + ' claim ' + st.claim + ' ends in "unclear" for this molecule. That is not a finding that it is outside: the reasons below need a person who reads the claim. Design-around ideas start from a molecule the check reads as covered.' }),
        why.length ? h('ul.da-why', null, why.slice(0, 8).map(function (t) { return h('li', { text: t }); })) : null,
        h('p', null, h('a', { href: R.build({ view: 'markush', arg: st.pn, params: { c: st.claim, q: smiles } }), text: 'Open the full Markush analysis' }), ' to review the unclear rules (for example confirm the translation or the quotes), then come back.'),
        h('p.faint', { text: 'Pre-screening, not legal advice.' })));
    }

    /* ---------- render ---------- */
    function filtered() {
      return (st.variants || []).filter(function (v) {
        var r = v.assessment ? v.assessment.risk : null;
        // not assessed (null / -1) ranks as the most risky: it passes only "Any risk"
        if (r == null || r < 0) { if (st.maxRisk < 4) return false; }
        else if (r > st.maxRisk) return false;
        if (st.moveType && v.move.type !== st.moveType) return false;
        return true;
      });
    }
    function render() {
      U.clear(body);
      if (!st.start) {
        if (st.form) { body.appendChild(formulationCard(st.form)); body.appendChild(limitsBox(st.form.limits)); }
        return;
      }
      body.appendChild(startCard(st.start));
      if (!st.variants || !st.variants.length) {
        body.appendChild(h('p.k-hint', { text: 'No design-around variants could be generated from the met variables of this claim. The met rules may have no adjustable carbon range, linker or head group that the generator can move.' }));
        body.appendChild(limitsBox(st.start.limits));
        return;
      }
      body.appendChild(toolbar());
      var list = h('div.da-list');
      var fv = filtered();
      if (!fv.length) list.appendChild(h('p.k-hint', { text: 'No variants match the current filters.' }));
      fv.forEach(function (v) { list.appendChild(variantCard(v)); });
      body.appendChild(list);
      if (st.form && st.form.variants && st.form.variants.length) body.appendChild(formulationCard(st.form));
      body.appendChild(explainBox());
      body.appendChild(limitsBox(st.start.limits));
    }

    function startCard(start) {
      var met = h('div.da-rules');
      (start.met || []).forEach(function (m) {
        met.appendChild(h('div.da-rule', null, h('span.mono.da-rname', { text: m.name }), K.ruleVerdictPill(m.verdict), h('span.da-rrule', { text: m.rule || '' })));
      });
      return h('section.sec.da-start', null,
        h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Starting point' }), h('h2.sec-title', { text: 'The molecule and the claim it falls under' })),
          h('div.da-start-pills', null, K.patentLink(start.pn, App), h('span.mono.faint', { text: 'claim ' + start.claim }), start.origin ? h('span.pill.hollow', { text: start.origin }) : null)),
        h('div.da-start-grid', null,
          depict(start.molecule.smiles, 320, 150),
          h('div.da-start-info', null,
            h('p.da-smiles.mono', { text: start.molecule.smiles }),
            start.molecule.formula ? h('p.faint.mono', { text: start.molecule.formula + (start.molecule.mw ? '  ' + start.molecule.mw + ' g/mol' : '') }) : null,
            h('p.da-sub', { text: 'Variables met by the molecule (the levers for a design-around):' }),
            met)));
    }

    function toolbar() {
      var riskSel = h('select.select', { 'aria-label': 'Maximum remaining risk' });
      [['4', 'Any risk'], ['3', 'risk <= 3'], ['2', 'risk <= 2'], ['1', 'risk <= 1'], ['0', 'risk 0 only']].forEach(function (o) { riskSel.appendChild(h('option', { value: o[0], text: o[1], selected: String(st.maxRisk) === o[0] })); });
      riskSel.addEventListener('change', function () { st.maxRisk = Number(riskSel.value); render(); });
      var moveSel = h('select.select', { 'aria-label': 'Move type' });
      MOVE_TYPES.forEach(function (o) { moveSel.appendChild(h('option', { value: o[0], text: o[1], selected: st.moveType === o[0] })); });
      moveSel.addEventListener('change', function () { st.moveType = moveSel.value; render(); });
      var exMd = h('button.btn.quiet.sm', { type: 'button', onclick: function () { exportFile('md'); } }, U.icon('download'), 'Markdown');
      var exCsv = h('button.btn.quiet.sm', { type: 'button', onclick: function () { exportFile('csv'); } }, U.icon('download'), 'CSV');
      var saveBtn = h('button.btn.sm', { type: 'button', onclick: saveSession }, U.icon('save'), 'Save');
      var explBtn = (AI && AI.available && AI.available()) ? h('button.btn.quiet.sm', { type: 'button', onclick: runExplain }, U.icon('spark'), 'Explain (Claude)') : null;
      var n = filtered().length, total = (st.variants || []).length;
      return h('div.da-toolbar', null,
        h('div.da-filters', null, K.field('Max risk', riskSel), K.field('Move', moveSel), h('span.da-count', { text: n + ' of ' + total + ' variants' + (st.assessMs ? '  ·  re-checked in ' + (st.assessMs / 1000).toFixed(1) + ' s' : '') })),
        h('div.da-actions', null, explBtn, exMd, exCsv, saveBtn));
    }

    function variantCard(v) {
      var a = v.assessment || {}, risk = a.risk != null ? a.risk : -1;
      var verified = v.verified !== undefined ? v.verified !== false : v.sourceVerdict === 'not_covered';
      var card = h('div.da-card', null,
        h('div.da-card-top', null,
          depict(v.smiles, 240, 110),
          h('div.da-card-main', null,
            h('div.da-card-head', null, h('span.da-move', { text: v.moveLabel || Dz.moveLabel(v.move) }), riskPill(risk)),
            verified ? h('p.da-reason', { text: 'Outside the claim (verified by code): ' + (v.sourceReason || v.sourceVerdict || '') })
              : h('p.da-reason.da-unverified', null, h('span.pill.warn.sm', { text: 'not verified' }), h('span', { text: ' Not verified outside: ' + (v.sourceReason || 'the checker is unclear') })),
            h('div.da-card-meta', null,
              v.sourceVerdict ? h('span.da-mi', null, h('span.faint', { text: 'source claim: ' }), verdictPill(v.sourceVerdict)) : null,
              h('span.da-mi', { title: 'Structural distance from the starting molecule (1 - count-fingerprint similarity), computed in code' }, h('span.faint', { text: 'distance from start: ' }), h('span.mono', { text: typeof v.distance === 'number' && isFinite(v.distance) ? v.distance.toFixed(2) : '-' }))))));
      // blocking patents + markush verdicts
      var pats = (a.patents || []).filter(function (p) { return p.markush === 'covered' || (p.src && (p.src.exact_claim || p.src.sim_claim)); });
      var det = h('div.da-card-det');
      if (pats.length) {
        var rows = h('div.da-pats');
        pats.slice(0, 6).forEach(function (p) {
          var why = p.markush === 'covered' ? 'Markush: covered' : p.src && p.src.exact_claim ? 'exact structure in claims' : 'similar in claims';
          var statusTag = p.right && p.right.granted ? h('span.pill.good.sm', { text: 'in force' }) : p.right && p.right.pending ? h('span.pill.warn.sm', { text: 'pending' }) : p.right && p.right.live === false ? h('span.pill.hollow.sm', { text: 'dead' }) : h('span.pill.hollow.sm', { text: 'status unknown' });
          rows.appendChild(h('div.da-pat', null, K.patentLink(p.pn, App), statusTag, h('span.da-pat-why', { text: why + (p.claim ? ' (claim ' + p.claim + ')' : '') })));
        });
        det.appendChild(h('div.da-det-block', null, h('p.da-det-title', { text: 'Patents to weigh' }), rows));
      }
      var mk = (a.markush || []).filter(function (m) { return m.overall === 'covered' || m.overall === 'unclear'; });
      if (mk.length) {
        var mkRows = h('div.da-mks');
        mk.slice(0, 6).forEach(function (m) { mkRows.appendChild(h('div.da-mk', null, K.patentLink(m.pn, App), h('span.mono.faint', { text: 'c' + m.claim }), verdictPill(m.overall))); });
        det.appendChild(h('div.da-det-block', null, h('p.da-det-title', { text: 'Other claims that may still read on it' }), mkRows));
      }
      if (!pats.length && !mk.length) det.appendChild(h('p.da-none', { text: 'No exact or close match in the corpus and no cached Markush claim reads on it. Equivalence and claims outside this corpus still remain for counsel.' }));
      if (a.unknown && a.unknown.length) det.appendChild(h('p.da-riskwhy', { text: 'Not every check ran: ' + a.unknown.map(function (u) { return u.check + ' (' + u.why + ')'; }).join('; ') + '.' }));
      if (a.riskParts && a.riskParts.length) det.appendChild(h('p.da-riskwhy', { text: 'Risk drivers: ' + a.riskParts.map(function (x) { return x.why; }).join('; ') + '.' }));
      card.appendChild(det);
      return card;
    }

    function formulationCard(form) {
      var rows = h('div.da-form-rows');
      function links(list) { return (list || []).slice(0, 8).map(function (w) { return h('span.da-mi', null, K.patentLink(w.pn, App), h('span.mono.faint', { text: ' c' + w.claim })); }); }
      (form.variants || []).forEach(function (v) {
        rows.appendChild(h('div.da-form-row', null, h('span.da-form-move', { text: v.moveLabel }),
          h('span.da-form-was', null, h('span.faint', { text: 'leaves: ' }), links(v.leaves)),
          h('span.da-form-was', null, h('span.faint', { text: v.rechecked ? 'still inside (re-checked across the corpus): ' : 'still inside (not re-checked): ' }),
            v.stillInside && v.stillInside.length ? links(v.stillInside) : h('span', { text: 'none' }), v.stillInsideCount > 8 ? h('span.faint', { text: ' +' + (v.stillInsideCount - 8) + ' more' }) : null)));
      });
      if (!(form.variants || []).length) rows.appendChild(h('p.k-hint', { text: 'No value of this profile sits inside a claimed range that has a finite bound to move past, so there is no formulation idea to show.' }));
      return h('section.sec.da-formsec', null, h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Formulation' + (form.profileName ? ' · ' + form.profileName : '') }), h('h2.sec-title', { text: 'Values moved outside the claimed ranges' }))),
        h('p.da-sub', { text: 'Each value is moved one step past a finite bound of a range it falls in, then re-checked against every claim range of the corpus. Other claim features and other patents still decide, and equivalence remains open; not advice.' }), rows);
    }

    function explainBox() {
      var box = h('div.da-explain');
      if (st.explain == null) { if (!(AI && AI.available && AI.available())) box.appendChild(h('p.da-expl-note', { text: 'Claude is not available in this build, so no written commentary is generated. The ideas and their risk are computed by code and shown above.' })); return box; }
      if (st.explain.skipped) { box.appendChild(h('p.da-expl-note', { text: st.explain.reason || 'The commentary was skipped.' })); return box; }
      box.appendChild(h('div.sec-head', null, h('div', null, h('p.overline', { text: 'Commentary' }), h('h2.sec-title', { text: 'Claude on the ideas (commentary only)' }))));
      box.appendChild(h('p.da-expl-note', { text: 'Commentary only; it cannot change the risk scores or the ranking above, and never states that a variant is free to operate.' }));
      // untrusted model text -> textContent only, split into paragraphs
      str(st.explain.text).split(/\n\s*\n/).forEach(function (p) { if (p.trim()) box.appendChild(h('p.da-expl-p', { text: p.trim() })); });
      return box;
    }
    function runExplain() {
      if (!st.start || !AI || !AI.available || !AI.available()) return;
      var my = seq;
      st.explain = { skipped: true, reason: 'Generating commentary …' }; render();
      Dz.explain(st.start, filtered(), {}).then(function (r) { if (my === seq && !dead) { st.explain = r; render(); } }, function () { if (my === seq && !dead) { st.explain = { skipped: true, reason: 'The commentary could not be generated; the ideas and risk are unchanged.' }; render(); } });
    }

    function limitsBox(limits) {
      var det = h('details.da-limits', null, h('summary', null, U.icon('help'), 'Limits of this pre-screening'));
      var ul = h('ul');
      var extra = [];
      if ((st.variants || []).some(function (v) { return !(typeof v.distance === 'number' && isFinite(v.distance)); })) extra.push('The structural distance from the start could not be computed for some variants (shown as "-"); they are ranked after the others of the same risk.');
      if ((st.variants || []).some(function (v) { return v.verified === false; })) extra.push('Ideas marked "not verified" are ones the Markush checker reads as unclear for the source claim: code could not confirm that they leave the claim. They carry one extra risk point.');
      (limits || []).concat(extra).concat(['Remaining risk is a code-computed score over this corpus snapshot (' + ((D && D.manifest && D.manifest.snapshots && D.manifest.snapshots.corpus) || 'current') + '); it is not a legal conclusion.']).forEach(function (l) { ul.appendChild(h('li', { text: l })); });
      det.appendChild(ul);
      return det;
    }

    /* ---------- export + save ---------- */
    function exportFile(fmt) {
      var fv = filtered(), start = st.start; if (!start) return;
      var stamp = K.fileStamp(), nm = str(start.pn).replace(/\s+/g, '') + '-c' + start.claim;
      if (fmt === 'csv') {
        var rows = [['rank', 'move', 'smiles', 'remaining_risk', 'source_verdict', 'verified_outside', 'distance_from_start', 'blocking_patents']];
        fv.forEach(function (v, i) {
          var pats = (v.assessment && v.assessment.patents || []).filter(function (p) { return p.markush === 'covered' || (p.src && (p.src.exact_claim || p.src.sim_claim)); }).map(function (p) { return p.pn; });
          rows.push([String(i + 1), v.moveLabel || '', v.smiles, v.assessment && v.assessment.risk != null ? String(v.assessment.risk) : 'not assessed', v.sourceVerdict || '', v.verified === false ? 'no' : 'yes', typeof v.distance === 'number' && isFinite(v.distance) ? v.distance.toFixed(3) : '', pats.join(' ')]);
        });
        U.saveFile('designaround-' + nm + '-' + stamp + '.csv', U.csv(rows), 'text/csv;charset=utf-8');
        return;
      }
      var md = ['# Design-around ideas - ' + U.pnPretty(start.pn) + ' claim ' + start.claim, '',
        '> ' + BANNER, '',
        'Starting molecule: `' + start.molecule.smiles + '`' + (start.molecule.formula ? ' (' + start.molecule.formula + ')' : ''), '',
        'Variables met (levers): ' + (start.met || []).filter(function (m) { return m.verdict === 'met'; }).map(function (m) { return m.name + ' (' + (m.rule || '') + ')'; }).join(', '), ''];
      md.push('| # | Move | Remaining risk | Source claim | Distance | SMILES | Patents to weigh |');
      md.push('|---|------|----------------|--------------|----------|--------|------------------|');
      fv.forEach(function (v, i) {
        var pats = (v.assessment && v.assessment.patents || []).filter(function (p) { return p.markush === 'covered' || (p.src && (p.src.exact_claim || p.src.sim_claim)); }).map(function (p) { return p.pn; }).join(' ');
        md.push('| ' + (i + 1) + ' | ' + (v.moveLabel || '').replace(/\|/g, '/') + ' | ' + (v.assessment && v.assessment.risk != null ? v.assessment.risk + '/4' : 'not assessed') + ' | ' + (v.sourceVerdict || '') + (v.verified === false ? ' (not verified)' : '') + ' | ' + (typeof v.distance === 'number' && isFinite(v.distance) ? v.distance.toFixed(2) : '-') + ' | `' + v.smiles + '` | ' + pats + ' |');
      });
      md.push('', '_Pre-screening, not legal advice. Equivalence (doctrine of equivalents) and claims or patents outside this corpus remain open questions for counsel._');
      U.saveFile('designaround-' + nm + '-' + stamp + '.md', md.join('\n'), 'text/markdown;charset=utf-8');
    }
    function saveSession() {
      if (!st.start || !Dz) return;
      var session = { start: st.start, variants: st.variants, form: st.form, pn: st.start.pn, claim: st.start.claim };
      Dz.save(session).then(function (doc) { st.id = doc.id; push(true); U.toast('Design-around session saved'); }, function (e) { U.toast('Could not save: ' + U.errText(e)); });
    }

    /* ---------- load a saved session ---------- */
    function loadSession(id) {
      busy('Loading the saved session …');
      Dz.ready().then(function () { return Dz.load(id); }).then(function (doc) {
        if (dead) return;
        if (!doc) { clearBusy(); U.clear(body); setStatus(h('p.k-hint', { text: 'No saved design-around session with this id.' })); return; }
        st.start = doc.start; st.variants = doc.variants || []; st.form = doc.form || null; st.loadedId = id; st.id = id;
        if (st.start && st.start.molecule) { qIn.value = st.start.molecule.smiles; st.q = st.start.molecule.smiles; }
        pnIn.value = st.pn = str(doc.pn || (doc.start && doc.start.pn)); cIn.value = st.claim = str(doc.claim || (doc.start && doc.start.claim));
        clearBusy(); render();
      }, function (e) { if (!dead) { clearBusy(); setStatus(K.errBox(e, 'Load')); } });
    }

    /* ---------- boot ---------- */
    fromRoute(route);
    var boot = Promise.resolve();
    if (St && St.init) boot = Promise.resolve(St.init()).catch(function () { });
    boot.then(function () { if (dead) return; if (st.id) loadSession(st.id); else run(); });

    return {
      update: function (r) {
        var oldId = st.id, oldKey = st.q + '|' + st.pn + '|' + st.claim + '|' + st.pid;
        fromRoute(r);
        if (st.id && st.id !== oldId) { loadSession(st.id); return true; }
        if (!st.id && (st.q + '|' + st.pn + '|' + st.claim + '|' + st.pid) !== oldKey) { run(); return true; }
        return true;
      },
      destroy: function () { dead = true; seq++; }
    };
  }

  // entry points: the Markush result links here when the molecule is covered (markush.js), and the Tools hub
  g.LnpApp.registerView({ id: 'designs', title: 'Design-around ideas', icon: 'spark', rail: false, parent: 'tools', mount: g.LnpLazyView('designs', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
