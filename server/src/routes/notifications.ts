import { DeviceNotifications, type NotificationStates } from "@starbridge/protocol";
import { Hono } from "hono";
import { memberOf, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { rateLimit } from "../limits";

export const notificationRoutes = new Hono<Env>();

/**
 * A device says whether it notifies (#943), for the other devices' Devices lists. Only about
 * itself: no device turns another's notifications off, and pushes go out as before. The server
 * notes which app said it (#1019), for the icon each list shows.
 */
notificationRoutes.put("/notifications", requireCaller("paired-device"), async (c) => {
  const caller = c.var.caller;
  const member = memberOf(caller);
  rateLimit(c, `notifications:${caller.account}:${member}`, c.var.config.limits.notificationWrites);
  const { state } = await json(c, DeviceNotifications);
  recheck(c);
  c.var.db
    .query("UPDATE members SET notify = ?, client = ? WHERE account_id = ? AND id = ?")
    .run(state, caller.role === "device" ? caller.client : null, caller.account, member);
  return c.body(null, 204);
});

notificationRoutes.get("/notifications", requireCaller("paired-device"), (c) => {
  const rows = c.var.db
    .query(
      "SELECT id, notify, client FROM members WHERE account_id = ? AND role = 'device' AND active = 1 AND notify IS NOT NULL",
    )
    .all(c.var.caller.account) as {
    id: string;
    notify: NotificationStates["devices"][string];
    client: string | null;
  }[];
  const states: NotificationStates = {
    devices: Object.fromEntries(rows.map((r) => [r.id, r.notify])),
    clients: Object.fromEntries(rows.flatMap((r) => (r.client ? [[r.id, r.client]] : []))),
  };
  return c.json(states);
});
