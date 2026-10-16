// Every client draws the same icon for the same job, in its own platform's set (DESIGN.md,
// "Icons"). `icons-by-job.json` lists them: job → the web name (`PATHS` in icons.tsx), the Android
// `Sym` entry and the iOS SF Symbol. This test reads the three sources and fails on a glyph the
// table does not hold, so a glyph from another platform's design language (an alarm clock on the
// Mac, #1848) shows up in review as a new row. It also fails on a Material import in the web or
// the iPhone app, which the table cannot see.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Platform = "web" | "android" | "ios";
const PLATFORMS: Platform[] = ["web", "android", "ios"];
type Glyphs = string | string[] | null;
const table = JSON.parse(read("design/icons-by-job.json")) as {
  jobs: Record<string, Record<Platform, Glyphs>>;
  extras: Record<Platform, string[]>;
  gaps: { platform: Platform; glyph: string; why: string }[];
};

function files(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) out.push(...files(path, extension));
    else if (name.endsWith(extension)) out.push(path);
  }
  return out;
}

/** Source without its comments, which may talk about other platforms' sets. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

const glyphsOf = (value: Glyphs) => (value === null ? [] : [value].flat());

/** What each client defines or draws, read from its source. */
const SOURCES: Record<Platform, () => string[]> = {
  web() {
    const source = read("web/src/components/icons.tsx");
    const paths = source.slice(source.indexOf("const PATHS = {"), source.indexOf("export type IconName"));
    const names = [...paths.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    // A glyph component beside `Icon` is another way to draw one: it must be listed as an extra.
    const exported = [...source.matchAll(/^export const (\w+) = /gm)].map((m) => m[1]);
    return [...names, ...exported];
  },
  android() {
    const sym = read("android/app/src/main/kotlin/dev/starbridge/app/ui/Symbols.kt");
    const entries = sym.slice(sym.indexOf("enum class Sym"), sym.indexOf("\n}\n", sym.indexOf("enum class Sym")));
    const names = [...entries.matchAll(/(\w+)\('/g)].map((m) => m[1]);
    // Material Icons is a second source beside Sym.
    const icons = files("android/app/src/main", ".kt")
      .flatMap((f) => [...code(read(f)).matchAll(/\bIcons\.(\w+)\.(\w+)/g)])
      .map((m) => `Icons.${m[1]}.${m[2]}`);
    return [...names, ...new Set(icons)];
  },
  ios() {
    // A name in a comparison or a `case` label is a value being tested, not a glyph.
    const symbol = /(?<!==\s*)(?<!case\s+)"([a-z0-9]+(?:\.[a-z0-9]+)*)"/g;
    const found = new Set<string>();
    for (const file of [...files("ios/Starbridge", ".swift"), ...files("ios/Notifications", ".swift")]) {
      const lines = code(read(file)).split("\n");
      let inSymbolFunction = false;
      for (const line of lines) {
        if (/^\s*func \w*Symbol\(/.test(line)) inSymbolFunction = true;
        if (inSymbolFunction || /systemName|systemImage|symbol:/.test(line)) {
          for (const m of line.matchAll(symbol)) found.add(m[1]);
        }
        if (inSymbolFunction && /^}/.test(line)) inSymbolFunction = false;
      }
    }
    return [...found];
  },
};

for (const platform of PLATFORMS) {
  test(`${platform}: every glyph is in the table, and the table names only glyphs that exist`, () => {
    const inSource = SOURCES[platform]();
    const inTable = new Set([
      ...Object.values(table.jobs).flatMap((job) => glyphsOf(job[platform])),
      ...table.extras[platform],
    ]);
    const gaps = table.gaps.filter((g) => g.platform === platform).map((g) => g.glyph);

    const missing = inSource.filter((g) => !inTable.has(g) && !gaps.includes(g));
    expect(
      missing,
      `${platform} draws a glyph that design/icons-by-job.json does not list. Add it to the job it serves, with the glyph the other platforms use for that job; a reviewer then checks it is this platform's own.`,
    ).toEqual([]);

    const gone = [...inTable, ...gaps].filter((g) => !inSource.includes(g));
    expect(
      gone,
      `design/icons-by-job.json lists ${platform} glyphs that no source holds: a typo, or a glyph removed (delete its row).`,
    ).toEqual([]);

    const sanctioned = gaps.filter((g) => inTable.has(g));
    expect(sanctioned, "a glyph is both a job's and a known gap").toEqual([]);
  });
}

test("every job has a glyph or null for each platform, and every known gap says why", () => {
  for (const [job, glyphs] of Object.entries(table.jobs)) {
    expect(Object.keys(glyphs).sort(), job).toEqual([...PLATFORMS].sort());
  }
  for (const gap of table.gaps) expect(gap.why.length, gap.glyph).toBeGreaterThan(20);
});

test("the web draws no Material icons: no package, no import, no font", () => {
  const material = /@mui|@material|material-symbols|material-icons|@fontsource\/material/i;
  const manifest = JSON.parse(read("web/package.json")) as Record<string, Record<string, string>>;
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  expect(packages.filter((p) => material.test(p))).toEqual([]);
  const offenders = [...files("web/src", ".ts"), ...files("web/src", ".tsx"), ...files("web/src", ".css")].filter(
    (f) => {
      const text = code(read(f));
      return material.test(text) || /Material (Symbols|Icons)/.test(text);
    },
  );
  expect(offenders.map((f) => relative("web", f))).toEqual([]);
});

test("the iPhone app draws no Material icons: SF Symbols, Octicons and the GitHub mark only", () => {
  const swift = [...files("ios/Starbridge", ".swift"), ...files("ios/Notifications", ".swift")];
  expect(swift.filter((f) => /material/i.test(code(read(f))))).toEqual([]);
  expect(/material/i.test(read("ios/project.yml"))).toBe(false);

  // Asset images by name: only the GitHub mark and the Octicons exist, and a name built at run
  // time (`UIImage(named: name)`) belongs to the link chips, whose names are Octicons.
  const named = swift.flatMap((f) => [...code(read(f)).matchAll(/\b(?:UIImage\(named:|Image\()\s*("[^"]*"|(?!systemName|uiImage|decorative|label|nsImage)[a-z]\w*(?=\)))/g)].map((m) => [f, m[1]]));
  const odd = named.filter(([f, name]) => {
    if (name.startsWith('"')) return name !== '"GitHub"' && !name.startsWith('"Octicon-');
    return !f.endsWith("LinkChips.swift");
  });
  expect(odd).toEqual([]);
});
