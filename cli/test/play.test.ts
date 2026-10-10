import { afterEach, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { PACKAGE, playNotes, upload } from "../scripts/play";

const URL_ = "https://github.com/T0mSIlver/starbridge/releases/tag/v1.2.3";

test("Play notes keep the pull request titles and fit Play's 500 characters", () => {
  const short = `## What's Changed
* Web: a fix by @T0mSIlver in https://github.com/T0mSIlver/starbridge/pull/1
* Android: a feature by @someone in https://github.com/T0mSIlver/starbridge/pull/2

**Full Changelog**: https://github.com/T0mSIlver/starbridge/compare/v1.2.2...v1.2.3`;
  expect(playNotes(short, URL_)).toBe("• Web: a fix\n• Android: a feature");

  const long = Array.from(
    { length: 30 },
    (_, i) => `* Change number ${i} with a longish title by @a in https://x/pull/${i}`,
  ).join("\n");
  const notes = playNotes(long, URL_);
  expect(notes.length).toBeLessThanOrEqual(500);
  expect(notes).toStartWith("• Change number 0 with a longish title\n");
  expect(notes).toEndWith(`\nMore: ${URL_}`);
});

type Seen = { method: string; path: string; body: string };

function fakePlay(commit: (seen: Seen[]) => Response | undefined = () => undefined) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const s = { method: req.method, path: url.pathname + url.search, body: await req.text() };
      if (url.pathname === "/token") {
        const [h, p, sig] = new URLSearchParams(s.body).get("assertion")?.split(".") ?? [];
        const ok = createVerify("RSA-SHA256")
          .update(`${h}.${p}`)
          .verify(publicKey, sig ?? "", "base64url");
        return ok
          ? Response.json({ access_token: "tok" })
          : new Response("bad jwt", { status: 401 });
      }
      if (req.headers.get("authorization") !== "Bearer tok")
        return new Response("no", { status: 401 });
      seen.push(s);
      const app = `/androidpublisher/v3/applications/${PACKAGE}`;
      if (s.path === `${app}/edits`) return Response.json({ id: "e1" });
      if (s.path.startsWith(`/upload${app}/edits/e1/bundles`))
        return Response.json({ versionCode: 3020399 });
      if (s.path === `${app}/edits/e1/details`) return Response.json({ defaultLanguage: "fr-FR" });
      if (s.path.includes(":commit")) return commit(seen) ?? Response.json({ id: "e1" });
      return new Response(s.method === "DELETE" ? "" : "{}");
    },
  });
  const account = {
    client_email: "ci@x.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: `http://localhost:${server.port}/token`,
  };
  const run = (validate: boolean) =>
    upload({
      account,
      aab: new Uint8Array([1, 2]),
      version: "1.2.3",
      notes: "• x",
      validate,
      api: `http://localhost:${server.port}`,
    });
  return { server, seen, run };
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("validate puts the bundle on alpha with notes in the listing's language, then discards the edit", async () => {
  const play = fakePlay();
  stop = () => play.server.stop(true);
  expect(await play.run(true)).toBe(3020399);
  const track = play.seen.find((s) => s.path.endsWith("/tracks/alpha"));
  expect(JSON.parse(track?.body ?? "")).toEqual({
    track: "alpha",
    releases: [
      {
        name: "1.2.3",
        versionCodes: ["3020399"],
        status: "completed",
        releaseNotes: [{ language: "fr-FR", text: "• x" }],
      },
    ],
  });
  expect(play.seen.map((s) => s.method + s.path.replace(/.*edits\/e1/, ""))).toEqual(
    expect.arrayContaining(["POST:validate", "DELETE"]),
  );
  expect(play.seen.some((s) => s.path.includes(":commit"))).toBe(false);
});

test("a commit Play will not send for review is committed for the owner to send", async () => {
  const play = fakePlay((seen) =>
    seen.filter((s) => s.path.includes(":commit")).length === 1
      ? new Response(
          '{"error":{"message":"set the query parameter changesNotSentForReview to true"}}',
          { status: 400 },
        )
      : undefined,
  );
  stop = () => play.server.stop(true);
  await play.run(false);
  expect(
    play.seen.filter((s) => s.path.includes(":commit")).map((s) => s.path.replace(/.*:/, ":")),
  ).toEqual([":commit", ":commit?changesNotSentForReview=true"]);
  expect(play.seen.some((s) => s.method === "DELETE")).toBe(false);
});
