import { expect, test } from "bun:test";
import { tagAsk, toSubagents, untagAsk } from "../hooks/subagent.ts";

test("a subagent's starbridge ask carries its id, and the permission check reads the command it wrote (#1702)", () => {
  const tagged = (c: string) => tagAsk(c, "a1fdba894e743a195");
  for (const c of [
    'starbridge ask --question "Q?" --option A',
    'cd /work && ~/.local/bin/starbridge ask --question "Q?"',
    'id=$(starbridge ask --question "Q?")',
  ]) {
    expect(tagged(c)).toBe(`export STARBRIDGE_CLAUDE_AGENT=a1fdba894e743a195\n${c}`);
    expect(untagAsk(tagged(c))).toBe(c);
    expect(tagged(tagged(c))).toBe(tagged(c));
  }
  for (const c of ["starbridge waiting d_1", "git commit -m 'starbridge asks'", "ls"])
    expect(tagged(c)).toBe(c);
  // An id the shell would read as more than a word.
  expect(tagAsk("starbridge ask --question Q", "a1; rm -rf ~")).toBe("starbridge ask --question Q");
  expect(untagAsk("export STARBRIDGE_CLAUDE_AGENT=x; ls")).toBe(
    "export STARBRIDGE_CLAUDE_AGENT=x; ls",
  );
});

test("each subagent gets its answers in one message; one that cannot take them leaves them to the parent (#1702)", async () => {
  const sent: [string, string][] = [];
  const logged: string[] = [];
  const { taken, rest } = await toSubagents(
    [
      { text: "Answer to d_1 (A?): x", ack: "d_1", subagent: "a1" },
      { text: "Answer to d_2 (B?): y", ack: "d_2" },
      { text: "Answer to d_3 (C?): z", ack: "d_3", subagent: "a1" },
      { text: "Answer to d_4 (D?): w", ack: "d_4", subagent: "gone" },
      { text: "Answer to d_5 (E?): v", ack: "d_5", subagent: "broken" },
    ],
    async (agent, text) => {
      if (agent === "broken") throw new Error("transcript expired");
      sent.push([agent, text]);
      return agent === "gone"
        ? { isDelivered: false, reason: "no agent gone" }
        : { isDelivered: true };
    },
    (t) => logged.push(t),
  );
  expect(sent).toEqual([
    ["a1", "Answer to d_1 (A?): x\nAnswer to d_3 (C?): z"],
    ["gone", "Answer to d_4 (D?): w"],
  ]);
  expect(taken).toEqual(["d_1", "d_3"]);
  const note = (agent: string) =>
    `Your subagent ${agent} asked this and could not take the answer: act on it, or pass it on.`;
  expect(rest).toEqual([
    { text: "Answer to d_2 (B?): y", ack: "d_2" },
    { text: `Answer to d_4 (D?): w\n${note("gone")}`, ack: "d_4" },
    { text: `Answer to d_5 (E?): v\n${note("broken")}`, ack: "d_5" },
  ]);
  expect(logged).toHaveLength(2);
});
