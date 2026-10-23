// Scene building: the extracted glTF files drawn the way the Dreamcast draws
// them - unlit, texture times vertex colour - and the chase camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    .then((gltf) => { if (HIRES) useTexturePack(gltf); return gltf; });
}

// The hi-res texture pack (?hires=1). A Flycast custom texture pack (MK-51035), mapped
// onto the extracted textures by tools/match_texture_pack.py (local-assets/texture_pack/:
// manifest.json + one link per matched texture), replaces a model's TEXDC textures once
// it has loaded: the model shows at once with the game's textures, the pack's swap in
// as they decode. The pack's images are upright, the extracted PNGs (and so the models'
// UVs) upside down: decoded flipped. They are 4-32 times the game's size, ~1.7 GB of
// texels for a city at full size, so they are scaled to at most 512 texels a side
// (?hires=N: at most N) and drawn mipmapped. A texture with see-through texels keeps the
// game's image when the pack's has none (most of the pack is JPEG). The menu's sprites
// (src/menu-view.js) and the HUD's destination pictures (src/hud.js) use it too.
const PACK = 'local-assets/texture_pack/';

/** The longest side a pack image is drawn at for a page's query string (0 = no pack). */
export function hiresCap(search) {
  const v = new URLSearchParams(search).get('hires');
  if (v === null || v === '0') return 0;
  const n = parseInt(v, 10);
  return n >= 2 ? n : 512;
}
export const HIRES = typeof location !== 'undefined' ? hiresCap(location.search) : 0;

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

let packEntries = null;      // Promise<Map<key, manifest entry>>
const packImages = new Map(); // key -> Promise<ImageBitmap | null>

function packManifest() {
  return packEntries || (packEntries = fetch(PACK + 'manifest.json')
    .then((r) => (r.ok ? r.json() : { textures: [] }))
    .then((m) => new Map(m.textures.filter((t) => t.link).map((t) => [t.png, t])))
    .catch(() => new Map()));
}

function packImage(t) {
  let p = packImages.get(t.png);
  if (!p) {
    const [w, h] = fitSize(t.pack_width, t.pack_height, HIRES);
    p = fetch(PACK + t.link)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => blob && createImageBitmap(blob, {
        imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
        resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
      }))
      .catch(() => null);
    packImages.set(t.png, p);
  }
  return p;
}

/**
 * The pack's image for an extracted picture ('sprites/SPRADV/0000.png'), stored the same way
 * up as the PNG, or null (no pack, no match, or the pack's has no alpha where `original` has).
 */
export async function hiresImage(png, original) {
  const t = HIRES ? (await packManifest()).get(png) : null;
  const img = t ? await packImage(t) : null;
  if (!img || (textureAlpha({ image: original }) !== 'solid' && textureAlpha({ image: img }) === 'solid')) return null;
  return img;
}

/** The URL of the pack's image (upright) for an extracted picture, or null. */
export async function hiresLink(png) {
  const t = HIRES ? (await packManifest()).get(png) : null;
  return t ? PACK + t.link : null;
}

async function useTexturePack(gltf) {
  const { parser } = gltf;
  const entries = await packManifest();
  const textures = await parser.getDependencies('texture');
  const swapped = new Map();  // Source -> Promise<boolean>
  textures.forEach((texture, i) => {
    const def = parser.json.textures[i];
    const t = entries.get(packKey(def && parser.json.images[def.source].uri));
    if (!texture || !t) return;
    const source = texture.source;
    if (!swapped.has(source)) {
      swapped.set(source, packImage(t).then((img) => {
        if (!img) return false;
        const before = textureAlpha(texture);
        if (before !== 'solid' && textureAlpha({ image: img }) === 'solid') return false;
        textureAlphas.set(img, before);  // drawn as the game's texture is (see Draw order)
        source.data = img;
        return true;
      }));
    }
    swapped.get(source).then((ok) => {
      if (!ok) return;
      texture.dispose();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
    });
  });
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
 */
export const ASPECT = 4 / 3;

export class GameCamera {
  constructor(camera) {
    this.camera = camera;
    this.camera.aspect = ASPECT;
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

/** The largest 4:3 picture inside w x h: { x, y, width, height } (black bars around it). */
export function letterbox(w, h) {
  const width = Math.min(w, Math.floor(h * ASPECT)), height = Math.min(h, Math.floor(w / ASPECT));
  return { x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height };
}
