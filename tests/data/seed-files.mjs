// SEED-FILES (TEST-CASES 3.2), built in memory on demand. The EICAR antivirus test string is assembled at run time so
// that no file in the repository is flagged by a scanner. Nothing here is real content.
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
  '!$H+H*',
].join('');

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** @param {{oversizeBytes?: number}} [o] Size of the oversized file; the caller sets it from the documented limit. */
export function seedFiles({ oversizeBytes = 26 * 1024 * 1024 } = {}) {
  return {
    cleanPdf: { name: 'clean.pdf', type: 'application/pdf', bytes: PDF },
    cleanImage: { name: 'clean.png', type: 'image/png', bytes: PNG },
    eicar: { name: 'eicar.txt', type: 'text/plain', bytes: Buffer.from(EICAR, 'ascii') },
    oversized: {
      name: 'oversized.pdf',
      type: 'application/pdf',
      bytes: Buffer.concat([PDF, Buffer.alloc(oversizeBytes)]),
    },
    // Declared as a PDF, content is a PNG.
    mismatchedType: { name: 'mismatch.pdf', type: 'application/pdf', bytes: PNG },
    doubleExtension: { name: 'report.pdf.exe', type: 'application/pdf', bytes: PDF },
  };
}
