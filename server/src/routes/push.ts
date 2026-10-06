import { Hono } from "hono";
import { z } from "zod";
import { fail, memberOf, randomToken, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { ipKey, rateLimit } from "../limits";
import { checkTarget, PushTarget } from "../push";

/** Most subscriptions one device, and one account, may hold. */
const DEVICE_SUBSCRIPTIONS = 10;
const ACCOUNT_SUBSCRIPTIONS = 30;

export const pushRoutes = new Hono<Env>();

pushRoutes.post("/push/subscriptions", requireCaller("paired-device"), async (c) => {
  rateLimit(c, `push-sub:${c.var.caller.account}`, c.var.config.limits.pushSubscribes);
  const target = await json(c, PushTarget);
  recheck(c);
  const why = checkTarget(target, c.var.config.allowPrivatePushEndpoints);
  if (why) fail(400, "bad-endpoint", why);
  const caller = c.var.caller;
  const member = memberOf(caller);
  const db = c.var.db;
  const known = db
    .query(
      "SELECT 1 FROM push_subscriptions WHERE account_id = ? AND member_id = ? AND endpoint = ?",
    )
    .get(caller.account, member, target.endpoint);
  if (!known) {
    const { mine, total } = db
      .query(
        `SELECT COUNT(*) FILTER (WHERE member_id = ?) AS mine, COUNT(*) AS total
         FROM push_subscriptions WHERE account_id = ?`,
      )
      .get(member, caller.account) as { mine: number; total: number };
    if (mine >= DEVICE_SUBSCRIPTIONS || total >= ACCOUNT_SUBSCRIPTIONS)
      fail(409, "too-many-subscriptions", "delete an old subscription first");
  }
  // Subscribing the same endpoint again keeps its id and takes the new keys.
  const row = db
    .query(
      `INSERT INTO push_subscriptions (id, account_id, member_id, type, endpoint, keys, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, member_id, endpoint) DO UPDATE SET type = excluded.type, keys = excluded.keys
       RETURNING id`,
    )
    .get(
      randomToken("ps_").slice(0, 24),
      caller.account,
      member,
      target.type,
      target.endpoint,
      target.keys ? JSON.stringify(target.keys) : null,
      new Date().toISOString(),
    ) as { id: string };
  return c.json({ id: row.id }, 201);
});

pushRoutes.delete("/push/subscriptions/:id", requireCaller("paired-device"), (c) => {
  const caller = c.var.caller;
  const r = c.var.db
    .query("DELETE FROM push_subscriptions WHERE id = ? AND account_id = ? AND member_id = ?")
    .run(c.req.param("id"), caller.account, memberOf(caller));
  if (r.changes === 0) fail(404, "not-found");
  return c.body(null, 204);
});

/** The key a browser passes as `applicationServerKey` when it subscribes. */
pushRoutes.get("/push/vapid", async (c) => {
  const publicKey = await c.var.push.vapidPublicKey();
  if (!publicKey) fail(404, "not-configured", "no Web Push key and no relay");
  return c.json({ publicKey });
});

/**
 * Relayed Web Pushes in flight, per push service (one per app) and per address, for the
 * relaySends and relaySendsPerClient caps.
 */
const relaying = new WeakMap<object, Map<string, number>>();

/**
 * Relay mode: forwards another server's push with this server's FCM and VAPID credentials.
 * The payload is already the device's ciphertext or an item id.
 */
pushRoutes.post("/relay", async (c) => {
  const { config, push } = c.var;
  if (!config.relayMode) fail(404, "not-found");
  rateLimit(c, `relay:${ipKey(c)}`, [120, 60_000]);
  const body = await json(c, PushTarget.extend({ payload: z.string().max(4000) }));
  if (body.type === "unifiedpush")
    fail(400, "bad-request", "UnifiedPush goes direct, not through the relay");
  const why = checkTarget(body, config.allowPrivatePushEndpoints);
  if (why) fail(400, "bad-endpoint", why);
  const { payload, ...target } = body;
  // A Web Push goes to whatever host the caller names, which may hold it for pushTimeoutMs; FCM
  // goes to Google, so only Web Push counts toward the caps and the self-hosters' Android
  // pushes always get through.
  const flights = relaying.get(push) ?? new Map<string, number>();
  relaying.set(push, flights);
  const keys = target.type === "webpush" ? ["", ipKey(c)] : [];
  const full = (k: string) =>
    (flights.get(k) ?? 0) >= (k ? config.limits.relaySendsPerClient : config.limits.relaySends);
  if (keys.some(full))
    return c.json({ error: "busy", detail: "too many pushes in flight; retry later" }, 503, {
      "retry-after": "5",
    });
  for (const k of keys) flights.set(k, (flights.get(k) ?? 0) + 1);
  const result = await push.send(target, payload, false).finally(() => {
    for (const k of keys) {
      const n = (flights.get(k) ?? 1) - 1;
      if (n) flights.set(k, n);
      else flights.delete(k);
    }
  });
  c.var.usage.record(`relay.${target.type}.${result}`);
  return c.json({ result }, result === "failed" ? 502 : 200);
});
