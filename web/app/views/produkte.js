/* LNP Patent Desk: product profiles. Route: #produkte[-<profile id> | -beispiel]
   A profile is the form that LnpFto.normalizeProfile() reads, stored through LnpStore (kind "profiles"):
   {id, name, example, stage, lipids[{role, name, smiles, molPct, pka, pegMw}], ratioBasis, np, payload{}, particle{}, process{},
    use{}, markets[], launchDate, freeText, updated}. */
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

  // option lists: [stored value, label]; the stored values stay as they are because the FTO engine reads them
  function opts(vals, labels) { return vals.map(function (v, i) { return [v, labels[i]]; }); }
  var ROLES = [['ionizable', 'Ionizable lipid'], ['helper', 'Helper lipid'], ['sterol', 'Sterol'], ['peg', 'PEG lipid'], ['other', 'Other']];
  var STAGES = opts(['', 'Forschung', 'Präklinik', 'Klinik Phase 1/2', 'Klinik Phase 3', 'Zulassung beantragt', 'Kommerziell'], ['not specified', 'Research', 'Preclinical', 'Clinical phase 1/2', 'Clinical phase 3', 'Approval applied for', 'Commercial']);
  var PAYLOADS = opts(['', 'mRNA', 'saRNA', 'siRNA', 'ASO', 'pDNA', 'circRNA', 'CRISPR (mRNA + gRNA)', 'leer (ohne Wirkstoff)'], ['not specified', 'mRNA', 'saRNA', 'siRNA', 'ASO', 'pDNA', 'circRNA', 'CRISPR (mRNA + gRNA)', 'empty (no payload)']);
  var MIXING = opts(['', 'T-Stück', 'Impinging-Jet-Mischer', 'Mikrofluidik Herringbone', 'Mikrofluidik toroidal', 'Ethanol-Injektion', 'Extrusion', 'sonstiges'], ['not specified', 'T-junction', 'Impinging jet mixer', 'Microfluidic herringbone', 'Microfluidic toroidal', 'Ethanol injection', 'Extrusion', 'Other']);
  var ROUTES = opts(['', 'intravenös', 'intramuskulär', 'subkutan', 'inhalativ', 'intratumoral', 'intrathekal', 'topisch', 'andere'], ['not specified', 'Intravenous', 'Intramuscular', 'Subcutaneous', 'Inhaled', 'Intratumoral', 'Intrathecal', 'Topical', 'Other']);
  var BASIS = [['nominal', 'nominal (input)'], ['gemessen', 'measured in the particle'], ['', 'unknown']];
  var MARKETS = [['DE', 'Germany'], ['EP', 'EP states'], ['UPC', 'Unitary patent'], ['US', 'USA']];

  function example() {
    return { id: 'beispiel', example: true, name: 'Example: generic MC3 siRNA formulation', stage: 'Präklinik',
      lipids: [{ role: 'ionizable', name: 'DLin-MC3-DMA', smiles: '', molPct: 50, pka: 6.44 }, { role: 'helper', name: 'DSPC', smiles: '', molPct: 10 }, { role: 'sterol', name: 'cholesterol', smiles: '', molPct: 38.5 }, { role: 'peg', name: 'DMG-PEG 2000', smiles: '', molPct: 1.5, pegMw: 2000 }],
      ratioBasis: 'nominal', np: 3, payload: { type: 'siRNA', modification: '2\'-O-methyl, partial', lengthNt: 21 }, particle: { sizeNm: 80, sizeMethod: 'DLS (Z-Average)', pdi: 0.1, encapsulationPct: 95 },
      process: { mixing: 'T-Stück', frr: 3, tfr: 12, buffer: 'Citrate 25 mM', ph: 4, solvent: 'Ethanol' }, use: { route: 'intravenös', indication: 'Liver disease (hepatocyte target gene)' },
      markets: ['DE', 'EP', 'US'], launchDate: '', freeText: 'Textbook-style composition of 50 / 10 / 38.5 / 1.5 mol % for demonstration. No information on a real product.' };
  }
  function blank() { return { id: '', name: 'New profile', stage: '', lipids: [{ role: 'ionizable', name: '', smiles: '', molPct: null }, { role: 'helper', name: '', smiles: '', molPct: null }, { role: 'sterol', name: 'cholesterol', smiles: '', molPct: null }, { role: 'peg', name: '', smiles: '', molPct: null }], ratioBasis: 'nominal', np: null, payload: {}, particle: {}, process: {}, use: {}, markets: ['DE', 'EP', 'US'], launchDate: '', freeText: '' }; }
  // keep only what the form knows; everything is a short string, a number or a list of those
  function clean(src) {
    function s(v, n) { return v == null ? '' : String(v).slice(0, n || 300); }
    function num(v) { if (v == null || v === '') return null; var x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; }
    function obj(o, keys) { var out = {}; o = (o && typeof o === 'object') ? o : {}; keys.forEach(function (k) { if (o[k] != null && o[k] !== '') out[k] = typeof o[k] === 'number' ? o[k] : s(o[k]); }); return out; }
    src = (src && typeof src === 'object') ? src : {};
    return { id: s(src.id, 80), example: !!src.example, name: s(src.name, 160) || 'Profile', stage: STAGES.some(function (x) { return x[0] === src.stage; }) ? src.stage : '',
      lipids: (Array.isArray(src.lipids) ? src.lipids : []).slice(0, 12).map(function (l) { l = l || {}; return { role: ROLES.some(function (r) { return r[0] === l.role; }) ? l.role : 'other', name: s(l.name, 120), smiles: s(l.smiles, 2000), molPct: num(l.molPct), pka: num(l.pka), pegMw: num(l.pegMw) }; }),
      ratioBasis: s(src.ratioBasis, 20), np: num(src.np), payload: obj(src.payload, ['type', 'modification', 'lengthNt', 'encodes']), particle: obj(src.particle, ['sizeNm', 'sizeMethod', 'pdi', 'encapsulationPct', 'zetaMv']),
      process: obj(src.process, ['mixing', 'device', 'frr', 'tfr', 'solvent', 'ethanolPct', 'buffer', 'ph', 'tempC', 'site', 'maker']), use: obj(src.use, ['route', 'indication', 'tissue', 'dose']),
      markets: (Array.isArray(src.markets) ? src.markets : []).filter(function (m) { return MARKETS.some(function (x) { return x[0] === m; }); }), launchDate: s(src.launchDate, 10), freeText: s(src.freeText, 4000), updated: s(src.updated, 30) };
  }

  function mount(host, route, App) {
    var K = g.LnpKit, St = g.LnpStore, Ch = g.LnpChem;
    var dead = false, profiles = [], cur = null, draft = false, saveState = h('span.note-state', { 'aria-live': 'polite' }), timers = [];
    App.chemUsed = true;
    var listBox = h('div.k-plist'), edBox = h('div.k-ped');
    var page = h('div.page.k-page', null,
      K.head('Products', 'Product profiles', 'to check against', 'A profile describes your own formulation as precisely as a claim asks for it: lipids with structure and proportion, payload, particle, process, use and markets. The FTO check compares each claim feature with these details.'),
      h('div.k-prod', null, h('aside.k-prod-side', null,
        h('div.k-row', null, h('button.btn.primary.sm', { type: 'button', onclick: function () { open(blank(), true); } }, 'New profile'), h('button.btn.sm', { type: 'button', onclick: function () { R.go('#produkte-beispiel'); } }, 'Example'),
          h('button.btn.sm', { type: 'button', onclick: importFile }, 'Import')), listBox), edBox));
    host.appendChild(page);

    /* ---------------------------------------------------------- list */
    function drawList() {
      U.clear(listBox);
      if (!profiles.length) { listBox.appendChild(h('p.k-hint', { text: 'No profile saved yet. The example on the right shows what a profile contains; the first change saves it as your own profile.' })); return; }
      var rows = h('div.rows');
      profiles.forEach(function (p) {
        var ion = (p.lipids || []).filter(function (l) { return l.role === 'ionizable'; })[0];
        rows.appendChild(h('a.row' + (cur && cur.id === p.id && !draft ? '.cur' : ''), { href: R.build({ view: 'produkte', arg: p.id }) },
          h('span.grow', null, h('b', { text: p.name || 'Profile' }), h('br'), h('span.faint', { text: (ion && (ion.name || 'own lipid')) || 'no ionizable lipid' })), h('span.mono.faint', { text: U.date(String(p.updated || '').slice(0, 10)) })));
      });
      listBox.appendChild(rows);
      listBox.appendChild(h('button.btn.quiet.sm', { type: 'button', onclick: function () { U.saveFile('lnp-profile-' + K.fileStamp() + '.json', JSON.stringify({ kind: 'lnp-profiles', v: 1, profiles: profiles }, null, 1), 'application/json'); } }, U.icon('download'), 'Export all'));
    }
    function load() {
      return St.list('profiles').then(function (list) { profiles = (list || []).filter(function (p) { return p && typeof p === 'object' && Array.isArray(p.lipids); }).map(function (p) { return clean(p); }); }, function (e) { App.logError('profiles', e); profiles = []; });
    }

    /* ---------------------------------------------------------- save */
    var saveSoon = U.debounce(function () { save(); }, 700);
    function touch() {
      if (draft) { draft = false; cur.id = K.uid('pr'); cur.example = false; if (/^Example: /.test(cur.name)) cur.name = cur.name.replace(/^Example: /, ''); R.go({ view: 'produkte', arg: cur.id }, { silent: true, replace: true }); drawHeadState(); }
      saveState.textContent = 'Changes not yet saved'; saveSoon();
    }
    function save() {
      if (!cur || draft || dead && !cur) return Promise.resolve();
      cur.updated = new Date().toISOString();
      var doc = clean(cur);
      saveState.textContent = 'Saving …';
      return St.put('profiles', cur.id, doc).then(function (r) {
        var i = profiles.findIndex(function (p) { return p.id === doc.id; });
        if (i >= 0) profiles[i] = doc; else profiles.unshift(doc);
        if (!dead) { saveState.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ({ db: '', local: ' (this browser only)', memory: ' (this session only)' }[(r && r.backend) || App.store.backend] || ''); drawList(); }
      }, function (e) { if (!dead) saveState.textContent = 'Saving failed: ' + U.errText(e); });
    }

    /* ---------------------------------------------------------- editor */
    var headState = h('span');
    function drawHeadState() { U.set(headState, draft ? h('span.pill.warn', { text: cur.example ? 'Example, not saved' : 'Draft, not saved' }) : cur.example ? h('span.pill.hollow', { text: 'Example' }) : null); }
    function open(p, isDraft) {
      saveSoon.flush && saveSoon.cancel(); timers.forEach(clearTimeout); timers = [];
      cur = clean(p); draft = !!isDraft; if (isDraft && !cur.example) cur.id = '';
      saveState.textContent = '';
      drawEditor(); drawList();
    }
    function inp(get, set, o) {
      o = o || {};
      var el = h('input.input' + (o.mono ? '.mono' : ''), { id: o.id || null, type: o.type || 'text', placeholder: o.ph || null, inputmode: o.num ? 'decimal' : null, autocomplete: 'off', spellcheck: 'false', 'aria-label': o.aria || null, maxlength: o.max || null });
      var v = get(); el.value = v == null ? '' : (o.num ? String(v) : v);
      el.addEventListener('input', function () {
        var raw = el.value;
        if (o.num) { var x = raw.trim() === '' ? null : parseFloat(raw.replace(',', '.')); el.setAttribute('aria-invalid', raw.trim() !== '' && !isFinite(x) ? 'true' : 'false'); set(isFinite(x) ? x : null); }
        else set(raw);
        touch(); if (o.after) o.after();
      });
      return el;
    }
    function sel(get, set, opts, o) {
      o = o || {};
      var el = h('select.select', { id: o.id || null, 'aria-label': o.aria || null });
      opts.forEach(function (x) { var v = Array.isArray(x) ? x[0] : x, t = Array.isArray(x) ? x[1] : (x || 'not specified'); el.appendChild(h('option', { value: v, text: t })); });
      el.value = get() || '';
      el.addEventListener('change', function () { set(el.value); touch(); if (o.after) o.after(); });
      return el;
    }
    function sub(key) { return cur[key] || (cur[key] = {}); }

    function lipidRow(l, idx, redraw, sumUp) {
      var pic = h('div.k-lip-pic'), info = h('div.k-lip-info'), seq = 0;
      function depict() {
        var my = ++seq, q = (l.smiles || '').trim() || (l.name || '').trim();
        if (!q) { U.set(pic, h('span.faint', { text: 'Structure' })); U.set(info, h('span.k-hint', { text: 'A SMILES or a known name shows the structure and its features here.' })); return; }
        Ch.parse(q).then(function (p) {
          if (my !== seq || dead) return;
          if (!p || !p.ok) { U.set(pic, h('span.faint', { text: '–' })); U.set(info, h('span.k-hint', { text: (l.smiles ? 'SMILES not readable' : 'Name not known as a structure') + '. Without a structure the analysis checks this lipid by name only.' })); return; }
          U.set(pic, K.mol(p.smiles, 200, 84, p.formula));
          U.set(info, h('span.k-sub', { text: (p.kind === 'name' && !l.smiles ? 'Structure from the name ' + p.name + ' · ' : '') + (p.formula || '') + (p.mw ? ' · ' + U.num(Math.round(p.mw * 10) / 10) + ' g/mol' : '') }));
          return Ch.descriptors(p.smiles).then(function (d) { if (my === seq && !dead) info.appendChild(K.descList(d, true)); });
        }).catch(function () { if (my === seq && !dead) U.set(info, h('span.k-hint', { text: 'Structure data not available.' })); });
      }
      var later = function () { timers.push(setTimeout(depict, 350)); };
      var row = h('div.k-lip', { role: 'group', 'aria-label': 'Lipid ' + (idx + 1) },
        h('div.k-lip-f', null,
          K.field('Role', sel(function () { return l.role; }, function (v) { l.role = v; }, ROLES, { id: 'pf-l' + idx + '-role' })),
          K.field('Name', inp(function () { return l.name; }, function (v) { l.name = v; }, { id: 'pf-l' + idx + '-name', ph: 'e.g. ALC-0315', after: later, max: 120 })),
          K.field('SMILES', inp(function () { return l.smiles; }, function (v) { l.smiles = v.trim(); }, { id: 'pf-l' + idx + '-smiles', mono: true, ph: 'optional', after: later, max: 2000 })),
          K.field('mol %', inp(function () { return l.molPct; }, function (v) { l.molPct = v; }, { id: 'pf-l' + idx + '-mol', num: true, after: sumUp })),
          l.role === 'ionizable' ? K.field('pKa (apparent)', inp(function () { return l.pka; }, function (v) { l.pka = v; }, { id: 'pf-l' + idx + '-pka', num: true, ph: 'e.g. 6.4' })) : l.role === 'peg' ? K.field('PEG molar mass', inp(function () { return l.pegMw; }, function (v) { l.pegMw = v; }, { id: 'pf-l' + idx + '-peg', num: true, ph: '2000' })) : h('div'),
          h('button.btn.quiet.icon.sm.k-lip-x', { type: 'button', 'aria-label': 'Remove lipid ' + (idx + 1), title: 'Remove', onclick: function () { cur.lipids.splice(idx, 1); touch(); redraw(); } }, U.icon('x'))),
        h('div.k-lip-s', null, pic, info));
      row.querySelector('select').addEventListener('change', function () { redraw(); });
      depict();
      return row;
    }

    function drawEditor() {
      var p = cur, lipBox = h('div.k-lips'), sumBox = h('p.k-sum'), del = null, delArmed = false;
      function sumUp() {
        var s = 0, any = false; p.lipids.forEach(function (l) { if (l.molPct != null) { s += l.molPct; any = true; } });
        U.set(sumBox, 'Total ', h('b.mono', { text: any ? (Math.round(s * 100) / 100).toLocaleString('en-GB') + ' mol %' : '–' }), any && Math.abs(s - 100) > 0.5 ? h('span.pill.warn', { text: 'differs from 100' }) : any ? h('span.pill.good', { text: 'adds up to 100' }) : null);
      }
      function drawLipids() { U.clear(lipBox); p.lipids.forEach(function (l, i) { lipBox.appendChild(lipidRow(l, i, drawLipids, sumUp)); }); sumUp(); }
      drawLipids(); drawHeadState();
      var mk = h('div.k-checks', { role: 'group', 'aria-label': 'Target markets' });
      MARKETS.forEach(function (m) {
        var cb = h('input.chk', { id: 'pf-m-' + m[0], type: 'checkbox', checked: p.markets.indexOf(m[0]) >= 0, onchange: function () { var i = p.markets.indexOf(m[0]); if (cb.checked && i < 0) p.markets.push(m[0]); else if (!cb.checked && i >= 0) p.markets.splice(i, 1); touch(); } });
        mk.appendChild(h('label.k-check', { 'for': 'pf-m-' + m[0] }, cb, m[1]));
      });
      var ta = h('textarea.textarea', { id: 'pf-free', maxlength: '4000', placeholder: 'Anything the fields do not cover: batch-to-batch variation, post-treatment, storage, planned acts …' }); ta.value = p.freeText || '';
      ta.addEventListener('input', function () { p.freeText = ta.value; touch(); });
      del = h('button.btn.quiet.sm', { type: 'button', onclick: function () {
        if (!delArmed) { delArmed = true; U.set(del, 'Really delete?'); timers.push(setTimeout(function () { delArmed = false; if (del.isConnected) U.set(del, 'Delete'); }, 4000)); return; }
        var id = p.id; saveSoon.cancel();
        St.remove('profiles', id).then(function () { profiles = profiles.filter(function (x) { return x.id !== id; }); U.toast('Profile deleted'); R.go('#produkte'); }, function (e) { U.toast('Deleting failed: ' + U.errText(e), { error: true }); });
      } }, 'Delete');
      function fto() { var go = function () { R.go({ view: 'fto', params: { p: cur.id } }); }; if (draft) { touch(); saveSoon.cancel(); save().then(go); } else { saveSoon.cancel(); save().then(go); } }
      // links to the range check and the expiry timeline of this profile, only when those views are part of the build
      function toolLink(view, label, params) { return !draft && App.views && App.views[view] ? h('button.btn.sm', { type: 'button', onclick: function () { saveSoon.cancel(); save().then(function () { if (App.views[view]) R.go({ view: view, params: params }); }); } }, label) : null; }
      U.set(edBox,
        h('div.k-ped-head', null, h('div.k-ped-title', null, inp(function () { return p.name; }, function (v) { p.name = v; }, { id: 'pf-name', aria: 'Profile name', max: 160 }), headState),
          h('div.k-row', null, saveState, h('button.btn.primary', { type: 'button', onclick: fto }, U.icon('fto'), 'Check FTO'),
            h('button.btn.sm', { type: 'button', onclick: function () { U.saveFile('lnp-profile-' + (p.name || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.json', JSON.stringify({ kind: 'lnp-profile', v: 1, profile: clean(p) }, null, 1), 'application/json'); } }, U.icon('download'), 'Export'),
            h('button.btn.sm', { type: 'button', onclick: function () { var c = clean(p); c.name = c.name.replace(/^Example: /, '') + ' (copy)'; c.example = false; open(c, true); touch(); } }, U.icon('copy'), 'Duplicate'),
            toolLink('ranges', 'Range check', { p: p.id }), toolLink('expiry', 'Expiry timeline', { s: 'profile', p: p.id }),
            draft ? null : del)),
        K.sec('Formulation', 'Lipids and proportions', h('button.btn.sm', { type: 'button', onclick: function () { if (p.lipids.length < 12) { p.lipids.push({ role: 'other', name: '', smiles: '', molPct: null }); touch(); drawLipids(); } } }, 'Add lipid'),
          lipBox, h('div.k-row.k-between', null, sumBox, h('div.k-inline', null,
            K.field('Basis of proportions', sel(function () { return p.ratioBasis; }, function (v) { p.ratioBasis = v; }, BASIS, { id: 'pf-basis' })),
            K.field('N/P ratio', inp(function () { return p.np; }, function (v) { p.np = v; }, { id: 'pf-np', num: true, ph: 'e.g. 6' }))))),
        K.sec('Active ingredient', 'Payload', null, h('div.k-form', null,
          K.field('Type', sel(function () { return sub('payload').type; }, function (v) { sub('payload').type = v; }, PAYLOADS, { id: 'pf-pay' })),
          K.field('Modification', inp(function () { return sub('payload').modification; }, function (v) { sub('payload').modification = v; }, { id: 'pf-mod', ph: 'e.g. N1-methylpseudouridine' })),
          K.field('Length (nt)', inp(function () { return sub('payload').lengthNt; }, function (v) { sub('payload').lengthNt = v; }, { id: 'pf-len', num: true })))),
        K.sec('Particle', 'Size and distribution', null, h('div.k-form', null,
          K.field('Size (nm)', inp(function () { return sub('particle').sizeNm; }, function (v) { sub('particle').sizeNm = v; }, { id: 'pf-size', num: true })),
          K.field('Measurement method', inp(function () { return sub('particle').sizeMethod; }, function (v) { sub('particle').sizeMethod = v; }, { id: 'pf-sizem', ph: 'e.g. DLS (Z-average)' }), 'Claims often name a method; the figure only applies with it.'),
          K.field('PDI', inp(function () { return sub('particle').pdi; }, function (v) { sub('particle').pdi = v; }, { id: 'pf-pdi', num: true })),
          K.field('Encapsulation (%)', inp(function () { return sub('particle').encapsulationPct; }, function (v) { sub('particle').encapsulationPct = v; }, { id: 'pf-enc', num: true })))),
        K.sec('Process', 'Manufacture', null, h('div.k-form', null,
          K.field('Mixing principle', sel(function () { return sub('process').mixing; }, function (v) { sub('process').mixing = v; }, MIXING, { id: 'pf-mix' })),
          K.field('Flow rate ratio aqueous : organic', inp(function () { return sub('process').frr; }, function (v) { sub('process').frr = v; }, { id: 'pf-frr', num: true, ph: 'e.g. 3' })),
          K.field('Total flow rate (mL/min)', inp(function () { return sub('process').tfr; }, function (v) { sub('process').tfr = v; }, { id: 'pf-tfr', num: true })),
          K.field('Aqueous buffer', inp(function () { return sub('process').buffer; }, function (v) { sub('process').buffer = v; }, { id: 'pf-buf', ph: 'e.g. citrate 50 mM' })),
          K.field('pH on mixing', inp(function () { return sub('process').ph; }, function (v) { sub('process').ph = v; }, { id: 'pf-ph', num: true })),
          K.field('Place of manufacture', inp(function () { return sub('process').site; }, function (v) { sub('process').site = v; }, { id: 'pf-site', ph: 'Country' }), 'Determines where \u201cmaking\u201d occurs as an act.'))),
        K.sec('Use', 'Route, markets, timeline', null, h('div.k-form', null,
          K.field('Route of administration', sel(function () { return sub('use').route; }, function (v) { sub('use').route = v; }, ROUTES, { id: 'pf-route' })),
          K.field('Indication', inp(function () { return sub('use').indication; }, function (v) { sub('use').indication = v; }, { id: 'pf-ind' })),
          K.field('Development stage', sel(function () { return p.stage; }, function (v) { p.stage = v; }, STAGES, { id: 'pf-stage' })),
          K.field('Planned market entry', inp(function () { return p.launchDate; }, function (v) { p.launchDate = v.trim(); }, { id: 'pf-launch', ph: 'YYYY-MM', mono: true, max: 10 }), 'Rights that expire earlier are downgraded in the assessment.')),
          h('div.k-field', null, h('span.k-label', { text: 'Target markets' }), mk, h('span.k-hint', { text: 'EP publications are assessed for DE, EP states and the unitary patent, US publications for the USA.' }))),
        K.sec('Free text', 'Further details', null, ta, h('p.k-hint', { text: 'Only Claude evaluates free text. Without Claude, only the fields above count.' })));
    }

    /* ---------------------------------------------------------- import */
    function importFile() {
      K.pickFile('.json,application/json').then(function (text) {
        var data; try { data = JSON.parse(text); } catch (e) { throw { message: 'The file is not valid JSON.' }; }
        var list = Array.isArray(data) ? data : Array.isArray(data.profiles) ? data.profiles : data.profile ? [data.profile] : [data];
        list = list.filter(function (x) { return x && typeof x === 'object' && Array.isArray(x.lipids); }).slice(0, 50);
        if (!list.length) throw { message: 'The file contains no product profile (an object with a \u201clipids\u201d list is expected).' };
        var docs = list.map(function (x) { var c = clean(x); c.id = K.uid('pr'); c.example = false; c.updated = new Date().toISOString(); return c; });
        return docs.reduce(function (p, d) { return p.then(function () { return St.put('profiles', d.id, d); }); }, Promise.resolve()).then(function () {
          U.toast(K.plural(docs.length, 'profile', 'profiles') + ' imported');
          return load().then(function () { if (!dead) R.go({ view: 'produkte', arg: docs[0].id }); });
        });
      }).catch(function (e) { if (e && e.code === 'cancelled') return; U.toast('Import failed: ' + U.errText(e), { error: true }); });
    }

    /* ---------------------------------------------------------- routing */
    function show(r) {
      var id = r.arg || '';
      if (id === 'beispiel') return open(example(), true);
      var p = profiles.filter(function (x) { return x.id === id; })[0];
      if (p) return open(p, false);
      if (id) U.toast('This profile no longer exists', { error: true });
      if (profiles.length) return open(profiles[0], false);
      open(example(), true);
    }
    U.set(edBox, K.busy('Loading profiles'));
    load().then(function () { if (!dead) show(route); });

    return {
      update: function (r) { if (cur && !draft && r.arg === cur.id) return true; saveSoon.cancel(); (cur && !draft ? save() : Promise.resolve()).then(function () { if (!dead) show(r); }); return true; },
      destroy: function () { saveSoon.cancel(); timers.forEach(clearTimeout); if (cur && !draft && /not yet/.test(saveState.textContent)) save(); dead = true; }
    };
  }
  g.LnpProfile = { example: example, clean: clean, blank: blank };
  g.LnpApp.registerView({ id: 'produkte', title: 'Products', icon: 'product', mount: g.LnpLazyView('produkte', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
