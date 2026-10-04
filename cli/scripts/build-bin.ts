/** Builds one standalone `starbridge` binary per platform into dist/ with `bun build --compile`. */
import { $ } from "bun";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];

for (const target of TARGETS) {
  await $`bun build src/main.ts --compile --minify --target=bun-${target} --outfile dist/starbridge-${target}`;
}
