// Smoke test agent-runtime from agent-backend's perspective:
//   1. GET /health (no auth needed)
//   2. POST /run with a fake bulk_run_id (returns 202 + spawns ghost worker)
// Run via:  railway run --service agent-backend node scripts/smoke-test-runtime.js
const http = require('http');
const { URL: NodeURL } = require('url');

const TARGET = process.env.AGENT_RUNTIME_URL;
const SECRET = process.env.AI_INTERNAL_SECRET;
if (!TARGET || !SECRET) { console.error('Missing env'); process.exit(1); }
const u = new NodeURL(TARGET.replace(/\/$/, ''));

function call(method, path, body, headers = {}) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
        timeout: 15_000,
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => res({ status: r.statusCode, body: b }));
      },
    );
    req.on('error', (e) => res({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: 'TIMEOUT' }); });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('Target:', URL);
  console.log('health:', await call('GET', '/health'));
  console.log('run (no secret):', await call('POST', '/run', { bulk_run_id: 'smoke-test' }));
  console.log('run (good):', await call('POST', '/run', { bulk_run_id: 'smoke-test' }, { 'X-Internal-Secret': SECRET }));
})();
