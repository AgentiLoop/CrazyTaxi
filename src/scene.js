// Scene building: the extracted glTF files drawn the way the Dreamcast draws
// them - unlit, texture times vertex colour - and the chase camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { scaledAtlases, swapAtlases } from './static-batch.js';

const loader = new GLTFLoader();

// KHR_materials_variants (the traffic cars' paints, "paint_NN"): three.js has no
// built-in support, so collect each mesh's variant materials by name into
// gltf.variants: Map<mesh name, Map<variant name, material>>.
loader.register((parser) => ({
  name: 'KHR_materials_variants',
  afterRoot(gltf) {
    const ext = parser.json.extensions && parser.json.extensions.KHR_materials_variants;
    gltf.variants = new Map();
    if (!ext) return;
    const names = ext.variants.map((v) => v.name);
    const pending = [];
    for (const scene of gltf.scenes) {
      scene.traverse((o) => {
        const m = o.userData.gltfExtensions && o.userData.gltfExtensions.KHR_materials_variants;
        if (!o.isMesh || !m) return;
        const byName = new Map();
        gltf.variants.set(o.name, byName);
        for (const map of m.mappings) {
          pending.push(parser.getDependency('material', map.material).then((mat) => {
            for (const v of map.variants) byName.set(names[v], mat);
          }));
        }
        delete o.userData.gltfExtensions;
      });
    }
    return Promise.all(pending);
  },
}));

export function loadGltf(url, onProgress) {
  return new Promise((resolve, reject) => loader.load(url, resolve, onProgress, reject))
    .then((gltf) => { models.push(gltf); if (HIRES) useTexturePack(gltf); return gltf; });
}

/**
 * Let go of a loaded glTF whose meshes are drawn no more (src/static-batch.js merged them):
 * its parser's caches hold the file's buffers and every parsed geometry, texture and
 * material - tens of MB for a city - and the pack would otherwise swap textures into it.
 */
export function releaseGltf(gltf) {
  const i = models.indexOf(gltf);
  if (i >= 0) models.splice(i, 1);
  if (gltf.parser && gltf.parser.cache) gltf.parser.cache.removeAll();
  gltf.parser = null;
  gltf.scene = null;
  gltf.scenes = [];
}

// The hi-res texture pack (?hires=1, or H in game). A Flycast custom texture pack (MK-51035), mapped
// onto the extracted textures by tools/match_texture_pack.py (local-assets/texture_pack/:
// manifest.json + one link per matched texture), replaces a model's TEXDC textures once
// it has loaded: the model shows at once with the game's textures, the pack's swap in
// as they decode. The pack's images are upright, the extracted PNGs (and so the models'
// UVs) upside down: decoded flipped. They are 4-32 times the game's size, ~1.7 GB of
// texels for a city at full size, so they are scaled to at most 512 texels a side
// (?hires=N: at most N) and drawn mipmapped. A model texture with see-through texels gets
// the pack's image cut by the game's alpha, scaled up (most of the pack is JPEG: the shop
// signs; some of its PNGs' alpha doesn't match the game's: the palm crowns). The menu's sprites
// (src/menu-view.js) and the HUD's destination pictures (src/hud.js) use it too.
// With an asset release (VITE_ASSETS=.../lowres/) the pack is its sibling hires/
// (tools/build_asset_release.mjs): there the models' textures are KTX2 (manifest `ktx2`,
// tools/ktx2_texture_pack.py: already flipped, scaled to at most 1024 and cut by the game's
// alpha), swapped in as GPU-compressed textures whatever ?hires=N says.
const RELEASE = (import.meta.env && import.meta.env.VITE_ASSETS) || '';
export const PACK = RELEASE ? RELEASE.replace(/[^/]+\/?$/, 'hires/') : 'local-assets/texture_pack/';

/** The longest side a pack image is drawn at for a page's query string (0 = no pack). */
export function hiresCap(search) {
  const v = new URLSearchParams(search).get('hires');
  if (v === null || v === '0') return 0;
  const n = parseInt(v, 10);
  return n >= 2 ? n : 512;
}
/** The pack's size cap while it is on, 0 while off (H toggles it). */
export let HIRES = typeof location !== 'undefined' ? hiresCap(location.search) : 0;
const PACK_CAP = HIRES || 512;
const models = [];              // every loaded glTF, so H can swap the pack in later
const originals = new Map();    // texture -> its sampling, put back when H turns the pack off
const gameImages = new Map();   // THREE.Source -> the game's image it held before the pack's
let batchedPack = null;         // the batched world's pack (packBatched): { batched, renderer, keyed, atlases, shown }

/** The game's image of a texture source (the pack's may be in it). */
function gameImage(source) {
  return gameImages.has(source) ? gameImages.get(source) : source.data;
}

/** Turn the pack on or off in place: the models' textures, the menu and the HUD follow HIRES. */
export function setHires(on) {
  HIRES = on ? PACK_CAP : 0;
  if (typeof history !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (HIRES) params.set('hires', String(PACK_CAP === 512 ? 1 : PACK_CAP)); else params.delete('hires');
    const q = params.toString();
    history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  if (HIRES) {
    for (const gltf of models) useTexturePack(gltf);
    if (batchedPack) showBatchedPack();
    return;
  }
  if (batchedPack && batchedPack.shown) { swapAtlases(batchedPack.batched, batchedPack.batched.batch.atlases); batchedPack.shown = false; }
  for (const [source, data] of gameImages) source.data = data;
  for (const [texture, o] of originals) {
    texture.dispose();
    Object.assign(texture, o);
    texture.needsUpdate = true;
  }
  gameImages.clear();
  originals.clear();
}

if (typeof addEventListener !== 'undefined') {
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    setHires(!HIRES);
  });
}

/** A texture's sampling and format before the pack's, put back when H turns the pack off. */
function keepOriginal(texture) {
  if (originals.has(texture)) return;
  const { minFilter, generateMipmaps, anisotropy, isCompressedTexture, mipmaps, format, type } = texture;
  originals.set(texture, { minFilter, generateMipmaps, anisotropy, isCompressedTexture, mipmaps, format, type });
}
/** Swap a pack image into a texture, keeping the game's to put back. */
function swapIn(texture, img) {
  const source = texture.source;
  if (!gameImages.has(source)) gameImages.set(source, source.data);
  keepOriginal(texture);
  source.data = img;
  texture.dispose();
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
}

/** The manifest's key ('textures/TEXDC1/0046.png') for a glTF image URI, else null. */
export function packKey(uri) {
  const m = /(?:^|\/)(textures\/TEXDC\d\/\d+\.png)$/.exec(uri || '');
  return m ? m[1] : null;
}

/** w x h scaled to at most cap on its longer side. */
export function fitSize(w, h, cap) {
  const s = Math.min(1, cap / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/**
 * Which file of a manifest entry to fetch for a size cap: [link, width, height]. The pack's
 * images pre-shrunk by tools/shrink_texture_pack.py (small/*.webp, ~16 times fewer bytes)
 * when one is at least as large as the cap draws the pack's, else the pack's own.
 */
export function packSource(t, cap) {
  const full = Math.max(t.pack_width, t.pack_height);
  const small = t.small ? Math.max(t.small_width, t.small_height) : 0;
  return small && small >= Math.min(cap, full) ? [t.small, t.small_width, t.small_height]
    : [t.link, t.pack_width, t.pack_height];
}

let packEntries = null;      // Promise<Map<key, manifest entry>>
const packImages = new Map(); // key -> Promise<ImageBitmap | null>
const packRequests = new Map(); // key -> { url, resolve, textures: Set<THREE.Source> }

function packManifest() {
  return packEntries || (packEntries = fetch(PACK + 'manifest.json')
    .then((r) => (r.ok ? r.json() : { textures: [] }))
    .then((m) => new Map(m.textures.filter((t) => t.link).map((t) => [t.png, t])))
    .catch(() => new Map()));
}

// At most PACK_FETCHES pack downloads at once, each at low fetch priority: the browser's
// connections per server stay free for the game's own files (the people's models waited
// behind hundreds at full size).
const PACK_FETCHES = 4;
let packFetching = 0;
const packQueue = [];

// What's in view first: the queue is ordered by how near the camera (packView) the
// textures' meshes are, those outside the view counting 4 times as far, the menu's and the
// HUD's pictures (no textures) before any, textures on nothing drawn last. Re-ranked at
// most every RANK_MS as downloads start.
const RANK_MS = 250;
let viewScene = null, viewCamera = null, rankedAt = -Infinity;

let ktx2 = null;   // KTX2Loader for the release's KTX2 textures: needs the renderer (its formats)
/** The scene and camera whose view orders the pack's downloads, the renderer drawing them (main.js). */
export function packView(scene, camera, renderer) {
  viewScene = scene;
  viewCamera = camera;
  if (renderer && !ktx2) ktx2 = new KTX2Loader().setTranscoderPath(PACK + 'basis/').detectSupport(renderer);
}

const _frustum = new THREE.Frustum(), _matrix = new THREE.Matrix4(), _sphere = new THREE.Sphere();
const _eye = new THREE.Vector3();

/** Per texture, the least (distance from the camera, x4 outside the view) of the meshes drawing it. */
function textureNearness() {
  const near = new Map();
  if (!viewScene || !viewCamera) return near;
  viewCamera.getWorldPosition(_eye);
  _frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(viewCamera.projectionMatrix, viewCamera.matrixWorldInverse));
  viewScene.traverseVisible((o) => {
    if (!o.isMesh || !o.material) return;
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    const d = Math.max(0, _sphere.center.distanceTo(_eye) - _sphere.radius) * (_frustum.intersectsSphere(_sphere) ? 1 : 4);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const t = m && m.map && m.map.source;   // clones of a texture share it
      if (t && !(near.get(t) <= d)) near.set(t, d);
    }
  });
  return near;
}

function rankPackQueue() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - rankedAt < RANK_MS || packQueue.length < 2) return;
  rankedAt = now;
  const near = textureNearness();
  const score = (req) => {
    if (!req.textures.size) return -1;
    let s = Infinity;
    for (const t of req.textures) s = Math.min(s, near.has(t) ? near.get(t) : Infinity);
    return s;
  };
  const scored = packQueue.map((req) => [score(req), req]);
  scored.sort((a, b) => (a[0] === b[0] ? 0 : a[0] - b[0]));
  scored.forEach(([, req], i) => { packQueue[i] = req; });
}

function packNext() {
  if (packFetching >= PACK_FETCHES || !packQueue.length) return;
  rankPackQueue();
  const req = packQueue.shift();
  packFetching++;
  const p = fetch(req.url, { priority: 'low' }).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
  p.then(() => { packFetching--; packNext(); });
  req.resolve(p);
}

/** The pack's image for a manifest entry; `texture` (a model's texture it replaces) ranks its download. */
function packImage(t, texture) {
  let p = packImages.get(t.png);
  if (!p) {
    const [url, width, height] = packSource(t, HIRES);
    const [w, h] = fitSize(width, height, HIRES);
    const req = { url: PACK + url, resolve: null, textures: new Set() };
    packRequests.set(t.png, req);
    p = new Promise((resolve) => { req.resolve = resolve; packQueue.push(req); packNext(); })
      .then((blob) => blob && createImageBitmap(blob, {
        imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
        resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
      }))
      .catch(() => null);
    packImages.set(t.png, p);
  }
  if (texture) packRequests.get(t.png).textures.add(texture.source);
  return p;
}

const packTextures = new Map();   // key -> Promise<THREE.CompressedTexture | null>
/** The KTX2 texture of a manifest entry (t.ktx2), queued like packImage's downloads. */
function packKtx2(t, texture) {
  const key = t.png + '#ktx2';
  let p = packTextures.get(key);
  if (!p) {
    const req = { url: PACK + t.ktx2, resolve: null, textures: new Set() };
    packRequests.set(key, req);
    p = new Promise((resolve) => { req.resolve = resolve; packQueue.push(req); packNext(); })
      .then((blob) => blob && blob.arrayBuffer())
      .then((buf) => buf && new Promise((resolve) => ktx2.parse(buf, resolve, () => resolve(null))))
      .catch(() => null);
    packTextures.set(key, p);
  }
  packRequests.get(key).textures.add(texture.source);
  return p;
}
/** Swap a KTX2 texture's compressed mip chain into a texture in place (clones share its source). */
function swapInCompressed(texture, k) {
  const source = texture.source;
  if (!gameImages.has(source)) gameImages.set(source, source.data);
  keepOriginal(texture);
  source.data = k.image;
  texture.dispose();
  texture.isCompressedTexture = true;
  texture.mipmaps = k.mipmaps;
  texture.format = k.format;
  texture.type = k.type;
  texture.minFilter = k.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
}
/**
 * The pack's image for an extracted picture ('sprites/SPRADV/0000.png'), stored the same way
 * up as the PNG, or null (no pack or no match). Where the pack's has no alpha but `original`
 * has (the JPEG colour head shots, SPRCOMM 94-97), it is cut by original's alpha, scaled up.
 */
export async function hiresImage(png, original) {
  const t = HIRES ? (await packManifest()).get(png) : null;
  const img = t ? await packImage(t) : null;
  if (!img || textureAlpha({ image: original }) === 'solid' || textureAlpha({ image: img }) !== 'solid') return img;
  return cutByAlpha(img, original);
}

/**
 * The pack's image cut by the game's texture's alpha, scaled up smoothly (its own alpha, if
 * any, kept too: the shop signs, logos and lamps on see-through quads, the palm crowns), or
 * null when it can't be drawn.
 * Both are stored the same way up (packImage decodes flipped, the extracted PNGs are upside down).
 */
function cutByAlpha(img, original) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(original, 0, 0, img.width, img.height);
  return canvas.transferToImageBitmap();
}

/** The URL of the pack's image (upright) for an extracted picture, or null. */
export async function hiresLink(png) {
  const t = HIRES ? (await packManifest()).get(png) : null;
  return t ? PACK + packSource(t, HIRES)[0] : null;
}

/**
 * The pack's image for a model texture's source, cut by the game's alpha where the game's
 * texture is see-through, whatever the pack's: its JPEGs (the shop signs) have none, and some
 * of its PNGs' is wrong (TEXDC1/0019, the palm crowns: a fully opaque band of fronds where
 * the game cuts out the leaves - drawn as filled triangles). Null when the pack has none.
 */
function packedImage(t, texture) {
  return packImage(t, texture).then((img) => {
    if (!img) return null;
    const game = { image: gameImage(texture.source) };
    const before = textureAlpha(game);
    if (before !== 'solid') img = cutByAlpha(img, game.image);
    if (img) textureAlphas.set(img, before);  // drawn as the game's texture is (see Draw order)
    return img;
  });
}

/** Each of a glTF's textures (its json's order) with the pack's manifest entry for its image, [[texture, entry]] (unmatched ones left out). */
function packEntriesOf(json, textures, entries) {
  return textures.map((texture, i) => {
    const def = json.textures[i];
    const t = entries.get(packKey(def && json.images[def.source].uri));
    return texture && t ? [texture, t] : null;
  }).filter(Boolean);
}

async function useTexturePack(gltf) {
  const { parser } = gltf;
  const entries = await packManifest();
  if (!models.includes(gltf)) return;   // let go (releaseGltf) meanwhile: batched, its textures draw no more
  const keyed = packEntriesOf(parser.json, await parser.getDependencies('texture'), entries);
  if (!models.includes(gltf)) return;
  const swapped = new Map();  // Source -> Promise<image | null>
  for (const [texture, t] of keyed) {
    const source = texture.source;
    if (t.ktx2 && ktx2) {
      packKtx2(t, texture).then((k) => {
        if (!k || !HIRES || !models.includes(gltf)) return;
        textureAlphas.set(k.image, textureAlpha({ image: gameImage(source) }));   // drawn as the game's texture is
        swapInCompressed(texture, k);
      });
      continue;
    }
    if (!swapped.has(source)) swapped.set(source, packedImage(t, texture));
    swapped.get(source).then((img) => { if (img && HIRES && models.includes(gltf)) swapIn(texture, img); });
  }
  // The traffic cars' paints (tools/extract_vehicles.py): a body texture baked with the
  // PowerVR decal-alpha rule over the paint colour and embedded, so it has no URI to
  // match. Its material's extras name the TEXDC texture and the colour: bake the pack's
  // image the same way.
  const materials = await parser.getDependencies('material');
  const baked = new Map();      // `${png}@${colour}` -> Promise<canvas | null>
  for (const m of materials) {
    const x = m && m.userData, colour = x && x.decal_alpha_colour;
    if (!colour || !m.map) continue;
    const t = entries.get(`textures/${String(x.texture_bank).replace('.BIN', '')}/${String(x.texture).padStart(4, '0')}.png`);
    if (!t) continue;
    const id = `${t.png}@${colour.join(',')}`;
    const texture = m.map;
    const image = packImage(t, texture);
    if (!baked.has(id)) baked.set(id, image.then((img) => img && decalAlpha(img, colour)));
    baked.get(id).then((img) => {
      if (!img || !HIRES || texture.source.data === img) return;
      textureAlphas.set(img, textureAlpha({ image: gameImage(texture.source) }));   // alpha = the paint's: unchanged
      swapIn(texture, img);
    });
  }
}

/**
 * The pack on the batched world (src/static-batch.js batchStatic merged the city's and the set
 * objects' meshes; their glTFs can be let go after this): atlases BATCH_SCALE times the
 * game's, the pack's pictures in the tiles, drawn while HIRES is on (built the first time, kept).
 * @param {THREE.Group} batched batchStatic's group
 * @param {object[]} gltfs the glTFs it merged (their image URIs name the pack's pictures)
 */
export function packBatched(batched, gltfs, renderer) {
  const deps = gltfs.map((g) => [g.parser.json, g.parser.getDependencies('texture')]);   // now: the glTFs may be let go next
  const keyed = packManifest().then((entries) => Promise.all(deps.map(([json, textures]) => textures.then((ts) => packEntriesOf(json, ts, entries)))))
    .then((lists) => new Map(lists.flat().map(([texture, t]) => [texture.source, [texture, t]])));
  batchedPack = { batched, renderer, keyed, atlases: null, shown: false };
  if (HIRES) showBatchedPack();
}

// A 64 x 64 game texture at 4 x 4 is the pack at 256 (its 512 would be a 16384 atlas: 1 GB).
const BATCH_SCALE = 4;

function showBatchedPack() {
  const p = batchedPack;
  if (!p.atlases) {
    const { batch } = p.batched;
    const scale = Math.min(BATCH_SCALE, p.renderer.capabilities.maxTextureSize / batch.atlasSize, Math.max(1, 2 ** Math.floor(Math.log2(PACK_CAP / 128))));
    p.atlases = p.keyed.then((keyed) => (HIRES ? scaledAtlases(p.renderer, batch, scale, (source) => {
      const k = keyed.get(source);
      return k ? packedImage(k[1], k[0]) : Promise.resolve(null);
    }) : null));
  }
  p.atlases.then((atlases) => {
    if (!atlases) { p.atlases = null; return; }   // turned off before they were begun: next time
    if (HIRES && batchedPack === p && !p.shown) { swapAtlases(p.batched, atlases); p.shown = true; }
  });
}

/** A texture baked the PowerVR decal-alpha way: RGB = texture RGB * A + colour RGB * (1 - A), A = colour A. */
function decalAlpha(img, colour) {
  const w = img.width, h = img.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' && w && h ? new OffscreenCanvas(w, h) : null;
  const ctx = canvas && canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data, level = colour.map((c) => Math.min(255, Math.max(0, Math.round(255 * c))));
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    for (let n = 0; n < 3; n++) d[i + n] = Math.round((d[i + n] * a + level[n] * (255 - a)) / 255);
    d[i + 3] = level[3];
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// Draw order. The Dreamcast sorts its translucent polygons per pixel, and most of the
// game's models (every traffic car, many set objects) sit in the translucent list, so
// they show the right way round whatever order they are sent in. three.js draws a
// glTF BLEND material without writing depth, sorted only per object: a far-side wheel
// drawn after the body shows through it, a bush through a tree. Per-pixel sorting
// gives the same picture as the depth buffer wherever a texel is solid (alpha 1) and
// shows nothing where it is empty (alpha 0), so a BLEND material is drawn by what its
// texels hold (tools/draw-order-check.mjs plays the game headlessly and finds the
// pixels that still come out wrong):
//   solid (the material, its texture and its vertex colours all alpha 1): opaque;
//   mask (the texture's alpha only 0 or 1): opaque with alpha test 0.5;
//   partial (real see-through texels): twice - its solid texels opaque (alpha test
//     0.998, writing depth), then the whole material blended over the scene as before
//     (a child mesh "<name>#blend"; its solid texels repeat the same colour).
const ALPHA_SOLID = 0.998;
const textureAlphas = new WeakMap();
const blendOf = new WeakMap();      // unlit opaque-pass material -> its blended pass

/** 'solid', 'mask' or 'partial': the alpha values a texture's image holds. */
function textureAlpha(texture) {
  const img = texture && texture.image;
  if (!img) return 'solid';
  let kind = textureAlphas.get(img);
  if (kind) return kind;
  kind = 'partial';     // unreadable: draw it both ways
  const w = img.width, h = img.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : null;
  const ctx = canvas && w && h ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  if (ctx) {
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let zero = false, mid = false;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) zero = true;
      else if (d[i] !== 255) { mid = true; break; }
    }
    kind = mid ? 'partial' : zero ? 'mask' : 'solid';
  }
  textureAlphas.set(img, kind);
  return kind;
}

/** True when a geometry's vertex colours carry alpha below 1. */
function vertexAlpha(geometry) {
  const c = geometry.attributes.color;
  if (!c || c.itemSize < 4) return false;
  for (let i = 0; i < c.count; i++) if (c.getW(i) < ALPHA_SOLID) return true;
  return false;
}

/** How a material's texels are drawn (see the header of this section). */
function alphaKind(m, vertexAlphaBelowOne) {
  if (!m.transparent) return 'opaque';
  if (m.opacity < 1 || vertexAlphaBelowOne) return 'partial';
  return textureAlpha(m.map);
}

/** An unlit copy of a glTF material (the game has no real-time lighting on the city). */
export function toUnlit(m, vertexColors, cache, vertexAlphaBelowOne = false) {
  const key = `${vertexColors}:${vertexAlphaBelowOne}`;
  let byKey = cache && cache.get(m);
  let u = byKey && byKey[key];
  if (!u) {
    const kind = alphaKind(m, vertexAlphaBelowOne);
    const make = (blended) => {
      const x = new THREE.MeshBasicMaterial({
        map: m.map || null,
        color: m.color,
        vertexColors,
        transparent: blended,
        alphaTest: blended ? m.alphaTest : kind === 'mask' ? 0.5 : kind === 'partial' ? ALPHA_SOLID : m.alphaTest,
        opacity: m.opacity,
        side: m.side,
        depthWrite: blended || kind === 'opaque' ? m.depthWrite : true,
      });
      x.name = m.name;
      return x;
    };
    u = make(false);
    if (kind === 'partial') blendOf.set(u, make(true));
    if (cache) { if (!byKey) cache.set(m, byKey = {}); byKey[key] = u; }
  }
  return u;
}

/** The blended pass of an unlit material drawn twice (kind 'partial'), else null. */
export function blendPass(u) {
  return blendOf.get(u) || null;
}

/** Replace the PBR materials with unlit ones (and add the blended passes: see above). */
export function makeUnlit(root, cache = new Map()) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const vc = !!o.geometry.attributes.color;
    const va = vc && vertexAlpha(o.geometry);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => toUnlit(m, vc, cache, va));
    o.material = Array.isArray(o.material) ? out : out[0];
    const blends = out.map(blendPass);
    if (blends.some(Boolean)) {
      const b = new THREE.Mesh(o.geometry, Array.isArray(o.material) ? blends.map((x, i) => x || out[i]) : blends[0]);
      b.name = `${o.name}#blend`;
      b.renderOrder = o.renderOrder;
      o.add(b);
    }
  }
  return root;
}

/**
 * The game's camera on a three.js camera. The Dreamcast draws a 4:3 picture whose field of
 * view (camUpdate's perspective, 60 degrees in the chase camera) spans the width; the view
 * matrix camUpdate stores is three.js's matrixWorldInverse (column major, looking down -z).
 * The vertical view is the 4:3 picture's whatever the camera's aspect (main.js: the
 * window's); a wider window sees more to the sides (the game's culling follows it:
 * DreamcastCar.aspect).
 */
export const ASPECT = 4 / 3;

export class GameCamera {
  constructor(camera) {
    this.camera = camera;
    this._inverse = new THREE.Matrix4();
    this._fov = 0;
  }

  /** @param {{view: Float32Array, fov: number}} cam DreamcastCar.camera() */
  apply(cam) {
    const v = cam.view;
    // The first frame of the start camera has eye == target: no matrix yet - keep the last one.
    if (v[15] !== 1 || (v[0] === 0 && v[1] === 0 && v[2] === 0)) return;
    this._inverse.fromArray(v).invert();
    this._inverse.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    if (cam.fov !== this._fov) {
      this._fov = cam.fov;
      // The horizontal angle across 4:3 -> three.js's vertical one.
      this.camera.fov = Math.atan(Math.tan(cam.fov * Math.PI / 360) / ASPECT) * 360 / Math.PI;
      this.camera.updateProjectionMatrix();
    }
  }
}

/**
 * The device pixel ratio to draw a w x h window at: the screen's up to 2, and at most
 * MAX_PIXELS on the canvas (1920 x 1440, three times the Dreamcast's 640 x 480; 2560 x 1920 is where the
 * M4 holds 60 fps). A full 5K screen would be four times that in frame buffers (~500 MB
 * with the multisampling) for a picture the Dreamcast drew at 640 x 480.
 */
export const MAX_PIXELS = 1920 * 1440;
export function pixelRatio(w, h, dpr) {
  return Math.min(dpr, 2, Math.sqrt(MAX_PIXELS / (w * h)));
}

/** The largest 4:3 picture inside w x h: { x, y, width, height } (black bars around it). */
export function letterbox(w, h) {
  const width = Math.min(w, Math.floor(h * ASPECT)), height = Math.min(h, Math.floor(w / ASPECT));
  return { x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height };
}
