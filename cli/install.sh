#!/bin/sh
# Installs the starbridge CLI into ~/.local/bin from a GitHub Release, then runs `starbridge setup`.
#
#   curl -fsSL https://starbridge.run/install.sh | sh
#
# starbridge.run serves this file from the deployed revision of main; each release also
# carries a copy as an asset. A self-hosted server serves its own copy, so
# `curl -fsSL https://my.host/install.sh | sh` sets the machine up with my.host.
#
# It accepts the binary only if its hash is in SHA256SUMS and SHA256SUMS carries the release
# key's minisign signature, for STARBRIDGE_VERSION when that is set. It checks the signature with
# minisign when installed, else openssl.
#
# STARBRIDGE_VERSION=1.2.3      a version other than the latest release
# STARBRIDGE_INSTALL_DIR=<dir>  instead of ~/.local/bin
# STARBRIDGE_NO_SETUP=1         install only
# STARBRIDGE_RELEASES_URL=<url> a mirror of https://github.com/T0mSIlver/starbridge/releases
set -eu

# The server setup pairs with: each Starbridge server writes its own address here when it serves
# this file (web/src/app/install.sh/route.ts). Empty, setup picks starbridge.run.
# STARBRIDGE_SERVER, when set, wins.
SERVER=

# The release key. Also in cli/minisign.pub, cli/src/release.ts and the README.
PUBKEY=RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F

RELEASES=${STARBRIDGE_RELEASES_URL:-https://github.com/T0mSIlver/starbridge/releases}
DIR=${STARBRIDGE_INSTALL_DIR:-$HOME/.local/bin}

fail() {
  echo "starbridge install: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no build for $(uname -s); try npm i -g starbridge" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no build for $(uname -m); try npm i -g starbridge" ;;
esac
# A shell under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  fail "the Linux builds need glibc and this system uses musl; try npm i -g starbridge"
fi
asset=starbridge-$os-$arch

if [ -n "${STARBRIDGE_VERSION:-}" ]; then
  base=$RELEASES/download/v${STARBRIDGE_VERSION#v}
else
  base=$RELEASES/latest/download
fi

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL --proto '=https,http' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q -O "$2" "$1"; }
else
  fail "needs curl or wget"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

for f in SHA256SUMS SHA256SUMS.minisig "$asset"; do
  get "$base/$f" "$tmp/$f" || fail "could not download $base/$f"
done

# Checks the minisign signature with openssl: the key id, then the Ed25519 signature over the file
# (over its BLAKE2b-512 hash for prehashed "ED" signatures), then the one over the trusted comment.
openssl_verify() {
  file=$1 sig=$2 t=$tmp/v
  mkdir "$t"
  printf '%s' "$PUBKEY" | openssl base64 -d -A >"$t/pub"
  sed -n 2p "$sig" | openssl base64 -d -A >"$t/sig"
  dd if="$t/pub" bs=1 skip=2 count=8 2>/dev/null >"$t/pubid"
  dd if="$t/sig" bs=1 skip=2 count=8 2>/dev/null >"$t/sigid"
  cmp -s "$t/pubid" "$t/sigid" || return 1
  # Ed25519 SubjectPublicKeyInfo header, then the 32-byte key.
  printf '\060\052\060\005\006\003\053\145\160\003\041\000' >"$t/key.der"
  dd if="$t/pub" bs=1 skip=10 count=32 2>/dev/null >>"$t/key.der"
  dd if="$t/sig" bs=1 skip=10 count=64 2>/dev/null >"$t/s"
  case $(dd if="$t/sig" bs=1 count=2 2>/dev/null) in
    ED) openssl dgst -blake2b512 -binary "$file" >"$t/m" ;;
    Ed) cp "$file" "$t/m" ;;
    *) return 1 ;;
  esac
  ed25519() { openssl pkeyutl -verify -pubin -keyform DER -inkey "$t/key.der" -rawin -in "$1" -sigfile "$2" >/dev/null 2>&1; }
  ed25519 "$t/m" "$t/s" || return 1
  comment=$(sed -n 3p "$sig")
  case $comment in "trusted comment: "*) ;; *) return 1 ;; esac
  { cat "$t/s"; printf '%s' "${comment#trusted comment: }"; } >"$t/gm"
  sed -n 4p "$sig" | openssl base64 -d -A >"$t/gs"
  ed25519 "$t/gm" "$t/gs"
}

if command -v minisign >/dev/null 2>&1; then
  comment="trusted comment: $(minisign -VQ -P "$PUBKEY" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig")" ||
    fail "SHA256SUMS does not carry the release signature"
elif command -v openssl >/dev/null 2>&1 &&
  openssl pkeyutl -help 2>&1 | grep -q rawin && openssl list -digest-algorithms 2>/dev/null | grep -qi blake2b512; then
  openssl_verify "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.minisig" ||
    fail "SHA256SUMS does not carry the release signature"
else
  fail "needs minisign (https://jedisct1.github.io/minisign/) or OpenSSL 3 to check the release signature"
fi
# The trusted comment names the version the signature is for, whatever tag served it.
signed=${comment#trusted comment: }
if [ -n "${STARBRIDGE_VERSION:-}" ] && [ "$signed" != "starbridge v${STARBRIDGE_VERSION#v}" ]; then
  fail "SHA256SUMS is signed for \"$signed\", not starbridge v${STARBRIDGE_VERSION#v}"
fi

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS lists no $asset"
if command -v sha256sum >/dev/null 2>&1; then
  have=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  have=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$have" = "$want" ] || fail "$asset does not match its hash in SHA256SUMS"

mkdir -p "$DIR"
chmod 755 "$tmp/$asset"
mv -f "$tmp/$asset" "$DIR/.starbridge.new"
mv -f "$DIR/.starbridge.new" "$DIR/starbridge"
echo "Installed $("$DIR/starbridge" --version) to $DIR/starbridge"

case :$PATH: in
  *:"$DIR":*) ;;
  *) echo "Add $DIR to your PATH, for example in ~/.profile: export PATH=\"$DIR:\$PATH\"" ;;
esac

# Run setup from the terminal, since stdin is this script under curl | sh.
server=$SERVER
[ -z "${STARBRIDGE_SERVER:-}" ] || server=
if [ -z "${STARBRIDGE_NO_SETUP:-}" ] && "$DIR/starbridge" --help | grep -q '^  starbridge setup'; then
  if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
    "$DIR/starbridge" setup ${server:+--server "$server"} </dev/tty
  else
    echo "Next: run starbridge setup${server:+ --server $server}"
  fi
fi
