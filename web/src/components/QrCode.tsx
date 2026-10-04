import { encode } from "uqr";

/** `text` as a QR code: dark modules on a white square, whatever the page's theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let d = "";
  for (const [y, row] of data.entries())
    for (const [x, dark] of row.entries()) if (dark) d += `M${x} ${y}h1v1h-1z`;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      style={{ width: "min(100%, 240px)", height: "auto", background: "#fff", borderRadius: 8 }}
    >
      <path d={d} fill="#000" />
    </svg>
  );
}
