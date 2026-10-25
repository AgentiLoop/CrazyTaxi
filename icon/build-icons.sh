#!/usr/bin/env bash
# Renders icon/crazytaxi.svg into the app icons: mac/AppIcon.icns, windows/CrazyTaxi.ico, linux/crazytaxi.png
# and icon/crazytaxi.png (1024). Needs rsvg-convert (brew install librsvg), iconutil and python3 with Pillow.
# Usage: icon/build-icons.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
SVG="$HERE/crazytaxi.svg"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

png() { rsvg-convert -w "$1" -h "$1" "$SVG" -o "$2"; }
png 1024 "$HERE/crazytaxi.png"
png 512 "$ROOT/linux/crazytaxi.png"

SET="$TMP/AppIcon.iconset"; mkdir "$SET"
for s in 16 32 128 256 512; do
  png "$s" "$SET/icon_${s}x${s}.png"
  png $((s * 2)) "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o "$ROOT/mac/AppIcon.icns"

png 256 "$TMP/ico.png"
python3 -c "from PIL import Image; Image.open('$TMP/ico.png').save('$ROOT/windows/CrazyTaxi.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])"
ls -la "$HERE/crazytaxi.png" "$ROOT/mac/AppIcon.icns" "$ROOT/windows/CrazyTaxi.ico" "$ROOT/linux/crazytaxi.png"
