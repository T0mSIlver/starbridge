import { installScript } from "@/lib/installScript";

// `irm https://starbridge.run/install.ps1 | iex`, as install.sh/route.ts serves install.sh.
export const dynamic = "force-dynamic";

export function GET() {
  return installScript("install.ps1");
}
