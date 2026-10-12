import { expect, test } from "bun:test";
import { updateListing } from "../scripts/play-listing";

function fake(failOn?: string) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}`);
      if (failOn && url.pathname.endsWith(failOn))
        return new Response('{"error":{"message":"the reason"}}', { status: 400 });
      return new Response(url.pathname.endsWith("/edits") ? '{"id":"e1"}' : "{}");
    },
  });
  return { seen, server, api: `http://localhost:${server.port}` };
}
const dir = `${import.meta.dir}/../../android/store`;

test("the listing's images are replaced in one edit, which is then committed", async () => {
  const { seen, server, api } = fake();
  await updateListing({ token: "t", dir, api });
  server.stop();
  const base = "/androidpublisher/v3/applications/dev.starbridge.app/edits";
  expect(seen).toEqual([
    `POST ${base}`,
    `DELETE ${base}/e1/listings/en-US/icon`,
    `POST /upload${base}/e1/listings/en-US/icon`,
    `DELETE ${base}/e1/listings/en-US/featureGraphic`,
    `POST /upload${base}/e1/listings/en-US/featureGraphic`,
    `POST ${base}/e1:commit`,
  ]);
});

test("a refused commit fails with Play's error body and discards the edit", async () => {
  const { seen, server, api } = fake(":commit");
  await expect(updateListing({ token: "t", dir, api })).rejects.toThrow("the reason");
  server.stop();
  expect(seen.at(-1)).toEndWith("/edits/e1");
});
