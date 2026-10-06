/**
 * The demo machine: the real CLI in its own config directory, scripted. It pairs through the
 * demo device, runs the agent with a scripted CodexBar for quota windows, keeps one question
 * open and a run going.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Broken, type DemoDevice } from "./device";

export interface MachineOptions {
  /** The command that runs the CLI, e.g. ["bun", "/app/starbridge.js"]. */
  cli: string[];
  server: string;
  /** The machine's HOME, which holds its config directory. */
  dir: string;
  /** The scripted CodexBar. */
  codexbar: string;
  /** Seconds between an answer and the next question. */
  nextQuestionAfter?: number;
  /** The command a run wraps. */
  runCommand?: string[];
  log?: (line: string) => void;
}

interface Question {
  project: string;
  session: string;
  question: string;
  context: string;
  options: string[];
}

/** Each answer brings the next; the list repeats. */
export const QUESTIONS: Question[] = [
  {
    project: "billing-api",
    session: "Retry failed invoice webhooks",
    question:
      "The staging migration added a NOT NULL column. Backfill it now, or ship with a default?",
    context:
      "Backfilling takes about 4 minutes on staging and locks the invoices table meanwhile. A default of 0 ships now; the backfill can run tonight.",
    options: ["Ship with a default", "Backfill now", "Hold the release"],
  },
  {
    project: "mobile-app",
    session: "Dark mode for settings",
    question: "Two snapshot tests fail on the new dark palette. Update the snapshots?",
    context: "The diffs are the new surface color only (#1C1B1F to #141218). No layout changed.",
    options: ["Update the snapshots", "Show me the diffs first"],
  },
  {
    project: "docs-site",
    session: "Move the guides to the new layout",
    question: "Redirect the 14 old guide URLs, or keep both layouts for a release?",
    context: "Redirects are one config file. Keeping both doubles the build time until removed.",
    options: ["Redirect them", "Keep both for a release"],
  },
];

/** Twelve minutes, then three idle: finished runs stay few, so the question stays in view. */
const RUN = ["sh", "-c", 'for i in $(seq 1 12); do echo "[$i/12] e2e suite"; sleep 60; done'];

export class DemoMachine {
  private readonly log: (line: string) => void;
  private readonly children = new Set<Bun.Subprocess>();

  constructor(
    private readonly opts: MachineOptions,
    private readonly device: DemoDevice,
  ) {
    this.log = opts.log ?? console.log;
  }

  private spawn(args: string[], stdout: "pipe" | "inherit" = "inherit", cwd?: string) {
    const child = Bun.spawn([...this.opts.cli, ...args], {
      cwd,
      // HOME too: the agent installs agent integrations (the Codex skill) under it.
      env: {
        ...process.env,
        HOME: this.opts.dir,
        STARBRIDGE_CONFIG_DIR: join(this.opts.dir, "starbridge"),
      },
      stdout,
      stderr: "inherit",
    });
    this.children.add(child);
    child.exited.finally(() => this.children.delete(child));
    return child;
  }

  stop() {
    for (const c of this.children) c.kill();
  }

  /** `starbridge pair`, approved by the demo device. */
  async pair(): Promise<void> {
    const child = this.spawn(["pair", "--server", this.opts.server, "--name", "demo-box"], "pipe");
    const decoder = new TextDecoder();
    let out = "";
    let approved = false;
    // Read to the end: a closed pipe would end `pair` with SIGPIPE.
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      out += decoder.decode(chunk);
      const code = /Pairing code: (\S+)/.exec(out)?.[1];
      if (code && !approved) {
        approved = true;
        await this.device.approvePairing(code);
      }
    }
    if ((await child.exited) !== 0) throw new Error(`pair failed:\n${out}`);
  }

  /** The agent uploads quota windows and re-seals open items to devices that join later (#365). */
  async agent(): Promise<never> {
    const child = this.spawn([
      "agent",
      "--codexbar",
      this.opts.codexbar,
      "--provider",
      "claude",
      "--provider",
      "codex",
      "--interval",
      "1m",
    ]);
    throw new Broken(`the agent exited with ${await child.exited}`);
  }

  /** Keeps one question open: posts the next a few seconds after each answer. */
  async questions(signal: AbortSignal): Promise<void> {
    let failures = 0;
    for (let i = 0; !signal.aborted; i++) {
      const q = QUESTIONS[i % QUESTIONS.length] as Question;
      const code = await this.spawn([
        "ask",
        "--question",
        q.question,
        "--context",
        q.context,
        ...q.options.flatMap((o) => ["--option", o]),
        "--waiting",
        "--wait",
        "--agent",
        "claude-code",
        "--project",
        q.project,
        "--session",
        `demo-${q.project}`,
        "--session-title",
        q.session,
      ]).exited;
      if (signal.aborted) return;
      // A revoked machine fails every ask: start over with a fresh account.
      failures = code === 0 ? 0 : failures + 1;
      if (failures >= 3) throw new Broken("three questions in a row failed");
      await Bun.sleep((code === 0 ? (this.opts.nextQuestionAfter ?? 5) : 10) * 1000);
    }
  }

  /** Keeps a run going most of the time: a suite that prints its progress, again and again. */
  async runs(signal: AbortSignal): Promise<void> {
    // A run's project is its directory's name.
    const project = join(this.opts.dir, "billing-api");
    mkdirSync(project, { recursive: true });
    while (!signal.aborted) {
      await this.spawn(
        [
          "run",
          "--title",
          "Nightly e2e",
          "--reason",
          "uses the shared staging database",
          "--",
          ...(this.opts.runCommand ?? RUN),
        ],
        "inherit",
        project,
      ).exited;
      await Bun.sleep(180_000);
    }
  }
}
