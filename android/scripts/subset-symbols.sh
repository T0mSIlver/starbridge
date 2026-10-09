#!/bin/bash
# Rebuilds app/src/main/res/font/material_symbols_rounded.ttf: Material Symbols Rounded, variable
# (FILL, GRAD, opsz, wght), cut down to the glyphs `Sym` names. To add one, add its name here and
# its codepoint to `Sym` (ui/Symbols.kt). Needs curl and uv.
set -euo pipefail
NAMES="inbox speed settings terminal contact_support check more_vert arrow_back smartphone laptop_mac
desktop_windows dns cloud notifications drag_indicator chevron_right expand_more expand_less play_arrow
qr_code_2 lock filter_list history key devices open_in_new open_in_full hourglass_top sync send link keyboard_arrow_up
keyboard_arrow_down check_circle computer close error content_copy visibility logout add pin search
notifications_off snooze visibility_off"
BASE=https://github.com/google/material-design-icons/raw/master/variablefont
FONT="MaterialSymbolsRounded%5BFILL,GRAD,opsz,wght%5D"
OUT="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/res/font/material_symbols_rounded.ttf"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/full.ttf" "$BASE/$FONT.ttf"
curl -fsSL -o "$TMP/codepoints" "$BASE/$FONT.codepoints"
UNICODES=""
for name in $NAMES; do
  code=$(awk -v n="$name" '$1 == n { print $2; exit }' "$TMP/codepoints")
  [ -n "$code" ] || { echo "no symbol named $name" >&2; exit 1; }
  UNICODES="$UNICODES,U+$code"
  echo "$name $code"
done
uv tool run --from fonttools pyftsubset "$TMP/full.ttf" --unicodes="${UNICODES#,}" --layout-features='' --no-hinting --output-file="$OUT"
