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
import { testCtx } from "./helpers";

const CLI = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "minisign");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const FIXTURE_KEY = fixture("test.pub").toString().split("\n")[1] as string;

/** A throwaway minisign key that signs the way `minisign -S` does (prehashed "ED"). */
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    pubkey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"),
    sign(file: Uint8Array, comment = "starbridge test") {
      const s = sign(null, createHash("blake2b512").update(file).digest(), privateKey);
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
  } = {},
) {
  const key = signer();
  const asset = opts.asset ?? platformAsset();
  const binary = `#!/bin/sh\necho "starbridge ${version}"\n`;
  const sums = `${createHash("sha256").update(binary).digest("hex")}  ${asset}\n`;
  const files: Record<string, string> = {
    SHA256SUMS: opts.tamper === "sums" ? `${"0".repeat(64)}  ${asset}\n` : sums,
    "SHA256SUMS.minisig": (opts.key ?? key).sign(
      Buffer.from(sums),
      `starbridge v${opts.signed ?? version}`,
    ),
    [asset]: opts.tamper === "binary" ? `${binary}# changed\n` : binary,
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

/** Runs a copy of install.sh that trusts `pubkey`, with PATH stripped of minisign if asked. */
async function install(url: string, pubkey: string, withMinisign: boolean, version?: string) {
  const script = join(dir, "install.sh");
  writeFileSync(
    script,
    readFileSync(join(CLI, "install.sh"), "utf8").replace(/^PUBKEY=\S+$/m, `PUBKEY=${pubkey}`),
  );
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => withMinisign || !existsSync(join(d, "minisign")))
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
const verifiers = hasMinisign ? ["openssl", "minisign"] : ["openssl"];

describe.each(verifiers)("install.sh checking with %s", (verifier) => {
  const run = (url: string, pubkey: string, version?: string) =>
    install(url, pubkey, verifier === "minisign", version);

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
    const path = join(dir, "bin", "starbridge");
    mkdirSync(join(dir, "bin"));
    writeFileSync(path, "old");
    chmodSync(path, 0o755);
    return path;
  }
  const ctx = () => testCtx({ HOME: dir, PATH: "", STARBRIDGE_RELEASES_URL: release?.url ?? "" });

  test("replaces the binary with the newer signed release", async () => {
    release = fakeReleases("99.0.0");
    const path = installed();
    const c = ctx();
    expect(await update(c, { kind: "binary", path }, release.pubkey)).toBe(0);
    // Then what the new binary printed for `setup --refresh` (the fake prints its version).
    expect(c.lines).toEqual([`Updated starbridge ${VERSION} to 99.0.0.`, "starbridge 99.0.0"]);
    expect(spawnSync(path, ["--version"], { encoding: "utf8" }).stdout).toBe("starbridge 99.0.0\n");
  });

  test("moves the Starbridge Pi package to the new release's tag", async () => {
    release = fakeReleases("99.0.0");
    const path = installed();
    const settings = join(dir, ".pi/agent/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ packages: [piSource(VERSION)] }));
    const c = ctx();
    c.env.PATH = [join(import.meta.dir, "fixtures", "fake-bin"), dirname(process.execPath)].join(
      delimiter,
    );
    c.env.FAKE_LOG = join(dir, "calls");
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
