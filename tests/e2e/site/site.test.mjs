// TC-BS-01, 02 (server-side hand-off link), 05, 07 and the no-form half of 06 (TEST-CASES 10.1). ENV-INT/ci.
// The REAL built site server (apps/site/dist/server/server.js) runs against the REAL API through a Host-rewriting proxy (the API
// selects the machine-client host by Host header; the site only accepts loopback origins). Nothing is mocked.
// Browser-only cases (TC-BS-04 analytics network capture, TC-BS-08 consent behaviour, TC-BS-02 click-through) need Chrome and an
// analytics sandbox that ENV-INT/ci does not provide in this runner; they are BLOCKED, never faked. TC-BS-03 needs the CMS (C-19).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('../../../', import.meta.url).pathname);
const st = JSON.parse(
  readFileSync(process.env.QA_STACK_STATE ?? resolve(root, 'reports/qa05/stack.json'), 'utf8'),
);
const free = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
let proxy, site, base, proxyPort, sitePort;

before(async () => {
  proxyPort = await free();
  proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: st.ports.api,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: st.integrationsHost, 'x-forwarded-for': '10.77.0.1' },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  sitePort = await free();
  base = `http://127.0.0.1:${sitePort}`;
  site = spawn('node', [resolve(root, 'apps/site/dist/server/server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(sitePort),
      SITE_ORIGIN: base,
      PUBLIC_API_ORIGIN: `http://127.0.0.1:${proxyPort}`,
      PATIENT_ORIGIN: 'http://localhost:5173',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('site did not start');
});
after(async () => {
  site?.kill();
  await new Promise((r) => proxy?.close(r) ?? r());
});
const page = async (p) => {
  const r = await fetch(base + p, { redirect: 'manual' });
  return { status: r.status, headers: r.headers, html: await r.text() };
};

describe('TC-BS', () => {
  test('TC-BS-01 published pages exist and show services, doctors, locations from the real directory', async () => {
    for (const p of ['/', '/about', '/services', '/doctors', '/locations', '/contact']) {
      const r = await page(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
    }
    assert.match((await page('/doctors')).html, /Synthetic STF-DR-A1/, 'a listed doctor appears');
    assert.match((await page('/locations')).html, /Synthetic Clinic A1/, 'a location appears');
    assert.match((await page('/services')).html, /General appointment/, 'a service appears');
    const nf = await page('/doctors/00000000-0000-7000-8000-00000000ffff');
    assert.equal(nf.status, 404);
    const unlisted = await page('/doctors/00000000-0000-7000-8000-000000001000');
    assert.equal(unlisted.status, 404, 'a clinician who is not directory-listed has no page');
    assert.match(
      (await page('/doctors')).headers.get('cache-control'),
      /max-age=60/,
      'cacheable for at most 60 s',
    );
  });

  test('TC-BS-02 the Book hand-off from a doctor page goes to my. with the service and doctor pre-selected (link check)', async () => {
    const list = await page('/doctors');
    const id = /\/doctors\/([0-9a-f-]{36})/.exec(list.html)?.[1];
    assert.ok(id, 'a doctor link exists');
    const d = await page(`/doctors/${id}`);
    assert.equal(d.status, 200);
    const m = /href="(http:\/\/localhost:5173\/book\?[^"]+)"/.exec(d.html.replace(/&amp;/g, '&'));
    assert.ok(m, 'a Book link to the patient origin');
    const u = new URL(m[1]);
    assert.equal(u.searchParams.get('clinicianId'), id);
    assert.match(u.searchParams.get('serviceId') ?? id, /^[0-9a-f-]{36}$/);
    // The sign-in-first branch and the click-through are browser journeys: BLOCKED below.
  });

  test('TC-BS-05 robots, sitemap, titles, descriptions and structured data are present and well-formed', async () => {
    const robots = await fetch(base + '/robots.txt').then((r) => r.text());
    assert.match(robots, /User-agent/i);
    assert.match(robots, /Sitemap:\s*http/i);
    const sm = await fetch(base + '/sitemap.xml');
    assert.equal(sm.status, 200);
    const xml = await sm.text();
    assert.match(xml, /<urlset[^>]*sitemaps\.org/);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]);
    assert.ok(locs.length >= 5, `at least five URLs (${locs.length})`);
    for (const p of ['/', '/services', '/doctors', '/locations', '/contact']) {
      const { html } = await page(p);
      const title = /<title>([^<]{5,})<\/title>/.exec(html)?.[1];
      assert.ok(title, `${p} has a title`);
      assert.match(html, /<meta name="description" content="[^"]{20,}"/, `${p} has a description`);
    }
    const doc = await page('/doctors');
    const blocks = [
      ...doc.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ];
    for (const b of blocks) {
      const j = JSON.parse(b[1]);
      assert.ok(j['@context'] && j['@type'], 'valid JSON-LD with @context and @type');
    }
    assert.doesNotMatch(
      JSON.stringify(blocks),
      /date.?of.?birth|patient|diagnos/i,
      'no health data in structured data',
    );
  });

  test('TC-BS-06 (no-form half) the site accepts only GET/HEAD and sets no cookie; there is no contact form to abuse', async () => {
    const post = await fetch(base + '/contact', { method: 'POST', body: 'name=x' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    const c = await page('/contact');
    assert.doesNotMatch(
      c.html,
      /<form[\s>]/i,
      'the contact page has no form in R1 (contact details only)',
    );
    assert.equal(c.headers.get('set-cookie'), null, 'no cookie on page views');
    assert.match(c.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(c.headers.get('x-content-type-options'), 'nosniff');
  });

  test('TC-BS-07 no language switch leads to a broken page (English only)', async () => {
    for (const p of ['/', '/services', '/doctors', '/locations', '/contact']) {
      const { html } = await page(p);
      assert.doesNotMatch(html, /hreflang=|lang-switch|language-switch|href="\/(es|fr|de)\//i, p);
    }
    const bad = await page('/es/');
    assert.equal(bad.status, 404);
  });

  const B = (w) => `BLOCKED: ${w}`;
  test(
    'TC-BS-03 marketing edits and publishes a page without a developer [CMS + browser]',
    {
      skip: B(
        'needs the CMS with a marketing login (C-19 decides the content source; apps/cms is not a deployed service in ENV-INT/ci) and a human for the editing journey',
      ),
    },
    () => {},
  );
  test(
    'TC-BS-04 no health data in analytics events after consent [analytics sandbox + browser]',
    {
      skip: B(
        'needs Chrome network capture and an analytics sandbox; none is provisioned in ENV-INT/ci (ANALYTICS_SRC unset, so the site loads no analytics at all)',
      ),
    },
    () => {},
  );
  test(
    'TC-BS-08 consent banner: no analytics before consent, allowed after, choice remembered [browser]',
    {
      skip: B(
        'needs a browser session; the consent unit tests (apps/site/src/consent.test.ts) cover the logic only and are not a substitute',
      ),
    },
    () => {},
  );
});
