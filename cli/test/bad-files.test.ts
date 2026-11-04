/**
 * A file the CLI reads, unreadable or the wrong shape, is repaired or named (#2266): "treat a read
 * that fails as an error" (AGENTS.md) had been broken three times by a read that took such a file
 * as empty or as success (#1174, #1335, #1334). Every file setup leaves in HOME (found from
 * `INTEGRATIONS`, so a new integration joins) and in the config folder is replaced in turn with
 * garbage, `[]`, `{}` and nothing; then setup, refresh, status, the update check and, for the
 * config folder, `ask` run. Each run ends with the file repaired or its path named, never with
 * the file as it was left and silence, and none hangs.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { makeAgent } from "../src/agent/main";
import { run } from "../src/cli";
import { checkLatest } from "../src/latest";
import { INTEGRATIONS } from "../src/setup/integrations";
import { refresh, setup } from "../src/setup/setup";
import { status } from "../src/setup/status";
import { defaults, type Sys } from "../src/setup/sys";
import { FAKE_BIN, paired, SYSTEM_PATH, type TestCtx } from "./helpers";

setDefaultTimeout(120_000);

const SHAPES = {
  garbage: "this is not { json or anything\n",
  array: "[]\n",
  object: "{}\n",
  missing: undefined,
} as const;
type Shape = keyof typeof SHAPES;

/** Longest one command may take; a hang fails the case instead of the whole run. */
const BOUND_MS = 20_000;

const bounded = <T>(what: string, p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => no(new Error(`${what} did not end in ${BOUND_MS} ms`)), BOUND_MS),
    ),
  ]);

/** Every file under `path`, which may itself be a file or absent. */
function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((n) => filesUnder(join(path, n)));
}

let server: LiveServer;
let github: ReturnType<typeof Bun.serve>;
let ctx: TestCtx;
let sys: Sys;
let home: string;
let stopAgent: () => Promise<void>;
/** Every file of the sweep, with the bytes a working setup left in it. */
const good = new Map<string, string>();
let configDir: string;
/** What the runs print with every file as setup left it: a line here names nothing wrong. */
const baseline = new Set<string>();

/**
 * Files that a run rewrites on its own, that hold a live process, or that another tool owns and
 * the CLI never reads: Codex's plugin cache (`codex plugin` writes it) and Pi's git checkout.
 */
const SKIPPED =
  /\.fake-marketplace$|\.sock$|\.port$|\.lock$|\.tmp$|\.unreadable-|agent\.log$|\.codex\/plugins\/|\.pi\/agent\/git\//;

/**
 * Cases that fail on main: a live bug each, `test.todo` below. Without `machine.json` setup pairs
 * again and waits for the phone, by design, so that case is not swept.
 */
const BUGS: Record<string, string> = {
  "config/state.json {}": "state.json holding {} crashes ask and setup with a TypeError (#2273)",
  "config/machine.json {}":
    "machine.json holding {} crashes setup and status says Paired: undefined (#2274)",
};
const NOT_SWEPT = ["config/machine.json missing"];

beforeAll(async () => {
  server = await LiveServer.start();
  github = Bun.serve({ port: 0, fetch: () => Response.json({ tag_name: "v99.0.0" }) });
  ctx = await paired(server);
  home = mkdtempSync(join(tmpdir(), "starbridge-bad-files-"));
  const fakes = mkdtempSync(join(tmpdir(), "starbridge-bad-fakes-"));
  Object.assign(ctx.env, {
    HOME: home,
    USER: "dev",
    PATH: [FAKE_BIN, dirname(process.execPath), SYSTEM_PATH].join(delimiter),
    FAKE_LOG: join(fakes, "log"),
    FAKE_STATE: fakes,
    STARBRIDGE_LATEST_URL: `http://localhost:${github.port}/latest`,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.file:///nonexistent/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
  });
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  const piConfig = join(home, ".pi/agent/extensions/pi-permission-system/config.json");
  mkdirSync(dirname(piConfig), { recursive: true });
  writeFileSync(piConfig, `${JSON.stringify({ permission: {} }, null, 2)}\n`);
  sys = {
    ctx,
    home,
    platform: "linux",
    arch: "x64",
    uid: 1000,
    prompt: defaults,
    self: [join(home, ".local", "bin", "starbridge")],
  };
  const agent = makeAgent(ctx);
  await agent.start();
  stopAgent = () => agent.stop();
  expect(await setup(sys, { yes: true, noQuota: true, readyTimeoutMs: 2_000 })).toBe(0);
  // The update check's own file, as the agent keeps it.
  await checkLatest(ctx);
  configDir = ctx.store.dir;
  const files = [
    ...INTEGRATIONS.flatMap((i) => i.paths(sys)).flatMap(filesUnder),
    ...filesUnder(configDir),
  ];
  for (const f of new Set(files)) if (!SKIPPED.test(f)) good.set(f, readFileSync(f, "utf8"));
});

afterAll(async () => {
  await stopAgent?.();
  github?.stop(true);
  server?.stop();
});

/** The folders of `file` that are at least two below HOME: `~/.codex/starbridge`, not `~/.codex`. */
function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let d = dirname(file); relative(home, d).split(sep).length >= 2; d = dirname(d)) out.push(d);
  return out;
}

const where = (f: string) =>
  f.startsWith(configDir) ? `config/${relative(configDir, f)}` : `~/${relative(home, f)}`;

/**
 * Runs the update check, refresh, setup, status and, for a file of the config folder, `ask`, each
 * bounded; returns every line they printed. `afterCheck` runs right after the update check.
 */
async function runAll(file: string, failures: string[], afterCheck = () => {}): Promise<string[]> {
  ctx.lines.length = 0;
  ctx.errors.length = 0;
  const step = async (what: string, p: Promise<unknown>) => {
    try {
      return await bounded(what, p);
    } catch (e) {
      ctx.errors.push(`${what}: ${(e as Error).message}`);
      if (/did not end/.test((e as Error).message)) failures.push((e as Error).message);
    }
  };
  await step("update check", checkLatest(ctx, new Date(Date.now() + 3 * 86_400_000)));
  afterCheck();
  await step(
    "refresh",
    refresh(sys).then((l) => {
      for (const x of l) ctx.out(x);
    }),
  );
  await step("setup", setup(sys, { yes: true, noQuota: true, readyTimeoutMs: 2_000 }));
  await step("status", status(sys));
  if (file.startsWith(configDir)) await step("ask", run(["ask", "--question", "Ship it?"], ctx));
  return [...ctx.lines, ...ctx.errors].flatMap((l) => l.split("\n"));
}

/** Shell startup files: the owner's, with one line of setup's. */
const OWNER_TEXT = /\/\.(profile|bashrc|bash_profile|zshrc|zprofile)$/;
/** Files only the agent's own command changes. */
const AGENT_OWNED = /\/\.codex\/config\.toml$|\/\.pi\/agent\/settings\.json$/;

/**
 * Whether `after` is a working file again, not just a changed one: a run may append to a broken
 * file and leave it broken. As setup wrote it, or for JSON the same kind of value it wrote, or
 * for any other file one that no longer holds the bad text.
 */
function valid(file: string, after: string, bad: string | undefined): boolean {
  const was = good.get(file);
  if (after === was) return true;
  // The owner's own text, where setup keeps only its line: setup can't know what else is right.
  if (OWNER_TEXT.test(file)) return after.includes("# Added by starbridge setup");
  // The agent's own files, which setup changes only through the agent's command (`codex plugin
  // add`, `pi install`). The fake agents append to a broken file where the real ones may refuse
  // it, so what is right here is the real agent's call, not this sweep's.
  if (AGENT_OWNED.test(file)) return true;
  if (file.endsWith(".json")) {
    const kind = (t: string | undefined) => {
      try {
        const v = JSON.parse(t ?? "");
        return Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
      } catch {
        return "unparsed";
      }
    };
    return kind(after) !== "unparsed" && kind(after) === kind(was) && after.trim() !== bad?.trim();
  }
  return bad === undefined || !after.includes(bad.trim());
}

/** What a case found wrong, or undefined. */
async function sweepOne(file: string, shape: Shape): Promise<string | undefined> {
  const before = new Map<string, string>();
  for (const f of [...good.keys(), ...filesUnder(home), ...filesUnder(configDir)])
    if (!SKIPPED.test(f) && existsSync(f)) before.set(f, readFileSync(f, "utf8"));
  const text = SHAPES[shape];
  if (text === undefined) rmSync(file, { force: true });
  else writeFileSync(file, text);
  const failures: string[] = [];
  try {
    // The update check cannot speak (it never throws and prints nothing), so it must repair
    // `latest.json` itself, a cache it reads again from GitHub (#1174).
    const lines = await runAll(file, failures, () => {
      if (file !== join(configDir, "latest.json")) return;
      const now = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      if (now === undefined || now === text)
        failures.push(`the update check left ${where(file)} (${shape}) as it was`);
    });
    // Only what a run with every file as setup left it does not print: setup names its folders
    // on every run, which says nothing about this file.
    const said = lines.filter((l) => !baseline.has(l)).join("\n");
    const after = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    // Named by its path or by the folder of the integration it belongs to ("left alone").
    const named = [file, ...ancestors(file)].some((p) => said.includes(p));
    // A step that failed says so on a ✗ line, which is not success.
    const reported = said.includes("✗ ");
    const repaired = after !== undefined && valid(file, after, text);
    if (!repaired && !named && !reported)
      failures.push(
        `${where(file)} (${shape}) was left ${after === undefined ? "missing" : `as ${JSON.stringify(after)}`} and no output names it`,
      );
  } finally {
    // Back to the working setup, for the next case.
    for (const [f, t] of before) writeFileSync(f, t);
    for (const f of [...filesUnder(home), ...filesUnder(configDir)])
      if (!before.has(f) && !SKIPPED.test(f)) rmSync(f, { force: true });
  }
  return failures.length ? failures.join("; ") : undefined;
}

// A file that is JSON but lacks what the reader needs reaches code that assumes it (no issue yet).
for (const [id, why] of Object.entries(BUGS)) test.todo(`${id}: ${why}`);

// The fake agents are shell scripts, which Windows does not start as these tests do.
test.skipIf(process.platform === "win32")("sweep", async () => {
  for (const l of await runAll(join(configDir, "none"), [])) baseline.add(l);
  const found: string[] = [];
  for (const file of good.keys())
    for (const shape of Object.keys(SHAPES) as Shape[]) {
      const id = `${where(file)} ${shape === "object" ? "{}" : shape}`;
      if (id in BUGS || NOT_SWEPT.includes(id)) continue;
      const r = await sweepOne(file, shape);
      if (r) found.push(r);
    }
  expect(
    found,
    "Read the file through a reader that refuses what it can't use and says which file (AGENTS.md: treat a read that fails as an error), or rewrite it as setup would",
  ).toEqual([]);
});
