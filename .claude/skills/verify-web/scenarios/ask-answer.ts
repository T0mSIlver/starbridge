// Flow 1: an agent asks with options and waits; the owner taps an answer on the web; the answer
// reaches the waiting session.
import type { Scenario } from "../../../../web/e2e/drive.ts";

const QUESTION = "Run the migration on the staging database now?";

export default async function ({ page, machine, shot, step }: Scenario) {
  step("the agent asks and waits");
  const ask = machine("ask", [
    "ask",
    "--question",
    QUESTION,
    "--context",
    "It locks `items` for about 2 s.",
    "--option",
    "Run it",
    "--option",
    "Wait for tonight",
    "--wait",
  ]);
  await ask.waitFor(/^d_\S+$/m);
  await page.getByText(QUESTION).first().waitFor();
  await shot("asked");

  step("the owner taps Run it");
  await page.getByText(QUESTION).first().click();
  await page.getByRole("button", { name: "Run it" }).click();

  step("the waiting session gets the answer");
  await ask.waitFor(/Answer to d_\S+ \(Run the migration on the staging database now\?\): Run it/);
  if ((await ask.exited) !== 0) throw new Error("ask --wait failed");
  await shot("answered");
}
