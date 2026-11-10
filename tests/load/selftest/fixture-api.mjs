// Local stand-in that proves the scripts' mechanics (thresholds -> exit code, guard, request shapes). It is NOT the API and
// nothing measured against it describes the system. DELAY_MS adds latency, FAIL_RATE adds 503s.
import http from 'node:http';
const port = Number(process.env.FIXTURE_PORT || 8097); const delay = Number(process.env.DELAY_MS || 0); const failRate = Number(process.env.FAIL_RATE || 0);
const seen = new Set();
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => setTimeout(() => {
    if (!req.headers['x-client-release'] || !req.headers.cookie) { res.statusCode = 401; return res.end('{}'); }
    if (Math.random() < failRate) { res.statusCode = 503; return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    const u = req.url.split('?')[0];
    if (u === '/api/v1/availability/search') return res.end('{"slots":[],"availabilityStale":false}');
    if (u === '/api/v1/holds') { const k = JSON.stringify(JSON.parse(body || '{}').startsAt); if (seen.has(k) && req.headers['x-race']) { res.statusCode = 409; return res.end('{"alternatives":[]}'); } res.statusCode = 201; return res.end('{"reservationId":"00000000-0000-4000-8000-000000000001","expiresAt":"2030-01-01T00:00:00Z"}'); }
    if (u.endsWith('/confirm')) return res.end('{}');
    if (u.endsWith('/notes')) { res.statusCode = 201; return res.end('{}'); }
    res.end('{"items":[]}');
  }, delay));
}).listen(port, '127.0.0.1', () => console.log(`fixture-api on ${port}`));
