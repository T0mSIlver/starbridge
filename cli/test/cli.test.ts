import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Answer, fromB64, open, type SealedItem, seal } from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { makeAgent } from "../src/agent/main";
import { run } from "../src/cli";
import { session } from "../src/context";
import { DONE_LINE, poll } from "../src/decisions";
import { piAllow, piPermissionConfig } from "../src/pi";
import { configCommand, offerPiChain } from "../src/settings";
import { FAKE_CODEXBAR, paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

const ASK = [
  "ask",
  "--question",
  "Merge #12 now?",
  "--context",
  "CI is green.",
  "--option",
  "Merge",
  "--option",
  "Wait",
];

test("pair joins the directory and keeps the keys private", async () => {
  const ctx = await paired(server);
  const machine = ctx.store.machine();
  expect(machine?.name).toBe("devbox");
  expect((await server.directory()).members.get(machine?.id as string)?.active).toBe(true);
  expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
  for (const f of ["machine.json", "directory.json", "state.json"])
    expect(statSync(join(ctx.store.dir, f)).mode & 0o777).toBe(0o600);
  expect(await run(["pair", "--server", server.url], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("already paired");
});

test("state files carry their format, and one the CLI cannot read stays as it is", async () => {
  const ctx = await paired(server);
  for (const f of ["machine.json", "directory.json", "state.json"])
    expect(JSON.parse(readFileSync(join(ctx.store.dir, f), "utf8")).v).toBe(1);
  const path = join(ctx.store.dir, "state.json");
  for (const [text, says] of [
    ["{ not json", "is not valid JSON"],
    ['{"v": 2, "asked": {}}', "from a newer starbridge"],
    ["[]", "move it away"],
  ] as const) {
    writeFileSync(path, text);
    expect(await run(["waiting", "d_1"], ctx)).toBe(1);
    expect(ctx.errors.at(-1)).toContain(says);
    expect(readFileSync(path, "utf8")).toBe(text);
  }
});

/** Reads a terminal QR back: each character is two modules, upper and lower, 4 px square. */
function scan(lines: string[]): string | undefined {
  const rows = lines.map((l) => [
    ...l.replaceAll("\u001b[30;107m", "").replaceAll("\u001b[0m", ""),
  ]);
  const width = (rows[0]?.length ?? 0) * 4;
  const height = rows.length * 8;
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [y, row] of rows.entries())
    for (const [x, ch] of row.entries()) {
      const dark = [ch === "█" || ch === "▀", ch === "█" || ch === "▄"];
      for (let dy = 0; dy < 8; dy++)
        for (let dx = 0; dx < 4; dx++) {
          if (!dark[dy < 4 ? 0 : 1]) continue;
          const i = ((y * 8 + dy) * width + x * 4 + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }
  return jsQR(px, width, height)?.data;
}

test("pair prints a link and a QR code that carry the code", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", `${server.url}/`, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Or type the code")));
  const code = ctx.lines[0]?.replace("Pairing code: ", "") as string;
  const link = `${server.url}/pair#${code}`;
  expect(ctx.lines[1]).toEndWith(link);
  expect(scan(ctx.lines.slice(2, -1))).toBe(link);
  await server.approve(code);
  expect(await done).toBe(0);
});

test("pair uses the hosted server unless --server or STARBRIDGE_SERVER names another", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    throw new Error("offline");
  }) as unknown as typeof fetch;
  try {
    const hosted = testCtx();
    expect(await run(["pair"], hosted)).toBe(1);
    expect(hosted.errors.at(-1)).toBe("starbridge: cannot reach https://starbridge.run: offline");
    expect(await run(["pair"], testCtx({ STARBRIDGE_SERVER: "https://self.example" }))).toBe(1);
  } finally {
    globalThis.fetch = real;
  }
  expect(asked).toEqual(["https://starbridge.run/v1/pairings", "https://self.example/v1/pairings"]);
});

test("pair --force names the old pairing as Devices shows it, not by its id (#287)", async () => {
  const ctx = await paired(server);
  const done = run(["pair", "--force"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  await server.approve(ctx.lines[0]?.replace("Pairing code: ", "") as string);
  expect(await done).toBe(0);
  expect(ctx.lines.at(-1)).toMatch(
    /^Devices still lists the old pairing as the earlier "devbox", added [A-Z][a-z]{2} \d+, \d\d:\d\d( [AP]M)? \S+\. Revoke it there\.$/,
  );
});

test("a machine the owner removed says so and how to pair it again", async () => {
  const ctx = await paired(server);
  await server.revoke(ctx.store.machine()?.id as string);
  expect(await run(ASK, ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toBe(
    "starbridge: this machine was removed from your Starbridge account: run `starbridge pair --force` to add it again",
  );
});

test("ask seals a decision the phone can open, recommended first", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const [d] = await server.opened("decision");
  expect(d?.id).toBe(ctx.lines[0] as string);
  expect(d?.options).toEqual(["Merge", "Wait"]);
  expect(d?.recommended).toBe("Merge");
  expect(d?.source).toMatchObject({ machine: "devbox", session: "s1" });
});

test("ask names the session and links to it from Claude Code's record, unless flags say otherwise", async () => {
  const ctx = await paired(server);
  const dir = mkdtempSync(join(tmpdir(), "starbridge-claude-"));
  mkdirSync(join(dir, "sessions"));
  const record = (pid: number, fields: object) =>
    writeFileSync(join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, ...fields }));
  // An older process that ran the same session, before a resume.
  record(1, { sessionId: "s1", name: "Old name", updatedAt: 1, bridgeSessionId: null });
  record(2, {
    sessionId: "s1",
    name: "Merge the uploader",
    updatedAt: 2,
    hostSessionId: "local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
    bridgeSessionId: "session_01UZCLSHk7GjaUdtNBsLAvvt",
  });
  // Rewritten in place without truncating: the tail of a longer record follows.
  writeFileSync(
    join(dir, "sessions", "3.json"),
    `${JSON.stringify({ sessionId: "s2", name: "Short" })}ion_01DRfkYrUXFy"}`,
  );
  ctx.env.CLAUDE_CONFIG_DIR = dir;
  ctx.env.CLAUDE_CODE_SESSION_ID = "s1";

  expect(await run(ASK, ctx)).toBe(0);
  expect(await run([...ASK, "--session", "s2"], ctx)).toBe(0);
  const flags = [
    "--session-title",
    "Mine",
    "--session-link",
    "web=https://claude.ai/code/session_9",
  ];
  expect(await run([...ASK, ...flags], ctx)).toBe(0);
  const sources = (await server.opened("decision")).map((d) => d.source);
  expect(sources[0]).toMatchObject({
    session: "s1",
    sessionTitle: "Merge the uploader",
    links: [
      { kind: "remote-control", url: "https://claude.ai/code/session_01UZCLSHk7GjaUdtNBsLAvvt" },
      {
        kind: "desktop",
        url: "claude://claude.ai/epitaxy/local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
      },
    ],
  });
  expect(sources[1]).toMatchObject({ session: "s2", sessionTitle: "Short" });
  expect(sources[1]?.links).toBeUndefined();
  expect(sources[2]).toMatchObject({
    sessionTitle: "Mine",
    links: [{ kind: "web", url: "https://claude.ai/code/session_9" }],
  });

  expect(await run([...ASK, "--session-link", "desktop=https://evil.example"], ctx)).toBe(1);
  expect(await run([...ASK, "--session-link", "nokind"], ctx)).toBe(1);
  expect(await server.opened("decision")).toHaveLength(3);
});

/** A PNG of noise, the worst case for compression, so only scaling it down makes it fit. */
function noisyPng(width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i++) png.data[i] = i % 4 === 3 ? 255 : (i * 7919) % 251;
  const path = join(mkdtempSync(join(tmpdir(), "starbridge-img-")), "shot.png");
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

test("ask attaches images scaled to fit the server's cap, and links", async () => {
  const ctx = await paired(server);
  const big = noisyPng(2400, 1500);
  const small = join(tmpdir(), `starbridge-small-${process.pid}.png`);
  writeFileSync(small, PNG.sync.write(new PNG({ width: 4, height: 2 })));
  const artifact = "https://claude.ai/public/artifacts/0b3f0e7c";
  const flags = ["--image", big, "--image", small, "--link", artifact];
  expect(await run([...ASK, ...flags], ctx)).toBe(0);

  const [d] = await server.opened("decision");
  expect(d?.links).toEqual([{ url: artifact }]);
  const [scaled, kept] = d?.images ?? [];
  // The large one became a JPEG, with its aspect ratio.
  expect(scaled?.type).toBe("image/jpeg");
  expect(scaled?.width).toBeLessThanOrEqual(2400);
  expect(Math.abs((scaled?.width ?? 0) / (scaled?.height ?? 1) - 1.6)).toBeLessThan(0.02);
  // The small one already fit, so it went as is.
  expect(kept).toMatchObject({ type: "image/png", width: 4, height: 2 });

  expect(await run([...ASK, "--image", join(tmpdir(), "missing.png")], ctx)).toBe(1);
  expect(await run([...ASK, "--image", FAKE_CODEXBAR], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("PNG or JPEG");
  expect(await run([...ASK, "--link", "http://example.com"], ctx)).toBe(1);
  expect(await server.opened("decision")).toHaveLength(1);
}, 30_000); // Scales real images: over 6 s on a loaded dev box runner (#222).

/** A landscape JPEG stored the way a phone stores a portrait: EXIF orientation 6. */
function sidewaysJpeg(): string {
  const w = 40;
  const h = 20;
  const data = Buffer.alloc(w * h * 4, 255);
  // A red left column, which shows on top once the photo is turned upright.
  for (let y = 0; y < h; y++) data.set([255, 0, 0, 255], y * w * 4);
  const plain = jpeg.encode({ data, width: w, height: h }, 90).data;
  const tiff = Buffer.from([
    ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8],
    ...[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0],
    ...[0, 0, 0, 0],
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, body.length + 2]), body]);
  const path = join(mkdtempSync(join(tmpdir(), "starbridge-img-")), "photo.jpg");
  writeFileSync(path, Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]));
  return path;
}

test("ask turns a sideways phone photo upright", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--image", sidewaysJpeg()], ctx)).toBe(0);
  const [img] = (await server.opened("decision"))[0]?.images ?? [];
  expect(img).toMatchObject({ type: "image/jpeg", width: 20, height: 40 });
  const px = jpeg.decode(fromB64(img?.data ?? ""), { useTArray: true });
  // The top row is red; the bottom row is white.
  expect(px.data[0]).toBeGreaterThan(200);
  expect(px.data[1]).toBeLessThan(80);
  expect(px.data[(39 * 20 + 10) * 4 + 1]).toBeGreaterThan(200);
});

test("ask --answer-in posts a pointer decision, and settle closes it", async () => {
  const ctx = await paired(server);
  const page = "https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYd";
  const pointer = ["ask", "--question", "Pick a layout?", "--session", "s"];
  expect(await run([...pointer, "--answer-in", page, "--option", "A", "--option", "B"], ctx)).toBe(
    1,
  );
  expect(ctx.errors.at(-1)).toContain("never in two places");
  expect(await run([...pointer, "--answer-in", page], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  expect((await server.opened("decision"))[0]).toMatchObject({
    answerIn: { url: page },
    options: [],
  });

  expect(await run(["settle", id], ctx)).toBe(0);
  const listed = (await server.listed("decision"))[0];
  expect(listed?.answeredAt).toBeDefined();
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
  // A second settle finds it closed already, which is fine.
  expect(await run(["settle", id], ctx)).toBe(0);
  expect(await run(["settle", "d_unknown"], ctx)).toBe(1);
});

test("Done on an --answer-in decision reaches the agent, and every device hears of it (#539)", async () => {
  const ctx = await paired(server);
  const page = "https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYd";
  expect(await run(["ask", "--question", "Pick a layout?", "--answer-in", page], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  expect((await server.opened("decision"))[0]).toMatchObject({
    answerIn: { url: page },
    done: true,
  });
  await server.answer(id, { done: true });
  ctx.lines.length = 0;
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([`Answer to ${id} (Pick a layout?): ${DONE_LINE}`]);
  const [notice] = await server.opened("settled");
  expect(notice).toMatchObject({ itemId: id, outcome: "device" });
  expect(notice?.choice).toBeUndefined();
  expect(notice?.text).toBeUndefined();
  // Answered already: settle posts nothing more.
  expect(await run(["settle", id], ctx)).toBe(0);
  expect(await server.opened("settled")).toHaveLength(1);
});

test("the machine tells every device which answer it took, once (#330)", async () => {
  const ctx = await paired(server);
  expect(await run(ASK, ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { choice: "Wait" });
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
  const phone = [...(await server.directory()).members.values()].find(
    (m) => m.member.role === "device",
  );
  expect(await server.opened("settled")).toMatchObject([
    { itemId: id, outcome: "device", device: phone?.member.id, choice: "Wait" },
  ]);
  // Told once: a later poll posts nothing more.
  expect(await run(["answers", "--session", "s", "--wait", "1"], ctx)).toBe(0);
  expect(await server.opened("settled")).toHaveLength(1);
});

test("settle leaves a decision whose answer reached the agent answered, not withdrawn", async () => {
  const ctx = await paired(server);
  expect(await run(ASK, ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { choice: "Merge" });
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
  expect(await run(["settle", id], ctx)).toBe(0);
  expect((await server.opened("settled")).map((n) => n.outcome)).toEqual(["device"]);
});

test("ask refuses a decision that would not stand alone", async () => {
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "Q?", "--option", "Only"], ctx)).toBe(1);
  expect(await run([...ASK, "--recommended", "Neither"], ctx)).toBe(1);
  expect(await run(["ask", "--option", "A", "--option", "B"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--question");
  expect(await server.opened("decision")).toEqual([]);
});

test("ask refuses a default, as a flag or in --input: agents never answer for the owner", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--default", "A"], ctx)).toBe(1);
  const file = join(mkdtempSync(join(tmpdir(), "starbridge-ask-")), "ask.json");
  writeFileSync(file, JSON.stringify({ question: "Q?", options: ["A", "B"], default: "A" }));
  expect(await run(["ask", "--input", file], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("no default");
  expect(await server.opened("decision")).toEqual([]);
});

test("waiting and working flip a decision's state, and each flip pushes", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  const state = async () => (await server.opened("waiting")).map((w) => w.state);
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(await state()).toEqual(["waiting"]);
  expect(await run(["working", id], ctx)).toBe(0);
  expect(await state()).toEqual(["working"]);
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(server.pushed).toEqual(["decision", "waiting", "waiting", "waiting"]);

  await server.answer(id, { choice: "Merge" });
  await run(["wait", id], ctx);
  expect(await run(["working", id], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("already answered");
});

test("wait --no-mark collects an answer without marking it waiting, which would notify again (#603)", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  expect(await run(["wait", id, "--no-mark", "--timeout", "1s"], ctx)).toBe(2);
  expect(await server.opened("waiting")).toEqual([]);
  expect(server.pushed).toEqual(["decision"]);
  // Without it, the first wait marks it waiting once; the next pushes nothing more.
  expect(await run(["wait", id, "--timeout", "1s"], ctx)).toBe(2);
  expect(await run(["wait", id, "--timeout", "1s"], ctx)).toBe(2);
  expect(server.pushed).toEqual(["decision", "waiting"]);
  await server.answer(id, { choice: "Merge" });
  expect(await run(["wait", id, "--no-mark"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
});

test("ask --waiting pushes once, through its waiting state, so the notification says waiting", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--waiting"], ctx);
  expect((await server.opened("waiting")).map((w) => w.state)).toEqual(["waiting"]);
  expect(server.pushed).toEqual(["waiting"]);
});

test("a decision names its agent and the machine's kind, which config sets", async () => {
  const ctx = await paired(server);
  expect(ctx.store.agentConfig().machineKind).toBeDefined();
  expect(await run(["config", "machine-kind", "laptop"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe("machine-kind  laptop");
  ctx.env.CLAUDECODE = "1";
  await run(ASK, ctx);
  const [d] = await server.opened("decision");
  expect(d?.agent).toBe("claude-code");
  expect(d?.source.machineKind).toBe("laptop");
  expect(await run(["config", "machine-kind", "phone"], ctx)).toBe(1);
});

test("a claude -p session is told to wait, since no mod brings its answer back", async () => {
  const ctx = await paired(server);
  ctx.env.CLAUDECODE = "1";
  await run(ASK, ctx);
  expect(ctx.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
  ctx.env.CLAUDE_CODE_SESSION_ATTENDED = "0";
  await run(ASK, ctx);
  expect(ctx.errors.at(-1)).toContain("run `starbridge wait");
  // Started from a Pi session, it inherits Pi's variables, and still asks as itself.
  ctx.env.PI_SESSION_ID = "p1";
  ctx.env.STARBRIDGE_PI_ANSWERS = "p1";
  await run(ASK, ctx);
  expect(ctx.errors.at(-1)).toContain("run `starbridge wait");
  expect((await server.opened("decision")).map((d) => d.agent)).toEqual([
    "claude-code",
    "claude-code",
    "claude-code",
  ]);
});

test("config turns permission prompts on and off", async () => {
  const ctx = await paired(server);
  expect(await run(["config"], ctx)).toBe(0);
  expect(ctx.lines.at(-2)).toBe("permissions   off");
  expect(await run(["config", "permissions", "on"], ctx)).toBe(0);
  expect(ctx.lines.at(-2)).toBe("permissions   on");
  expect(await run(["config", "permissions", "maybe"], ctx)).toBe(1);
});

test("permissions on offers to name the Starbridge link in pi-permission-system's chain", async () => {
  const ctx = await paired(server);
  const home = mkdtempSync(join(tmpdir(), "starbridge-pi-home-"));
  const dir = join(home, ".pi", "agent", "extensions", "pi-permission-system");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ permission: { bash: "ask" }, authorizerChain: ["judge"] }));
  ctx.env.HOME = home;
  // No terminal: it says what to add and touches nothing.
  expect(await run(["config", "permissions", "on"], ctx)).toBe(0);
  expect(ctx.lines).toContain(
    `Pi: to send pi-permission-system's prompts too, add "starbridge" to "authorizerChain" in ${file}.`,
  );
  expect(JSON.parse(readFileSync(file, "utf8")).authorizerChain).toEqual(["judge"]);

  const no = { confirm: async () => false, text: async (_q: string, d: string) => d };
  await offerPiChain(ctx, no);
  expect(JSON.parse(readFileSync(file, "utf8")).authorizerChain).toEqual(["judge"]);
  await offerPiChain(ctx, { ...no, confirm: async () => true });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    permission: { bash: "ask" },
    authorizerChain: ["judge", "starbridge"],
  });
  // Named already: nothing to ask.
  const before = ctx.lines.length;
  await offerPiChain(ctx, {
    ...no,
    confirm: async () => {
      throw new Error("asked");
    },
  });
  expect(ctx.lines.length).toBe(before);
});

test("permissions on after installing pi-permission-system lets Starbridge's own calls through", async () => {
  const ctx = await paired(server);
  ctx.env.HOME = mkdtempSync(join(tmpdir(), "starbridge-pi-home-"));
  // Installed after setup, as setup's hint says: setup had no config to add the rules to.
  mkdirSync(join(ctx.env.HOME, ".pi/agent/extensions/pi-permission-system"), { recursive: true });
  const yes = { confirm: async () => true, text: async (_q: string, d: string) => d };
  expect(await configCommand(ctx, ["permissions", "on"], yes)).toBe(0);
  const config = JSON.parse(readFileSync(piPermissionConfig(ctx.env), "utf8"));
  expect(config.authorizerChain).toEqual(["starbridge"]);
  expect(Object.keys(config.permission)).toEqual(["skill", "read"]);
  expect(piAllow(ctx.env).state).toBe("allowed");
});

test("ask --wait prints the answer the phone sends", async () => {
  const ctx = await paired(server);
  const done = run([...ASK, "--wait"], ctx);
  await until(() => ctx.lines.length === 1);
  await server.answer(ctx.lines[0] as string, { choice: "Wait" });
  expect(await done).toBe(0);
  expect(ctx.lines[1]).toBe(`Answer to ${ctx.lines[0]} (Merge #12 now?): Wait`);
});

test("a typed reply answers a question with options", async () => {
  const ctx = await paired(server);
  const done = run([...ASK, "--wait"], ctx);
  await until(() => ctx.lines.length === 1);
  const [d] = await server.opened("decision");
  expect(d?.replies).toBe(true);
  await server.answer(ctx.lines[0] as string, { text: "Merge after #13" });
  expect(await done).toBe(0);
  expect(ctx.lines[1]).toBe(`Answer to ${ctx.lines[0]} (Merge #12 now?): Merge after #13`);
});

test("wait ignores forged or foreign answers and keeps the good one", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  const done = run(["wait", id, "--json"], ctx);
  await until(() => server.log.includes("GET /answers"));
  // The open poll returns these answers, then the directory refresh and the next poll fail once.
  server.failures.push("/directory", "/answers");
  // The real server takes one answer per decision; these two need a compromised one.
  await server.forge(
    { decisionId: id, reply: { choice: "Ship it" } },
    { decisionId: id, reply: { choice: "Merge" }, tamper: { decisionId: "d_other" } },
  );
  await server.answer(id, { choice: "Merge" });
  expect(await done).toBe(0);
  expect(JSON.parse(ctx.lines[1] as string)).toMatchObject({ decisionId: id, choice: "Merge" });
  expect(ctx.errors.filter((e) => e.includes("ignored an answer"))).toHaveLength(2);
  expect(ctx.errors.filter((e) => e.includes("retrying"))).toHaveLength(2);
});

test("an answer to a withdrawn or answerIn decision, or a Done to another, is neither accepted nor delivered", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s"], ctx);
  const late = ctx.lines.at(-1) as string;
  await run([...ASK, "--session", "s"], ctx);
  const early = ctx.lines.at(-1) as string;
  const page = "https://claude.ai/artifact/2ig2MyNRD484b7oZea5vkZ";
  await run(["ask", "--question", "Pick?", "--answer-in", page, "--session", "s"], ctx);
  const pointer = ctx.lines.at(-1) as string;
  await run([...ASK, "--session", "s"], ctx);
  const open = ctx.lines.at(-1) as string;
  // Accepted before the agent withdrew it, still unread: it is never delivered.
  await server.answer(early, { choice: "Merge" });
  await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
  expect(ctx.store.state().answers[early]).toBeDefined();
  await run(["settle", early], ctx);
  await run(["settle", late], ctx);
  // A compromised server held these signed answers and releases them now.
  await server.forge(
    { decisionId: late, reply: { choice: "Merge" } },
    { decisionId: pointer, reply: { text: "Roomy" } },
    // Done answers only a decision asked on its own page.
    { decisionId: open, reply: { done: true } },
  );
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s", "--wait", "1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect(ctx.store.state().answers[late]).toBeUndefined();
  expect(ctx.store.state().answers[pointer]).toBeUndefined();
  expect(ctx.store.state().answers[open]).toBeUndefined();
  expect(ctx.errors.filter((e) => e.includes("ignored an answer"))).toHaveLength(3);
  expect(await run(["wait", "--timeout", "1s"], ctx)).toBe(2);
  expect(await run(["wait", early, "--timeout", "1s"], ctx)).toBe(1);
});

test("a device the decision was not sealed to cannot answer it", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s"], ctx);
  const id = ctx.lines.at(-1) as string;
  // Paired after the decision: a compromised server hands it the id, and it answers.
  const laptop = await server.addDevice("laptop");
  const machine = (await server.directory()).members.get(ctx.store.machine()?.id as string);
  const body: Answer = {
    v: 1,
    id: `a_${crypto.randomUUID()}`,
    decisionId: id,
    to: machine?.member.id as string,
    answeredAt: `${new Date().toISOString().slice(0, 19)}Z`,
    text: "Force-push main",
  };
  server.inject(
    seal("answer", body, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, [
      machine?.member as NonNullable<typeof machine>["member"],
    ]),
  );
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s", "--wait", "1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect(ctx.errors.at(-1)).toContain("not sent to laptop");
  // The phone, which it was sealed to, still can.
  await server.answer(id, { choice: "Wait" });
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
});

test("open decisions reach a device that joins later, which can answer them", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s", "--waiting"], ctx);
  const id = ctx.lines.at(-1) as string;
  await run(["ask", "--question", "Done?", "--session", "s"], ctx);
  await run(["settle", ctx.lines.at(-1) as string], ctx);
  await server.addDevice("old");
  await server.revoke("old");
  const laptop = await server.addDevice("laptop");
  const machine = ctx.store.machine()?.id as string;
  const call = async (path: string, init?: RequestInit) =>
    fetch(`${server.url}/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${laptop.token}`, "content-type": "application/json" },
    });
  const opened = async () => {
    const { items } = (await (await call("/items?kind=decision,waiting")).json()) as {
      items: { item: SealedItem & { kind: "decision" | "waiting" } }[];
    };
    const dir = await server.directory();
    return items.map((i) => open(i.item, { id: laptop.id, box: laptop.keys.box }, dir).body);
  };
  expect(await opened()).toEqual([]);
  server.pushed.length = 0;
  // Any answer poll re-seals; a second one, with nothing new, posts nothing.
  for (let i = 0; i < 2; i++)
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 0, shared: true });
  // Pushed to the laptop only; the revoked device gets no box, which the server would refuse.
  expect(server.pushed).toEqual(["decision"]);
  expect(ctx.errors.filter((e) => e.includes("re-send"))).toEqual([]);
  expect((await opened()).map((b) => b.id)).toEqual([
    id,
    ctx.store.state().asked[id]?.waiting?.id as string,
  ]);
  // Signed with the head the machine holds now, which lists the laptop (#362).
  const now = await server.directory();
  for (const b of await opened()) expect(b.dir).toEqual({ length: now.length, head: now.head });
  // The phone, which had it, still holds one copy.
  expect((await server.opened("decision", "&open=1")).map((d) => d.id)).toEqual([id]);
  const answer: Answer = {
    v: 1,
    id: `a_${crypto.randomUUID()}`,
    decisionId: id,
    to: machine,
    answeredAt: `${new Date().toISOString().slice(0, 19)}Z`,
    choice: "Merge",
  };
  const member = (await server.directory()).members.get(machine)?.member;
  const sealed = seal("answer", answer, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, [
    member as NonNullable<typeof member>,
  ]);
  expect((await call("/items", { method: "POST", body: JSON.stringify(sealed) })).status).toBe(201);
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
  // Answered or withdrawn, a decision's plaintext leaves the state.
  expect(Object.values(ctx.store.state().asked).map((a) => a.body)).toEqual([undefined, undefined]);
});

/** A laptop's answer the machine accepted, not yet taken by its session, then the laptop revoked. */
async function revokedAnswer() {
  const ctx = await paired(server);
  const laptop = await server.addDevice("laptop");
  await run([...ASK, "--session", "s"], ctx);
  const id = ctx.lines.at(-1) as string;
  const machine = ctx.store.machine()?.id as string;
  const answer: Answer = {
    v: 1,
    id: `a_${crypto.randomUUID()}`,
    decisionId: id,
    to: machine,
    answeredAt: `${new Date().toISOString().slice(0, 19)}Z`,
    choice: "Merge",
  };
  const member = (await server.directory()).members.get(machine)?.member;
  const sealed = seal("answer", answer, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, [
    member as NonNullable<typeof member>,
  ]);
  const posted = await fetch(`${server.url}/v1/items`, {
    method: "POST",
    headers: { authorization: `Bearer ${laptop.token}`, "content-type": "application/json" },
    body: JSON.stringify(sealed),
  });
  expect(posted.status).toBe(201);
  const { cursor } = await poll(ctx, session(ctx), { seconds: 0, shared: true });
  // Accepted while the session's agent was closed.
  expect(ctx.store.state().answers[id]?.seen).toBe(false);
  await server.revoke("laptop");
  return { ctx, id, cursor };
}

test("a revoked device's undelivered answer is not handed to its session (#491)", async () => {
  const { ctx, id } = await revokedAnswer();
  // `answers` hands out what is saved before it polls, as `wait` does.
  expect(await run(["answers", "--session", "s", "--wait", "0"], ctx)).toBe(0);
  expect(ctx.lines.join("\n")).not.toContain("Merge");
  expect(ctx.store.state().answers[id]).toBeUndefined();
});

test("a decision whose answer came from a device revoked since is closed (#515)", async () => {
  const { ctx, id, cursor } = await revokedAnswer();
  await poll(ctx, session(ctx), { cursor, seconds: 0, shared: true });
  expect(ctx.store.state().asked[id]).toMatchObject({ settled: true, revoked: true });
  // `wait` says so at once instead of timing out; the agent can ask again.
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(1);
  expect(ctx.errors.join("\n")).toContain("removed since");
  // `settle` posts no notice the server would contradict: it holds the decision answered.
  const posts = server.log.filter((c) => c === "POST /items").length;
  expect(await run(["settle", id], ctx)).toBe(0);
  expect(server.log.filter((c) => c === "POST /items").length).toBe(posts);
});

test("through the local agent, wait says too that a revoked device answered (#515)", async () => {
  const { ctx, id } = await revokedAnswer();
  const agent = makeAgent(ctx, { socket: join(ctx.store.dir, "agent.sock"), noQuota: true });
  await agent.start();
  try {
    const started = Date.now();
    expect(await run(["wait", id, "--timeout", "20s"], ctx)).toBe(1);
    expect(ctx.errors.join("\n")).toContain("removed since");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    await agent.stop();
  }
});

test("a poll that brings no answer drops a revoked device's undelivered one (#491)", async () => {
  const { ctx, id, cursor } = await revokedAnswer();
  await poll(ctx, session(ctx), { cursor, seconds: 0, shared: true });
  expect(ctx.store.state().answers[id]).toBeUndefined();
});

test("wait with no id returns each answer once, then times out with exit 2", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  await run(["ask", "--question", "Name the branch?"], ctx);
  const [first, second] = ctx.lines as [string, string];
  await server.answer(second, { text: "t/6-cli" });
  await server.answer(first, { choice: "Merge" });
  expect(await run(["wait"], ctx)).toBe(0);
  expect(await run(["wait"], ctx)).toBe(0);
  expect(ctx.lines.slice(2).sort()).toEqual(
    [
      `Answer to ${first} (Merge #12 now?): Merge`,
      `Answer to ${second} (Name the branch?): t/6-cli`,
    ].sort(),
  );
  expect(await run(["wait", "--timeout", "1s"], ctx)).toBe(2);
  expect(ctx.errors.at(-1)).toContain("No answer to any decision yet");
  // An answer already received prints again for its own id.
  expect(await run(["wait", first], ctx)).toBe(0);
});

test("quota push --once posts a sealed snapshot and survives bad providers", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  const providers = [
    "codex",
    "zai",
    "claude",
    "mistral",
    "signedout",
    "broken",
    "garbage",
    "nosuch",
  ];
  const args = providers.flatMap((p) => ["--provider", p]);
  expect(await run(["quota", "push", "--once", ...args], ctx)).toBe(0);
  const [snap] = await server.opened("quota");
  const by = new Map(snap?.providers.map((p) => [p.provider, p]));
  expect([...by.keys()]).toEqual(providers);
  expect(by.get("claude")?.windows.map((w) => w.id)).toEqual([
    "primary",
    "secondary",
    "claude-weekly-scoped-fable",
  ]);
  expect(by.get("mistral")?.windows.map((w) => w.label)).toEqual(["Included API", "Monthly Plan"]);
  expect(by.get("signedout")?.error).toBe("No available fetch strategy for signedout.");
  expect(by.get("broken")?.error).toContain("provider not configured");
  expect(by.get("garbage")?.error).toContain("unreadable output");
  expect(by.get("nosuch")?.error).toBe("missing from codexbar's output");
  expect(ctx.lines.at(-1)).toMatch(/^posted q_/);
});

test("quota push keeps going after a failed round", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  server.failures.push("/items");
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const done = run(["quota", "push", "--provider", "claude", "--interval", "1s"], ctx);
  await until(async () => (await server.opened("quota")).length === 1);
  controller.abort();
  expect(await done).toBe(0);
  expect(ctx.errors[0]).toContain("503");
  expect(ctx.errors[1]).toMatch(/posted q_.*1 providers, 3 windows/);
});

test("answers hands each session only its own answers, until it confirms them", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1"], ctx);
  ctx.env.CLAUDE_CODE_SESSION_ID = "s2";
  await run(["ask", "--question", "Name the branch?"], ctx);
  const [mine, theirs] = ctx.lines as [string, string];
  expect(ctx.store.state().asked[theirs]?.session).toBe("s2");
  ctx.lines.length = 0;

  // Nothing yet: one short poll, nothing printed.
  expect(await run(["answers", "--session", "s1", "--wait", "1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);

  await server.answer(theirs, { text: "multi\nline" });
  await server.answer(mine, { choice: "Wait" });
  expect(await run(["answers", "--session", "s1", "--wait", "5"], ctx)).toBe(0);
  const handed = { decisionId: mine, ack: mine, line: `Answer to ${mine} (Merge #12 now?): Wait` };
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([handed]);
  // Unconfirmed, it is handed over again; another session cannot confirm it.
  expect(await run(["answers", "--session", "s2", "--ack", mine], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[1] as string)).toEqual(handed);
  expect(await run(["answers", "--session", "s1", "--ack", mine], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(2);

  // s2's answer was stored by s1's poll; s2 takes it with no poll, only a read of the directory
  // to check the device still counts (#491).
  const polls = server.log.length;
  expect(await run(["answers", "--session", "s2"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[2] as string).line).toBe(
    `Answer to ${theirs} (Name the branch?): multi\nline`,
  );
  expect(server.log.slice(polls)).toEqual(["GET /directory"]);
  expect(await run(["answers", "--session", "s3"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(3);
});

test("answers exits 1 on a server error and keeps the cursor", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1"], ctx);
  server.failures.push("/answers");
  expect(await run(["answers", "--session", "s1", "--wait", "1"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("503");
  expect(ctx.store.state().cursor).toBeUndefined();
  expect(await run(["answers", "--session", "s1", "--wait", "30"], ctx)).toBe(1);
  expect(await run(["answers", "--wait", "1"], ctx)).toBe(1);
});

test("a lock left by a dead process is broken, and the command goes on", async () => {
  const ctx = await paired(server);
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(ctx.store.dir, ".lock"), `${dead} left-by-a-crash`);
  expect(await run(ASK, ctx)).toBe(0);
  expect(existsSync(join(ctx.store.dir, ".lock"))).toBe(false);
});
