import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { anchorHash, EMPTY_ROOT, GENESIS_HASH, leafHash, merkleRoot } from './merkle.js';

const d = (n: number): Buffer => createHash('sha256').update(`row-${n}`).digest();
const sha = (...b: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const x of b) h.update(x);
  return h.digest();
};

describe('merkle root', () => {
  test('empty is the hash of nothing; one leaf is its leaf hash', () => {
    assert.deepEqual(merkleRoot([]), EMPTY_ROOT);
    assert.deepEqual(merkleRoot([d(1)]), leafHash(d(1)));
  });
  test('two and three leaves follow the 0x00 / 0x01 domain separation, an odd node is carried up', () => {
    const [a, b, c] = [leafHash(d(1)), leafHash(d(2)), leafHash(d(3))] as [Buffer, Buffer, Buffer];
    const ab = sha(Buffer.from([1]), a, b);
    assert.deepEqual(merkleRoot([d(1), d(2)]), ab);
    assert.deepEqual(merkleRoot([d(1), d(2), d(3)]), sha(Buffer.from([1]), ab, c));
  });
  test('any change, swap, removal or addition changes the root', () => {
    const base = [d(1), d(2), d(3), d(4), d(5)];
    const root = merkleRoot(base);
    assert.notDeepEqual(merkleRoot([d(1), d(2), d(9), d(4), d(5)]), root);
    assert.notDeepEqual(merkleRoot([d(2), d(1), d(3), d(4), d(5)]), root);
    assert.notDeepEqual(merkleRoot(base.slice(0, 4)), root);
    assert.notDeepEqual(merkleRoot([...base, d(6)]), root);
  });
  test('a leaf cannot be passed off as an inner node', () => {
    const [a, b] = [leafHash(d(1)), leafHash(d(2))] as [Buffer, Buffer];
    const inner = sha(Buffer.from([1]), a, b);
    assert.notDeepEqual(merkleRoot([inner]), merkleRoot([d(1), d(2)]));
  });
});

describe('anchor hash', () => {
  const base = {
    prevHash: GENESIS_HASH,
    fromTs: '2026-11-06T02:00:00.000000Z',
    toTs: '2026-11-06T02:01:00.000000Z',
    rowCount: 3n,
    merkleRoot: merkleRoot([d(1), d(2), d(3)]),
  };
  test('depends on every input', () => {
    const h = anchorHash(base);
    assert.equal(h.length, 32);
    assert.notDeepEqual(anchorHash({ ...base, prevHash: sha(Buffer.from('x')) }), h);
    assert.notDeepEqual(anchorHash({ ...base, fromTs: '2026-11-06T02:00:01.000000Z' }), h);
    assert.notDeepEqual(anchorHash({ ...base, toTs: '2026-11-06T02:02:00.000000Z' }), h);
    assert.notDeepEqual(anchorHash({ ...base, rowCount: 4n }), h);
    assert.notDeepEqual(anchorHash({ ...base, merkleRoot: EMPTY_ROOT }), h);
    assert.deepEqual(anchorHash({ ...base }), h);
  });
});
