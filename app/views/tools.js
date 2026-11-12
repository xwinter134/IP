/* LNP Patent Desk: Tools hub. Route: #tools. The only rail entry of the tool set: one card per tool (purpose, whether the engine, its
   data and Claude are available in this build) and a section "For your AI tools" (window.LnpAPI, context packs, MCP server).
   Availability is read from the page: engine globals, LnpData.manifest (x datasets, chemistry set), LnpAI.available().
   Nothing here depends on Claude; the hub itself needs no capability. Patent text is only ever inserted with textContent. */
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
        return { update: function (r) { return inst && inst.update ? inst.update(r) : false; }, destroy: function () { dead = true; try { if (typeof inst === 'function') inst(); else if (inst && inst.destroy) inst.destroy(); } catch (e) { App.logError('view ' + id, e); } } };
      };
    };
  })();

  /* One entry per tool. need: engine global; data: 'chem' (chemistry set), 'x:<name>' (extra dataset), 'live' (the search index / status files, always in a build),
     'x:<name>?' (optional extra dataset); ai: 'none' | 'optional' (Claude adds something, a manual mode exists). */
  var TOOLS = [
    { id: 'markush', title: 'Markush check', icon: 'structure', href: '#markush', engine: 'LnpMarkush', data: 'x:markush?', ai: 'optional',
      what: 'Is a molecule inside the generic formula of a claim? Code matches the core, the substituents and the provisos.',
      aiNote: 'Claude translates a claim into a record and reads formula images; without Claude you enter the core SMILES and the rules by hand.' },
    { id: 'screen', title: 'Library screen', icon: 'structure', href: '#screen', engine: 'LnpScreen', data: 'chem', ai: 'none',
      what: 'Run a list of molecules (SMILES, CSV) against the corpus: exact, similar and substructure hits, claims, status and Markush coverage.' },
    { id: 'ranges', title: 'Range check', icon: 'filter', href: '#ranges', engine: 'LnpRanges', data: 'x:ranges', ai: 'none',
      what: 'Compare values of a formulation (mol %, size, pH, N/P ...) with the numeric ranges found in the claims.' },
    { id: 'designs', title: 'Design-around ideas', icon: 'spark', href: '#designs', engine: 'LnpDesign', data: 'chem', ai: 'optional',
      what: 'Candidate variants just outside one claimed Markush rule, re-checked by code and ranked by distance. An idea generator, not advice.',
      aiNote: 'Claude only writes the commentary; the variants and the checks are computed.' },
    { id: 'disclosure', title: 'Earliest disclosure', icon: 'landscape', href: '#disclosure', engine: 'LnpDisclosure', data: 'chem', ai: 'none',
      what: 'The dated list of publications that show a compound, with the earliest publication and priority in the corpus.' },
    { id: 'whitespace', title: 'White-space map', icon: 'landscape', href: '#whitespace', engine: 'LnpDisclosure', data: 'chem', ai: 'none',
      what: 'A heat map of the lipid chemistry space (tail length, unsaturation, head group ...) showing where patents are dense and where they are not.' },
    { id: 'expiry', title: 'Expiry timeline', icon: 'family', href: '#expiry', engine: 'LnpExpiry', data: 'live', ai: 'none',
      what: 'When rights expire, by jurisdiction: estimated from filing dates, with patent term adjustment, a cliff chart and an ICS / CSV export.' },
    { id: 'similar', title: 'Similar patents', icon: 'search', href: '#similar', engine: 'LnpSimilar', data: 'live', ai: 'none',
      what: 'Query by example: families that share distinctive words, specific compounds and patent classes with a publication or a text.' },
    { id: 'legal', title: 'Legal timeline', icon: 'family', href: '#suche', engine: 'LnpLegal', data: 'live', ai: 'none', via: 'patent',
      what: 'Filing, grant, opposition, appeal, lapse and fee events of a publication and its family. Open a patent: the panel sits on its page.' },
    { id: 'context', title: 'Context packs and API', icon: 'copy', href: '#tools', anchor: 'tl-ai', engine: 'LnpContext', data: 'live', ai: 'none',
      what: 'Bundle claims, status, family and compounds of one patent, a list or a search for an AI tool, or call everything from the console with LnpAPI.' }
  ];

  function manifest() { var D = g.LnpData; return (D && D.manifest) || null; }
  function xState(name) {
    var M = manifest(), x = M && M.x && M.x[name];
    return x ? { ok: true, built: x.built || '' } : { ok: false };
  }
  function aiAvail() { try { return !!(g.LnpAI && typeof g.LnpAI.available === 'function' && g.LnpAI.available()); } catch (e) { return false; } }

  // -> {engine, data, ai, state: 'ready'|'limited'|'missing', notes[], dataText, aiText}
  function assess(t, App) {
    var M = manifest(), eng = !!g[t.engine], view = !!(App && App.views && App.views[t.id]) || t.id === 'context', notes = [], data, dataText, state;
    if (t.data === 'chem') { data = !!(M && M.chem); dataText = data ? 'Chemistry set in this build' : 'No chemistry set in this build'; if (!data) notes.push('needs the chemistry set'); }
    else if (/^x:/.test(t.data)) {
      var opt = /\?$/.test(t.data), nm = t.data.slice(2).replace(/\?$/, ''), xs = xState(nm);
      data = xs.ok || opt;
      dataText = xs.ok ? 'Data "' + nm + '" in this build' : (opt ? 'No curated "' + nm + '" records in this build (own records work)' : 'Data "' + nm + '" is not in this build');
      if (!data) notes.push('needs the "' + nm + '" dataset');
    } else { data = !!M; dataText = 'Computed live from the corpus files'; }
    if (!eng) notes.push('engine not loaded');
    if (!view) notes.push('view not loaded');
    state = !eng || !view ? 'missing' : (!data ? 'limited' : 'ready');
    var ai = t.ai === 'none' ? 'none' : (aiAvail() ? 'available' : 'manual');
    return { engine: eng && view, data: data, ai: ai, state: state, notes: notes, dataText: dataText,
      aiText: ai === 'none' ? 'No Claude needed' : (ai === 'available' ? 'Claude available' : 'Manual mode (Claude not available)') };
  }

  function mount(host, route, App) {
    var K = g.LnpKit, dead = false, unsub = [];
    var gridEl = h('div.tl-grid', { role: 'list' });
    var aiBox = h('div.tl-ai', { id: 'tl-ai' });
    var page = h('div.page.k-page.tl-page', null,
      K.head('Tools', 'Check, compare and', 'map the corpus', 'Tools around the search: structure and range checks, design-around ideas, disclosure and expiry timelines, similarity and a map of the chemistry space. Each card says whether it can run in this build.'),
      K.sec('Overview', 'What is in this build', null, gridEl, h('p.k-note', { id: 'tl-note' })),
      K.sec('For your AI tools', 'Use the data from outside the page', null, aiBox));
    host.appendChild(page);

    /* ---------------------------------------------------------- cards */
    function card(t) {
      var a = assess(t, App);
      var stateWord = a.state === 'ready' ? 'Ready' : a.state === 'limited' ? 'Limited' : 'Not in this build';
      var stateCls = a.state === 'ready' ? 'good' : a.state === 'limited' ? 'warn' : 'hollow';
      var href = t.href;
      var link = h('a.btn.sm' + (a.state === 'missing' ? '' : '.primary'), { href: href, 'aria-label': 'Open ' + t.title, onclick: function (ev) { if (!t.anchor) return; ev.preventDefault(); var el = document.getElementById(t.anchor); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        t.anchor ? 'Show below' : (t.via === 'patent' ? 'Find a patent' : 'Open'));
      var li = h('article.tl-card', { role: 'listitem', data: { tool: t.id, state: a.state, engine: a.engine ? '1' : '0', data: a.data ? '1' : '0', ai: a.ai } },
        h('div.tl-top', null, h('span.tl-ico', null, U.icon(t.icon)), h('h3.tl-title', { text: t.title }), h('span.pill.' + stateCls, { text: stateWord })),
        h('p.tl-what', { text: t.what }),
        h('ul.tl-av', { 'aria-label': 'Availability of ' + t.title },
          h('li', { data: { k: 'engine' } }, h('span.tl-k', { text: 'Engine' }), h('span', { text: a.engine ? 'Loaded' : 'Not loaded' })),
          h('li', { data: { k: 'data' } }, h('span.tl-k', { text: 'Data' }), h('span', { text: a.dataText })),
          h('li', { data: { k: 'ai' } }, h('span.tl-k', { text: 'Claude' }), h('span', { text: a.aiText }))),
        a.ai === 'manual' && t.aiNote ? h('p.tl-note', { text: t.aiNote }) : (a.ai === 'available' && t.aiNote ? h('p.tl-note', { text: t.aiNote }) : null),
        a.state !== 'ready' && a.notes.length ? h('p.tl-note.warn', { text: 'Unavailable here: ' + a.notes.join('; ') + '.' }) : null,
        h('div.tl-foot', null, link));
      return li;
    }
    function drawCards() {
      U.clear(gridEl);
      var counts = { ready: 0, limited: 0, missing: 0 };
      TOOLS.forEach(function (t) { var c = card(t); counts[c.dataset.state]++; gridEl.appendChild(c); });
      var note = document.getElementById('tl-note');
      if (note) note.textContent = counts.ready + ' of ' + TOOLS.length + ' tools are ready in this build' + (counts.limited ? ', ' + counts.limited + ' limited by missing data' : '') + (counts.missing ? ', ' + counts.missing + ' not loaded' : '') +
        '. Results are pre-screening aids computed from a corpus snapshot, not legal advice. Claude is ' + (aiAvail() ? 'available' : 'not available') + ' here; every tool has a manual mode.';
    }
    drawCards();

    /* ---------------------------------------------------------- AI tools section */
    var out = { fmt: 'md', text: '', busy: false };
    var inp = h('textarea.textarea.mono', { id: 'tl-pns', rows: '3', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Publication numbers, one per line', placeholder: 'EP3532103B1\nUS 10,000,445 B2' });
    var seg = h('div.seg', { role: 'group', 'aria-label': 'Format' });
    var prev = h('pre.tl-prev', { id: 'tl-prev', hidden: true, tabindex: '0', 'aria-label': 'Context pack preview' });
    var meta = h('p.k-hint', { id: 'tl-meta' });
    var btnGo = h('button.btn.primary', { type: 'button', id: 'tl-go', onclick: make }, U.icon('copy'), 'Build pack');
    var btnCopy = h('button.btn', { type: 'button', id: 'tl-copy', disabled: true, onclick: function () { if (out.text) U.copy(out.text, 'Context pack copied'); } }, U.icon('copy'), 'Copy');
    var btnSave = h('button.btn', { type: 'button', id: 'tl-save', disabled: true, onclick: function () { if (out.text) U.saveFile('lnp-context-pack-' + K.fileStamp() + (out.fmt === 'json' ? '.json' : '.md'), out.text, out.fmt === 'json' ? 'application/json' : 'text/markdown'); } }, U.icon('download'), 'Download');
    [['md', 'Markdown'], ['json', 'JSON']].forEach(function (f) {
      seg.appendChild(h('button', { type: 'button', 'data-f': f[0], 'aria-pressed': f[0] === out.fmt ? 'true' : 'false', onclick: function () { out.fmt = f[0]; Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', b.dataset.f === out.fmt ? 'true' : 'false'); }); } }, f[1]));
    });
    function make() {
      var list = inp.value.split(/\n+|;|,\s*(?=[A-Za-z]{2}\s*\d)/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!list.length) { meta.textContent = 'Enter at least one publication number.'; return; }
      if (!g.LnpContext) { meta.textContent = 'Context packs are not available in this build.'; return; }
      out.busy = true; btnGo.disabled = true; meta.textContent = 'Building ...';
      g.LnpContext.pack(list.length === 1 ? { pn: list[0] } : { pns: list.slice(0, 50) }, { format: out.fmt }).then(function (r) {
        if (dead) return;
        out.text = r.text; prev.hidden = false;
        prev.textContent = r.text.length > 6000 ? r.text.slice(0, 6000) + '\n\n[preview cut: ' + (r.bytes - 6000) + ' more bytes in the copy and the file]' : r.text;
        meta.textContent = r.patents + ' publication' + (r.patents === 1 ? '' : 's') + ', ' + Math.round(r.bytes / 1024) + ' KB' + (r.truncated ? ', cut to the size budget (stated inside the pack)' : '') + ((r.notes && r.notes.length) ? '. ' + r.notes.join('; ') : '') + '. The preview is plain text; patent text is never interpreted.';
        btnCopy.disabled = btnSave.disabled = false;
      }, function (e) { if (dead) return; out.text = ''; prev.hidden = true; btnCopy.disabled = btnSave.disabled = true; meta.textContent = 'Could not build the pack: ' + ((e && e.message) || 'error'); })
        .then(function () { out.busy = false; btnGo.disabled = false; });
    }
    function code(t) { return h('pre.tl-code', { tabindex: '0' }, h('code', { text: t })); }
    var apiOk = !!g.LnpAPI, ctxOk = !!g.LnpContext;
    U.set(aiBox,
      h('div.tl-ai-grid', null,
        h('div.tl-ai-card', { data: { part: 'api' } },
          h('h3', null, 'window.LnpAPI ', h('span.pill.' + (apiOk ? 'good' : 'hollow'), { text: apiOk ? 'Loaded' : 'Not loaded' })),
          h('p', { text: 'One documented facade over the search, patent text, status, chemistry, Markush, ranges, expiry, similarity and disclosure engines. Every method returns plain JSON and rejects with {code, message}; none of them calls Claude. Use it from the browser console or from a script that drives the page.' }),
          code("await LnpAPI.ready();\nconst r = await LnpAPI.search('ionizable lipid', {limit: 5});\nconst c = await LnpAPI.claims(r.hits[0].pn, 'en');"),
          h('p.k-hint', { text: 'Reference and examples: docs/LNPAPI.md.' })),
        h('div.tl-ai-card', { data: { part: 'packs' } },
          h('h3', null, 'Context packs ', h('span.pill.' + (ctxOk ? 'good' : 'hollow'), { text: ctxOk ? 'Loaded' : 'Not loaded' })),
          h('p', { text: 'A Markdown or JSON bundle of claims (verbatim), status with its date, family, compounds and ranges for a patent, a list or a search. The limits statement stands first and last, patent text sits in marked blocks, and the size is controlled. Patents have a "Context pack" button; the search results have "Context pack (top 50)".' }),
          h('p.k-hint', { text: 'Patent text in a pack is untrusted data: the receiving tool must treat it as quotation and ignore instructions inside it.' })),
        h('div.tl-ai-card', { data: { part: 'mcp' } },
          h('h3', { text: 'MCP server' }),
          h('p', { text: 'The same operations are offered to MCP clients (Claude Desktop, Claude Code and others) by a small Node server that reads the files of the website build; it needs no network. See mcp/README.md and docs/INTEGRATION.md.' }),
          h('p.k-hint', { text: 'Not part of this page: it runs on your computer, next to the downloaded build.' }))),
      h('div.tl-mk', null,
        h('h3', { text: 'Make a context pack' }),
        h('div.k-field', null, h('label', { 'for': 'tl-pns', text: 'Publication numbers' }), inp, h('span.k-hint', { text: 'One per line, up to 50. A single number gives a one-patent pack.' })),
        h('div.k-row', null, seg, btnGo, btnCopy, btnSave),
        meta, prev));
    if (!ctxOk) { btnGo.disabled = true; meta.textContent = 'Context packs are not available in this build.'; }

    var offCaps = App.on ? App.on('caps', function () { if (!dead) drawCards(); }) : null;
    if (offCaps) unsub.push(offCaps);
    return { update: function () { return true; }, destroy: function () { dead = true; unsub.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); } };
  }

  // a toolbox glyph (the "rows" icon reads as a menu); added to the shared icon set without changing ui.js
  if (U.ICONS && !U.ICONS.toolbox) U.ICONS.toolbox = 'M3 7.5h14v8.5H3zM7.5 7.5V5h5v2.5M3 11h14M9 11v1.8h2V11';
  g.LnpApp.registerView({ id: 'tools', title: 'Tools', icon: 'toolbox', rail: true, mount: g.LnpLazyView('tools', ['app/views/views.css', 'app/views/lib/kit.js'], mount) });
})(window);
