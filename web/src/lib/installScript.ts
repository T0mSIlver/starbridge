import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The line each script carries for the server it pairs with, empty as committed. */
const SERVER_LINE = {
  "install.sh": { line: /^SERVER=$/m, set: (o: string) => `SERVER='${o}'` },
  "install.ps1": { line: /^ {2}\$Server = ''$/m, set: (o: string) => `  $Server = '${o}'` },
} as const;

export type Script = keyof typeof SERVER_LINE;

/**
 * This server's public origin, from the PUBLIC_URL the server reads too (server/README.md), when
 * it is a plain http(s) origin: it goes into a shell script, so nothing else passes.
 */
export function publicOrigin(env: Record<string, string | undefined>): string | undefined {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) return undefined;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return undefined;
  }
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin) ? origin : undefined;
}

/** The script with `origin` written in, so its setup pairs with that server (#749). */
export function withServer(script: Script, text: string, origin: string | undefined): string {
  if (!origin) return text;
  const { line, set } = SERVER_LINE[script];
  if (!line.test(text)) throw new Error(`${script} has no empty server line`);
  return text.replace(line, set(origin));
}

const served = new Map<Script, string>();

/**
 * `cli/<script>` as this server serves it. PUBLIC_URL is read when the page runs, not when it is
 * built, so one image serves any server; the deploy's compose file sets it (deploy/compose.yaml,
 * server/compose.yaml).
 */
export function installScript(script: Script): Response {
  let text = served.get(script);
  if (text === undefined) {
    text = withServer(
      script,
      readFileSync(join(process.cwd(), "../cli", script), "utf8"),
      publicOrigin(process.env),
    );
    served.set(script, text);
  }
  // Plain text, so a browser shows the script to read before piping it into a shell.
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
