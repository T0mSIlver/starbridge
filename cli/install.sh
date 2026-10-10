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
# minisign when installed, else OpenSSL 3, else Python 3 (RHEL 8 keeps one for dnf).
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
  get() { curl -fsL --proto '=https,http' -o "$2" "$1"; }
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

# The same check in Python, for systems with neither minisign nor OpenSSL 3, such as RHEL 8 and its
# OpenSSL 1.1.1. Ed25519 verification as in RFC 8032, section 5.1.7. Prints the trusted comment.
python_verify() {
  "$1" - "$PUBKEY" "$2" "$3" <<'PY'
import base64, hashlib, sys

p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = -121665 * pow(121666, p - 2, p) % p
I = pow(2, (p - 1) // 4, p)

def add(P, Q):
    a = (P[1] - P[0]) * (Q[1] - Q[0]) % p
    b = (P[1] + P[0]) * (Q[1] + Q[0]) % p
    c = 2 * P[3] * Q[3] * d % p
    e = 2 * P[2] * Q[2] % p
    f, g, h, k = b - a, e - c, e + c, b + a
    return (f * g % p, h * k % p, g * h % p, f * k % p)

def mul(s, P):
    Q = (0, 1, 1, 0)
    while s:
        if s & 1:
            Q = add(Q, P)
        P = add(P, P)
        s >>= 1
    return Q

def same(P, Q):
    return (P[0] * Q[2] - Q[0] * P[2]) % p == 0 and (P[1] * Q[2] - Q[1] * P[2]) % p == 0

def point(y, sign):
    if y >= p:
        return None
    x2 = (y * y - 1) * pow(d * y * y + 1, p - 2, p) % p
    if x2 == 0:
        return None if sign else (0, y, 1, 0)
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p:
        x = x * I % p
    if (x * x - x2) % p:
        return None
    if x & 1 != sign:
        x = p - x
    return (x, y, 1, x * y % p)

def decode(b):
    y = int.from_bytes(b, "little")
    return point(y & ((1 << 255) - 1), y >> 255)

B = point(4 * pow(5, p - 2, p) % p, 0)

def verify(key, msg, sig):
    A, R = decode(key), decode(sig[:32])
    s = int.from_bytes(sig[32:], "little")
    if A is None or R is None or s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + key + msg).digest(), "little") % L
    return same(mul(s, B), add(R, mul(h, A)))

prefix = b"trusted comment: "
try:
    pub = base64.b64decode(sys.argv[1], validate=True)
    with open(sys.argv[2], "rb") as f:
        lines = f.read().split(b"\n")
    sig = base64.b64decode(lines[1].strip(), validate=True)
    comment = lines[2].rstrip(b"\r")
    signed = base64.b64decode(lines[3].strip(), validate=True)
    with open(sys.argv[3], "rb") as f:
        msg = f.read()
except Exception:
    sys.exit(1)
if len(pub) != 42 or pub[:2] != b"Ed" or len(sig) != 74 or sig[2:10] != pub[2:10]:
    sys.exit(1)
if sig[:2] == b"ED":
    msg = hashlib.blake2b(msg).digest()
elif sig[:2] != b"Ed":
    sys.exit(1)
if not comment.startswith(prefix) or len(signed) != 64:
    sys.exit(1)
if not verify(pub[10:], msg, sig[10:]) or not verify(pub[10:], sig[10:] + comment[17:], signed):
    sys.exit(1)
sys.stdout.write(comment.decode("utf-8", "replace"))
PY
}

# A Python 3 that can check: python3, else the one every RHEL 8 keeps for dnf.
python=
for py in python3 /usr/libexec/platform-python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import hashlib; hashlib.blake2b' >/dev/null 2>&1; then
    python=$py
    break
  fi
done

# The command that installs minisign on this system.
minisign_hint() {
  if [ "$os" = darwin ]; then
    echo "brew install minisign"
    return
  fi
  id= like= version=
  if [ -r /etc/os-release ]; then
    id=$(. /etc/os-release && echo "${ID:-}")
    like=$(. /etc/os-release && echo "${ID_LIKE:-}")
    version=$(. /etc/os-release && echo "${VERSION_ID:-}")
  fi
  case " $id $like " in
    " fedora "*) echo "sudo dnf install minisign" ;;
    " rhel "*) echo "sudo dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-${version%%.*}.noarch.rpm && sudo dnf install minisign" ;;
    *" rhel "* | *" centos "* | *" fedora "*) echo "sudo dnf install epel-release && sudo dnf install minisign" ;;
    *" debian "* | *" ubuntu "*) echo "sudo apt install minisign" ;;
    *" arch "*) echo "sudo pacman -S minisign" ;;
    *) echo "see https://jedisct1.github.io/minisign/" ;;
  esac
}

if command -v minisign >/dev/null 2>&1; then
  comment="trusted comment: $(minisign -VQ -P "$PUBKEY" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig")" ||
    fail "SHA256SUMS does not carry the release signature"
elif command -v openssl >/dev/null 2>&1 &&
  openssl pkeyutl -help 2>&1 | grep -q rawin && openssl list -digest-algorithms 2>/dev/null | grep -qi blake2b512; then
  openssl_verify "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.minisig" ||
    fail "SHA256SUMS does not carry the release signature"
elif [ -n "$python" ]; then
  comment=$(python_verify "$python" "$tmp/SHA256SUMS.minisig" "$tmp/SHA256SUMS") ||
    fail "SHA256SUMS does not carry the release signature"
else
  fail "needs minisign, OpenSSL 3 or Python 3 to check the release signature. To install minisign: $(minisign_hint)"
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
