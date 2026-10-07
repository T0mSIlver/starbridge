import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";

/**
 * The owner can pause sign-ups on a launch day (#784): while this file sits beside the database,
 * a GitHub sign-in that would make an account is refused, and accounts that exist sign in as
 * before. `bun server.js signups pause|resume` writes and removes it; the running server reads
 * it on each new account, so no restart is needed.
 */
function pausedFile(config: Config): string {
  return join(dirname(config.dbPath), "signups-paused");
}

export function signUpsPaused(config: Config): boolean {
  return config.dbPath !== ":memory:" && existsSync(pausedFile(config));
}

export function setSignUps(config: Config, open: boolean): void {
  if (open) rmSync(pausedFile(config), { force: true });
  else writeFileSync(pausedFile(config), `${new Date().toISOString()}\n`);
}

export const SIGNUPS_PAUSED =
  "Starbridge is not taking new accounts right now; accounts that exist still sign in. Try again in a few hours.";
