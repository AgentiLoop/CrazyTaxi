#!/usr/bin/env bash
# Packages the web-thin Linux app (x64 + arm64 in one tarball): the CrazyTaxi launcher opens the hosted game in a
# Chrome / Chromium app window; install.sh installs a browser if needed + a menu entry.
# Usage: linux/build-web-thin.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION=$(node -p "require('$HERE/../package.json').version")
URL="${CT_WEB_URL:-https://ct.gokart.games/}"
STAGE="$HERE/build/web-thin/CrazyTaxi-web-thin"
TGZ="$HERE/../release/CrazyTaxi-web-thin-$VERSION-linux.tar.gz"

rm -rf "$HERE/build/web-thin"; mkdir -p "$STAGE"
cp "$HERE/CrazyTaxi" "$HERE/install.sh" "$STAGE/"
cp "$HERE/README-web-thin.txt" "$STAGE/README.txt"
echo "$URL" > "$STAGE/url.txt"
chmod +x "$STAGE/CrazyTaxi" "$STAGE/install.sh"
mkdir -p "$(dirname "$TGZ")"; rm -f "$TGZ"
COPYFILE_DISABLE=1 tar -czf "$TGZ" -C "$HERE/build/web-thin" CrazyTaxi-web-thin
ls -la "$TGZ"
