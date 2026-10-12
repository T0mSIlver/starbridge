import {
  MachineRelease,
  type MachineReleases,
  parseClientHeader,
  versionBelow,
} from "@starbridge/protocol";
import { Hono } from "hono";
import { memberOf, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { rateLimit } from "../limits";

export const releaseRoutes = new Hono<Env>();

/**
 * A machine says which CLI release it runs and the latest its agent read from GitHub (#1050), for
 * the devices' Devices lists. Only about itself; nothing is pushed. A release other than the one
 * it said before stamps `cli_updated_at` (#1266); SET reads the row's old values.
 */
releaseRoutes.put("/release", requireCaller("machine"), async (c) => {
  const caller = c.var.caller;
  const member = memberOf(caller);
  rateLimit(c, `release:${caller.account}:${member}`, c.var.config.limits.releaseWrites);
  const { version, latest } = await json(c, MachineRelease);
  recheck(c);
  c.var.db
    .query(
      `UPDATE members SET cli_updated_at = CASE WHEN cli_version IS NOT NULL AND cli_version != ?1
         THEN ?2 ELSE cli_updated_at END, cli_version = ?1, cli_latest = ?3
       WHERE account_id = ?4 AND id = ?5`,
    )
    .run(version, new Date().toISOString(), latest, caller.account, member);
  return c.body(null, 204);
});

releaseRoutes.get("/releases", requireCaller("paired-device"), (c) => {
  const rows = c.var.db
    .query(
      "SELECT id, cli_version, cli_latest, cli_updated_at FROM members WHERE account_id = ? AND role = 'machine' AND active = 1 AND cli_version IS NOT NULL",
    )
    .all(c.var.caller.account) as {
    id: string;
    cli_version: string;
    cli_latest: string | null;
    cli_updated_at: string | null;
  }[];
  const releases: MachineReleases = {
    machines: Object.fromEntries(
      rows.map((r) => {
        const running = parseClientHeader(`cli/${r.cli_version}`);
        const behind = !!running && r.cli_latest !== null && versionBelow(running, r.cli_latest);
        return [
          r.id,
          { version: r.cli_version, latest: r.cli_latest, behind, updatedAt: r.cli_updated_at },
        ];
      }),
    ),
  };
  return c.json(releases);
});
