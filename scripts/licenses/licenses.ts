#!/usr/bin/env bun
// Licence policy and third-party notices (#2024).
//
//   licenses.ts check npm               every runtime npm dependency, from `pnpm licenses list --prod`
//   licenses.ts check android FILE      the modules in FILE (gradle :app:runtimeModules), from their POMs
//   licenses.ts notices npm FILTER      the notices for one workspace package's runtime dependencies
//   licenses.ts notices android FILE    the notices for the Android app
//
// A licence is fine when it is permissive. Anything else (copyleft such as GPL, AGPL, LGPL, MPL and
// CC-BY-SA, an attribution licence such as CC-BY, a vendor's terms, or one this script cannot name)
// fails unless allow.json lists the package with that same licence and a reason. A new version of an
// allowed package that changes licence fails again.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Zlib",
  "Python-2.0",
]);

/** Whether an SPDX expression is permissive: OR needs one permissive side, AND and WITH both. */
export function permissive(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const or = (): boolean => {
    let ok = and();
    while (tokens[at]?.toUpperCase() === "OR") {
      at++;
      const rhs = and();
      ok = ok || rhs;
    }
    return ok;
  };
  const and = (): boolean => {
    let ok = term();
    while (tokens[at]?.toUpperCase() === "AND") {
      at++;
      const rhs = term();
      ok = ok && rhs;
    }
    return ok;
  };
  const term = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const ok = or();
      at++;
      return ok;
    }
    if (token === undefined) return false;
    if (tokens[at]?.toUpperCase() === "WITH") {
      at += 2;
      return false;
    }
    return PERMISSIVE.has(token);
  };
  const ok = or();
  return ok && at >= tokens.length;
}

/** An SPDX id for a Maven POM's licence name and URL, or `unknown: <name>`. */
export function mavenLicense(name: string, url = ""): string {
  const text = `${name} ${url}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/lesser general public|\blgpl/, "LGPL"],
    [/affero|\bagpl/, "AGPL-3.0"],
    [/general public license|\bgpl/, "GPL"],
    [/mozilla|\bmpl/, "MPL"],
    [/eclipse public|\bepl/, "EPL"],
    [/cddl|common development and distribution/, "CDDL"],
    [/creative commons.*share ?alike|cc-by-sa/, "CC-BY-SA"],
    [/apache/, "Apache-2.0"],
    [/\bmit\b|opensource\.org\/licenses\/mit/, "MIT"],
    [/bsd[- ]?3|3-clause|new bsd|modified bsd|revised bsd/, "BSD-3-Clause"],
    [/bsd[- ]?2|2-clause|simplified bsd/, "BSD-2-Clause"],
    [/\bbsd/, "BSD-3-Clause"],
    [/\bisc\b/, "ISC"],
    [/android software development kit/, "Android-SDK-terms"],
    [/ml kit terms of service/, "ML-Kit-terms"],
  ];
  for (const [pattern, id] of rules)
    if (pattern.test(text)) return id === "LGPL" ? lgplVersion(text) : id;
  return `unknown: ${name.trim() || url.trim() || "none declared"}`;
}

function lgplVersion(text: string): string {
  return /\b3(\.0)?\b/.test(text) ? "LGPL-3.0" : /2\.1/.test(text) ? "LGPL-2.1" : "LGPL";
}

export interface Pkg {
  name: string;
  version: string;
  license: string;
  url: string;
  /** For npm, the folder holding the package. */
  path?: string;
}

interface Entry {
  license: string;
  reason: string;
}
export type AllowList = { npm: Record<string, Entry>; android: Record<string, Entry> };

function entryFor(list: Record<string, Entry>, name: string): Entry | undefined {
  const exact = list[name];
  if (exact) return exact;
  for (const [key, entry] of Object.entries(list))
    if (key.endsWith("*") && name.startsWith(key.slice(0, -1))) return entry;
  return undefined;
}

export interface Verdict {
  allowed: { pkg: Pkg; reason: string }[];
  violations: { pkg: Pkg; why: string }[];
  /** Allow-list keys no package matched. */
  unused: string[];
}

export function judge(
  pkgs: Pkg[],
  list: Record<string, Entry>,
  isPermissive: (license: string) => boolean,
): Verdict {
  const verdict: Verdict = { allowed: [], violations: [], unused: [] };
  const used = new Set<string>();
  for (const pkg of pkgs) {
    if (isPermissive(pkg.license)) continue;
    const entry = entryFor(list, pkg.name);
    if (!entry) {
      verdict.violations.push({
        pkg,
        why: `${pkg.license} is not on the permissive list and ${pkg.name} is not on the allow-list`,
      });
      continue;
    }
    used.add(Object.keys(list).find((k) => list[k] === entry) ?? "");
    if (entry.license !== pkg.license) {
      verdict.violations.push({
        pkg,
        why: `${pkg.name} is allowed as ${entry.license}, but is now ${pkg.license}`,
      });
      continue;
    }
    verdict.allowed.push({ pkg, reason: entry.reason });
  }
  verdict.unused = Object.keys(list).filter((key) => !used.has(key));
  return verdict;
}

// npm ------------------------------------------------------------------------------------------

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out;
}

export function parseNpm(json: string): Pkg[] {
  const byLicense = JSON.parse(json) as Record<
    string,
    { name: string; versions: string[]; paths: string[]; homepage?: string; license: string }[]
  >;
  const pkgs: Pkg[] = [];
  for (const [license, list] of Object.entries(byLicense)) {
    for (const p of list) {
      for (const [i, version] of p.versions.entries()) {
        pkgs.push({ name: p.name, version, license, url: p.homepage ?? "", path: p.paths[i] });
      }
    }
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

async function npmPackages(filter?: string): Promise<Pkg[]> {
  const cmd = [
    "pnpm",
    ...(filter ? ["--filter", filter] : []),
    "licenses",
    "list",
    "--prod",
    "--json",
    "--long",
  ];
  return parseNpm(await run(cmd));
}

// Android --------------------------------------------------------------------------------------

function gradleCache(): string {
  return join(
    process.env.GRADLE_USER_HOME ?? join(homedir(), ".gradle"),
    "caches/modules-2/files-2.1",
  );
}

function pomOf(cache: string, group: string, name: string, version: string): string | undefined {
  const dir = join(cache, group, name, version);
  if (!existsSync(dir)) return undefined;
  for (const hash of readdirSync(dir)) {
    const file = join(dir, hash, `${name}-${version}.pom`);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
}

const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** The licences a POM declares, else its parent's; the project's URL. */
export function readPom(
  cache: string,
  group: string,
  name: string,
  version: string,
  depth = 0,
): { licenses: [string, string][]; url: string } {
  const pom = pomOf(cache, group, name, version);
  if (!pom) throw new Error(`no POM for ${group}:${name}:${version} in ${cache}`);
  const noParent = pom.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const licenses = [...noParent.matchAll(/<license>([\s\S]*?)<\/license>/g)].map(
    (m) => [decode(tag(m[1], "name") ?? ""), decode(tag(m[1], "url") ?? "")] as [string, string],
  );
  const url = decode(
    tag(
      noParent.replace(
        /<licenses>[\s\S]*?<\/licenses>|<scm>[\s\S]*?<\/scm>|<developers>[\s\S]*?<\/developers>|<dependencies>[\s\S]*?<\/dependencies>/g,
        "",
      ),
      "url",
    ) ?? "",
  );
  const parent = pom.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (licenses.length === 0 && parent && depth < 5) {
    const up = readPom(
      cache,
      decode(tag(parent, "groupId") ?? ""),
      decode(tag(parent, "artifactId") ?? ""),
      decode(tag(parent, "version") ?? ""),
      depth + 1,
    );
    return { licenses: up.licenses, url: url || up.url };
  }
  return { licenses, url };
}

function androidPackages(modulesFile: string): Pkg[] {
  const cache = gradleCache();
  return readFileSync(modulesFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [group, name, version] = line.split(":");
      const { licenses, url } = readPom(cache, group, name, version);
      const ids = [...new Set(licenses.map(([n, u]) => mavenLicense(n, u)))];
      return {
        name: `${group}:${name}`,
        version,
        license: ids.length ? ids.join(" AND ") : "unknown: none declared",
        url,
      };
    });
}

// Output ----------------------------------------------------------------------------------------

const allowFile = join(dirname(import.meta.path), "allow.json");
const loadAllow = (): AllowList => JSON.parse(readFileSync(allowFile, "utf8"));

function report(
  kind: string,
  pkgs: Pkg[],
  list: Record<string, Entry>,
  isPermissive: (l: string) => boolean,
): number {
  const verdict = judge(pkgs, list, isPermissive);
  console.log(`${kind}: ${pkgs.length} packages, ${verdict.allowed.length} on the allow-list`);
  for (const { pkg, reason } of verdict.allowed)
    console.log(`  allowed  ${pkg.name} ${pkg.version} (${pkg.license}): ${reason}`);
  for (const key of verdict.unused) console.log(`  unused allow-list entry: ${key}`);
  for (const { pkg, why } of verdict.violations)
    console.log(
      `::error::${kind}: ${pkg.name} ${pkg.version}: ${why}. Add it to scripts/licenses/allow.json with a reason if it is acceptable.`,
    );
  return verdict.violations.length;
}

/** Plain text: each licence text once, with the packages it covers. */
export function npmNotices(pkgs: Pkg[], title: string): string {
  const groups = new Map<string, { text: string; pkgs: Pkg[] }>();
  for (const pkg of pkgs) {
    const file = pkg.path
      ? readdirSync(pkg.path).find((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      : undefined;
    const text = file
      ? readFileSync(join(pkg.path as string, file), "utf8").trim()
      : `Licensed under ${pkg.license}; the licence text is at https://spdx.org/licenses/${encodeURIComponent(pkg.license)}.html${pkg.url ? `\nProject: ${pkg.url}` : ""}`;
    const key = createHash("sha256").update(text).digest("hex");
    const group = groups.get(key) ?? { text, pkgs: [] };
    group.pkgs.push(pkg);
    groups.set(key, group);
  }
  const blocks = [...groups.values()]
    .sort((a, b) => a.pkgs[0].name.localeCompare(b.pkgs[0].name))
    .map(
      ({ text, pkgs }) =>
        `${pkgs.map((p) => `${p.name} ${p.version} (${p.license})${p.url ? ` ${p.url}` : ""}`).join("\n")}\n\n${text}`,
    );
  return `${title}\n\n${blocks.join(`\n\n${"-".repeat(72)}\n\n`)}\n`;
}

/** Versions are left out so a Dependabot bump leaves the committed file alone. */
export function androidNotices(pkgs: Pkg[]): string {
  const rows = pkgs
    .map((p) => `${p.name}\n  ${p.license}${p.url ? `\n  ${p.url.replace(/#.*/, "")}` : ""}`)
    .sort();
  return `Third-party software in the Starbridge Android app\n\nEach library is used under the licence named below.\n\n${rows.join("\n\n")}\n`;
}

if (import.meta.main) {
  const [command, target, arg] = process.argv.slice(2);
  const usage =
    "usage: licenses.ts check npm | check android FILE | notices npm FILTER | notices android FILE";
  if (command === "check" && target === "npm") {
    process.exit(report("npm", await npmPackages(), loadAllow().npm, permissive) ? 1 : 0);
  } else if (command === "check" && target === "android" && arg) {
    const isPermissive = (l: string) =>
      !l.includes("unknown") && l.split(" AND ").every((id) => PERMISSIVE.has(id));
    process.exit(
      report("android", androidPackages(arg), loadAllow().android, isPermissive) ? 1 : 0,
    );
  } else if (command === "notices" && target === "npm" && arg) {
    process.stdout.write(
      npmNotices(
        await npmPackages(arg),
        `Third-party software in the Starbridge ${arg.replace("@starbridge/", "")} image`,
      ),
    );
  } else if (command === "notices" && target === "android" && arg) {
    process.stdout.write(androidNotices(androidPackages(arg)));
  } else {
    console.error(usage);
    process.exit(2);
  }
}
