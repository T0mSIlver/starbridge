/**
 * Compares load.ts's `--json` result with a stored baseline and names each regression: a stage
 * that broke, lost or doubled answers, a slower p99 or answer delivery, more errors, more peak
 * memory, or, over a soak, memory that keeps growing. Exits 1 when it found one.
 *
 *   bun evals/load/compare.ts RESULT.json BASELINE.json [--out VERDICT.json]
 *
 * Each bound is relative and absolute together, so the run-to-run noise of a shared VM and of
 * small numbers does not read as a regression.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { LoadResult, StageResult } from "./lib.ts";

/** Worse than the baseline by more than `ratio` times and by more than `plus`. */
const worse = (now: number, base: number, ratio: number, plus: number) =>
  now > base * ratio && now > base + plus;

/** Server memory growth over a soak: the last hour's mean less the second hour's, in MB. */
export function growth(r: LoadResult, container = "server"): number | undefined {
  const at = (from: number, to: number) => {
    const xs = r.memory.filter((m) => m.t >= from && m.t < to).map((m) => m.mb[container]);
    const ok = xs.filter((x): x is number => x !== undefined);
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : undefined;
  };
  const end = r.memory.at(-1)?.t ?? 0;
  // The first hour fills caches and pools; under 3 hours there is no trend to read.
  if (end < 3 * 3600) return undefined;
  const early = at(3600, 7200);
  const late = at(end - 3600, end + 1);
  return early === undefined || late === undefined ? undefined : late - early;
}

export function compare(now: LoadResult, base: LoadResult): string[] {
  const out: string[] = [];
  if (now.broke && !base.broke) out.push(`broke: ${now.broke}`);
  for (const k of ["lost", "dup", "unseen"])
    if ((now.final[k] ?? 0) > (base.final[k] ?? 0))
      out.push(`${k}: ${now.final[k]} (baseline ${base.final[k] ?? 0})`);
  for (const s of now.stages) {
    const b = base.stages.find((x) => x.users === s.users);
    if (!b) continue;
    const at = `${s.users} users`;
    const check = (
      what: string,
      n: number,
      o: number,
      ratio: number,
      plus: number,
      unit: string,
    ) => {
      if (worse(n, o, ratio, plus)) out.push(`${at}: ${what} ${n}${unit} (baseline ${o}${unit})`);
    };
    check("p99", s.p99, b.p99, 1.5, 50, " ms");
    check("answer delivery p99", s.deliveryP99, b.deliveryP99, 1.5, 250, " ms");
    for (const c of ["server", "caddy"])
      if (s.peakMB[c] !== undefined && b.peakMB[c] !== undefined)
        check(`${c} peak memory`, s.peakMB[c], b.peakMB[c], 1.25, 64, " MB");
    if (s.errorRate > b.errorRate + 0.001)
      out.push(`${at}: errors ${pct(s)} of requests (baseline ${pct(b)})`);
  }
  const g = growth(now);
  if (g !== undefined && g > Math.max(0, growth(base) ?? 0) + 64)
    out.push(
      `server memory grew ${Math.round(g)} MB over the soak (baseline ${Math.round(growth(base) ?? 0)} MB)`,
    );
  return out;
}

const pct = (s: StageResult) => `${(s.errorRate * 100).toFixed(2)}%`;

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const [resultFile, baseFile] = positionals;
  if (!resultFile || !baseFile) {
    console.error("usage: compare.ts RESULT.json BASELINE.json [--out VERDICT.json]");
    process.exit(2);
  }
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as LoadResult;
  const regressions = compare(read(resultFile), read(baseFile));
  for (const r of regressions) console.log(`REGRESSION ${r}`);
  if (!regressions.length) console.log("no regression against the baseline");
  if (values.out)
    await Bun.write(values.out, `${JSON.stringify({ ok: !regressions.length, regressions })}\n`);
  process.exit(regressions.length ? 1 : 0);
}
