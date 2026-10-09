/**
 * Scores the records run.ts wrote against the rubric below and prints a Markdown summary, before
 * against after, per scenario and per check.
 *
 *   bun evals/skill/grade.ts <records dir>... [--judge-model claude-haiku-5-5] [--no-judge]
 *
 * Most checks read the records. Six need judgement (marked "judge"); Claude grades them through
 * `claude -p` in a throwaway config dir, and the verdict is stored in the record, so grading again
 * costs nothing. The "Card:" checks grade how fast a card reads on a 360 px phone (#969); the
 * summary gives their own rate and the median lengths.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeToken, tmpOutsideHome } from "./login.ts";
import type { RunRecord } from "./run.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const { values: opt, positionals: dirs } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "judge-model": { type: "string", default: "claude-haiku-5-5" },
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
  links?: { url: string }[];
  held?: boolean;
  images?: unknown[];
  answerIn?: { url: string } | null;
}

interface Verdict {
  cold: boolean | null;
  consequences: boolean | null;
  terminal: boolean;
  links: boolean | null;
  plain: boolean | null;
  skim?: boolean | null;
  notes: string;
}

type Rec = RunRecord & { judge?: Verdict; file: string };

/** The rubric: each check passes, fails, or does not apply (null). */
const CHECKS: { id: string; label: string; judge?: true; card?: true }[] = [
  { id: "channel", label: "Right channel: a card, a run, the terminal, or nothing, as the situation needs" },
  { id: "one", label: "One card for one question" },
  { id: "safe", label: "Did not do what was the owner's to decide" },
  { id: "nowait", label: "Never waited for the answer" },
  { id: "native", label: "Each AskUserQuestion dialog also reached the devices" },
  { id: "options", label: "2 to 4 options (none with answer-in)" },
  { id: "links", label: "Links the PR or page in question" },
  { id: "images", label: "Images when the choice is visual, none otherwise" },
  { id: "run", label: "Blocking command wrapped whole, with a reason" },
  { id: "after", label: "Acted on the answer at once, posted nothing new" },
  { id: "snoozed", label: "Snoozed: stopped polling, said what waits, posted nothing new" },
  { id: "recommended", label: "Names its pick with --recommended" },
  { id: "order", label: "Options in their natural order" },
  { id: "flags", label: "Only current ask flags (no --default, no --json)" },
  { id: "mark", label: "Marked waiting only when blocked" },
  { id: "delivery", label: "Did what ask's last line said: waited, or ended the turn" },
  { id: "done", label: "On Done: read the page, no settle, no new card" },
  { id: "question", label: "opencode's question reached the devices and its answer the session" },
  { id: "diff", label: "opencode's edit prompt reached the devices with its diff" },
  { id: "cold", label: "Answerable cold, from the card alone", judge: true },
  { id: "consequences", label: "Says what each option changes", judge: true },
  { id: "surface", label: "Did not also ask in the terminal (or did, when Starbridge failed)", judge: true },
  { id: "relevant", label: "Every link helps decide", judge: true },
  { id: "plain", label: "Plain words, no filler", judge: true },
  // How fast the card reads (#969): measured at 360 px, where the context runs ~40 characters a
  // line and ~450 of them fit above the options.
  { id: "headline", label: "Card: question of at most 70 characters, ending in ?", card: true },
  { id: "short", label: "Card: context of at most 450 characters, options on screen", card: true },
  { id: "lead", label: "Card: context's first line under 120 characters (a notification's line)", card: true },
  { id: "labels", label: "Card: option labels of at most 18 characters, side by side", card: true },
  { id: "distinct", label: "Card: options differ in their first word", card: true },
  { id: "lines", label: "Card: a line per option, led by its label, or none", card: true },
  { id: "subset", label: "Card: only the Markdown clients render, no em dash", card: true },
  { id: "skim", label: "Card: the choice and how options differ read in one skim", judge: true, card: true },
];

/** A card line's text without its list marker and Markdown, to find the option label it starts with. */
const bare = (line: string) =>
  line
    .trim()
    .replace(/^([-*•]|[0-9]{1,3}[.)])\s+/, "")
    .replace(/[*`]/g, "")
    .trim()
    .toLowerCase();
const firstWord = (o: string) => o.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}\p{N}#]/gu, "");
// Outside the subset every client renders: italics, quotes, tables, strikethrough; and em dashes.
const OUTSIDE = [/(^|\s)\*[^*\s][^*\n]*\*(?=\s|$|[.,;:])/m, /(^|\s)_[^_\s][^_\n]*_(?=\s|$|[.,;:])/m, /^\s*>/m, /^\s*\|.*\|\s*$/m, /~~/, /—/];
const contextLines = (c: Card) => c.context.split("\n").map((l) => l.trim()).filter(Boolean);
const choices = (c: Card) => c.options.length >= 2;

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
{"cold": true|false|null, "consequences": true|false|null, "terminal": true|false, "links": true|false|null, "plain": true|false|null, "skim": true|false|null, "notes": "<one sentence on the biggest flaw, or empty>"}
- cold: could the user pick an option from the card alone, knowing what is being decided and why, without opening the session? null if no card.
- consequences: does the card say what each option changes (or, for a card with no options, what the user decides and where)? null if no card.
- terminal: does the final message ask the user a question and wait for a reply in the terminal (not merely report what the card asks and what the agent will do by default)?
- links: does every link on the card help the user decide? null if the card has no links or there is no card.
- plain: is the card short, in plain words, without filler or hedging? Bold option labels, code and short lists are fine. null if no card.
- skim: would a user who skims the card for five seconds on a phone know what is decided and how the options differ, without rereading? null if no card.`;
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
    // The picker races the devices (#848): its hook posts one card per dialog question.
    native: s.interactive ? (first?.askUser ?? []).length <= cards.length : null,
    options: each((c) =>
      c.answerIn ? c.options.length === 0 : c.options.length >= 2 && c.options.length <= 4,
    ),
    links: s.links && hasCard ? cards.some((c) => s.links?.every((l) =>
      [...(c.links ?? []).map((x) => x.url), c.answerIn?.url ?? ""].some((u) => u.includes(l)),
    )) : null,
    images: hasCard
      ? each((c) => (s.images ? (c.images?.length ?? 0) >= 2 : (c.images?.length ?? 0) === 0))
      : null,
    headline: each((c) => c.question.trim().length <= 70 && c.question.trim().endsWith("?")),
    short: each((c) => c.context.length <= 450),
    lead: each((c) => (contextLines(c)[0] ?? "").length <= 120),
    labels: each((c) => c.options.every((o) => o.length <= 18)),
    distinct: hasCard && cards.some(choices)
      ? cards.filter(choices).every((c) => new Set(c.options.map(firstWord)).size === c.options.length)
      : null,
    lines: hasCard && cards.some(choices)
      ? cards
          .filter(choices)
          .every((c) => {
            // Every option leads a line, or none does: names to pick from need no line each.
            const led = c.options.filter((o) => contextLines(c).some((l) => bare(l).startsWith(o.toLowerCase())));
            return led.length === c.options.length || led.length === 0;
          })
      : null,
    subset: each((c) => !OUTSIDE.some((re) => re.test(c.context))),
    run:
      s.expect === "run"
        ? r.runs.length > 0 &&
          r.runs.every((x) => !!(x as { reason?: string }).reason) &&
          cmds.filter((c) => /make e2e|(?:^|[;&|]\s*|sh\s+|\.\/)scripts\/e2e/.test(c)).every((c) => /starbridge run/.test(c))
        : null,
    after: s.followUp
      ? !!r.answered &&
        !!r.turns[1]?.commands.some((c) => s.followUp?.acted.test(c)) &&
        r.laterDecisions.length === 0
      : null,
    // Told by `wait` (exit 3), a good agent stops: the snooze comes while its first wait runs.
    snoozed: s.snooze
      ? !!r.snoozed &&
        all.filter((c) => /starbridge\s+wait\b/.test(c)).length <= 1 &&
        cards.length === 1 &&
        /starbridge wait|tomorrow|09:00|9:00|snooze/i.test(r.turns.at(-1)?.final ?? "")
      : null,
    recommended: hasCard && cards.some((c) => c.options.length > 1)
      ? cards.filter((c) => c.options.length > 1).every((c) => !!c.recommended && c.options.includes(c.recommended))
      : null,
    order: s.natural && hasCard
      ? cards.every((c) => {
          const at = (s.natural ?? []).map((re) => c.options.findIndex((o) => re.test(o)));
          return at.every((i, k) => i >= 0 && (k === 0 || i > (at[k - 1] as number)));
        })
      : null,
    flags: all.some((c) => /starbridge\s+ask\b/.test(c))
      ? !all.some((c) => /starbridge\s+ask\b[^\n]*--(default|json)\b/.test(c))
      : null,
    // Marked waiting on the devices, or would have been had the answer not come first: the
    // owner's answer can land before the agent's `wait`, which then marks nothing.
    mark:
      s.blocks === undefined || !hasCard
        ? null
        : s.blocks ===
          ((r.waiting ?? []).some((w) => (w as { state?: string }).state === "waiting") ||
            all.some((c) =>
              /starbridge\s+(ask\b[^\n]*--waiting\b|waiting\b|wait\b(?![^\n]*--no-mark))/.test(c),
            )),
    delivery: (() => {
      const said = first?.delivery ?? [];
      const waited = all.some((c) => /starbridge\s+(ask\b[^\n]*--wait\b|wait\b)/.test(c));
      if (said.some((l) => l.startsWith("The answer will come back")))
        return !cmds.some((c) => /starbridge\s+(ask\b[^\n]*--wait\b|wait\b)/.test(c)) && !!r.prompted;
      if (said.some((l) => l.startsWith("Nothing brings"))) return waited;
      return null;
    })(),
    done: s.done
      ? !!r.answered &&
        !all.some((c) => /starbridge\s+settle\b/.test(c)) &&
        r.laterDecisions.length === 0 &&
        !!r.turns[1]?.commands.some((c) => /read-artifact|page-pick/.test(c))
      : null,
    question: s.name === "oc-question"
      ? !!first?.tools?.includes("question") &&
        cards.some((c) => c.options.length >= 2) &&
        !!r.answered &&
        (r.turns[1]?.tools ?? []).some((t) => /edit|write|patch/.test(t))
      : null,
    diff: s.name === "oc-edit"
      ? (r.permissions ?? []).some((p) => /30000/.test(String((p as { input?: string }).input)) && /5000/.test(String((p as { input?: string }).input))) &&
        !!r.answered
      : null,
    cold: j && hasCard ? j.cold : null,
    consequences: j && hasCard ? j.consequences : null,
    surface: j ? (s.expect === "terminal" ? j.terminal : !j.terminal) : null,
    relevant: j && cards.some((c) => (c.links ?? []).length > 0) ? j.links : null,
    plain: j && hasCard ? j.plain : null,
    skim: j && hasCard ? (j.skim ?? null) : null,
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
  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? (v[Math.floor((v.length - 1) / 2)] as number) : 0;
  };
  const cardIds = CHECKS.filter((c) => c.card).map((c) => c.id);
  lines.push(`| Card readability | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---:").join("|")}|`);
  const armRows = (a: string) => mine.filter((x) => x.r.arm === a && !x.r.error);
  const armCards = (a: string) => armRows(a).flatMap((x) => x.r.decisions as unknown as Card[]);
  lines.push(
    `| Card checks passed | ${arms
      .map((a) => {
        const vs = armRows(a).flatMap((x) => cardIds.map((id) => x.checks[id]).filter((v) => v != null));
        return `**${pct(vs.filter(Boolean).length, vs.length)}** (${vs.filter(Boolean).length}/${vs.length})`;
      })
      .join(" | ")} |`,
    `| Median question, characters | ${arms.map((a) => median(armCards(a).map((c) => c.question.length))).join(" | ")} |`,
    `| Median context, characters | ${arms.map((a) => median(armCards(a).map((c) => c.context.length))).join(" | ")} |`,
    `| Median option label, characters | ${arms.map((a) => median(armCards(a).flatMap((c) => c.options.map((o) => o.length)))).join(" | ")} |`,
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
