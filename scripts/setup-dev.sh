#!/usr/bin/env bash
# Sets up an Ubuntu or Debian box, or a Claude Code cloud environment, to build and test
# Starbridge: Node 24, Bun, pnpm, JDK 21, xvfb and Playwright's Firefox, and with --android the
# Android SDK. Inside a clone it also installs the dependencies and the git hooks
# (scripts/worktree-setup.sh). Safe to run again: each step skips what is already there.
# CONTRIBUTING.md, "Set up a box", says how to use it.
#
#   scripts/setup-dev.sh [--android] [--no-browser] [--dry-run]
set -euo pipefail

BUN_VERSION=1.4.2   # CI's pin, in .github/workflows/*.yml
NODE_MAJOR=24       # CI's node-version
NODE_VERSION=24.18.0
ANDROID_PACKAGES=("platforms;android-37.0" "build-tools;37.0.0" "platform-tools")
RAW=${STARBRIDGE_RAW:-https://raw.githubusercontent.com/T0mSIlver/starbridge/main}

android=0 browser=1 dry=0
for arg in "$@"; do
  case $arg in
    --android) android=1 ;;
    --no-browser) browser=0 ;;
    --dry-run) dry=1 ;;
    -h | --help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "setup-dev: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { printf 'setup-dev: %s\n' "$*"; }
warn() { printf 'setup-dev: warning: %s\n' "$*" >&2; }
run() {
  printf '+ %s\n' "$*"
  [ "$dry" = 1 ] || "$@"
}

# The clone this script sits in, or the one the current directory is in. Piped from curl, the
# script has no file, so only the current directory counts.
repo=
for dir in "$(dirname "${BASH_SOURCE[0]:-.}")" "$PWD"; do
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || continue
  if [ -f "$top/scripts/setup-dev.sh" ] && [ -f "$top/pnpm-workspace.yaml" ]; then repo=$top; break; fi
done

if [ "$(id -u)" = 0 ]; then
  prefix=/usr/local sudo=()
else
  prefix=$HOME/.local sudo=(sudo)
fi
orig_path=$PATH
export PATH="$prefix/bin:$PATH"

case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "setup-dev: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

# A file from the clone, or from main on GitHub when there is no clone.
repo_file() {
  if [ -n "$repo" ]; then cat "$repo/$1"; else curl -fsSL "$RAW/$1"; fi
}

# System packages.
if command -v apt-get >/dev/null; then
  need=()
  for pkg in ca-certificates curl git python3 unzip xz-utils xvfb; do
    dpkg -s "$pkg" >/dev/null 2>&1 || need+=("$pkg")
  done
  java -version 2>&1 | grep -q 'version "21' || need+=(openjdk-21-jdk-headless)
  if [ ${#need[@]} -gt 0 ]; then
    run "${sudo[@]}" apt-get update -q
    run "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${need[@]}"
  else
    say "system packages present"
  fi
else
  warn "no apt-get: install curl, git, python3, unzip, xz, xvfb and JDK 21 yourself"
fi

# Node, from nodejs.org, checked against its published SHA-256.
if node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  say "Node $(node --version) present"
else
  name=node-v$NODE_VERSION-linux-$arch
  dest=$prefix/lib/nodejs
  tmp=$(mktemp -d)
  run curl -fsSLo "$tmp/$name.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz"
  run curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  if [ "$dry" = 0 ]; then
    (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum --check --status) ||
      { echo "setup-dev: $name.tar.xz does not match nodejs.org's checksum" >&2; exit 1; }
  fi
  run mkdir -p "$dest" "$prefix/bin"
  run tar -xJf "$tmp/$name.tar.xz" -C "$dest"
  for bin in node npm npx corepack; do run ln -sf "$dest/$name/bin/$bin" "$prefix/bin/$bin"; done
  rm -rf "$tmp"
fi

# Bun and pnpm, from npm: bun.sh is not on a cloud environment's default list of allowed domains.
pnpm_version=$(repo_file package.json | sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' || true)
[ -n "$pnpm_version" ] || { echo "setup-dev: could not read the pnpm version in package.json's packageManager" >&2; exit 1; }
npm_global=()
[ "$(bun --version 2>/dev/null)" = "$BUN_VERSION" ] && say "Bun $BUN_VERSION present" || npm_global+=("bun@$BUN_VERSION")
[ "$(pnpm --version 2>/dev/null)" = "$pnpm_version" ] && say "pnpm $pnpm_version present" || npm_global+=("pnpm@$pnpm_version")
[ ${#npm_global[@]} -eq 0 ] || run npm install --global --prefix "$prefix" "${npm_global[@]}"

# When the PATH this shell started with finds another node, bun or pnpm first, put ours in front
# in ~/.bashrc, which Claude Code's shell reads too.
stale=
[[ $(PATH=$orig_path node --version 2>/dev/null) == "v$NODE_MAJOR."* ]] || stale="$stale node"
[ "$(PATH=$orig_path bun --version 2>/dev/null)" = "$BUN_VERSION" ] || stale="$stale bun"
[ "$(PATH=$orig_path pnpm --version 2>/dev/null)" = "$pnpm_version" ] || stale="$stale pnpm"
line="export PATH=\"$prefix/bin:\$PATH\" # starbridge setup-dev"
if [ -n "$stale" ] && ! grep -qxF "$line" "$HOME/.bashrc" 2>/dev/null; then
  say "putting $prefix/bin first on the PATH in ~/.bashrc, for:$stale"
  [ "$dry" = 1 ] || printf '\n%s\n' "$line" >>"$HOME/.bashrc"
fi

if [ -n "$repo" ]; then
  run "$repo/scripts/worktree-setup.sh"
else
  # A cloud environment's setup runs before the clone exists, or elsewhere. Filling pnpm's store
  # from main's lockfile lets the session's own install (.claude/settings.json) skip the registry.
  tmp=$(mktemp -d)
  if ! (for f in package.json pnpm-lock.yaml pnpm-workspace.yaml; do repo_file "$f" >"$tmp/$f"; done &&
    cd "$tmp" && run pnpm fetch); then
    warn "pnpm fetch failed; the first install downloads every package"
  fi
  rm -rf "$tmp"
fi

# Playwright's Firefox, for the web and desktop end-to-end runs. Its download servers are not on a
# cloud environment's default list of allowed domains, so a failure here only warns.
if [ "$browser" = 1 ]; then
  pw_version=$(repo_file web/package.json | sed -n 's/.*"playwright": *"\([^"]*\)".*/\1/p')
  deps=()
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then deps=(--with-deps); fi
  run npx --yes "playwright@$pw_version" install "${deps[@]}" firefox ||
    warn "Playwright's Firefox did not install; the end-to-end runs need it (CONTRIBUTING.md, \"Set up a box\")"
fi

# The Android SDK: the newest command-line tools from Google's repository index, then the
# platform and build tools android/app/build.gradle.kts compiles against.
if [ "$android" = 1 ]; then
  sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
  sdkmanager=$sdk/cmdline-tools/latest/bin/sdkmanager
  if [ ! -x "$sdkmanager" ]; then
    index=https://dl.google.com/android/repository/repository2-3.xml
    zip=$(curl -fsSL "$index" | python3 -c '
import sys, xml.etree.ElementTree as ET
for p in ET.parse(sys.stdin).getroot().iter("remotePackage"):
    if p.get("path") == "cmdline-tools;latest":
        for a in p.iter("archive"):
            if a.findtext("host-os") == "linux":
                print(a.findtext("complete/url"), a.findtext("complete/checksum"))
                sys.exit()
') || { warn "could not read $index; is dl.google.com allowed?"; zip=; }
    if [ -n "$zip" ]; then
      read -r file sha1 <<<"$zip"
      tmp=$(mktemp -d)
      if run curl -fsSLo "$tmp/$file" "https://dl.google.com/android/repository/$file" &&
        { [ "$dry" = 1 ] || echo "$sha1  $tmp/$file" | sha1sum --check --status; }; then
        run mkdir -p "$sdk/cmdline-tools"
        run unzip -q -o "$tmp/$file" -d "$tmp"
        run rm -rf "$sdk/cmdline-tools/latest"
        run mv "$tmp/cmdline-tools" "$sdk/cmdline-tools/latest"
      else
        warn "$file did not download, or does not match Google's checksum"
      fi
      rm -rf "$tmp"
    fi
  fi
  if [ -x "$sdkmanager" ] || [ "$dry" = 1 ]; then
    [ "$dry" = 1 ] || yes 2>/dev/null | "$sdkmanager" --licenses >/dev/null || true
    run "$sdkmanager" "${ANDROID_PACKAGES[@]}" || warn "sdkmanager did not install ${ANDROID_PACKAGES[*]}"
    if [ -n "$repo" ] && [ ! -f "$repo/android/local.properties" ]; then
      say "writing android/local.properties with sdk.dir=$sdk"
      [ "$dry" = 1 ] || echo "sdk.dir=$sdk" >"$repo/android/local.properties"
    fi
  fi
fi

say "done"
