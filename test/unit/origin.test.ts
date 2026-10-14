import { expect, test } from "bun:test";
import { opensOutside, serverOrigin, staysInWindow } from "../../src/origin";

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
