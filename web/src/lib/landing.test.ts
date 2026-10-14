import { expect, test } from "bun:test";
import { cacheOrigin } from "./landing";

const request = (h: Record<string, string>) => new Headers(h);

test("the landing cache keys on the public origin, never a forged forwarded host (#1722)", () => {
  const own = {
    host: "starbridge.run",
    "x-forwarded-host": "starbridge.run",
    "x-forwarded-proto": "https",
  };
  const forged = { ...own, "x-forwarded-host": "evil.example" };
  expect(cacheOrigin(request(own), "https://starbridge.run")).toBe("https://starbridge.run");
  expect(cacheOrigin(request(forged), "https://starbridge.run")).toBeUndefined();
  expect(
    cacheOrigin(request({ ...own, "x-forwarded-proto": "http" }), "https://starbridge.run"),
  ).toBeUndefined();
  // Without PUBLIC_URL, the forwarded host must be the Host the proxy routed on.
  expect(cacheOrigin(request(own))).toBe("https://starbridge.run");
  expect(cacheOrigin(request(forged))).toBeUndefined();
  expect(cacheOrigin(request({ host: "localhost:3000" }))).toBe("http://localhost:3000");
});
