// Verifies agent-backend → rs-server internal API connectivity from
// inside Railway's network. Run with: railway run --service agent-backend node scripts/smoke-test-internal.js
const http = require('http');

const RS_URL = process.env.RS_SERVER_URL;
const SECRET = process.env.AI_INTERNAL_SECRET;

if (!RS_URL || !SECRET) {
  console.error('Missing RS_SERVER_URL or AI_INTERNAL_SECRET');
  process.exit(1);
}

const target = new URL(RS_URL.replace(/\/$/, '') + '/api/v1/internal/tools/health');
console.log('Target:', target.href);

const data = '{}';
const req = http.request(
  {
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname,
    method: 'POST',
    headers: {
      'X-Internal-Secret': SECRET,
      'X-Company-Id': 'smoke-test',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 10_000,
  },
  (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.log('HTTP', res.statusCode);
      console.log('Body:', body.slice(0, 400));
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on('error', (e) => {
  console.error('ERR', e.message);
  process.exit(2);
});
req.on('timeout', () => {
  console.error('ERR timeout');
  req.destroy();
  process.exit(3);
});
req.write(data);
req.end();
