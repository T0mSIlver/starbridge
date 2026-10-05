import { expect, test } from "bun:test";
import { needsHomeScreen } from "./install";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPHONE_16_3 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const tab = (userAgent: string, maxTouchPoints = 5) => ({
  userAgent,
  maxTouchPoints,
  installed: false,
});

test("Safari and other iOS browsers in a tab need the Home Screen", () => {
  expect(needsHomeScreen(tab(IPHONE))).toBe(true);
  expect(needsHomeScreen(tab(CHROME_IOS))).toBe(true);
});

test("an iPad, which reports a Mac, is told apart by its touch screen", () => {
  expect(needsHomeScreen(tab(MAC_SAFARI, 5))).toBe(true);
  expect(needsHomeScreen(tab(MAC_SAFARI, 0))).toBe(false);
});

test("the Home Screen app itself offers push as usual", () => {
  expect(needsHomeScreen({ ...tab(IPHONE), installed: true })).toBe(false);
});

test("iOS before 16.4 has no Web Push, so nothing to install for", () => {
  expect(needsHomeScreen(tab(IPHONE_16_3))).toBe(false);
});

test("Android pushes from a tab", () => {
  expect(needsHomeScreen(tab(ANDROID))).toBe(false);
});
