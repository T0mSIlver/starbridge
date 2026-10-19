import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Answer,
  checkKeyFromLink,
  fromB64,
  open,
  type SealedItem,
  seal,
} from "@starbridge/protocol";
import { DEFAULT_LIMITS, LiveServer } from "@starbridge/server/test-support";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { makeAgent } from "../src/agent/main";
import { hookStop } from "../src/antigravity";
import { run } from "../src/cli";
import { session } from "../src/context";
import { DONE_LINE, poll, postDecision, typedBreaks } from "../src/decisions";
import { piAllow, piPermissionConfig } from "../src/pi";
import { configCommand, piChainStep } from "../src/settings";
import { agentAddress, approveAndConfirm, FAKE_CODEXBAR, paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

/** A line with its times as `HH:MM`, which the clock decides. */
const clock = (line: string | undefined) => line?.replace(/\d\d:\d\d/g, "HH:MM");

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
  // Windows keeps no POSIX modes; the config folder sits in the user's own profile.
  if (process.platform !== "win32") {
    expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
    for (const f of ["machine.json", "directory.json", "state.json"])
      expect(statSync(join(ctx.store.dir, f)).mode & 0o777).toBe(0o600);
  }
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

test("pair prints a link and a QR code that carry the code; the app that scans it checks the code (#795)", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", `${server.url}/`, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.includes("Or type the code")));
  const code = ctx.lines[0]?.replace("Pairing code: ", "") as string;
  const link = `${server.url}/pair#${code}`;
  expect(ctx.lines.at(-2)).toBe(`  No app? Open  ${link}`);
  // Only the QR carries the check key, in text no camera hands to an app.
  const scanned = scan(ctx.lines.slice(2, -2)) as string;
  const key = checkKeyFromLink(scanned) as string;
  expect(scanned).toBe(`starbridge-pair?server=${encodeURIComponent(server.url)}&k=${key}#${code}`);
  await server.approve(code, key);
  expect(await done).toBe(0);
  // Checked by the app: nothing to show or ask.
  expect(ctx.lines.some((l) => l.startsWith("Check code") || l.includes("Same code?"))).toBe(false);
});

test("pair saves nothing when the app that scanned the QR saw another add entry (#795)", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  // A proof under another key fails as one over another entry does.
  await server.approve(ctx.lines[0]?.slice(14) as string, "0123456789ABCDEF");
  expect(await done).toBe(1);
  expect(ctx.errors.at(-1)).toContain("saw another check code");
  expect(ctx.errors.at(-1)).toContain('revoke "devbox" under Devices');
  expect(ctx.store.machine()).toBeUndefined();
});

test("pair saves nothing when the owner says the codes differ (#795)", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", "devbox"], ctx);
  const check = await approveAndConfirm(server, ctx, false);
  expect(await done).toBe(1);
  expect(ctx.lines).toContain(`Check code: ${check}`);
  expect(ctx.errors.at(-1)).toContain("the codes differ, so this machine is not paired");
  expect(ctx.store.machine()).toBeUndefined();
});

test("pair --confirm answers only the check code it names (#795)", async () => {
  const ctx = testCtx();
  expect(await run(["pair", "--confirm"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("no `starbridge pair` is waiting");
  const done = run(["pair", "--server", server.url, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  const check = await server.approve(
    ctx.lines.find((l) => l.startsWith("Pairing code: "))?.slice(14) as string,
  );
  await until(() => ctx.lines.some((l) => l.includes("Same code?")));
  // An answer meant for another pairing on this machine.
  writeFileSync(join(ctx.store.dir, "pair-answer.AAAA-AAAA-AAAA-AAAA"), "yes");
  await Bun.sleep(1200);
  expect(ctx.store.machine()).toBeUndefined();
  expect(await run(["pair", "--confirm"], ctx)).toBe(0);
  expect(ctx.lines).toContain(`Confirmed check code ${check} for the waiting \`starbridge pair\`.`);
  expect(await done).toBe(0);
});

test("pair past the account's machine limit ends at once with the reason (#615)", async () => {
  server.stop();
  server = await LiveServer.start({ maxMachines: 1 });
  await paired(server);
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", "sixth"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  const code = ctx.lines[0]?.replace("Pairing code: ", "") as string;
  await expect(server.approve(code)).rejects.toThrow("machine-cap");
  expect(await done).toBe(1);
  expect(ctx.errors.join("\n")).toContain(
    "maximum number of machines (phones and browsers don't count): revoke one",
  );
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

test("the last poll waits no longer than the code has left, and a swept pairing reads as expired (#623)", async () => {
  const real = globalThis.fetch;
  const polls: string[] = [];
  const start = Date.now();
  let posted = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/pairings")) {
      posted = true;
      return new Response(null, { status: 201 });
    }
    polls.push(String(url));
    return Response.json(
      { error: "not-found", detail: "no such pairing, or it expired" },
      { status: 404 },
    );
  }) as unknown as typeof fetch;
  try {
    const ctx = testCtx();
    // Half a second of the 10 minutes is left once the pairing is stored.
    ctx.now = () => new Date(posted ? start + 599_500 : start);
    expect(await run(["pair", "--server", "https://self.example"], ctx)).toBe(1);
    expect(polls.map((u) => new URL(u).searchParams.get("wait"))).toEqual(["1"]);
    expect(ctx.errors.at(-1)).toBe(
      "starbridge: the pairing code expired; run `starbridge pair` again",
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("pair --force names the old pairing as Devices shows it, not by its id (#287)", async () => {
  const ctx = await paired(server);
  const done = run(["pair", "--force"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  await approveAndConfirm(server, ctx);
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

test("a cloud session asks and waits as the machine STARBRIDGE_MACHINE carries, until it is revoked (#1818)", async () => {
  const owner = await paired(server, "Cloud sessions");
  expect(await run(["machine", "export"], owner)).toBe(0);
  const [line] = owner.lines;
  expect(owner.errors.at(-1)).toContain("private keys");
  const id = owner.store.machine()?.id;

  for (const name of ["first", "second"]) {
    const cloud = testCtx({ STARBRIDGE_MACHINE: line as string });
    expect(await run([...ASK, "--session", name], cloud)).toBe(0);
    const asked = cloud.lines.at(-1) as string;
    expect(cloud.store.machine()?.id).toBe(id);
    expect((await server.opened("decision")).at(-1)?.source).toMatchObject({
      machine: "Cloud sessions",
      machineKind: "cloud",
      session: name,
    });
    await server.answer(asked, { choice: "Wait" });
    cloud.lines.length = 0;
    expect(await run(["wait", asked, "--timeout", "5s"], cloud)).toBe(0);
    expect(cloud.lines).toEqual([`Answer to ${asked} (Merge #12 now?): Wait`]);
  }

  await server.revoke(id as string);
  const late = testCtx({ STARBRIDGE_MACHINE: line as string });
  expect(await run(ASK, late)).toBe(1);
  expect(late.errors.at(-1)).toBe(
    "starbridge: this machine was removed from your Starbridge account: run `starbridge machine export` on a paired machine, then replace STARBRIDGE_MACHINE with its line",
  );
});

test("a folder that holds a machine keeps it over STARBRIDGE_MACHINE, and a bad one stops commands (#1818)", async () => {
  const one = await paired(server, "one");
  const two = await paired(server, "two");
  expect(await run(["machine", "export"], two)).toBe(0);
  one.env.STARBRIDGE_MACHINE = two.lines[0] as string;
  expect(await run(ASK, one)).toBe(0);
  expect(one.store.machine()?.name).toBe("one");
  // Revoked, the folder's machine is paired again with `pair --force`, not exported (#1838).
  await server.revoke(one.store.machine()?.id as string);
  expect(await run(ASK, one)).toBe(1);
  expect(one.errors.at(-1)).toContain("`starbridge pair --force`");

  const bad = testCtx({ STARBRIDGE_MACHINE: `sbm1.${"A".repeat(40)}` });
  expect(await run(ASK, bad)).toBe(1);
  expect(bad.errors.at(-1)).toStartWith("starbridge: STARBRIDGE_MACHINE is not a line");
  expect(bad.store.machine()).toBeUndefined();
  expect(await run(["--version"], bad)).toBe(0);
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
  // Outside an agent's session, such as from a script, --session names any session (#1748).
  delete ctx.env.CLAUDE_CODE_SESSION_ID;
  expect(await run([...ASK, "--session", "s2"], ctx)).toBe(0);
  ctx.env.CLAUDE_CODE_SESSION_ID = "s1";
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

test("ask asks as its own session when --session names another, and keeps the asking subagent (#1702, #1748)", async () => {
  const ctx = await paired(server);
  const dir = mkdtempSync(join(tmpdir(), "starbridge-claude-"));
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: 1, sessionId: "s2" }));
  Object.assign(ctx.env, {
    CLAUDECODE: "1",
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CODE_SESSION_ID: "s1",
    STARBRIDGE_CLAUDE_AGENT: "a1fdba894e743a195",
  });
  const warned = () => ctx.errors.filter((l) => l.startsWith("starbridge: --session"));

  // A made-up id, or another session of this machine's: the answer comes back here.
  expect(await run([...ASK, "--session", "sb-1697"], ctx)).toBe(0);
  const madeUp = ctx.lines.at(-1) as string;
  expect(await run([...ASK, "--session", "s2"], ctx)).toBe(0);
  const other = ctx.lines.at(-1) as string;
  expect(warned()).toEqual([
    "starbridge: --session sb-1697 names no Claude Code session on this machine, so it asks as this session (s1).",
    "starbridge: --session s2 is not this session, and an answer goes only to the session that asked, so it asks as this session (s1).",
  ]);
  ctx.errors.length = 0;
  // Its own id, which a subagent's parent shares: no warning.
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const own = ctx.lines.at(-1) as string;
  expect(warned()).toEqual([]);
  // Only the mod names a subagent, so the answer comes back.
  expect(ctx.errors).toContain("The answer will come back into this session as a new prompt.");

  const asked = ctx.store.state().asked;
  for (const id of [own, other, madeUp]) {
    expect(asked[id]?.session).toBe("s1");
    expect(asked[id]?.subagent).toBe("a1fdba894e743a195");
  }
  const sources = (await server.opened("decision")).map((d) => d.source.session);
  expect(sources).toEqual(["s1", "s1", "s1"]);

  await server.answer(own, { choice: "Merge" });
  await poll(ctx, session(ctx), { seconds: 0, shared: true });
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([
    {
      decisionId: own,
      ack: own,
      line: `Answer to ${own} (Merge #12 now?): Merge`,
      question: "Merge #12 now?",
      waiting: false,
      subagent: "a1fdba894e743a195",
    },
  ]);
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

test("a decision's image is stored once whatever the devices, and a re-seal keeps it (#685)", async () => {
  const ctx = await paired(server);
  const shot = noisyPng(1080, 2400);
  expect(await run([...ASK, "--image", shot], ctx)).toBe(0);
  const one = server.decisionBytes();
  const laptop = await server.addDevice("laptop");
  const tablet = await server.addDevice("tablet");
  await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 0, shared: true });
  const three = server.decisionBytes();
  // Two more boxes of text, not two more copies of the picture.
  expect(three - one).toBeLessThan(10_000);
  const [img] = (await server.images())[0] ?? [];
  for (const by of [laptop, tablet]) expect((await server.images(by))[0]?.[0]).toEqual(img);
}, 30_000);

test("a decision with four images and a long context still reaches devices that join (#720)", async () => {
  server.stop();
  // Forty devices sign in within the minute.
  const fast: [number, number] = [100, 60_000];
  server = await LiveServer.start({
    limits: {
      ...DEFAULT_LIMITS,
      challenges: fast,
      ownerSignIns: fast,
      directoryAppends: fast,
      pairingPosts: fast,
      pairingReads: fast,
      pairingResults: fast,
    },
  });
  const ctx = await paired(server);
  const images = [1, 2, 3, 4].flatMap(() => ["--image", noisyPng(2400, 1500)]);
  const context = "Why: ".padEnd(8000, "x");
  expect(await run([...ASK.slice(0, 3), "--context", context, ...images], ctx)).toBe(0);
  const added = [];
  // Each new device adds an 11 KB box; the images alone had nearly filled the item for one.
  for (let i = 0; i < 40; i++) added.push(await server.addDevice(`device${i}`));
  await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 0, shared: true });
  expect(ctx.errors.filter((e) => /re-send|too large/.test(e))).toEqual([]);
  for (const by of added) expect((await server.images(by))[0]).toHaveLength(4);
}, 60_000);

test("ask turns a sideways phone photo upright", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--image", sidewaysJpeg()], ctx)).toBe(0);
  const [img] = (await server.images())[0] ?? [];
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
  // What to do when the page answers comes only to the agent that built one (#1063).
  expect(ctx.errors.at(-1)).toContain(`run \`starbridge settle ${id}\`, then act`);
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

test("every command names the card's question, and a closed card says how and when it closed (#1697)", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  const card = `${id} (Merge #12 now?)`;
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(clock(ctx.errors.at(-1))).toBe(`Marked ${card} waiting.`);
  expect(await run(["working", id], ctx)).toBe(0);
  expect(clock(ctx.errors.at(-1))).toBe(`Marked ${card} working.`);
  expect(await run(["wait", id, "--timeout", "1s"], ctx)).toBe(2);
  expect(clock(ctx.errors.at(-1))).toBe(`No answer to ${card} yet.`);

  expect(await run(["settle", id, "--reason", "Merged it by hand"], ctx)).toBe(0);
  expect(clock(ctx.errors.at(-1))).toBe(`Settled ${card}: withdrawn at HH:MM: Merged it by hand`);
  // A second settle, wait, waiting and working all say how it closed.
  const closed = `${card} was already withdrawn at HH:MM: Merged it by hand`;
  expect(await run(["settle", id, "--reason", "Again"], ctx)).toBe(0);
  expect(clock(ctx.errors.at(-1))).toBe(`starbridge: ${closed}`);
  expect(await run(["waiting", id], ctx)).toBe(1);
  expect(clock(ctx.errors.at(-1))).toBe(`starbridge: ${closed}`);
  expect(await run(["wait", id, "--timeout", "1s"], ctx)).toBe(1);
  expect(clock(ctx.errors.at(-1))).toBe(
    `starbridge: ${card} was withdrawn at HH:MM: Merged it by hand: no answer will come`,
  );

  // An answer the session has not taken: `answers` lists the question beside the id.
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const second = ctx.lines.at(-1) as string;
  await server.answer(second, { choice: "Wait" });
  await poll(ctx, session(ctx), { seconds: 0, shared: true });
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[0] as string)).toMatchObject({
    decisionId: second,
    question: "Merge #12 now?",
  });
  expect(await run(["wait", second, "--timeout", "5s"], ctx)).toBe(0);
  expect(await run(["working", second], ctx)).toBe(1);
  expect(clock(ctx.errors.at(-1))).toBe(
    `starbridge: ${second} (Merge #12 now?) was already answered at HH:MM: Wait`,
  );
});

test("settle --session and --all close a flood at the server's pace (#584)", async () => {
  server.stop();
  // Two posts per half second: the settles meet 429s and wait them out.
  server = await LiveServer.start({ limits: { ...DEFAULT_LIMITS, machineItems: [2, 500] } });
  const ctx = await paired(server);
  const ids: Record<string, string[]> = { s1: [], s2: [] };
  for (const [s, n] of [
    ["s1", 4],
    ["s2", 2],
  ] as const)
    for (let i = 0; i < n; i++) {
      for (;;) {
        if ((await run([...ASK, "--session", s], ctx)) === 0) break;
        await Bun.sleep(100);
      }
      ids[s]?.push(ctx.lines.at(-1) as string);
    }
  const [answered, ...rest] = ids.s1 as string[];
  await server.answer(answered as string, { choice: "Merge" });
  expect(await run(["wait", answered as string, "--timeout", "10s"], ctx)).toBe(0);

  let slept = 0;
  const sleep = ctx.sleep;
  ctx.sleep = (ms) => {
    slept++;
    return sleep(ms);
  };
  expect(await run(["settle", "--session", "s1", "--outcome", "withdrawn"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe("Settled 3 decisions.");
  expect(slept).toBeGreaterThan(0);
  const open = async () =>
    (await server.listed("decision")).filter((d) => !d.answeredAt).map((d) => d.item.id);
  expect((await open()).sort()).toEqual([...(ids.s2 as string[])].sort());
  for (const id of rest) expect(ctx.store.state().asked[id]?.settled).toBe(true);

  // Without a terminal, --all is refused, --yes or not (#1761).
  expect(await run(["settle", "--all"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("needs a terminal");
  expect(await run(["settle", "--all", "--yes"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("needs a terminal");
  expect(await open()).toHaveLength(2);
  ctx.interactive = true;
  expect(await run(["settle", "--all", "--session", "s2"], ctx)).toBe(1);
  expect(await run(["settle", "--all", "--yes"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe("Settled 2 decisions.");
  expect(await open()).toEqual([]);
  expect(await run(["settle", "--all", "--yes"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe("No open decision this machine asked.");
  // A settle whose notice never reached the server is posted again.
  const failed = ids.s2?.[0] as string;
  ctx.store.updateState((st) => {
    (st.asked[failed] as { unposted?: boolean }).unposted = true;
  });
  expect(await run(["settle", "--all", "--yes"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe("Settled 1 decision.");
  expect(ctx.store.state().asked[failed]?.unposted).toBeUndefined();
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

test("a withdrawal says why in one short line, which the settled notice carries (#1008)", async () => {
  const ctx = await paired(server);
  expect(await run(ASK, ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  expect(await run(["settle", id], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--reason '");
  expect(await run(["settle", id, "--reason", "x".repeat(121)], ctx)).toBe(1);
  expect(await run(["settle", id, "--reason", "Fixed\nit"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("one line of at most 120 characters");
  expect(await run(["settle", id, "--outcome", "elsewhere", "--reason", "Fixed it"], ctx)).toBe(1);
  expect(await server.opened("settled")).toEqual([]);
  const reason = "Fixed it myself after rereading the logs";
  expect(await run(["settle", id, "--outcome", "withdrawn", "--reason", reason], ctx)).toBe(0);
  expect(await server.opened("settled")).toMatchObject([
    { itemId: id, outcome: "withdrawn", reason },
  ]);
});

test("settle leaves a decision whose answer reached the agent answered, not withdrawn", async () => {
  const ctx = await paired(server);
  expect(await run(ASK, ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { choice: "Merge" });
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(0);
  expect(await run(["settle", id, "--reason", "No longer needed"], ctx)).toBe(0);
  expect((await server.opened("settled")).map((n) => n.outcome)).toEqual(["device"]);
});

test("settle after an answer its session has not taken prints it, and withdraws nothing (#1575)", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { text: "Make it dreamier" });
  // Accepted, and held for the end of the turn that now settles it.
  await poll(ctx, session(ctx), { seconds: 0, shared: true });
  ctx.lines.length = 0;
  expect(await run(["settle", id, "--reason", "Reposted as a review"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([`Answer to ${id} (Merge #12 now?): Make it dreamier`]);
  expect(ctx.errors.at(-1)).toMatch(
    /already answered at \d\d:\d\d: Make it dreamier; it stays answered/,
  );
  expect((await server.opened("settled")).map((n) => n.outcome)).not.toContain("withdrawn");
  // Handed over once: the session's loop gets nothing more.
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
});

test("answers --all lists an answer whose decision was settled since (#1575)", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { text: "Make it dreamier" });
  await poll(ctx, session(ctx), { seconds: 0, shared: true });
  // As a settle before #1575 left it.
  ctx.store.updateState((st) => {
    (st.asked[id] as { settled?: boolean }).settled = true;
  });
  ctx.lines.length = 0;
  expect(await run(["answers", "--all"], ctx)).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l))).toMatchObject([
    { decisionId: id, text: "Make it dreamier", session: "s1" },
  ]);
});

test("ask refuses a decision that would not stand alone", async () => {
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "Q?", "--option", "Only"], ctx)).toBe(1);
  expect(await run([...ASK, "--recommended", "Neither"], ctx)).toBe(1);
  expect(await run(["ask", "--option", "A", "--option", "B"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--question");
  expect(await server.opened("decision")).toEqual([]);
});

test("ask names the flag that is too long and its limit, as the help lists them (#1920)", async () => {
  const ctx = await paired(server);
  const x = (n: number) => "x".repeat(n);
  for (const [args, line] of [
    [["--question", x(301), "--option", "a", "--option", "b"], "--question takes at most 300"],
    [["--question", "Q?", "--option", x(101), "--option", "b"], "--option takes at most 100"],
    [
      ["--question", "Q?", "--option", "a", "--option", "b", "--context", x(8001)],
      "--context takes at most 8000",
    ],
  ] as const) {
    expect(await run(["ask", ...args], ctx)).toBe(1);
    expect(ctx.errors.at(-1)).toBe(`starbridge: ${line} characters`);
  }
  expect(await server.opened("decision")).toEqual([]);
  expect(await run(["--help"], ctx)).toBe(0);
  expect(ctx.lines.join("\n")).toContain(
    "The question takes at most\n      300 characters, each option 100 and the context 8000.",
  );
  // pair says the same of --name, before it reaches the server.
  const fresh = testCtx();
  expect(await run(["pair", "--server", server.url, "--name", x(101)], fresh)).toBe(1);
  expect(fresh.errors.at(-1)).toBe("starbridge: --name takes at most 100 characters");
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
  expect(ctx.errors.at(-1)).toMatch(
    /d_\S+ \(Merge #12 now\?\) was already answered at \d\d:\d\d: Merge/,
  );
});

for (const via of ["the CLI", "the local agent"])
  test(`through ${via}, waiting on an answer not yet handed over prints it, once (#1484)`, async () => {
    const ctx = await paired(server);
    const agent =
      via === "the local agent"
        ? makeAgent(ctx, { socket: agentAddress(ctx.store.dir), noQuota: true })
        : undefined;
    await agent?.start();
    try {
      await run([...ASK, "--session", "s1"], ctx);
      const id = ctx.lines.at(-1) as string;
      await server.answer(id, { choice: "Merge" });
      await until(async () => {
        ctx.lines.length = 0;
        await run(["answers", "--session", "s1", "--wait", "1"], ctx);
        return ctx.lines.length > 0;
      });
      expect(await run(["waiting", id], ctx)).toBe(0);
      expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
      ctx.lines.length = 0;
      expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
      expect(ctx.lines).toEqual([]);
      expect(await run(["waiting", id], ctx)).toBe(1);
    } finally {
      await agent?.stop();
    }
  });

test("waiting says when the owner snoozed the question, and wait says it once with exit 3", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  const until = new Date();
  until.setDate(until.getDate() + 1);
  until.setHours(18, 0, 0, 0);
  // Without the agent, `waiting` reads the snooze itself.
  await server.snooze(id, until);
  const line = `Snoozed ${id} (Merge #12 now?) until tomorrow 18:00: no answer before then.`;
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe(line);
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(3);
  expect(ctx.lines.at(-1)).toBe(line);
  // Told once: the next wait waits on, and an answer still comes.
  const next = run(["wait", id, "--timeout", "20s"], ctx);
  await server.answer(id, { choice: "Merge" });
  expect(await next).toBe(0);
  expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
});

test("through the local agent, waiting and wait say the snooze too, and --json prints its time", async () => {
  const ctx = await paired(server);
  const agent = makeAgent(ctx, { socket: agentAddress(ctx.store.dir), noQuota: true });
  await agent.start();
  try {
    await run(ASK, ctx);
    const id = ctx.lines.at(-1) as string;
    const back = new Date();
    back.setDate(back.getDate() + 1);
    back.setHours(18, 0, 0, 0);
    await server.snooze(id, back);
    await until(() => !!ctx.store.state().asked[id]?.snooze);
    expect(await run(["waiting", id], ctx)).toBe(0);
    expect(ctx.lines.at(-1)).toBe(
      `Snoozed ${id} (Merge #12 now?) until tomorrow 18:00: no answer before then.`,
    );
    expect(await run(["wait", id, "--json", "--timeout", "5s"], ctx)).toBe(3);
    expect(JSON.parse(ctx.lines.at(-1) as string)).toEqual({
      decisionId: id,
      snoozedUntil: back.toISOString(),
    });
    expect(await run(["wait", id, "--timeout", "2s"], ctx)).toBe(2);
  } finally {
    await agent.stop();
  }
});

test("a snooze waiting read is not told by wait once the owner answered since", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  await server.snooze(id, new Date(Date.now() + 3_600_000));
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toStartWith(`Snoozed ${id}`);
  await server.answer(id, { choice: "Merge" });
  expect(await run(["wait", id, "--timeout", "10s"], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
});

test("back now from a device whose clock runs ahead says nothing either", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  const ahead = new Date(Date.now() + 4 * 60_000);
  await server.snooze(id, ahead, ahead);
  expect(await run(["waiting", id], ctx)).toBe(0);
  expect(ctx.lines.at(-1)).toBe(id);
  expect(await run(["wait", id, "--timeout", "2s"], ctx)).toBe(2);
});

test("back now: a snooze already over says nothing", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  await server.snooze(id, new Date(Date.now() - 1000));
  await poll(ctx, session(ctx), {
    cursor: ctx.store.state().asked[id]?.cursor,
    seconds: 0,
    shared: false,
  });
  expect(await run(["wait", id, "--timeout", "2s"], ctx)).toBe(2);
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
  ]);
});

test("an Antigravity conversation asks under its id and title, and is told to wait", async () => {
  const ctx = await paired(server);
  const home = mkdtempSync(join(tmpdir(), "starbridge-agy-"));
  const notes = join(home, ".gemini", "antigravity-cli", "annotations");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "c-1.pbtxt"), 'title:"Fix the \\"build\\""');
  ctx.env = { HOME: home, ANTIGRAVITY_CONVERSATION_ID: "c-1" };
  await run(ASK, ctx);
  expect(ctx.errors.at(-1)).toContain("run `starbridge wait");
  // Started from a Claude Code session, it still asks as itself; a `claude -p` it starts, or a
  // `codex exec` review, asks as that agent.
  ctx.env = { HOME: home, ANTIGRAVITY_CONVERSATION_ID: "c-1", CLAUDECODE: "1" };
  await run(ASK, ctx);
  ctx.env.CLAUDE_CODE_SESSION_ATTENDED = "0";
  await run(ASK, ctx);
  ctx.env = { HOME: home, ANTIGRAVITY_CONVERSATION_ID: "c-1", CODEX_THREAD_ID: "t1" };
  await run(ASK, ctx);
  const opened = await server.opened("decision");
  expect(opened.map((d) => d.agent)).toEqual([
    "antigravity",
    "antigravity",
    "claude-code",
    "codex",
  ]);
  expect([opened[0]?.source.session, opened[0]?.source.sessionTitle]).toEqual([
    "c-1",
    'Fix the "build"',
  ]);
});

test("a Cursor agent's command asks as Cursor, in its conversation, and is told to wait (#955)", async () => {
  const ctx = await paired(server);
  ctx.env = { ...ctx.env, CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "c-1" };
  await run(ASK, ctx);
  expect(ctx.errors.at(-1)).toContain("run `starbridge wait");
  // The IDE gives its agent's commands no conversation id.
  delete ctx.env.CURSOR_CONVERSATION_ID;
  await run(ASK, ctx);
  expect((await server.opened("decision")).map((d) => [d.agent, d.source.session])).toEqual([
    ["cursor", "c-1"],
    ["cursor", ""],
  ]);
});

test("Antigravity's Stop hook holds a waiting turn for its answer and hands it over once (#961)", async () => {
  const ctx = await paired(server);
  ctx.env = { ANTIGRAVITY_CONVERSATION_ID: "c-1" };
  expect(await run([...ASK, "--waiting"], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  const stop = async (conversationId: string) => {
    ctx.lines.length = 0;
    expect(await hookStop(ctx, JSON.stringify({ conversationId }), { agent: "antigravity" })).toBe(
      0,
    );
    return ctx.lines;
  };
  // Another conversation waits on nothing: its turn ends at once.
  expect(await stop("c-2")).toEqual([]);
  setTimeout(() => void server.answer(id, { choice: "Merge" }), 300);
  expect((await stop("c-1")).map((l) => JSON.parse(l))).toEqual([
    { decision: "continue", reason: `Answer to ${id} (Merge #12 now?): Merge` },
  ]);
  expect(await stop("c-1")).toEqual([]);
});

test("an answer the Stop hook could not print is handed over by the next one (#1287)", async () => {
  const ctx = await paired(server);
  ctx.env = { ANTIGRAVITY_CONVERSATION_ID: "c-1" };
  expect(await run(ASK, ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  await server.answer(id, { choice: "Merge" });
  await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
  const input = JSON.stringify({ conversationId: "c-1" });
  // Antigravity closed the hook's stdout.
  const out = ctx.out;
  ctx.out = () => {
    throw new Error("write EPIPE");
  };
  expect(await hookStop(ctx, input, { agent: "antigravity" })).toBe(0);
  ctx.out = out;
  ctx.lines.length = 0;
  expect(await hookStop(ctx, input, { agent: "antigravity" })).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([
    { decision: "continue", reason: `Answer to ${id} (Merge #12 now?): Merge` },
  ]);
});

test("config turns permission prompts on and off", async () => {
  const ctx = await paired(server);
  expect(await run(["config"], ctx)).toBe(0);
  expect(ctx.lines.at(-5)).toBe("permissions   off");
  expect(await run(["config", "permissions", "on"], ctx)).toBe(0);
  expect(ctx.lines.at(-5)).toBe("permissions   on");
  expect(await run(["config", "permissions", "maybe"], ctx)).toBe(1);
});

test("permissions on names the Starbridge link in pi-permission-system's chain", async () => {
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

  // With a terminal, the yes to permission prompts names it, with no question of its own (#2130).
  piChainStep(ctx, true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    permission: { bash: "ask" },
    authorizerChain: ["judge", "starbridge"],
  });
  // Named already: nothing to say.
  const before = ctx.lines.length;
  piChainStep(ctx, true);
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

test("ask --wait prints a typed reply to a question with options", async () => {
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
  const page = "https://claude.ai/artifact/2ig2MyNRD484b7oZea5vkZ";
  await run(["ask", "--question", "Pick?", "--answer-in", page, "--session", "s"], ctx);
  const pointer = ctx.lines.at(-1) as string;
  await run([...ASK, "--session", "s"], ctx);
  const open = ctx.lines.at(-1) as string;
  await run(["settle", late, "--reason", "No longer needed"], ctx);
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
  expect(await run(["wait", late, "--timeout", "1s"], ctx)).toBe(1);
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
  await run(["settle", ctx.lines.at(-1) as string, "--reason", "No longer needed"], ctx);
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

test("a re-seal the server finds too large is not sent again (#720)", async () => {
  server.stop();
  // Room for the decision's box for one device, not for two.
  server = await LiveServer.start({ limits: { ...DEFAULT_LIMITS, itemBytes: 15_000 } });
  const ctx = await paired(server);
  const context = "Why: ".padEnd(8000, "x");
  expect(await run(["ask", "--question", "Q?", "--context", context, "--session", "s"], ctx)).toBe(
    0,
  );
  await server.addDevice("laptop");
  const s = session(ctx);
  let posts = 0;
  const postItem = s.api.postItem.bind(s.api);
  s.api.postItem = (item) => {
    posts++;
    return postItem(item);
  };
  const again = () => poll(ctx, s, { cursor: ctx.store.state().cursor, seconds: 0, shared: true });
  await again();
  await again();
  expect(posts).toBe(1);
  expect(ctx.errors.filter((e) => e.includes("too large"))).toHaveLength(1);
});

test("re-sealing stops at a 429 and waits its Retry-After, leaving the window to asks (#650)", async () => {
  server.stop();
  // Three items a minute: two asks and the first re-sealed copy fill it.
  server = await LiveServer.start({
    limits: { ...DEFAULT_LIMITS, machineItems: [3, 60_000] },
  });
  const ctx = await paired(server);
  for (const q of ["First?", "Second?"])
    expect(await run(["ask", "--question", q, "--session", "s"], ctx)).toBe(0);
  await server.addDevice("laptop");
  const s = session(ctx);
  let posts = 0;
  const postItem = s.api.postItem.bind(s.api);
  s.api.postItem = (item) => {
    posts++;
    return postItem(item);
  };
  const again = () => poll(ctx, s, { cursor: ctx.store.state().cursor, seconds: 0, shared: true });
  await again();
  // The second copy got the 429: no third try, no error shown.
  expect(posts).toBe(2);
  expect(ctx.errors.filter((e) => e.includes("re-send"))).toEqual([]);
  await again();
  expect(posts).toBe(2);
  // Past the Retry-After, the next poll sends the rest.
  const later = Date.now() + 61_000;
  ctx.now = () => new Date(later);
  await again();
  expect(posts).toBe(3);
});

test("SIGTERM ends an ask whose post the server never answers (#1288)", async () => {
  const ctx = await paired(server);
  server.stalls.push("POST /items");
  const stop = new AbortController();
  const asked = run([...ASK, "--session", "s"], { ...ctx, signal: stop.signal });
  await until(() => server.log.includes("POST /items"));
  stop.abort();
  // Ctrl-C exits 130, as CONTRACT.md says.
  expect(await Promise.race([asked, Bun.sleep(5000).then(() => "still running")])).toBe(130);
});

test("a decision whose post lost its reply is withdrawn, so its card does not stay on the devices (#1289)", async () => {
  const ctx = await paired(server);
  server.lostReplies.push("POST /items");
  const stop = new AbortController();
  const asked = run([...ASK, "--session", "s"], { ...ctx, signal: stop.signal });
  await until(async () => (await server.opened("decision")).length === 1);
  stop.abort();
  const ended = await Promise.race([
    asked.then(
      () => true,
      () => true,
    ),
    Bun.sleep(5000).then(() => false),
  ]);
  expect(ended).toBe(true);
  const [decision] = await server.opened("decision");
  await until(async () => (await server.opened("settled")).length === 1);
  expect(await server.opened("settled")).toMatchObject([
    { itemId: decision?.id, outcome: "withdrawn" },
  ]);
});

test("a waiting flip within the same second as the last one carries a later time (#1982)", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--session", "s"], ctx)).toBe(0);
  const id = ctx.lines.at(-1) as string;
  const at = new Date("2026-10-18T10:00:00.200Z");
  ctx.now = () => at;
  const last = async () => (await server.opened("waiting")).find((w) => w.decisionId === id);
  expect(await run(["waiting", id], ctx)).toBe(0);
  const first = await last();
  expect(await run(["working", id], ctx)).toBe(0);
  const second = await last();
  expect(second?.state).toBe("working");
  // Devices keep the update with the latest `at`: an equal one would leave them on `waiting`.
  expect(Date.parse(second?.at ?? "")).toBeGreaterThan(Date.parse(first?.at ?? ""));
});

test("an answer the agent reads before the question's post replies still counts (#1975)", async () => {
  const ctx = await paired(server);
  const s = session(ctx);
  const postItem = s.api.postItem.bind(s.api);
  // The server stores the question; before its reply comes back, the owner answers and the
  // agent's poll reads that answer.
  s.api.postItem = async (item, signal) => {
    await postItem(item, signal);
    if (item.kind !== "decision") return;
    await server.answer(item.id, { choice: "Merge" });
    const st = ctx.store.state();
    await poll(ctx, session(ctx), { cursor: st.cursor, seconds: 0, shared: true });
  };
  const decision = await postDecision(ctx, s, {
    question: "Merge #12 now?",
    options: ["Merge", "Wait"],
    session: "s",
  });
  expect(ctx.store.state().answers[decision.id]?.answer.choice).toBe("Merge");
});

test("a question settled while its post is in flight is settled once the server holds it (#1975)", async () => {
  const ctx = await paired(server);
  const s = session(ctx);
  const postItem = s.api.postItem.bind(s.api);
  s.api.postItem = async (item, signal) => {
    // The session's questions are settled before the server stores this one.
    if (item.kind === "decision")
      expect(await run(["settle", "--session", "s", "--outcome", "elsewhere"], ctx)).toBe(0);
    await postItem(item, signal);
  };
  const decision = await postDecision(ctx, s, {
    question: "Merge #12 now?",
    options: ["Merge", "Wait"],
    session: "s",
  });
  const notices = (await server.opened("settled")).filter((n) => n.itemId === decision.id);
  expect(notices.length).toBeGreaterThan(0);
  // The server now holds it closed: a device's answer is refused.
  await expect(server.answer(decision.id, { choice: "Merge" })).rejects.toThrow();
});

test("a question settled while its post is in flight keeps that outcome when the reply is lost (#1975)", async () => {
  const ctx = await paired(server);
  const s = session(ctx);
  const postItem = s.api.postItem.bind(s.api);
  s.api.postItem = async (item, signal) => {
    if (item.kind !== "decision") return postItem(item, signal);
    expect(await run(["settle", "--session", "s", "--outcome", "elsewhere"], ctx)).toBe(0);
    await postItem(item, signal);
    throw new TypeError("fetch failed");
  };
  await expect(
    postDecision(ctx, s, { question: "Merge #12 now?", options: ["Merge", "Wait"], session: "s" }),
  ).rejects.toThrow();
  const notices = await server.opened("settled");
  expect(notices.length).toBeGreaterThan(0);
  expect(notices.map((n) => n.outcome)).toEqual(notices.map(() => "elsewhere"));
});

test("a question the server refused leaves nothing asked (#1975)", async () => {
  server.stop();
  server = await LiveServer.start({ limits: { ...DEFAULT_LIMITS, storedBytes: 1 } });
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "First?", "--session", "s"], ctx)).not.toBe(0);
  expect(ctx.store.state().asked).toEqual({});
});

test("ask on a full account says so in plain words (#586)", async () => {
  server.stop();
  server = await LiveServer.start({ limits: { ...DEFAULT_LIMITS, storedBytes: 1 } });
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "First?", "--session", "s"], ctx)).not.toBe(0);
  expect(ctx.errors.join("\n")).toContain("your Starbridge account is full");
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
  expect(await run(["settle", id, "--reason", "No longer needed"], ctx)).toBe(0);
  expect(server.log.filter((c) => c === "POST /items").length).toBe(posts);
  // Nor does it claim an answer it holds none of (#1575).
  expect(ctx.errors.at(-1)).not.toContain("answered first");
});

test("through the local agent, wait says too that a revoked device answered (#515)", async () => {
  const { ctx, id } = await revokedAnswer();
  const agent = makeAgent(ctx, { socket: agentAddress(ctx.store.dir), noQuota: true });
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

/** Posts a laptop's answer to decision `id` as the laptop, its routing hint `re` if given. */
async function laptopAnswer(
  ctx: Awaited<ReturnType<typeof paired>>,
  laptop: Awaited<ReturnType<LiveServer["addDevice"]>>,
  id: string,
  re?: string,
) {
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
    body: JSON.stringify(re ? { ...sealed, re } : sealed),
  });
  expect(posted.status).toBe(201);
}

test("an answer from a device revoked before the machine fetched it closes the decision, so wait fails at once (#1301)", async () => {
  const ctx = await paired(server);
  const laptop = await server.addDevice("laptop");
  await run([...ASK, "--session", "s"], ctx);
  const id = ctx.lines.at(-1) as string;
  await laptopAnswer(ctx, laptop, id);
  await server.revoke("laptop");
  expect(await run(["wait", id, "--timeout", "5s"], ctx)).toBe(1);
  expect(ctx.errors.join("\n")).toContain("removed since");
  expect(ctx.store.state().asked[id]).toMatchObject({ settled: true, revoked: true });
  ctx.lines.length = 0;
  expect(await run(["decisions", "--open"], ctx)).toBe(0);
  expect(ctx.lines.join("")).not.toContain(id);
});

test("a revoked device's answer whose routing hint names another decision closes neither (#1301)", async () => {
  const ctx = await paired(server);
  const laptop = await server.addDevice("laptop");
  await run([...ASK, "--session", "s"], ctx);
  await run(["ask", "--question", "Name the branch?", "--session", "s"], ctx);
  const [first, second] = ctx.lines.slice(-2) as [string, string];
  // The hint is not signed: only the body says which decision a device answered.
  await laptopAnswer(ctx, laptop, second, first);
  await server.revoke("laptop");
  expect(await run(["wait", first, "--timeout", "1s"], ctx)).toBe(2);
  expect(ctx.store.state().asked[first]?.settled).toBeUndefined();
  expect(ctx.store.state().asked[second]?.settled).toBeUndefined();
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
  const handed = {
    decisionId: mine,
    ack: mine,
    line: `Answer to ${mine} (Merge #12 now?): Wait`,
    question: "Merge #12 now?",
    waiting: false,
  };
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([handed]);
  // Unconfirmed, it is handed over again; another session cannot confirm it.
  expect(await run(["answers", "--session", "s2", "--ack", mine], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[1] as string)).toEqual({ acked: [] });
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[2] as string)).toEqual(handed);
  expect(await run(["answers", "--session", "s1", "--ack", mine], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[3] as string)).toEqual({ acked: [mine] });
  // Confirmed: handed over no more, and a second confirm confirms nothing (#1484).
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1", "--ack", mine], ctx)).toBe(0);
  expect(ctx.lines.slice(4).map((l) => JSON.parse(l))).toEqual([{ acked: [] }]);

  // s2's answer was stored by s1's poll; s2 takes it with no poll, only a read of the directory
  // to check the device still counts (#491).
  const polls = server.log.length;
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s2"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[0] as string).line).toBe(
    `Answer to ${theirs} (Name the branch?): multi\nline`,
  );
  expect(server.log.slice(polls)).toEqual(["GET /directory"]);
  expect(await run(["answers", "--session", "s3"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(1);
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

test("a context typed with \\n for its line breaks gets them, but never in code (#1037)", () => {
  expect(typedBreaks("Locks 4 min.\\n**Now:** fails.\\n- `printf 'a\\nb'`")).toBe(
    "Locks 4 min.\n**Now:** fails.\n- `printf 'a\\nb'`",
  );
  // A real line break says the \n was meant; a backslash before it keeps it too.
  expect(typedBreaks("First.\nRun `sed 's/\\n//'` or C:\\\\new")).toBe(
    "First.\nRun `sed 's/\\n//'` or C:\\\\new",
  );
  expect(typedBreaks("Path C:\\\\new")).toBe("Path C:\\\\new");
});

test("<command> --help prints that command's usage, as help <command> does (#1967)", async () => {
  const commands = ["setup", "status", "uninstall", "pair", "machine", "ask", "waiting", "working"];
  commands.push("settle", "wait", "answers", "decisions", "run", "quota", "agent", "config");
  commands.push("hook", "hello", "update");
  for (const command of commands) {
    const usage = testCtx();
    expect(await run([command, "--help"], usage)).toBe(0);
    const text = usage.lines.join("\n");
    expect(text).toContain(`  starbridge ${command}`);
    // Only that command's: no other command's usage line.
    for (const other of commands.filter((c) => c !== command && !text.includes(`starbridge ${c} `)))
      expect(text).not.toContain(`\n  starbridge ${other}`);
    for (const args of [
      [command, "-h"],
      ["help", command],
    ]) {
      const again = testCtx();
      expect(await run(args, again)).toBe(0);
      expect(again.lines.join("\n")).toBe(text);
    }
  }
  const ask = testCtx();
  expect(await run(["ask", "--question", "Q?", "--help"], ask)).toBe(0);
  expect(ask.lines.join("\n")).toContain("The question takes at most\n      300 characters");
  expect(ask.lines.join("\n")).not.toContain("starbridge setup");
  // After run's --, --help belongs to the command.
  const wrapped = testCtx();
  expect(await run(["run", "--help", "--", "ls", "--help"], wrapped)).toBe(0);
  expect(wrapped.lines.join("\n")).toContain("starbridge run --title");
  const unknown = testCtx();
  expect(await run(["frobnicate", "--help"], unknown)).toBe(1);
  expect(unknown.errors.at(-1)).toContain("unknown command: frobnicate");
  expect(await run(["help", "frobnicate"], unknown)).toBe(1);
  expect(unknown.errors.at(-1)).toContain("unknown command: frobnicate");
});
