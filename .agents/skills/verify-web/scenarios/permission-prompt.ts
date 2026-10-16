// Flow 4: Claude Code asks to run a command; the owner taps Allow on the web; the hook tells
// Claude Code to allow it.
import type { Scenario } from "../../../../web/e2e/drive.ts";

export default async function ({ page, machine, prompt, shot, step }: Scenario) {
  step("the machine sends permission prompts");
  if ((await machine("perm-on", ["config", "permissions", "on"]).exited) !== 0)
    throw new Error("config permissions on failed");

  step("Claude Code asks to run git push");
  const answered = prompt({
    session_id: "verify-prompt",
    cwd: "/home/me/work/starbridge",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
  });
  await page.getByText("git push origin main").first().waitFor({ timeout: 30_000 });
  await shot("prompt");

  step("the owner taps Allow");
  await page.getByRole("button", { name: "Allow" }).first().click();

  step("the hook prints an allow decision");
  const printed = await answered;
  console.log("hook printed:", printed);
  const decision = JSON.parse(printed).hookSpecificOutput?.decision;
  if (decision?.behavior !== "allow") throw new Error(`expected allow, got ${printed}`);
  await shot("allowed");
}
