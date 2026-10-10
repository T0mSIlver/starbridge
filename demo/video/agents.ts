/**
 * The demo's agents: what each asks, what it runs once answered, and the lines it prints around
 * the real CLI's. `Agent` runs the real CLI on its machine and notes when each step happened;
 * frame.html draws its terminal from `toJSON()`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cli, type MACHINES } from "./stack";

export interface Script {
  machine: keyof typeof MACHINES;
  agent: "claude-code" | "codex";
  project: string;
  session: string;
  prompt: string;
  /** The tool call already on screen: name, argument, result. */
  tool: [string, string, string];
  why: string;
  question: { question: string; context: string; options: string[] };
  /** The option the demo picks. */
  answer: string;
  /** The image's file name as the terminal shows it; question.html renders it. */
  image?: string;
  next: string;
  /** Prints `steps` one per `every` seconds, the first at once. */
  run?: { title: string; reason: string; command: string; every: number; steps: string[] };
  done: string;
}

/** A call only the owner can make: which model the full eval spends money on. */
export const EVAL: Script = {
  machine: "workstation",
  agent: "claude-code",
  project: "web-app",
  session: "Search ranking prompt",
  prompt: "Tune the search ranking prompt in web-app, then run the full eval.",
  tool: ["Edit", "prompts/rank.md", "Updated 14 lines"],
  why: "The sample looks good. The full eval costs real money, so the model is your call.",
  question: {
    question: "Full eval of the new ranking prompt: which model?",
    context: "2,000 prompts on rented H100s. The table has the 50-prompt sample.",
    options: ["Large, ~$14", "Small, ~$2", "Skip the full eval"],
  },
  answer: "Large, ~$14",
  image: "sample.png",
  next: "Running the full eval on Large.",
  run: {
    title: "Eval: ranking prompt",
    reason: "2,000 prompts on 4 rented H100s, about $14",
    command: "./eval.sh --model large",
    // One step per 10 s: the CLI sends progress at most that often, and the video speeds it up.
    every: 10.5,
    steps: [
      "[0/5] renting 4 H100s",
      "[1/5] 400 of 2,000 prompts · score 0.87 · $2.71",
      "[2/5] 800 of 2,000 prompts · score 0.86 · $5.46",
      "[3/5] 1,200 of 2,000 prompts · score 0.86 · $8.19",
      "[4/5] 1,600 of 2,000 prompts · score 0.86 · $10.90",
      "[5/5] 2,000 of 2,000 prompts · score 0.86 · $13.62",
    ],
  },
  done: "Done. 0.86 on 2,000 prompts against 0.79 in prod, for $13.62. Ready to ship.",
};

/** A second agent on another machine, for the inbox cut: a pricing call. */
export const PRICING: Script = {
  machine: "build-server",
  agent: "codex",
  project: "billing-api",
  session: "Retire legacy tiers",
  prompt: "Retire the legacy pricing tiers in billing-api.",
  tool: ["Read", "src/plans/tiers.ts", "84 lines"],
  why: "1,284 plans are still on the legacy tiers. Where they go is a pricing call.",
  question: {
    question: "Move the 1,284 legacy-tier plans to which plan?",
    context: "Standard costs the same; Pro costs $4 more after 3 free months.",
    options: ["Standard", "Pro, 3 months free", "Keep legacy"],
  },
  answer: "Standard",
  next: "Mapping both legacy tiers to Standard.",
  done: "Done. Legacy tiers map to Standard from Nov 1, at the same price.",
};

export interface Line {
  t: number;
  text: string;
}

const output = async (p: Bun.Subprocess<"ignore", "pipe", "inherit">) => {
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0) throw new Error(`the CLI failed:\n${out}`);
  return out;
};

export class Agent {
  id = "";
  asked?: number;
  answered?: number;
  answer = "";
  running?: number;
  ran?: number;
  readonly lines: Line[] = [];
  private readonly children: Bun.Subprocess[] = [];
  private readonly cwd: string;

  /** `clock()` gives the take's time in seconds. */
  constructor(
    readonly script: Script,
    private readonly dir: string,
    private readonly clock: () => number,
  ) {
    this.cwd = join(dir, script.machine, script.project);
    mkdirSync(this.cwd, { recursive: true });
  }

  private cli(args: string[]) {
    const p = cli(this.dir, this.script.machine, args, this.cwd);
    this.children.push(p);
    return p;
  }

  /** Posts the question, waiting for the owner: `ask --wait` in two steps, so `stop` can withdraw it. */
  async ask(image?: string): Promise<void> {
    const { script } = this;
    this.asked = this.clock();
    const q = script.question;
    this.id = (
      await output(
        this.cli([
          ...["ask", "--question", q.question, "--context", q.context],
          ...q.options.flatMap((o) => ["--option", o]),
          ...(image ? ["--image", image] : []),
          ...["--waiting", "--agent", script.agent, "--project", script.project],
          ...["--session", `demo-${script.project}`, "--session-title", script.session],
        ]),
      )
    ).split("\n")[0] as string;
  }

  /** Waits for the answer; past `seconds`, the take failed. */
  async wait(seconds: number): Promise<void> {
    const wait = this.cli(["wait", this.id]);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      wait.kill();
    }, seconds * 1000);
    try {
      this.answer = await output(wait);
    } catch (e) {
      if (late)
        throw new Error(`no answer to "${this.script.question.question}" within ${seconds} s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    this.answered = this.clock();
  }

  /** Runs the script's run, noting when each line printed. */
  async run(): Promise<void> {
    const { run } = this.script;
    if (!run) return;
    this.running = this.clock();
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const sh = run.steps.map((step) => `echo ${quote(step)}`).join(`; sleep ${run.every}; `);
    const p = this.cli(["run", "--title", run.title, "--reason", run.reason, "--", "sh", "-c", sh]);
    let pending = "";
    for await (const chunk of p.stdout) {
      pending += new TextDecoder().decode(chunk);
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        this.lines.push({ t: this.clock(), text: pending.slice(0, i) });
        pending = pending.slice(i + 1);
      }
    }
    if ((await p.exited) !== 0) throw new Error(`run "${run.title}" failed`);
    this.ran = this.clock();
  }

  /** Stops the CLI and withdraws the question if it was never answered. */
  async stop(): Promise<void> {
    for (const child of this.children) child.kill();
    if (this.id && !this.answer)
      await cli(this.dir, this.script.machine, [
        "settle",
        this.id,
        "--outcome",
        "withdrawn",
        "--reason",
        "The demo take stopped",
      ]).exited;
  }

  toJSON() {
    const { script } = this;
    return {
      ...script,
      question: { question: script.question.question, options: script.question.options },
      asked: this.asked,
      answered: this.answered,
      answer: this.answer,
      running: this.running,
      ran: this.ran,
      lines: this.lines,
    };
  }
}
