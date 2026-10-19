import { expect, test } from "bun:test";

// register.ts imports the engine's types, which CI does not have: loaded by a path tsc does not
// follow (register.test.ts).
const REGISTER = "../hooks/register.ts";

type Handler = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

/** The mod's hooks as the starbridge-remote plugin loads them, where remote.sh exits `code`. */
async function remote(code: number) {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const ran: string[][] = [];
  const $ = {
    plugin: { name: "starbridge-remote", root: "/r" },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv);
        return { exitCode: code, stdout: "", stderr: "" };
      },
    },
  };
  return { handlers, ran, $ };
}

test("in starbridge-remote, every hook of the mod hands on where the installed starbridge-mod runs (#2107)", async () => {
  const { handlers, ran, $ } = await remote(1);
  expect([...handlers.keys()]).toContain("session.start");
  for (const [event, h] of handlers) {
    let passed: unknown;
    const e = { event };
    // A hook that ran would read `$.env` or `$.session`, which this `$` lacks, and throw.
    await h($, e, async (x) => {
      passed = x;
      return "next";
    });
    expect(passed).toBe(e);
  }
  // Claude Code's arguments do not change while it runs: one check per process.
  expect(ran).toEqual([["sh", "/r/hooks/remote.sh", "starbridge-mod"]]);
});

test("in starbridge-remote, the mod's hooks run where a hookless copy replaced starbridge-mod (#2107)", async () => {
  const { handlers, $ } = await remote(0);
  // session.start reads the environment after `next`: getting there shows the hook ran.
  const start = handlers.get("session.start") as Handler;
  await expect(start($, { isInteractive: true }, async () => undefined)).rejects.toThrow();
});
