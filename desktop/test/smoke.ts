// Launches the app on a stand-in server page and checks the bridge end to end: the window loads
// the page, the page's count reaches the menu bar, a question notifies with its options, a button
// and a typed reply answer through the page, the notification closes once the question leaves,
// and the window refuses another origin. Notifications and the tray are watched in the main
// process, so no OS notification is needed (GitHub's macOS runners cannot grant the permission).
//
//   pnpm --filter @starbridge/desktop e2e     (on Linux: xvfb-run -a …)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const DESKTOP = resolve(import.meta.dirname, "..");

/** The stand-in page's globals. */
type StandIn = { answers: unknown[]; send(entries: unknown[]): void };

/** What the main process records in place of the OS. */
type Watched = {
  shown: Electron.Notification[];
  closed: string[];
  titles: string[];
  outside: string[];
};

const PAGE = `<!doctype html><title>stand-in</title><script>
window.answers = [];
const b = window.starbridgeDesktop;
document.title = b ? "bridge " + b.version : "no bridge";
if (b) b.onAnswer(async (a) => { window.answers.push(a); if (a.text === "fail") throw new Error("offline"); });
window.send = (entries) => b.update({ count: entries.length, entries });
</script>`;

function serve(body: string): Promise<Server> {
  const s = createServer((_req, res) => res.setHeader("content-type", "text/html").end(body));
  return new Promise((done) => s.listen(0, "127.0.0.1", () => done(s)));
}
const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function until<T>(f: () => Promise<T>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const server = await serve(PAGE);
const other = await serve(`<title>other</title>`);
const app = await electron.launch({
  args: [DESKTOP, `--user-data-dir=${mkdtempSync(join(tmpdir(), "sb-desktop-"))}`],
  env: { ...process.env, STARBRIDGE_SERVER: url(server) },
});
try {
  await app.evaluate(({ Notification, Tray, shell }) => {
    const g = globalThis as Record<string, unknown>;
    const shown: unknown[] = [];
    const closed: string[] = [];
    const titles: string[] = [];
    const outside: string[] = [];
    Object.assign(g, { shown, closed, titles, outside });
    Notification.prototype.show = function (this: Electron.Notification) {
      shown.push(this);
    };
    Notification.prototype.close = function (this: Electron.Notification) {
      closed.push(this.id);
    };
    Tray.prototype.setTitle = (t: string) => {
      titles.push(t);
    };
    shell.openExternal = async (u: string) => {
      outside.push(u);
    };
  });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  assert.equal(
    await page.title(),
    `bridge ${JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version}`,
  );

  const q = {
    id: "d-1",
    title: "Ship it?",
    body: "devbox · starbridge",
    options: ["yes", "no"],
    reply: true,
    waiting: false,
  };
  const p = {
    id: "p-1",
    title: "Run rm -rf build?",
    body: "devbox",
    options: [],
    reply: false,
    waiting: true,
  };
  await page.evaluate(([q, p]) => (window as unknown as StandIn).send([q, p]), [q, p] as const);

  const main = <T>(f: (g: Watched) => T) =>
    app.evaluate(
      (_e, src) => new Function("g", `return (${src})(g)`)(globalThis),
      f.toString(),
    ) as Promise<T>;
  await until(() => main((g) => g.titles.at(-1) === "2"), "the count in the menu bar");
  const shown = await main((g) =>
    g.shown.map((n: Electron.Notification) => ({
      id: n.id,
      title: n.title,
      actions: n.actions.map((a) => a.text),
      reply: n.hasReply,
    })),
  );
  assert.deepEqual(shown, [
    { id: "item-d-1", title: "Ship it?", actions: ["yes", "no"], reply: true },
    { id: "item-p-1", title: "Run rm -rf build?", actions: [], reply: false },
  ]);

  // A button, then a typed reply, answer through the page.
  await main((g) => g.shown[0]?.emit("action", { actionIndex: 1 }, 1));
  await main((g) => g.shown[0]?.emit("reply", { reply: "after lunch" }, "after lunch"));
  const answers = await until(
    () =>
      page.evaluate(() =>
        (window as unknown as StandIn).answers.length === 2
          ? (window as unknown as StandIn).answers
          : null,
      ),
    "two answers",
  );
  assert.deepEqual(answers, [
    { id: "d-1", choice: "no" },
    { id: "d-1", text: "after lunch" },
  ]);
  await until(
    () => main((g) => g.closed.includes("item-d-1")),
    "the answered notification to close",
  );

  // A failed answer says so in a notification of its own.
  await main((g) => g.shown[1]?.emit("reply", { reply: "fail" }, "fail"));
  await until(
    () =>
      main((g) =>
        g.shown.some(
          (n: Electron.Notification) => n.title === "Answer not sent" && n.body === "offline",
        ),
      ),
    "Answer not sent",
  );

  // Answered elsewhere: the page drops it, and its notification closes.
  await page.evaluate(() => (window as unknown as StandIn).send([]));
  await until(
    () => main((g) => g.closed.includes("item-p-1") && g.titles.at(-1) === ""),
    "the prompt to close",
  );

  // Another origin stays out of the window and opens in the browser.
  await page.evaluate((u) => {
    location.href = u;
  }, url(other));
  await until(() => main((g) => g.outside.length === 1), "the link to open outside");
  assert.equal(new URL(page.url()).origin, url(server));
  console.log("desktop smoke test passed");
} finally {
  await app.close();
  server.close();
  other.close();
}
