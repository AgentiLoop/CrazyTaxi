#!/bin/sh
# Build the macOS app: mac/build/CrazyTaxi.app (a WKWebView playing dist/ over local-assets/).
# Usage: mac/build.sh [debug]      (release by default; needs `npm run build` for dist/)
set -e
cd "$(dirname "$0")"
CONF=${1:-release}
swift build -c "$CONF" 2>&1 | grep -v '^\[' || true
BIN=".build/$CONF/CrazyTaxi"
test -x "$BIN"
APP="build/CrazyTaxi.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CrazyTaxi"
cp Info.plist "$APP/Contents/"
cp AppIcon.icns "$APP/Contents/Resources/"
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $PWD/$APP"
