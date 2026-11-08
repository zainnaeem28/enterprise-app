import { useMemo } from 'react';
import { qrMatrix } from './qr.js';

/** One path of dark modules on a white square with the four-module quiet zone the format asks for. Drawn as SVG, so it scales for a wall screen. */
export function QrCode({
  text,
  label,
  size = 220,
}: {
  text: string;
  label: string;
  size?: number;
}) {
  const { path, n } = useMemo(() => {
    const m = qrMatrix(text);
    const quiet = 4;
    let d = '';
    m.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }),
    );
    return { path: d, n: m.length + quiet * 2 };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ background: '#fff', maxWidth: '100%', height: 'auto' }}
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
