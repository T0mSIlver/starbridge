/** The hosted server's origin, which a CLI installed without a script pairs with by default. */
export const HOSTED = "https://starbridge.run";

/**
 * Each platform's ways to install: label, command, and the method the copy event reports, kept
 * as first named. npm is the same package on both. The scripts come from the page's own origin,
 * which writes its address into them, so a self-hosted page's command pairs with it (#749).
 * Homebrew and npm install only the CLI, whose setup pairs with starbridge.run unless told
 * otherwise, so another server's page runs setup with its own address. Windows PowerShell 5.1
 * has no `&&`.
 */
export function installCommands(origin: string) {
  const then = (sep: string) =>
    origin === HOSTED ? "" : `${sep} starbridge setup --server ${origin}`;
  const setup = then(" &&");
  return [
    {
      platform: "macOS / Linux",
      methods: [
        ["Script", `curl -fsSL ${origin}/install.sh | sh`, "Script"],
        ["Homebrew", `brew install T0mSIlver/starbridge/starbridge${setup}`, "Homebrew"],
        ["npm", `npm i -g starbridge${setup}`, "npm"],
      ],
    },
    {
      platform: "Windows",
      methods: [
        ["PowerShell", `irm ${origin}/install.ps1 | iex`, "Windows"],
        ["npm", `npm i -g starbridge${then(";")}`, "npm"],
      ],
    },
  ] as const;
}
