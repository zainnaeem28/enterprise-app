// File-type sniffing and the container rewrite of images (ARCHITECTURE 25.10, SEC-D-08). The type comes from the file's own first
// bytes, never from the name or the declared header; a file whose bytes do not match what the upload URL fixed is refused.
import { InvalidFile } from './ports.js';
import type { ImageReencoder } from './ports.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffType(b: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  return null;
}

// PNG: keep the chunks a decoder needs (IHDR, PLTE, tRNS, IDAT, IEND); drop every ancillary chunk that can carry text or metadata.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function stripPng(b: Buffer): Buffer {
  if (!b.subarray(0, 8).equals(PNG_SIG)) throw new InvalidFile();
  const out: Buffer[] = [PNG_SIG];
  let p = 8;
  let first = true;
  let ended = false;
  while (p < b.length) {
    if (p + 12 > b.length) throw new InvalidFile();
    const len = b.readUInt32BE(p);
    const type = b.subarray(p + 4, p + 8).toString('latin1');
    const end = p + 12 + len;
    if (end > b.length) throw new InvalidFile();
    if (first && type !== 'IHDR') throw new InvalidFile();
    first = false;
    if (PNG_KEEP.has(type)) out.push(b.subarray(p, end));
    p = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || p !== b.length) throw new InvalidFile(); // missing IEND, or bytes after it
  return Buffer.concat(out);
}

// JPEG: keep the tables and the frame (DQT, DHT, DRI, SOFn, SOS and the entropy-coded data after it); drop APPn and COM.
function stripJpeg(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new InvalidFile();
  const out: Buffer[] = [b.subarray(0, 2)];
  let p = 2;
  for (;;) {
    if (p + 4 > b.length || b[p] !== 0xff) throw new InvalidFile();
    const m = b[p + 1] as number;
    if (m === 0xda) {
      // SOS: the header, then entropy-coded data to the end; it must end with EOI.
      const len = b.readUInt16BE(p + 2);
      if (p + 2 + len > b.length) throw new InvalidFile();
      const rest = b.subarray(p);
      if (rest.length < 2 || rest[rest.length - 2] !== 0xff || rest[rest.length - 1] !== 0xd9)
        throw new InvalidFile();
      out.push(rest);
      return Buffer.concat(out);
    }
    if (m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) throw new InvalidFile(); // EOI before a scan, or a marker without a length
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) throw new InvalidFile();
    const keep = !(m >= 0xe0 && m <= 0xef) && m !== 0xfe;
    if (keep) out.push(b.subarray(p, p + 2 + len));
    p += 2 + len;
  }
}

/**
 * The default {@link ImageReencoder}: a container-level rewrite that removes metadata (location, device, text) from JPEG and PNG
 * and refuses a file whose structure is broken. It does NOT decode and re-encode the pixels; that needs an image library
 * (sharp / libvips), a dependency decision for the Orchestrator (README, open item O-5). A PDF is not rewritten.
 */
export const metadataStrippingReencoder: ImageReencoder = {
  reencode(type, bytes) {
    if (type === 'image/png') return stripPng(bytes);
    if (type === 'image/jpeg') return stripJpeg(bytes);
    return bytes;
  },
};
