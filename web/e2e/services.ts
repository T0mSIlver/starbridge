// Stand-ins for the outside services the end-to-end run needs, on Bun:
// - GitHub OAuth: authorize redirects straight back, the token exchange and /user always succeed.
// - A Web Push service speaking Firefox's push WebSocket protocol (autopush). Firefox subscribes
//   through it, the Starbridge server posts RFC 8291 bodies to the endpoints it hands out, and
//   it relays them to Firefox, which decrypts them as with Mozilla's own service.
// Prints one JSON line per event so the driver (run.ts) can wait for them.
import type { ServerWebSocket } from "bun";

const GITHUB_PORT = Number(process.env.GITHUB_PORT ?? 3872);
const PUSH_PORT = Number(process.env.PUSH_PORT ?? 3873);

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

Bun.serve({
  port: GITHUB_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "stub-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      log({ event: "github-authorize" });
      return Response.redirect(back.toString(), 302);
    }
    if (url.pathname === "/login/oauth/access_token")
      return Response.json({ access_token: "stub-token", token_type: "bearer" });
    if (url.pathname === "/user") return Response.json({ id: 4242, login: "starbridge-e2e" });
    return new Response("not found", { status: 404 });
  },
});

type Socket = ServerWebSocket<{ uaid?: string }>;
const channels = new Map<string, Socket>();

Bun.serve<{ uaid?: string }, never>({
  port: PUSH_PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/" && server.upgrade(req, { data: {} })) return undefined;
    const m = /^\/wpush\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const ws = channels.get(m[1] as string);
      if (!ws) return new Response("gone", { status: 410 });
      const body = new Uint8Array(await req.arrayBuffer());
      ws.send(
        JSON.stringify({
          messageType: "notification",
          channelID: m[1],
          version: crypto.randomUUID(),
          data: Buffer.from(body).toString("base64url"),
          headers: { encoding: req.headers.get("content-encoding") ?? "aes128gcm" },
        }),
      );
      log({ event: "push", channel: m[1], bytes: body.length });
      return new Response(null, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open() {
      log({ event: "push-connected" });
    },
    message(ws: Socket, raw) {
      log({ event: "push-message", raw: String(raw).slice(0, 200) });
      const msg = JSON.parse(String(raw)) as { messageType: string; channelID?: string };
      if (msg.messageType === "hello") {
        ws.data.uaid ??= crypto.randomUUID().replace(/-/g, "");
        ws.send(
          JSON.stringify({
            messageType: "hello",
            uaid: ws.data.uaid,
            status: 200,
            use_webpush: true,
          }),
        );
        for (const [id, s] of channels) if (s.data.uaid === ws.data.uaid) channels.set(id, ws);
      } else if (msg.messageType === "register" && msg.channelID) {
        channels.set(msg.channelID, ws);
        ws.send(
          JSON.stringify({
            messageType: "register",
            channelID: msg.channelID,
            status: 200,
            pushEndpoint: `http://localhost:${PUSH_PORT}/wpush/${msg.channelID}`,
          }),
        );
        log({ event: "subscribed", channel: msg.channelID });
      } else if (msg.messageType === "unregister" && msg.channelID) {
        channels.delete(msg.channelID);
        ws.send(
          JSON.stringify({ messageType: "unregister", channelID: msg.channelID, status: 200 }),
        );
      } else if (msg.messageType === "ack") {
        log({ event: "ack", updates: (msg as { updates?: unknown }).updates });
      } else if (msg.messageType === "ping") {
        ws.send("{}");
      }
    },
  },
});

log({ event: "ready", github: GITHUB_PORT, push: PUSH_PORT });
