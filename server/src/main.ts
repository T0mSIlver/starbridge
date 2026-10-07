import { createApp } from "./app";
import { configFromEnv } from "./config";
import { openDb, SCHEMA_VERSION } from "./db";
import { describe, parseValue, readOverrides, writeOverrides } from "./overrides";
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
// `limits [show]`, `limits set KEY VALUE`, `limits unset KEY`, `limits reset`: the owner's
// runtime limits, which the running server applies within a minute (#786).
// deploy/host/switch.sh runs it and logs each change.
if (process.argv[2] === "limits") {
  const [what = "show", key, value] = process.argv.slice(3);
  // A reset needs no readable file: it is how a broken one goes.
  const over = what === "reset" ? {} : readOverrides(config);
  if (what === "set" && key && value)
    writeOverrides(config, { ...over, [key]: parseValue(key, value) });
  else if (what === "unset" && key) {
    const { [key as keyof typeof over]: _, ...rest } = over;
    writeOverrides(config, rest);
  } else if (what === "reset") writeOverrides(config, {});
  else if (what !== "show") throw new Error("limits [show] | set KEY VALUE | unset KEY | reset");
  console.log(describe(readOverrides(config)));
  if (what !== "show") console.log("the server applies it within a minute");
  process.exit(0);
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
