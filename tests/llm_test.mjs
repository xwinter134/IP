/* Tests of engine/x-llm.js (LnpLLM, "bring your own key") and its hook in engine/ai.js (LnpAI.useProvider).
     node tests/llm_test.mjs
   No network: fetch is a mock that records every request and answers from a script. Checks per adapter the request
   (URL, headers, body, image parts), the parsing of replies and errors, model listing, base-URL validation, key
   redaction (the key never appears in errors, usage logs, state, config or console output) and the routing order of
   LnpAI (mock > sample > own provider > off). */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0, checks = 0;
function ok(c, msg, extra) { checks++; if (!c) { fails++; console.log('FAIL ' + msg + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); } }

// browser storage doubles (x-llm.js only touches localStorage / sessionStorage)
function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
const LS = mem(), SS = mem();
Object.defineProperty(globalThis, 'localStorage', { value: LS, configurable: true, writable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: SS, configurable: true, writable: true });

// console spy: nothing may be logged by the engines
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (k === 'log' && /^FAIL|^llm_test/.test(String(a[0]))) orig.apply(console, a); }; }

const AI = require(path.join(ROOT, 'web/engine/ai.js'));
const L = require(path.join(ROOT, 'web/engine/x-llm.js'));

// fetch mock
let calls = [], script = null;
function reply(status, body) { const t = typeof body === 'string' ? body : JSON.stringify(body); return { ok: status >= 200 && status < 300, status, text: async () => t }; }
L._setFetch(async (url, init) => {
  const c = { url, init, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
  calls.push(c);
  if (init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  return script(c);
});

const KEY = { anthropic: 'sk-ant-TESTKEY-0123456789abcdefXYZ', openai: 'sk-proj-TESTKEY0123456789abcdefXYZ', gemini: 'AIzaTESTKEY0123456789abcdefghijXYZ', mistral: 'mistralTESTKEY0123456789abcdefXYZ', openrouter: 'sk-or-v1-TESTKEY0123456789abcdefXYZ', compatible: 'gwTESTKEY0123456789abcdefXYZ' };
const ALLKEYS = Object.values(KEY);
const leaks = (s) => ALLKEYS.filter((k) => String(s).includes(k) || String(s).includes(k.slice(0, 12)) || String(s).includes(k.slice(-12)));
const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], { type: 'image/png' });
const pngB64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
const M = { d: 'model-d', q: 'model-q', c: 'model-c' };
const errorsSeen = [];
async function rejects(p) { try { await p; return null; } catch (e) { errorsSeen.push(e); return e; } }

// ------------------------------------------------------------------------------------------------ base URL validation
{
  const v = L.validateBase;
  ok(v('https://api.example.com/v1/').ok && v('https://api.example.com/v1/').url === 'https://api.example.com/v1', 'https base accepted, trailing slash removed');
  ok(v('http://localhost:11434/v1').ok && v('http://127.0.0.1:1234/v1').ok && v('http://[::1]:8080/v1').ok, 'http on localhost / 127.0.0.1 / [::1] accepted');
  ok(!v('http://example.com/v1').ok, 'plain http to another host refused');
  ok(!v('http://localhost.evil.com/v1').ok, 'http to a look-alike of localhost refused');
  ok(!v('https://user:pw@api.example.com/v1').ok, 'credentials in the URL refused');
  ok(!v('https://api.example.com/v1?key=abc').ok && !v('https://api.example.com/v1#x').ok, 'query and fragment refused');
  ok(!v('javascript:alert(1)').ok && !v('file:///etc/passwd').ok && !v('ftp://x.org').ok && !v('').ok && !v('not a url').ok, 'other schemes and junk refused');
  let e = null; try { L.normalize({ provider: 'compatible', base: 'http://example.com/v1', models: { default: 'x' } }); } catch (x) { e = x; }
  ok(e && e.code === 'invalid_config' && e.field === 'base', 'normalize rejects a bad custom base URL', e);
  ok(L.normalize({ provider: 'anthropic', base: 'https://evil.example', models: { default: 'm' } }).base === '', 'a base URL is ignored for fixed providers');
  ok(JSON.stringify(L.normalize({ provider: 'openai', models: { default: 'a"b<c', quick: 'ok-1' }, oneModel: false }).models) === '{"quick":"ok-1"}', 'model ids with quotes or markup are dropped');
}

// ------------------------------------------------------------------------------------------------ nothing configured: off
{
  AI.reset(); L.load();
  ok(!L.ready() && (await AI.init()) === false && !AI.available(), 'no settings: LnpAI is not available');
  const e = await rejects(AI.text('hi'));
  ok(e && e.code === 'unavailable', 'no settings: text() rejects unavailable', e);
}

// ------------------------------------------------------------------------------------------------ adapters
function save(provider, extra = {}) {
  return L.save(Object.assign({ provider, models: { default: M.d, quick: M.q, complex: M.c }, oneModel: false, remember: false }, extra), KEY[provider]);
}

// Anthropic
{
  save('anthropic');
  ok(SS.getItem('lnp.llm.key') === KEY.anthropic && LS.getItem('lnp.llm.key') === null, 'key not remembered: stored in sessionStorage only');
  ok(!String(LS.getItem('lnp.llm.cfg')).includes(KEY.anthropic), 'the stored config does not contain the key');
  AI.reset(); await AI.init();
  ok(AI.available() && AI.state().source === 'provider' && AI.state().label === 'Anthropic · model-d', 'Anthropic: LnpAI available through the provider, label names provider and model', AI.state());
  calls = []; script = () => reply(200, { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], stop_reason: 'end_turn' });
  const v = await AI.json('Return JSON {"a":1}', { tier: 'redteam', images: [png], schema: { type: 'object', required: ['a'] } });
  const c = calls[0];
  ok(v && v.a === 1, 'Anthropic: reply text parts joined and parsed', v);
  ok(c.url === 'https://api.anthropic.com/v1/messages', 'Anthropic: URL', c.url);
  ok(c.headers['x-api-key'] === KEY.anthropic && c.headers['anthropic-version'] && c.headers['anthropic-dangerous-direct-browser-access'] === 'true' && !c.headers.authorization, 'Anthropic: headers', Object.keys(c.headers));
  ok(c.init.redirect === 'error' && c.init.credentials === 'omit' && c.init.referrerPolicy === 'no-referrer', 'requests refuse redirects, omit cookies and referrer');
  ok(c.body.model === M.c && c.body.max_tokens === 8192 && c.body.messages.length === 1, 'Anthropic: complex tier picks the complex model; max_tokens set', c.body.model);
  const parts = c.body.messages[0].content;
  ok(Array.isArray(parts) && parts[0].type === 'image' && parts[0].source.type === 'base64' && parts[0].source.media_type === 'image/png' && parts[0].source.data === pngB64 && parts[1].type === 'text', 'Anthropic: image block then text block', parts.map((p) => p.type));
  ok(!('response_format' in c.body), 'Anthropic: no JSON-mode field');
  ok(!c.url.includes(KEY.anthropic), 'key not in the URL');
  calls = []; script = () => reply(200, { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' });
  const r = await AI.text('x', { tier: 'triage' });
  ok(r.truncated === true && r.text === 'partial' && calls[0].body.model === M.q && r.tierApplied === 'quick', 'Anthropic: max_tokens -> truncated; quick tier', r);
  calls = []; script = () => reply(200, { content: [], stop_reason: 'refusal' });
  const e = await rejects(AI.text('x'));
  ok(e && e.code === 'refused', 'Anthropic: refusal -> refused', e);
  // repair: a turn list goes through as messages with roles
  calls = []; let n = 0; script = () => reply(200, { content: [{ type: 'text', text: n++ ? '{"a":2}' : 'not json' }], stop_reason: 'end_turn' });
  const v2 = await AI.json('give json', { schema: { type: 'object', required: ['a'] }, images: [png] });
  ok(v2.a === 2 && calls.length === 2 && calls[1].body.messages.map((m) => m.role).join() === 'user,assistant,user', 'one repair call, sent as a conversation', calls.map((x) => x.body.messages.length));
  ok(Array.isArray(calls[1].body.messages[0].content) && calls[1].body.messages[0].content[0].type === 'image', 'repair call carries the images on the first user turn');
  // models, with paging
  calls = []; script = (c) => /after_id/.test(c.url) ? reply(200, { data: [{ id: 'm3', display_name: 'M 3' }], has_more: false }) : reply(200, { data: [{ id: 'm1', display_name: 'M 1' }, { id: 'm2' }], has_more: true, last_id: 'm2' });
  const list = await L.listModels();
  ok(list.map((m) => m.id).join() === 'm1,m2,m3' && list[0].name === 'M 1' && calls.length === 2 && calls[0].url.startsWith('https://api.anthropic.com/v1/models') && calls[0].headers['x-api-key'] === KEY.anthropic, 'Anthropic: models listed with paging', list);
}

// OpenAI
{
  save('openai', { remember: true });
  ok(LS.getItem('lnp.llm.key') === KEY.openai && SS.getItem('lnp.llm.key') === null, 'remembered key: localStorage only (session copy removed)');
  ok(L.config().keyStore === 'local' && L.config().hasKey && !JSON.stringify(L.config()).includes(KEY.openai), 'config() says where the key is but never contains it');
  AI.reset();
  calls = []; script = () => reply(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
  const v = await AI.json('Return JSON', { tier: 'chart', images: [png] });
  const c = calls[0];
  ok(v.ok === true, 'OpenAI: parsed');
  ok(c.url === 'https://api.openai.com/v1/chat/completions' && c.headers.authorization === 'Bearer ' + KEY.openai, 'OpenAI: URL and bearer header');
  ok(c.body.model === M.d && c.body.max_completion_tokens === 8192 && !('max_tokens' in c.body) && c.body.response_format && c.body.response_format.type === 'json_object', 'OpenAI: model, max_completion_tokens, JSON mode for json()', c.body);
  const p = c.body.messages[0].content;
  ok(p[0].type === 'text' && p[1].type === 'image_url' && p[1].image_url.url === 'data:image/png;base64,' + pngB64, 'OpenAI: text part then image_url data URL', p);
  calls = []; await AI.text('plain');
  ok(!('response_format' in calls[0].body) && calls[0].body.messages[0].content === 'plain', 'OpenAI: text() sends no JSON mode and a plain string content');
  script = () => reply(200, { choices: [{ message: { content: 'abc' }, finish_reason: 'length' }] });
  ok((await AI.text('x')).truncated === true, 'OpenAI: finish_reason length -> truncated');
  script = () => reply(200, { choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] });
  ok((await rejects(AI.text('x'))).code === 'refused', 'OpenAI: refusal -> refused');
  script = () => reply(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  ok((await rejects(AI.text('x'))).code === 'empty_completion', 'empty reply -> empty_completion');
  // errors
  script = () => reply(429, { error: { message: 'Rate limit reached', type: 'requests' } });
  let e = await rejects(AI.text('x'));
  ok(e.code === 'rate_limited' && AI.action(e) === 'wait' && AI.available(), '429 -> rate_limited, AI stays on', e);
  script = () => reply(400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.", code: 'context_length_exceeded' } });
  e = await rejects(AI.text('x'));
  ok(e.code === 'prompt_too_large', 'context too long -> prompt_too_large', e);
  script = () => reply(404, { error: { message: 'The model `nope` does not exist or you do not have access to it.', code: 'model_not_found' } });
  e = await rejects(AI.text('x'));
  ok(e.code === 'model_unavailable' && AI.isFatal(e), 'unknown model -> model_unavailable (stops a chain)', e);
  script = () => reply(500, 'Internal error');
  e = await rejects(AI.text('x'));
  ok(e.code === 'upstream_error' && /HTTP 500/.test(e.message), '5xx -> upstream_error', e);
  script = () => { throw new TypeError('Failed to fetch'); };
  e = await rejects(AI.text('x'));
  ok(e.code === 'unreachable' && AI.isFatal(e) && /CORS/.test(e.message), 'network / CORS failure -> unreachable', e);
  // an error body that echoes the key (as some providers do) is redacted
  script = () => reply(401, { error: { message: 'Incorrect API key provided: ' + KEY.openai + '. You can find your API key at ...' } });
  e = await rejects(AI.text('x'));
  ok(e.code === 'key_invalid' && !leaks(JSON.stringify(e)).length && /redacted/.test(e.message), '401 -> key_invalid; echoed key redacted', e);
  ok(!AI.available() && AI.state().off === 'key_invalid' && AI.action(e) === 'off', 'key_invalid switches the AI off until the settings change');
  ok((await rejects(AI.text('x'))).code === 'key_invalid' && calls.length >= 1, 'no further call after key_invalid');
  // models
  save('openai', { remember: true }); AI.reset();
  ok(AI.available() === true && AI.state().off === null && (await AI.init()) === true, 'saving again switches the AI back on');
  calls = []; script = () => reply(200, { object: 'list', data: [{ id: 'chat-a' }, { id: 'text-embedding-x' }, { id: 'whisper-y' }] });
  const list = await L.listModels();
  ok(calls[0].url === 'https://api.openai.com/v1/models' && calls[0].init.method === 'GET' && !calls[0].body && list.length === 3 && list.filter((m) => m.chat).map((m) => m.id).join() === 'chat-a', 'OpenAI: models listed, non-chat models flagged', list);
}

// Gemini
{
  save('gemini');
  AI.reset();
  calls = []; script = () => reply(200, { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"g":1}' }] }, finishReason: 'STOP' }] });
  const v = await AI.json('Return JSON', { tier: 'expand', images: [png] });
  const c = calls[0];
  ok(v.g === 1, 'Gemini: thought parts skipped, text parsed', v);
  ok(c.url === 'https://generativelanguage.googleapis.com/v1beta/models/' + M.q + ':generateContent' && c.headers['x-goog-api-key'] === KEY.gemini && !c.url.includes('key='), 'Gemini: URL with model, key only in the header', c.url);
  ok(c.body.contents[0].role === 'user' && c.body.contents[0].parts[0].text && c.body.contents[0].parts[1].inline_data.mime_type === 'image/png' && c.body.contents[0].parts[1].inline_data.data === pngB64, 'Gemini: text and inline_data parts', c.body.contents[0].parts.map((p) => Object.keys(p)[0]));
  ok(c.body.generationConfig.maxOutputTokens === 8192 && c.body.generationConfig.responseMimeType === 'application/json', 'Gemini: generationConfig with JSON mime type');
  script = () => reply(200, { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] });
  ok((await AI.text('x')).truncated, 'Gemini: MAX_TOKENS -> truncated');
  script = () => reply(200, { promptFeedback: { blockReason: 'SAFETY' } });
  ok((await rejects(AI.text('x'))).code === 'refused', 'Gemini: blocked prompt -> refused');
  script = () => reply(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
  ok((await rejects(AI.text('x'))).code === 'key_invalid', 'Gemini: invalid key (HTTP 400) -> key_invalid');
  script = () => reply(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
  save('gemini'); AI.reset();
  ok((await rejects(AI.text('x'))).code === 'rate_limited', 'Gemini: RESOURCE_EXHAUSTED -> rate_limited');
  calls = []; script = (c) => /pageToken/.test(c.url) ? reply(200, { models: [{ name: 'models/g2', displayName: 'G 2', supportedGenerationMethods: ['generateContent'] }] })
    : reply(200, { models: [{ name: 'models/g1', displayName: 'G 1', inputTokenLimit: 1000, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/e1', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'P2' });
  const list = await L.listModels();
  ok(list.map((m) => m.id).join() === 'g1,g2' && list[0].ctx === 1000 && calls.length === 2 && calls.every((x) => x.headers['x-goog-api-key'] === KEY.gemini && !/key=/.test(x.url)), 'Gemini: models (generateContent only), paging, key in header', list);
}

// Mistral
{
  save('mistral', { vision: true });
  AI.reset();
  calls = []; script = () => reply(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
  await AI.text('x', { images: [png] });
  const c = calls[0];
  ok(c.url === 'https://api.mistral.ai/v1/chat/completions' && c.headers.authorization === 'Bearer ' + KEY.mistral && c.body.max_tokens === 8192, 'Mistral: URL, bearer, max_tokens', c.body);
  ok(c.body.messages[0].content[1].image_url === 'data:image/png;base64,' + pngB64, 'Mistral: image_url as a plain data-URL string');
  script = () => reply(200, { data: [{ id: 'mi-chat', capabilities: { completion_chat: true, vision: true }, max_context_length: 32000 }, { id: 'mi-embed', capabilities: { completion_chat: false } }] });
  const list = await L.listModels();
  ok(list.length === 1 && list[0].vision === true && list[0].ctx === 32000, 'Mistral: non-chat models dropped, vision and context read', list);
}

// OpenRouter
{
  save('openrouter');
  AI.reset();
  calls = []; script = () => reply(200, { choices: [{ message: { content: '{"r":1}' }, finish_reason: 'stop' }] });
  await AI.json('Return JSON');
  const c = calls[0];
  ok(c.url === 'https://openrouter.ai/api/v1/chat/completions' && c.headers.authorization === 'Bearer ' + KEY.openrouter && !('response_format' in c.body), 'OpenRouter: URL, bearer, no JSON mode by default', c.body);
  ok(!('http-referer' in c.headers) && !('x-title' in c.headers), 'OpenRouter: no app-identifying headers are sent');
  script = () => reply(200, { data: [{ id: 'vendor/m', name: 'Vendor M', context_length: 200000, architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000003', completion: '0.000015' } }] });
  const list = await L.listModels();
  ok(list[0].vision === true && Math.abs(list[0].price.inPerM - 3) < 1e-9 && Math.abs(list[0].price.outPerM - 15) < 1e-9, 'OpenRouter: vision flag and price per million tokens', list[0]);
}

// OpenAI-compatible (gateway, Azure-style header, local server without key, Ollama tags fallback)
{
  L.save({ provider: 'compatible', base: 'https://gw.example.org/openai/v1/', auth: 'api-key', models: { default: 'gw-m' } }, KEY.compatible);
  AI.reset();
  calls = []; script = () => reply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  const r = await AI.text('x', { images: [png] });
  const c = calls[0];
  ok(c.url === 'https://gw.example.org/openai/v1/chat/completions' && c.headers['api-key'] === KEY.compatible && !c.headers.authorization, 'compatible: custom base URL and api-key header', c.url);
  ok(r.imagesDropped === 1 && typeof c.body.messages[0].content === 'string', 'compatible: text only by default, images dropped and counted');
  L.save({ provider: 'compatible', base: 'http://localhost:11434/v1', auth: 'none', models: { default: 'local-m' }, vision: true });
  AI.reset();
  ok(L.ready() && !L.config().hasKey, 'local server without a key is ready');
  calls = []; await AI.text('x');
  ok(calls[0].url === 'http://localhost:11434/v1/chat/completions' && !calls[0].headers.authorization && !calls[0].headers['api-key'], 'local server: no auth header');
  calls = []; script = (c) => /\/v1\/models$/.test(c.url) ? reply(404, 'not found') : reply(200, { models: [{ name: 'llama-local:8b' }, { name: 'nomic-embed-text' }] });
  const list = await L.listModels();
  ok(calls.map((x) => x.url).join() === 'http://localhost:11434/v1/models,http://localhost:11434/api/tags' && list.map((m) => m.id).join() === 'llama-local:8b,nomic-embed-text' && list[1].chat === false, 'Ollama: /api/tags fallback on the same server', list);
}

// test(), timeout and cancel
{
  save('openai');
  calls = []; script = () => reply(200, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  const t = await L.test();
  ok(t.ok && t.reply === 'OK' && calls.length === 1 && calls[0].body.max_completion_tokens === 256, 'test(): one tiny call', t);
  // a draft that is not saved: test with another key and provider, saved settings untouched
  calls = []; script = () => reply(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
  await L.test({ provider: 'anthropic', models: { default: 'draft-m' } }, KEY.anthropic);
  ok(calls[0].url.startsWith('https://api.anthropic.com/') && calls[0].body.model === 'draft-m' && L.config().cfg.provider === 'openai', 'test() with a draft does not change the saved settings');
  ok((await rejects(L.test({ provider: 'anthropic', models: { default: 'draft-m' } }))).code === 'key_invalid', 'a draft for another provider never borrows the saved key');
  script = (c) => new Promise((res, rej) => c.init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  let e = await rejects(L._callWith(L.config().cfg, KEY.openai, 'x', { timeout: 50 }));
  ok(e && e.code === 'timeout', 'timeout -> timeout', e);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 30);
  AI.reset();
  e = await rejects(AI.text('x', { signal: ac.signal }));
  ok(e && e.code === 'cancelled', 'AbortSignal -> cancelled', e);
  // the 256 KiB cap of LnpAI applies before the provider sees anything
  calls = []; script = () => reply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  const big = await AI.text('a'.repeat(400000));
  ok(big.cuts.length === 1 && Buffer.byteLength(calls[0].body.messages[0].content) <= AI.MAX_PROMPT_BYTES, 'the 256 KiB cap is applied before the provider call', big.bytesIn);
}

// routing: mock > sample > provider > off
{
  save('openai');
  let sampleCalls = 0;
  const sample = async () => { sampleCalls++; return { text: 'from sample' }; };
  sample.limits = async () => ({ maxPromptBytes: 262144 });
  globalThis.claude = { use: async (n) => (n === 'sample' ? sample : null) };
  AI.reset(); calls = [];
  await AI.init();
  const r1 = await AI.text('x');
  ok(r1.text === 'from sample' && sampleCalls === 1 && calls.length === 0 && AI.state().source === 'sample' && /Claude/.test(AI.state().label), 'sample capability first: the own provider is not called', AI.state());
  globalThis.claude = { use: async () => null };
  AI.reset(); calls = [];
  await AI.init();
  const r2 = await AI.text('x');
  ok(r2.text === 'ok' && calls.length === 1 && AI.state().source === 'provider', 'sample null: the own provider answers');
  AI.mock(() => 'from mock');
  ok((await AI.text('x')).text === 'from mock' && AI.state().source === 'mock', 'a mock wins over everything');
  AI.mock(null);
  delete globalThis.claude;
  L.forget(); AI.reset();
  ok(!L.ready() && (await AI.init()) === false && !AI.available() && LS.getItem('lnp.llm.key') === null && SS.getItem('lnp.llm.key') === null, 'forget(): key removed from both storages, AI off');
  ok(L.config().cfg && L.config().cfg.provider === 'openai', 'forget() keeps the non-secret settings');
  L.resetAll();
  ok(L.config().cfg === null && LS.getItem('lnp.llm.cfg') === null, 'resetAll() removes the settings too');
  // a saved key belongs to one provider: switching provider without a new key is refused
  save('openai');
  let se = null; try { L.save({ provider: 'anthropic', models: { default: 'x' } }); } catch (x) { se = x; }
  ok(se && se.code === 'invalid_config' && se.field === 'key', 'switching provider requires that provider\'s key', se);
  let ke = null; try { L.save({ provider: 'openai', models: { default: 'x' } }, 'has space in it'); } catch (x) { ke = x; }
  ok(ke && ke.field === 'key' && !String(ke.message).includes('has space'), 'a malformed key is refused without echoing it', ke);
}

// ------------------------------------------------------------------------------------------------ key never leaks
{
  const usage = JSON.stringify(AI.usage()), state = JSON.stringify(AI.state()), cfg = JSON.stringify(L.config());
  ok(!leaks(usage).length && !leaks(state).length && !leaks(cfg).length, 'no key in LnpAI.usage(), LnpAI.state() or LnpLLM.config()');
  ok(errorsSeen.length > 10 && errorsSeen.every((e) => !leaks(JSON.stringify(e)).length && !leaks(String(e.message)).length), 'no key in any thrown error (' + errorsSeen.length + ' errors)');
  ok(!leaks(logged.join('\n')).length && !logged.some((l) => /x-llm|LnpLLM/.test(l)), 'nothing written to the console by the engines', logged.slice(0, 3));
  const rd = L.redact('Bearer tok_QQQQQQQQQQ and sk-zzzzzzzzzz and AIzaSyD-abcdefghijklmnop1234 and ?key=abc123');
  ok(rd === '[redacted] and [redacted] and [redacted] and ?key=[redacted]', 'redact() masks bearer tokens, sk- keys, Google keys and key parameters', rd);
  const src = fs.readFileSync(path.join(ROOT, 'web/engine/x-llm.js'), 'utf8');
  ok(!/LnpStore\s*\.|console\.(log|warn|error|info|debug)|\.innerHTML|sendBeacon|XMLHttpRequest/.test(src), 'x-llm.js never touches LnpStore, the console, innerHTML or other transports');
  ok(/^[\x00-\x7f]*$/.test(src) && /^[\x00-\x7f]*$/.test(fs.readFileSync(path.join(ROOT, 'web/engine/ai.js'), 'utf8')), 'x-llm.js and ai.js are ASCII only');
  const view = fs.readFileSync(path.join(ROOT, 'web/app/views/aikeys.js'), 'utf8');
  ok(!/LnpStore\s*\.|\.innerHTML|insertAdjacentHTML|console\.(log|warn|error|info|debug)/.test(view), 'the settings view never writes to LnpStore and inserts no HTML');
  ok(!/x-llm|LnpLLM|lnp\.llm/.test(fs.readFileSync(path.join(ROOT, 'web/engine/x-context.js'), 'utf8')), 'context packs know nothing of the provider settings');
  // no hard-coded model identifiers: model fields only come from the user or the provider's list
  ok(!/\b(gpt-[0-9]|claude-[0-9a-z]|gemini-[0-9]|mistral-(large|small|medium)|llama-?[0-9])/i.test(src + view), 'no model identifiers in x-llm.js or the view');
}

console.log('llm_test: ' + (checks - fails) + ' of ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
