// Neutral data for the landing page's product shots and the dev-only /sample pages that
// screenshots compare against, as on the Play Store's (#448). Times are relative to `now`.
import type { Member } from "@starbridge/protocol";
import type { Quotas, Runs } from "./device";
import shots from "./sample-shots.json";
import type { Device, InboxItem, PromptItem, QuotaCardData, RunItem } from "./types";

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
    src: ReturnType<typeof source> & { sessionTitle?: string },
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
      ...(options.length > 0 ? { replies: true } : {}),
      source: src,
      ...extra,
    }) as unknown as InboxItem["decision"];

  const workstation = (s: string) => source("workstation", "desktop", "billing-api", s);
  const buildServer = (s: string) => source("build server", "server", "web-app", s);
  const laptop = (s: string) => source("laptop", "laptop", "web-app", s);
  const items: InboxItem[] = [
    {
      decision: decision(
        "d1",
        12 * min,
        { ...buildServer("ship-checkout-v2"), sessionTitle: "Ship checkout v2" },
        "Merge the API change before the checkout PR?",
        "Both touch `api/orders.ts`. Merging the API first lets the checkout PR rebase onto the final routes:\n```\ngit rebase origin/main\nnpm test\n```\nThe checkout PR then needs one more review.",
        ["API first", "Checkout first"],
      ),
      machine: member("build server"),
    },
    {
      decision: decision(
        "d2",
        3 * min,
        workstation("rename-user-id-column"),
        "Rename the user_id column now, or after Friday's release?",
        "Renaming now touches 14 queries and needs a migration. After the release, nothing else is in flight.",
        ["Now", "After the release"],
        { agent: "codex", recommended: "After the release" },
      ),
      machine: member("workstation"),
      waitingSince: at(2 * min + 10_000),
    },
    {
      decision: decision(
        "d3",
        8 * min,
        laptop("checkout-layouts"),
        "Which checkout layout should I keep?",
        "Both are built on their own branches.",
        ["Keep A", "Keep B"],
        {
          images: (["A", "B"] as const).map((v) => ({
            type: "image/png",
            width: 368,
            height: 228,
            data: shots[v],
            alt: `Layout ${v}`,
          })),
          links: [
            { url: "https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYd" },
            { url: "https://github.com/T0mSIlver/starbridge/pull/86" },
          ],
        },
      ),
      machine: member("laptop"),
    },
    {
      decision: decision(
        "h1",
        3 * 60 * min,
        source("cloud", "cloud", "web-app", "node-version"),
        "Bump the Node version in CI?",
        "",
        ["Yes", "No"],
      ),
      machine: member("cloud"),
      answeredAt: at(2 * 60 * min),
      reply: { choice: "Yes" },
    },
    {
      decision: decision(
        "h2",
        4 * 60 * min,
        workstation("flaky-payment-test"),
        "Retry the flaky payment test once more?",
        "",
        ["Yes", "No"],
      ),
      machine: member("workstation"),
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
        summary: "git push origin feature/retry-queue",
        description: "Push the retry queue branch.",
        input: '{"command":"git push origin feature/retry-queue"}',
        inputHash: "",
        suggestions: [
          { scope: "session", label: "Allow for this session", rule: "Bash(git push:*)" },
          { scope: "project", label: "Always allow in billing-api", rule: "Bash(git push:*)" },
        ],
        expiresAt: new Date(now + 9 * min).toISOString(),
        source: source("laptop", "laptop", "billing-api", "retry-queue"),
      } as PromptItem["permission"],
      machine: member("laptop"),
      receivedAt: at(72_000),
    },
  ];

  const runs: RunItem[] = [
    {
      machine: "build server",
      run: {
        v: 1,
        id: "r1",
        to: ["d_self"],
        title: "Integration tests",
        reason: "Uses the shared staging database",
        source: source("build server", "server", "billing-api", "integration"),
        startedAt: at(6 * min + 12_000),
        at: at(5_000),
        progress: { done: 34, total: 120, unit: "step" },
      } as RunItem["run"],
    },
    {
      machine: "workstation",
      run: {
        v: 1,
        id: "r2",
        to: ["d_self"],
        title: "Build the release",
        reason: "The deploy waits for it",
        source: source("workstation", "desktop", "web-app", "release-build"),
        startedAt: at(40_000),
        at: at(5_000),
      } as RunItem["run"],
    },
    {
      machine: "build server",
      run: {
        v: 1,
        id: "r3",
        to: ["d_self"],
        title: "Load test",
        reason: "Killed before its first update",
        source: buildServer("load-test"),
        // Killed before its first heartbeat: its only news is its start (#190).
        startedAt: at(6 * min + 37_000),
        at: at(6 * min + 37_000),
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
  const device = (
    id: string,
    name: string,
    role: "device" | "machine",
    days: number,
    self = false,
  ) =>
    ({
      id,
      name,
      role,
      boxPk: "",
      signPk: "",
      addedAt: at(days * 24 * 60 * min),
      status: "active",
      self,
    }) as Device;
  const devices = [
    device("d_self", "Chrome on laptop", "device", 2, true),
    device("d_px9", "Pixel 9", "device", 23),
    device("m_workstation", "workstation", "machine", 23),
    device("m_buildserver", "build server", "machine", 20),
    device("m_laptop", "laptop", "machine", 9),
  ];
  return {
    devices,
    inbox: { items, rejected: [] },
    prompts,
    runs: { items: runs, rejected: [] } as Runs,
    quotas,
  };
}
