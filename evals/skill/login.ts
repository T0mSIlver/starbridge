/**
 * The logins the eval runs on, none of which refreshes: for Claude, a long-lived token from
 * `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN or `~/.config/starbridge/secrets/claude-eval-token`);
 * for Codex, an OpenAI API key (OPENAI_API_KEY or `.../secrets/codex-eval-key`). Copies of
 * `~/.claude/.credentials.json` or `~/.codex/auth.json` would each refresh on their own, and a
 * rotated refresh token signs the original out.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const secrets = join(homedir(), ".config/starbridge/secrets");

function secret(env: string, name: string, how: string): string {
  const file = join(secrets, name);
  const value = process.env[env] ?? (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (!value) throw new Error(`no ${env}: ${how} and save it in ${file}`);
  return value;
}

export const claudeToken = () =>
  secret("CLAUDE_CODE_OAUTH_TOKEN", "claude-eval-token", "run `claude setup-token`");

export const codexKey = () =>
  secret("OPENAI_API_KEY", "codex-eval-key", "create an OpenAI API key");

/** A `claude -p` under the home folder would read an ancestor's CLAUDE.md. */
export function tmpOutsideHome(): string {
  if (`${tmpdir()}/`.startsWith(`${homedir()}/`)) throw new Error("TMPDIR must be outside your home");
  return tmpdir();
}
