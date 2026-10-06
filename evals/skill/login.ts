/**
 * The Claude login the eval runs on: a long-lived token from `claude setup-token`, in
 * CLAUDE_CODE_OAUTH_TOKEN or in `~/.config/starbridge/secrets/claude-eval-token`. Copies of
 * `~/.claude/.credentials.json` would each refresh on their own, and a rotated refresh token
 * signs the original out.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = join(homedir(), ".config/starbridge/secrets/claude-eval-token");

export function claudeToken(): string {
  const token =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    (existsSync(file) ? readFileSync(file, "utf8").trim() : undefined);
  if (!token)
    throw new Error(`no Claude token: run \`claude setup-token\` and save it in ${file}`);
  return token;
}
