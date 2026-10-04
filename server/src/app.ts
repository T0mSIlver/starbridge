import { ready } from "@starbridge/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { SESSION_COOKIE } from "./auth";
import type { Config } from "./config";
import { openDb } from "./db";
import type { Deps, Env } from "./env";
import { Push } from "./push";
import { RateLimiter } from "./ratelimit";
import { authRoutes } from "./routes/auth";
import { directoryRoutes } from "./routes/directory";
import { itemRoutes } from "./routes/items";
import { pairingRoutes, sweepPairings } from "./routes/pairings";
import { pushRoutes } from "./routes/push";
import { Waiters } from "./waiters";

export async function createApp(config: Config, fetchFn: typeof fetch = fetch) {
  await ready;
  const db = openDb(config.dbPath);
  const deps: Deps = {
    config,
    db,
    push: new Push(config, db, fetchFn),
    answers: new Waiters(),
    pairings: new Waiters(),
    limiter: new RateLimiter(),
  };

  setInterval(() => sweepPairings(db), 60_000).unref();

  const v1 = new Hono<Env>()
    .route("/", authRoutes)
    .route("/", directoryRoutes)
    .route("/", pairingRoutes)
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
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "too-large" }, 413),
    }),
  );
  app.get("/healthz", (c) => c.text("ok"));
  app.route("/v1", v1);
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    console.error(e);
    return c.json({ error: "internal" }, 500);
  });
  return { app, deps };
}
