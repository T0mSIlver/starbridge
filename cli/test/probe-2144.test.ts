// Temporary probe for #2144, removed before merge: how long a dial to a closed loopback port takes.
import { expect, test } from "bun:test";
import { request } from "node:http";
import { createServer } from "node:net";

test("probe: a dial to a closed loopback port", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const err = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent: false }, () =>
        resolve("answered"),
      );
      req.on("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? String(e)));
      req.end();
    });
    console.log(
      `PROBE-2144 ${process.platform} dial ${i}: ${err} after ${Math.round(performance.now() - t)} ms`,
    );
  }
  expect(true).toBe(true);
});
