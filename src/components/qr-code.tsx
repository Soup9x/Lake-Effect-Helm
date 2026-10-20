'use client';

/**
 * A QR code, drawn as SVG squares from qrcode-generator's matrix.
 *
 * The matrix rather than the library's own SVG string, so nothing here is
 * injected as markup: what is rendered is React elements built from booleans.
 * Black on white whatever the theme, because a scanner needs the contrast and
 * a dark-mode QR code is one half the phones in a room will not read.
 */
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { count: n, path: d };
  }, [value]);

  const margin = 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-margin} ${-margin} ${count + margin * 2} ${count + margin * 2}`}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect x={-margin} y={-margin} width={count + margin * 2} height={count + margin * 2} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
