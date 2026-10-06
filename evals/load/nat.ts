/**
 * USERS people behind one address, like an office NAT, all set Starbridge up within SPREAD
 * seconds: each signs in on the phone and the web page and pairs a machine and the page
 * (accounts.ts). Everything goes through Caddy, so the server sees one address. Prints each
 * per-address limit they hit and how long the slowest of them waited on it. Their use after the
 * setup meets no per-address limit at all: load.ts's users already share one address.
 *
 *   bun evals/load/nat.ts --users 20 --spread 60
 */
import { parseArgs } from "node:util";
import { ready } from "../../packages/protocol/src/index.ts";
import { makeUser } from "./accounts.ts";

const { values } = parseArgs({
  options: {
    users: { type: "string", default: "20" },
    spread: { type: "string", default: "60" },
    server: { type: "string", default: "http://127.0.0.1:18000" },
    fake: { type: "string", default: "http://host.docker.internal:18099" },
  },
});
await ready;

const hits = new Map<string, number>();
const waited: number[] = [];
const took: number[] = [];
await Promise.all(
  Array.from({ length: Number(values.users) }, async (_, i) => {
    await Bun.sleep(Math.random() * Number(values.spread) * 1000);
    const t = Date.now();
    let wait = 0;
    await makeUser(1_000_000 + i, {
      server: values.server,
      fake: values.fake,
      limited: (path, seconds) => {
        hits.set(path, (hits.get(path) ?? 0) + 1);
        wait += seconds;
      },
    });
    waited.push(wait);
    took.push((Date.now() - t) / 1000);
  }),
);
const max = (a: number[]) => Math.max(0, ...a);
console.log(
  JSON.stringify({
    users: Number(values.users),
    spread: Number(values.spread),
    limited: Object.fromEntries(hits),
    usersLimited: waited.filter((w) => w > 0).length,
    maxWaitSeconds: max(waited),
    maxSetupSeconds: Math.round(max(took)),
  }),
);
