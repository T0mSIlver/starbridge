// Renders the DMG window's ground, build/background.png (and @2x), with Firefox:
//
//   node desktop/scripts/icons.ts
//
// The app and menu bar icons come from the mark: web/scripts/icons.ts draws them.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firefox } from "playwright";

const DESKTOP = resolve(import.meta.dirname, "..");

// The DMG window (#972, owner's pick from mockups): pale dots every 20 px on the light scheme's
// `bg`, fading toward the edges, and one arrow in `line-strong` from the app to Applications,
// whose icons electron-builder.yml places at (170, 190) and (470, 190). The window shows the top
// 372 px, under its title bar.
let dots = "";
for (let x = 10; x < 640; x += 20)
  for (let y = 10; y < 400; y += 20) dots += `<circle cx="${x}" cy="${y}" r="1.1"/>`;

const BACKGROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <defs>
    <radialGradient id="fade" cx="320" cy="186" r="360" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <mask id="edges"><rect width="640" height="400" fill="url(#fade)"/></mask>
  </defs>
  <rect width="640" height="400" fill="#f4f4f4"/>
  <g mask="url(#edges)" fill="#c9c9c9">${dots}</g>
  <g fill="none" stroke="#bdbdbd" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M272 190 H368 M354 176 L368 190 L354 204"/>
  </g>
</svg>`;

const browser = await firefox.launch();
const page = await browser.newPage();

async function png(svg: string, width: number, height = width): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const url = await page.evaluate(
    async ([src, width, height]) => {
      const img = new Image(width, height);
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d")?.drawImage(img, 0, 0, width, height);
      return c.toDataURL("image/png");
    },
    [src, width, height] as const,
  );
  return Buffer.from(url.split(",")[1] ?? "", "base64");
}

writeFileSync(join(DESKTOP, "build/background.png"), await png(BACKGROUND, 640, 400));
writeFileSync(join(DESKTOP, "build/background@2x.png"), await png(BACKGROUND, 1280, 800));
await browser.close();
