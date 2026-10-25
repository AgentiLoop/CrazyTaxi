#!/usr/bin/env bash
# Packages the web-thin Windows app (x64 + ARM64 in one zip): crazytaxi-web.ps1 opens the hosted game in a
# Microsoft Edge app window, so nothing is compiled or bundled. Install.cmd / CrazyTaxi.cmd / Uninstall.cmd wrap it.
# Usage: windows/build-web-thin.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION=$(node -p "require('$HERE/../package.json').version")
URL="${CT_WEB_URL:-https://ct.gokart.games/}"
STAGE="$HERE/build/web-thin/CrazyTaxi-web-thin"
ZIP="$HERE/../release/CrazyTaxi-web-thin-$VERSION-win.zip"

crlf() { sed 's/$/\r/'; }   # .cmd/.ps1/.txt with Windows line endings
rm -rf "$HERE/build/web-thin"; mkdir -p "$STAGE"
crlf < "$HERE/crazytaxi-web.ps1" > "$STAGE/crazytaxi-web.ps1"
crlf < "$HERE/README-web-thin.txt" > "$STAGE/README.txt"
printf '%s\r\n' "$URL" > "$STAGE/url.txt"
cmd() { printf '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%%~dp0crazytaxi-web.ps1" %s\r\n%s\r\n' "$1" "$2" > "$STAGE/$3"; }
cmd ''           'if errorlevel 1 pause' Install.cmd
cmd '-Run'       'if errorlevel 1 pause' CrazyTaxi.cmd
cmd '-Uninstall' 'pause'                 Uninstall.cmd
mkdir -p "$(dirname "$ZIP")"; rm -f "$ZIP"
(cd "$HERE/build/web-thin" && zip -qrX "$ZIP" CrazyTaxi-web-thin)
ls -la "$ZIP"
