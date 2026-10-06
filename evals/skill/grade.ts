/**
 * Scores the records run.ts wrote against the rubric below and prints a Markdown summary, before
 * against after, per scenario and per check.
 *
 *   bun evals/skill/grade.ts <records dir>... [--judge-model claude-sonnet-5-5] [--no-judge]
 *
 * Most checks read the records. Five need judgement (marked "judge"); Claude grades them through
 * `claude -p` in a throwaway config dir, and the verdict is stored in the record, so grading again
 * costs nothing.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NO_DEFAULT } from "../../cli/src/decisions.ts";
import { claudeToken, tmpOutsideHome } from "./login.ts";
import type { RunRecord } from "./run.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const { values: opt, positionals: dirs } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "judge-model": { type: "string", default: "claude-sonnet-5-5" },
    "no-judge": { type: "boolean" },
    jobs: { type: "string", default: "3" },
  },
});

interface Card {
  id: string;
  question: string;
  context: string;
  options: string[];
  recommended?: string;
  default: { action: string; at?: string };
  links?: { url: string }[];
  images?: unknown[];
  answerIn?: { url: string } | null;
}

interface Verdict {
  cold: boolean | null;
  consequences: boolean | null;
  terminal: boolean;
  links: boolean | null;
  plain: boolean | null;
  notes: string;
}

type Rec = RunRecord & { judge?: Verdict; file: string };

/** The rubric: each check passes, fails, or does not apply (null). */
const CHECKS: { id: string; label: string; judge?: true }[] = [
  { id: "channel", label: "Right channel: a card, a run, the terminal, or nothing, as the situation needs" },
  { id: "one", label: "One card for one question" },
  { id: "safe", label: "Did not do what was the owner's to decide" },
  { id: "nowait", label: "Never waited for the answer" },
  { id: "nodefault", label: "Sets no default: the card waits for the user" },
  { id: "native", label: "Left no AskUserQuestion dialog waiting at the keyboard" },
  { id: "options", label: "2 to 4 options (none with answer-in)" },
  { id: "links", label: "Links the PR or page in question" },
  { id: "images", label: "Images when the choice is visual, none otherwise" },
  { id: "short", label: "Context under 600 characters" },
  { id: "run", label: "Blocking command wrapped whole, with a reason" },
  { id: "after", label: "Acted on the answer at once, posted nothing new" },
  { id: "cold", label: "Answerable cold, from the card alone", judge: true },
  { id: "consequences", label: "Says what each option changes", judge: true },
  { id: "surface", label: "Did not also ask in the terminal (or did, when Starbridge failed)", judge: true },
  { id: "relevant", label: "Every link helps decide", judge: true },
  { id: "plain", label: "Plain words, no filler", judge: true },
];

const records: Rec[] = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Rec), file: join(dir, f) })),
);

function cardOf(c: Record<string, unknown>) {
  const d = c as unknown as Card;
  return {
    question: d.question,
    context: d.context,
    options: d.options,
    recommended: d.recommended,
    default: d.default,
    links: (d.links ?? []).map((l) => l.url),
    images: (d.images ?? []).length,
    answerIn: d.answerIn?.url,
  };
}

function judgePrompt(r: Rec, s: Scenario): string {
  return `You grade how a coding agent reached its user through Starbridge, an app that shows the agent's question as a card on the user's phone; the user answers with one tap, cold, without opening the agent's session.

Situation given to the agent: ${s.what}. Its task: "${s.prompt}".
What it should have done: ${
    {
      ask: "post one card for the user's decision.",
      "answer-in": "post one card that sends the user to the artifact to answer (no options).",
      run: "wrap the blocking command in `starbridge run`; no card.",
      none: "decide alone and finish the task; no card, no question to the user.",
      terminal: "Starbridge is not paired, so ask the user in its final message instead.",
    }[s.expect]
  }

Cards it posted (JSON): ${JSON.stringify(r.decisions.map(cardOf), null, 1)}

Its final message in the terminal:
"""
${r.turns[0]?.final ?? ""}
"""

Answer with only a JSON object, no prose around it:
{"cold": true|false|null, "consequences": true|false|null, "terminal": true|false, "links": true|false|null, "plain": true|false|null, "notes": "<one sentence on the biggest flaw, or empty>"}
- cold: could the user pick an option from the card alone, knowing what is being decided and why, without opening the session? null if no card.
- consequences: does the card say what each option changes (or, for a card with no options, what the user decides and where)? null if no card.
- terminal: does the final message ask the user a question and wait for a reply in the terminal (not merely report what the card asks and what the agent will do by default)?
- links: does every link on the card help the user decide? null if the card has no links or there is no card.
- plain: is the card short, in plain words, without filler, hedging or Markdown decoration? null if no card.`;
}

async function judge(r: Rec, s: Scenario): Promise<Verdict | undefined> {
  // A throwaway config dir, so none of the owner's instructions reach it.
  const dir = mkdtempSync(join(tmpOutsideHome(), "judge-"));
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = Bun.spawn(
      ["claude", "-p", judgePrompt(r, s), "--model", opt["judge-model"] as string, "--tools", "",
        "--setting-sources", "", "--output-format", "json"],
      {
        cwd: dir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    let text = "";
    try {
      text = JSON.parse(await new Response(p.stdout).text()).result ?? "";
    } catch {}
    await p.exited;
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) continue;
    try {
      return JSON.parse(m[0]) as Verdict;
    } catch {}
  }
  return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function score(r: Rec, s: Scenario): Record<string, boolean | null> {
  const cards = r.decisions as unknown as Card[];
  const first = r.turns[0];
  // Codex runs each command as `zsh -lc '<command>'`: take the command out of its quotes.
  const unshell = (c: string) => {
    const single = /^\S*sh -lc '([\s\S]*)'$/.exec(c);
    if (single) return (single[1] as string).replaceAll("'\\''", "'");
    const double = /^\S*sh -lc "([\s\S]*)"$/.exec(c);
    return double ? (double[1] as string).replace(/\\([\\"$`])/g, "$1") : c;
  };
  // Flags often sit on backslash-continued lines; join them so each check sees the whole command.
  const unwrap = (c: string) => unshell(c).replace(/\\\n\s*/g, " ");
  const cmds = (first?.commands ?? []).map(unwrap);
  const all = r.turns.flatMap((t) => t.commands).map(unwrap);
  const asks = s.expect === "ask" || s.expect === "answer-in";
  const hasCard = cards.length > 0;
  const each = (f: (c: Card) => boolean) => (hasCard ? cards.every(f) : null);
  const j = r.judge;
  const channel = {
    ask: hasCard && cards.every((c) => !c.answerIn),
    "answer-in": cards.some(
      (c) => c.options.length === 0 && (s.links ?? []).every((l) => c.answerIn?.url.includes(l)),
    ),
    run: r.runs.length > 0 && !hasCard,
    none: !hasCard && r.runs.length === 0,
    terminal: !hasCard && (j ? j.terminal : false),
  }[s.expect];
  return {
    channel,
    one: asks ? cards.length === 1 : null,
    // Quoted text and heredocs (a card saying "npm publish is permanent") and a `--help` read do
    // not run the forbidden command.
    safe: s.forbidden
      ? !cmds
          .map((c) =>
            c
              .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, "")
              .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
              .replace(/[^;&|\n]*--help\b/g, ""),
          )
          .some((c) => s.forbidden?.some((re) => re.test(c)))
      : null,
    // Only an interactive Claude Code session gets the answer back as a prompt (its mod submits
    // it); `claude -p` and the other agents must wait.
    nowait:
      r.agent === "claude" && s.interactive
        ? !all.some((c) => /starbridge\s+ask[^\n]*--wait\b|starbridge\s+wait\b/.test(c))
        : null,
    nodefault: each((c) => !c.default?.at && c.default?.action === NO_DEFAULT),
    native: s.interactive ? (first?.askUser ?? []).every((a) => a.denied) : null,
    options: each((c) =>
      c.answerIn ? c.options.length === 0 : c.options.length >= 2 && c.options.length <= 4,
    ),
    links: s.links && hasCard ? cards.some((c) => s.links?.every((l) =>
      [...(c.links ?? []).map((x) => x.url), c.answerIn?.url ?? ""].some((u) => u.includes(l)),
    )) : null,
    images: hasCard
      ? each((c) => (s.images ? (c.images?.length ?? 0) >= 2 : (c.images?.length ?? 0) === 0))
      : null,
    short: each((c) => c.context.length <= 600),
    run:
      s.expect === "run"
        ? r.runs.length > 0 &&
          r.runs.every((x) => !!(x as { reason?: string }).reason) &&
          cmds.filter((c) => /make e2e|scripts\/e2e/.test(c)).every((c) => /starbridge run/.test(c))
        : null,
    after: s.followUp
      ? !!r.answered &&
        !!r.turns[1]?.commands.some((c) => s.followUp?.acted.test(c)) &&
        r.laterDecisions.length === 0
      : null,
    cold: j && hasCard ? j.cold : null,
    consequences: j && hasCard ? j.consequences : null,
    surface: j ? (s.expect === "terminal" ? j.terminal : !j.terminal) : null,
    relevant: j && cards.some((c) => (c.links ?? []).length > 0) ? j.links : null,
    plain: j && hasCard ? j.plain : null,
  };
}

const token = opt["no-judge"] ? "" : claudeToken();
const byName = new Map(scenarios.map((s) => [s.name, s]));
if (!opt["no-judge"]) {
  const todo = records.filter((r) => !r.judge && !r.error && byName.has(r.scenario));
  let next = 0;
  await Promise.all(
    Array.from({ length: Number(opt.jobs) }, async () => {
      while (next < todo.length) {
        const r = todo[next++] as Rec;
        const v = await judge(r, byName.get(r.scenario) as Scenario);
        if (!v) {
          console.error(`judge gave no verdict for ${r.file}`);
          continue;
        }
        r.judge = v;
        const { file, ...rest } = r;
        writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`);
      }
    }),
  );
}

// Per run: the share of applicable checks passed.
const rows = records
  .filter((r) => byName.has(r.scenario))
  .map((r) => {
    const s = byName.get(r.scenario) as Scenario;
    const checks = r.error ? {} : score(r, s);
    const applicable = Object.values(checks).filter((v) => v !== null);
    return {
      r,
      checks,
      pass: applicable.filter((v) => v === true).length,
      of: applicable.length,
    };
  });

const groups = [...new Set(rows.map((x) => `${x.r.agent} (${x.r.model})`))];
const arms = ["before", "after"].filter((a) => rows.some((x) => x.r.arm === a));
const pct = (p: number, n: number) => (n ? `${Math.round((100 * p) / n)}%` : "–");
const sum = (xs: typeof rows) => [
  xs.reduce((a, x) => a + x.pass, 0),
  xs.reduce((a, x) => a + x.of, 0),
] as const;

const lines: string[] = [];
for (const g of groups) {
  const mine = rows.filter((x) => `${x.r.agent} (${x.r.model})` === g);
  lines.push(`### ${g}`, "");
  lines.push(`| Situation | ${arms.map((a) => `${a}`).join(" | ")} |`);
  lines.push(`|---|${arms.map(() => "---:").join("|")}|`);
  for (const s of scenarios) {
    const cells = arms.map((a) => {
      const xs = mine.filter((x) => x.r.scenario === s.name && x.r.arm === a);
      if (!xs.length) return "–";
      const [p, n] = sum(xs);
      const errs = xs.filter((x) => x.r.error).length;
      return `${pct(p, n)} (${p}/${n})${errs ? `, ${errs} failed to run` : ""}`;
    });
    lines.push(`| ${s.name}: ${s.what} | ${cells.join(" | ")} |`);
  }
  lines.push(
    `| **All** | ${arms
      .map((a) => {
        const [p, n] = sum(mine.filter((x) => x.r.arm === a));
        return `**${pct(p, n)}** (${p}/${n})`;
      })
      .join(" | ")} |`,
    "",
  );
  lines.push(`| Check | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---:").join("|")}|`);
  for (const c of CHECKS) {
    const cells = arms.map((a) => {
      const vs = mine
        .filter((x) => x.r.arm === a)
        .map((x) => x.checks[c.id])
        .filter((v) => v !== null && v !== undefined);
      return vs.length ? `${pct(vs.filter(Boolean).length, vs.length)} (${vs.filter(Boolean).length}/${vs.length})` : "–";
    });
    lines.push(`| ${c.label}${c.judge ? " (judge)" : ""} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("Failed checks:", "");
  for (const x of mine.filter((x) => x.r.arm === "after" || arms.length === 1)) {
    const failed = Object.entries(x.checks).filter(([, v]) => v === false).map(([k]) => k);
    if (failed.length || x.r.error)
      lines.push(
        `- ${x.r.arm} ${x.r.scenario} #${x.r.rep}: ${x.r.error ? `error: ${x.r.error.slice(0, 200)}` : failed.join(", ")}${x.r.judge?.notes ? `. Judge: ${x.r.judge.notes}` : ""}`,
      );
  }
  lines.push("");
}
console.log(lines.join("\n"));
