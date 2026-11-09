// Real-stack admin run (INT04-F22a). Drives headless Chromium against a RUNNING API (+ PostgreSQL) and a BUILT staff app:
// administrator sign-in with the CI WebAuthn fixture, admin configuration (create a service, check it persisted), the audit
// viewer and the break-the-glass review, asserting real outcomes and saving screenshots. It starts nothing itself.
// Usage:   CI=true EHR_ADMIN_CI_FIXTURE=1 ADMIN_RUN_... node scripts/ci/admin-run.mjs
//          node scripts/ci/admin-run.mjs --selftest          (no stack, no browser: checks the driver's own helpers)
// Needs: `pnpm build` (the fixture loads apps/api/dist), the browser from scripts/ci/install-browser.sh, and a stack started by the
// CI start script with the SAME fixture values (adminFixtureEnv) it passed to the API. See scripts/ci/README.md "Admin run".
//
// Environment (names only; values are never printed):
//   ADMIN_RUN_STAFF_URL            origin of the built staff app, e.g. http://127.0.0.1:4173 (its /api proxy reaches the API). Required.
//   ADMIN_RUN_API_URL              origin of the API for the server-side enrolment calls. Default: ADMIN_RUN_STAFF_URL.
//   ADMIN_RUN_HANDLE               handle of the seeded admin principal. Required.
//   ADMIN_RUN_ENROLMENT_TOKEN      approved single-use enrolment token for that handle (seeded by the start script). Required. Secret.
//   ADMIN_RUN_OUT                  screenshot/summary directory. Default: artifacts/admin-run.
//   ADMIN_RUN_RP_ID                WebAuthn RP id. Default: host name of ADMIN_RUN_STAFF_URL.
//   ADMIN_RUN_CONNECT              <loopback ipv4>:<port> of the CI TLS front (F27). Needs an https ADMIN_RUN_STAFF_URL without a port
//                                  and ADMIN_RUN_TLS_CERT_PEM. Chromium then maps the staff host to it and trusts only that certificate.
//   ADMIN_RUN_TLS_CERT_PEM         PEM of the front's public certificate (required with ADMIN_RUN_CONNECT; never unverified TLS).
//   ADMIN_RUN_CLIENT_RELEASE       X-Client-Release value, r<number>.<12 hex>. Default: r1.000000000000.
// The principal must hold the roles that read/write configuration and review break-the-glass, and the database must hold at least
// one PENDING break-the-glass grant opened by someone else. A missing prerequisite is a failed step, never a silent skip.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';

const SECRET_VARS = ['ADMIN_RUN_ENROLMENT_TOKEN'];
const CLIENT_RELEASE = /^r[1-9][0-9]*\.[0-9a-f]{12}$/;

/** SPKI pin (base64 sha256) of a certificate, the form Chromium's --ignore-certificate-errors-spki-list takes. */
export const spkiPin = (certPem) =>
  createHash('sha256')
    .update(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');

/** Reads and validates the configuration. Problems name the variable, never its value. */
export function readConfig(env) {
  const problems = [];
  const need = (n) => {
    const v = env[n];
    if (v === undefined || v.trim() === '') problems.push(`${n} is required`);
    return v?.trim() ?? '';
  };
  const staff = need('ADMIN_RUN_STAFF_URL');
  const handle = need('ADMIN_RUN_HANDLE');
  const token = need('ADMIN_RUN_ENROLMENT_TOKEN');
  const url = (n, v) => {
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      return u;
    } catch {
      problems.push(`${n} must be an http(s) URL`);
      return undefined;
    }
  };
  const staffUrl = staff === '' ? undefined : url('ADMIN_RUN_STAFF_URL', staff);
  const apiRaw = env.ADMIN_RUN_API_URL?.trim() || staff;
  const apiUrl = apiRaw === '' ? undefined : url('ADMIN_RUN_API_URL', apiRaw);
  const connectRaw = env.ADMIN_RUN_CONNECT?.trim() ?? '';
  const certPem = env.ADMIN_RUN_TLS_CERT_PEM?.trim() ?? '';
  let connect;
  if (connectRaw !== '') {
    const m = /^(127(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(connectRaw);
    const octets = m?.[1].split('.').map(Number) ?? [];
    const port = Number(m?.[2]);
    if (!m || octets.some((o) => o > 255) || port < 1 || port > 65535) {
      problems.push('ADMIN_RUN_CONNECT must be a loopback IPv4 address and port (127.x.x.x:port)');
    } else {
      connect = { host: m[1], port };
      if (staffUrl !== undefined && (staffUrl.protocol !== 'https:' || staffUrl.port !== '')) {
        problems.push('ADMIN_RUN_CONNECT needs an https ADMIN_RUN_STAFF_URL without a port');
      }
      if (certPem === '')
        problems.push('ADMIN_RUN_TLS_CERT_PEM is required with ADMIN_RUN_CONNECT');
      else {
        try {
          spkiPin(certPem);
        } catch {
          problems.push('ADMIN_RUN_TLS_CERT_PEM is not a valid certificate');
        }
      }
    }
  }
  const clientRelease = env.ADMIN_RUN_CLIENT_RELEASE?.trim() || 'r1.000000000000';
  if (!CLIENT_RELEASE.test(clientRelease)) {
    problems.push('ADMIN_RUN_CLIENT_RELEASE must look like r<number>.<12 hex>');
  }
  if (problems.length > 0) throw new Error(`invalid configuration: ${problems.join('; ')}`);
  return {
    connect,
    certPem,
    clientRelease,
    origin: staffUrl.origin,
    apiOrigin: apiUrl.origin,
    rpId: env.ADMIN_RUN_RP_ID?.trim() || staffUrl.hostname,
    staffHost: staffUrl.hostname,
    handle,
    token,
    out: env.ADMIN_RUN_OUT?.trim() || 'artifacts/admin-run',
  };
}

/** Removes every secret value from text that is about to be printed or written. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s !== '' && s !== undefined) out = out.split(s).join('[redacted]');
  return out;
}

export const shotName = (n, label) =>
  `${String(n).padStart(2, '0')}-${label
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()}.png`;

function selftest() {
  const cfg = readConfig({
    ADMIN_RUN_STAFF_URL: 'http://127.0.0.1:4173/',
    ADMIN_RUN_HANDLE: 'ci-admin',
    ADMIN_RUN_ENROLMENT_TOKEN: 'tok-secret-value',
  });
  assert.equal(cfg.origin, 'http://127.0.0.1:4173');
  assert.equal(cfg.apiOrigin, 'http://127.0.0.1:4173');
  assert.equal(cfg.rpId, '127.0.0.1');
  assert.equal(cfg.out, 'artifacts/admin-run');
  assert.throws(
    () => readConfig({ ADMIN_RUN_STAFF_URL: 'ftp://x' }),
    (e) =>
      /ADMIN_RUN_HANDLE is required/.test(e.message) &&
      /ADMIN_RUN_ENROLMENT_TOKEN is required/.test(e.message) &&
      /ADMIN_RUN_STAFF_URL must be an http\(s\) URL/.test(e.message),
  );
  assert.throws(() => readConfig({}), /ADMIN_RUN_STAFF_URL is required/);
  const leaked = redact(`failed with tok-secret-value in body`, [cfg.token]);
  assert.ok(!leaked.includes('tok-secret-value') && leaked.includes('[redacted]'));
  assert.equal(shotName(3, 'Audit log: results'), '03-audit-log-results.png');
  assert.equal(cfg.connect, undefined);
  assert.equal(cfg.clientRelease, 'r1.000000000000');
  // F26/F27 configuration; the valid case uses a throwaway certificate made here (temp dir removed at once)
  const base = {
    ADMIN_RUN_STAFF_URL: 'https://staff.ci.test',
    ADMIN_RUN_HANDLE: 'ci-admin',
    ADMIN_RUN_ENROLMENT_TOKEN: 'tok-secret-value',
  };
  const dir = mkdtempSync(join(tmpdir(), 'admin-run-selftest-'));
  let certPem;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '1',
      ]
        .concat(['-subj', '/CN=staff.ci.test', '-addext', 'subjectAltName=DNS:staff.ci.test'])
        .concat(['-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')]),
      { stdio: 'ignore' },
    );
    certPem = readFileSync(join(dir, 'c.pem'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const tls = readConfig({
    ...base,
    ADMIN_RUN_CONNECT: '127.0.0.1:4443',
    ADMIN_RUN_TLS_CERT_PEM: certPem,
  });
  assert.deepEqual(tls.connect, { host: '127.0.0.1', port: 4443 });
  assert.equal(tls.origin, 'https://staff.ci.test');
  assert.equal(tls.rpId, 'staff.ci.test');
  assert.match(spkiPin(certPem), /^[A-Za-z0-9+/]{43}=$/);
  assert.throws(
    () => readConfig({ ...base, ADMIN_RUN_CONNECT: '127.0.0.1:4443' }),
    /ADMIN_RUN_TLS_CERT_PEM is required/,
  );
  assert.throws(
    () =>
      readConfig({ ...base, ADMIN_RUN_CONNECT: '10.0.0.5:4443', ADMIN_RUN_TLS_CERT_PEM: certPem }),
    /ADMIN_RUN_CONNECT must be a loopback/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ADMIN_RUN_STAFF_URL: 'https://staff.ci.test:8443',
        ADMIN_RUN_CONNECT: '127.0.0.1:4443',
        ADMIN_RUN_TLS_CERT_PEM: certPem,
      }),
    /without a port/,
  );
  assert.throws(
    () => readConfig({ ...base, ADMIN_RUN_CLIENT_RELEASE: 'r1.xyz' }),
    /ADMIN_RUN_CLIENT_RELEASE/,
  );
  assert.equal(
    readConfig({ ...base, ADMIN_RUN_CLIENT_RELEASE: 'r142.3f9a1c2b7d10' }).clientRelease,
    'r142.3f9a1c2b7d10',
  );
  console.log('admin-run self-test: configuration, redaction and screenshot naming ok');
}

/** `fixture`: the fixture the API was started with (admin-stack.mjs). Without it a fresh one is made, which only fits an API started by hand. */
export async function main(fixture) {
  const cfg = readConfig(process.env);
  const secrets = [cfg.token];
  const log = (m) => console.log(redact(m, secrets));
  const { createAdminFixture } = await import('./admin-fixture/index.mjs');
  const fx = fixture ?? createAdminFixture(); // refuses unless CI=true and EHR_ADMIN_CI_FIXTURE=1
  const { chromium } = createRequire(`${process.cwd()}/apps/staff/package.json`)(
    '@playwright/test',
  );
  mkdirSync(cfg.out, { recursive: true });

  const results = [];
  let shots = 0;
  let page;
  const shot = async (label) => {
    const file = `${cfg.out}/${shotName(++shots, label)}`;
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  /** Runs one named step; a failure takes a screenshot, is recorded, and (if `fatal`) stops the run. */
  const step = async (name, fn, { fatal = false } = {}) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ step: name, ok: true, ms: Date.now() - t0 });
      log(`ok   ${name}`);
      return true;
    } catch (e) {
      const message = redact(e instanceof Error ? e.message.split('\n')[0] : String(e), secrets);
      results.push({ step: name, ok: false, ms: Date.now() - t0, error: message });
      log(`FAIL ${name}: ${message}`);
      if (page !== undefined) await shot(`FAILED ${name}`).catch(() => {});
      if (fatal) throw new Error(`fatal step failed: ${name}`, { cause: e });
      return false;
    }
  };

  /** Server-side enrolment of the seeded principal with the fixture key (the staff UI has no enrolment screen). */
  const post = async (path, body, session) => {
    const payload = JSON.stringify(body);
    const headers = {
      'content-type': 'application/json',
      origin: cfg.origin,
      'x-client-release': cfg.clientRelease,
      ...(session === undefined ? {} : { cookie: session.cookie, 'x-csrf-token': session.csrf }),
    };
    const url = `/api/v1/admin${path}`;
    let status;
    let text;
    let setCookies;
    if (cfg.connect === undefined) {
      const r = await fetch(`${cfg.apiOrigin}${url}`, { method: 'POST', headers, body: payload });
      status = r.status;
      text = await r.text();
      setCookies = r.headers.getSetCookie();
    } else {
      // Through the CI TLS front: pinned to this run's certificate, host name still checked (servername), never unverified.
      ({ status, text, setCookies } = await new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            host: cfg.connect.host,
            port: cfg.connect.port,
            servername: cfg.staffHost,
            ca: cfg.certPem,
            method: 'POST',
            path: url,
            headers: {
              ...headers,
              host: cfg.staffHost,
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                text: Buffer.concat(chunks).toString('utf8'),
                setCookies: res.headers['set-cookie'] ?? [],
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(payload);
      }));
    }
    if (status !== 200) throw new Error(`${path} answered ${status}`);
    return { json: JSON.parse(text), setCookies };
  };

  // F27: with the CI TLS front, map exactly the staff host to it and trust only its certificate (SPKI pin). Nothing broader.
  const browserArgs = ['--no-sandbox'];
  if (cfg.connect !== undefined) {
    browserArgs.push(
      `--host-resolver-rules=MAP ${cfg.staffHost}:443 ${cfg.connect.host}:${cfg.connect.port}`,
      `--ignore-certificate-errors-spki-list=${spkiPin(cfg.certPem)}`,
    );
  }
  const browser = await chromium.launch({ args: browserArgs });
  let failed = true;
  try {
    log(`chromium ${browser.version()}`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await fx.installAuthenticator(context, { origin: cfg.origin, rpId: cfg.rpId });
    page = await context.newPage();

    /** Clicks "Use security key" if the elevation dialog is (or soon becomes) open, then waits for it to close. */
    const confirmKey = async (timeout = 3000) => {
      const button = page.getByRole('button', { name: 'Use security key' });
      const asked = await button.waitFor({ state: 'visible', timeout }).then(
        () => true,
        () => false,
      );
      if (!asked) return false;
      await button.click();
      await button.waitFor({ state: 'hidden', timeout: 15000 });
      return true;
    };
    const heading = (name) => page.getByRole('heading', { level: 1, name });
    const open = async (path, title) => {
      await page.goto(cfg.origin + path);
      await confirmKey();
      await heading(title).waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForLoadState('networkidle').catch(() => {});
    };

    await step(
      'enrol the admin principal with the fixture key (token spent, second key registered)',
      async () => {
        const opt = await post('/auth/enrolment/options', { handle: cfg.handle, token: cfg.token });
        const attestation = fx.createKeyAttestation(opt.json.publicKey, {
          origin: cfg.origin,
          rpId: cfg.rpId,
        });
        const ver = await post('/auth/enrolment/verify', {
          challengeId: opt.json.challengeId,
          handle: cfg.handle,
          token: cfg.token,
          attestation,
        });
        const sid = ver.setCookies.map((c) => c.split(';')[0]).find((c) => c.includes('sid='));
        assert.ok(sid, 'enrolment returned no session cookie');
        assert.equal(typeof ver.json.csrfToken, 'string');
        const session = { cookie: sid, csrf: ver.json.csrfToken };
        const o2 = await post('/auth/enrolment/second-key/options', {}, session);
        const a2 = fx.createKeyAttestation(o2.json.publicKey, {
          origin: cfg.origin,
          rpId: cfg.rpId,
        });
        await post(
          '/auth/enrolment/second-key/verify',
          { challengeId: o2.json.challengeId, attestation: a2 },
          session,
        );
      },
      { fatal: true },
    );

    await step(
      'administrator sign-in in the browser with the security key',
      async () => {
        await page.goto(`${cfg.origin}/admin/sign-in`);
        await heading('Administrator sign-in').waitFor({ state: 'visible' });
        await page.getByLabel('Administrator handle').fill(cfg.handle);
        await shot('admin sign-in form');
        await page.getByRole('button', { name: 'Sign in with security key' }).click();
        await page.waitForURL((u) => !u.pathname.endsWith('/admin/sign-in'), { timeout: 20000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        const session = await page.evaluate(async (clientRelease) => {
          const r = await fetch('/api/v1/auth/session', {
            credentials: 'include',
            headers: { 'x-client-release': clientRelease },
          });
          const b = r.ok ? await r.json() : {};
          return { status: r.status, realm: b.realm, audience: b.audience };
        }, cfg.clientRelease);
        assert.equal(session.status, 200, `session answered ${session.status}`);
        assert.equal(session.realm, 'admin_pool', 'session is not in the admin_pool realm');
        assert.equal(session.audience, 'staff', 'session audience is not staff');
        await shot('signed in landing');
      },
      { fatal: true },
    );

    const serviceName = `CI admin run ${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    // The name can appear in more than one cell of the table (e.g. repeated in other columns); an exact match on the
    // first one still proves the saved service is listed, without tripping Playwright strict mode.
    const serviceCell = () => page.getByRole('cell', { name: serviceName, exact: true }).first();
    await step('admin configuration: create a service and see it saved', async () => {
      await open('/admin/services', 'Services catalogue');
      await page.getByRole('button', { name: 'Add: Services' }).click();
      await page.getByLabel('Internal name').fill(serviceName);
      await page.getByLabel('Length (minutes)').fill('30');
      await page.getByLabel('How it is held').selectOption({ label: 'In person' });
      await shot('services form filled');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await confirmKey(8000);
      await page
        .getByText('Saved. The change is recorded in the audit log.')
        .waitFor({ state: 'visible', timeout: 15000 });
      await serviceCell().waitFor({ state: 'visible' });
      await shot('services saved');
    });
    await step(
      'admin configuration: the service is still there after a reload (persisted)',
      async () => {
        await open('/admin/services', 'Services catalogue');
        await serviceCell().waitFor({ state: 'visible', timeout: 15000 });
        await shot('services after reload');
      },
    );

    await step('audit viewer: the last 24 hours show recorded entries', async () => {
      await open('/admin/audit', 'Audit log');
      const status = page.getByRole('status').filter({ hasText: /\d+ (entry|entries)/ });
      let count = 0;
      // Audit rows may be written by the worker a moment after the action; look again for up to 30 seconds.
      for (let i = 0; i < 10 && count === 0; i++) {
        await page.getByRole('button', { name: 'Apply filters' }).click();
        await confirmKey();
        await status.waitFor({ state: 'visible', timeout: 15000 });
        count = Number(/(\d+)/.exec(await status.innerText())?.[1] ?? 0);
        if (count === 0) await page.waitForTimeout(3000);
      }
      assert.ok(count > 0, 'the audit viewer returned no entries for the last 24 hours');
      assert.ok((await page.getByRole('table').count()) > 0, 'no audit table is shown');
      await shot('audit viewer results');
    });

    await step('break-the-glass review: record a decision on a pending access', async () => {
      await open('/admin/btg', 'Break-the-glass review');
      const review = page.getByRole('button', { name: /^Review: access opened/ }).first();
      const found = await review.waitFor({ state: 'visible', timeout: 10000 }).then(
        () => true,
        () => false,
      );
      assert.ok(
        found,
        'no pending break-the-glass access to review (the start script must seed one opened by another principal)',
      );
      await shot('break-the-glass pending list');
      await review.click();
      await page.getByRole('radio', { name: 'Justified', exact: true }).check();
      await page
        .locator('#btg-note')
        .fill('CI admin run: emergency access reviewed and justified.');
      await shot('break-the-glass decision form');
      await page.getByRole('button', { name: 'Record decision' }).click();
      await confirmKey(8000);
      await page
        .getByText('Decision recorded: Justified.')
        .waitFor({ state: 'visible', timeout: 15000 });
      await shot('break-the-glass decision recorded');
    });
    await step(
      'break-the-glass review: the decision is stored (shown under Justified after reload)',
      async () => {
        await open('/admin/btg', 'Break-the-glass review');
        await page.getByLabel('Show').selectOption({ label: 'Justified' });
        await page.getByRole('table').waitFor({ state: 'visible', timeout: 15000 });
        assert.ok((await page.getByRole('row').count()) > 1, 'no justified access is listed');
        await shot('break-the-glass justified list');
      },
    );

    failed = results.some((r) => !r.ok);
  } catch (e) {
    log(`run stopped: ${redact(e instanceof Error ? e.message : String(e), secrets)}`);
    failed = true;
  } finally {
    await browser.close();
    writeFileSync(
      `${cfg.out}/summary.json`,
      JSON.stringify(
        { origin: cfg.origin, handle: cfg.handle, ok: !failed, steps: results },
        null,
        2,
      ),
    );
  }
  log(
    failed
      ? 'admin run FAILED'
      : `admin run passed (${results.length} steps), screenshots in ${cfg.out}`,
  );
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    main()
      .then((code) => process.exit(code))
      .catch((e) => {
        const secrets = SECRET_VARS.map((n) => process.env[n] ?? '');
        console.error(redact(e instanceof Error ? e.message : String(e), secrets));
        process.exit(1);
      });
  }
}
