// Renders the desktop app's icons from the mark (DESIGN.md, "The mark") with Firefox:
//
//   node desktop/scripts/icons.ts
//
// build/icon.png is the app icon: the launcher's tile on Apple's grid, 824 px of a 1024 canvas.
// assets/trayTemplate.png (and @2x) is the menu bar icon: the mark in black on transparent, which
// macOS recolours for a light or dark menu bar.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firefox } from "playwright";

const DESKTOP = resolve(import.meta.dirname, "..");

const TILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <clipPath id="t"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  <g clip-path="url(#t)"><g transform="translate(100 100) scale(12.875) translate(-22 -22)">
    <rect width="108" height="108" fill="#0c0c0c"/>
    <path fill="#f1f1f1" d="M0,88.97 A80,80 0 0 1 108,88.97 V108 H0 Z"/>
    <path fill="#f1f1f1" d="M51.75,0 H56.25 V72 H51.75 Z"/>
    <path fill="#f5a83b" d="M48.5,39.5 A5.5,5.5 0 0 1 59.5,39.5 V48.5 A5.5,5.5 0 0 1 48.5,48.5 Z"/>
  </g></g></svg>`;

// The mark in one colour, cropped closer than the tab icon so it holds at 18 pt. A gap cut
// around the climber keeps it apart from the tether, as colour does in the full mark.
const TRAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="24 22 60 60">
  <mask id="gap"><rect x="0" y="0" width="108" height="108" fill="white"/>
    <rect x="45.5" y="31" width="17" height="26" rx="8.5" fill="black"/></mask>
  <g mask="url(#gap)">
    <circle cx="54" cy="148" r="80"/>
    <rect x="51.75" y="18" width="4.5" height="52"/>
  </g>
  <rect x="48.5" y="34" width="11" height="20" rx="5.5"/>
</svg>`;

const browser = await firefox.launch();
const page = await browser.newPage();

async function png(svg: string, size: number): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const url = await page.evaluate(
    async ([src, size]) => {
      const img = new Image(size, size);
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d")?.drawImage(img, 0, 0, size, size);
      return c.toDataURL("image/png");
    },
    [src, size] as const,
  );
  return Buffer.from(url.split(",")[1] ?? "", "base64");
}

writeFileSync(join(DESKTOP, "build/icon.png"), await png(TILE, 1024));
writeFileSync(join(DESKTOP, "assets/trayTemplate.png"), await png(TRAY, 18));
writeFileSync(join(DESKTOP, "assets/trayTemplate@2x.png"), await png(TRAY, 36));
await browser.close();
