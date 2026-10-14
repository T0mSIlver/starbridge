import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, ApiError, MAX_RESPONSE_BYTES, Unreachable } from "../src/api";
import { MAX_PROVIDERS, MAX_STDOUT_BYTES, parseUsage, runCodexbar } from "../src/codexbar";
import { imageSize, loadPicture, MAX_FILE_BYTES } from "../src/images";
import { ProgressParser } from "../src/run";
import { fakeCommand } from "./helpers";

const WINDOWS = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "starbridge-robust-"));

/** A PNG's signature and header chunk, which claim `w` by `h` pixels and carry no pixels. */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

test("an image is refused by its header or its file size before any decoder allocates", () => {
  expect(imageSize(pngHeader(300, 200))).toEqual({ width: 300, height: 200 });
  // A JPEG: SOI, an APP0 segment, then SOF0 with 5 rows and 9 columns.
  const jpg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 9, 1, 1, 0x11, 0,
  ]);
  expect(imageSize(jpg)).toEqual({ width: 9, height: 5 });

  const huge = join(dir, "huge.png");
  writeFileSync(huge, pngHeader(60_000, 60_000));
  expect(() => loadPicture(huge)).toThrow("megapixels");
  const big = join(dir, "big.png");
  writeFileSync(big, pngHeader(10, 10));
  truncateSync(big, MAX_FILE_BYTES + 1);
  expect(() => loadPicture(big)).toThrow("cannot read");
});

test("run progress takes only safe integers and at most 10000 steps", () => {
  const read = (text: string) => new ProgressParser().feed(text);
  expect(read("[3/7]")).toEqual({ done: 3, total: 7, unit: "step" });
  expect(read("[3/10000]")).toMatchObject({ total: 10000 });
  expect(read("[3/10001]")).toBeUndefined();
  expect(read("[1/99999999999999999999]")).toBeUndefined();
  expect(read("[99999999999999999999/99999999999999999999]")).toBeUndefined();
});

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request) => Response | Promise<Response>): Api {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return new Api(`http://127.0.0.1:${server.port}`, "tok");
}

test("a server's error text is shown without control characters, cut, and its Retry-After capped", async () => {
  const api = serve(() =>
    Response.json(
      { error: "\u001b[2Jboom", detail: `‮${"x".repeat(1000)}`, minimum: 7 },
      { status: 500 },
    ),
  );
  const err = await api.postItem({} as never).catch((e) => e as ApiError);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).message).not.toContain("\u001b");
  expect((err as ApiError).message).toContain("\\u001B[2Jboom");
  expect((err as ApiError).message).toContain("\\u202E");
  expect((err as ApiError).message.length).toBeLessThan(500);

  const limited = serve(() =>
    Response.json({ error: "rate-limited" }, { status: 429, headers: { "retry-after": "86400" } }),
  );
  const e2 = (await limited.postItem({} as never).catch((e) => e)) as ApiError;
  expect(e2.retryAfter).toBe(300);

  // A name from Object.prototype is not one of the known errors.
  const proto = serve(() => Response.json({ error: "constructor" }, { status: 507 }));
  expect(((await proto.postItem({} as never).catch((e) => e)) as ApiError).message).toContain(
    "constructor",
  );
});

test("a success body over the cap, and a page that is not one, are refused", async () => {
  const big = serve(() => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)));
  await expect(big.answers(undefined, 0)).rejects.toBeInstanceOf(Unreachable);

  for (const body of [
    { items: "x" },
    { items: [], cursor: "c".repeat(300) },
    { items: [], cursor: 5 },
    { items: new Array(1001).fill({ item: 1 }) },
    { items: [], directory: 1.5 },
  ]) {
    const api = serve(() => Response.json(body));
    await expect(api.answers(undefined, 0)).rejects.toThrow("cannot read");
    server?.stop(true);
  }
  const fat = serve(() =>
    Response.json({ items: [{ item: { id: 1, pad: "x".repeat(5 << 20) } }, { item: { id: 2 } }] }),
  );
  expect(await fat.answers(undefined, 0)).toEqual({ items: [{ id: 2 }] });
  server?.stop(true);
  const ok = serve(() =>
    Response.json({ items: [{ item: { id: 1 } }], cursor: "c", directory: 2 }),
  );
  expect(await ok.answers(undefined, 0)).toEqual({ items: [{ id: 1 }], cursor: "c", directory: 2 });
});

test.skipIf(WINDOWS)(
  "codexbar stops at its output cap and when it exits, and kills its children",
  async () => {
    const flood = fakeCommand(join(dir, "flood.sh"), "#!/bin/sh\nyes | head -c 3000000\n");
    const r = await runCodexbar(flood, undefined, 10_000);
    expect(r.code).toBeNull();
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`over ${MAX_STDOUT_BYTES}`);

    // The child that CodexBar leaves running holds the pipes open: the run still ends when it exits.
    const left = fakeCommand(join(dir, "left.sh"), "#!/bin/sh\nsleep 30 &\necho '[]'\n");
    const started = Date.now();
    const l = await runCodexbar(left, undefined, 20_000);
    expect(l).toMatchObject({ code: 0, stdout: "[]\n" });
    expect(Date.now() - started).toBeLessThan(5_000);

    const hung = fakeCommand(join(dir, "hung.sh"), "#!/bin/sh\nsleep 30 &\nwait\n");
    const h0 = Date.now();
    const h = await runCodexbar(hung, undefined, 300);
    expect(h.code).toBeNull();
    expect(Date.now() - h0).toBeLessThan(5_000);
  },
);

test("codexbar's text loses control characters, and its rows and windows are capped", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    provider: `p${i}\u001b[31m`,
    error: "bad\u001b]0;pwned\u0007",
    usage: {
      extraRateWindows: Array.from({ length: 100 }, (_, k) => ({
        id: `w${k}`,
        title: "t",
        window: { usedPercent: k },
      })),
    },
  }));
  const parsed = parseUsage(JSON.stringify(rows), undefined, new Date());
  expect(parsed).toHaveLength(MAX_PROVIDERS);
  expect(parsed[0]?.provider).toBe("p0[31m");
  expect(parsed[0]?.error).toBe("bad]0;pwned");
  expect(parsed[0]?.windows.length).toBeLessThanOrEqual(20);
});
