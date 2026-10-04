/**
 * The real server on a random port, for testing clients (the CLI, the mod) end to end: SQLite in
 * memory, push and GitHub off, and an owner whose phone is the account's first device. The phone
 * calls the app in-process, so only the client under test shows in `log` and meets `failures`.
 */
import {
  type Answer,
  addEntry,
  type Directory,
  open,
  openPairingRequest,
  pairingApproval,
  parsePairingCode,
  type SealedItem,
  seal,
} from "@starbridge/protocol";
import type { Server as BunServer } from "bun";
import { nextSeq } from "../src/db";
import type { Stored } from "../src/routes/items";
import { type Account, append, directory, makeServer, type Server, setupAccount } from "./app";

export class LiveServer {
  /** HTTP requests received, as "METHOD /path" without the `/v1` prefix. */
  readonly log: string[] = [];
  /**
   * The next HTTP requests to these paths fail with 503, once each: the real server has no
   * outage on demand.
   */
  readonly failures: string[] = [];

  private constructor(
    private readonly s: Server,
    readonly owner: Account,
    private readonly http: ReturnType<typeof Bun.serve>,
  ) {}

  static async start(): Promise<LiveServer> {
    const s = await makeServer();
    const owner = await setupAccount(s, "phone");
    let live: LiveServer | undefined;
    const http = Bun.serve({
      port: 0,
      fetch: (req, server) => (live as LiveServer).handle(req, server),
    });
    live = new LiveServer(s, owner, http);
    return live;
  }

  get url() {
    return `http://localhost:${this.http.port}`;
  }

  stop() {
    this.http.stop(true);
  }

  private handle(req: Request, server: BunServer<undefined>) {
    const path = new URL(req.url).pathname.replace(/^\/v1/, "");
    this.log.push(`${req.method} ${path}`);
    const fail = this.failures.indexOf(path);
    if (fail >= 0) {
      this.failures.splice(fail, 1);
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    return this.s.app.fetch(req, { server });
  }

  /** A call from the owner's phone; throws unless the status is 2xx. */
  private async phone(method: string, path: string, body?: unknown) {
    const r = await this.s.call(method, `/v1${path}`, { token: this.owner.device.token, body });
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }

  directory(): Promise<Directory> {
    return directory(this.s, this.owner.device.token);
  }

  /** What the owner does after typing the code on the phone. */
  async approve(codeText: string) {
    const code = parsePairingCode(codeText);
    const { request } = await this.phone("GET", `/pairings/${code.rendezvous}`);
    const req = openPairingRequest(request, code);
    const signer = { id: "phone", signKey: this.owner.device.keys.sign.privateKey };
    const member = {
      id: req.id,
      role: req.role,
      name: req.name,
      boxPk: req.boxPk,
      signPk: req.signPk,
    };
    const r = await append(this.s, this.owner.device.token, addEntry(await this.directory(), signer, member, `${new Date().toISOString().slice(0, 19)}Z`));
    if (r.status !== 201) throw new Error(`add entry: ${r.status} ${JSON.stringify(r.json)}`);
    const approval = pairingApproval(
      {
        v: 1,
        rendezvous: code.rendezvous,
        account: this.owner.id,
        length: r.json.length,
        head: r.json.head,
        approver: "phone",
      },
      code,
    );
    await this.phone("POST", `/pairings/${code.rendezvous}/approve`, { approval });
  }

  /** Items of `kind` as the phone lists them, opened and verified. */
  async opened<K extends "decision" | "quota">(kind: K) {
    const { items } = (await this.phone("GET", `/items?kind=${kind}`)) as { items: Stored[] };
    const dir = await this.directory();
    const me = { id: "phone", box: this.owner.device.keys.box };
    return items.map((s) => open(s.item as SealedItem & { kind: K }, me, dir).body);
  }

  private async sealAnswer(
    decisionId: string,
    reply: { choice?: string; text?: string },
    tamper?: Partial<Answer>,
  ): Promise<SealedItem> {
    const { item } = (await this.phone("GET", `/items/${decisionId}`)) as Stored;
    const machine = (await this.directory()).members.get(item.from);
    if (!machine) throw new Error(`no member ${item.from}`);
    const body = {
      v: 1 as const,
      id: `a_${crypto.randomUUID()}`,
      decisionId,
      to: machine.member.id,
      answeredAt: `${new Date().toISOString().slice(0, 19)}Z`,
      ...reply,
      ...tamper,
    } as Answer;
    return seal("answer", body, { id: "phone", signKey: this.owner.device.keys.sign.privateKey }, [
      machine.member,
    ]);
  }

  /** The phone answers a decision through `POST /items`. */
  async answer(decisionId: string, reply: { choice?: string; text?: string }) {
    await this.phone("POST", "/items", await this.sealAnswer(decisionId, reply));
  }

  /**
   * Stores answers the way a compromised server would: past the checks `POST /items` makes
   * (one answer per decision, `re` naming a decision), and without marking the decision
   * answered. `tamper` changes the signed body.
   */
  async forge(
    ...answers: { decisionId: string; reply: { choice?: string; text?: string }; tamper?: Partial<Answer> }[]
  ) {
    const items = await Promise.all(
      answers.map((a) => this.sealAnswer(a.decisionId, a.reply, a.tamper)),
    );
    const { db, answers: waiters } = this.s.deps;
    const account = this.owner.id;
    db.transaction(() => {
      for (const item of items) {
        db.query(
          "INSERT INTO items (seq, account_id, id, kind, from_id, re, received_at) VALUES (?, ?, ?, 'answer', ?, ?, ?)",
        ).run(nextSeq(db), account, item.id, item.from, item.re ?? null, new Date().toISOString());
        for (const b of item.boxes)
          db.query("INSERT INTO boxes (account_id, item_id, to_id, box) VALUES (?, ?, ?, ?)").run(
            account,
            item.id,
            b.to,
            b.box,
          );
      }
    })();
    for (const to of new Set(items.flatMap((i) => i.boxes.map((b) => b.to))))
      waiters.wake(`${account}/${to}`);
  }
}
