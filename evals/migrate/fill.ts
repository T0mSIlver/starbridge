/**
 * Gives the users setup.ts made (../load) what a week of use leaves: each machine posts
 * `--decisions` decisions sealed to its phone and page, the phone or the page answers half of them,
 * and the machine posts a run and a quota snapshot. Through the server's own API, as load.ts posts,
 * each user from its own made-up address.
 *
 *   bun evals/migrate/fill.ts --server http://127.0.0.1:18080 --decisions 20
 *
 * grow.ts then copies these rows until the database reaches its size.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { box, id, LOAD_DIR, type User } from "../load/lib.ts";

const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://127.0.0.1:18080" },
    decisions: { type: "string", default: "20" },
    concurrency: { type: "string", default: "16" },
  },
});
const users = readFileSync(`${LOAD_DIR}/users.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as User);

async function post(u: User, token: string, item: unknown): Promise<void> {
  for (let tries = 0; ; tries++) {
    const res = await fetch(`${values.server}/v1/items`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${(u.n >> 16) & 255}.${(u.n >> 8) & 255}.${u.n & 255}`,
      },
      body: JSON.stringify(item),
    });
    const text = await res.text();
    if (res.status === 201) return;
    if (res.status === 429 && tries < 10) {
      await Bun.sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
      continue;
    }
    throw new Error(`user ${u.n}: POST /items ${res.status} ${text.slice(0, 200)}`);
  }
}

async function fillUser(u: User) {
  for (let i = 0; i < Number(values.decisions); i++) {
    const d = id("d");
    await post(u, u.machine, {
      v: 1,
      kind: "decision",
      id: d,
      from: "mac",
      boxes: [
        { to: "phone", box: box(1500) },
        { to: "web", box: box(1500) },
      ],
    });
    if (i % 2) continue;
    const [from, token] = i % 4 ? ["phone", u.phone] : ["web", u.web];
    await post(u, token, {
      v: 1,
      kind: "answer",
      id: id("a"),
      from,
      re: d,
      boxes: [{ to: "mac", box: box(600) }],
    });
  }
  const to = [
    { to: "phone", box: box(800) },
    { to: "web", box: box(800) },
  ];
  await post(u, u.machine, { v: 1, kind: "run", id: id("r"), from: "mac", boxes: to });
  await post(u, u.machine, { v: 1, kind: "quota", id: id("q"), from: "mac", boxes: to });
}

let next = 0;
let done = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < users.length) {
      await fillUser(users[next++] as User);
      if (++done % 500 === 0)
        console.log(`${done} users filled (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }),
);
console.log(`${done} users filled`);
