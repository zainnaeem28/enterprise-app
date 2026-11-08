import jsQR from 'jsqr';
import { qrMatrix } from '/paperclip/instances/default/projects/36187ce6-342f-40d7-801c-5215c9d394f7/6b326782-6478-4db3-938d-47b97d5fbc83/enterprise-app/.paperclip/worktrees/HEAAA-119-sdlc-ticket-fe-09-pre-consultation-desk-arrivals-board-check-in-forms-review-triage-panel-red-flag-bar-queues-/apps/staff/src/features/preconsult/qr.ts';
import { randomBytes } from 'node:crypto';
let ok = 0,
  bad = 0;
const texts = [
  'A',
  'hello',
  ...Array.from({ length: 200 }, () => randomBytes(16).toString('base64url')),
  'x'.repeat(32),
  'x'.repeat(50),
  'y'.repeat(100),
];
for (const t of texts) {
  const m = qrMatrix(t);
  const q = 4,
    s = 6,
    n = m.length + 2 * q,
    W = n * s;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < m.length; y++)
    for (let x = 0; x < m.length; x++)
      if (m[y][x])
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) {
            const i = (((y + q) * s + dy) * W + (x + q) * s + dx) * 4;
            px[i] = px[i + 1] = px[i + 2] = 0;
          }
  const r = jsQR(px, W, W);
  if (r && r.data === t) ok++;
  else {
    bad++;
    console.log('FAIL', t, r && r.data);
  }
}
console.log({ ok, bad });
