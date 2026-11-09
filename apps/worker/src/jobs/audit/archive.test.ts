import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAnchorArchive } from './archive-fake.js';
import { anchorArchiveKey, canonicalAnchorBody, sha256, type AnchorRow } from './archive.js';

const row: AnchorRow = {
  id: '17',
  organisationId: '00000000-0000-7000-8000-0000000000a1',
  fromTs: '2026-03-04T05:06:00.000000Z',
  toTs: '2026-03-04T05:07:00.123456Z',
  rowCount: '9007199254740993',
  merkleRoot: Buffer.alloc(32, 1),
  prevHash: Buffer.alloc(32, 2),
  hash: Buffer.alloc(32, 255),
  lateRows: 0,
};

test('the canonical body is stable: sorted keys, no whitespace, bigint as string, hex digests', () => {
  const body = canonicalAnchorBody(row).toString('utf8');
  assert.equal(
    body,
    `{"from_ts":"2026-03-04T05:06:00.000000Z","hash":"${'ff'.repeat(32)}","id":"17","late_rows":0,"merkle_root":"${'01'.repeat(32)}","organisation_id":"00000000-0000-7000-8000-0000000000a1","prev_hash":"${'02'.repeat(32)}","row_count":"9007199254740993","schema":1,"to_ts":"2026-03-04T05:07:00.123456Z"}`,
  );
  assert.deepEqual(canonicalAnchorBody({ ...row }), canonicalAnchorBody(row));
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed['row_count'], '9007199254740993');
  assert.equal(parsed['schema'], 1);
});

test('the key is anchors/<org>/<yyyy>/<mm>/<dd>/<to_ts>_<id>.json, disjoint from partitions/', () => {
  assert.equal(
    anchorArchiveKey(row),
    'anchors/00000000-0000-7000-8000-0000000000a1/2026/03/04/2026-03-04T05:07:00.123456Z_17.json',
  );
});

test('the fake store refuses an overwrite and a wrong checksum, and keeps versions', async () => {
  const store = new MemoryAnchorArchive();
  const body = canonicalAnchorBody(row);
  const first = await store.putAnchor('anchors/k', body, sha256(body));
  assert.equal(first.outcome, 'created');
  assert.deepEqual(await store.putAnchor('anchors/k', Buffer.from('x'), sha256(Buffer.from('x'))), {
    outcome: 'exists',
  });
  await assert.rejects(
    store.putAnchor('anchors/other', body, sha256(Buffer.from('y'))),
    /BadDigest/,
  );
  assert.equal(store.objects.get('anchors/k')?.length, 1);
});
