// CloudWatch Synthetics canary: read-only HTTPS check. It records status and timing only; it never logs
// a URL query, a header value or a response body (PHI-free artifacts, NFR-18). Configuration comes from the
// run environment: TARGET_URL, KIND (shallow|journey), MIN_CERT_DAYS, optional RELEASE_JSON_URL.
const https = require('https');
const log = require('SyntheticsLogger');

const MAX_BODY = 4096;

function request(url, headers, readBody) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = https.get(url, { headers, timeout: 20000 }, (res) => {
      const cert = res.socket.getPeerCertificate();
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (readBody && size <= MAX_BODY) chunks.push(c);
      });
      res.on('end', () => {
        const days = cert && cert.valid_to ? (new Date(cert.valid_to).getTime() - Date.now()) / 86400000 : NaN;
        resolve({ status: res.statusCode, ms: Date.now() - started, certDays: days, body: readBody ? Buffer.concat(chunks).toString('utf8') : '' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function releaseHeader(releaseUrl) {
  if (!releaseUrl) return {};
  const r = await request(releaseUrl, { 'Cache-Control': 'no-cache' }, true);
  if (r.status !== 200) throw new Error(`release.json status ${r.status}`);
  const j = JSON.parse(r.body);
  if (!Number.isInteger(j.release_number) || typeof j.git_sha12 !== 'string') throw new Error('release.json shape');
  return { 'X-Client-Release': `r${j.release_number}.${j.git_sha12}` };
}

const handler = async () => {
  const url = process.env.TARGET_URL;
  const kind = process.env.KIND;
  const minDays = Number(process.env.MIN_CERT_DAYS || '21');
  const headers = await releaseHeader(process.env.RELEASE_JSON_URL);
  const r = await request(url, headers, false);
  log.info(`kind=${kind} status=${r.status} ms=${r.ms} certDays=${Math.floor(r.certDays)}`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!(r.certDays >= minDays)) throw new Error(`certificate expires in ${Math.floor(r.certDays)} days`);
};

exports.handler = async () => {
  return await handler();
};
