// Serve the asset release's pre-compressed files (tools/build_asset_release.mjs writes a
// <name>.br next to every .glb/.json/.BIN/.svg/.wav/.ktx2) with Content-Encoding: br, in dev and in
// preview, whenever the browser accepts Brotli. Anything without a .br is served as before.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const TYPES = { glb: 'model/gltf-binary', json: 'application/json', BIN: 'application/octet-stream', svg: 'image/svg+xml', wav: 'audio/wav', ktx2: 'image/ktx2' };

function brotli(root) {
  return (req, res, next) => {
    const path = decodeURIComponent((req.url || '').split('?')[0]);
    const ext = path.slice(path.lastIndexOf('.') + 1);
    if (!TYPES[ext] || !/\bbr\b/.test(req.headers['accept-encoding'] || '')) return next();
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, '')) + '.br';
    if (!existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', TYPES[ext]);
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(readFileSync(file));
  };
}

export default {
  plugins: [{
    name: 'brotli-assets',
    configureServer(server) { server.middlewares.use(brotli(server.config.root)); },
    configurePreviewServer(server) { server.middlewares.use(brotli(server.config.root)); },
  }],
};
