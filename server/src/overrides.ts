import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { DEFAULT_LIMITS, type Limits } from "./limits";

/**
 * Limits the owner changes at runtime, on a launch day (#786): `limits.json` beside the
 * database holds the ones that differ from the server's own, and the server reads it every
 * minute, so a change needs no restart and survives deploys until it is unset. Rate windows,
 * caps and the machine cap may change; the retention periods may not, since shortening one
 * deletes data at the next sweep.
 */
type Key = Exclude<keyof Limits, `${string}Retention`> | "maxMachines";
type Overrides = Partial<Record<Key, number | readonly [number, number]>>;

function file(config: Config): string {
  return join(dirname(config.dbPath), "limits.json");
}

function isKey(key: string): key is Key {
  return (
    key === "maxMachines" || (Object.hasOwn(DEFAULT_LIMITS, key) && !key.endsWith("Retention"))
  );
}

/** "60/60" is 60 calls per 60 s for a rate window; a cap is a whole number. */
export function parseValue(key: string, raw: string): number | [number, number] {
  if (!isKey(key)) throw new Error(`not a limit that may change at runtime: ${key}`);
  const window = key !== "maxMachines" && Array.isArray(DEFAULT_LIMITS[key]);
  const m = window ? /^(\d+)\/(\d+)$/.exec(raw) : /^(\d+)$/.exec(raw);
  if (!m)
    throw new Error(`${key} takes ${window ? "CALLS/SECONDS, such as 60/60" : "a whole number"}`);
  const n = Number(m[1]);
  if (window && Number(m[2]) === 0) throw new Error(`${key}: a window lasts at least a second`);
  return window ? [n, Number(m[2]) * 1000] : n;
}

function show(key: string, v: number | readonly [number, number]): string {
  return Array.isArray(v) ? `${key} ${v[0]}/${v[1] / 1000}s` : `${key} ${v}`;
}

export function readOverrides(config: Config): Overrides {
  if (config.dbPath === ":memory:" || !existsSync(file(config))) return {};
  const raw = JSON.parse(readFileSync(file(config), "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("limits.json is not an object");
  const out: Overrides = {};
  const whole = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!isKey(k)) throw new Error(`not a limit that may change at runtime: ${k}`);
    const window = k !== "maxMachines" && Array.isArray(DEFAULT_LIMITS[k]);
    const ok = window
      ? Array.isArray(v) && v.length === 2 && whole(v[0]) && whole(v[1]) && v[1] > 0
      : whole(v);
    if (!ok) throw new Error(`${k}: not a ${window ? "rate window" : "whole number"}`);
    out[k] = v as number | [number, number];
  }
  return out;
}

export function writeOverrides(config: Config, over: Overrides): void {
  if (Object.keys(over).length === 0) {
    rmSync(file(config), { force: true });
    return;
  }
  writeFileSync(`${file(config)}.tmp`, `${JSON.stringify(over)}\n`);
  renameSync(`${file(config)}.tmp`, file(config));
}

export function describe(over: Overrides): string {
  const keys = Object.keys(over) as Key[];
  return keys.length === 0
    ? "no overrides: the server's own limits"
    : keys.map((k) => show(k, over[k] as number | [number, number])).join(", ");
}

/**
 * Brings `config` to its base limits plus the file's, and returns the overrides' description
 * when it changed since `last`. A file that fails to parse keeps the limits as they were.
 */
export function applyOverrides(
  config: Config,
  base: { limits: Limits; maxMachines: number },
  last: string,
): string {
  let over: Overrides;
  try {
    over = readOverrides(config);
  } catch (e) {
    console.error(`limits.json unreadable, limits unchanged: ${e}`);
    return last;
  }
  const { maxMachines, ...limits } = over;
  config.limits = { ...base.limits, ...limits } as Limits;
  config.maxMachines = typeof maxMachines === "number" ? maxMachines : base.maxMachines;
  const now = describe(over);
  if (now !== last) console.log(`limits: ${now}`);
  return now;
}
