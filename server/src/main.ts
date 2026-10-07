import { createApp } from "./app";
import { configFromEnv } from "./config";
import { openDb, SCHEMA_VERSION } from "./db";
import { formatReport, report } from "./usage";
import { Waiters } from "./waiters";

// `schema` prints the schema version this server migrates to, so a deploy backs the database up
// only when it will run a migration (#586).
if (process.argv[2] === "schema") {
  console.log(SCHEMA_VERSION);
  process.exit(0);
}
const config = configFromEnv();

// `usage [days]` prints the daily usage counts and exits. It runs on the server's host, so only
// whoever can open the database can read them.
if (process.argv[2] === "usage") {
  const days = Number(process.argv[3] ?? 7);
  if (!Number.isInteger(days) || days < 1)
    throw new Error("usage [days]: days is a positive integer");
  console.log(formatReport(report(openDb(config.dbPath), days)));
  process.exit(0);
}
// Anything else would start a second server beside the running one (deploy/host/switch.sh runs
// these commands in its container).
if (process.argv[2] !== undefined) {
  console.error(`unknown command: ${process.argv[2]}`);
  process.exit(2);
}
const { app, deps } = await createApp(config);

const server = Bun.serve({
  port: config.port,
  // Long-polls lift this per request; everything else idles out after it.
  idleTimeout: 30,
  fetch: (req, server) => app.fetch(req, { server }),
});

const modes = [
  config.github && "GitHub sign-in",
  config.ownerToken && "owner token",
  config.fcm ? "FCM" : config.relayUrl && "FCM via relay",
  config.vapid ? "Web Push" : config.relayUrl && "Web Push via relay",
  config.relayMode && "relay mode",
  config.demo && "DEMO",
].filter(Boolean);
console.log(
  `starbridge server on port ${server.port} (${modes.join(", ") || "no sign-in configured"})`,
);

// A deploy stops this container with SIGTERM (deploy/host/apply.sh). Long-polls answer at once,
// as if their wait passed, and the client's next one waits in Caddy until the new server is up.
process.on("SIGTERM", async () => {
  for (const w of Object.values(deps)) if (w instanceof Waiters) w.close();
  await server.stop();
  // Pushes already queued go out first: a snoozed question's return is pushed once (#571).
  await Promise.race([deps.push.idle(), Bun.sleep(10_000)]);
  process.exit(0);
});
