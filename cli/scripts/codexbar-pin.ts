/**
 * Pins the CodexBar release that setup and `starbridge update` install: writes its version and
 * each CLI tarball's SHA-256 to `cli/src/setup/codexbar-pin.json`, which the signed binary
 * carries. `version.ts` runs it when it stamps a release, so the pin changes in the release PR.
 *
 *   bun cli/scripts/codexbar-pin.ts [version]   (default: CodexBar's latest release)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEYS, latestCodexbar, type Pin, releaseVersion } from "../src/setup/codexbar";

const RELEASES = "https://github.com/steipete/CodexBar/releases";
export const PIN_FILE = join(import.meta.dir, "..", "src", "setup", "codexbar-pin.json");

/** Fetches `version`'s checksums, or the latest release's, and writes the pin. */
export async function pinCodexbar(version?: string, env = process.env): Promise<Pin> {
  const releases = env.STARBRIDGE_CODEXBAR_RELEASES ?? RELEASES;
  const v = version ? releaseVersion(version) : await latestCodexbar(env);
  const sha256: Record<string, string> = {};
  for (const key of KEYS) {
    const name = `CodexBarCLI-v${v}-${key}.tar.gz`;
    const res = await fetch(`${releases}/download/v${v}/${name}.sha256`);
    const sha = res.ok && /^[0-9a-f]{64}\b/i.exec((await res.text()).trim())?.[0].toLowerCase();
    if (!sha) throw new Error(`CodexBar ${v} has no checksum for ${name} (${res.status})`);
    sha256[key] = sha;
  }
  const pin = { version: v, sha256 };
  writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

if (import.meta.main) {
  const pin = await pinCodexbar(process.argv[2]);
  console.log(`Pinned CodexBar ${pin.version}.`);
}
