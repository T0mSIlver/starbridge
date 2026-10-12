import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "../../deploy/host/deploy-rev.sh"), "utf8");

test("the deploy fetches main only from the host key GitHub publishes", () => {
  const line = /^echo "(github\.com ssh-ed25519 \S+)" > \$known$/m.exec(script)?.[1];
  expect(line).toBeDefined();
  const r = spawnSync("ssh-keygen", ["-lf", "-"], { input: `${line}\n`, encoding: "utf8" });
  // docs.github.com, "GitHub's SSH key fingerprints".
  expect(r.stdout).toContain("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
  expect(script).toContain("-o StrictHostKeyChecking=yes");
  expect(script).not.toContain("accept-new");
});
