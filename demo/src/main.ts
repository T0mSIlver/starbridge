/**
 * The demo program for Play reviewers (#423), beside a demo server (DEMO=1). It goes on with the
 * account it saved in DEMO_DATA, so phones set up before a restart stay in it (#2049), and exits
 * when the demo breaks; its container then restarts, on a fresh account only when the old one
 * is past repair.
 */
import { join } from "node:path";
import { DemoDevice } from "./device";
import { DemoMachine, resumeDemo } from "./machine";

const env = process.env;
const server = env.DEMO_SERVER ?? "http://127.0.0.1:8080";
const ownerToken = env.OWNER_TOKEN;
if (!ownerToken) throw new Error("OWNER_TOKEN is not set");
const data = env.DEMO_DATA ?? "/data";

const device = new DemoDevice(server, ownerToken);
// The server starts beside this program.
for (let i = 0; ; i++) {
  const up = await fetch(`${server}/healthz`).then(
    (r) => r.ok,
    () => false,
  );
  if (up) break;
  if (i === 60) throw new Error(`${server} is not up`);
  await Bun.sleep(500);
}
const machine = new DemoMachine(
  {
    cli: (env.DEMO_CLI ?? "bun /app/starbridge.js").split(" "),
    server,
    dir: join(data, "machine"),
    codexbar: env.DEMO_CODEXBAR ?? "/app/codexbar",
  },
  device,
);
const how = await resumeDemo(device, machine, data);
console.log(`demo ready: ${how} account ${device.account}`);

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
