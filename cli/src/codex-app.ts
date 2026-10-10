/**
 * A client of the Codex app-server daemon (#951), which runs the TUI's sessions: JSON-RPC in
 * WebSocket text frames over its control socket, `$CODEX_HOME/app-server-control/
 * app-server-control.sock`. The daemon sends a thread's server requests, such as
 * `item/tool/requestUserInput`, to every connection subscribed to that thread, replays the
 * pending ones to a connection that subscribes later, and takes the first answer.
 */
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

/** A notification (no `id`) or a server request (`id` and `method`) from the daemon. */
export interface CodexMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

const CONNECT_MS = 5_000;
/** The daemon advertises 16 MB; nothing Starbridge reads comes near it. */
const MAX_FRAME = 16 << 20;

export function codexControlSocket(home: string): string {
  return join(home, "app-server-control", "app-server-control.sock");
}

/** One client frame: text, final, masked as RFC 6455 requires of clients. */
function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x80 | op, 0x80 | n])
      : n < 65536
        ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255])
        : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), bigLength(n)]);
  const mask = randomBytes(4);
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  return Buffer.concat([head, mask, body]);
}

function bigLength(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

export class CodexApp {
  private nextId = 1;
  private readonly calls = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buf = Buffer.alloc(0);
  private text: Buffer[] = [];
  private closed = false;
  /** Resolves once the socket closed, for whatever reason. */
  readonly done: Promise<void>;
  private onClose = () => {};

  private constructor(
    private readonly socket: Socket,
    private readonly onMessage: (m: CodexMessage) => void,
  ) {
    this.done = new Promise((resolve) => {
      this.onClose = resolve;
    });
  }

  /**
   * Connects to the daemon of `home` and initializes, opting into the experimental API, which
   * `requestUserInput` belongs to. Rejects when no daemon listens.
   */
  static async connect(
    home: string,
    onMessage: (m: CodexMessage) => void,
    signal?: AbortSignal,
  ): Promise<CodexApp> {
    const socket = createConnection(codexControlSocket(home));
    const app = new CodexApp(socket, onMessage);
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new Error("the Codex daemon did not answer")),
        CONNECT_MS,
      );
      signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
      socket.once("error", fail);
      socket.once("connect", () =>
        socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      let head = Buffer.alloc(0);
      const onHead = (d: Buffer) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onHead);
        socket.off("error", fail);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101 /.test(head.toString("latin1")))
          return fail(new Error("the Codex daemon refused the connection"));
        socket.on("data", (more: Buffer) => app.read(more));
        socket.on("error", () => app.close());
        socket.on("close", () => app.close());
        app.read(head.subarray(end + 4));
        resolve();
      };
      socket.on("data", onHead);
    });
    // A daemon that took the connection but never answers would hold a detached race forever.
    const silent = setTimeout(() => app.close(), CONNECT_MS);
    try {
      await app.request("initialize", {
        clientInfo: { name: "starbridge", version: "1" },
        capabilities: { experimentalApi: true },
      });
    } finally {
      clearTimeout(silent);
    }
    app.send({ method: "initialized" });
    return app;
  }

  private send(m: object) {
    if (!this.closed) this.socket.write(frame(1, Buffer.from(JSON.stringify(m))));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("the Codex daemon closed the connection"));
      this.calls.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /** Answers the daemon's request `id`. */
  respond(id: number | string, result: unknown) {
    this.send({ id, result });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.calls.values())
      c.reject(new Error("the Codex daemon closed the connection"));
    this.calls.clear();
    this.socket.destroy();
    this.onClose();
  }

  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0] as number;
      let len = (this.buf[1] as number) & 127;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_FRAME) return this.close();
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 15;
      if (op === 8) return this.close();
      if (op === 9) {
        if (!this.closed) this.socket.write(frame(10, payload));
        continue;
      }
      if (op !== 0 && op !== 1) continue;
      this.text.push(Buffer.from(payload));
      if (!(b0 & 0x80)) continue;
      const text = Buffer.concat(this.text).toString("utf8");
      this.text = [];
      let m: CodexMessage;
      try {
        m = JSON.parse(text) as CodexMessage;
      } catch {
        continue;
      }
      const call = typeof m.id === "number" && !m.method ? this.calls.get(m.id) : undefined;
      if (call) {
        this.calls.delete(m.id as number);
        if (m.error) call.reject(new Error(m.error.message ?? "Codex refused the request"));
        else call.resolve(m.result);
      } else if (m.method) this.onMessage(m);
    }
  }
}
