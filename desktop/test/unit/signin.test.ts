import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { browserSignIn, newSignIn, SIGN_IN_MS, signInReturn, startsSignIn } from "../../src/signin";

const SB = "https://starbridge.run";

test("the challenge is the verifier's S256, as RFC 7636 has it", () => {
  const s = newSignIn();
  expect(s.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(s.challenge).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
  expect(browserSignIn(SB, s)).toBe(`${SB}/v1/auth/github?app=1&challenge=${s.challenge}`);
  expect(browserSignIn(SB, s, "/v1/auth/apple")).toBe(
    `${SB}/v1/auth/apple?app=1&challenge=${s.challenge}`,
  );
});

test.each([
  [`${SB}/v1/auth/github`, "/v1/auth/github"],
  [`${SB}/v1/auth/github?next=/`, "/v1/auth/github"],
  [`${SB}/v1/auth/apple`, "/v1/auth/apple"],
  [`${SB}/v1/auth/github?app=1&challenge=x`, null],
  [`${SB}/v1/auth/github/callback?code=x`, null],
  ["https://evil.example/v1/auth/github", null],
])("%p starts the page's sign-in: %p", (url, starts) => {
  expect(startsSignIn(url, SB)).toBe(starts);
});

test("a link back with our challenge carries the code or GitHub's error", () => {
  const s = newSignIn(1_000);
  const back = (q: string) => signInReturn(`starbridge://auth?${q}`, s, 2_000);
  expect(back(`code=abc123&state=${s.challenge}`)).toEqual({ code: "abc123" });
  // Apple's, with dots.
  expect(back(`code=c1f.0.ab.Xy-z&state=${s.challenge}`)).toEqual({ code: "c1f.0.ab.Xy-z" });
  expect(back(`error=access_denied&state=${s.challenge}`)).toEqual({ error: "access_denied" });
});

test.each([
  ["another challenge", (c: string) => `starbridge://auth?code=abc&state=${c}x`],
  ["no state", () => "starbridge://auth?code=abc"],
  ["a pairing link", (c: string) => `starbridge://pair?code=abc&state=${c}`],
  ["a code with a slash", (c: string) => `starbridge://auth?code=a/b&state=${c}`],
])("%s is ignored", (_why, link) => {
  const s = newSignIn(1_000);
  expect(signInReturn(link(s.challenge), s, 2_000)).toBeNull();
});

test("a link after ten minutes, or with no sign-in started, is ignored", () => {
  const s = newSignIn(0);
  const link = `starbridge://auth?code=abc&state=${s.challenge}`;
  expect(signInReturn(link, s, SIGN_IN_MS + 1)).toBeNull();
  expect(signInReturn(link, null)).toBeNull();
});
