import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("output into a pipe the reader closed ends quietly, with SIGPIPE's status", async () => {
  const main = join(import.meta.dir, "../src/main.ts");
  // `true` exits without reading, so every write hits a closed pipe; the CLI's status goes to
  // stderr, which stays open.
  const sh = Bun.spawn(
    ["sh", "-c", `{ "${process.execPath}" "${main}" --help; echo "exit $?" >&2; } | true`],
    {
      env: {
        ...process.env,
        STARBRIDGE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "starbridge-cli-")),
      },
      stderr: "pipe",
    },
  );
  await sh.exited;
  expect(await new Response(sh.stderr).text()).toBe("exit 141\n");
});

test("the binary prints a command's help unpaired and with a broken STARBRIDGE_MACHINE, and run passes --help on (#1967)", async () => {
  const main = join(import.meta.dir, "../src/main.ts");
  const home = mkdtempSync(join(tmpdir(), "starbridge-cli-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_RUNTIME_DIR: home,
    STARBRIDGE_CONFIG_DIR: join(home, "config"),
    STARBRIDGE_NO_AGENT: "1",
    STARBRIDGE_NO_UPDATE_CHECK: "1",
  };
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, main, ...args], {
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = [
      await new Response(p.stdout).text(),
      await new Response(p.stderr).text(),
      await p.exited,
    ];
    return { out, err, code };
  };
  for (const extra of [{}, { STARBRIDGE_MACHINE: "not a machine" }] as Record<string, string>[]) {
    const help = await cli(["ask", "--help"], extra);
    expect(help).toMatchObject({ code: 0, err: "" });
    expect(help.out).toStartWith("  starbridge ask --question <text>");
    expect(help.out).toContain("The question takes at most\n      300 characters");
  }
  // After --, --help is the wrapped command's: it runs, unreported on an unpaired machine.
  const wrapped = await cli([
    "run",
    "--title",
    "t",
    "--reason",
    "r",
    "--",
    "sh",
    "-c",
    'echo "got $1"',
    "sh",
    "--help",
  ]);
  expect(wrapped).toMatchObject({ code: 0, out: "got --help\n" });
});
