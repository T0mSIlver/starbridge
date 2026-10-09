import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookPreInvocation, hookPreTool, pbtxtString } from "../src/antigravity";
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
  // Prompts off: nothing to tell, and the conversation needs no CLI from then on.
  expect(out(turn("c-0"))).toEqual([{}]);
  ctx.store.saveAgentConfig({ permissions: { enabled: true } });
  expect(out(tool("c-0", "ls"))).toEqual([]);
  // No agent to take the key: nothing either.
  expect(out(tool("c-1", "ls"))).toEqual([]);
  writeFileSync(socket, "");
  expect(JSON.stringify(out(turn("c-2")))).toContain("run `starbridge hello`");
  // The hello itself runs; the first other command is denied with the same words, once.
  expect(out(tool("c-2", "starbridge hello"))[0]?.decision).toBe("allow");
  expect(out(tool("c-2", "ls"))[0]?.decision).toBe("deny");
  expect(out(tool("c-2", "ls"))).toEqual([]);
});
