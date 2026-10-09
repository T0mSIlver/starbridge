// Renders the desktop app's icons from the mark (DESIGN.md, "The mark") with Firefox:
//
//   node desktop/scripts/icons.ts
//
// build/icon.png is the app icon: the launcher's tile on Apple's grid, 824 px of a 1024 canvas.
// assets/tray*.png (and @2x) are the menu bar icons, below. build/background.png (and @2x) is the
// DMG window's ground, below.
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

// The mark cropped closer than the tab icon so it holds at 18 pt. A gap cut around the climber
// keeps it apart from the tether, as colour does in the full mark. In one colour it is a template
// image, which macOS recolours for the menu bar; while something needs the owner, the climber is
// amber, so the icon carries its own colours, one variant per menu bar appearance.
const tray = (
  fill: string,
  climber: string,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="24 22 60 60">
  <mask id="gap"><rect x="0" y="0" width="108" height="108" fill="white"/>
    <rect x="45.5" y="31" width="17" height="26" rx="8.5" fill="black"/></mask>
  <g mask="url(#gap)" fill="${fill}">
    <circle cx="54" cy="148" r="80"/>
    <rect x="51.75" y="18" width="4.5" height="52"/>
  </g>
  <rect x="48.5" y="34" width="11" height="20" rx="5.5" fill="${climber}"/>
</svg>`;

// Template: black; the light and dark variants use DESIGN.md's `fg` and `accent` of each scheme.
const TRAYS = {
  trayTemplate: tray("#000", "#000"),
  trayWaitingLight: tray("#121212", "#965700"),
  trayWaitingDark: tray("#f1f1f1", "#f5a83b"),
};

// The DMG window (#972): stars over a planet's edge, as in the mark, and one arrow from the app to
// Applications, whose icons electron-builder.yml places at (170, 190) and (470, 190). The window
// shows the top 372 px, under its title bar. On a light ground soft dots read as stains, so the
// stars are crisp: pinpoints, and a few four-point sparkles. They keep clear of the icons, their
// labels and the arrow, and come from a fixed generator, so each render draws the same sky.
const SKY = {
  bg: "#f4f4f4",
  planet: "#ebebeb",
  edge: "#d6d6d6",
  star: "#a3a3a3",
  arrow: "#c6c6c6",
};

/** A four-point sparkle of radius r: four points joined by curves pulled to the centre. */
const sparkle = (x: number, y: number, r: number) =>
  `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" d="M0 ${-r}Q0 0 ${r} 0Q0 0 0 ${r}Q0 0 ${-r} 0Q0 0 0 ${-r}Z"/>`;

function sky(): string {
  let seed = 11;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const clear = (x: number, y: number) =>
    x > 12 &&
    x < 628 &&
    y > 14 &&
    y < 300 &&
    [170, 470].every((cx) => Math.abs(x - cx) > 86 || Math.abs(y - 190) > 104) &&
    !(x > 236 && x < 404 && Math.abs(y - 190) < 48);
  const out: string[] = [];
  let sparkles = 0;
  while (out.length < 34) {
    const [x, y, k] = [next() * 640, next() * 400, next()];
    if (!clear(x, y)) continue;
    if (sparkles < 7 && k > 0.75) {
      out.push(sparkle(x, y, 4 + next() * 3.5));
      sparkles++;
    } else
      out.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.7 + k * 0.6).toFixed(2)}"/>`,
      );
  }
  return out.join("");
}

const BACKGROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="${SKY.bg}"/>
  <g fill="${SKY.star}">${sky()}</g>
  <circle cx="320" cy="1290" r="960" fill="${SKY.planet}" stroke="${SKY.edge}" stroke-width="1.5"/>
  <g fill="none" stroke="${SKY.arrow}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
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

writeFileSync(join(DESKTOP, "build/icon.png"), await png(TILE, 1024));
for (const [name, svg] of Object.entries(TRAYS)) {
  writeFileSync(join(DESKTOP, `assets/${name}.png`), await png(svg, 18));
  writeFileSync(join(DESKTOP, `assets/${name}@2x.png`), await png(svg, 36));
}
writeFileSync(join(DESKTOP, "build/background.png"), await png(BACKGROUND, 640, 400));
writeFileSync(join(DESKTOP, "build/background@2x.png"), await png(BACKGROUND, 1280, 800));
await browser.close();
