// Unit tests (no database): file-type sniffing, the image container rewrite, the scan-tag adapter and the object-key shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TAG_MAPPING,
  OcrAdapter,
  OcrProviderError,
  TagScannerAdapter,
  scannerCaller,
} from './adapters.js';
import { InvalidFile } from './ports.js';
import { metadataStrippingReencoder as re, sniffType } from './sniff.js';
import { InMemoryObjectStore, StubOcrProvider, StubTagClient } from './stubs.js';

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (extra: Buffer[] = []): Buffer =>
  Buffer.concat([
    SIG,
    chunk('IHDR', Buffer.alloc(13)),
    ...extra,
    chunk('IDAT', Buffer.from([1, 2])),
    chunk('IEND', Buffer.alloc(0)),
  ]);

test('sniffType decides from the first bytes only', () => {
  assert.equal(sniffType(Buffer.from('%PDF-1.7 ...')), 'application/pdf');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffType(png()), 'image/png');
  assert.equal(sniffType(Buffer.from('<html>%PDF-</html>')), null);
  assert.equal(sniffType(Buffer.from('MZ\x90\x00')), null);
  assert.equal(sniffType(Buffer.alloc(0)), null);
});

test('PNG rewrite drops text and metadata chunks, keeps the image, refuses a broken file', () => {
  const dirty = png([
    chunk('tEXt', Buffer.from('Author\0Jane')),
    chunk('eXIf', Buffer.from('GPS')),
    chunk('tRNS', Buffer.from([0])),
  ]);
  const clean = re.reencode('image/png', dirty);
  assert.ok(!clean.includes('Jane') && !clean.includes('GPS'));
  assert.ok(clean.includes('IDAT') && clean.includes('tRNS') && clean.includes('IEND'));
  assert.equal(sniffType(clean), 'image/png');
  assert.throws(() => re.reencode('image/png', dirty.subarray(0, dirty.length - 5)), InvalidFile);
  assert.throws(
    () => re.reencode('image/png', Buffer.concat([dirty, Buffer.from('trailing')])),
    InvalidFile,
  );
  assert.throws(
    () =>
      re.reencode(
        'image/png',
        Buffer.concat([SIG, chunk('IDAT', Buffer.alloc(1)), chunk('IEND', Buffer.alloc(0))]),
      ),
    InvalidFile,
  );
});

test('JPEG rewrite drops APPn and COM segments, keeps tables and scan data, refuses a broken file', () => {
  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, 0xff, 0xfe, 0x00, 0x04, 0x68, 0x69,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x11, 0x22, 0xff, 0xd9,
  ]);
  const clean = re.reencode('image/jpeg', jpg);
  assert.ok(!clean.includes('Exif') && !clean.includes('hi'));
  assert.equal(clean.length, jpg.length - 8 - 6);
  assert.deepEqual([...clean.subarray(0, 2)], [0xff, 0xd8]);
  assert.throws(() => re.reencode('image/jpeg', jpg.subarray(0, 12)), InvalidFile);
  assert.throws(() => re.reencode('image/jpeg', jpg.subarray(0, jpg.length - 2)), InvalidFile);
  assert.equal(re.reencode('application/pdf', Buffer.from('%PDF-')).toString(), '%PDF-');
});

test('the scan-tag adapter: unknown or missing is never clean; bad arguments and outage are failures', async () => {
  const client = new StubTagClient();
  const adapter = new TagScannerAdapter(client);
  const base = {
    connection: { id: 'x', kind: 'malware_scan', vendor: 'stub', settings: {} },
    credentials: { get: () => Promise.resolve('') },
    idempotencyToken: 'abcdefgh',
    signal: new AbortController().signal,
  };
  const key = `q/${'0f'.repeat(16)}`;
  const state = async (): Promise<unknown> =>
    (
      (
        await adapter.call({
          ...base,
          operation: 'scan_result',
          args: { bucket: 'quarantine', key },
        })
      ).data as { state: string }
    ).state;
  assert.equal(await state(), 'pending');
  for (const [tag, want] of [
    ...DEFAULT_TAG_MAPPING.clean.map((x) => [x, 'clean']),
    ...DEFAULT_TAG_MAPPING.infected.map((x) => [x, 'infected']),
    ['??', 'error'],
    ['', 'error'],
  ] as const) {
    client.tags.set(`quarantine/${key}`, tag);
    assert.equal(await state(), want, tag);
  }
  await assert.rejects(
    adapter.call({ ...base, operation: 'scan_result', args: { bucket: 'x', key } }),
    /bad_arguments/,
  );
  await assert.rejects(
    adapter.call({
      ...base,
      operation: 'scan_result',
      args: { bucket: 'quarantine', key: 'q/../x' },
    }),
    /bad_arguments/,
  );
  client.outage = true;
  await assert.rejects(
    adapter.call({ ...base, operation: 'scan_result', args: { bucket: 'quarantine', key } }),
    /scanner_unavailable/,
  );
  assert.deepEqual(await adapter.healthCheck(base), { ok: false });
  const caller = scannerCaller(adapter, base.connection, base.credentials, () => 'tokentoken');
  await assert.rejects(caller('quarantine', key));
});

test('the OCR adapter implements classify only, passes no bytes, maps provider errors', async () => {
  const provider = new StubOcrProvider();
  const adapter = new OcrAdapter(provider);
  const base = {
    connection: { id: 'x', kind: 'ocr', vendor: 'stub', settings: {} },
    credentials: { get: () => Promise.resolve('') },
    idempotencyToken: 'abcdefgh',
    signal: new AbortController().signal,
  };
  const key = `c/${'0f'.repeat(16)}`;
  const r = await adapter.call({ ...base, operation: 'classify', args: { bucket: 'clean', key } });
  assert.deepEqual(r.data, { documentType: 'insurance_card' });
  await assert.rejects(
    adapter.call({ ...base, operation: 'lookup', args: { bucket: 'clean', key } }),
    /unsupported_operation/,
  );
  await assert.rejects(
    adapter.call({ ...base, operation: 'classify', args: { bucket: 'clean', key: '/etc/passwd' } }),
    /bad_arguments/,
  );
  provider.plan = () => new OcrProviderError(false, 400, 'rejected');
  await assert.rejects(
    adapter.call({ ...base, operation: 'classify', args: { bucket: 'clean', key } }),
    (e: unknown) => (e as { retryable: boolean }).retryable === false,
  );
  assert.equal(adapter.supportsIdempotencyToken, true);
});

test('the in-memory store refuses to read more than the declared size', async () => {
  const s = new InMemoryObjectStore();
  s.upload('q/aa', Buffer.alloc(10), 'application/pdf');
  await assert.rejects(s.read('quarantine', 'q/aa', 5));
  assert.equal((await s.read('quarantine', 'q/aa', 10)).length, 10);
});
