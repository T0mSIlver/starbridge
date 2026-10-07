import { installScript } from "@/lib/installScript";

// `curl -fsSL https://starbridge.run/install.sh | sh`, with this server's address written in
// (lib/installScript.ts), so a self-hosted server's script pairs with it.
export const dynamic = "force-dynamic";

export function GET() {
  return installScript("install.sh");
}
