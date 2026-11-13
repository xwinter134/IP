/* LNP Patent Desk: AI provider settings ("bring your own key"). Route: #ai (under System).
   Choose a provider, enter an API key, list the provider's models and pick one per task tier (or one for all), test the
   connection, forget the key. Engine: engine/x-llm.js (LnpLLM); LnpAI uses the provider only where the claude.ai "sample"
   capability is absent. The key stays in this browser (localStorage or sessionStorage) and goes only to the chosen
   endpoint. Nothing here writes to the app store (LnpStore). Every provider text (model names, error replies) is inserted with textContent. */
(function (g) {
  'use strict';
  var U = g.LnpUI, h = U.h;
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

  var TIER_TEXT = {
    quick: ['Quick', 'Triage, query expansion, re-ranking of search hits. Many small calls: a fast, cheap model is enough.'],
    'default': ['Default', 'Claim charts, claim explanations, Markush translation and formula-image reading. Needs a capable model; images need a model that reads images.'],
    complex: ['Complex', 'Red-team review and the synthesis of an FTO analysis. Few calls: the strongest model you have.']
  };

  function mount(host, route, App) {
    var K = g.LnpKit, L = g.LnpLLM, dead = false, unsub = [], ctl = null;
    var page = h('div.page.k-page.ak-page');
    host.appendChild(page);
    if (!L) {
      page.appendChild(K.head('Settings', 'AI provider', null, 'Use the AI features with your own API key.'));
      page.appendChild(h('p.notice.err', { text: 'The provider engine (engine/x-llm.js) is not part of this build, so no own AI provider can be set up here.' }));
      return function () { };
    }
    var PROV = L.providers(), BY = {}; PROV.forEach(function (p) { BY[p.id] = p; });
    var cur = L.config(), c0 = cur.cfg || {};
    var st = { provider: c0.provider || 'anthropic', models: [], showAll: false, busy: false };

    /* ---------------------------------------------------------- controls */
    var provSel = h('select.select', { id: 'ak-provider', 'aria-label': 'Provider' }, PROV.map(function (p) { return h('option', { value: p.id, text: p.name, selected: p.id === st.provider }); }));
    var baseIn = h('input.input.mono', { id: 'ak-base', type: 'url', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://api.example.com/v1  or  http://localhost:11434/v1', value: c0.base || '' });
    var authSel = h('select.select', { id: 'ak-auth', 'aria-label': 'How the key is sent' },
      h('option', { value: 'bearer', text: 'Authorization: Bearer <key>', selected: c0.auth !== 'api-key' && c0.auth !== 'none' }),
      h('option', { value: 'api-key', text: 'api-key: <key> (Azure-style)', selected: c0.auth === 'api-key' }),
      h('option', { value: 'none', text: 'No key (local server)', selected: c0.auth === 'none' }));
    var keyIn = h('input.input.mono', { id: 'ak-key', type: 'password', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    var showBtn = h('button.btn.sm', { type: 'button', id: 'ak-show', 'aria-pressed': 'false', onclick: function () { var on = keyIn.type === 'password'; keyIn.type = on ? 'text' : 'password'; showBtn.textContent = on ? 'Hide' : 'Show'; showBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); } }, 'Show');
    var remember = h('input', { type: 'checkbox', id: 'ak-remember', checked: !!c0.remember });
    var keyState = h('p.k-hint', { id: 'ak-keystate' });
    var keyLink = h('p.k-hint', { id: 'ak-keylink' });
    var provNote = h('p.k-hint', { id: 'ak-provnote' });
    var baseField = K.field('Base URL', baseIn, 'https for every host; plain http only for a server on this computer (localhost, 127.0.0.1). Paths end before /chat/completions.');
    var authField = K.field('Key header', authSel);

    var oneModel = h('input', { type: 'checkbox', id: 'ak-one', checked: c0.oneModel !== false });
    var showAll = h('input', { type: 'checkbox', id: 'ak-all' });
    var dl = h('datalist', { id: 'ak-models' });
    var modelIn = {}, modelField = {};
    ['quick', 'default', 'complex'].forEach(function (t) {
      modelIn[t] = h('input.input.mono', { id: 'ak-model-' + t, list: 'ak-models', spellcheck: 'false', autocomplete: 'off', placeholder: t === 'default' ? 'load the list or type a model id' : 'same as Default when empty', value: (c0.models || {})[t] || '' });
      modelField[t] = K.field(t === 'default' ? 'Model (Default tier)' : TIER_TEXT[t][0] + ' tier', modelIn[t], TIER_TEXT[t][1]);
    });
    var vision = h('input', { type: 'checkbox', id: 'ak-vision', checked: c0.vision != null ? !!c0.vision : BY[st.provider].vision });
    var jsonMode = h('input', { type: 'checkbox', id: 'ak-json', checked: c0.jsonMode != null ? !!c0.jsonMode : BY[st.provider].jsonMode });
    var maxTok = h('input.input.mono', { id: 'ak-maxtok', type: 'number', min: '256', max: '200000', step: '256', value: String(c0.maxTokens || 8192) });
    var modelList = h('div.ak-models', { id: 'ak-modellist' });
    var statusBox = h('div', { id: 'ak-status' });
    var msgBox = h('div.ak-msg', { id: 'ak-msg', role: 'status', 'aria-live': 'polite' });
    var costBox = h('div', { id: 'ak-cost' });

    var loadBtn = h('button.btn', { type: 'button', id: 'ak-load', onclick: loadModels }, 'Load models');
    var testBtn = h('button.btn', { type: 'button', id: 'ak-test', onclick: testConn }, 'Test connection');
    var saveBtn = h('button.btn.primary', { type: 'button', id: 'ak-save', onclick: saveCfg }, U.icon('check'), 'Save and use');
    var forgetBtn = h('button.btn', { type: 'button', id: 'ak-forget', onclick: forgetKey }, 'Forget key');
    var resetBtn = h('button.btn.quiet', { type: 'button', id: 'ak-reset', onclick: resetAll }, 'Remove all AI settings');

    page.appendChild(K.head('Settings', 'AI provider', 'bring your own key',
      'Connect the AI features (FTO analysis, AI search help, claim explanations, Markush translation and formula-image reading, design-around commentary) to your own account at an AI provider. Without one, every tool keeps its manual mode.'));
    page.appendChild(K.sec('Now', 'Which AI answers here', null, statusBox));
    page.appendChild(K.sec('Step 1', 'Provider and key', null,
      h('div.k-form.ak-form', null, K.field('Provider', provSel), baseField, authField),
      provNote,
      h('div.ak-keyrow', null, K.field('API key', keyIn), showBtn),
      keyState, keyLink,
      h('label.k-check', { 'for': 'ak-remember' }, remember, 'Remember the key on this device (otherwise only until this tab is closed)')));
    page.appendChild(K.sec('Step 2', 'Models', h('div.k-row', null, loadBtn),
      h('p.k-note', { text: 'The list comes from the provider (its models endpoint) with your key. Pick one model for everything, or one per task tier. You can also type a model id the list does not show.' }),
      h('label.k-check', { 'for': 'ak-one' }, oneModel, 'One model for all tasks'),
      h('div.k-form.ak-form', null, modelField['default'], modelField.quick, modelField.complex), dl,
      h('div.k-row.ak-checks', null,
        h('label.k-check', { 'for': 'ak-vision' }, vision, 'The model reads images (formula images are sent)'),
        h('label.k-check', { 'for': 'ak-json' }, jsonMode, 'Use JSON mode where the provider has it'),
        h('label.k-check', { 'for': 'ak-all' }, showAll, 'Show non-chat models in the list')),
      h('div.k-inline', null, K.field('Max output tokens', maxTok, 'Per call. Lower it if the provider says the value is above the model limit.')),
      modelList));
    page.appendChild(K.sec('Step 3', 'Test and save', null,
      h('div.k-row', null, testBtn, saveBtn, forgetBtn, resetBtn), msgBox));
    page.appendChild(K.sec('Costs', 'Who pays', null, costBox));
    page.appendChild(K.sec('Privacy and security', 'Where your key and your data go', null,
      h('ul.k-list', { id: 'ak-privacy' },
        h('li', { text: 'The key is stored only in this browser: in localStorage when "Remember" is ticked, otherwise in sessionStorage (gone when the tab closes). It is not saved in the app database, the diagnostics, context packs, exports or links, and it is never shown in error messages.' }),
        h('li', { text: 'The key is sent only to the endpoint of the provider you chose, as a request header (never in the URL), without cookies and without following redirects.' }),
        h('li', { text: 'When you run an AI feature, the prompt goes to that provider: patent text (claims, definitions, formula images) and what you entered, such as your product profile, lipid structures and formulation data. The provider\'s terms decide how it stores or uses them; check them and your organisation\'s rules first.' }),
        h('li', { text: 'Anyone who can use this browser profile can use a remembered key. Use "Forget key" on shared computers, and prefer a key with a spending limit.' }),
        h('li', { text: 'In the claude.ai Artifact version, Claude through the Artifact is used first; your own provider is only used where that is not available (the Artifact may also block other hosts).' }))));
    page.appendChild(K.sec('Limits', 'What the AI output is', null,
      h('p.k-note', { text: 'Every AI result is a pre-screening aid, not legal advice. The prompts were written and tested with Claude; other models can answer differently or less reliably. Code still checks what code can check: quotes against the claim text, numbers, structure matches and the JSON structure of every reply (one repair call at most).' })));

    /* ---------------------------------------------------------- helpers */
    function P() { return BY[provSel.value]; }
    function setMsg(kind, text, extra) {
      U.clear(msgBox);
      if (!text) return;
      msgBox.appendChild(h('p.notice' + (kind === 'err' ? '.err' : kind === 'ok' ? '.ak-ok' : ''), { text: text }));
      if (extra) msgBox.appendChild(extra);
    }
    function draftCfg() {
      var m = { 'default': modelIn['default'].value.trim(), quick: modelIn.quick.value.trim(), complex: modelIn.complex.value.trim() };
      return { provider: provSel.value, base: baseIn.value.trim(), auth: authSel.value, models: m, oneModel: oneModel.checked, vision: vision.checked, jsonMode: jsonMode.checked,
        maxTokens: Number(maxTok.value) || 8192, remember: remember.checked };
    }
    function typedKey() { var k = keyIn.value.trim(); return k ? k : undefined; }
    function errLine(e) { return (e && e.message) ? String(e.message) : (e && e.code) ? String(e.code) : 'Unknown error'; }
    function busy(on) { st.busy = on; [loadBtn, testBtn, saveBtn].forEach(function (b) { b.disabled = on; }); }
    function drawProvider() {
      var p = P(), custom = !!p.custom;
      baseField.hidden = !custom; authField.hidden = !custom;
      U.set(provNote, p.note + (custom ? '' : ' Endpoint: ') , custom ? null : h('span.mono', { text: p.base }));
      U.clear(keyLink);
      if (p.keyUrl) keyLink.appendChild(h('span', null, 'Get a key: ', h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: p.keyUrl.replace(/^https:\/\//, '') })));
      var saved = cur.cfg && cur.cfg.provider === p.id && cur.hasKey;
      keyIn.placeholder = saved ? 'a key is stored; leave empty to keep it' : (custom ? 'optional for a local server' : 'paste your ' + p.name + ' API key');
      keyState.textContent = saved ? ('A key for ' + p.name + ' is stored ' + (cur.keyStore === 'local' ? 'on this device (localStorage).' : cur.keyStore === 'session' ? 'for this tab only (sessionStorage).' : 'in memory for this page only.')) : 'No key is stored for ' + p.name + '.';
      forgetBtn.disabled = !cur.hasKey;
      drawTiers();
    }
    function drawTiers() {
      var one = oneModel.checked;
      modelField.quick.hidden = one; modelField.complex.hidden = one;
    }
    function drawStatus() {
      var A = g.LnpAI, s = null;
      try { s = A && A.state ? A.state() : null; } catch (e) { s = null; }
      var av = !!(A && A.available && A.available());
      cur = L.config();
      var rows = [];
      if (av && s && s.source === 'sample') rows.push(h('p', null, h('span.pill.good', { text: 'AI available' }), ' ', h('b', { text: 'Claude (claude.ai Artifact)' }), '. This page runs inside claude.ai; your own provider is not used here.'));
      else if (av && s && s.source === 'provider') rows.push(h('p', null, h('span.pill.good', { text: 'AI available' }), ' ', h('b', { text: s.label || 'own provider' })));
      else if (av) rows.push(h('p', null, h('span.pill.good', { text: 'AI available' }), ' ', h('span', { text: (s && s.label) || '' })));
      else rows.push(h('p', null, h('span.pill.hollow', { text: 'No AI connected' }), ' Every tool works in its manual mode. Set up a provider below to switch the AI features on.'));
      if (s && s.off) rows.push(h('p.notice.err', { text: 'The AI was switched off after an error (' + s.off + '). ' + (A.message ? A.message({ code: s.off }) : '') }));
      if (cur.active) {
        var a = cur.active;
        rows.push(K.kv([['Provider', a.name], ['Default tier', a.models['default'] || '-'], ['Quick tier', a.models.quick || a.models['default'] || '-'], ['Complex tier', a.models.complex || a.models['default'] || '-'],
          ['Images', a.vision ? 'sent to the model' : 'not sent (text only)'], ['Key', cur.keyStore === 'local' ? 'remembered on this device' : cur.keyStore === 'session' ? 'this tab only' : cur.keyStore === 'memory' ? 'this page only' : 'none needed']]));
      }
      U.set(statusBox, rows);
      drawCost();
    }
    function fmtPrice(x) { return x >= 1 ? '$' + x.toFixed(2) : '$' + x.toFixed(3); }
    function drawCost() {
      var p = P(), lines = [h('p.k-note', { text: 'Every call is billed by ' + p.name + ' to your own account at its current prices; this app charges nothing and cannot see your bill. One call sends at most 256 KiB of text (roughly 65,000 tokens) plus any formula images; an FTO analysis makes several calls per publication (the FTO page shows the estimated number before you start), AI search help makes 2 to 4 calls, a claim explanation or Markush translation one call. Set a spending limit at the provider.' })];
      var m = st.models.filter(function (x) { return x.id === modelIn['default'].value.trim() && x.price; })[0];
      if (m) {
        var maxIn = 65000 / 1e6 * m.price.inPerM, out = (Number(maxTok.value) || 8192) / 1e6 * m.price.outPerM;
        lines.push(h('p.k-note', { id: 'ak-price' }, 'Listed price of ', h('span.mono', { text: m.id }), ': ' + fmtPrice(m.price.inPerM) + ' per million input tokens, ' + fmtPrice(m.price.outPerM) + ' per million output tokens. A call at the size limit costs at most about ' + fmtPrice(maxIn + out) + '; most calls are much smaller. Estimate only.'));
      } else if (p.custom) lines.push(h('p.k-hint', { text: 'A local server (Ollama, LM Studio) costs nothing per call; a hosted endpoint bills like any provider.' }));
      U.set(costBox, lines);
    }
    function drawModels() {
      U.clear(dl); U.clear(modelList);
      var list = st.models.filter(function (m) { return showAll.checked || m.chat; });
      list.forEach(function (m) { dl.appendChild(h('option', { value: m.id, label: m.name !== m.id ? m.name : null })); });
      if (!st.models.length) return;
      modelList.appendChild(h('p.k-hint', { text: list.length + ' of ' + st.models.length + ' models shown' + (showAll.checked ? '' : ' (chat models)') + '. Tap one to use it for the Default tier' + (oneModel.checked ? '' : '; type into the other fields for Quick and Complex') + '.' }));
      var ul = h('ul.ak-mlist', { role: 'list' });
      list.slice(0, 400).forEach(function (m) {
        var meta = [];
        if (m.name && m.name !== m.id) meta.push(m.name);
        if (m.ctx) meta.push(U.num(m.ctx) + ' tokens context');
        if (m.vision === true) meta.push('reads images'); else if (m.vision === false) meta.push('text only');
        if (m.price) meta.push(fmtPrice(m.price.inPerM) + ' / ' + fmtPrice(m.price.outPerM) + ' per M tokens');
        ul.appendChild(h('li', null, h('button.ak-mbtn', { type: 'button', 'aria-pressed': modelIn['default'].value.trim() === m.id ? 'true' : 'false', onclick: function () {
          modelIn['default'].value = m.id;
          if (typeof m.vision === 'boolean') vision.checked = m.vision;
          drawModels(); drawCost();
        } }, h('span.mono.ak-mid', { text: m.id }), meta.length ? h('span.ak-mmeta', { text: meta.join(' \u00b7 ') }) : null)));
      });
      modelList.appendChild(ul);
    }

    /* ---------------------------------------------------------- actions */
    function loadModels() {
      if (st.busy) return;
      busy(true); setMsg('', ''); U.set(modelList, K.busy('Asking ' + P().name + ' for its models (no prompt is sent)'));
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      L.listModels(draftCfg(), typedKey(), { signal: ctl && ctl.signal }).then(function (list) {
        if (dead) return;
        st.models = list; drawModels(); drawCost();
        setMsg('ok', list.length ? list.length + ' models found. Choose one and press "Test connection".' : 'The provider listed no models. Type a model id by hand.');
      }, function (e) {
        if (dead) return;
        U.clear(modelList);
        setMsg('err', 'The model list could not be loaded: ' + errLine(e) + (e && e.code === 'unreachable' ? ' Some providers do not allow calls from a web page (CORS); a gateway or a local server with an OpenAI-compatible endpoint is the way around.' : ''));
      }).then(function () { if (!dead) busy(false); });
    }
    function testConn() {
      if (st.busy) return;
      busy(true); setMsg('', ''); U.set(msgBox, K.busy('One short test call to ' + P().name + ' ("Reply with OK")'));
      L.test(draftCfg(), typedKey()).then(function (r) {
        if (dead) return;
        setMsg('ok', 'Connection works: ' + r.model + ' answered in ' + U.num(r.ms) + ' ms' + (r.reply ? ' ("' + r.reply + '")' : '') + '. Press "Save and use" to switch the AI features on.');
      }, function (e) {
        if (dead) return;
        var A = g.LnpAI, hint = A && A.message && e && e.code ? A.message(e) : '';
        setMsg('err', 'Test failed: ' + errLine(e), hint ? h('p.k-hint', { text: hint }) : null);
      }).then(function () { if (!dead) busy(false); });
    }
    function saveCfg() {
      try {
        L.save(draftCfg(), typedKey());
      } catch (e) {
        setMsg('err', errLine(e));
        var f = e && e.field === 'key' ? keyIn : e && e.field === 'base' ? baseIn : e && e.field === 'model' ? modelIn['default'] : null;
        if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); }
        return;
      }
      [keyIn, baseIn, modelIn['default']].forEach(function (f) { f.removeAttribute('aria-invalid'); });
      keyIn.value = ''; keyIn.type = 'password'; showBtn.textContent = 'Show'; showBtn.setAttribute('aria-pressed', 'false');
      cur = L.config(); drawProvider(); drawStatus();
      setMsg('ok', 'Saved. The AI features now use ' + (cur.active ? cur.active.name + ' \u00b7 ' + cur.active.model : 'your provider') + ' wherever Claude through claude.ai is not available.');
      U.toast('AI provider saved');
    }
    function forgetKey() {
      L.forget(); keyIn.value = '';
      cur = L.config(); drawProvider(); drawStatus();
      setMsg('ok', 'The key was removed from this browser. The AI features are off until you enter a key again.');
    }
    function resetAll() {
      L.resetAll(); keyIn.value = '';
      ['quick', 'default', 'complex'].forEach(function (t) { modelIn[t].value = ''; });
      st.models = []; drawModels();
      cur = L.config(); drawProvider(); drawStatus();
      setMsg('ok', 'All AI provider settings and the key were removed from this browser.');
    }

    provSel.addEventListener('change', function () {
      var p = P(); st.models = []; drawModels();
      vision.checked = p.vision; jsonMode.checked = p.jsonMode;
      if (!(cur.cfg && cur.cfg.provider === p.id)) ['quick', 'default', 'complex'].forEach(function (t) { modelIn[t].value = ''; });
      setMsg('', ''); drawProvider(); drawCost();
    });
    oneModel.addEventListener('change', drawTiers);
    showAll.addEventListener('change', drawModels);
    modelIn['default'].addEventListener('change', drawCost);
    maxTok.addEventListener('change', drawCost);

    drawProvider(); drawStatus();
    if (App && App.on) unsub.push(App.on('caps', function () { if (!dead) drawStatus(); }));
    return { update: function () { return true; }, destroy: function () { dead = true; if (ctl && ctl.abort) ctl.abort(); keyIn.value = ''; unsub.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); } };
  }

  g.LnpApp.registerView({ id: 'ai', title: 'AI provider', icon: 'spark', rail: true, parent: 'system', mount: g.LnpLazyView('ai', ['app/views/views.css', 'app/views/lib/kit.js', 'app/x-aikeys.css'], mount) });
})(window);
