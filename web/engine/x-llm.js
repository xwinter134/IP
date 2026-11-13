/* LNP Patent Desk: "bring your own key" AI access (global LnpLLM). Plain script, ASCII only, no dependencies.
   Provider adapters behind one function with the contract of the Artifact "sample" capability:
     call(input, {modelTier, images, signal, onText, json}) -> {text, truncated, modelTierApplied}
   input: a string or a list of turns {role: "user" | "assistant", content}. Registered with LnpAI.useProvider(); LnpAI uses it
   only when the claude.ai "sample" capability is absent (order: sample > own provider > off). Queue, 256 KiB cap, schema
   validation and the one repair call stay in LnpAI.
   Providers: Anthropic (Messages API), OpenAI (Chat Completions), Google Gemini (generateContent), Mistral, OpenRouter and any
   OpenAI-compatible endpoint with its own base URL (gateways, Groq, Together, DeepSeek, Ollama, LM Studio ...).
   No model identifier is written here: models are listed from the provider's models endpoint and chosen by the user.
   Security:
   - the key lives in this closure and in browser storage only (localStorage "lnp.llm.key" when remembered, else sessionStorage);
     never in LnpStore, diagnostics, context packs, exports, URLs, logs or error text (every message is redacted);
   - it is sent only as a request header to the configured endpoint (same origin checked per request, redirects refused,
     no cookies, no referrer); a custom base URL must be https, or http on localhost / 127.0.0.1 / [::1];
   - nothing is written to the console. Prompts (and patent text inside them) are passed through unchanged.
   API: docs/INTEGRATION.md ("Use your own AI provider"). */
(function (g) {
  'use strict';
  var CFG_KEY = 'lnp.llm.cfg', KEY_KEY = 'lnp.llm.key';
  var TIERS = ['quick', 'default', 'complex'];
  var IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  var MAX_PROMPT_BYTES = 262144, IMG_MAX_BYTES = 3500000;
  var CALL_TIMEOUT = 300000, SMALL_TIMEOUT = 30000;
  var DEFAULT_MAX_TOKENS = 8192;
  /* model ids that are clearly not chat models (hidden unless "show all"); a filter on words, not a list of models */
  var NON_CHAT = /(embed|tts|whisper|dall-e|moderation|transcri|realtime|audio|speech|rerank|davinci|babbage|image-gen|imagen|veo|-search)/i;

  var PROVIDERS = [
    { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', base: 'https://api.anthropic.com', needsKey: true, vision: true, jsonMode: false, maxImages: 20,
      keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Messages API, called directly from the browser (header anthropic-dangerous-direct-browser-access).' },
    { id: 'openai', name: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', needsKey: true, vision: true, jsonMode: true, tokenParam: 'max_completion_tokens', maxImages: 10,
      keyUrl: 'https://platform.openai.com/api-keys', note: 'Chat Completions API.' },
    { id: 'gemini', name: 'Google Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, vision: true, jsonMode: true, maxImages: 16,
      keyUrl: 'https://aistudio.google.com/apikey', note: 'Gemini API generateContent; the key goes in a header, never in the URL.' },
    { id: 'mistral', name: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai/v1', needsKey: true, vision: false, jsonMode: true, imageUrlString: true, maxImages: 8,
      keyUrl: 'https://console.mistral.ai/api-keys', note: 'Chat Completions API of Mistral.' },
    { id: 'openrouter', name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', needsKey: true, vision: true, jsonMode: false, maxImages: 10,
      keyUrl: 'https://openrouter.ai/keys', note: 'One key for models of many providers; the model list shows prices.' },
    { id: 'compatible', name: 'OpenAI-compatible endpoint', kind: 'openai', base: '', custom: true, needsKey: false, vision: false, jsonMode: false, maxImages: 8,
      keyUrl: '', note: 'Any server with /chat/completions and /models: gateways (also Azure-style with an api-key header), Groq, Together, DeepSeek, local Ollama or LM Studio.' }
  ];
  var BY_ID = {}; PROVIDERS.forEach(function (p) { BY_ID[p.id] = p; });

  var S = { cfg: null, key: null, keyStore: null, fetch: null, applied: false };

  function mkErr(code, message, extra) { var e = { code: code, message: message || code }, k; if (extra) for (k in extra) e[k] = extra[k]; return e; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ------------------------------------------------------------------------------------------------ redaction
  var SECRET_RES = [/\bsk-[A-Za-z0-9_\-]{6,}/g, /\bAIza[0-9A-Za-z_\-]{10,}/g, /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{6,}/gi, /\b(x-api-key|api-key|x-goog-api-key|authorization)\s*[:=]\s*\S+/gi, /([?&](key|api_key|apikey|token)=)[^&\s]+/gi];
  /* redact(s, extraKey?) -> s with the stored key, the given key and anything that looks like a key replaced by [redacted] */
  function redact(s, extra) {
    s = String(s == null ? '' : s);
    [S.key, extra].forEach(function (k) {
      if (typeof k !== 'string' || k.length < 4) return;
      s = s.split(k).join('[redacted]');
      if (k.length >= 16) { s = s.split(k.slice(0, 12)).join('[redacted]'); s = s.split(k.slice(-12)).join('[redacted]'); }
    });
    SECRET_RES.forEach(function (re) { s = s.replace(re, function (m, a, b) { return re.source.indexOf('[?&]') >= 0 ? a + '[redacted]' : '[redacted]'; }); });
    return s;
  }
  function cleanText(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 300); }

  // ------------------------------------------------------------------------------------------------ validation
  function isLocalHost(h) { h = String(h || '').toLowerCase(); return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'; }
  /* validateBase(url) -> {ok: true, url} | {ok: false, error}; https anywhere, http only on this machine */
  function validateBase(url) {
    var u, s = String(url == null ? '' : url).trim();
    if (!s) return { ok: false, error: 'Enter the base URL of the endpoint, e.g. https://api.example.com/v1 or http://localhost:11434/v1.' };
    if (s.length > 300) return { ok: false, error: 'The base URL is too long.' };
    try { u = new URL(s); } catch (e) { return { ok: false, error: 'This is not a valid URL.' }; }
    if (u.username || u.password) return { ok: false, error: 'The URL must not contain a user name or password; put the key in the key field.' };
    if (u.search || u.hash || /[?#]/.test(s)) return { ok: false, error: 'The URL must not contain a query (?) or fragment (#); a key never belongs in the URL.' };
    if (u.protocol === 'https:') { /* ok */ }
    else if (u.protocol === 'http:') { if (!isLocalHost(u.hostname)) return { ok: false, error: 'Plain http is only allowed for a server on this computer (localhost, 127.0.0.1). Use https for every other host.' }; }
    else return { ok: false, error: 'Only https URLs (or http on localhost) are allowed.' };
    return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') };
  }
  function validKey(k) { return typeof k === 'string' && k.length >= 8 && k.length <= 600 && /^[\x21-\x7e]+$/.test(k); }
  function cleanModel(m) { m = String(m == null ? '' : m).trim(); return /^[\x21-\x7e]{1,200}$/.test(m) && !/[\\"'<>`]/.test(m) ? m : ''; }

  /* normalize(cfg) -> a clean config or throws {code: "invalid_config", message, field} */
  function normalize(c) {
    c = c || {};
    var P = BY_ID[c.provider];
    if (!P) throw mkErr('invalid_config', 'Choose a provider.', { field: 'provider' });
    var o = { v: 1, provider: P.id, base: '', auth: 'bearer', models: {}, oneModel: c.oneModel !== false, maxTokens: DEFAULT_MAX_TOKENS,
      vision: c.vision == null ? P.vision : !!c.vision, jsonMode: c.jsonMode == null ? P.jsonMode : !!c.jsonMode, remember: !!c.remember };
    if (P.custom) {
      var b = validateBase(c.base);
      if (!b.ok) throw mkErr('invalid_config', b.error, { field: 'base' });
      o.base = b.url;
      o.auth = c.auth === 'api-key' || c.auth === 'none' ? c.auth : 'bearer';
    }
    var mt = Number(c.maxTokens);
    if (isFinite(mt) && mt > 0) o.maxTokens = Math.max(256, Math.min(200000, Math.round(mt)));
    var m = c.models || {};
    TIERS.forEach(function (t) { var x = cleanModel(m[t]); if (x) o.models[t] = x; });
    if (o.oneModel) { var d = o.models['default']; o.models = d ? { quick: d, 'default': d, complex: d } : {}; }
    return o;
  }

  // ------------------------------------------------------------------------------------------------ storage (browser only)
  function store(name) { try { var s = g[name]; if (s && typeof s.getItem === 'function') return s; } catch (e) { /* blocked */ } return null; }
  function sGet(st, k) { try { return st ? st.getItem(k) : null; } catch (e) { return null; } }
  function sSet(st, k, v) { try { if (st) { st.setItem(k, v); return true; } } catch (e) { /* quota or blocked */ } return false; }
  function sDel(st, k) { try { if (st) st.removeItem(k); } catch (e) { /* ignore */ } }
  function load() {
    var raw = sGet(store('localStorage'), CFG_KEY), cfg = null;
    if (raw) { try { cfg = normalize(JSON.parse(raw)); } catch (e) { cfg = null; } }
    S.cfg = cfg;
    var k = sGet(store('sessionStorage'), KEY_KEY), where = 'session';
    if (!k) { k = sGet(store('localStorage'), KEY_KEY); where = 'local'; }
    S.key = validKey(k) ? k : null; S.keyStore = S.key ? where : null;
    return apply();
  }
  function writeKey(key, remember) {
    var L = store('localStorage'), Se = store('sessionStorage');
    sDel(L, KEY_KEY); sDel(Se, KEY_KEY);
    S.key = null; S.keyStore = null;
    if (!key) return;
    S.key = key;
    if (remember && sSet(L, KEY_KEY, key)) S.keyStore = 'local';
    else if (sSet(Se, KEY_KEY, key)) S.keyStore = 'session';
    else S.keyStore = 'memory';
  }

  // ------------------------------------------------------------------------------------------------ HTTP
  function prov(cfg) { return BY_ID[cfg.provider]; }
  function baseOf(cfg) { var P = prov(cfg); return P.custom ? cfg.base : P.base; }
  function authHeaders(cfg, key) {
    var P = prov(cfg), h = {};
    if (P.kind === 'anthropic') { h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; h['anthropic-dangerous-direct-browser-access'] = 'true'; }
    else if (P.kind === 'gemini') h['x-goog-api-key'] = key;
    else if (P.custom) { if (key && cfg.auth === 'api-key') h['api-key'] = key; else if (key && cfg.auth === 'bearer') h.authorization = 'Bearer ' + key; }
    else h.authorization = 'Bearer ' + key;
    return h;
  }
  function errFromHttp(P, status, data, text, key, phase) {
    var e = data && data.error, msg = '';
    if (e && typeof e === 'object') msg = e.message || e.msg || e.status || e.type || '';
    else if (typeof e === 'string') msg = e;
    if (!msg && data && typeof data === 'object') msg = data.message || data.detail || data.title || '';
    if (Array.isArray(data) && data[0] && data[0].error) msg = data[0].error.message || '';
    if (typeof msg !== 'string') { try { msg = JSON.stringify(msg); } catch (x) { msg = ''; } }
    if (!msg) msg = text || '';
    msg = redact(cleanText(msg, 300), key);
    var etype = String((e && (e.type || e.status || e.code)) || ''), all = msg + ' ' + etype, code;
    if (status === 401 || /api[ _-]?key[ _-]?(not valid|invalid)|invalid[ _-]api[ _-]key|API_KEY_INVALID|authentication|unauthori[sz]ed|incorrect api key/i.test(all)) code = 'key_invalid';
    else if (status === 429 || /rate.?limit|RESOURCE_EXHAUSTED|quota|insufficient_quota|too many requests/i.test(all)) code = 'rate_limited';
    else if (status === 403) code = /region|country|location/i.test(all) ? 'refused' : 'key_invalid';
    else if (status === 408 || status === 504 || status === 524) code = 'timeout';
    else if (status === 413) code = 'prompt_too_large';
    else if (/max_tokens|max_completion_tokens|maxOutputTokens|output tokens/i.test(all) && !/context|prompt is too long/i.test(all)) code = 'invalid_request';
    else if (/context[ _]?(length|window)|too long|too many tokens|maximum context|exceeds? the (maximum|limit|context)|request too large|token limit|input is too large/i.test(all)) code = 'prompt_too_large';
    else if (/image|vision|multimodal|inline_data|image_url/i.test(all) && status === 400) code = 'images_unavailable';
    else if (status === 404 || /model[^.]*(not found|does not exist|not exist|unknown|invalid|not supported|unsupported)|model_not_found|no such model|NOT_FOUND/i.test(all)) code = phase === 'models' ? 'not_found' : 'model_unavailable';
    else if (/safety|content[_ ]?(policy|filter)|blocked|prohibited/i.test(all)) code = 'refused';
    else if (status >= 500) code = 'upstream_error';
    else code = 'invalid_request';
    return mkErr(code, P.name + ' answered HTTP ' + status + (msg ? ': ' + msg : ''), { status: status, provider: P.id });
  }
  /* request(cfg, key, {path | url, method, body, signal, timeout, phase}) -> parsed JSON reply */
  function request(cfg, key, o) {
    var P = prov(cfg), base = baseOf(cfg), url = o.url || (base + o.path), f = S.fetch || g.fetch;
    if (typeof f !== 'function') return Promise.reject(mkErr('unreachable', 'This browser has no fetch().'));
    var bo, uo;
    try { bo = new URL(base).origin; uo = new URL(url).origin; } catch (e) { return Promise.reject(mkErr('invalid_request', 'bad endpoint URL')); }
    // the key is only ever sent to the configured endpoint
    if (bo !== uo) return Promise.reject(mkErr('invalid_request', 'refused to send a request outside the configured endpoint'));
    if (o.signal && o.signal.aborted) return Promise.reject(mkErr('cancelled', 'cancelled'));
    var Ctl = g.AbortController, ctl = Ctl ? new Ctl() : null, timedOut = false, timer = null, onAbort = null;
    if (ctl) {
      timer = setTimeout(function () { timedOut = true; ctl.abort(); }, o.timeout || CALL_TIMEOUT);
      if (o.signal) { onAbort = function () { ctl.abort(); }; o.signal.addEventListener('abort', onAbort); }
    }
    var headers = authHeaders(cfg, key);
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    var init = { method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers: headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' };
    if (o.body !== undefined) init.body = JSON.stringify(o.body);
    if (ctl) init.signal = ctl.signal;
    function done() { if (timer) clearTimeout(timer); if (onAbort && o.signal) o.signal.removeEventListener('abort', onAbort); }
    return Promise.resolve().then(function () { return f(url, init); }).then(function (res) {
      return Promise.resolve(res.text()).then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!res.ok) throw errFromHttp(P, res.status, data, t, key, o.phase);
        if (data === null) throw mkErr('upstream_error', P.name + ' sent a reply that is not JSON.');
        done(); return data;
      });
    }).then(null, function (e) {
      done();
      if (e && typeof e === 'object' && typeof e.code === 'string' && !(e.name === 'AbortError')) { e.message = redact(e.message, key); throw e; }
      if (o.signal && o.signal.aborted) throw mkErr('cancelled', 'cancelled');
      if (timedOut) throw mkErr('timeout', P.name + ' did not answer within ' + Math.round((o.timeout || CALL_TIMEOUT) / 1000) + ' s.');
      throw mkErr('unreachable', P.name + ' could not be reached from this page (network error, CORS policy of the provider or the security policy of the page)' +
        (e && e.message ? ': ' + redact(cleanText(e.message, 120), key) : '') + '.');
    });
  }

  // ------------------------------------------------------------------------------------------------ images
  function toBase64(bytes) {
    var s = '', CH = 0x8000, i;
    for (i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    if (typeof g.btoa === 'function') return g.btoa(s);
    return Buffer.from(s, 'binary').toString('base64');
  }
  /* image -> {mediaType, data (base64)}; a Blob / File, or {type | mediaType, data: base64} */
  function readImage(img) {
    if (img && typeof img.arrayBuffer === 'function') {
      return Promise.resolve(img.arrayBuffer()).then(function (buf) { return { mediaType: img.type || 'image/png', data: toBase64(new Uint8Array(buf)) }; });
    }
    if (img && typeof img.data === 'string') return Promise.resolve({ mediaType: img.mediaType || img.type || 'image/png', data: img.data });
    return Promise.reject(mkErr('image_rejected', 'an image could not be read'));
  }

  // ------------------------------------------------------------------------------------------------ adapters
  function turnsOf(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (Array.isArray(input)) return input.map(function (t) { return { role: t && t.role === 'assistant' ? 'assistant' : 'user', content: String(t && t.content != null ? t.content : '') }; });
    throw mkErr('invalid_request', 'input must be a string or a list of turns');
  }
  function firstUser(turns) { for (var i = 0; i < turns.length; i++) if (turns[i].role === 'user') return i; return 0; }

  var ADAPT = {
    anthropic: {
      chatPath: function () { return '/v1/messages'; },
      body: function (cfg, P, model, turns, imgs, o) {
        var fu = firstUser(turns);
        return { model: model, max_tokens: o.maxTokens || cfg.maxTokens, messages: turns.map(function (t, i) {
          if (i !== fu || !imgs.length) return { role: t.role, content: t.content };
          return { role: t.role, content: imgs.map(function (im) { return { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }; }).concat([{ type: 'text', text: t.content }]) };
        }) };
      },
      parse: function (d, P) {
        var text = (d && Array.isArray(d.content) ? d.content : []).filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text; }).join('');
        var stop = d && d.stop_reason;
        if (stop === 'refusal' && !text) throw mkErr('refused', P.name + ': the model declined the request.');
        return { text: text, truncated: stop === 'max_tokens' };
      },
      modelsPath: '/v1/models?limit=1000',
      models: function (d) { return (d && d.data || []).map(function (m) { return { id: m.id, name: m.display_name || m.id }; }); },
      next: function (d) { return d && d.has_more && d.last_id ? '/v1/models?limit=1000&after_id=' + encodeURIComponent(d.last_id) : null; }
    },
    openai: {
      chatPath: function () { return '/chat/completions'; },
      body: function (cfg, P, model, turns, imgs, o) {
        var fu = firstUser(turns);
        var b = { model: model, messages: turns.map(function (t, i) {
          if (i !== fu || !imgs.length) return { role: t.role, content: t.content };
          return { role: t.role, content: [{ type: 'text', text: t.content }].concat(imgs.map(function (im) {
            var url = 'data:' + im.mediaType + ';base64,' + im.data;
            return { type: 'image_url', image_url: P.imageUrlString ? url : { url: url } };
          })) };
        }) };
        b[P.tokenParam || 'max_tokens'] = o.maxTokens || cfg.maxTokens;
        if (o.json && cfg.jsonMode) b.response_format = { type: 'json_object' };
        return b;
      },
      parse: function (d, P) {
        var ch = d && Array.isArray(d.choices) ? d.choices[0] : null, m = ch && ch.message, text = '';
        if (m) {
          if (typeof m.content === 'string') text = m.content;
          else if (Array.isArray(m.content)) text = m.content.map(function (c) { return typeof c === 'string' ? c : (c && (c.text || '')); }).join('');
          if (!text && m.refusal) throw mkErr('refused', P.name + ': the model declined the request.');
        }
        var fr = ch && ch.finish_reason;
        if (!text && fr === 'content_filter') throw mkErr('refused', P.name + ': the reply was blocked by a content filter.');
        return { text: text || '', truncated: fr === 'length' || fr === 'max_tokens' };
      },
      modelsPath: '/models',
      models: function (d) {
        var list = Array.isArray(d) ? d : (d && (d.data || d.models)) || [];
        return list.filter(function (m) { return m && (m.id || m.name) && !(m.capabilities && m.capabilities.completion_chat === false); }).map(function (m) {
          var o = { id: String(m.id || m.name), name: String(m.name || m.id) };
          var mods = m.architecture && m.architecture.input_modalities;
          if (Array.isArray(mods)) o.vision = mods.indexOf('image') >= 0;
          else if (m.capabilities && typeof m.capabilities.vision === 'boolean') o.vision = m.capabilities.vision;
          var ctx = m.context_length || m.max_context_length; if (ctx > 0) o.ctx = ctx;
          if (m.pricing && isFinite(+m.pricing.prompt) && isFinite(+m.pricing.completion)) o.price = { inPerM: +m.pricing.prompt * 1e6, outPerM: +m.pricing.completion * 1e6 };
          return o;
        });
      },
      next: function () { return null; }
    },
    gemini: {
      chatPath: function (model) { return '/models/' + encodeURIComponent(String(model).replace(/^models\//, '')) + ':generateContent'; },
      body: function (cfg, P, model, turns, imgs, o) {
        var fu = firstUser(turns);
        var b = { contents: turns.map(function (t, i) {
          var parts = [{ text: t.content }];
          if (i === fu && imgs.length) parts = parts.concat(imgs.map(function (im) { return { inline_data: { mime_type: im.mediaType, data: im.data } }; }));
          return { role: t.role === 'assistant' ? 'model' : 'user', parts: parts };
        }), generationConfig: { maxOutputTokens: o.maxTokens || cfg.maxTokens } };
        if (o.json && cfg.jsonMode) b.generationConfig.responseMimeType = 'application/json';
        return b;
      },
      parse: function (d, P) {
        if (d && d.promptFeedback && d.promptFeedback.blockReason) throw mkErr('refused', P.name + ': the request was blocked (' + cleanText(d.promptFeedback.blockReason, 40) + ').');
        var c = d && Array.isArray(d.candidates) ? d.candidates[0] : null, parts = (c && c.content && c.content.parts) || [];
        var text = parts.filter(function (p) { return p && typeof p.text === 'string' && !p.thought; }).map(function (p) { return p.text; }).join('');
        var fr = c && c.finishReason;
        if (!text && /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/.test(String(fr || ''))) throw mkErr('refused', P.name + ': the reply was blocked (' + cleanText(fr, 40) + ').');
        return { text: text, truncated: fr === 'MAX_TOKENS' };
      },
      modelsPath: '/models?pageSize=1000',
      models: function (d) {
        return (d && d.models || []).filter(function (m) { return !m.supportedGenerationMethods || m.supportedGenerationMethods.indexOf('generateContent') >= 0; }).map(function (m) {
          var o = { id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || String(m.name || '').replace(/^models\//, '') };
          if (m.inputTokenLimit > 0) o.ctx = m.inputTokenLimit;
          return o;
        }).filter(function (m) { return m.id; });
      },
      next: function (d) { return d && d.nextPageToken ? '/models?pageSize=1000&pageToken=' + encodeURIComponent(d.nextPageToken) : null; }
    }
  };

  function needKey(cfg) { var P = prov(cfg); return P.needsKey || (P.custom && cfg.auth !== 'none'); }
  function pickModel(cfg, tier) {
    var t = TIERS.indexOf(tier) >= 0 ? tier : 'default';
    if (cfg.models[t]) return { model: cfg.models[t], tier: t };
    return { model: cfg.models['default'] || '', tier: 'default' };
  }
  /* one call with an explicit config and key (draft settings or the saved ones) */
  function callWith(cfg, key, input, opt) {
    opt = opt || {};
    var P = prov(cfg), A = ADAPT[P.kind];
    return Promise.resolve().then(function () {
      if (needKey(cfg) && !validKey(key)) throw mkErr('key_invalid', 'No API key is set for ' + P.name + '.');
      var pm = pickModel(cfg, opt.modelTier);
      if (!pm.model) throw mkErr('model_unavailable', 'No model is chosen for ' + P.name + '.');
      var turns = turnsOf(input), imgs = Array.isArray(opt.images) ? opt.images : [];
      if (imgs.length && !cfg.vision) throw mkErr('images_unavailable', 'The chosen model is set as text only; images are not sent.');
      return Promise.all(imgs.map(readImage)).then(function (list) {
        var body = A.body(cfg, P, pm.model, turns, list, { json: !!opt.json, maxTokens: opt.maxTokens });
        return request(cfg, key, { path: A.chatPath(pm.model), body: body, signal: opt.signal, timeout: opt.timeout || CALL_TIMEOUT, phase: 'call' });
      }).then(function (d) {
        var r = A.parse(d, P);
        if (!r.text && !r.truncated && !opt.allowEmpty) throw mkErr('empty_completion', P.name + ' returned no text.');
        if (typeof opt.onText === 'function' && r.text) { try { opt.onText({ text: r.text, delta: r.text }); } catch (e) { /* ignore */ } }
        return { text: r.text, truncated: !!r.truncated, modelTierApplied: pm.tier };
      });
    });
  }

  // ------------------------------------------------------------------------------------------------ LnpAI registration
  function ready() { var c = S.cfg; return !!(c && c.models['default'] && (!needKey(c) || validKey(S.key))); }
  function limitsFor(cfg) {
    var P = prov(cfg), l = { maxPromptBytes: MAX_PROMPT_BYTES, modelTiers: TIERS.slice() };
    if (cfg.vision) l.images = { maxCount: P.maxImages || 8, maxInputBytes: IMG_MAX_BYTES, mediaTypes: IMG_TYPES.slice() };
    return l;
  }
  function active() {
    if (!ready()) return null;
    var P = prov(S.cfg);
    return { provider: P.id, name: P.name, model: S.cfg.models['default'], models: { quick: S.cfg.models.quick, 'default': S.cfg.models['default'], complex: S.cfg.models.complex }, vision: S.cfg.vision };
  }
  var providerObj = {
    id: 'own',
    label: function () { var a = active(); return a ? a.name + ' \u00b7 ' + a.model : 'own provider (not set up)'; },
    call: function (input, opt) { if (!ready()) return Promise.reject(mkErr('unavailable', 'no AI provider is set up')); return callWith(S.cfg, S.key, input, opt); },
    limits: function () { return S.cfg ? limitsFor(S.cfg) : { maxPromptBytes: MAX_PROMPT_BYTES }; },
    toJSON: function () { return { id: 'own' }; }
  };
  function apply() {
    var A = g.LnpAI;
    if (!A || typeof A.useProvider !== 'function') return false;
    A.useProvider(ready() ? providerObj : null);
    S.applied = true;
    var App = g.LnpApp;
    if (App && App.booted && typeof A.init === 'function') {
      Promise.resolve(A.init()).then(function () { if (typeof App.emit === 'function') App.emit('caps', 'ai'); }, function () { /* ignore */ });
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------ public API
  function config() {
    var c = S.cfg ? JSON.parse(JSON.stringify(S.cfg)) : null;
    return { cfg: c, hasKey: !!S.key, keyStore: S.keyStore, ready: ready(), active: active() };
  }
  /* save(cfg, key?) -> config(); key undefined = keep the stored key, "" = remove it */
  function save(cfg, key) {
    var c = normalize(cfg);
    if (key !== undefined && key !== null) {
      key = String(key).trim();
      if (key && !validKey(key)) throw mkErr('invalid_config', 'The key has an unexpected form (8 to 600 visible characters, no spaces).', { field: 'key' });
    }
    if (!c.models['default']) throw mkErr('invalid_config', 'Choose a model (at least the default one).', { field: 'model' });
    var keep = (key === undefined || key === null) ? S.key : key;
    if (S.cfg && S.cfg.provider !== c.provider && (key === undefined || key === null)) keep = null;   // a key belongs to one provider
    if (needKey(c) && !validKey(keep)) throw mkErr('invalid_config', 'Enter the API key of ' + prov(c).name + '.', { field: 'key' });
    if (!sSet(store('localStorage'), CFG_KEY, JSON.stringify(c))) { /* settings then live for this page only */ }
    S.cfg = c;
    writeKey(needKey(c) ? keep : null, c.remember);
    apply();
    return config();
  }
  function forget() { writeKey(null); apply(); return config(); }
  function resetAll() { writeKey(null); sDel(store('localStorage'), CFG_KEY); S.cfg = null; apply(); return config(); }
  function draft(cfg, key) {
    var c = normalize(cfg || S.cfg);
    var k = (key === undefined || key === null || key === '') ? ((S.cfg && S.cfg.provider === c.provider) ? S.key : null) : String(key).trim();
    if (needKey(c) && !validKey(k)) throw mkErr('key_invalid', 'Enter the API key of ' + prov(c).name + ' first.');
    return { cfg: c, key: k };
  }
  /* listModels(cfg?, key?) -> [{id, name, chat, vision?, ctx?, price?}] from the provider's models endpoint */
  function listModels(cfg, key, o) {
    o = o || {};
    return Promise.resolve().then(function () {
      var d = draft(cfg, key), P = prov(d.cfg), A = ADAPT[P.kind], out = [], pages = 0;
      function page(path) {
        return request(d.cfg, d.key, { path: path, signal: o.signal, timeout: SMALL_TIMEOUT, phase: 'models' }).then(function (r) {
          out = out.concat(A.models(r)); pages++;
          var nx = A.next(r);
          return nx && pages < 10 ? page(nx) : out;
        });
      }
      return page(A.modelsPath).then(null, function (e) {
        // Ollama without the OpenAI-style list: /api/tags on the same local server
        if (P.custom && e && e.code !== 'key_invalid' && e.code !== 'cancelled' && isLocalHost(new URL(d.cfg.base).hostname)) {
          return request(d.cfg, d.key, { url: new URL(d.cfg.base).origin + '/api/tags', signal: o.signal, timeout: SMALL_TIMEOUT, phase: 'models' }).then(function (r) {
            return (r && r.models || []).map(function (m) { return { id: String(m.name || m.model), name: String(m.name || m.model) }; });
          }, function () { throw e; });
        }
        throw e;
      });
    }).then(function (list) {
      var seen = {};
      return list.filter(function (m) { if (!m.id || seen[m.id]) return false; seen[m.id] = 1; return true; }).map(function (m) { m.chat = !NON_CHAT.test(m.id); return m; });
    });
  }
  /* test(cfg?, key?) -> {ok: true, ms, model, reply} | rejects {code, message}; one tiny call with the default model */
  function test(cfg, key, o) {
    o = o || {};
    var t0 = Date.now();
    return Promise.resolve().then(function () {
      var d = draft(cfg, key);
      if (!d.cfg.models['default']) throw mkErr('model_unavailable', 'Choose a model first.');
      return callWith(d.cfg, d.key, 'Connection test. Reply with the single word OK.', { maxTokens: 256, allowEmpty: true, signal: o.signal, timeout: 60000 }).then(function (r) {
        return { ok: true, ms: Date.now() - t0, model: d.cfg.models['default'], reply: cleanText(r.text, 40), truncated: r.truncated };
      });
    });
  }
  function providers() { return PROVIDERS.map(function (p) { var o = {}, k; for (k in p) if (own(p, k)) o[k] = p[k]; return o; }); }

  var api = {
    providers: providers, config: config, save: save, forget: forget, resetAll: resetAll, load: load, listModels: listModels, test: test,
    active: active, ready: ready, validateBase: validateBase, redact: function (s) { return redact(s); }, normalize: normalize,
    TIERS: TIERS.slice(), NON_CHAT: NON_CHAT,
    _setFetch: function (f) { S.fetch = typeof f === 'function' ? f : null; return api; },
    _callWith: callWith
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpLLM = api;
  load();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
