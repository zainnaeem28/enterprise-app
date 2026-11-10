// HTTP client for the QA-05 platform suites (ENV-INT/ci). One cookie jar per client, manual redirect following, and two transports:
//  * the patient API origin is plain http on a loopback port;
//  * the staff and admin origin is https://staff.ci.test, served by the run's TLS front on loopback (the admin realm only accepts
//    that origin). The connection goes to the front's loopback port; the host name is still checked against the pinned run
//    certificate (never unverified TLS).
// Responses are returned verbatim, nothing is retried. Writes carry the session CSRF token, an Idempotency-Key and Origin the way
// the portals do.
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const state = () =>
  JSON.parse(readFileSync(process.env.QA_STACK_STATE ?? 'reports/qa05/stack.json', 'utf8'));
export const RELEASE = 'r1.000000000000';

let ipSeq = Math.floor(Math.random() * 60000);
// The API trusts X-Forwarded-For from loopback and rate-limits unauthenticated calls per source IP: each client gets its own
// synthetic (non-routable) address.
export const nextIp = () => `10.201.${(ipSeq >> 8) & 255}.${ipSeq++ & 255 || 1}`;

/** Low-level request. `url` is absolute; hostnames staff.ci.test go through the TLS front, everything else is plain http. */
export function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const s = state();
  const u = new URL(url);
  const viaFront = u.hostname === s.staffHost;
  const payload =
    body === undefined
      ? undefined
      : typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body);
  const h = { ...headers };
  if (payload !== undefined) {
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type'))
      h['content-type'] = 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  const opts = viaFront
    ? {
        host: '127.0.0.1',
        port: s.ports.tls,
        servername: s.staffHost,
        ca: s.tlsCertPem,
        headers: { host: s.staffHost, ...h },
      }
    : { host: u.hostname, port: u.port || 80, headers: { ...h } };
  const lib = viaFront ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { ...opts, method, path: u.pathname + u.search, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buf,
            setCookies: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60 s')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export class Client {
  /** @param origin e.g. http://127.0.0.1:3000 or https://staff.ci.test */
  constructor(origin, key, { ip, extraHeaders = {} } = {}) {
    this.origin = origin;
    this.key = key;
    this.jar = new Map();
    this.ip = ip ?? nextIp();
    this.extra = extraHeaders;
    this.session = null;
    this.sessionStatus = 0;
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(setCookies) {
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const val = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || val === '';
      if (expired) this.jar.delete(name);
      else this.jar.set(name, val);
    }
  }
  /** One request with the cookie jar; `follow` controls redirect following (GET semantics). */
  async send(method, urlOrPath, { body, headers = {}, follow = 0 } = {}) {
    let url = urlOrPath.startsWith('http') ? urlOrPath : this.origin + urlOrPath;
    let m = method;
    let b = body;
    for (let hops = 0; ; hops++) {
      const h = {
        'x-client-release': RELEASE,
        'x-forwarded-for': this.ip,
        ...this.extra,
        ...headers,
      };
      const ck = this.cookieHeader();
      const sameSite = new URL(url).origin === this.origin;
      if (ck && sameSite) h.cookie = ck;
      const r = await rawRequest(url, { method: m, headers: h, body: b });
      if (sameSite) this.absorb(r.setCookies);
      if (r.status >= 300 && r.status < 400 && r.headers.location && hops < follow) {
        url = new URL(r.headers.location, url).toString();
        m = 'GET';
        b = undefined;
        continue;
      }
      const text = r.buf.toString('utf8');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      return { status: r.status, headers: r.headers, text, json, buf: r.buf, url };
    }
  }
  async call(
    method,
    path,
    { body, headers = {}, idem = true, follow = 0, bearerless = false } = {},
  ) {
    const h = { origin: this.origin, ...headers };
    if (method !== 'GET' && !bearerless) {
      if (this.session?.csrfToken && !h['x-csrf-token']) h['x-csrf-token'] = this.session.csrfToken;
      if (idem && !h['idempotency-key']) h['idempotency-key'] = randomUUID();
    }
    return this.send(method, path, { body, headers: h, follow });
  }
  get(path, o) {
    return this.call('GET', path, o);
  }
  post(path, body, o) {
    return this.call('POST', path, { body, ...o });
  }
  patch(path, body, o) {
    return this.call('PATCH', path, { body, ...o });
  }
  put(path, body, o) {
    return this.call('PUT', path, { body, ...o });
  }
  delete(path, o) {
    return this.call('DELETE', path, o);
  }
  close() {
    return Promise.resolve();
  }
}

// The fixture IdP signs in "whoever is next": sign-ins never overlap (one queue).
let signIn = Promise.resolve();
export function login(kind, key, over = {}, subjectOf, personaEmail) {
  const run = signIn.then(
    () => loginNow(kind, key, over, subjectOf, personaEmail),
    () => loginNow(kind, key, over, subjectOf, personaEmail),
  );
  signIn = run.catch(() => {});
  return run;
}
async function loginNow(kind, key, over, subjectOf, personaEmail) {
  const s = state();
  const origin = kind === 'staff' ? `https://${s.staffHost}` : `http://127.0.0.1:${s.ports.api}`;
  const idpControl = (kind === 'staff' ? s.ports.staffIdp : s.ports.patientIdp) + 1;
  const ctl = await fetch(
    `http://127.0.0.1:${idpControl}/next?sub=${encodeURIComponent(over.sub ?? subjectOf(key))}&email=${encodeURIComponent(over.email ?? personaEmail(key))}`,
  );
  if (!ctl.ok) throw new Error('IdP control failed');
  const c = new Client(origin, key, { ip: over.ip });
  await c.send('GET', '/api/v1/auth/sign-in?returnTo=/', { follow: 10 });
  const sres = await c.send('GET', '/api/v1/auth/session');
  c.sessionStatus = sres.status;
  c.session = sres.status === 200 ? sres.json : null;
  return c;
}

/** A client that is not signed in (anonymous visitor or script). */
export const anonymous = (kind = 'patient', over = {}) => {
  const s = state();
  const origin =
    kind === 'staff'
      ? `https://${s.staffHost}`
      : kind === 'integrations'
        ? `http://127.0.0.1:${s.ports.api}`
        : `http://127.0.0.1:${s.ports.api}`;
  return new Client(origin, 'anonymous', {
    ip: over.ip,
    extraHeaders: kind === 'integrations' ? { host: s.integrationsHost } : {},
  });
};
