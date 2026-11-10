/* Static server that mimics the Artifact host as strictly as it can be done locally. Used by tests/e2e.cjs and
   usable on its own:   node tests/artifact_server.cjs [--dist dist] [--port 8787] [--mode host|blob|strict]
   - index.html is a body fragment (no doctype / html / head): it is wrapped in a document skeleton like the host does.
   - Every response carries the Content-Security-Policy of the host (no inline script, no eval, no wasm, connect 'self').
   - mode "host":   worker-src 'self' blob:
     mode "blob":   requests with Sec-Fetch-Dest: worker get 404 (file workers fail, blob: workers must take over)
     mode "strict": worker-src 'none' and every *.bin answers 404 (main-thread engines + base64 files; needs a dist
                    built with --enc b64)
   - faults: {"<path>": "404" | "corrupt" | "truncate" | "slow"} can be set per server (opts.faults, mutable). */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');

const CSP_BASE = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; ";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

function skeleton(fragment) {
  return '<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n' + fragment + '\n</body>\n</html>\n';
}

function serve(opts) {
  opts = opts || {};
  const root = path.resolve(opts.dist || 'dist'), mode = opts.mode || 'host', faults = opts.faults || {}, log = opts.log || [];
  const csp = CSP_BASE + (mode === 'strict' ? "worker-src 'none'" : "worker-src 'self' blob:");
  const srv = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (e) { rel = '/'; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(root, rel), key = rel.replace(/^\//, '');
    const head = { 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const send = (code, type, body) => { log.push({ path: key, status: code, bytes: body ? body.length : 0, dest: req.headers['sec-fetch-dest'] || '' }); res.writeHead(code, Object.assign({ 'Content-Type': type }, head)); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method');
    if (file !== root && !file.startsWith(root + path.sep)) return send(403, 'text/plain', 'forbidden');
    const fault = faults[key];
    if (fault === '404') return send(404, 'text/plain', 'not found');
    if (mode === 'strict' && /\.bin$/.test(key)) return send(404, 'text/plain', 'not found');
    if (mode === 'blob' && req.headers['sec-fetch-dest'] === 'worker') return send(404, 'text/plain', 'not found');
    fs.readFile(file, (err, buf) => {
      if (err) return send(404, 'text/plain', 'not found');
      if (key === 'index.html') buf = Buffer.from(skeleton(buf.toString('utf8')));
      if (fault === 'corrupt') { buf = Buffer.from(buf); for (let i = Math.min(64, buf.length >> 1); i < buf.length; i += 7) buf[i] ^= 0x5a; }
      if (fault === 'truncate') buf = buf.subarray(0, Math.max(1, buf.length >> 1));
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      if (fault === 'slow') setTimeout(() => send(200, type, buf), 1500); else send(200, type, buf);
    });
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(opts.port || 0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, origin: 'http://127.0.0.1:' + srv.address().port, faults, log, csp, close: () => new Promise((r) => srv.close(r)) }));
  });
}

module.exports = { serve, skeleton, CSP_BASE };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  serve({ dist: arg('dist', path.join(__dirname, '..', 'dist')), port: +arg('port', 8787), mode: arg('mode', 'host') }).then((s) => {
    console.log('serving ' + arg('dist', 'dist') + ' at ' + s.origin + '  (mode ' + arg('mode', 'host') + ')');
  });
}
