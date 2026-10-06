import { stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ready } from "@starbridge/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { SESSION_COOKIE } from "./auth";
import { clientVersion } from "./clients";
import type { Config } from "./config";
import { openDb } from "./db";
import type { Deps, Env } from "./env";
import { Push } from "./push";
import { RateLimiter } from "./ratelimit";
import { sweepStorage } from "./retention";
import { authRoutes } from "./routes/auth";
import { bindRoutes } from "./routes/bind";
import { directoryRoutes } from "./routes/directory";
import { itemRoutes } from "./routes/items";
import { joinRoutes, sweepJoins } from "./routes/joins";
import { pairingRoutes, sweepPairings } from "./routes/pairings";
import { pushRoutes } from "./routes/push";
import { wakeSnoozes } from "./snooze";
import { closeDays, diskFull, Usage } from "./usage";
import { Waiters } from "./waiters";

/** /healthz/backup fails past this; deploy/host/backup.sh runs nightly. */
const BACKUP_MAX_AGE_MS = 26 * 3_600_000;
/** /healthz/disk fails below this much free space beside the database. */
const DISK_MIN_FREE = 2 * 1024 ** 3;

export async function createApp(config: Config, fetchFn: typeof fetch = fetch) {
  await ready;
  const db = openDb(config.dbPath);
  const usage = new Usage(db);
  const deps: Deps = {
    config,
    db,
    push: new Push(config, db, fetchFn),
    answers: new Waiters(),
    quotas: new Waiters(),
    quotaAsks: new Map(),
    pairings: new Waiters(),
    joins: new Waiters(),
    limiter: new RateLimiter(),
    usage,
  };
  deps.push.onSent = (type, result) => usage.record(`push.${type}.${result}`);

  // Housekeeping deletes, and a delete needs room in the WAL: on a full disk it waits for the
  // next round rather than crash the server, at start included.
  const housekeep = (job: () => void) => () => {
    try {
      job();
    } catch (e) {
      if (!diskFull(e)) throw e;
    }
  };
  const minutely = housekeep(() => {
    sweepPairings(db);
    sweepJoins(db);
  });
  const hourly = housekeep(() => {
    sweepStorage(db, config.limits);
    closeDays(db);
  });
  setInterval(minutely, 60_000).unref();
  // Snoozed decisions come back within this much of their time (#571).
  const snoozes = housekeep(() => wakeSnoozes(db, deps.push, config.pushInlineLimit));
  setInterval(snoozes, 15_000).unref();
  hourly();
  setInterval(hourly, 3_600_000).unref();

  const v1 = new Hono<Env>()
    .use(clientVersion)
    .route("/", authRoutes)
    .route("/", bindRoutes)
    .route("/", directoryRoutes)
    .route("/", pairingRoutes)
    .route("/", joinRoutes)
    .route("/", itemRoutes)
    .route("/", pushRoutes);

  const app = new Hono<Env>();
  app.use(async (c, next) => {
    for (const [k, v] of Object.entries(deps)) c.set(k as keyof Deps, v as never);
    await next();
  });
  // The web page signs in with a cookie; refuse cross-site writes that would carry it. Browsers
  // send Origin on every cross-origin write, so a write without one comes from a non-browser.
  const origin = new URL(config.publicUrl).origin;
  app.use(async (c, next) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const sent = c.req.header("origin");
    if (unsafe && getCookie(c, SESSION_COOKIE) && sent !== undefined && sent !== origin)
      return c.json({ error: "forbidden", detail: "cross-site request" }, 403);
    await next();
  });
  app.use(
    bodyLimit({
      // A decision with images, sealed to every device: `itemBytes` plus the JSON around it.
      maxSize: 3 * 1024 * 1024,
      onError: (c) => c.json({ error: "too-large" }, 413),
    }),
  );
  // The deploy checks that the server it reaches runs the commit it deployed.
  app.get("/healthz", (c) => {
    if (config.revision) c.header("x-starbridge-revision", config.revision);
    return c.text("ok");
  });
  // deploy/host/backup.sh touches this file beside the database after each good backup. The
  // answer says only whether it is fresh, for the uptime check (.github/workflows/uptime.yml).
  const backupStamp = join(dirname(config.dbPath), "last-backup");
  app.get("/healthz/backup", async (c) => {
    const at = await stat(backupStamp).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    return Date.now() - at < BACKUP_MAX_AGE_MS ? c.text("ok") : c.text("backup stale", 503);
  });
  // The uptime check calls this too: a filling disk opens an issue before writes fail (#301).
  app.get("/healthz/disk", async (c) => {
    const { bavail, bsize } = await statfs(dirname(config.dbPath));
    // No figure: anyone can call it, and the headroom left is the operator's to know.
    return bavail * bsize >= DISK_MIN_FREE ? c.text("ok") : c.text("disk low", 503);
  });
  // The demo program (demo/) runs only against a server that answers this.
  if (config.demo) app.get("/v1/demo", (c) => c.json({ demo: true }));
  app.route("/v1", v1);
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  let fullLoggedAt = 0;
  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    // A full disk refuses writes while reads go on. Clients retry a 503; one line a minute
    // stands for the stack each refused write would print.
    if (diskFull(e)) {
      if (Date.now() - fullLoggedAt > 60_000) {
        fullLoggedAt = Date.now();
        console.error("disk full: refusing writes");
      }
      return c.json(
        { error: "storage-full", detail: "the server's disk is full; retry later" },
        503,
        { "retry-after": "60" },
      );
    }
    console.error(e);
    return c.json({ error: "internal" }, 500);
  });
  return { app, deps };
}
