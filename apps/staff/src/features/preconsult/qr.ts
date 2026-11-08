// A small QR Code encoder for the front desk's daily check-in token (byte mode, error correction L, versions 1 to 5, one block).
// The token is 22 characters, which fits version 2. No library is added because dependency changes are outside this ticket;
// `qr.test.ts` pins the format and the Reed-Solomon maths, and the evidence notes record the decode check against an
// independent decoder.

const EC_CODEWORDS = [7, 10, 15, 20, 26]; // versions 1..5, level L, single block
const DATA_CODEWORDS = [19, 34, 55, 80, 108];

// GF(256), primitive polynomial 0x11D.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

/** Remainder of data(x)·x^degree divided by the generator polynomial: the error correction codewords. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  // Generator polynomial, highest-order coefficient first, leading 1 implied by the loop below.
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] as number) ^ (gen[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ mul(gen[j] as number, EXP[i] as number);
    }
    gen = next;
  }
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rem.shift() as number);
    rem.push(0);
    for (let i = 0; i < degree; i++)
      rem[i] = (rem[i] as number) ^ mul(gen[i + 1] as number, factor);
  }
  return rem;
}

function dataCodewords(bytes: readonly number[], version: number): number[] {
  const capacity = DATA_CODEWORDS[version - 1] as number;
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] as number);
    out.push(v);
  }
  for (let pad = 0xec; out.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
  return out;
}

/** The module matrix (true = dark) for `text`, UTF-8 encoded. Throws when the text does not fit version 5. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  for (let v = 1; v <= 5; v++) {
    if (4 + 8 + bytes.length * 8 <= (DATA_CODEWORDS[v - 1] as number) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new RangeError('QR payload too long');

  const data = dataCodewords(bytes, version);
  const all = [...data, ...reedSolomon(data, EC_CODEWORDS[version - 1] as number)];
  const size = 17 + 4 * version;
  const dark: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const fixed: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, v: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    (dark[y] as boolean[])[x] = v;
    (fixed[y] as boolean[])[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  // Format information (level L = 01, mask 0), both copies, and the dark module.
  const formatData = 0b01 << 3;
  let rem = formatData;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((formatData << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);

  // Codewords, zig-zag from the bottom right; mask 0 on data modules only.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if ((fixed[y] as boolean[])[x] === true || n >= all.length * 8) continue;
        const value =
          ((((all[n >>> 3] as number) >>> (7 - (n & 7))) & 1) !== 0) !== ((x + y) % 2 === 0);
        (dark[y] as boolean[])[x] = value;
        n++;
      }
    }
  }
  return dark;
}
