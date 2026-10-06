// The async variants, for clients whose private keys live outside libsodium (the web page's
// non-extractable WebCrypto keys), must match the sync ones byte for byte and reject the same
// vectors with the same codes.
import { describe, expect, test } from "bun:test";
import {
  addEntry,
  addEntryAsync,
  fromB64,
  genesisEntry,
  genesisEntryAsync,
  type Member,
  open,
  openAsync,
  ProtocolError,
  ready,
  recoveryKeyPair,
  revokeEntry,
  revokeEntryAsync,
  type SealedItem,
  type SignFn,
  seal,
  sealAsync,
  verifyDirectory,
} from "../src/index";
import { sodium } from "../src/sodium";

const load = async (name: string) =>
  JSON.parse(await Bun.file(new URL(`../vectors/${name}`, import.meta.url)).text());

// The describe bodies below call libsodium while the tests are collected.
await ready;

const V = {
  directory: await load("directory.json"),
  envelopes: await load("envelopes.json"),
  keys: await load("keys.json"),
};

type VectorMember = Member & { boxSk: string; signSk: string };
const member = (id: string): VectorMember => V.keys.members.find((m: VectorMember) => m.id === id);
const pub = ({ id, role, name, boxPk, signPk }: VectorMember): Member => ({
  id,
  role,
  name,
  boxPk,
  signPk,
});
const signFn =
  (m: VectorMember): SignFn =>
  async (message) =>
    sodium.crypto_sign_detached(message, fromB64(m.signSk));
const openSealFn = (m: VectorMember) => async (box: Uint8Array) =>
  sodium.crypto_box_seal_open(box, fromB64(m.boxPk), fromB64(m.boxSk));

const at = "2026-10-04T12:00:00Z";

describe("signing", () => {
  const phone = member("phone");
  const browser = member("browser");
  const recovery = recoveryKeyPair(new Uint8Array(16).fill(7));
  const genesis = genesisEntry({
    account: "acct",
    device: pub(phone),
    signKey: fromB64(phone.signSk),
    recovery,
    at,
  });
  const dir = verifyDirectory([genesis]);

  test("genesisEntryAsync equals genesisEntry", async () => {
    const env = await genesisEntryAsync({
      account: "acct",
      device: pub(phone),
      sign: signFn(phone),
      recovery,
      at,
    });
    expect(env).toEqual(genesis);
  });

  test("addEntryAsync and revokeEntryAsync equal the sync writers", async () => {
    const signer = { id: "phone", signKey: fromB64(phone.signSk) };
    const asyncSigner = { id: "phone", sign: signFn(phone) };
    expect(await addEntryAsync(dir, asyncSigner, pub(browser), at)).toEqual(
      addEntry(dir, signer, pub(browser), at),
    );
    expect(await revokeEntryAsync(dir, asyncSigner, "browser", at)).toEqual(
      revokeEntry(dir, signer, "browser", at),
    );
  });

  test("sealAsync seals what open accepts, signed as seal signs", async () => {
    const machine = member("devbox");
    const body = {
      v: 1 as const,
      id: "a1",
      decisionId: "d1",
      to: "devbox",
      answeredAt: at,
      choice: "Merge",
    };
    const chain = [
      genesis,
      addEntry(dir, { id: "phone", signKey: fromB64(phone.signSk) }, pub(machine), at),
    ];
    const withMachine = verifyDirectory(chain);
    const item = await sealAsync("answer", body, { id: "phone", sign: signFn(phone) }, [machine]);
    const opened = open(
      item,
      {
        id: "devbox",
        box: { publicKey: fromB64(machine.boxPk), privateKey: fromB64(machine.boxSk) },
      },
      withMachine,
    );
    expect(opened.body).toEqual(body);
    const sync = seal("answer", body, { id: "phone", signKey: fromB64(phone.signSk) }, [machine]);
    // The boxes differ (fresh ephemeral keys); the routing hints do not.
    expect({ ...item, boxes: [] }).toEqual({ ...sync, boxes: [] });
  });

  test("sealAsync seals the body and recipients as they were when it was called", async () => {
    const machine = member("devbox");
    const body = {
      v: 1 as const,
      id: "a1",
      decisionId: "d1",
      to: "devbox",
      answeredAt: at,
      choice: "Merge",
    };
    const recipients = [{ id: machine.id, boxPk: machine.boxPk }];
    const sign: SignFn = async (message) => {
      body.id = "a2";
      recipients[0] = { id: "evil", boxPk: member("evil").boxPk };
      return signFn(phone)(message);
    };
    const item = await sealAsync("answer", body, { id: "phone", sign }, recipients);
    expect(item.id).toBe("a1");
    expect(item.boxes.map((b) => b.to)).toEqual(["devbox"]);
  });

  test("sealAsync refuses recipients the body does not name", async () => {
    const body = {
      v: 1 as const,
      id: "a1",
      decisionId: "d1",
      to: "devbox",
      answeredAt: at,
      choice: "Merge",
    };
    await expect(
      sealAsync("answer", body, { id: "phone", sign: signFn(phone) }, [member("browser")]),
    ).rejects.toThrow("body.to must list exactly the recipients");
  });
});

test("openAsync checks the item as it was when it was called", async () => {
  const c = V.envelopes.sealed.find((x: { name: string }) => x.name === "decision for phone");
  const m = member("phone");
  const item = structuredClone(c.item) as SealedItem;
  const openSeal = async (box: Uint8Array) => {
    item.kind = "quota";
    return openSealFn(m)(box);
  };
  const opened = await openAsync(
    item as SealedItem & { kind: "decision" },
    { id: m.id, openSeal },
    verifyDirectory(V.directory.cases[0].entries),
  );
  expect(opened.body).toEqual(c.expect.body);
});

describe("openAsync on envelopes.json", () => {
  const directory = () => verifyDirectory(V.directory.cases[0].entries);
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "ok";
    } catch (e) {
      if (e instanceof ProtocolError) return e.code;
      throw e;
    }
  };

  for (const c of V.envelopes.sealed) {
    test(c.name, async () => {
      const m = member(c.recipient);
      const run = () =>
        openAsync(c.item as SealedItem, { id: m.id, openSeal: openSealFn(m) }, directory());
      const sync = () =>
        open(
          c.item as SealedItem,
          { id: m.id, box: { publicKey: fromB64(m.boxPk), privateKey: fromB64(m.boxSk) } },
          directory(),
        );
      if (c.expect.error) {
        expect(await code(run)).toBe(c.expect.error);
        return;
      }
      expect(await run()).toEqual(sync());
    });
  }
});
