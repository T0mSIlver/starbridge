// Runs every case in ../vectors against the code. The Kotlin tests run the same files.
import { beforeAll, describe, expect, test } from "bun:test";
import { buildVectors, render } from "../scripts/gen-vectors";
import {
  alertsFor,
  BODY_SCHEMAS,
  bindMessage,
  claimHash,
  computePace,
  formatPairingCode,
  fromB64,
  open,
  openPairingApproval,
  openPairingRequest,
  ProtocolError,
  pairingKey,
  parsePairingCode,
  ready,
  recoverySeedFromWords,
  recoveryWords,
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
  const kinds = ["decision", "answer", "permission", "permission-answer", "settled"] as const;
  for (const kind of kinds) {
    const schema = BODY_SCHEMAS[kind];
    for (const c of v[kind]) {
      test(`${kind}: ${c.name}`, () => {
        expect(schema.safeParse(c.body).success).toBe(c.valid);
      });
    }
  }
});

test("recovery words round-trip", () => {
  const { recovery } = V.keys;
  expect(toB64(recoverySeedFromWords(recovery.words))).toBe(recovery.seed);
  expect(recoveryWords(fromB64(recovery.seed))).toBe(recovery.words);
});

test("the generator reproduces the committed vectors, sealed boxes aside", async () => {
  const anyBox = (text: string) => text.replace(/"box": "[A-Za-z0-9_-]+"/g, '"box": "*"');
  for (const [name, value] of Object.entries(await buildVectors())) {
    const committed = await Bun.file(new URL(`../vectors/${name}`, import.meta.url)).text();
    expect(anyBox(render(value))).toBe(anyBox(committed));
  }
});
