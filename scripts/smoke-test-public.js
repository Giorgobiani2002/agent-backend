// Smoke test against rs-server's PUBLIC Railway URL from a local machine.
// Verifies InternalToolsController is registered and InternalSecretGuard
// enforces the X-Internal-Secret header.
//
// Usage:  node scripts/smoke-test-public.js <SECRET>

const https = require('https');
const fs = require('fs');

const SECRET = (process.argv[2] || fs.readFileSync('/tmp/secret.txt', 'utf8')).trim();
if (!SECRET) {
  console.error('Provide secret as arg or in /tmp/secret.txt');
  process.exit(1);
}

const HOST = 'rs-server-production-130f.up.railway.app';
const PATH = '/api/v1/internal/tools/health';

function run(label, headers) {
  return new Promise((resolve) => {
    const data = '{}';
    const req = https.request(
      {
        hostname: HOST,
        port: 443,
        path: PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          console.log(label, '->', res.statusCode, body.slice(0, 200));
          resolve();
        });
      },
    );
    req.on('error', (e) => {
      console.log(label, 'ERR', e.message);
      resolve();
    });
    req.on('timeout', () => {
      console.log(label, 'TIMEOUT');
      req.destroy();
      resolve();
    });
    req.write(data);
    req.end();
  });
}

(async () => {
  await run('no-secret  ', { 'X-Company-Id': 'smoke' });
  await run('bad-secret ', { 'X-Internal-Secret': 'wrong', 'X-Company-Id': 'smoke' });
  await run('good-secret', { 'X-Internal-Secret': SECRET, 'X-Company-Id': 'smoke' });
  await run('no-company ', { 'X-Internal-Secret': SECRET });
})();
