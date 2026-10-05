// The mockups' data (DESIGN.md, design v2), for the landing page's product shots and the
// dev-only /sample pages that screenshots compare against. Times are relative to `now`.
import type { Member } from "@starbridge/protocol";
import shots from "./sample-shots.json";
import type { Quotas, Runs } from "./device";
import type { InboxItem, PromptItem, QuotaCardData, RunItem } from "./types";

const min = 60_000;
const member = (name: string): Member => ({
  id: `m_${name.replace(/\W/g, "")}`,
  role: "machine",
  name,
  boxPk: "",
  signPk: "",
});

type Kind = "server" | "desktop" | "laptop" | "cloud";
const source = (machine: string, kind: Kind, project: string, session: string) => ({
  machine,
  machineKind: kind,
  project,
  session,
  links: [{ kind: "web" as const, url: `https://claude.ai/code/${session}` }],
});

export function sample(now = Date.now()) {
  const at = (ago: number) => new Date(now - ago).toISOString();
  const decision = (
    id: string,
    ago: number,
    src: ReturnType<typeof source>,
    question: string,
    context: string,
    options: string[],
    extra: object = {},
  ) =>
    ({
      v: 1,
      id,
      to: ["d_self"],
      createdAt: at(ago),
      question,
      context,
      options,
      recommended: options[0],
      source: src,
      ...extra,
    }) as unknown as InboxItem["decision"];

  const devbox = (s: string) => source("dev box", "server", "starbridge", s);
  const items: InboxItem[] = [
    {
      decision: decision(
        "d1",
        12 * min,
        devbox("orchestrate-merges-server-before-cli"),
        "Merge the server PR before the CLI PR?",
        "Both touch `packages/protocol`. Merging the server first lets the CLI rebase onto the final routes:\n```\ngit rebase origin/main\npnpm test\n```\nThe CLI PR then needs one more review.",
        ["Server first", "CLI first"],
      ),
      machine: member("dev box"),
    },
    {
      decision: decision(
        "d2",
        3 * min,
        source("mac mini", "desktop", "localvoxtral", "eval-runner-whisper-large-v3-nightly"),
        "Run speech inference on the Mac while you're away?",
        "The eval needs the Mac's GPU for about 40 minutes.",
        ["Run it now", "Wait until tonight"],
        { agent: "codex" },
      ),
      machine: member("mac mini"),
      waitingSince: at(2 * min + 10_000),
    },
    {
      decision: decision(
        "d3",
        8 * min,
        source("MacBook", "laptop", "starbridge", "landing-hero-two-variants"),
        "Which landing hero should I keep?",
        "Both are built on their own branches.",
        ["Keep A", "Keep B"],
        {
          images: (["A", "B"] as const).map((v) => ({
            type: "image/png",
            width: 368,
            height: 228,
            data: shots[v],
            alt: `Hero ${v}`,
          })),
        },
      ),
      machine: member("MacBook"),
    },
    {
      decision: decision(
        "h1",
        3 * 60 * min,
        devbox("decision-sheet"),
        "Ship the light or dark decision sheet first?",
        "",
        ["Dark", "Light"],
      ),
      machine: member("dev box"),
      answeredAt: at(2 * 60 * min),
      reply: { choice: "Dark" },
    },
    {
      decision: decision(
        "h2",
        4 * 60 * min,
        source("cloud", "cloud", "starbridge", "supervisor-flaky"),
        "Retry the flaky supervisor test once more?",
        "",
        ["Yes", "No"],
      ),
      machine: member("cloud"),
      answeredAt: at(3 * 60 * min),
    },
  ];

  const prompts: PromptItem[] = [
    {
      permission: {
        v: 1,
        id: "p1",
        to: ["d_self"],
        createdAt: at(72_000),
        agent: "claude-code",
        tool: "Bash",
        summary: "git push origin t/57-hook",
        description: "Push the permission hook branch.",
        input: '{"command":"git push origin t/57-hook"}',
        inputHash: "",
        suggestions: [
          { scope: "session", label: "Allow for this session", rule: "Bash(git push:*)" },
          { scope: "project", label: "Always allow in starbridge", rule: "Bash(git push:*)" },
        ],
        expiresAt: new Date(now + 9 * min).toISOString(),
        source: devbox("permission-hook-t57-implementation"),
      } as PromptItem["permission"],
      machine: member("dev box"),
      receivedAt: at(72_000),
    },
  ];

  const runs: RunItem[] = [
    {
      machine: "mac mini",
      run: {
        v: 1,
        id: "r1",
        to: ["d_self"],
        title: "Mac e2e",
        reason: "Uses your session and keyboard",
        source: source("mac mini", "desktop", "localvoxtral", "e2e-dictation-suite"),
        startedAt: at(6 * min + 12_000),
        at: at(5_000),
        progress: { done: 34, total: 120, unit: "step" },
      } as RunItem["run"],
    },
  ];

  const window = (
    id: string,
    label: string,
    used: number,
    pace: number,
    resetIn: number,
    minutes: number,
    runsOutIn?: number,
  ): QuotaCardData["window"] => ({
    id,
    label,
    usedPercent: used,
    windowMinutes: minutes,
    resetsAt: new Date(now + resetIn).toISOString(),
    pace: {
      stage: used > pace ? "ahead" : used < pace ? "behind" : "on-track",
      expectedUsedPercent: pace,
      deltaPercent: used - pace,
      projectedUsedPercent: null,
      willLastToReset: runsOutIn === undefined,
      runsOutAt: runsOutIn === undefined ? null : new Date(now + runsOutIn).toISOString(),
    },
  });
  const unused = (provider: string, w: string, resetIn: number, pct: number) =>
    ({
      kind: "unused-headroom",
      provider,
      window: w,
      resetsAt: new Date(now + resetIn).toISOString(),
      unusedPercent: pct,
    }) as QuotaCardData["alerts"][number];
  const card = (provider: string, w: QuotaCardData["window"], alert?: QuotaCardData["alert"]) => ({
    provider,
    window: w,
    alert,
    alerts: alert ? [alert] : [],
    snapshot: "s1",
  });
  const h = 60 * min;
  const quotas: Quotas = {
    takenAt: at(min),
    errors: [],
    rejected: [],
    cards: [
      card("claude", window("primary", "5-hour", 81, 63, 110 * min, 300, 50 * min)),
      card("gemini", window("primary", "Daily", 100, 48, 6 * h, 1440, -20 * min)),
      card(
        "codex",
        window("secondary", "Weekly", 34, 72, 19 * h, 10080),
        unused("codex", "secondary", 19 * h, 41),
      ),
      card(
        "zai",
        window("primary", "5-hour", 12, 88, 38 * min, 300),
        unused("zai", "primary", 38 * min, 86),
      ),
      card("claude", window("secondary", "Weekly", 62, 58, 52 * h, 10080)),
      card("mistral", window("monthly", "Monthly credits", 55, 60, 12 * 24 * h, 43200)),
    ],
  };
  return {
    inbox: { items, rejected: [] },
    prompts,
    runs: { items: runs, rejected: [] } as Runs,
    quotas,
  };
}
