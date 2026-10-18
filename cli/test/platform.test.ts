import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidates, inBunfs, normalEnv, resolveCommand, spawnable } from "../src/platform";
import { platformAsset } from "../src/release";
import { removeBinary, replaceBinary } from "../src/update";
import { compiledFake, testCtx, until } from "./helpers";

describe("normalEnv", () => {
  test("on Windows, Path reads as PATH and HOME falls back to USERPROFILE", () => {
    const env = normalEnv(
      { Path: "C:\\bin", USERPROFILE: "C:\\Users\\tom", PATHEXT: ".EXE" },
      "win32",
      "C:\\fallback",
    );
    expect(env.PATH).toBe("C:\\bin");
    expect(env.Path).toBeUndefined();
    expect(env.HOME).toBe("C:\\Users\\tom");
    expect(env.PATHEXT).toBe(".EXE");
  });

  test("elsewhere it is the environment itself", () => {
    const env = { PATH: "/bin" };
    expect(normalEnv(env, "linux")).toBe(env);
  });
});

describe("candidates", () => {
  const env = { PATH: 'C:\\npm;"C:\\Program Files\\nodejs";relative', PATHEXT: ".COM;.EXE;.CMD" };

  test("on Windows, each PATHEXT extension in each absolute PATH folder", () => {
    expect(candidates(env, "codex", "win32")).toEqual([
      "C:\\npm\\codex.com",
      "C:\\npm\\codex.exe",
      "C:\\npm\\codex.cmd",
      "C:\\Program Files\\nodejs\\codex.com",
      "C:\\Program Files\\nodejs\\codex.exe",
      "C:\\Program Files\\nodejs\\codex.cmd",
    ]);
  });

  test("a name with an extension is taken as it is", () => {
    expect(candidates(env, "npm.cmd", "win32")).toEqual([
      "C:\\npm\\npm.cmd",
      "C:\\Program Files\\nodejs\\npm.cmd",
    ]);
  });

  test("on Unix, the name in each absolute folder", () => {
    expect(candidates({ PATH: "/usr/bin:bin:/bin" }, "codex", "linux")).toEqual([
      "/usr/bin/codex",
      "/bin/codex",
    ]);
  });
});

describe("spawnable", () => {
  test("an .exe or a Unix binary starts directly", () => {
    expect(spawnable("C:\\bin\\claude.exe", ["a&b"], {}, "win32")).toEqual({
      file: "C:\\bin\\claude.exe",
      args: ["a&b"],
    });
    expect(spawnable("/bin/x.cmd", ["a"], {}, "linux")).toEqual({
      file: "/bin/x.cmd",
      args: ["a"],
    });
  });

  test("a .cmd shim goes through cmd.exe with every special character escaped twice", () => {
    const s = spawnable(
      "C:\\Users\\tom\\AppData\\Roaming\\npm\\codex.cmd",
      ["queue", 'say "hi" & calc', "50%"],
      { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      "win32",
    );
    expect(s.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(s.windowsVerbatimArguments).toBe(true);
    expect(s.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(s.args[3]).toBe(
      '"C:\\Users\\tom\\AppData\\Roaming\\npm\\codex.cmd ^^^"queue^^^" ^^^"say^^^ \\^^^"hi\\^^^"^^^ ^^^&^^^ calc^^^" ^^^"50^^^%^^^""',
    );
  });

  test("a script that does not pass %* on gets its arguments escaped once", () => {
    const bat = join(mkdtempSync(join(tmpdir(), "sb-bat-")), "tool.bat");
    writeFileSync(bat, "@echo %~1\r\n");
    expect(spawnable(bat, ["a&b"], {}, "win32").args[3]).toBe(
      `"${bat.replace(/([ ()%])/g, "^$1")} ^"a^&b^""`,
    );
  });

  test("a line break cannot go through cmd.exe", () => {
    expect(() => spawnable("C:\\x.cmd", ["a\nb"], {}, "win32")).toThrow("line break");
  });
});

test("inBunfs knows a compiled binary's script on Unix and on Windows", () => {
  expect(inBunfs("/$bunfs/root/starbridge")).toBe(true);
  expect(inBunfs("B:\\~BUN\\root\\starbridge.exe")).toBe(true);
  expect(inBunfs("B:/~BUN/root/starbridge.exe")).toBe(true);
  expect(
    inBunfs("C:\\Users\\tom\\AppData\\Roaming\\npm\\node_modules\\starbridge\\dist\\starbridge.js"),
  ).toBe(false);
  expect(inBunfs(undefined)).toBe(false);
});

test("platformAsset names the Windows builds with .exe", () => {
  expect(platformAsset("win32", "x64")).toBe("starbridge-windows-x64.exe");
  expect(platformAsset("win32", "arm64")).toBe("starbridge-windows-arm64.exe");
  expect(platformAsset("linux", "arm64")).toBe("starbridge-linux-arm64");
  expect(() => platformAsset("win32", "ia32")).toThrow("no starbridge build");
});

test("resolveCommand keeps a relative path, and looks a bare name up on the PATH", () => {
  expect(resolveCommand({ PATH: "/nowhere" }, "./build.sh", "linux")).toBe("./build.sh");
  expect(resolveCommand({ PATH: "C:\\nowhere" }, "scripts\\build.cmd", "win32")).toBe(
    "scripts\\build.cmd",
  );
  expect(resolveCommand({ PATH: "/nowhere" }, "build.sh", "linux")).toBeUndefined();
});

describe("replaceBinary on Windows", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-replace-"));
    const target = join(dir, "starbridge.exe");
    const next = join(dir, ".starbridge.new");
    writeFileSync(target, "old");
    writeFileSync(next, "new");
    return { dir, target, next };
  };

  test("the new binary takes the name and the old one is gone", () => {
    const { target, next } = setup();
    writeFileSync(`${target}.old`, "from the update before");
    writeFileSync(`${target}.4242.old`, "kept by a copy that still ran");
    replaceBinary(next, target, "win32");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(next)).toBe(false);
    expect(existsSync(`${target}.old`)).toBe(false);
    expect(existsSync(`${target}.4242.old`)).toBe(false);
  });

  test("when the move fails, the old binary goes back", () => {
    const { target, dir } = setup();
    expect(() => replaceBinary(join(dir, "missing"), target, "win32")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("old");
  });
});

// Windows deletes no running `.exe`: a detached cmd.exe deletes it once uninstall returns. Its
// command line quotes the path, so a path with spaces and parentheses must reach `del` whole,
// and one cmd.exe would read otherwise must not reach it at all.
describe.skipIf(process.platform !== "win32")("removeBinary on Windows", () => {
  test("deletes the running binary and an update's leftovers once it exits", async () => {
    const dir = join(
      mkdtempSync(join(tmpdir(), "sb-remove-")),
      "Program Files (x86)",
      "star bridge",
    );
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "starbridge.exe");
    copyFileSync(compiledFake("await Bun.sleep(1000);"), exe);
    writeFileSync(`${exe}.old`, "from the update before");
    writeFileSync(`${exe}.4242.old`, "kept by a copy that still ran");
    // A neighbour the wildcard must not take.
    writeFileSync(join(dir, "starbridge.toml"), "");
    const running = Bun.spawn([exe]);
    const ctx = testCtx();
    expect(removeBinary(ctx, { kind: "binary", path: exe })).toBe(0);
    expect(ctx.lines).toEqual([
      `${exe} is deleted once this command returns; if it stays, a program still runs it.`,
    ]);
    await running.exited;
    await until(() => ![exe, `${exe}.old`, `${exe}.4242.old`].some(existsSync), 15_000);
    expect(existsSync(join(dir, "starbridge.toml"))).toBe(true);
  });

  test("leaves a path cmd.exe would read otherwise to the person, and says so", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sb-remove-")), "R&D 100%");
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "starbridge.exe");
    writeFileSync(exe, "");
    const ctx = testCtx();
    expect(removeBinary(ctx, { kind: "binary", path: exe })).toBe(0);
    expect(ctx.lines).toEqual([`Delete ${exe} once this command returns.`]);
    await Bun.sleep(3_000);
    expect(existsSync(exe)).toBe(true);
  });
});
