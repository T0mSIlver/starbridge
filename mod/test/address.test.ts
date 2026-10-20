import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { agentSocket, configKey } from "../hooks/address.ts";

const sync = (text: string) => createHash("sha256").update(text).digest("hex");
const async = async (text: string) => sync(text);
const join = (...parts: string[]) => parts.join("/");

test("one config key and one agent address, hashed either way", async () => {
  const key = configKey("/home/tom/.config/starbridge", false, sync);
  expect(key).toHaveLength(16);
  // Doubled and trailing slashes, and on Windows backslashes, name the same folder.
  for (const [dir, windows] of [
    ["/home/tom//.config/starbridge", false],
    ["/home/tom/.config/starbridge/", false],
    ["\\home\\tom\\.config\\starbridge", true],
  ] as const) {
    expect(configKey(dir, windows, sync)).toBe(key);
    expect(await configKey(dir, windows, async)).toBe(key);
  }
  // Elsewhere a backslash is part of a name.
  expect(configKey("/tmp/a\\b", false, sync)).not.toBe(configKey("/tmp/a/b", false, sync));

  const dir = { path: "/c/starbridge", standard: "/c/starbridge", key };
  const run = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(agentSocket({ ...run, STARBRIDGE_AGENT_SOCKET: "/s.sock" }, dir, false, join)).toBe(
    "/s.sock",
  );
  expect(agentSocket(run, dir, true, join)).toBe("/c/starbridge/agent.port");
  expect(agentSocket(run, dir, false, join)).toBe(`/run/user/1000/starbridge/agent-${key}.sock`);
  expect(agentSocket({}, dir, false, join)).toBe("/c/starbridge/agent.sock");
  expect(agentSocket(run, { ...dir, path: "/tmp/sb" }, false, join)).toBe("/tmp/sb/agent.sock");
});
