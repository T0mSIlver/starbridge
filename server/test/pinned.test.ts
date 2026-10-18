// The real `pinnedHttps`, which push.test.ts replaces with a fake: it must connect to the address
// the private-address check passed (the SSRF defence, #1918), still check the certificate against
// the URL's host, and give up on a service that drip-feeds its reply.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { pinnedHttps } from "../src/push";

const FIXTURES = join(import.meta.dir, "fixtures/push-tls");

/** What the service saw of each request. */
const seen: { method?: string; url?: string; host?: string; body: string }[] = [];
/** The client port of each request's connection. */
const sockets: (number | undefined)[] = [];
/** How the service answers: at once, or a byte every 100 ms without end. */
let drip = false;
let server: Server;
let port: number;

beforeAll(async () => {
  // Trust the test CA beside the system's, as a push service's real CA is.
  tls.setDefaultCACertificates([
    ...tls.getCACertificates("default"),
    readFileSync(join(FIXTURES, "ca.pem"), "utf8"),
  ]);
  server = createServer(
    {
      key: readFileSync(join(FIXTURES, "push.key")),
      cert: readFileSync(join(FIXTURES, "push.pem")),
    },
    (req, res) => {
      sockets.push(req.socket.remotePort);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString(),
        });
        if (!drip) return res.writeHead(201).end();
        res.writeHead(201, { "content-type": "text/plain" });
        const tick = setInterval(() => res.write("."), 100);
        res.on("close", () => clearInterval(tick));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const post = (body: string) => ({
  method: "POST",
  headers: { ttl: "60", "content-type": "application/octet-stream" },
  body: new TextEncoder().encode(body),
});

test("the push goes to the pinned address, never to what the host resolves to", async () => {
  seen.length = 0;
  // `push.test` resolves nowhere: only the pin can reach the service.
  const status = await pinnedHttps(
    new URL(`https://push.test:${port}/wpush/v2/abc?x=1`),
    "127.0.0.1",
    post("sealed"),
    5_000,
  );
  expect(status).toBe(201);
  expect(seen).toEqual([
    { method: "POST", url: "/wpush/v2/abc?x=1", host: `push.test:${port}`, body: "sealed" },
  ]);
});

test("the certificate is still checked against the URL's host, not the pinned address", async () => {
  seen.length = 0;
  // The pin reaches the same service, whose certificate names push.test only.
  const sent = pinnedHttps(new URL(`https://other.test:${port}/p`), "127.0.0.1", post("x"), 5_000);
  await expect(sent).rejects.toThrow(/other\.test|altname|hostname|certificate/i);
  expect(seen).toEqual([]);
});

test("each push opens its own connection, so none skips the pin through a pooled one", async () => {
  sockets.length = 0;
  for (let i = 0; i < 2; i++)
    await pinnedHttps(new URL(`https://push.test:${port}/p`), "127.0.0.1", post("x"), 5_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[0]).not.toBe(sockets[1]);
});

test("a service that drip-feeds its reply is cut at the deadline", async () => {
  drip = true;
  try {
    const sent = pinnedHttps(new URL(`https://push.test:${port}/p`), "127.0.0.1", post("x"), 500);
    // A byte every 100 ms would hold an idle timeout open forever.
    const late = Bun.sleep(3_000).then(() => "still sending after 3 s");
    expect(await Promise.race([sent.catch((e: Error) => e.message), late])).toBe("push timed out");
  } finally {
    drip = false;
  }
});
