import { afterEach, expect, test } from "bun:test";
import {
  internalTrack,
  mainCode,
  PACKAGE,
  playNotes,
  TRACKS,
  type Track,
  upload,
} from "../scripts/play";

const URL_ = "https://github.com/T0mSIlver/starbridge/releases/tag/v1.2.3";

test("Play notes keep the Android section alone and fit Play's 500 characters", () => {
  const notes = `### Android
- Cards open faster. (#2)
- A fix. (#3)

### Web
- Not for Play. (#1)

<details><summary>All pull requests (3)</summary>

- Android: a feature (#2)
</details>`;
  expect(playNotes(notes, URL_)).toBe("• Cards open faster.\n• A fix.");
  expect(playNotes("### Web\n- Not for Play. (#1)\n", URL_)).toBe(`More: ${URL_}`);

  const long = `### Android\n${Array.from(
    { length: 30 },
    (_, i) => `- Change number ${i} with a longish line. (#${i})`,
  ).join("\n")}`;
  const cut = playNotes(long, URL_);
  expect(cut.length).toBeLessThanOrEqual(500);
  expect(cut).toStartWith("• Change number 0 with a longish line.\n");
  expect(cut).toEndWith(`\nMore: ${URL_}`);
});

type Seen = { method: string; path: string; body: string };

function fakePlay(
  commit: (seen: Seen[]) => Response | undefined = () => undefined,
  validate?: Response,
) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const s = { method: req.method, path: url.pathname + url.search, body: await req.text() };
      if (req.headers.get("authorization") !== "Bearer tok")
        return new Response("no", { status: 401 });
      seen.push(s);
      const app = `/androidpublisher/v3/applications/${PACKAGE}`;
      if (s.path === `${app}/edits`) return Response.json({ id: "e1" });
      if (s.path.startsWith(`/upload${app}/edits/e1/bundles`))
        return Response.json({ versionCode: 3020399 });
      if (s.path === `${app}/edits/e1/details`) return Response.json({ defaultLanguage: "fr-FR" });
      if (s.path.includes(":validate") && validate) return validate;
      if (s.path.includes(":commit")) return commit(seen) ?? Response.json({ id: "e1" });
      return new Response(s.method === "DELETE" ? "" : "{}");
    },
  });
  const run = (validate: boolean, track: Track = "alpha") =>
    upload({
      token: "tok",
      aab: new Uint8Array([1, 2]),
      version: "1.2.3",
      notes: "• x",
      track,
      validate,
      api: `http://localhost:${server.port}`,
    });
  return { server, seen, run };
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test.each([...TRACKS])(
  "validate puts the bundle on %s with notes in the listing's language, then discards the edit",
  async (name) => {
    const play = fakePlay();
    stop = () => play.server.stop(true);
    expect(await play.run(true, name)).toBe(3020399);
    const track = play.seen.find((s) => s.path.endsWith(`/tracks/${name}`));
    expect(JSON.parse(track?.body ?? "")).toEqual({
      track: name,
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
  },
);

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

test("validate reports a versionCode Play will not roll out, discards the edit and still passes", async () => {
  const play = fakePlay(
    undefined,
    new Response(
      '{"error":{"code":403,"message":"You cannot rollout this release because it does not allow any existing users to upgrade to the newly added APKs."}}',
      { status: 403 },
    ),
  );
  stop = () => play.server.stop(true);
  expect(await play.run(true)).toBe(3020399);
  expect(play.seen.at(-1)?.method).toBe("DELETE");
  expect(play.seen.some((s) => s.path.includes(":commit"))).toBe(false);
});

test("validate still fails on any other refusal", async () => {
  const play = fakePlay(undefined, new Response('{"error":{"message":"bad"}}', { status: 403 }));
  stop = () => play.server.stop(true);
  await expect(play.run(true)).rejects.toThrow("403");
  expect(play.seen.at(-1)?.method).toBe("DELETE");
});

test("the internal track's release name and highest code are read in an edit that is discarded (#1540)", async () => {
  const seen: string[] = [];
  const app = `/androidpublisher/v3/applications/${PACKAGE}`;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      if (path === `${app}/edits`) return Response.json({ id: "e2" });
      if (path === `${app}/edits/e2/tracks/internal`)
        return Response.json({
          releases: [{ name: "main-1a2b3c4d", versionCodes: ["2010751", "2010750"] }],
        });
      return new Response("");
    },
  });
  stop = () => server.stop(true);
  expect(await internalTrack("tok", `http://localhost:${server.port}`)).toEqual({
    name: "main-1a2b3c4d",
    maxCode: 2010751,
  });
  expect(seen.at(-1)).toBe(`DELETE ${app}/edits/e2`);
});

test("a build of main takes the next of its version's slots 50 to 98 above the track's highest code (#1690)", () => {
  // Same vectors as android/app/src/test/kotlin/VersionCodeTest.kt.
  expect(mainCode("0.1.7-rc.2", 0)).toBe(2_010_750);
  expect(mainCode("0.1.7-rc.3", 2_010_755)).toBe(2_010_756);
  expect(mainCode("0.1.7-rc.2", 2_010_797)).toBe(2_010_798);
  // After the final, the next patch.
  expect(mainCode("0.1.7", 2_010_760)).toBe(2_010_850);
  expect(mainCode("0.1.7", 0)).toBe(2_010_850);
  // An rc whose final is tagged (#1731): the next patch's slots, above the final.
  expect(mainCode("0.1.7-rc.2", 2_010_797, true)).toBe(2_010_850);
  expect(mainCode("0.1.7-rc.2", 0, true)).toBe(2_010_850);
  expect(mainCode("0.1.7-rc.2", 2_010_850, true)).toBe(2_010_851);
  // A new version's rc has its own slots: the old version's top code does not use them up.
  expect(mainCode("0.2.0-rc.1", 2_010_798)).toBe(2_020_050);
});

test("main's slots are spent after 98, for that version only (#1690)", () => {
  expect(mainCode("0.1.7-rc.2", 2_010_798)).toBeNull();
  expect(mainCode("0.1.7-rc.2", 2_010_850)).toBeNull();
  expect(mainCode("0.1.7", 2_010_898)).toBeNull();
  expect(mainCode("0.1.7", 2_010_897)).toBe(2_010_898);
  expect(mainCode("0.1.7-rc.2", 2_010_897, true)).toBe(2_010_898);
  expect(mainCode("0.1.7-rc.2", 2_010_898, true)).toBeNull();
  expect(() => mainCode("main", 0)).toThrow("not a version");
});
