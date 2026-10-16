// Flow 3, after drive.ts's own sign-in, first device and pairing: a browser that signs out of
// GitHub's session and signs in again binds to its device, without pairing, and still reads what
// the machine sends.
import type { Scenario } from "../../../../web/e2e/drive.ts";

export default async function ({ page, context, machine, shot, step }: Scenario) {
  step("the session ends; sign in again");
  const origin = new URL(page.url()).origin;
  await context.clearCookies();
  await page.goto(origin);
  await page.getByRole("link", { name: /^(Sign in|Continue) with GitHub$/ }).click();
  await page.getByText("Nothing needs you").waitFor({ timeout: 30_000 });
  await shot("signed-in-again");

  step("a question from the paired machine still opens");
  const ask = machine("ask", ["ask", "--question", "Still there?", "--option", "Yes", "--option", "No"]);
  if ((await ask.exited) !== 0) throw new Error("ask failed");
  await page.getByText("Still there?").first().waitFor({ timeout: 30_000 });
  await shot("reads-machine");
}
