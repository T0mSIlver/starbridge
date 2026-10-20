import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookPreInvocation, hookPreTool, onLoopback, pbtxtString } from "../src/antigravity";
import { testCtx } from "./helpers";

test("a prototext string reads back whatever Go's encoder escaped", () => {
  expect(pbtxtString('title: "a \\"b\\" \\\\ c\\nd"', "title")).toBe('a "b" \\ c\nd');
  expect(pbtxtString('subtitle:"no" title:"Caf\\303\\251 \\x41\\u00e9"', "title")).toBe("Café Aé");
  expect(pbtxtString('title:"Été"', "title")).toBe("Été");
  expect(pbtxtString("other:1", "title")).toBeUndefined();
});

test("with prompts on, a conversation that ran no starbridge command is told to, once denied (#962)", () => {
  const ctx = testCtx();
  const socket = join(ctx.store.dir, "agent.sock");
  ctx.env.STARBRIDGE_AGENT_SOCKET = socket;
  const call = (id: string, line: string) =>
    JSON.stringify({
      conversationId: id,
      toolCall: { name: "run_command", args: { CommandLine: line } },
    });
  const out = (fn: () => void) => {
    ctx.lines.length = 0;
    fn();
    return ctx.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const turn = (id: string) => () =>
    hookPreInvocation(ctx, JSON.stringify({ conversationId: id }), { agent: "antigravity" });
  const tool = (id: string, line: string) => () =>
    hookPreTool(ctx, call(id, line), { agent: "antigravity" });
  // Prompts off: nothing to tell.
  expect(out(turn("c-0"))).toEqual([{}]);
  ctx.store.saveAgentConfig({ permissions: { enabled: true } });
  // No agent to take the key: nothing either.
  expect(out(tool("c-1", "ls"))).toEqual([]);
  writeFileSync(socket, "");
  // Both were passing states: those conversations are told too, once the agent runs (#1336).
  for (const id of ["c-0", "c-1", "c-2"])
    expect(JSON.stringify(out(turn(id)))).toContain("run `starbridge hello`");
  // The hello itself runs; the first other command is denied with the same words, once.
  expect(out(tool("c-2", "starbridge hello"))[0]?.decision).toBe("allow");
  expect(out(tool("c-2", "ls"))[0]?.decision).toBe("deny");
  expect(out(tool("c-2", "ls"))).toEqual([]);
});

test("a language server's address counts only on loopback, at a port a server can take (#1749)", () => {
  for (const a of ["127.0.0.1:36469", "localhost:1", "[::1]:65535"])
    expect([a, onLoopback(a)]).toEqual([a, true]);
  for (const a of [
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:080",
    "127.0.0.1:",
    "127.0.0.2:36469",
    "127.0.0.1:36469/x",
    "user@127.0.0.1:36469",
    "example.com:36469",
    "127.0.0.1:36469\n",
  ])
    expect([a, onLoopback(a)]).toEqual([a, false]);
});

test("a line that hands ask a file to read stays in the sandbox, or asks the owner (L3)", () => {
  const ctx = testCtx();
  const decide = (line: string) => {
    ctx.lines.length = 0;
    hookPreTool(
      ctx,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: line } } }),
      { agent: "antigravity" },
    );
    return (JSON.parse(ctx.lines[0] ?? "{}") as { decision?: string }).decision;
  };
  expect(decide("starbridge ask --question ok --option ok --context 'see the log'")).toBe("allow");
  for (const line of [
    "starbridge ask --question ok --option ok --context-file /home/u/.ssh/id_ed25519",
    "starbridge ask --question ok --context-file=~/.aws/credentials",
    "starbridge ask --input ~/.config/x.json",
    "starbridge ask --question ok --image /home/u/secret.png",
    `starbridge ask --question ok "--context-file" /etc/passwd`,
    `starbridge ask --question ok --con"text-fi"le /etc/passwd`,
  ])
    expect([line, decide(line)]).toEqual([line, "force_ask"]);
});
