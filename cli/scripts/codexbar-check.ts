/**
 * Installs CodexBar's latest release the way setup does, into a throwaway HOME, and reads its
 * output with the uploader's parser, without credentials: the provider list, and the error row
 * a provider without an API key returns. Exits 1 with the reason when either breaks.
 * `.github/workflows/codexbar.yml` runs it daily.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/codexbar";
import { Store } from "../src/config";
import { installRelease, listProviders, NoChecksum, releaseVersion } from "../src/setup/codexbar";
import { defaults, type Sys } from "../src/setup/sys";

const home = mkdtempSync(join(tmpdir(), "codexbar-check-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const ctx = {
  env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  store: new Store(join(home, ".config/starbridge")),
  out: (l: string) => console.log(l),
  err: (l: string) => console.error(l),
  now: () => new Date(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
const sys: Sys = {
  ctx,
  home,
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.() ?? 0,
  prompt: defaults,
  self: [],
};

const fail = (why: string) => {
  console.error(why);
  process.exit(1);
};

// The runner shares its IP's anonymous API limit with other jobs, so it asks with its token.
let version: string | undefined;
if (process.env.GITHUB_TOKEN) {
  const res = await fetch("https://api.github.com/repos/steipete/CodexBar/releases/latest", {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
  });
  if (!res.ok) fail(`finding CodexBar's latest release: ${res.status}`);
  version = releaseVersion(((await res.json()) as { tag_name: string }).tag_name);
}
const bin = await installRelease(sys, version).catch((e: Error) => {
  // A release whose tarballs are still uploading; tomorrow's run checks it.
  if (e instanceof NoChecksum) {
    console.log(`Not checked: ${e.message}`);
    process.exit(0);
  }
  return fail(e.message);
});

const providers = (await listProviders(sys, bin)).map((p) => p.provider);
for (const p of ["claude", "codex"])
  if (!providers.includes(p))
    fail(`\`codexbar config providers --format json\` lists no ${p}: ${providers.join(", ")}`);

// OpenRouter needs an API key, so without one CodexBar returns its error row.
// `collect` runs CodexBar with this process's environment: give it the throwaway HOME, no token.
process.env.HOME = home;
delete process.env.GITHUB_TOKEN;
const rows = await collect(bin, ["openrouter"], () => new Date(), console.log);
const row = rows[0];
if (rows.length !== 1 || row?.provider !== "openrouter" || !row.error)
  fail(`\`codexbar usage --provider openrouter\` without a key read as ${JSON.stringify(rows)}`);
if (row?.error?.startsWith("exited ") || row?.error?.startsWith("unreadable output"))
  fail(`\`codexbar usage --provider openrouter\` without a key: ${row.error}`);
console.log(`CodexBar's output reads as before: ${providers.length} providers; ${row?.error}`);
