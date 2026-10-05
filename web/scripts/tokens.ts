// Emits the design tokens from the YAML frontmatter of ../../DESIGN.md, the
// single source of truth, for both clients:
//
//   web/src/styles/tokens.css   custom properties, light and dark, with a
//                               --provider-<id> colour per provider
//   web/src/styles/type.css     one .t-<role> class per typography role, with
//                               its compact size under 600 px
//   android/.../ui/theme/Tokens.kt
//
//   bun web/scripts/tokens.ts          rewrite all three
//   bun web/scripts/tokens.ts --check  exit 1 if any is stale (CI)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const DESIGN_MD = resolve(ROOT, "DESIGN.md");
const KOTLIN_PACKAGE = "dev.starbridge.app.ui.theme";
const OUT = {
  css: resolve(ROOT, "web/src/styles/tokens.css"),
  type: resolve(ROOT, "web/src/styles/type.css"),
  kotlin: resolve(ROOT, "android/app/src/main/kotlin/dev/starbridge/app/ui/theme/Tokens.kt"),
};

type Metrics = { size: number; lineHeight: number; letterSpacing: number };
type Role = Metrics & {
  font: "sans" | "mono";
  weight: number;
  tabular?: boolean;
  compact?: Partial<Metrics>;
};
type Design = {
  colors: { light: Record<string, string>; dark: Record<string, string> };
  providers: Record<string, string>;
  fonts: { sans: string; mono: string };
  typography: Record<string, Role>;
  spacing: Record<string, number>;
  radius: Record<string, number>;
  size: Record<string, number>;
  motion: Record<string, number>;
};

function load(): Design {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(DESIGN_MD, "utf8"));
  if (!match) throw new Error("DESIGN.md: no YAML frontmatter");
  const design = Bun.YAML.parse(match[1] ?? "") as Design;
  const { light, dark } = design.colors;
  for (const name of new Set([...Object.keys(light), ...Object.keys(dark)])) {
    for (const [scheme, colors] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const value = colors[name];
      if (value === undefined) throw new Error(`colors.${scheme}.${name} is missing`);
      if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
        throw new Error(`colors.${scheme}.${name}: ${value} is not #rrggbb or #rrggbbaa`);
      }
    }
  }
  for (const [name, role] of Object.entries(design.typography)) {
    if (!(role.font in design.fonts))
      throw new Error(`typography.${name}: unknown font ${role.font}`);
    for (const key of Object.keys(role.compact ?? {})) {
      if (!["size", "lineHeight", "letterSpacing"].includes(key))
        throw new Error(`typography.${name}.compact: ${key} is not a size`);
    }
  }
  for (const [id, value] of Object.entries(design.providers)) {
    if (!/^[a-z0-9]+$/.test(id))
      throw new Error(`providers.${id}: ids are lowercase letters and digits`);
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`providers.${id}: ${value} is not #rrggbb`);
  }
  return design;
}

// Colour maths for the provider dots: sRGB, WCAG contrast, and OKLCH (Björn Ottosson's OKLab).

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const toHex = (rgb: Rgb) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(Math.max(v, 0), 1) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(linear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map(linear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

// Linear sRGB, possibly out of gamut.
function fromOklch(L: number, C: number, H: number): Rgb {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// The colour at lightness L and hue H, with as much of chroma C as sRGB can show.
function inGamut(L: number, C: number, H: number): string {
  const fits = (c: number) => fromOklch(L, c, H).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0;
  let hi = C;
  if (!fits(hi)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  return toHex(fromOklch(L, hi, H).map(gamma) as Rgb);
}

/** A dot needs 3:1 against what it sits on (WCAG 1.4.11, non-text contrast). */
export const DOT_CONTRAST = 3;

/**
 * [hex] moved in OKLCH lightness, away from the grounds, just far enough to reach
 * [DOT_CONTRAST] against each of them; [hex] itself when it already does.
 */
export function fitDot(hex: string, grounds: string[]): string {
  const passes = (c: string) => grounds.every((g) => contrast(c, g) >= DOT_CONTRAST);
  if (passes(hex)) return hex;
  const [L, C, H] = toOklch(hex);
  const lighter = grounds.every((g) => luminance(g) < 0.18);
  for (let step = 1; step <= 200; step++) {
    const l = lighter ? L + step * 0.005 : L - step * 0.005;
    if (l < 0 || l > 1) break;
    const c = inGamut(l, C, H);
    if (passes(c)) return c;
  }
  throw new Error(`no lightness of ${hex} reaches ${DOT_CONTRAST}:1 on ${grounds.join(", ")}`);
}

/** Each provider's dot per scheme, checked against the grounds it sits on. */
function providerDots(d: Design, scheme: "light" | "dark"): [string, string][] {
  const c = d.colors[scheme];
  const grounds = [c.bg, c.surface, c.surface2].map((g) => (g ?? "").slice(0, 7));
  return Object.entries(d.providers).map(([id, hex]) => [id, fitDot(hex.toLowerCase(), grounds)]);
}

const num = (n: number) => String(Number(n.toFixed(4)));

const GENERATED = [
  "GENERATED by web/scripts/tokens.ts from DESIGN.md. Do not edit;",
  "change the frontmatter and run `bun web/scripts/tokens.ts`.",
];
const CSS_HEADER = `/* ${GENERATED[0]}\n   ${GENERATED[1]} */\n`;
const KT_HEADER = `// ${GENERATED[0]}\n// ${GENERATED[1]}\n`;

// Dark is the default. Light applies when the browser asks for it, unless the
// page sets data-theme="dark" on <html>; data-theme="light" forces it (the
// web's Colours setting).
function tokensCss(d: Design): string {
  const colors = (scheme: Record<string, string>, indent: string) =>
    Object.entries(scheme).map(([k, v]) => `${indent}--${k}: ${v};`);
  const dots = (scheme: "light" | "dark", indent: string) =>
    providerDots(d, scheme).map(([id, v]) => `${indent}--provider-${id}: ${v};`);
  const px = (prefix: string, group: Record<string, number>) =>
    Object.entries(group).map(([k, v]) => `  --${prefix}${k}: ${num(v)}px;`);
  return [
    CSS_HEADER,
    ":root {",
    "  color-scheme: dark;",
    ...colors(d.colors.dark, "  "),
    ...dots("dark", "  "),
    "",
    ...px("", d.spacing),
    ...px("radius-", d.radius),
    ...px("size-", d.size),
    ...Object.entries(d.motion).map(([k, v]) => `  --t-${k}: ${v}ms;`),
    "}",
    "",
    "@media (prefers-color-scheme: light) {",
    '  :root:not([data-theme="dark"]) {',
    "    color-scheme: light;",
    ...colors(d.colors.light, "    "),
    ...dots("light", "    "),
    "  }",
    "}",
    "",
    ':root[data-theme="light"] {',
    "  color-scheme: light;",
    ...colors(d.colors.light, "  "),
    ...dots("light", "  "),
    "}",
    "",
  ].join("\n");
}

const metrics = (m: Partial<Metrics>, indent: string) => [
  ...(m.size === undefined ? [] : [`${indent}font-size: ${num(m.size)}px;`]),
  ...(m.lineHeight === undefined ? [] : [`${indent}line-height: ${num(m.lineHeight)}px;`]),
  ...(m.letterSpacing === undefined ? [] : [`${indent}letter-spacing: ${num(m.letterSpacing)}em;`]),
];

// --sans and --mono are bound to next/font's variables in app/layout.tsx.
function typeCss(d: Design): string {
  const lines = [CSS_HEADER];
  const roles = Object.entries(d.typography);
  for (const [name, r] of roles) {
    lines.push(`.t-${name} {`);
    lines.push(`  font-family: var(--${r.font});`);
    lines.push(...metrics(r, "  "));
    lines.push(`  font-weight: ${r.weight};`);
    if (r.tabular) lines.push("  font-variant-numeric: tabular-nums;");
    lines.push("}", "");
  }
  lines.push("@media (max-width: 599px) {");
  for (const [name, r] of roles) {
    if (r.compact) lines.push(`  .t-${name} {`, ...metrics(r.compact, "    "), "  }");
  }
  lines.push("}", "");
  return lines.join("\n");
}

const camel = (key: string) => key.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

// #rrggbb[aa] -> Color(0xAARRGGBB)
function kColor(hex: string): string {
  const h = hex.slice(1).toUpperCase();
  const alpha = h.length === 8 ? h.slice(6) : "FF";
  return `Color(0x${alpha}${h.slice(0, 6)})`;
}

function tokensKt(d: Design): string {
  const names = Object.keys(d.colors.light);
  const scheme = (name: string, colors: Record<string, string>) => [
    `val ${name} = StarbridgeColors(`,
    ...names.map((k) => `    ${camel(k)} = ${kColor(colors[k] ?? "")},`),
    ")",
    "",
  ];
  const dots = (name: string, scheme: "light" | "dark") => [
    `val ${name}: Map<String, Color> = mapOf(`,
    ...providerDots(d, scheme).map(([id, v]) => `    "${id}" to ${kColor(v)},`),
    ")",
    "",
  ];
  const dims = (name: string, group: Record<string, number>, unit: "dp" | "Long") => [
    `object ${name} {`,
    ...Object.entries(group).map(([k, v]) =>
      unit === "dp" ? `    val ${camel(k)} = ${num(v)}.dp` : `    const val ${camel(k)}Ms = ${v}L`,
    ),
    "}",
    "",
  ];
  const style = ([name, r]: [string, Role]) => {
    const fields = [
      `fontFamily = ${r.font},`,
      `fontSize = ${num(r.size)}.sp,`,
      `fontWeight = FontWeight(${r.weight}),`,
      `lineHeight = ${num(r.lineHeight)}.sp,`,
      `letterSpacing = ${num(r.letterSpacing)}.em,`,
      ...(r.tabular ? ['fontFeatureSettings = "tnum",'] : []),
    ];
    return [`    val ${camel(name)} = TextStyle(`, ...fields.map((f) => `        ${f}`), "    )"];
  };
  return [
    KT_HEADER,
    `package ${KOTLIN_PACKAGE}`,
    "",
    "import androidx.compose.runtime.Immutable",
    "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.text.TextStyle",
    "import androidx.compose.ui.text.font.FontFamily",
    "import androidx.compose.ui.text.font.FontWeight",
    "import androidx.compose.ui.unit.dp",
    "import androidx.compose.ui.unit.em",
    "import androidx.compose.ui.unit.sp",
    "",
    "@Immutable",
    "data class StarbridgeColors(",
    ...names.map((k) => `    val ${camel(k)}: Color,`),
    ")",
    "",
    ...scheme("LightColors", d.colors.light),
    ...scheme("DarkColors", d.colors.dark),
    "// Each provider's dot, by CodexBar provider id.",
    ...dots("LightProviders", "light"),
    ...dots("DarkProviders", "dark"),
    ...dims("Spacing", d.spacing, "dp"),
    ...dims("Radius", d.radius, "dp"),
    ...dims("Sizes", d.size, "dp"),
    ...dims("Motion", d.motion, "Long"),
    "// The theme passes the bundled faces.",
    "class StarbridgeType(sans: FontFamily, mono: FontFamily) {",
    ...Object.entries(d.typography).flatMap(style),
    "}",
    "",
  ].join("\n");
}

const design = load();
const outputs: [string, string][] = [
  [OUT.css, tokensCss(design)],
  [OUT.type, typeCss(design)],
  [OUT.kotlin, tokensKt(design)],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [path, want] of outputs) {
    let have = "";
    try {
      have = readFileSync(path, "utf8");
    } catch {
      // missing counts as stale
    }
    if (have !== want) {
      stale = true;
      console.error(`${relative(ROOT, path)} is stale: run \`bun web/scripts/tokens.ts\``);
    }
  }
  process.exit(stale ? 1 : 0);
}

for (const [path, text] of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${relative(ROOT, path)}`);
}
