#!/bin/zsh
# Publish the web game: ct.gokart.games (the code), ctlow.gokart.games (asset-release/lowres)
# and cthigh.gokart.games (asset-release/hires) as three Cloudflare static-asset Workers.
# The asset hosts send CORS headers (_headers); their Brotli .br copies are left out
# (static assets can't send them with Content-Encoding: Cloudflare compresses on its own).
set -e
cd "${0:A:h}/.."
for dir in asset-release/lowres asset-release/hires; do
  printf '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=86400\n' > $dir/_headers
  printf '*.br\n.git\n.gitignore\n.DS_Store\nREADME.md\n' > $dir/.assetsignore
done
VITE_ASSETS=https://ctlow.gokart.games/ VITE_PACK=https://cthigh.gokart.games/ npm run build
for site in ctlow cthigh ct; do npx wrangler@4 deploy -c deploy/$site.toml; done
