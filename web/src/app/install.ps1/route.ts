import { readFileSync } from "node:fs";
import { join } from "node:path";

// `irm https://starbridge.run/install.ps1 | iex`, as install.sh/route.ts serves install.sh.
export const dynamic = "force-static";

export function GET() {
  const script = readFileSync(join(process.cwd(), "../cli/install.ps1"), "utf8");
  return new Response(script, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
