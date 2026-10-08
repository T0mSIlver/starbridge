import { expect, test } from "bun:test";
import { linkPage, opensOutside, serverOrigin, staysInWindow } from "../../src/origin";

test.each([
  ["https://starbridge.run", "https://starbridge.run"],
  [" https://sb.example.com:8443/inbox ", "https://sb.example.com:8443"],
  ["http://localhost:3000", "http://localhost:3000"],
  ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ["http://sb.example.com", null],
  ["https://user:pw@sb.example.com", null],
  ["file:///etc/passwd", null],
  ["javascript:alert(1)", null],
  ["starbridge.run", null],
])("server %p is %p", (input, origin) => {
  expect(serverOrigin(input)).toBe(origin);
});

const SB = "https://starbridge.run";

test.each([
  ["https://starbridge.run/pair", true],
  ["https://github.com/login/oauth/authorize?x=1", false],
  ["https://starbridge.run.evil.com/", false],
  ["https://gist.github.com/x", false],
  ["http://starbridge.run/", false],
  ["file:///etc/passwd", false],
])("%p stays in the window: %p", (url, inside) => {
  expect(staysInWindow(url, SB)).toBe(inside);
});

test.each([
  ["https://claude.ai/code/session_01", true],
  ["mailto:abuse@starbridge.run", true],
  ["file:///Applications/Calculator.app", false],
  ["smb://host/share", false],
  ["starbridge://pair#X", false],
  ["not a url", false],
])("%p opens outside: %p", (url, outside) => {
  expect(opensOutside(url)).toBe(outside);
});

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";

test("a pairing link opens /pair on the configured server, without its check key", () => {
  const link = `starbridge://pair?server=${encodeURIComponent(SB)}&k=0123456789ABCDEF#${CODE}`;
  expect(linkPage(link, SB)).toEqual({ url: `${SB}/pair#${CODE}` });
  expect(linkPage(`starbridge://pair#${CODE}`, SB)).toEqual({ url: `${SB}/pair#${CODE}` });
});

test("a pairing link for another server is refused", () => {
  const page = linkPage(`starbridge://pair?server=https://evil.example#${CODE}`, SB);
  expect(page).toEqual({
    refused:
      "This pairing link is for https://evil.example, and Starbridge uses https://starbridge.run.",
  });
});

test.each([
  "starbridge://auth?code=x",
  "starbridge://pair",
  `starbridge://pair#${CODE}%22><script>`,
  "https://starbridge.run/pair#ABCD",
  "nonsense",
])("%p opens nothing", (link) => {
  expect(linkPage(link, SB)).toBeNull();
});
