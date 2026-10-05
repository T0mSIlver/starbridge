import { encode } from "uqr";

/**
 * `text` as a QR code for the terminal: black half blocks on a white background, two rows of
 * modules per line, so it scans the same in light and dark terminals.
 */
export function terminalQr(text: string): string[] {
  const { data } = encode(text, { ecc: "L", border: 2 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    const top = data[y] ?? [];
    const bottom = data[y + 1] ?? [];
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = top[x];
      const b = bottom[x] ?? false;
      line += t ? (b ? "█" : "▀") : b ? "▄" : " ";
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines;
}
