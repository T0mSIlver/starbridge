import type { Register } from "claude-code";
import { configDir, Poller } from "./poller.ts";

/**
 * Starts the answer loop in each interactive session; see poller.ts. A hot reload loads this
 * module afresh: the old loop dies with the old module, and `session.start` starts a new one.
 */
export const register: Register = (on) => {
  let poller: Poller | undefined;

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    if (!e.isInteractive) return started;
    void poller?.stop();
    const dir = configDir({
      STARBRIDGE_CONFIG_DIR: await $.env.get("STARBRIDGE_CONFIG_DIR"),
      XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
      HOME: await $.env.get("HOME"),
    });
    poller = new Poller(
      {
        sessionId: () => $.session.id(),
        run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
        read: (path) => $.fs.read(path),
        write: (path, text) => $.fs.write(path, text),
        mtime: async (path) => (await $.fs.stat(path).catch(() => undefined))?.mtimeMs,
        now: () => $.clock.now(),
        sleep: (ms) => $.clock.sleep(ms),
        submit: (text) => void $.prompt.submit({ text }),
        status: (text) => $.ui.status(text),
        log: (text) => $.ui.log(text, { to: "debug" }),
      },
      dir,
    );
    return started;
  });

  // After a /clear the process goes on under a new session id, and the loop reads it each step.
  on("session.end", async (_$, e, next) => {
    if (e.reason !== "clear") {
      await poller?.stop();
      poller = undefined;
    }
    return next(e);
  });
};
