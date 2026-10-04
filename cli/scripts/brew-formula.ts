/**
 * Prints the Homebrew formula for one release, from its SHA256SUMS:
 *   bun run scripts/brew-formula.ts <version> <SHA256SUMS> [<releases url>]
 * The release workflow commits it to T0mSIlver/homebrew-starbridge as Formula/starbridge.rb.
 */
import { readFileSync } from "node:fs";
import { parseSums, RELEASES_URL } from "../src/release";

const [version, sumsPath, releases = RELEASES_URL] = process.argv.slice(2);
if (!version || !sumsPath) throw new Error("usage: brew-formula.ts <version> <SHA256SUMS> [url]");
const sums = parseSums(readFileSync(sumsPath, "utf8"));

function asset(os: string, arch: string): string {
  const name = `starbridge-${os}-${arch}`;
  const sha = sums.get(name);
  if (!sha) throw new Error(`SHA256SUMS lists no ${name}`);
  return `      url "${releases}/download/v${version}/${name}"
      sha256 "${sha}"`;
}

process.stdout.write(`class Starbridge < Formula
  desc "Answer your coding agents' decisions from your phone and watch AI plan quotas"
  homepage "https://github.com/T0mSIlver/starbridge"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${asset("darwin", "arm64")}
    end
    on_intel do
${asset("darwin", "x64")}
    end
  end

  on_linux do
    on_arm do
${asset("linux", "arm64")}
    end
    on_intel do
${asset("linux", "x64")}
    end
  end

  def install
    bin.install Dir["starbridge-*"].first => "starbridge"
  end

  def caveats
    "Run starbridge setup to pair this machine."
  end

  test do
    assert_equal "starbridge #{version}", shell_output("#{bin}/starbridge --version").strip
  end
end
`);
