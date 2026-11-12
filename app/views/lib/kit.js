/* LNP Patent Desk: helpers shared by the work views (global LnpKit). Classic script; needs ui.js.
   Loaded on demand by the views (struktur, produkte, fto, landschaft, merkliste, system) together with
   app/views/views.css. Nothing here assigns innerHTML; corpus and model text goes through textContent. */
(function (g) {
  'use strict';
  var U = g.LnpUI, h = U.h;
  var K = {};

  /* ------------------------------------------------------------ page furniture */
  K.head = function (over, title, light, lead) {
    return h('header.page-head', null, h('p.overline', { text: over }), h('h1.page-title', null, title + ' ', light ? h('span.light', { text: light }) : null), lead ? h('p.lead', { text: lead }) : null);
  };
  // sec(over, title, actions | null, body...) -> section
  K.sec = function (over, title, actions) {
    var s = h('section.sec', null, h('div.sec-head', null, h('div', null, over ? h('p.overline', { text: over }) : null, h('h2.sec-title', { text: title })), actions || null));
    for (var i = 3; i < arguments.length; i++) U.add(s, arguments[i]);
    return s;
  };
  K.field = function (label, control, hint) {
    var id = control.id || (control.id = 'k-f' + (++K._id));
    return h('div.k-field', null, h('label', { 'for': id, text: label }), control, hint ? h('span.k-hint', { text: hint }) : null);
  };
  K._id = 0;
  K.busy = function (text) { return h('div.k-busy', { role: 'status' }, h('span.spin'), h('span', { text: text })); };
  K.errBox = function (e, prefix) { return h('p.notice.err', { text: (prefix ? prefix + ': ' : '') + U.errText(e) }); };
  K.kv = function (rows) {
    var dl = h('dl.kv');
    rows.forEach(function (r) {
      if (!r || r[1] == null || r[1] === '') return;
      dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', null, r[1]));
    });
    return dl;
  };
  K.stats = function (rows) {
    var dl = h('dl.stats.k-stats');
    rows.forEach(function (r) { if (!r || r[1] == null) return; dl.appendChild(h('div.stat', null, h('dt', { text: r[0] }), h('dd', null, r[1], r[2] ? h('small', { text: r[2] }) : null))); });
    return dl;
  };
  // re-run fn when the element changes width (charts are drawn to the pixel, not scaled)
  K.onResize = function (el, fn) {
    var last = -1, ro = null, raf = 0;
    function run() { raf = 0; var w = el.clientWidth; if (w && w !== last) { last = w; fn(w); } }
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(function () { if (!raf) raf = requestAnimationFrame(run); }); ro.observe(el); }
    else g.addEventListener('resize', run);
    run();
    return function () { if (ro) ro.disconnect(); else g.removeEventListener('resize', run); };
  };

  /* ------------------------------------------------------------ dates */
  K.todayIso = function () { return new Date().toISOString().slice(0, 10); };
  K.iso = function (n) { var s = String(n || '').replace(/-/g, ''); return /^\d{8}/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : ''; };
  K.daysSince = function (iso) { var t = Date.parse(iso); return isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null; };
  K.fileStamp = function () { return new Date().toISOString().slice(0, 10); };

  /* ------------------------------------------------------------ chemistry */
  var AMINE = { tertiary: 'tertiary amine', secondary: 'secondary amine', primary: 'primary amine', quaternary: 'quaternary ammonium', amide: 'amide', none: 'no amine', aromatic: 'aromatic nitrogen', other: 'other nitrogen' };
  var HEAD = { neutral: 'neutral', polyether: 'polyether (PEG)', sterol: 'sterol', phosphocholine: 'phosphocholine', phosphoethanolamine: 'phosphoethanolamine', phospho: 'phosphate', quaternary: 'quaternary ammonium', polyamine: 'polyamine',
    dimethylamino: 'dimethylamino', 'hydroxyalkyl-tert-amine': 'hydroxyalkyl tert-amine', 'cyclic-tert-amine': 'cyclic tert-amine', 'tert-amine': 'tert-amine', 'sec-amine': 'sec-amine', 'prim-amine': 'prim-amine', heteroaryl: 'heteroaryl', amide: 'amide', 'other-n': 'other nitrogen' };
  var WHERE = [['clm', 'Claims', 'Found in the claim text by SureChEMBL. Not evidence that the claim protects the compound.'], ['desc', 'Description', 'Mentioned in the description'], ['abs', 'Abstract', 'Mentioned in the abstract'],
    ['ttl', 'Title', 'Mentioned in the title'], ['img', 'Formula image', 'Read from a formula image'], ['mol', 'Molfile', 'Attached as a structure file']];
  K.AMINE = AMINE; K.HEAD = HEAD;
  K.amineLabel = function (c) { return AMINE[c] || c || ''; };
  K.headLabel = function (c) { return HEAD[c] || c || ''; };
  // the two descriptor shapes of LnpChem (search hit .desc and descriptors()) read through one accessor
  K.desc = function (d) {
    d = d || {};
    var links = (d.links && typeof d.links === 'object') ? d.links : (d.linkers && !Array.isArray(d.linkers) ? d.linkers : {});
    var tails = (d.tails || []).map(function (t) { return { nC: t.nC, dbl: t.nDoubleBonds || 0, branched: !!t.branched, acyl: !!t.acyl, arms: t.arms || null }; });
    return { head: d.head || '', amine: (d.amine && d.amine.class) || 'none', amineCount: (d.amine && d.amine.count) || 0, ester: links.ester || 0, links: links, tails: tails,
      nTails: d.nTails != null ? d.nTails : tails.length, nEnds: d.nChainEnds, biodegradable: !!d.biodegradable, maxTail: tails.reduce(function (m, t) { return Math.max(m, t.nC || 0); }, 0) };
  };
  K.tailText = function (t) { return 'C' + t.nC + (t.dbl ? ':' + t.dbl : '') + (t.branched ? ' branched' : ''); };
  // -> element: hairline list "Tails / Head group / Amine / Linkers"
  K.descList = function (d, compact) {
    var x = K.desc(d), dl = h('dl.k-desc' + (compact ? '.compact' : ''));
    function row(k, v, title) { dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: v, title: title || null })); }
    row(x.nTails === 1 ? 'Tail' : 'Tails', x.nTails ? x.nTails + ' · ' + x.tails.map(K.tailText).join(', ') : 'none from C6', 'Hydrocarbon chains of 6 or more carbon atoms; C18:2 = 18 carbon atoms, 2 double bonds');
    row('Head', K.headLabel(x.head) || '–');
    row('Amine', K.amineLabel(x.amine) + (x.amineCount > 1 ? ' × ' + x.amineCount : ''), 'Type of amine: determines whether the lipid is ionisable (relevant to pKa)');
    var ln = Object.keys(x.links).filter(function (k) { return x.links[k] > 0 && k !== 'hydroxyl'; }).map(function (k) { return x.links[k] + ' ' + (LINK[k] || k); });
    row('Linkers', ln.length ? ln.join(', ') : 'none');
    return dl;
  };
  var LINK = { ester: 'ester', carbonate: 'carbonate', carbamate: 'carbamate', amide: 'amide', urea: 'urea', thioester: 'thioester', ether: 'ether', thioether: 'thioether', disulfide: 'disulfide', ketal: 'ketal', phosphate: 'phosphate', acid: 'acid', ketone: 'ketone' };
  K.whereTags = function (w) {
    var out = [];
    WHERE.forEach(function (x) { if (w && w[x[0]]) out.push(h('span.tag' + (x[0] === 'clm' ? '.k-clm' : ''), { text: x[1], title: x[2] })); });
    return out;
  };
  K.whereText = function (w) { return WHERE.filter(function (x) { return w && w[x[0]]; }).map(function (x) { return x[1]; }).join(', '); };
  // depiction box; fills itself when the engine answers. input = c index, SMILES or name
  K.mol = function (input, w, hh, fallback) {
    var box = h('div.k-mol', { style: { height: hh + 'px' } });
    if (input == null || input === '' || !g.LnpChem) { if (fallback) box.appendChild(h('span.faint.mono', { text: fallback })); return box; }
    Promise.resolve().then(function () { return g.LnpChem.svg(input, w, hh); }).then(function (s) {
      var n = U.svgNode(s);
      if (n) U.set(box, n); else if (fallback) U.set(box, h('span.faint.mono', { text: fallback }));
    }, function () { U.set(box, h('span.faint.mono', { text: fallback || 'no depiction' })); });
    return box;
  };

  /* ------------------------------------------------------------ patents */
  K.expiryText = function (pt) { return pt && pt.exp ? U.date(pt.exp) : '–'; };
  K.inForce = function (pt, today) { return !!pt && pt.status === 'granted' && (!pt.exp || pt.exp >= (today || U.today())); };
  K.patentLink = function (pn, App) { return h('a.mono.k-pn', { href: App.patentHref(pn, { q: '' }), text: U.pnPretty(pn) }); };
  // pns -> Map pn -> patent object | null (unknown numbers stay null)
  K.patentsByPn = function (pns) {
    var D = g.LnpData, out = new Map();
    return Promise.all(pns.map(function (pn) { return D.byPn(pn).then(function (p) { return p >= 0 ? D.patent(p) : null; }).then(function (pt) { out.set(pn, pt); }, function () { out.set(pn, null); }); })).then(function () { return out; });
  };

  /* ------------------------------------------------------------ risk vocabulary of the FTO engine */
  var RISK = { '1_sehr_gering': ['very low', 0], '2_gering': ['low', 1], '3_mittel': ['medium', 2], '4_hoch': ['high', 3], '5_sehr_hoch': ['very high', 4], nicht_beurteilbar: ['cannot be assessed', -1] };
  K.riskLabel = function (r) { return RISK[r] ? RISK[r][0] : (r ? String(r) : 'not rated'); };
  K.riskLevel = function (r) { return RISK[r] ? RISK[r][1] : -2; };
  K.riskPill = function (r) {
    var lv = K.riskLevel(r);
    return h('span.k-risk', { data: { lv: String(lv) }, title: 'Risk rating of the pre-screen; not legal advice' }, h('span.k-risk-bar', { 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(function (i) { return h('i' + (lv >= 0 && i <= lv ? '.on' : '')); })), h('span', { text: K.riskLabel(r) }));
  };
  var LIT = { wortsinngemaess_erfuellt: 'literally met', wortsinngemaess_moeglich: 'literally possible', wortsinngemaess_nicht_erfuellt: 'literally not met', nicht_beurteilbar: 'cannot be assessed' };
  K.litLabel = function (l) { return LIT[l] || (l ? String(l).replace(/_/g, ' ') : '–'); };
  var VERD = { erfuellt: ['met', 'crit'], nicht_erfuellt: ['not met', 'good'], unklar: ['unclear', 'warn'], formel_fehlt: ['formula not available', 'hollow'], nicht_beurteilbar: ['cannot be assessed', 'hollow'] };
  // verdict of one Markush rule (variable) for a molecule: one label and colour set for every view (met = the molecule
  // satisfies the claimed rule = risk, shown red)
  K.RULE_VERDICT = { met: ['met', 'crit'], not_met: ['not met', 'good'], unclear: ['unclear', 'warn'], 'n/a': ['not present', 'hollow'] };
  K.ruleVerdictPill = function (v) { var x = K.RULE_VERDICT[v] || [v ? String(v).replace(/_/g, ' ') : '–', 'hollow']; return h('span.pill.' + x[1], { text: x[0] }); };
  K.verdictPill = function (v) { var x = VERD[v] || [v ? String(v).replace(/_/g, ' ') : '–', 'hollow']; return h('span.pill.' + x[1], { text: x[0] }); };

  /* ------------------------------------------------------------ chart tooltip (one for the page) */
  var tip = null;
  K.tip = {
    show: function (ev, title, rows, foot) {
      if (!tip) { tip = h('div.k-tip', { role: 'tooltip' }); document.getElementById('overlays').appendChild(tip); }
      U.clear(tip);
      if (title) tip.appendChild(h('div.k-tip-t', { text: title }));
      (rows || []).forEach(function (r) { tip.appendChild(h('div.k-tip-r', null, r[2] ? h('i', { style: { background: r[2] } }) : h('i.none'), h('span', { text: r[0] }), h('b', { text: r[1] }))); });
      if (foot) tip.appendChild(h('div.k-tip-f', { text: foot }));
      tip.hidden = false;
      var x = ev.clientX, y = ev.clientY, w = tip.offsetWidth, hh = tip.offsetHeight, vw = g.innerWidth, vh = g.innerHeight;
      if (ev.type === 'focus' || (!x && !y)) { var r2 = ev.target.getBoundingClientRect(); x = r2.left + r2.width / 2; y = r2.top; }
      var left = x + 14; if (left + w > vw - 8) left = Math.max(8, x - w - 14);
      var top = y + 14; if (top + hh > vh - 8) top = Math.max(8, y - hh - 14);
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    },
    hide: function () { if (tip) tip.hidden = true; }
  };

  /* ------------------------------------------------------------ misc */
  K.uid = function (prefix) { return (prefix || 'x') + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); };
  // read a text file chosen by the user -> Promise<string>
  K.pickFile = function (accept) {
    return new Promise(function (res, rej) {
      var inp = h('input', { type: 'file', accept: accept || '', style: { display: 'none' } });
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (inp.parentNode) inp.parentNode.removeChild(inp);
        if (!f) return rej({ code: 'cancelled', message: 'No file selected' });
        if (f.size > 5e6) return rej({ code: 'too_large', message: 'The file is larger than 5 MB' });
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result || '')); };
        fr.onerror = function () { rej({ code: 'read', message: 'The file could not be read' }); };
        fr.readAsText(f);
      });
      document.body.appendChild(inp); inp.click();
    });
  };
  // OpenChemLib parse errors ("Class$S18: SmilesParser: unknown element label found. Position:0") -> plain text
  K.chemErr = function (m) {
    var s = String(m == null ? '' : (m && m.message) || m);
    var hit = /(?:Class\$\w+:\s*)?SmilesParser:\s*([\s\S]*)$/.exec(s) || /((?:dangling ring closure|unknown element|valence)[\s\S]*)$/i.exec(s);
    if (!hit) return s.replace(/\.{2,}/g, '.');
    var d = hit[1].replace(/\.?\s*Position:\s*(\d+)/i, function (x, p) { return ' at position ' + (Number(p) + 1); }).replace(/\s+label found\b|\s+found\b/i, '').replace(/[.\s]+$/, '');
    return 'not a valid SMILES (' + d.replace(/\.{2,}/g, '.').trim() + ')';
  };
  K.plural = function (n, one, many) { return U.num(n) + ' ' + (n === 1 ? one : many); };

  g.LnpKit = K;
})(window);
