/**
 * The demo program for Play reviewers (#423), beside a demo server (DEMO=1) on an empty
 * database. It exits when the demo breaks, and its container restarts with a fresh account.
 */
import { DemoDevice } from "./device";
import { DemoMachine } from "./machine";

const env = process.env;
const server = env.DEMO_SERVER ?? "http://127.0.0.1:8080";
const ownerToken = env.OWNER_TOKEN;
if (!ownerToken) throw new Error("OWNER_TOKEN is not set");

const device = new DemoDevice(server, ownerToken);
// The server starts beside this program.
for (let i = 0; ; i++) {
  const up = await fetch(`${server}/healthz`).then((r) => r.ok, () => false);
  if (up) break;
  if (i === 60) throw new Error(`${server} is not up`);
  await Bun.sleep(500);
}
await device.createAccount();
const machine = new DemoMachine(
  {
    cli: (env.DEMO_CLI ?? "bun /app/starbridge.js").split(" "),
    server,
    dir: env.DEMO_DIR ?? "/tmp/demo-machine",
    codexbar: env.DEMO_CODEXBAR ?? "/app/codexbar",
  },
  device,
);
await machine.pair();
console.log(`demo ready: account ${device.account}`);

const stop = new AbortController();
try {
  await Promise.race([
    device.approveJoins(stop.signal),
    machine.agent(),
    machine.questions(stop.signal),
    machine.runs(stop.signal),
  ]);
} catch (e) {
  console.error(`demo stopped: ${(e as Error).message}`);
} finally {
  stop.abort();
  machine.stop();
  process.exit(1);
}
