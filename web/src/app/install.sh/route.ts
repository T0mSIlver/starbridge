import { readFileSync } from "node:fs";
import { join } from "node:path";

// `curl -fsSL https://starbridge.run/install.sh | sh`. Read at build time, so each deploy serves
// the script from the revision it was built from.
export const dynamic = "force-static";

export function GET() {
  const script = readFileSync(join(process.cwd(), "../cli/install.sh"), "utf8");
  // Plain text, so a browser shows the script to read before piping it into a shell.
  return new Response(script, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
