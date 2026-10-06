// Runs every case in ../vectors against the code. The Kotlin tests run the same files.
import { beforeAll, describe, expect, test } from "bun:test";
import { buildVectors, render } from "../scripts/gen-vectors";
import {
  alertsFor,
  approverKeys,
  BODY_SCHEMAS,
  bindMessage,
  claimHash,
  codeFromLink,
  computePace,
  formatPairingCode,
  fromB64,
  joinCommitment,
  joinerKeys,
  joinRequest,
  open,
  openJoinApproval,
  openPairingApproval,
  openPairingRequest,
  ProtocolError,
  pairingKey,
  parsePairingCode,
  ready,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  type SealedItem,
  toB64,
  verify,
  verifyBind,
  verifyDirectory,
} from "../src/index";

const load = async (name: string) =>
  JSON.parse(await Bun.file(new URL(`../vectors/${name}`, import.meta.url)).text());

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
  return "ok";
};

beforeAll(() => ready);

const V = {
  directory: await load("directory.json"),
  envelopes: await load("envelopes.json"),
  keys: await load("keys.json"),
  pairing: await load("pairing.json"),
  join: await load("join.json"),
  pace: await load("pace.json"),
  schemas: await load("schemas.json"),
};

describe("directory.json", () => {
  const { cases } = V.directory;
  for (const c of cases) {
    test(c.name, () => {
      if (c.expect.error) {
        expect(errorCode(() => verifyDirectory(c.entries, c.options))).toBe(c.expect.error);
        return;
      }
      const dir = verifyDirectory(c.entries, c.options);
      expect(dir.length).toBe(c.expect.length);
      expect(dir.head).toBe(c.expect.head);
      const ids = (active: boolean) =>
        [...dir.members.values()].filter((m) => m.active === active).map((m) => m.member.id);
      expect(ids(true)).toEqual(c.expect.active);
      expect(ids(false)).toEqual(c.expect.revoked);
      expect(dir.recoveryPk).toBe(c.expect.recoveryPk);
    });
  }
});

describe("envelopes.json", () => {
  const { signatures, sealed } = V.envelopes;
  const { members } = V.keys;
  const directory = () => verifyDirectory(V.directory.cases[0].entries);
  const me = (id: string) => {
    const m = members.find((x: { id: string }) => x.id === id);
    return { id, box: { publicKey: fromB64(m.boxPk), privateKey: fromB64(m.boxSk) } };
  };

  for (const c of signatures) {
    test(`signature: ${c.name}`, () => {
      expect(errorCode(() => verify(c.envelope, c.signPk))).toBe(c.expect);
    });
  }
  for (const c of sealed) {
    test(`sealed: ${c.name}`, () => {
      const run = () => open(c.item as SealedItem, me(c.recipient), directory());
      if (c.expect.error) {
        expect(errorCode(run)).toBe(c.expect.error);
        return;
      }
      const opened = run();
      expect(opened.signer.id).toBe(c.expect.signer);
      expect(opened.body).toEqual(c.expect.body);
    });
  }
});

describe("pairing.json", () => {
  const v = V.pairing;

  test("code and key", () => {
    const code = parsePairingCode(v.code);
    expect(code).toEqual({ rendezvous: v.rendezvous, secret: v.secret });
    expect(toB64(pairingKey(code))).toBe(v.key);
    expect(claimHash(v.claim.secret)).toBe(v.claim.hash);
  });
  for (const c of v.parse) {
    test(`parse ${c.input}`, () => {
      let got: string;
      try {
        got = formatPairingCode(parsePairingCode(c.input));
      } catch (e) {
        got = (e as ProtocolError).code;
      }
      expect(got).toBe(c.expect);
    });
  }
  test("request and approval open with the code", () => {
    const code = parsePairingCode(v.code);
    expect(openPairingRequest(v.request.message, code)).toEqual(v.request.body);
    expect(openPairingApproval(v.approval.message, code)).toEqual(v.approval.body);
  });
  for (const c of v.bad) {
    test(c.name, () => {
      const fn = c.kind === "request" ? openPairingRequest : openPairingApproval;
      expect(errorCode(() => fn(c.message, parsePairingCode(c.code)))).toBe(c.expect);
    });
  }
});

describe("pairing.json: links", () => {
  const [made, ...rest] = V.pairing.links;
  test("pairingLink", () => {
    expect(made.link).toBe(`https://starbridge.run/pair#${V.pairing.code}`);
    expect(formatPairingCode(codeFromLink(made.link))).toBe(made.expect);
  });
  for (const c of rest) {
    test(`codeFromLink ${c.input}`, () => {
      let got: string;
      try {
        got = formatPairingCode(codeFromLink(c.input));
      } catch (e) {
        got = (e as ProtocolError).code;
      }
      expect(got).toBe(c.expect);
    });
  }
});

describe("join.json", () => {
  const v = V.join;
  const pair = (k: { publicKey: string; privateKey: string }) => ({
    publicKey: fromB64(k.publicKey),
    privateKey: fromB64(k.privateKey),
    keyType: "x25519" as const,
  });
  test("request, commitment, digits and approval", () => {
    expect(joinRequest(v.request.body)).toBe(v.request.text);
    expect(joinCommitment(fromB64(v.joiner.publicKey), v.request.text)).toBe(v.commitment);
    const a = approverKeys({
      mine: pair(v.approver),
      joinerKey: v.joiner.publicKey,
      request: v.request.text,
      commitment: v.commitment,
    });
    const j = joinerKeys({
      mine: pair(v.joiner),
      approverKey: v.approver.publicKey,
      request: v.request.text,
    });
    expect(a.digits).toBe(v.digits);
    expect(j.digits).toBe(v.digits);
    expect(toB64(a.mac)).toBe(v.mac);
    expect(toB64(j.mac)).toBe(v.mac);
    expect(openJoinApproval(v.approval.message, j, v.request.body.join)).toEqual(v.approval.body);
  });
  for (const c of v.bad) {
    test(c.name, () => {
      const run = () => {
        if (c.side === "approver")
          approverKeys({
            mine: pair(v.approver),
            joinerKey: c.joinerKey,
            request: c.request,
            commitment: c.commitment,
          });
        else if (c.side === "joiner")
          joinerKeys({ mine: pair(v.joiner), approverKey: c.approverKey, request: c.request });
        else {
          const keys = joinerKeys({
            mine: pair(v.joiner),
            approverKey: v.approver.publicKey,
            request: v.request.text,
          });
          openJoinApproval(c.message, keys, v.request.body.join);
        }
      };
      expect(errorCode(run)).toBe(c.expect);
    });
  }
});

test("pairing.json: bind", () => {
  const b = V.pairing.bind;
  expect(toB64(bindMessage(b.account, b.member, b.nonce))).toBe(b.message);
  expect(verifyBind(b, b.signPk)).toBe(true);
  expect(verifyBind({ ...b, member: "browser" }, b.signPk)).toBe(false);
  expect(verifyBind({ ...b, nonce: `${b.nonce}x` }, b.signPk)).toBe(false);
  expect(verifyBind({ ...b, sig: "AAAA" }, b.signPk)).toBe(false);
});

describe("pace.json", () => {
  const { cases } = V.pace;
  for (const c of cases) {
    test(c.name, () => {
      const now = new Date(c.now);
      const pace = computePace(c.window, now);
      expect(pace).toEqual(c.expectPace);
      expect(alertsFor(c.provider, { ...c.window, pace }, now)).toEqual(c.expectAlerts);
    });
  }
});

describe("schemas.json", () => {
  const v = V.schemas;
  const kinds = [
    "decision",
    "answer",
    "permission",
    "permission-answer",
    "settled",
    "run",
  ] as const;
  for (const kind of kinds) {
    const schema = BODY_SCHEMAS[kind];
    for (const c of v[kind]) {
      test(`${kind}: ${c.name}`, () => {
        expect(schema.safeParse(c.body).success).toBe(c.valid);
      });
    }
  }
});

test("the recovery key reads back to its seed and signing key", () => {
  const { recovery } = V.keys;
  expect(recoveryKey(fromB64(recovery.seed))).toBe(recovery.key);
  expect(toB64(recoverySeedFromKey(recovery.key))).toBe(recovery.seed);
  expect(toB64(recoveryKeyPair(fromB64(recovery.seed)).publicKey)).toBe(recovery.signPk);
});

test("the generator reproduces the committed vectors, sealed boxes aside", async () => {
  const anyBox = (text: string) => text.replace(/"box": "[A-Za-z0-9_-]+"/g, '"box": "*"');
  for (const [name, value] of Object.entries(await buildVectors())) {
    const committed = await Bun.file(new URL(`../vectors/${name}`, import.meta.url)).text();
    expect(anyBox(render(value))).toBe(anyBox(committed));
  }
});
