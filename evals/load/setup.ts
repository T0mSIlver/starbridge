/**
 * Makes users for load.ts (accounts.ts) and appends them to $LOAD_DIR/users.jsonl, so a later
 * run adds only what is missing.
 *
 *   bun evals/load/setup.ts --users 3000
 *
 * It calls the server directly (port 18080), each user from its own made-up address in
 * X-Forwarded-For, so the per-address sign-in and pairing limits do not slow the setup down.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ready } from "../../packages/protocol/src/index.ts";
import { makeUser } from "./accounts.ts";
import { LOAD_DIR } from "./lib.ts";

const { values } = parseArgs({
  options: {
    users: { type: "string", default: "100" },
    concurrency: { type: "string", default: "16" },
    server: { type: "string", default: "http://127.0.0.1:18080" },
    fake: { type: "string", default: "http://host.docker.internal:18099" },
  },
});
const FILE = `${LOAD_DIR}/users.jsonl`;
await ready;

const have = existsSync(FILE) ? readFileSync(FILE, "utf8").split("\n").filter(Boolean).length : 0;
const want = Number(values.users);
let next = have;
let made = 0;
const started = Date.now();
async function worker() {
  while (next < want) {
    const n = next++;
    const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
    const user = await makeUser(n, { server: values.server, fake: values.fake, ip });
    appendFileSync(FILE, `${JSON.stringify(user)}\n`);
    if (++made % 100 === 0)
      console.log(`${have + made} users (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
console.log(`${have + made} users in ${FILE}`);
