// Renders the mark's raster icons (DESIGN.md, "The mark") with Firefox through Playwright:
//
//   node web/scripts/icons.ts      (Node 22.6+ runs this TypeScript as is)
//
// They draw the mark on its own ground, as the Android launcher icon does, since a home screen or
// a browser that ignores icon.svg shows them on any colour. icon.svg is the tab icon and follows
// the scheme instead.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firefox } from "playwright";

const WEB = resolve(import.meta.dirname, "..");

// The launcher's colours: res/values/colors.xml's icon_ground, and dark `fg` and `accent`.
const SHAPES = `
  <rect width="108" height="108" fill="#0c0c0c"/>
  <path fill="#f1f1f1" d="M0,88.97 A80,80 0 0 1 108,88.97 V108 H0 Z"/>
  <path fill="#f1f1f1" d="M51.75,0 H56.25 V72 H51.75 Z"/>
  <path fill="#f5a83b" d="M48.5,39.5 A5.5,5.5 0 0 1 59.5,39.5 V48.5 A5.5,5.5 0 0 1 48.5,48.5 Z"/>`;

/** The central 64 units, rounded like a tile, or the whole canvas for a maskable icon. */
function svg(crop: "tile" | "square" | "canvas"): string {
  if (crop === "canvas")
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${SHAPES}</svg>`;
  const clip = crop === "tile" ? ' clip-path="url(#t)"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="22 22 64 64">
  <clipPath id="t"><rect x="22" y="22" width="64" height="64" rx="14"/></clipPath>
  <g${clip}>${SHAPES}</g></svg>`;
}

const browser = await firefox.launch();
const page = await browser.newPage();

/** Draws the SVG onto a canvas of `size`, which keeps the rounded tile's corners transparent. */
async function png(crop: Parameters<typeof svg>[0], size: number): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg(crop)).toString("base64")}`;
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

/** An ICO whose entries are PNGs, which every browser that reads favicon.ico accepts. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size % 256, e);
    head.writeUInt8(size % 256, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

const sizes = [16, 32, 48];
const tiles = [];
for (const size of sizes) tiles.push({ size, data: await png("tile", size) });
writeFileSync(join(WEB, "src/app/favicon.ico"), ico(tiles));
writeFileSync(join(WEB, "src/app/apple-icon.png"), await png("square", 180));
writeFileSync(join(WEB, "public/icon-192.png"), await png("tile", 192));
writeFileSync(join(WEB, "public/icon-512.png"), await png("tile", 512));
writeFileSync(join(WEB, "public/icon-maskable-512.png"), await png("canvas", 512));
await browser.close();
