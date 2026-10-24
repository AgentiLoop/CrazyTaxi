#!/bin/sh
# The 60 fps check in the real thing: the macOS app's WKWebView (mac/build/CrazyTaxi.app).
# Builds dist/ and the app, opens the city unattended, drives for SECONDS and prints one
# JSON line a second plus a summary (fps min/mean/max over the driving seconds, frames over
# 20 ms, the longest frame, the WebContent process's footprint).
# Usage: tools/mac-probe.sh [seconds=30] [query=city=arcade] [WxH=1280x960]
set -e
cd "$(dirname "$0")/.."
SECONDS_=${1:-30}
QUERY=${2:-city=arcade}
SIZE=${3:-1280x960}
npm run build >/dev/null 2>&1
mac/build.sh >/dev/null
exec mac/build/CrazyTaxi.app/Contents/MacOS/CrazyTaxi --root "$PWD" --probe "$SECONDS_" --query "$QUERY" --size "$SIZE"
