// F-BE22-1: raw request bytes are kept for /webhooks/* JSON bodies only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Controller, Post, Req as NestReq } from '@nestjs/common';
import type { Req } from '../../src/platform/http.js';
import { PUBLIC } from '../../src/platform/permissions.js';
import { Route } from '../../src/platform/route.js';
import { R, MIN_RELEASE, start } from './harness.js';
import type { Running } from './harness.js';

const seen: { webhook?: Buffer; other?: Buffer; otherBody?: unknown } = {};
const open = { permission: PUBLIC, resolver: 'none' } as const;

@Controller()
class RawFixture {
  @Post('webhooks/vendor')
  @Route({ ...open, releaseExempt: true })
  hook(@NestReq() req: Req): { ok: true } {
    seen.webhook = req.rawBody;
    return { ok: true };
  }
  @Post('api/v1/raw-check')
  @Route(open)
  other(@NestReq() req: Req): { ok: true } {
    seen.other = req.rawBody;
    seen.otherBody = req.body;
    return { ok: true };
  }
}

describe('raw body retention', () => {
  let s: Running;
  before(async () => {
    s = await start({ controllers: [RawFixture] });
  });
  after(() => s.close());
  const json = { 'content-type': 'application/json' };

  test('/webhooks/* JSON: rawBody is byte-identical to what was sent (whitespace, key order, unicode)', async () => {
    const body = Buffer.from('{ "b":1,  "a" : "café ☃",\n"n":1.0 }', 'utf8');
    const r = await fetch(s.base + '/webhooks/vendor', { method: 'POST', headers: json, body });
    assert.equal(r.status, 201);
    assert.ok(seen.webhook);
    assert.ok(Buffer.compare(seen.webhook, body) === 0);
  });

  test('non-webhook route does not retain raw bytes but still parses the body', async () => {
    const r = await fetch(s.base + '/api/v1/raw-check', {
      method: 'POST',
      headers: { ...json, 'x-client-release': R(MIN_RELEASE) },
      body: '{"a": 1}',
    });
    assert.equal(r.status, 201);
    assert.equal(seen.other, undefined);
    assert.deepEqual(seen.otherBody, { a: 1 });
  });

  test('webhook body limit is unchanged: over 256 KB -> 413', async () => {
    const r = await fetch(s.base + '/webhooks/vendor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ t: 'x'.repeat(256 * 1024 + 10) }),
    });
    assert.equal(r.status, 413);
  });
});
