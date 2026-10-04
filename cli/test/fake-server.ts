/**
 * A server that follows PROTOCOL.md for the routes a machine calls, plus an owner with a phone
 * in the directory who approves pairings and answers decisions. Built on the protocol package,
 * so the CLI is tested against real keys, signatures and sealed boxes.
 */
import { randomBytes } from "node:crypto";
import {
  type Answer,
  addEntry,
  claimHash,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type Member,
  type MemberKeys,
  open,
  openPairingRequest,
  pairingApproval,
  parsePairingCode,
  publicKeys,
  ready,
  recoveryKeyPair,
  type SealedItem,
  type SignedEnvelope,
  seal,
  verifyDirectory,
} from "@starbridge/protocol";

await ready;

const ACCOUNT = "acct_test";
const now = () => `${new Date().toISOString().slice(0, 19)}Z`;

interface Pairing {
  request: unknown;
  claimHash: string;
  result?: { approval: unknown; token: string };
}

export class FakeServer {
  readonly phoneKeys: MemberKeys = generateMemberKeys();
  readonly phone: Member = {
    id: "phone",
    role: "device",
    name: "Pixel",
    ...publicKeys(this.phoneKeys),
  };
  readonly chain: SignedEnvelope[];
  readonly pairings = new Map<string, Pairing>();
  readonly tokens = new Map<string, string>();
  readonly items: SealedItem[] = [];
  /** Requests seen, as "METHOD /path". */
  readonly log: string[] = [];
  /** The next requests to these paths fail with 503, once each. */
  readonly failures: string[] = [];
  private wakers: (() => void)[] = [];
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.chain = [
      genesisEntry({
        account: ACCOUNT,
        device: this.phone,
        signKey: this.phoneKeys.sign.privateKey,
        recovery: recoveryKeyPair(generateRecoverySeed()),
        at: now(),
      }),
    ];
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
  }

  get url() {
    return `http://localhost:${this.server.port}`;
  }

  stop() {
    this.server.stop(true);
  }

  directory() {
    return verifyDirectory(this.chain);
  }

  /** What the owner does after typing the code on the phone. */
  approve(codeText: string) {
    const code = parsePairingCode(codeText);
    const p = this.pairings.get(code.rendezvous);
    if (!p) throw new Error("no such pairing");
    const req = openPairingRequest(p.request, code);
    const member: Member = {
      id: req.id,
      role: req.role,
      name: req.name,
      boxPk: req.boxPk,
      signPk: req.signPk,
    };
    this.chain.push(
      addEntry(
        this.directory(),
        { id: "phone", signKey: this.phoneKeys.sign.privateKey },
        member,
        now(),
      ),
    );
    const dir = this.directory();
    const approval = pairingApproval(
      {
        v: 1,
        rendezvous: code.rendezvous,
        account: dir.account,
        length: dir.length,
        head: dir.head,
        approver: "phone",
      },
      code,
    );
    const token = randomBytes(16).toString("base64url");
    this.tokens.set(token, member.id);
    p.result = { approval, token };
    this.wake();
  }

  /** Items of `kind` opened and verified as the phone. */
  opened<K extends "decision" | "quota">(kind: K) {
    const dir = this.directory();
    return this.items
      .filter((i): i is SealedItem & { kind: K } => i.kind === kind)
      .map((i) => open(i, { id: "phone", box: this.phoneKeys.box }, dir).body);
  }

  /** The phone answers a decision; `tamper` changes the signed body to test the machine's checks. */
  answer(decisionId: string, reply: { choice?: string; text?: string }, tamper?: Partial<Answer>) {
    const decision = this.opened("decision").find((d) => d.id === decisionId);
    if (!decision) throw new Error("no such decision");
    const machine = this.directory().members.get(
      this.items.find((i) => i.id === decisionId)?.from ?? "",
    );
    if (!machine) throw new Error("no machine");
    const body = {
      v: 1 as const,
      id: `a_${randomBytes(9).toString("base64url")}`,
      decisionId,
      to: machine.member.id,
      answeredAt: now(),
      ...reply,
      ...tamper,
    } as Answer;
    this.items.push(
      seal("answer", body, { id: "phone", signKey: this.phoneKeys.sign.privateKey }, [
        machine.member,
      ]),
    );
    this.wake();
  }

  private wake() {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }

  private until(pred: () => boolean, seconds: number): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      const check = () => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else this.wakers.push(check);
      };
      this.wakers.push(check);
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1/, "");
    this.log.push(`${req.method} ${path}`);
    const fail = this.failures.indexOf(path);
    if (fail >= 0) {
      this.failures.splice(fail, 1);
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    const caller = this.tokens.get(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");

    if (req.method === "POST" && path === "/pairings") {
      const body = (await req.json()) as { request: { body: string }; claimHash: string };
      const rendezvous = (JSON.parse(body.request.body) as { rendezvous: string }).rendezvous;
      if (this.pairings.has(rendezvous)) return Response.json({ error: "taken" }, { status: 409 });
      this.pairings.set(rendezvous, { request: body.request, claimHash: body.claimHash });
      return Response.json({}, { status: 201 });
    }
    const result = /^\/pairings\/([^/]+)\/result$/.exec(path);
    if (req.method === "GET" && result) {
      const p = this.pairings.get(result[1] as string);
      if (!p || claimHash(req.headers.get("x-claim") ?? "") !== p.claimHash)
        return Response.json({ error: "not-found" }, { status: 404 });
      await this.until(() => p.result !== undefined, Number(url.searchParams.get("wait") ?? 0));
      return p.result ? Response.json(p.result) : new Response(null, { status: 204 });
    }

    if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });

    if (req.method === "GET" && path === "/directory") {
      const from = Number(url.searchParams.get("from") ?? 0);
      return Response.json({ entries: this.chain.slice(from) });
    }
    if (req.method === "POST" && path === "/items") {
      const item = (await req.json()) as SealedItem;
      if (item.from !== caller) return Response.json({ error: "forbidden" }, { status: 403 });
      if (this.items.some((i) => i.id === item.id))
        return Response.json({ error: "conflict" }, { status: 409 });
      this.items.push(item);
      return Response.json({}, { status: 201 });
    }
    if (req.method === "GET" && path === "/answers") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const wait = Math.min(300, Number(url.searchParams.get("wait") ?? 0));
      const mine = () =>
        this.items
          .map((item, i) => ({ item, i }))
          .filter(
            ({ item, i }) =>
              i >= after && item.kind === "answer" && item.boxes.some((b) => b.to === caller),
          );
      await this.until(() => mine().length > 0, wait);
      return Response.json({
        items: mine().map(({ item }) => ({
          ...item,
          boxes: item.boxes.filter((b) => b.to === caller),
        })),
        cursor: String(this.items.length),
      });
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  }
}
