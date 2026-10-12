/**
 * The logins the eval runs on, none of which refreshes: for Claude, a long-lived token from
 * `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN or `~/.config/starbridge/secrets/claude-eval-token`);
 * for Codex, an OpenAI API key (OPENAI_API_KEY or `.../secrets/codex-eval-key`); for Cursor and
 * Antigravity, an API key, else a login made for the eval alone, which the runs share rather
 * than copy. Copies of
 * `~/.claude/.credentials.json` or `~/.codex/auth.json` would each refresh on their own, and a
 * rotated refresh token signs the original out.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Antigravity's login: a Gemini API key (GEMINI_API_KEY or `.../secrets/gemini-eval-key`), else
 * the token file of a sign-in made for the eval alone: `agy` run with HOME set to
 * `.../secrets/agy-eval-home`, Google OAuth. Each run links to that file.
 */
export function antigravityLogin(): { GEMINI_API_KEY: string } | { token: string } {
  const token = join(secrets, "agy-eval-home/.gemini/antigravity-cli/antigravity-oauth-token");
  if (!process.env.GEMINI_API_KEY && !existsSync(join(secrets, "gemini-eval-key")) && existsSync(token))
    return { token };
  return {
    GEMINI_API_KEY: secret(
      "GEMINI_API_KEY",
      "gemini-eval-key",
      `create a Gemini API key, or sign in with HOME=${dirname(dirname(dirname(token)))} agy,`,
    ),
  };
}

/**
 * Cursor's login: an API key (CURSOR_API_KEY or `.../secrets/cursor-eval-key`), else the folder of a login made for the eval alone with
 * `env -i PATH=$PATH HOME=<dir> XDG_CONFIG_HOME=<dir>/.config cursor-agent login`. That login
 * refreshes in place, so the runs read it from there, one at a time, never from copies.
 */
export function cursorLogin(): { CURSOR_API_KEY: string } | { XDG_CONFIG_HOME: string } {
  // `cursor-agent` reads the login from `$XDG_CONFIG_HOME/cursor`, not `CURSOR_CONFIG_DIR`.
  const config = join(secrets, "cursor-eval-home/.config");
  if (!process.env.CURSOR_API_KEY && !existsSync(join(secrets, "cursor-eval-key")) && existsSync(join(config, "cursor/auth.json")))
    return { XDG_CONFIG_HOME: config };
  return {
    CURSOR_API_KEY: secret(
      "CURSOR_API_KEY",
      "cursor-eval-key",
      `create a Cursor API key, or log in to ${config} as login.ts says,`,
    ),
  };
}

/** A `claude -p` under the home folder would read an ancestor's CLAUDE.md. */
export function tmpOutsideHome(): string {
  if (`${tmpdir()}/`.startsWith(`${homedir()}/`)) throw new Error("TMPDIR must be outside your home");
  return tmpdir();
}

/**
 * opencode's login file as a run gets it: the API keys only (the Z.ai key), since an OAuth login
 * in it would refresh in each run's copy.
 */
export function opencodeApiKeys(authJson: string): string {
  const keys = Object.entries(JSON.parse(authJson) as Record<string, { type?: string }>).filter(
    ([, login]) => login.type === "api",
  );
  if (!keys.length) throw new Error("no API key in opencode's auth.json: run `opencode auth login`");
  return JSON.stringify(Object.fromEntries(keys));
}
