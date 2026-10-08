import { AccountSettings, Presence } from "@starbridge/protocol";
import { Hono } from "hono";
import { memberOf, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { rateLimit } from "../limits";
import { pushHold } from "../presence";

export const presenceRoutes = new Hono<Env>();

/** A machine or a device says whether the owner sits at its screen (#848): one bit, never why. */
presenceRoutes.put("/presence", requireCaller("paired"), async (c) => {
  const caller = c.var.caller;
  const member = memberOf(caller);
  rateLimit(c, `presence:${caller.account}:${member}`, c.var.config.limits.presenceBeats);
  const { present } = await json(c, Presence);
  recheck(c);
  c.var.presence.beat(caller.account, member, present);
  return c.body(null, 204);
});

presenceRoutes.get("/settings", requireCaller("paired-device"), (c) => {
  const settings: AccountSettings = { pushHold: pushHold(c.var.db, c.var.caller.account) };
  return c.json(settings);
});

presenceRoutes.put("/settings", requireCaller("paired-device"), async (c) => {
  const caller = c.var.caller;
  rateLimit(c, `settings:${caller.account}`, c.var.config.limits.settingsWrites);
  const settings = await json(c, AccountSettings);
  recheck(c);
  c.var.db
    .query("UPDATE accounts SET push_hold = ? WHERE id = ?")
    .run(settings.pushHold, caller.account);
  return c.json(settings);
});
