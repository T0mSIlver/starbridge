import { expect, test } from "bun:test";
import { installCommands } from "./installCommands";

const commands = (origin: string) =>
  installCommands(origin).flatMap((p) => p.methods.map(([label, cmd]) => `${label}: ${cmd}`));

test("another server's Homebrew and npm commands pair with it; starbridge.run's stay bare", () => {
  expect(commands("https://my.host")).toEqual([
    "Script: curl -fsSL https://my.host/install.sh | sh",
    "Homebrew: brew install T0mSIlver/starbridge/starbridge && starbridge setup --server https://my.host",
    "npm: npm i -g starbridge && starbridge setup --server https://my.host",
    "PowerShell: irm https://my.host/install.ps1 | iex",
    "npm: npm i -g starbridge; starbridge setup --server https://my.host",
  ]);
  expect(commands("https://starbridge.run")).toContain("npm: npm i -g starbridge");
});

test("the empty inbox's Homebrew and npm commands run setup on starbridge.run too (#1378)", () => {
  const cmds = installCommands("https://starbridge.run", true).flatMap((p) =>
    p.methods.map(([label, cmd]) => `${label}: ${cmd}`),
  );
  expect(cmds).toEqual([
    "Script: curl -fsSL https://starbridge.run/install.sh | sh",
    "Homebrew: brew install T0mSIlver/starbridge/starbridge && starbridge setup",
    "npm: npm i -g starbridge && starbridge setup",
    "PowerShell: irm https://starbridge.run/install.ps1 | iex",
    "npm: npm i -g starbridge; starbridge setup",
  ]);
});
