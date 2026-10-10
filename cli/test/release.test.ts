import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { compareVersions, platformAsset, RELEASE_KEY, verifyMinisign } from "../src/release";
import { piSource } from "../src/setup/harnesses";
import { update } from "../src/update";
import { VERSION } from "../src/version";
import { bareEnv, compiledFake, FAKE_BIN, SYSTEM_PATH, testCtx } from "./helpers";

const WINDOWS = process.platform === "win32";

const CLI = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "minisign");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const FIXTURE_KEY = fixture("test.pub").toString().split("\n")[1] as string;

/** A throwaway minisign key that signs the way `minisign -S` does (prehashed "ED"). */
function signer(id = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    pubkey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"),
    /** `change` alters the file's signature before the trusted comment's signs it. */
    sign(file: Uint8Array, comment = "starbridge test", change = (s: Buffer) => s) {
      const s = change(sign(null, createHash("blake2b512").update(file).digest(), privateKey));
      const global = sign(null, Buffer.concat([s, Buffer.from(comment)]), privateKey);
      const sig = Buffer.concat([Buffer.from("ED"), id, s]).toString("base64");
      return `untrusted comment: test\n${sig}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    },
  };
}

test("every copy of the release key is the same", () => {
  const pub = readFileSync(join(CLI, "minisign.pub"), "utf8").split("\n")[1];
  const script = /^PUBKEY=(\S+)$/m.exec(readFileSync(join(CLI, "install.sh"), "utf8"))?.[1];
  const ps = /^ {2}\$PubKey = '(\S+)'$/m.exec(readFileSync(join(CLI, "install.ps1"), "utf8"))?.[1];
  expect(pub).toBe(RELEASE_KEY);
  expect(script).toBe(RELEASE_KEY);
  expect(ps).toBe(RELEASE_KEY);
  expect(readFileSync(join(CLI, "README.md"), "utf8")).toContain(RELEASE_KEY);
});

describe("verifyMinisign", () => {
  test("accepts minisign's own signatures, prehashed and legacy", () => {
    expect(
      verifyMinisign(fixture("SHA256SUMS"), fixture("SHA256SUMS.minisig").toString(), FIXTURE_KEY),
    ).toBe("starbridge v1.2.3");
    expect(
      verifyMinisign(fixture("legacy"), fixture("legacy.minisig").toString(), FIXTURE_KEY),
    ).toBe("legacy");
  });

  test("refuses a changed file, another key and a changed trusted comment", () => {
    const sig = fixture("SHA256SUMS.minisig").toString();
    const file = fixture("SHA256SUMS");
    expect(() => verifyMinisign(Buffer.concat([file, Buffer.from("x")]), sig, FIXTURE_KEY)).toThrow(
      "does not match",
    );
    expect(() => verifyMinisign(file, sig, RELEASE_KEY)).toThrow("another key");
    const forged = sig.replace("starbridge v1.2.3", "starbridge v9.9.9");
    expect(() => verifyMinisign(file, forged, FIXTURE_KEY)).toThrow("trusted comment");
  });
});

test("compareVersions sorts release candidates before their release", () => {
  expect(compareVersions("1.2.3-rc.4", "1.2.3")).toBe(-1);
  expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
});

/** A releases page in GitHub's layout, serving one signed release of a fake binary. */
function fakeReleases(
  version: string,
  opts: {
    tamper?: "binary" | "sums";
    key?: ReturnType<typeof signer>;
    /** The version the signature names: an older release served under `version`'s tag. */
    signed?: string;
    asset?: string;
    /** Changes the signature file after signing. */
    minisig?: (sig: string) => string;
    /** Changes the file's signature before the trusted comment's signs it. */
    fileSig?: (s: Buffer) => Buffer;
  } = {},
) {
  const key = signer();
  const asset = opts.asset ?? platformAsset();
  // Windows starts only a real executable.
  const binary = WINDOWS
    ? readFileSync(compiledFake(`console.log("starbridge ${version}");`))
    : Buffer.from(`#!/bin/sh\necho "starbridge ${version}"\n`);
  const sums = `${createHash("sha256").update(binary).digest("hex")}  ${asset}\n`;
  const files: Record<string, string | Uint8Array<ArrayBuffer>> = {
    SHA256SUMS: opts.tamper === "sums" ? `${"0".repeat(64)}  ${asset}\n` : sums,
    "SHA256SUMS.minisig": (opts.minisig ?? ((sig) => sig))(
      (opts.key ?? key).sign(
        Buffer.from(sums),
        `starbridge v${opts.signed ?? version}`,
        opts.fileSig,
      ),
    ),
    [asset]: new Uint8Array(
      opts.tamper === "binary" ? Buffer.concat([binary, Buffer.from("# changed\n")]) : binary,
    ),
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/releases/latest")
        return new Response(null, {
          status: 302,
          headers: { location: `/releases/tag/v${version}` },
        });
      const m = /^\/releases\/(?:latest\/download|download\/v[^/]+)\/(.+)$/.exec(path);
      const body = m && files[m[1] as string];
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/releases`, pubkey: key.pubkey, server };
}

let release: ReturnType<typeof fakeReleases> | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "starbridge-release-"));
});
afterEach(() => release?.server.stop(true));

/**
 * Runs a copy of install.sh that trusts `pubkey` and checks with `verifier`: the PATH loses
 * minisign but for "minisign", and fails `broken` commands, as on RHEL 8 with OpenSSL 1.1.1.
 */
async function install(url: string, pubkey: string, verifier: string, version?: string) {
  const script = join(dir, "install.sh");
  writeFileSync(
    script,
    readFileSync(join(CLI, "install.sh"), "utf8").replace(/^PUBKEY=\S+$/m, `PUBKEY=${pubkey}`),
  );
  const broken = { python: ["openssl"], none: ["openssl", "python3"] }[verifier] ?? [];
  const fakes = join(dir, "fakes");
  mkdirSync(fakes, { recursive: true });
  for (const name of broken) {
    writeFileSync(join(fakes, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakes, name), 0o755);
  }
  const path = [fakes, ...(process.env.PATH ?? "").split(delimiter)]
    .filter((d) => verifier === "minisign" || !existsSync(join(d, "minisign")))
    .join(delimiter);
  // Async: the fake releases server answers from this same process.
  const p = Bun.spawn(["sh", script], {
    env: {
      PATH: path,
      HOME: dir,
      STARBRIDGE_RELEASES_URL: url,
      STARBRIDGE_INSTALL_DIR: join(dir, "bin"),
      STARBRIDGE_NO_SETUP: "1",
      ...(version ? { STARBRIDGE_VERSION: version } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err, bin: join(dir, "bin", "starbridge") };
}

const hasMinisign = spawnSync("minisign", ["-v"]).status === 0;
const hasPython = spawnSync("python3", ["-c", "import hashlib; hashlib.blake2b"]).status === 0;
const verifiers = [
  "openssl",
  ...(hasMinisign ? ["minisign"] : []),
  ...(hasPython ? ["python"] : []),
];

// install.sh refuses Windows, whose installer is install.ps1.
describe.skipIf(WINDOWS).each(verifiers)("install.sh checking with %s", (verifier) => {
  const run = (url: string, pubkey: string, version?: string) =>
    install(url, pubkey, verifier, version);

  test("installs the signed binary", async () => {
    release = fakeReleases("9.9.9");
    const r = await run(release.url, release.pubkey);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed starbridge 9.9.9 to ${r.bin}`);
    expect(spawnSync(r.bin, ["--version"], { encoding: "utf8" }).stdout).toBe("starbridge 9.9.9\n");
  });

  test("refuses a binary that does not match SHA256SUMS", async () => {
    release = fakeReleases("9.9.9", { tamper: "binary" });
    const r = await run(release.url, release.pubkey);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match its hash");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("refuses SHA256SUMS signed by another key, or changed after signing", async () => {
    release = fakeReleases("9.9.9", { key: signer() });
    let r = await run(release.url, release.pubkey);
    expect(r.err).toContain("does not carry the release signature");
    release.server.stop(true);
    release = fakeReleases("9.9.9", { tamper: "sums" });
    r = await run(release.url, release.pubkey);
    expect(r.err).toContain("does not carry the release signature");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("refuses an older signed release served as the version asked for", async () => {
    release = fakeReleases("9.9.9", { signed: "1.0.0" });
    const r = await run(release.url, release.pubkey, "9.9.9");
    expect(r.err).toContain('SHA256SUMS is signed for "starbridge v1.0.0", not starbridge v9.9.9');
    expect(existsSync(r.bin)).toBe(false);
    release.server.stop(true);
    release = fakeReleases("9.9.9");
    expect((await run(release.url, release.pubkey, "v9.9.9")).code).toBe(0);
  });
});

/** The `n`th line of a signature file, changed by `f`. */
const line = (n: number, f: (l: string) => string) => (sig: string) =>
  sig
    .split("\n")
    .map((l, i) => (i === n ? f(l) : l))
    .join("\n");
/** A base64 line with byte `at` flipped. */
const flip = (at: number) => (l: string) => {
  const b = Buffer.from(l, "base64");
  b[at] = (b[at] as number) ^ 1;
  return b.toString("base64");
};
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
/** The same signature with S + L in place of S: the same point equation, not canonical. */
function plusL(sig: Uint8Array): Buffer {
  const s = BigInt(`0x${Buffer.from(sig.subarray(32)).reverse().toString("hex")}`) + L;
  const bytes = Buffer.from(s.toString(16).padStart(64, "0"), "hex").reverse();
  return Buffer.concat([sig.subarray(0, 32), bytes]);
}

// The checks the Python path makes, each failing closed: install stops and nothing is installed.
describe.skipIf(WINDOWS || !hasPython)("install.sh's Python check refuses", () => {
  const python = install.bind(null);
  test.each([
    ["a flipped byte in the file signature's R", { minisig: line(1, flip(12)) }],
    ["a flipped byte in the file signature's S", { minisig: line(1, flip(60)) }],
    ["a flipped byte in the key id", { minisig: line(1, flip(4)) }],
    [
      "an unknown algorithm",
      {
        minisig: line(1, (l) =>
          Buffer.concat([Buffer.from("Ex"), Buffer.from(l, "base64").subarray(2)]).toString(
            "base64",
          ),
        ),
      },
    ],
    ["a truncated file signature", { minisig: line(1, (l) => l.slice(0, -8)) }],
    ["a non-canonical S (S + L), with the trusted comment signed over it", { fileSig: plusL }],
    [
      "a trusted comment edited after signing",
      { minisig: line(2, () => "trusted comment: starbridge v9.9.8") },
    ],
    ["a flipped byte in the comment's signature", { minisig: line(3, flip(5)) }],
    ["a truncated comment signature", { minisig: line(3, (l) => l.slice(0, -8)) }],
    [
      "a missing comment signature",
      { minisig: (sig: string) => sig.split("\n").slice(0, 3).join("\n") },
    ],
    ["a tampered SHA256SUMS", { tamper: "sums" as const }],
  ])("%s", async (_, opts) => {
    release = fakeReleases("9.9.9", opts);
    const r = await python(release.url, release.pubkey, "python");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not carry the release signature");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("another key, even under the release key's id", async () => {
    const id = randomBytes(8);
    release = fakeReleases("9.9.9", { key: signer(id) });
    const trusted = signer(id).pubkey;
    const r = await install(release.url, trusted, "python");
    expect(r.err).toContain("does not carry the release signature");
    expect(existsSync(r.bin)).toBe(false);
  });

  // RFC 8032, section 7.1, tests 1 to 3, run through the script's own Ed25519 check.
  test("RFC 8032's vectors, and each with S + L", () => {
    const vectors = [
      [
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
      ],
      [
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
      ],
      [
        "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
        "af82",
        "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
      ],
    ] as const;
    const cases = vectors.flatMap(([key, msg, sig]) => [
      [key, msg, sig],
      [key, msg, plusL(Buffer.from(sig, "hex")).toString("hex")],
      [key, `${msg}00`, sig],
    ]);
    const script = readFileSync(join(CLI, "install.sh"), "utf8");
    const body = /<<'PY'\n([\s\S]*?)\nprefix = /.exec(script)?.[1] ?? "";
    const r = spawnSync(
      "python3",
      [
        "-c",
        `${body}\nimport json\nprint(json.dumps([verify(*(bytes.fromhex(x) for x in c)) for c in json.loads(sys.argv[1])]))`,
        JSON.stringify(cases),
      ],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  test("a legacy signature, over its file only", () => {
    const script = readFileSync(join(CLI, "install.sh"), "utf8");
    const body = /<<'PY'\n([\s\S]*?)\nPY\n/.exec(script)?.[1] ?? "";
    const check = (file: string) =>
      spawnSync("python3", ["-", FIXTURE_KEY, join(FIXTURES, "legacy.minisig"), file], {
        input: body,
        encoding: "utf8",
      });
    const ok = check(join(FIXTURES, "legacy"));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("trusted comment: legacy");
    const changed = join(dir, "legacy");
    writeFileSync(changed, `${fixture("legacy")}x`);
    expect(check(changed).status).toBe(1);
  });
});

// RHEL 8's Python sits at a path the PATH cannot hide.
test.skipIf(WINDOWS || existsSync("/usr/libexec/platform-python"))(
  "install.sh with nothing to check the signature says how to get minisign",
  async () => {
    release = fakeReleases("9.9.9");
    const r = await install(release.url, release.pubkey, "none");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("needs minisign, OpenSSL 3 or Python 3 to check the release signature");
    expect(r.err).toContain("To install minisign: ");
    expect(existsSync(r.bin)).toBe(false);
  },
);

/**
 * install.ps1 under PowerShell 7, with minisign from the PATH in place of the pinned Windows
 * download. The fake `.exe` is a shell script, so this runs on Linux and macOS only.
 */
const pwsh = spawnSync("pwsh", ["-v"]).status === 0 && process.platform !== "win32";
describe.skipIf(!pwsh || !hasMinisign)("install.ps1", () => {
  const asset = platformAsset("win32", process.arch);
  async function installPs(
    url: string,
    pubkey: string,
    version?: string,
    opts: { minisign?: string; iex?: boolean } = {},
  ) {
    const script = join(dir, "install.ps1");
    writeFileSync(
      script,
      readFileSync(join(CLI, "install.ps1"), "utf8").replace(
        /^ {2}\$PubKey = '\S+'$/m,
        `  $PubKey = '${pubkey}'`,
      ),
    );
    // As `irm | iex` runs it: in a session whose last native command exited 0.
    const iex = `cmd /c exit 0 2>$null; $global:LASTEXITCODE = 0; Get-Content -Raw '${script}' | Invoke-Expression`;
    const args = opts.iex ? ["-Command", iex] : ["-File", script];
    const p = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        STARBRIDGE_RELEASES_URL: url,
        STARBRIDGE_INSTALL_DIR: join(dir, "bin"),
        STARBRIDGE_MINISIGN:
          opts.minisign ??
          spawnSync("sh", ["-c", "command -v minisign"], {
            encoding: "utf8",
          }).stdout.trim(),
        STARBRIDGE_NO_SETUP: "1",
        NO_COLOR: "1",
        ...(version ? { STARBRIDGE_VERSION: version } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    // PowerShell wraps an error at the console width.
    const text = `${out}${err}`.replace(/\s*\n\s*\|\s*/g, " ");
    return { code, out: text, bin: join(dir, "bin", "starbridge.exe") };
  }

  test("installs the signed binary, over a copy that stays running", async () => {
    release = fakeReleases("9.9.9", { asset });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "starbridge.exe"), "old");
    const r = await installPs(release.url, release.pubkey);
    expect(r.out).toContain(`Installed starbridge 9.9.9 to ${r.bin}`);
    expect(r.code).toBe(0);
    expect(readFileSync(r.bin, "utf8")).toContain("starbridge 9.9.9");
    expect(existsSync(`${r.bin}.old`)).toBe(false);
  });

  test("refuses a binary that does not match, or a signature by another key", async () => {
    release = fakeReleases("9.9.9", { asset, tamper: "binary" });
    let r = await installPs(release.url, release.pubkey);
    expect(r.out).toContain("does not match its hash in SHA256SUMS");
    expect(r.code).not.toBe(0);
    release.server.stop(true);
    release = fakeReleases("9.9.9", { asset, key: signer() });
    r = await installPs(release.url, release.pubkey);
    expect(r.out).toContain("SHA256SUMS does not carry the release signature");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("under iex, a minisign that cannot start fails closed", async () => {
    release = fakeReleases("9.9.9", { asset });
    const r = await installPs(release.url, release.pubkey, undefined, {
      minisign: join(dir, "missing-minisign"),
      iex: true,
    });
    expect(r.out).toContain("SHA256SUMS does not carry the release signature");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("is plain ASCII, which Windows PowerShell reads right without a BOM", () => {
    const text = readFileSync(join(CLI, "install.ps1"), "utf8");
    expect([...text].every((c) => (c.codePointAt(0) ?? 0) < 128)).toBe(true);
  });

  test("refuses an older signed release served as the version asked for", async () => {
    release = fakeReleases("9.9.9", { asset, signed: "1.0.0" });
    const r = await installPs(release.url, release.pubkey, "9.9.9");
    expect(r.out).toContain('SHA256SUMS is signed for "starbridge v1.0.0", not starbridge v9.9.9');
    expect(existsSync(r.bin)).toBe(false);
  });
});

describe("update", () => {
  function installed() {
    const path = join(dir, "bin", WINDOWS ? "starbridge.exe" : "starbridge");
    mkdirSync(join(dir, "bin"));
    writeFileSync(path, "old");
    chmodSync(path, 0o755);
    return path;
  }
  const ctx = () => testCtx({ HOME: dir, PATH: "", STARBRIDGE_RELEASES_URL: release?.url ?? "" });

  test("offline, names what it could not reach and still checks CodexBar (#617)", async () => {
    const codexbar = join(dir, "codexbar");
    writeFileSync(codexbar, "#!/bin/sh\n", { mode: 0o755 });
    const c = testCtx({
      HOME: dir,
      PATH: "",
      STARBRIDGE_RELEASES_URL: "http://127.0.0.1:1",
      STARBRIDGE_CODEXBAR: codexbar,
    });
    expect(await update(c, { kind: "binary", path: installed() })).toBe(1);
    expect(c.lines[0]).toStartWith(
      "Could not update starbridge: cannot reach http://127.0.0.1:1/latest (",
    );
    expect(c.lines[1]).toStartWith(`CodexBar at ${codexbar} was not installed by starbridge`);
  });

  test("replaces the binary with the newer signed release", async () => {
    release = fakeReleases("99.0.0");
    const path = installed();
    const c = ctx();
    expect(await update(c, { kind: "binary", path }, release.pubkey)).toBe(0);
    // Then what the new binary printed for `setup --refresh` (the fake prints its version).
    expect(c.lines).toEqual([
      `Updated starbridge ${VERSION} to 99.0.0 in ${path}.`,
      "starbridge 99.0.0",
    ]);
    expect(spawnSync(path, ["--version"], { encoding: "utf8" }).stdout).toBe("starbridge 99.0.0\n");
  });

  test("moves the Starbridge Pi package to the new release's tag", async () => {
    release = fakeReleases("99.0.0");
    const path = installed();
    const settings = join(dir, ".pi/agent/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ packages: [piSource(VERSION)] }));
    const c = ctx();
    Object.assign(
      c.env,
      bareEnv({
        PATH: [FAKE_BIN, dirname(process.execPath), SYSTEM_PATH].join(delimiter),
        FAKE_LOG: join(dir, "calls"),
      }),
    );
    expect(await update(c, { kind: "binary", path }, release.pubkey)).toBe(0);
    expect(c.lines).toContain("Moved the Starbridge Pi package to v99.0.0.");
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual([piSource("99.0.0")]);
  });

  test("keeps the binary when the download does not check out", async () => {
    release = fakeReleases("99.0.0", { tamper: "binary" });
    const path = installed();
    await expect(update(ctx(), { kind: "binary", path }, release.pubkey)).rejects.toThrow(
      "does not match its hash",
    );
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  test("refuses an older signed release a mirror serves as the latest", async () => {
    release = fakeReleases("99.0.0", { signed: "0.0.1" });
    const path = installed();
    await expect(update(ctx(), { kind: "binary", path }, release.pubkey)).rejects.toThrow(
      'signed for "starbridge v0.0.1"',
    );
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  test("leaves a newer or equal version alone, and brew and npm installs to their manager", async () => {
    release = fakeReleases(VERSION);
    const path = installed();
    const c = ctx();
    expect(await update(c, { kind: "binary", path }, release.pubkey)).toBe(0);
    expect(await update(c, { kind: "brew" })).toBe(0);
    expect(c.lines).toEqual([
      `starbridge ${VERSION} is up to date.`,
      "starbridge was installed with brew: run brew upgrade starbridge, then starbridge setup --refresh",
    ]);
    expect(readFileSync(path, "utf8")).toBe("old");
  });
});
