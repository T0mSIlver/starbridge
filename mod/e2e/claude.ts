/**
 * Drives a real interactive Claude Code session in a detached tmux window and reads its
 * transcript, so a script can tell when the session is idle and when a prompt reached it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

export interface Entry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
}

/** The text a user entry carries, or undefined for tool results and other entries. */
export function userText(e: Entry): string | undefined {
  if (e.type !== "user") return undefined;
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return undefined;
  const texts = c.filter((b) => b?.type === "text").map((b) => b.text as string);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Each Bash command the assistant ran. */
export function bashCommands(entries: Entry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content as {
      type?: string;
      name?: string;
      input?: { command?: string };
    }[])
      if (b.type === "tool_use" && b.name === "Bash" && b.input?.command) out.push(b.input.command);
  }
  return out;
}

export async function until<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (true) {
    const v = await probe();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000} s: ${what}`);
    await Bun.sleep(everyMs);
  }
}

export class Claude {
  readonly tmux: string;
  /** The session id the window runs under now; a /clear changes it. */
  sessionId: string;

  constructor(
    readonly name: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly args: string[],
  ) {
    this.tmux = `sb-e2e-${name}`;
    this.sessionId = crypto.randomUUID();
  }

  get projectDir(): string {
    return join(homedir(), ".claude", "projects", this.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  }

  transcript(id = this.sessionId): Entry[] {
    const path = join(this.projectDir, `${id}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Entry];
        } catch {
          return [];
        }
      });
  }

  async start(): Promise<void> {
    await $`tmux kill-session -t ${this.tmux}`.quiet().nothrow();
    // A clean environment: nothing from the session or app that runs this script.
    const keep = ["HOME", "USER", "LANG", "PATH", "SHELL"];
    const base = Object.fromEntries(
      keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
    );
    const env = Object.entries({ ...base, TERM: "xterm-256color", ...this.env }).map(
      ([k, v]) => `${k}=${v}`,
    );
    const cmd = ["env", "-i", ...env, "claude", "--session-id", this.sessionId, ...this.args];
    await $`tmux new-session -d -s ${this.tmux} -x 200 -y 50 -c ${this.cwd} ${cmd}`;
    // The folder-trust question on a first start in a new folder.
    await until(
      "the prompt",
      async () => {
        const p = await this.pane();
        // "No, exit" is preselected.
        if (/I trust this folder/.test(p)) {
          await $`tmux send-keys -t ${this.tmux} Down`.quiet();
          await Bun.sleep(300);
          await $`tmux send-keys -t ${this.tmux} Enter`.quiet();
          return undefined;
        }
        return /^❯/m.test(p) && /^\s*─{20}/m.test(p) ? true : undefined;
      },
      60_000,
      500,
    );
  }

  async pane(): Promise<string> {
    return (await $`tmux capture-pane -p -t ${this.tmux}`.quiet().nothrow()).stdout.toString();
  }

  /** Types `text` into the prompt and submits it. */
  async send(text: string): Promise<void> {
    await $`tmux send-keys -t ${this.tmux} -l ${text}`.quiet();
    await Bun.sleep(300);
    await $`tmux send-keys -t ${this.tmux} Enter`.quiet();
  }

  async busy(): Promise<boolean> {
    return /esc to interrupt/i.test(await this.pane());
  }

  /** Waits until no turn has run for `quietMs`. */
  async idle(timeoutMs = 300_000, quietMs = 2_000): Promise<void> {
    let since = Date.now();
    await until(
      `${this.name} idle`,
      async () => {
        if (await this.busy()) since = Date.now();
        return Date.now() - since >= quietMs ? true : undefined;
      },
      timeoutMs,
    );
  }

  /** The first user prompt in transcript `id` containing `needle`, with its time. */
  prompt(needle: string, id = this.sessionId): { at: number; text: string } | undefined {
    for (const e of this.transcript(id)) {
      const t = userText(e);
      if (t?.includes(needle)) return { at: Date.parse(e.timestamp ?? ""), text: t };
    }
    return undefined;
  }

  /** Every transcript of this folder that mentions `needle` in a user prompt. */
  sessionsWith(needle: string): string[] {
    if (!existsSync(this.projectDir)) return [];
    return readdirSync(this.projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6))
      .filter((id) => this.prompt(needle, id));
  }

  /** The newest transcript in this folder other than `not`: the id a /clear moved to. */
  newestSession(not: string): string | undefined {
    const files = readdirSync(this.projectDir)
      .filter((f) => f.endsWith(".jsonl") && f !== `${not}.jsonl`)
      .map((f) => ({ f, t: statSync(join(this.projectDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files[0]?.f.slice(0, -6);
  }

  async stop(): Promise<void> {
    await $`tmux kill-session -t ${this.tmux}`.quiet().nothrow();
  }
}
