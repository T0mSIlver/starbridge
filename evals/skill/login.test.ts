import { expect, test } from "bun:test";
import { opencodeApiKeys } from "./login.ts";

test("a run's opencode login holds the API keys, never an OAuth login that refreshes", () => {
  const auth = JSON.stringify({
    zai: { type: "api", key: "k" },
    github: { type: "oauth", refresh: "r", access: "a", expires: 1 },
  });
  expect(JSON.parse(opencodeApiKeys(auth))).toEqual({ zai: { type: "api", key: "k" } });
  expect(() => opencodeApiKeys(JSON.stringify({ github: { type: "oauth" } }))).toThrow("no API key");
});
