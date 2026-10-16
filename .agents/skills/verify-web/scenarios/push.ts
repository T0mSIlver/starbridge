// Flow 2: with notifications on, an agent's question arrives as a Web Push notification; the
// owner answers; the notification closes and the answer reaches the waiting session.
import type { Scenario } from "../../../../web/e2e/drive.ts";

const QUESTION = "Deploy the hotfix to production?";

export default async function ({ page, machine, services, shot, step }: Scenario) {
  const shown = () =>
    page.evaluate(() =>
      navigator.serviceWorker.ready.then((r) =>
        r.getNotifications().then((ns) => ns.map((n) => n.title)),
      ),
    );
  const until = async (ok: (titles: string[]) => boolean, what: string) => {
    for (let i = 0; i < 75; i++) {
      if (ok(await shown())) return;
      await page.waitForTimeout(200);
    }
    throw new Error(`${what} within 15 s; shown: ${JSON.stringify(await shown())}`);
  };

  step("turn on notifications");
  await page.getByRole("button", { name: "Turn on notifications" }).click();
  await services.waitFor(/"event":"subscribed"/);
  await page.getByRole("button", { name: "Turn on notifications" }).waitFor({ state: "detached" });

  step("the agent asks; a notification shows it");
  const ask = machine("ask", ["ask", "--question", QUESTION, "--option", "Deploy", "--option", "Hold", "--wait"]);
  await ask.waitFor(/^d_\S+$/m);
  await services.waitFor(/"event":"push"/);
  await until((t) => t.includes(QUESTION), "no notification for the question");
  await shot("notified");

  step("the owner answers; the notification closes and the session gets the answer");
  await page.getByText(QUESTION).first().click();
  await page.getByRole("button", { name: /^Deploy/, exact: false }).and(page.locator("[aria-keyshortcuts]")).click();
  await ask.waitFor(/Answer to d_\S+ \(Deploy the hotfix to production\?\): Deploy/);
  await until((t) => !t.includes(QUESTION), "the notification still shows");
  await shot("answered");
}
