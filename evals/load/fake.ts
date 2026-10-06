/**
 * Stands in for GitHub's OAuth and for the push services, so the stack signs users in and sends
 * every push for real without leaving the machine. Each push waits PUSH_MS, about what FCM takes,
 * so the server holds its outgoing connections as long as it would in prod.
 *
 *   bun evals/load/fake.ts --host 172.17.0.1   (the host's address on Docker's bridge)
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "18099" },
  },
});
const PUSH_MS = 80;
const counts: Record<string, number> = { token: 0, user: 0, fcm: 0, webpush: 0 };

const server = Bun.serve({
  hostname: values.host,
  port: Number(values.port),
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/login/oauth/access_token") {
      counts.token++;
      // The code is the GitHub user id the load script picked; the token carries it on.
      const { code } = (await req.json()) as { code: string };
      return Response.json({ access_token: `gh_${code}` });
    }
    if (path === "/user") {
      counts.user++;
      const id = Number(req.headers.get("authorization")?.replace(/^Bearer gh_/, ""));
      return Response.json({ id, login: `load${id}` });
    }
    if (path === "/token") return Response.json({ access_token: "fcm", expires_in: 3600 });
    if (path.endsWith("/messages:send")) {
      counts.fcm++;
      await Bun.sleep(PUSH_MS);
      return Response.json({ name: "projects/load/messages/1" });
    }
    if (path.startsWith("/wp/")) {
      counts.webpush++;
      await Bun.sleep(PUSH_MS);
      return new Response(null, { status: 201 });
    }
    if (path === "/counts") return Response.json(counts);
    return new Response("not found", { status: 404 });
  },
});
console.log(`fake GitHub and push on ${server.hostname}:${server.port}`);
