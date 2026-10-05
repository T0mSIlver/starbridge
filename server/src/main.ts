import { createApp } from "./app";
import { configFromEnv } from "./config";
import { openDb } from "./db";
import { formatReport, report } from "./usage";

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
const { app } = await createApp(config);

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
].filter(Boolean);
console.log(
  `starbridge server on port ${server.port} (${modes.join(", ") || "no sign-in configured"})`,
);
