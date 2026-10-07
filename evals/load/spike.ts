/**
 * A Show HN spike on the scratch stack through Caddy: visitors arrive at `--rates` per second,
 * one stage each, and do what a browser does on the landing page, then a share signs in and a
 * share of those sets Starbridge up and tries it.
 *
 * - visitor: the page (rendered per request), its scripts, styles and fonts, the four landing
 *   pictures of one theme, `GET /v1/me`, Umami's script and one event;
 * - `--docs` of visitors then open `/docs` and the FAQ;
 * - `--signin` of visitors start the GitHub sign-in and stop there;
 * - `--signup` of visitors sign in on the phone and the page and pair a machine (accounts.ts),
 *   then try it until the run ends: the machine holds its answers long-poll and the page its
 *   join list long-poll and 20 s inbox poll; the machine asks a first question with a picture,
 *   then one every `--every` s (a third with a picture), each answered after about 20 s, one
 *   answer in three a Done; a quota snapshot every 5 minutes. Each question sends a push to the
 *   phone and the page (fake.ts).
 *
 * Each visitor comes from its own address (X-Sim-IP, stack.sh), but `--nat` of them share one of
 * `--nat-ips` addresses, as an office or a carrier's NAT would. Run it beside load.ts, whose
 * users stand for the accounts made before the launch.
 *
 *   evals/load/stack.sh spike --rates 2,5,10,20,40 --stage 120
 */
import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { ready } from "../../packages/protocol/src/index.ts";
import { makeUser } from "./accounts.ts";
import { box, expMs, Hist, id, LOAD_DIR, type User } from "./lib.ts";

const { values } = parseArgs({
  options: {
    rates: { type: "string", default: "2,5,10" },
    stage: { type: "string", default: "120" },
    signin: { type: "string", default: "0.1" },
    signup: { type: "string", default: "0.04" },
    /** Share of visitors who then read the docs: /docs and the FAQ. */
    docs: { type: "string", default: "0.3" },
    every: { type: "string", default: "300" },
    /** Bytes of the picture, before base64. */
    image: { type: "string", default: "250000" },
    nat: { type: "string", default: "0" },
    "nat-ips": { type: "string", default: "20" },
    /** A stage fails when its landing page p99 passes this many ms. */
    slow: { type: "string", default: "3000" },
    fake: { type: "string", default: "http://host.docker.internal:18099" },
    out: { type: "string" },
  },
});
await ready;

const TARGET = process.env.LOAD_TARGET ?? "http://caddy:18000";
const WEBSITE = "f3741d82-c450-47d3-8845-646cddbe392f";
const WINDOW_MS = 10_000;
const LONG = new Set(["answers.wait", "joins.wait"]);
const rates = values.rates.split(",").map(Number);
const stageMs = Number(values.stage) * 1000;

type Op = { hist: Hist; errors: Record<string, number> };
let ops = new Map<string, Op>();
let stageOps = new Map<string, Op>();
const op = (m: Map<string, Op>, name: string) => {
  const o = m.get(name) ?? { hist: new Hist(), errors: {} };
  m.set(name, o);
  return o;
};
function record(name: string, ms: number, error?: string) {
  for (const m of [ops, stageOps]) {
    const o = op(m, name);
    o.hist.add(ms);
    if (error) o.errors[error] = (o.errors[error] ?? 0) + 1;
  }
}

/** The route a URL names, ids and queries left out, as each request's latency is filed. */
function route(method: string, url: string): string {
  const u = new URL(url);
  if (u.pathname.startsWith("/_next/static/media/")) return "font";
  if (u.pathname.startsWith("/_next/static/")) return "chunk";
  if (u.pathname.startsWith("/landing/")) return "picture";
  const p = u.pathname
    .replace(/^\/v1/, "")
    .replace(/\/[0-9A-Z]{8}(?=\/|$)/g, "/:r")
    .replace(/^\/stats\/api\/send$/, "umami.send");
  if (p === "/answers" && u.searchParams.get("wait") !== "0") return "answers.wait";
  if (p === "/joins" && u.searchParams.has("wait")) return "joins.wait";
  return `${method} ${p}`;
}

// Every request the visitors and accounts.ts make is timed and filed by route.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const name = route(init?.method ?? "GET", url);
  const t = performance.now();
  try {
    const res = await realFetch(input, init);
    const body = await res.arrayBuffer();
    record(name, performance.now() - t, res.status >= 400 ? String(res.status) : undefined);
    return new Response(res.status === 204 || res.status === 304 ? null : body, {
      status: res.status,
      headers: res.headers,
    });
  } catch (e) {
    record(name, performance.now() - t, (e as { code?: string }).code ?? "net");
    throw e;
  }
}) as typeof fetch;

// --- The landing page's files, as a browser fetches them ------------------------------------

async function assets(): Promise<string[]> {
  const res = await realFetch(`${TARGET}/`);
  const html = await res.text();
  const files = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g))
    files.add(m[1] as string);
  for (const m of (res.headers.get("link") ?? "").matchAll(/<(\/_next\/static\/[^>]+)>/g))
    files.add(m[1] as string);
  for (const f of readdirSync(`${import.meta.dir}/../../web/public/landing`))
    if (f.endsWith("-light.webp")) files.add(`/landing/${f}`);
  return [...files];
}
const files = await assets();
console.log(`landing page: ${files.length} files`);

const ip = () =>
  Math.random() < Number(values.nat)
    ? `198.51.100.${Math.floor(Math.random() * Number(values["nat-ips"]))}`
    : `${11 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

let stopped = false;
const counts = { visitors: 0, signins: 0, signups: 0, signupFailed: 0, limited: 0, trying: 0 };
const limitedBy: Record<string, number> = {};
const got = (r: Response) => r.status;

async function visitor() {
  counts.visitors++;
  const addr = ip();
  const h = { "x-sim-ip": addr, "accept-encoding": "gzip, br, zstd" };
  const t = performance.now();
  try {
    const page = await fetch(`${TARGET}/`, { headers: h });
    if (page.status !== 200) return record("landing.full", performance.now() - t, "page");
    // A browser fetches about six at a time from one host over HTTP/1.1, all at once over h2.
    const queue = [...files];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift())
          await fetch(`${TARGET}${f}`, { headers: h }).then(got);
      }),
    );
    await Promise.all([
      fetch(`${TARGET}/v1/me`, { headers: h }).then(got),
      fetch(`${TARGET}/stats/script.js`, { headers: h }).then(got),
    ]);
    record("landing.full", performance.now() - t);
    await fetch(`${TARGET}/stats/api/send`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "user-agent": "Mozilla/5.0 load" },
      body: JSON.stringify({
        type: "event",
        payload: {
          website: WEBSITE,
          hostname: "starbridge.run",
          url: "/",
          referrer: "https://news.ycombinator.com/",
          language: "en-US",
          screen: "1920x1080",
          title: "Starbridge",
        },
      }),
    }).then(got);
  } catch {
    return record("landing.full", performance.now() - t, "net");
  }
  if (Math.random() < Number(values.docs))
    for (const path of ["/docs", "/docs/faq"])
      await fetch(`${TARGET}${path}`, { headers: h }).then(got).catch(() => {});
  const r = Math.random();
  if (r < Number(values.signup)) return signup(addr);
  if (r < Number(values.signin)) {
    counts.signins++;
    await fetch(`${TARGET}/v1/auth/github`, { headers: h, redirect: "manual" }).catch(() => {});
  }
}

async function signup(addr: string) {
  counts.signups++;
  const t = performance.now();
  try {
    const u = await makeUser(2_000_000 + counts.signups, {
      server: TARGET,
      fake: values.fake,
      ip: addr,
      viaCaddy: true,
      limited: (path) => {
        counts.limited++;
        limitedBy[path] = (limitedBy[path] ?? 0) + 1;
      },
    });
    record("signup", performance.now() - t);
    tryIt(u);
  } catch (e) {
    counts.signupFailed++;
    record("signup", performance.now() - t, String(e).slice(0, 60));
  }
}

// --- A new account trying Starbridge ---------------------------------------------------------

let delivery = new Hist();
let stageDelivery = new Hist();
const answers = new Map<string, number>();

async function api(u: string, method: string, path: string, body?: unknown) {
  try {
    const res = await fetch(`${TARGET}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${u}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : undefined };
  } catch {
    return { status: 0, json: undefined };
  }
}

async function tryIt(u: User) {
  counts.trying++;
  const image = Number(values.image);
  // The machine's answers long-poll.
  (async () => {
    let cursor = "";
    while (!stopped) {
      const r = await api(
        u.machine,
        "GET",
        `/answers?wait=60&directory=${u.directory}${cursor ? `&after=${cursor}` : ""}`,
      );
      if (r.status !== 200) {
        await Bun.sleep(5000);
        continue;
      }
      for (const s of r.json.items as { item: { id: string } }[]) {
        const at = answers.get(s.item.id);
        if (at === undefined) continue;
        answers.delete(s.item.id);
        delivery.add(Date.now() - at);
        stageDelivery.add(Date.now() - at);
      }
      cursor = r.json.cursor;
    }
  })();
  // The page: join list long-poll and inbox poll.
  (async () => {
    let c = "0";
    while (!stopped) {
      const r = await api(u.web, "GET", `/joins?after=${c}&wait=25`);
      if (r.status === 200) c = r.json.cursor;
      else await Bun.sleep(5000);
    }
  })();
  (async () => {
    let c = "";
    while (!stopped) {
      const r = await api(
        u.web,
        "GET",
        `/items?kind=decision,settled,waiting${c ? `&after=${c}` : ""}`,
      );
      if (r.status === 200) c = r.json.cursor;
      await Bun.sleep(20_000);
    }
  })();
  (async () => {
    await Bun.sleep(Math.random() * 300_000);
    while (!stopped) {
      await api(u.machine, "POST", "/items", {
        v: 1,
        kind: "quota",
        id: id("q"),
        from: "mac",
        quiet: true,
        boxes: [
          { to: "phone", box: box(2000) },
          { to: "web", box: box(2000) },
        ],
      });
      await Bun.sleep(300_000);
    }
  })();
  await Bun.sleep(10_000);
  for (let n = 0; !stopped; n++) {
    const size = 1500 + (n === 0 || Math.random() < 1 / 3 ? Math.ceil((image * 4) / 3) : 0);
    const d = id("d");
    const r = await api(u.machine, "POST", "/items", {
      v: 1,
      kind: "decision",
      id: d,
      from: "mac",
      boxes: [
        { to: "phone", box: box(size) },
        { to: "web", box: box(size) },
      ],
    });
    if (r.status === 201) {
      (async () => {
        await Bun.sleep(expMs(20_000));
        if (stopped) return;
        const [from, token] = Math.random() < 0.5 ? ["phone", u.phone] : ["web", u.web];
        const a = id("a");
        answers.set(a, Date.now());
        // A Done carries `done: true` inside the box: the server sees an answer like any other.
        const ok = await api(token, "POST", "/items", {
          v: 1,
          kind: "answer",
          id: a,
          from,
          re: d,
          boxes: [{ to: "mac", box: box(600) }],
        });
        if (ok.status !== 201) answers.delete(a);
      })();
    }
    await Bun.sleep(expMs(Number(values.every) * 1000));
  }
}

// --- Stages ------------------------------------------------------------------------------------

const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};
const p = (h: Hist | undefined, q: number) => (h?.n ? h.q(q).toFixed(0) : "-");
const errs = (m: Map<string, Op>) =>
  Object.fromEntries(
    [...m].flatMap(([k, o]) => Object.entries(o.errors).map(([c, n]) => [`${k}:${c}`, n])),
  );
function line(m: Map<string, Op>, secs: number, d: Hist) {
  let n = 0;
  const api = new Hist();
  for (const [k, o] of m) {
    n += o.hist.n;
    if (/^(GET|POST|DELETE) \/./.test(k) && !k.includes("/stats/") && !LONG.has(k))
      api.merge(o.hist);
  }
  const g = (k: string) => m.get(k)?.hist;
  return `rps=${(n / secs).toFixed(0)} page p50=${p(g("GET /"), 0.5)} p99=${p(g("GET /"), 0.99)} full p99=${p(g("landing.full"), 0.99)} chunk p99=${p(g("chunk"), 0.99)} api p50=${p(api, 0.5)} p99=${p(api, 0.99)} post.items p99=${p(g("POST /items"), 0.99)} signup p50=${p(g("signup"), 0.5)} p99=${p(g("signup"), 0.99)}ms answer delivery p99=${p(d, 0.99)}ms`;
}

const t0 = Date.now();
let broke = "";
for (const [i, rate] of rates.entries()) {
  stageOps = new Map();
  stageDelivery = new Hist();
  const end = t0 + (i + 1) * stageMs;
  const arrivals = (async () => {
    while (Date.now() < end && !broke) {
      await Bun.sleep(expMs(1000 / rate));
      visitor();
    }
  })();
  while (Date.now() < end) {
    await Bun.sleep(WINDOW_MS);
    say(
      `t=${((Date.now() - t0) / 1000).toFixed(0)}s rate=${rate}/s ${line(ops, WINDOW_MS / 1000, delivery)} trying=${counts.trying} errors ${JSON.stringify(errs(ops))}`,
    );
    ops = new Map();
    delivery = new Hist();
  }
  await arrivals;
  const page = stageOps.get("GET /")?.hist;
  say(
    `STAGE rate=${rate}/s ${line(stageOps, stageMs / 1000, stageDelivery)} ${JSON.stringify(counts)} limited=${JSON.stringify(limitedBy)} errors=${JSON.stringify(errs(stageOps))}\n  p99 by op (ms): ${[
      ...stageOps,
    ]
      .filter(([k]) => !LONG.has(k))
      .map(([k, o]) => `${k} ${p(o.hist, 0.99)}`)
      .join(", ")}`,
  );
  const total = [...stageOps.values()].reduce((a, o) => a + o.hist.n, 0);
  const failed = [...stageOps.values()].reduce(
    (a, o) =>
      a +
      Object.entries(o.errors)
        .filter(([c]) => !["401", "429"].includes(c))
        .reduce((b, [, n]) => b + n, 0),
    0,
  );
  if (page && page.q(0.99) > Number(values.slow))
    broke = `page p99 passed ${values.slow} ms at ${rate}/s`;
  else if (failed > total / 100) broke = `over 1% of requests failed at ${rate}/s`;
  if (broke) break;
}
say(broke ? `BROKE: ${broke}` : "held every stage");
stopped = true;
if (values.out)
  await Bun.write(
    values.out.startsWith("/") ? values.out : `${LOAD_DIR}/${values.out}`,
    `${log.join("\n")}\n`,
  );
process.exit(0);
