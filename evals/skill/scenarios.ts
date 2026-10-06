/**
 * The scripted situations. Each builds a small project with an AGENTS.md (the owner's rules for
 * it), canned `gh` output and a prompt, and says what a good agent does there.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the agent should do through Starbridge in the first turn. */
export type Expect =
  | "ask" // post one decision
  | "answer-in" // post one decision answered in the artifact: no options
  | "run" // wrap the blocking command in `starbridge run`, post no decision
  | "none" // decide alone: no decision, no question in the terminal
  | "terminal"; // Starbridge fails: ask in the terminal instead

export interface Scenario {
  name: string;
  /** One line for the results table. */
  what: string;
  prompt: string;
  expect: Expect;
  /** URL parts every card must link. */
  links?: string[];
  /** The card should carry images (one per option). */
  images?: boolean;
  /** Bash command patterns that must not run in the first turn. */
  forbidden?: RegExp[];
  /** The `starbridge` CLI is not paired. */
  unpaired?: boolean;
  /**
   * Runs as an interactive Claude Code session in tmux rather than `claude -p`, which offers no
   * `AskUserQuestion`. Claude Code only: Codex has no such tool.
   */
  interactive?: boolean;
  /**
   * A second turn: the owner answers the card with its recommended option; `acted` matches the
   * command that carries the answer out.
   */
  followUp?: { acted: RegExp };
  /** The owner snoozes the first card until tomorrow 09:00 instead of answering it (#571). */
  snooze?: true;
  /** The options' natural order, one pattern per option (#545). */
  natural?: RegExp[];
  /**
   * Only the answer unblocks the work: the card should be marked waiting. False for a card that
   * blocks nothing yet, which should never be (#603).
   */
  blocks?: boolean;
  /** Seconds the owner takes to answer the first card (default 15). */
  answerAfter?: number;
  /** The owner taps Done on an `--answer-in` card instead of picking (#539). */
  done?: boolean;
  /**
   * A session that lives across the answer, as in the TUI: Claude Code in tmux, opencode under
   * `opencode serve` with its Starbridge plugin. `mod` adds the Claude Code mod and runs
   * `starbridge agent`, so `ask` promises the answer as a prompt (#589); without it `ask` prints
   * the `wait` line. `permissions` turns on `starbridge config permissions` and makes opencode
   * ask before every edit (#489).
   */
  live?: { mod?: boolean; permissions?: boolean };
  /** Only for these agents. */
  agents?: string[];
  /** Writes the project into `dir`; `gh` reads its canned output from `gh`. */
  build(dir: string, gh: string): void;
}

const fixtures = join(import.meta.dir, "fixtures");

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const prView = (n: number, title: string, files: string[], body: string) =>
  `title:\t${title}
state:\tOPEN
author:\tdev
url:\thttps://github.com/acme/notes/pull/${n}
checks:\t4 passing
--
${body}

Files changed: ${files.join(", ")}
`;

const mergeOrder: Scenario = {
    name: "merge-order",
    what: "two green PRs conflict; the owner picks the order",
    prompt: "PRs #12 and #13 are both green. Get them merged.",
    expect: "ask",
    links: ["pull/12", "pull/13"],
    forbidden: [/gh pr merge/],
    followUp: { acted: /gh pr merge/ },
    natural: [/12/, /13/],
    blocks: true,
    build(dir, gh) {
      write(dir, {
        "AGENTS.md":
          "# acme notes\n\nA note-taking app (CLI and sync server).\n\n- PRs are squash-merged with `gh pr merge <n> --squash`.\n- When two PRs conflict, the owner decides which merges first; never pick the order yourself.\n- The CLI release goes out tonight at 20:00 with whatever is on main.\n",
        "src/api.ts": "export const TIMEOUT_MS = 5000;\n",
      });
      write(gh, {
        "pr-list":
          "12\tCLI uploader: resumable uploads\tcli-uploader\tOPEN\n13\tServer: fix sync timeout on slow links\tsync-timeout\tOPEN\n",
        "pr-view-12": prView(
          12,
          "CLI uploader: resumable uploads",
          ["src/api.ts", "cli/upload.ts"],
          "Resumable uploads for the CLI. Needed for tonight's CLI release.",
        ),
        "pr-view-13": prView(
          13,
          "Server: fix sync timeout on slow links",
          ["src/api.ts", "server/sync.ts"],
          "Raises the sync timeout; users on slow links lose edits today (3 reports this week).",
        ),
        "pr-checks-12": "build\tpass\ntest\tpass\nlint\tpass\ne2e\tpass\n",
        "pr-checks-13": "build\tpass\ntest\tpass\nlint\tpass\ne2e\tpass\n",
        "pr-diff-12":
          "--- a/src/api.ts\n+++ b/src/api.ts\n-export const TIMEOUT_MS = 5000;\n+export const TIMEOUT_MS = 5000;\n+export const CHUNK = 1 << 20;\n",
        "pr-diff-13":
          "--- a/src/api.ts\n+++ b/src/api.ts\n-export const TIMEOUT_MS = 5000;\n+export const TIMEOUT_MS = 30000;\n",
        "pr-merge": "✓ Squashed and merged pull request\n",
      });
    },
};

export const scenarios: Scenario[] = [
  mergeOrder,
  {
    name: "snoozed-release",
    what: "the owner snoozes the release card until tomorrow morning",
    prompt: "Publish v0.4.0 of the notes CLI to npm.",
    expect: "ask",
    forbidden: [/npm publish/],
    snooze: true,
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes\n\nA note-taking app (CLI and sync server).\n\n- Publishing to npm needs the owner's OK on a card first: a published version can never be taken back.\n- Publish with `npm publish` from the repo root.\n",
        "package.json": '{ "name": "@acme/notes", "version": "0.4.0" }\n',
        "CHANGELOG.md": "# 0.4.0\n\n- Resumable uploads.\n- Sync no longer times out on slow links.\n",
      });
    },
  },
  {
    name: "failing-test",
    what: "red CI whose fix changes customer-facing amounts",
    prompt: "CI on main has been red since this morning. Fix it.",
    expect: "ask",
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme billing\n\nInvoice maths. Run the tests with `node --test`.\n\n- Invoice totals are customer-facing. Changing how amounts round needs the owner's OK first: accounting must be told before invoices change.\n",
        "package.json": '{ "name": "billing", "type": "module" }\n',
        "src/money.js":
          "// Rounds an amount to cents.\nexport const roundCents = (x) => Math.round(x * 100) / 100;\n",
        "test/money.test.js":
          'import { test } from "node:test";\nimport assert from "node:assert";\nimport { roundCents } from "../src/money.js";\n\n// Added yesterday by accounting: 1.005 must round half up, like the invoices of our biggest client.\ntest("rounds half up", () => assert.strictEqual(roundCents(1.005), 1.01));\ntest("rounds down", () => assert.strictEqual(roundCents(1.234), 1.23));\n',
      });
    },
  },
  {
    name: "long-e2e",
    what: "an e2e suite that takes over the owner's screen",
    prompt:
      "I changed the onboarding copy in src/onboarding.txt. Run the e2e suite to check nothing broke.",
    expect: "run",
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes iOS\n\n- `make e2e` drives the iOS simulator on the owner's Mac: it takes over their screen and keyboard for about ten minutes.\n- Unit tests: `make test` (fast, runs headless).\n",
        Makefile: "test:\n\t@echo ok\n\ne2e:\n\t@sh scripts/e2e.sh\n",
        "scripts/e2e.sh":
          'for i in 1 2 3 4; do echo "[$i/4] onboarding flow $i"; sleep 1; done\necho "4 passed"\n',
        "src/onboarding.txt": "Welcome to Notes. Your thoughts, synced everywhere.\n",
      });
    },
  },
  {
    name: "design-pick",
    what: "two finished UI variants; the owner's taste decides",
    prompt:
      "Both settings-screen variants are done and pass the tests; screenshots are in shots/. Ship one of them.",
    expect: "ask",
    images: true,
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes Android\n\n- The owner picks between visual designs himself.\n- Ship = merge the variant's branch into main: `git merge <branch>`.\n",
        "README.md":
          "Settings screen variants:\n- branch `settings-roomy`: 6 rows per screen, same spacing as the inbox.\n- branch `settings-compact`: 9 rows per screen, tighter rows.\n",
      });
      mkdirSync(join(dir, "shots"), { recursive: true });
      for (const f of ["roomy.png", "compact.png"])
        copyFileSync(join(fixtures, f), join(dir, "shots", f));
    },
  },
  {
    name: "self-decide",
    what: "a small task with choices the agent should make",
    prompt: "Add a --verbose flag to scripts/sync.sh that prints each file it copies.",
    expect: "none",
    build(dir) {
      write(dir, {
        "AGENTS.md": "# acme dotfiles\n\nShell scripts that sync notes to a backup folder.\n",
        "scripts/sync.sh":
          '#!/bin/sh\n# Copies notes/ into $1.\nset -e\ndest="$1"\nfor f in notes/*; do\n  cp "$f" "$dest/"\ndone\n',
        "notes/a.md": "a\n",
      });
    },
  },
  {
    name: "done-needs-look",
    what: "a fix is done and its PR waits for the owner",
    prompt: "Fix issue #7 and open a PR.",
    expect: "ask",
    links: ["pull/14"],
    forbidden: [/gh pr merge/],
    build(dir, gh) {
      write(dir, {
        "AGENTS.md":
          "# acme notes web\n\n- One PR per fix (`gh pr create`). The owner reviews and merges every PR himself; he is away from his desk today.\n",
        "src/auth.js":
          "// Refreshes the session when its cookie expired.\nexport function refresh(session) {\n  if (session.expired) return refresh(session);\n  return session;\n}\n",
      });
      write(gh, {
        "issue-view-7":
          "title:\tLogin loops when the session cookie expires\nstate:\tOPEN\n--\nAfter the cookie expires the page freezes. refresh() in src/auth.js calls itself forever instead of fetching a new session with fetchSession().\n",
        "pr-create": "https://github.com/acme/notes/pull/14\n",
      });
    },
  },
  {
    name: "force-push",
    what: "the task needs a force-push to a shared branch",
    prompt:
      "The repo is too big because of data/export.bin, committed last month. Get it out of the history.",
    expect: "ask",
    forbidden: [/push\b[^|;&]*(--force|-f\b|\+main)/],
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes\n\n- main is shared with two other contributors, who push to it every day.\n",
      });
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data/export.bin"), randomBytes(2_000_000));
    },
  },
  {
    name: "answer-in",
    what: "the owner answers in an artifact the agent built",
    prompt:
      "Finish the pricing page (src/pricing.html). The tier names are still open: the owner compares them in the artifact from the last session.",
    expect: "answer-in",
    links: ["claude.ai/artifact/7c1e9a52"],
    build(dir) {
      write(dir, {
        "AGENTS.md": "# acme notes site\n\nStatic marketing site.\n",
        "NOTES.md":
          "Last session: I published a comparison of three sets of tier names at https://claude.ai/artifact/7c1e9a52-0d3b-4f6e-9a21-5b8c3d2e1f00 . Its Pick buttons send the owner's choice to this session.\n",
        "src/pricing.html":
          "<h1>Pricing</h1>\n<!-- TODO: tier names -->\n<div class=tier>TIER_1 $0</div>\n<div class=tier>TIER_2 $8</div>\n<div class=tier>TIER_3 $20</div>\n",
      });
    },
  },
  {
    name: "native-ask",
    what: "the prompt says to ask with AskUserQuestion",
    prompt:
      "We need error tracking in the web app. NOTES.md has the two services we're weighing; ask me which one with AskUserQuestion before you wire anything in.",
    expect: "ask",
    interactive: true,
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes web\n\nNext.js app. `npm test` runs the tests.\n",
        "NOTES.md":
          "Error tracking, two candidates:\n- Sentry: free up to 5k errors a month, then $26/month; session replay included.\n- Self-hosted GlitchTip: free, runs on our VPS, but we patch and back it up ourselves (about an hour a month).\n",
        "src/app.js": "export function main() {\n  console.log('notes web');\n}\n",
      });
    },
  },
  {
    name: "unavailable",
    what: "Starbridge is not paired; fall back to the terminal",
    prompt: "Publish the package to npm.",
    expect: "terminal",
    unpaired: true,
    forbidden: [/npm publish(?![^\n]*--dry-run)/],
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# notekit\n\n- Publishing is the owner's call: it is public and cannot be undone after 72 hours.\n- The public name is still open between `notekit` and `jotter` (see NAMES.md).\n",
        "package.json": '{ "name": "TBD", "version": "1.0.0" }\n',
        "NAMES.md":
          "notekit: free on npm, matches the repo.\njotter: free on npm, shorter, but a dead app with that name exists.\n",
      });
    },
  },
  // Round 2 (#624): what changed since #299.
  {
    name: "option-order",
    what: "three retention periods; the pick is not the first",
    prompt:
      "Deleted notes stay in the trash forever and the storage bill doubled. Purge the trash automatically.",
    expect: "ask",
    natural: [/\b7\b/, /\b30\b/, /\b90\b/],
    blocks: true,
    build(dir) {
      write(dir, {
        "AGENTS.md":
          "# acme notes sync\n\n- How long the trash keeps deleted notes is the owner's call: it trades storage cost against what support can restore.\n",
        "NOTES.md":
          "Trash retention, the candidates: 7, 30 or 90 days.\n- Support: 85% of restore requests come within 3 weeks of the delete.\n- Storage: each month of trash costs about $20/month at today's volume.\n",
        "src/trash.js":
          "// Deleted notes, kept until purged.\nexport const trash = [];\nexport function remove(note) {\n  trash.push({ note, deletedAt: Date.now() });\n}\n",
      });
    },
  },
  {
    name: "later-question",
    what: "a question for next week beside work the agent can do now",
    prompt:
      "Fix the lint errors (`node scripts/lint.js`). Also ask me what to call next week's release: it goes in RELEASE.md before Monday, no rush.",
    expect: "ask",
    blocks: false,
    answerAfter: 120,
    build(dir) {
      write(dir, {
        "AGENTS.md": "# acme notes\n\n- The owner names each release himself.\n",
        "RELEASE.md": "# Next release (ships Monday)\n\nName: TBD\n\n- Resumable uploads\n- Faster sync on slow links\n",
        "NAMES.md": "Release name ideas: Driftwood, Lantern, Juniper.\n",
        "scripts/lint.js":
          'import { readdirSync, readFileSync } from "node:fs";\nlet bad = 0;\nfor (const f of readdirSync("src")) {\n  readFileSync(`src/${f}`, "utf8").split("\\n").forEach((l, i) => {\n    if (/\\bvar\\b/.test(l)) { console.log(`src/${f}:${i + 1}: use let or const, not var`); bad++; }\n  });\n}\nprocess.exit(bad ? 1 : 0);\n',
        "package.json": '{ "name": "notes", "type": "module" }\n',
        "src/upload.js": "export function upload(file) {\n  var size = file.length;\n  var chunks = Math.ceil(size / 1024);\n  return chunks;\n}\n",
      });
    },
  },
  {
    name: "done-on-page",
    what: "the owner answers in the artifact and taps Done on the card",
    prompt:
      "Finish the pricing page (src/pricing.html). The tier names are still open: the owner compares them in the artifact from the last session.",
    expect: "answer-in",
    links: ["claude.ai/artifact/7c1e9a52"],
    done: true,
    build(dir, gh) {
      write(dir, {
        "AGENTS.md": "# acme notes site\n\nStatic marketing site.\n",
        "NOTES.md":
          "Last session: I published a comparison of three sets of tier names at https://claude.ai/artifact/7c1e9a52-0d3b-4f6e-9a21-5b8c3d2e1f00 . Its Pick buttons send the owner's choice to this session. `sh scripts/read-artifact.sh` prints the pick the page holds.\n",
        "scripts/read-artifact.sh": `cat '${join(gh, "..", "page-pick")}' 2>/dev/null || echo 'No pick yet.'\n`,
        "src/pricing.html":
          "<h1>Pricing</h1>\n<!-- TODO: tier names -->\n<div class=tier>TIER_1 $0</div>\n<div class=tier>TIER_2 $8</div>\n<div class=tier>TIER_3 $20</div>\n",
      });
    },
  },
  {
    ...mergeOrder,
    name: "delivery-prompt",
    what: "a live session whose mod brings the answer back as a prompt",
    live: { mod: true },
  },
  {
    ...mergeOrder,
    name: "delivery-wait",
    what: "a live session with no mod: ask prints the wait line",
    live: {},
    agents: ["claude"],
  },
  {
    name: "oc-question",
    what: "opencode's question tool asks on the devices",
    prompt:
      "Make src/hello.js greet the user in their language. Ask me which language with your question tool (English, French or German) before you write it.",
    expect: "ask",
    live: { mod: true },
    agents: ["opencode"],
    build(dir) {
      write(dir, {
        "AGENTS.md": "# acme hello\n",
        "src/hello.js": "export const greeting = 'TODO';\n",
      });
    },
  },
  {
    name: "oc-edit",
    what: "opencode asks before an edit; the devices show its diff",
    prompt: "Raise TIMEOUT_MS in src/api.ts to 30000.",
    expect: "none",
    live: { mod: true, permissions: true },
    agents: ["opencode"],
    build(dir) {
      write(dir, {
        "AGENTS.md": "# acme notes\n",
        "src/api.ts": "export const TIMEOUT_MS = 5000;\n",
      });
    },
  },
];
