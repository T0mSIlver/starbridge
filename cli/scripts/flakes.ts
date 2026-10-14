/**
 * Runs that failed on their first attempt and passed on a rerun, so flaky tests are counted
 * instead of rerun silently (#1657). Run nightly by flakes.yml:
 *   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo bun cli/scripts/flakes.ts [hours]
 * Looks at runs that finished green in the last `hours` (24) after more than one attempt, and
 * prints a Markdown table of the jobs that failed in the first attempt, with the failing step and
 * the test names its log gives. With FLAKES_ISSUE=1 it also comments the table on the open issue
 * labelled `flaky` (opened if none) and keeps that issue's per-job count.
 */

const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY ?? "T0mSIlver/starbridge";
const token = process.env.GH_TOKEN ?? "";
const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";

export type Flake = {
  run: number;
  workflow: string;
  url: string;
  job: string;
  step: string;
  tests: string[];
};

/** The failing test names a job's log gives: bun's `(fail)`, Gradle's `FAILED`, XCTest's failed cases,
 * then GitHub's `##[error]` lines when none of those matched. At most six. */
export function failingTests(log: string): string[] {
  const lines = log.split("\n").map((l) => l.replace(/^\S+Z /, "").trim());
  const tests = new Set<string>();
  for (const l of lines) {
    const m =
      /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l) ??
      /^(\S.* > .+) FAILED$/.exec(l) ??
      /^Test Case '(.+)' failed/.exec(l);
    if (m?.[1]) tests.add(m[1]);
  }
  if (tests.size === 0) {
    for (const l of lines) {
      const m = /^##\[error\](.+)$/.exec(l);
      if (m?.[1] && !/^Process completed with exit code/.test(m[1])) tests.add(m[1]);
    }
  }
  return [...tests].slice(0, 6);
}

const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Run = { id: number; name: string; run_attempt: number; updated_at: string; html_url: string };
type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

export async function flakes(hours: number): Promise<Flake[]> {
  const since = Date.now() - hours * 3_600_000;
  // A rerun can come days after the first attempt; the API lists by creation, up to 1,000 runs.
  const created = new Date(since - 3 * 86_400_000).toISOString().slice(0, 10);
  const runs: Run[] = [];
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs } = await json<{ workflow_runs: Run[] }>(
      `/repos/${repo}/actions/runs?status=success&created=%3E%3D${created}&per_page=100&page=${page}`,
    );
    runs.push(
      ...workflow_runs.filter((r) => r.run_attempt > 1 && Date.parse(r.updated_at) >= since),
    );
    if (workflow_runs.length < 100) break;
  }
  const found: Flake[] = [];
  for (const run of runs) {
    const { jobs } = await json<{ jobs: Job[] }>(
      `/repos/${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
    );
    for (const job of jobs.filter((j) => j.conclusion === "failure")) {
      const step = job.steps?.find((s) => s.conclusion === "failure")?.name ?? "";
      // Logs expire, and a job with none still counts.
      const log = await fetch(`${api}/repos/${repo}/actions/jobs/${job.id}/logs`, { headers });
      const tests = log.ok ? failingTests(await log.text()) : [];
      found.push({
        run: run.id,
        workflow: run.name,
        url: `${run.html_url}/attempts/1`,
        job: job.name,
        step,
        tests,
      });
    }
  }
  return found;
}

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

export function table(found: Flake[]): string {
  const rows = found.map(
    (f) =>
      `| [${cell(f.workflow)}](${f.url}) | ${cell(f.job)} | ${cell(f.step)} | ${f.tests.map((t) => `\`${cell(t)}\``).join("<br>")} |`,
  );
  return ["| Run | Job | Step | Failed |", "|---|---|---|---|", ...rows].join("\n");
}

const COUNTS = /<!-- counts (\{.*\}) -->/;

/** The issue body: the count per workflow and job since the issue opened, highest first. */
export function body(counts: Record<string, number>): string {
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| ${cell(k)} | ${n} |`);
  return [
    "Jobs that failed on a run's first attempt and passed on a rerun, recorded each night by `flakes.yml`; each comment lists one night's.",
    "A test named here gets its own issue and a fix, not another rerun.",
    "",
    "| Workflow / job | First-attempt failures |",
    "|---|---|",
    ...rows,
    "",
    `<!-- counts ${JSON.stringify(counts)} -->`,
  ].join("\n");
}

async function record(found: Flake[]): Promise<void> {
  type Issue = { number: number; body: string | null };
  let [issue] = await json<Issue[]>(`/repos/${repo}/issues?labels=flaky&state=open&per_page=1`);
  if (!issue) {
    // Fails harmlessly when the label exists.
    await fetch(`${api}/repos/${repo}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "flaky",
        color: "FBCA04",
        description: "Recorded by the flakes workflow",
      }),
    });
    issue = await json<Issue>(`/repos/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Flaky CI: jobs that passed on a rerun",
        labels: ["flaky"],
        body: body({}),
      }),
    });
  }
  const counts: Record<string, number> = JSON.parse(COUNTS.exec(issue.body ?? "")?.[1] ?? "{}");
  for (const f of found) {
    const key = `${f.workflow} / ${f.job}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  await json(`/repos/${repo}/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: body(counts) }),
  });
  const run = `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  await json(`/repos/${repo}/issues/${issue.number}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: `${found.length} first-attempt failures passed on a rerun ([run](${run})):\n\n${table(found)}`,
    }),
  });
}

if (import.meta.main) {
  const hours = Number(process.argv[2] ?? 24);
  if (!(hours > 0)) throw new Error(`not a number of hours: ${process.argv[2]}`);
  const found = await flakes(hours);
  console.log(found.length ? table(found) : `No run passed on a rerun in the last ${hours} hours.`);
  if (found.length && process.env.FLAKES_ISSUE === "1") await record(found);
}
