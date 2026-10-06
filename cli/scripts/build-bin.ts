/** Builds one standalone `starbridge` binary per platform into dist/ with `bun build --compile`. */
import { $ } from "bun";

const TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "windows-x64",
  "windows-arm64",
];

for (const target of TARGETS) {
  const out = `dist/starbridge-${target}${target.startsWith("windows") ? ".exe" : ""}`;
  await $`bun build src/main.ts --compile --minify --target=bun-${target} --outfile ${out}`;
}
