/**
 * A local TCP relay that can play a network outage: `block()` drops every open connection and
 * refuses new ones until `unblock()`. As an HTTP CONNECT proxy (`HTTPS_PROXY`) it relays to any
 * host; with `target` it forwards every connection there, for a server on plain HTTP.
 */
import type { Socket, TCPSocketListener } from "bun";

interface Pair {
  up?: Socket<Pair>;
  down: Socket<Pair>;
  pending: Uint8Array[];
}

export class Relay {
  private blocked = false;
  private readonly open = new Set<Pair>();
  private listener: TCPSocketListener<Pair> | undefined;
  /** Connections refused while blocked. */
  refused = 0;

  constructor(private readonly target?: { host: string; port: number }) {}

  get port(): number {
    return this.listener?.port ?? 0;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): this {
    this.listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (down) => {
          if (this.blocked) {
            this.refused++;
            down.end();
            return;
          }
          const pair: Pair = { down, pending: [] };
          down.data = pair;
          this.open.add(pair);
          if (this.target) this.connect(pair, this.target.host, this.target.port, undefined);
        },
        data: (down, chunk) => {
          const pair = down.data;
          if (!pair) return;
          if (pair.up) {
            pair.up.write(chunk);
            return;
          }
          if (this.target) {
            pair.pending.push(chunk);
            return;
          }
          // CONNECT host:port HTTP/1.1, then headers; the tunnel starts after the blank line.
          const head = new TextDecoder().decode(chunk);
          const m = /^CONNECT ([^:\s]+):(\d+) /.exec(head);
          if (!m) {
            down.end("HTTP/1.1 400 Bad Request\r\n\r\n");
            return;
          }
          this.connect(
            pair,
            m[1] as string,
            Number(m[2]),
            "HTTP/1.1 200 Connection Established\r\n\r\n",
          );
        },
        close: (down) => this.drop(down.data),
        error: (down) => this.drop(down.data),
      },
    });
    return this;
  }

  private connect(pair: Pair, host: string, port: number, hello: string | undefined) {
    Bun.connect<Pair>({
      hostname: host,
      port,
      data: pair,
      socket: {
        open: (up) => {
          pair.up = up;
          if (hello) pair.down.write(hello);
          for (const c of pair.pending.splice(0)) up.write(c);
        },
        data: (_up, chunk) => {
          pair.down.write(chunk);
        },
        close: () => this.drop(pair),
        error: () => this.drop(pair),
      },
    }).catch(() => this.drop(pair));
  }

  private drop(pair: Pair | undefined) {
    if (!pair || !this.open.delete(pair)) return;
    pair.up?.end();
    pair.down.end();
  }

  /** Cuts every open connection, as a dropped link does, and refuses new ones. */
  block() {
    this.blocked = true;
    for (const p of [...this.open]) this.drop(p);
  }

  unblock() {
    this.blocked = false;
  }

  stop() {
    this.block();
    this.listener?.stop(true);
  }
}
