// Minimal MCP server over stdio: JSON-RPC 2.0, one JSON message per line (no embedded newlines).
// Methods: initialize, notifications/initialized, notifications/cancelled, ping, tools/list, tools/call.
// Nothing here knows about patents; tools are {name, description, inputSchema, annotations?, handler(args, ctx)}.
import readline from 'node:readline';

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

// ---------------------------------------------------------------------------------------------- tiny JSON-schema checker
// Supports what the tool schemas use: type, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, items,
// properties, required, additionalProperties (false), pattern.
export function validate(schema, value, path = '') {
  const errs = [];
  const at = path || 'arguments';
  function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v; }
  function typeOk(t, v) { const k = typeOf(v); return t === k || (t === 'number' && k === 'integer'); }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) { errs.push(`${at} must be ${types.join(' or ')} (got ${typeOf(value)})`); return errs; }
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at} must be <= ${schema.maximum}`);
    if (!Number.isFinite(value)) errs.push(`${at} must be a finite number`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.trim().length < schema.minLength) errs.push(schema.minLength > 1 && value.trim().length ? `${at} must be at least ${schema.minLength} characters` : `${at} must not be empty`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at} is too long (max ${schema.maxLength} characters)`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at} does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${at} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${at} has too many items (max ${schema.maxItems})`);
    if (schema.items) value.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (value[r] === undefined) errs.push(`${at}.${r} is required`.replace('arguments.', ''));
    for (const k of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) { if (value[k] !== undefined) errs.push(...validate(props[k], value[k], path ? `${path}.${k}` : k)); }
      else if (schema.additionalProperties === false) errs.push(`unknown property ${path ? path + '.' : ''}${k} (allowed: ${Object.keys(props).join(', ')})`);
    }
  }
  return errs;
}

export function textResult(obj, isError = false, extraText = []) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  const content = [{ type: 'text', text }];
  for (const t of extraText) content.push({ type: 'text', text: t });
  const r = { content };
  if (isError) r.isError = true;
  return r;
}

/**
 * @param {{name: string, title?: string, version: string, instructions?: string, tools: object[], log?: (s: string) => void,
 *          timeoutMs?: number, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} o
 */
export function serve(o) {
  const input = o.input || process.stdin, output = o.output || process.stdout, log = o.log || (() => {});
  const tools = new Map(o.tools.map((t) => [t.name, t]));
  const inflight = new Map();           // request id -> AbortController
  let pending = 0, closed = false, initialized = false;

  function send(msg) {
    try { output.write(JSON.stringify(msg) + '\n'); } catch (e) { log('write failed: ' + e.message); }
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id: id === undefined ? null : id, error: data === undefined ? { code, message } : { code, message, data } });

  function listTools() {
    return {
      tools: o.tools.map((t) => ({
        name: t.name, title: t.title || t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: Object.assign({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.annotations || {})
      }))
    };
  }

  async function callTool(id, params) {
    const name = params && params.name, tool = tools.get(name);
    if (!tool) return fail(id, ERR.INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 80)}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    const errs = (args && typeof args === 'object' && !Array.isArray(args)) ? validate(tool.inputSchema, args) : ['arguments must be an object'];
    if (errs.length) return reply(id, textResult({ error: 'invalid_arguments', message: errs.join('; '), tool: name, hint: 'See the inputSchema of the tool (tools/list).' }, true));
    const ac = new AbortController();
    inflight.set(id, ac);
    const t0 = Date.now();
    let timer;
    try {
      const timeoutMs = tool.timeoutMs || o.timeoutMs || 120000;
      const run = Promise.resolve().then(() => tool.handler(args, { signal: ac.signal }));
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s and was cancelled`), { code: 'timeout' })); }, timeoutMs); });
      const out = await Promise.race([run, timeout]);
      if (ac.signal.aborted && inflight.get(id) !== ac) return;     // cancelled by the client: no answer
      reply(id, out && out.content ? out : textResult(out));
      log(`${name} ok ${Date.now() - t0} ms`);
    } catch (e) {
      if (inflight.get(id) !== ac) return;                            // cancelled
      const code = (e && e.code) || 'error';
      log(`${name} error ${Date.now() - t0} ms: ${e && e.message}`);
      reply(id, textResult({ error: String(code), message: String((e && e.message) || e).slice(0, 2000), tool: name }, true));
    } finally { clearTimeout(timer); inflight.delete(id); }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return fail(msg && msg.id, ERR.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 message');
    }
    const { id, method, params } = msg;
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return fail(null, ERR.INVALID_REQUEST, 'id must be a string or a number');
    const isReq = id !== undefined && id !== null && method !== undefined;
    if (method === undefined) return;                                  // a response to something we never sent: ignore
    if (typeof method !== 'string') return fail(id, ERR.INVALID_REQUEST, 'method must be a string');
    if (!isReq) {                                                      // notification
      if (method === 'notifications/initialized') initialized = true;
      else if (method === 'notifications/cancelled' && params && params.requestId !== undefined) {
        const ac = inflight.get(params.requestId);
        if (ac) { inflight.delete(params.requestId); ac.abort(); log(`request ${params.requestId} cancelled by the client`); }
      }
      return;
    }
    try {
      switch (method) {
        case 'initialize': {
          const want = params && params.protocolVersion;
          const version = SUPPORTED_VERSIONS.includes(want) ? want : SUPPORTED_VERSIONS[0];
          return reply(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, title: o.title || o.name, version: o.version }, instructions: o.instructions || '' });
        }
        case 'ping': return reply(id, {});
        case 'tools/list': return reply(id, listTools());
        case 'tools/call':
          if (inflight.has(id)) return fail(id, ERR.INVALID_REQUEST, 'A request with this id is already in progress');
          return await callTool(id, params || {});
        case 'logging/setLevel': return reply(id, {});
        default: return fail(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
      }
    } catch (e) { return fail(id, ERR.INTERNAL, 'Internal error: ' + String((e && e.message) || e).slice(0, 500)); }
  }

  const MAX_LINE = o.maxLineBytes || 4 * 1024 * 1024;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.length > MAX_LINE) return fail(null, ERR.INVALID_REQUEST, `Message too large (${line.length} characters, max ${MAX_LINE})`);
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return fail(null, ERR.PARSE, 'Parse error: the line is not valid JSON'); }
    const items = Array.isArray(msg) ? msg : [msg];                    // batches were removed from newer protocol versions but are harmless
    if (Array.isArray(msg) && !msg.length) return fail(null, ERR.INVALID_REQUEST, 'Empty batch');
    for (const m of items) {
      pending++;
      handle(m).catch((e) => log('handler failed: ' + (e && e.message))).finally(() => { pending--; if (closed && !pending) done(); });
    }
  });
  let finish;
  const finished = new Promise((r) => { finish = r; });
  function done() { finish(); }
  rl.on('close', () => { closed = true; if (!pending) done(); });
  return { finished, state: () => ({ initialized, pending }) };
}
