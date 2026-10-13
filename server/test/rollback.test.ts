import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy/rollback.sh in a repository of its own whose main has four commits, against a fake ssh
// that answers as the box would: the running commit, then the image tags it holds.
let dir: string;
const commits: string[] = [];

function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function box(running: string, server: string[], web: string[]) {
  const lines = [running, ...server.map((t) => `server ${t}`), ...web.map((t) => `web ${t}`)];
  writeFileSync(join(dir, "box"), `${lines.join("\n")}\n`);
}

function rollback(args: string[], input = "") {
  return spawnSync("sh", ["deploy/rollback.sh", ...args], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir },
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rollback-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  for (const n of [1, 2, 3, 4]) {
    git("commit", "-q", "--allow-empty", "-m", `release ${n}`);
    commits.push(git("rev-parse", "HEAD"));
  }
  git("remote", "add", "origin", dir);
  mkdirSync(join(dir, "deploy"));
  copyFileSync(join(import.meta.dir, "../../deploy/rollback.sh"), join(dir, "deploy/rollback.sh"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/ssh"), `#!/bin/sh\ncat "${join(dir, "box")}"\n`);
  chmodSync(join(dir, "bin/ssh"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the default target is the newest held release before the running one", () => {
  const [c1, c2, c3, c4] = commits as [string, string, string, string];
  // c3's web image is gone, and c4 is newer than what runs: neither is a target.
  box(c3, [c1, c2, c3, c4, "latest"], [c1, c2, c4]);
  const r = rollback([], "n\n");
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(`roll back to         ${c2.slice(0, 7)}`);
  expect(r.stdout).toContain("not deployed");
});

test("--list names the releases the box holds, newest first", () => {
  const [c1, c2, c3] = commits as [string, string, string];
  box(c2, [c1, c2, c3], [c1, c2, c3]);
  const r = rollback(["--list"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim().split("\n").map((l) => l.split(" ")[0])).toEqual([c3, c2, c1].map((c) => c.slice(0, 7)));
  expect(r.stdout).toContain("release 2 (running)");
});

test("a commit whose images the box lacks is refused", () => {
  const [c1, c2, c3] = commits as [string, string, string];
  box(c3, [c2, c3], [c2, c3]);
  const r = rollback([c1]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`the box holds no images for ${c1}`);
});

test("no older release held is an error, not a deploy", () => {
  const [, c2, c3] = commits as [string, string, string];
  box(c2, [c2, c3], [c2, c3]);
  const r = rollback([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("holds no release older than");
});
