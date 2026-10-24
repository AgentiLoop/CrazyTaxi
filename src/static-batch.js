// The static world in a few draw calls. The city (BINCn) is 11,600 meshes over 1,500
// materials and the set objects (OBJDCn) 2,200 more: three.js spends ~10 us of JavaScript
// on every one it draws, and 3,000 of them in view (the frustum culls the rest) is 30 ms a
// frame - 40 fps, not the game's 60. The triangles themselves (250,000 in all) are nothing.
//
// So, once, after loading:
//   - every texture of the world (334 in the Arcade city, 64 x 64 for the most part) is
//     packed into one 2048 x 2048 atlas (more if they don't fit), each tile ringed by one
//     texel of its own wrapped edge so bilinear filtering across a repeat is right;
//   - every mesh is merged with the others of its cell (CELL units square) that are drawn
//     the same way (alpha test, blending, depth write, side), the material colour folded
//     into a vertex colour, the texture's place in the atlas and its wrap modes
//     (repeat / clamp / mirror per axis) carried per vertex;
//   - one MeshBasicMaterial per (atlas, way of drawing) samples the atlas in a shader that
//     applies the wrap inside the tile.
// The picture is the same (unlit texture x colour, the draw-order kinds of src/scene.js
// kept); the world draws in ~100 calls instead of ~3,000. ?batch=0 turns it off (the
// draw-order tool reads the meshes by name). The hi-res pack (?hires=1, or H) draws the
// same batches from atlases SCALE times the size, the same layout with the pack's pictures in
// the tiles (scaledAtlases; src/scene.js packBatched builds them and swaps them in).
import * as THREE from 'three';

export const ATLAS_SIZE = 2048;
export const PAD = 1;
export const CELL = 4000;

/** 0 repeat, 1 clamp, 2 mirror (what the shader applies inside a tile). */
export function wrapCode(mode) {
  return mode === THREE.ClampToEdgeWrapping ? 1 : mode === THREE.MirroredRepeatWrapping ? 2 : 0;
}

/**
 * Shelf-pack tiles ({ id, width, height }) with PAD texels around each into atlases of
 * `size` texels: [{ id, atlas, x, y, width, height }] (x, y of the picture itself, not
 * its ring). Tallest first; a new shelf when the row is full, a new atlas when the
 * shelves are.
 */
export function packTiles(tiles, size = ATLAS_SIZE) {
  const order = tiles.slice().sort((a, b) => b.height - a.height || b.width - a.width);
  const placed = [];
  let atlas = 0, shelfY = 0, shelfH = 0, x = 0;
  for (const t of order) {
    const w = t.width + 2 * PAD, h = t.height + 2 * PAD;
    if (w > size || h > size) throw new Error(`static-batch: ${t.width}x${t.height} texture is larger than the atlas`);
    if (x + w > size) { x = 0; shelfY += shelfH; shelfH = 0; }
    if (shelfY + h > size) { atlas++; shelfY = 0; shelfH = 0; x = 0; }
    placed.push({ id: t.id, atlas, x: x + PAD, y: shelfY + PAD, width: t.width, height: t.height });
    x += w;
    shelfH = Math.max(shelfH, h);
  }
  return placed;
}

/** The meshes under `roots` that can be batched: single material, no texture transform. */
function collect(roots) {
  const meshes = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material) || !o.geometry.attributes.position) return;
      let vis = o.visible, p = o.parent;
      while (vis && p) { vis = p.visible; p = p.parent; }
      if (!vis) return;
      const map = o.material.map;
      if (map && (map.offset.x || map.offset.y || map.repeat.x !== 1 || map.repeat.y !== 1 || map.rotation)) return;
      meshes.push(o);
    });
  }
  return meshes;
}

/** The way a material draws (everything but its texture and colour, which the batch carries itself). */
function drawKey(m) {
  return [m.alphaTest, m.side, m.transparent ? 1 : 0, m.opacity, m.depthWrite ? 1 : 0, m.depthTest ? 1 : 0, m.blending, m.polygonOffset ? m.polygonOffsetFactor : 0].join('|');
}

const ATLAS_VERTEX = /* glsl */`
attribute vec4 tile;
attribute vec2 wrap;
varying vec4 vTile;
varying vec2 vWrap;
`;
const ATLAS_FRAGMENT = /* glsl */`
varying vec4 vTile;
varying vec2 vWrap;
uniform vec2 atlasSize;
uniform float atlasScale;
`;
// Replaces <map_fragment>: the uv wrapped inside the tile (repeat: the ring of wrapped
// texels makes the filtering right across the seam; clamp and mirror: kept half a texel
// inside, as the hardware clamps), then the atlas. The texture's level of detail comes from
// the unwrapped uv (the wrap's jumps would pick the smallest level along every seam) and is
// held to where the ring is still a texel wide (the mipmapped hi-res atlases: PAD texels of
// the layout, PAD x atlasScale of the picture); the clamp's half texel is that level's.
// Where a pixel covers more texels than that level filters (roads into the distance: the
// moire), it is supersampled - up to ATLAS_SUPERSAMPLE x ATLAS_SUPERSAMPLE taps across the
// pixel's footprint, each wrapped inside the tile, so the average never bleeds into a neighbour.
export const ATLAS_SUPERSAMPLE = 6;
const ATLAS_MAP = /* glsl */`
#ifdef USE_MAP
  vec2 u = vMapUv;
  vec2 scaled = u * vTile.zw / atlasSize;
  vec2 ddx = dFdx(scaled), ddy = dFdy(scaled);
  float texels = atlasSize.x / ${PAD}.0;
  int nx = int(clamp(ceil(length(ddx) * texels), 1.0, ${ATLAS_SUPERSAMPLE}.0));
  int ny = int(clamp(ceil(length(ddy) * texels), 1.0, ${ATLAS_SUPERSAMPLE}.0));
  vec2 dux = dFdx(u) / float(nx), duy = dFdy(u) / float(ny);
  ddx /= float(nx); ddy /= float(ny);
  float footprint = max(length(ddx), length(ddy)) * texels;   // layout texels a tap covers
  if (footprint > 1.0) { ddx /= footprint; ddy /= footprint; }
  vec2 inset = 0.5 * clamp(footprint, 1.0 / atlasScale, 1.0) / vTile.zw;
  vec4 sampledDiffuseColor = vec4(0.0);
  for (int j = 0; j < ny; j++) {
    for (int i = 0; i < nx; i++) {
      vec2 s = u + dux * (float(i) - 0.5 * float(nx - 1)) + duy * (float(j) - 0.5 * float(ny - 1));
      vec2 t;
      if (vWrap.x < 0.5) t.x = fract(s.x);
      else t.x = clamp(vWrap.x < 1.5 ? s.x : 1.0 - abs(fract(s.x * 0.5) * 2.0 - 1.0), inset.x, 1.0 - inset.x);
      if (vWrap.y < 0.5) t.y = fract(s.y);
      else t.y = clamp(vWrap.y < 1.5 ? s.y : 1.0 - abs(fract(s.y * 0.5) * 2.0 - 1.0), inset.y, 1.0 - inset.y);
      sampledDiffuseColor += textureGrad(map, (vTile.xy + t * vTile.zw) / atlasSize, ddx, ddy);
    }
  }
  sampledDiffuseColor /= float(nx * ny);
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/**
 * A MeshBasicMaterial drawing one atlas the way `sample` (a batched material) draws. Its
 * `atlasSize` is the layout's (ATLAS_SIZE, the tiles' texels; atlas.userData.layoutSize when
 * the picture is larger): a scaled atlas is swapped in as `map` with userData.atlasScale.value
 * = its scale.
 */
export function atlasMaterial(sample, atlas) {
  const m = new THREE.MeshBasicMaterial({
    map: atlas, vertexColors: true, color: 0xffffff,
    alphaTest: sample.alphaTest, alphaToCoverage: sample.alphaToCoverage, side: sample.side, transparent: sample.transparent, opacity: 1,
    depthWrite: sample.depthWrite, depthTest: sample.depthTest, blending: sample.blending,
    polygonOffset: sample.polygonOffset, polygonOffsetFactor: sample.polygonOffsetFactor, polygonOffsetUnits: sample.polygonOffsetUnits,
  });
  m.name = `atlas ${drawKey(sample)}`;
  const decal = sample.userData.decal === true;
  if (decal) pullDecal(m);
  if (atlas) {
    const layout = atlas.userData.layoutSize || atlas.image.width;
    m.userData.atlasScale = { value: atlas.image.width / layout };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.atlasSize = { value: new THREE.Vector2(layout, layout) };
      shader.uniforms.atlasScale = m.userData.atlasScale;
      shader.vertexShader = ATLAS_VERTEX + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vTile = tile;\n  vWrap = wrap;');
      shader.fragmentShader = ATLAS_FRAGMENT + shader.fragmentShader.replace('#include <map_fragment>', ATLAS_MAP);
      if (decal) shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', DECAL_PROJECT);
    };
    m.customProgramCacheKey = () => decal ? 'static-atlas-decal' : 'static-atlas';
  }
  return m;
}

// The see-through layers (window shadows, grime) sit ~0.1 in front of their walls; past a few
// hundred units that is under the depth buffer's step (near 3, it grows with distance squared)
// and they flicker. Each vertex is moved toward the eye along its own ray by a fraction of its
// distance: the same pixels, nearer in depth by DECAL_PULL x distance (2.5 depth steps at
// 10 000, more nearer in).
export const DECAL_PULL = 5e-4;
const DECAL_PROJECT = /* glsl */`#include <project_vertex>
  mvPosition.xyz *= ${1 - DECAL_PULL};
  gl_Position = projectionMatrix * mvPosition;`;

/** Marks a material as a see-through layer on a wall and pulls it toward the eye (DECAL_PULL). */
export function pullDecal(m) {
  m.userData.decal = true;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', DECAL_PROJECT);
  };
  m.customProgramCacheKey = () => 'decal';
}

/**
 * Merge meshes (all drawn alike, all on one atlas or all untextured) into one geometry:
 * world-space positions, uv, the tile (x, y, w, h in atlas texels) and wrap codes per vertex,
 * colour = material colour x vertex colour (alpha = opacity x vertex alpha).
 * @param {{ mesh: THREE.Mesh, tile: object | null }[]} parts
 */
export function mergeParts(parts, textured) {
  let vertexCount = 0, indexCount = 0;
  for (const { mesh } of parts) {
    const g = mesh.geometry;
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 4);
  const uv = textured ? new Float32Array(vertexCount * 2) : null;
  const tile = textured ? new Uint16Array(vertexCount * 4) : null;
  const wrap = textured ? new Uint8Array(vertexCount * 2) : null;
  const index = new Uint32Array(indexCount);
  const v = new THREE.Vector3();
  let vo = 0, io = 0;
  for (const { mesh, tile: t } of parts) {
    const g = mesh.geometry, m = mesh.material;
    const pos = g.attributes.position, col = m.vertexColors ? g.attributes.color : null, guv = g.attributes.uv;
    const n = pos.count;
    const r = m.color.r, gg = m.color.g, b = m.color.b, a = m.opacity;
    const map = m.map;
    const wx = map ? wrapCode(map.wrapS) : 0, wy = map ? wrapCode(map.wrapT) : 0;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const k = vo + i;
      position[k * 3] = v.x; position[k * 3 + 1] = v.y; position[k * 3 + 2] = v.z;
      if (col) {
        color[k * 4] = r * col.getX(i); color[k * 4 + 1] = gg * col.getY(i); color[k * 4 + 2] = b * col.getZ(i);
        color[k * 4 + 3] = a * (col.itemSize > 3 ? col.getW(i) : 1);
      } else {
        color[k * 4] = r; color[k * 4 + 1] = gg; color[k * 4 + 2] = b; color[k * 4 + 3] = a;
      }
      if (textured) {
        if (guv) { uv[k * 2] = guv.getX(i); uv[k * 2 + 1] = guv.getY(i); }
        if (t) { tile[k * 4] = t.x; tile[k * 4 + 1] = t.y; tile[k * 4 + 2] = t.width; tile[k * 4 + 3] = t.height; }
        wrap[k * 2] = wx; wrap[k * 2 + 1] = wy;
      }
    }
    if (g.index) {
      const gi = g.index;
      for (let i = 0; i < gi.count; i++) index[io + i] = vo + gi.getX(i);
      io += gi.count;
    } else {
      for (let i = 0; i < n; i++) index[io + i] = vo + i;
      io += n;
    }
    vo += n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 4));
  if (textured) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('tile', new THREE.BufferAttribute(tile, 4));
    geometry.setAttribute('wrap', new THREE.BufferAttribute(wrap, 2));
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The cell (x, z) a mesh's world bounding-box centre is in. */
function cellOf(mesh, cell) {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  return `${Math.floor(c.x / cell)},${Math.floor(c.z / cell)}`;
}

/**
 * Plan the batches of the meshes under `roots` (no renderer: testable): the atlases' tiles
 * (one per texture source) and the groups [{ key, atlas, textured, sample, parts }].
 */
export function planBatches(roots, { cell = CELL, atlasSize = ATLAS_SIZE } = {}) {
  const meshes = collect(roots);
  const sources = new Map();   // THREE.Source -> a texture of it
  for (const o of meshes) {
    const map = o.material.map;
    if (map && map.image && map.image.width && !sources.has(map.source)) sources.set(map.source, map);
  }
  const tiles = packTiles([...sources].map(([source, map]) => ({ id: source, width: map.image.width, height: map.image.height })), atlasSize);
  const tileOf = new Map(tiles.map((t) => [t.id, t]));
  const groups = new Map();
  for (const o of meshes) {
    const m = o.material;
    const t = m.map && tileOf.get(m.map.source);
    const textured = !!t;
    const key = `${textured ? t.atlas : 'plain'}|${drawKey(m)}|${o.renderOrder}|${cellOf(o, cell)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, atlas: textured ? t.atlas : -1, textured, sample: m, renderOrder: o.renderOrder, parts: [] });
    group.parts.push({ mesh: o, tile: t || null });
  }
  return { meshes, tiles, groups: [...groups.values()], atlasCount: tiles.length ? Math.max(...tiles.map((t) => t.atlas)) + 1 : 0 };
}

/** An empty atlas of `size` texels on the GPU (a layout of `layoutSize`; mipmapped if asked). */
function newAtlas(renderer, size, layoutSize, mipmapped, name) {
  // Storage only (source.dataReady false: nothing to upload); the tiles are copied in.
  const tex = new THREE.DataTexture(null, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.source.dataReady = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.generateMipmaps = mipmapped;   // allocates the levels; generated once the tiles are in (mipmapAtlas)
  tex.minFilter = mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = mipmapped ? 4 : 1;
  tex.needsUpdate = true;
  tex.name = name;
  tex.userData.layoutSize = layoutSize;
  renderer.initTexture(tex);
  tex.generateMipmaps = false;   // not after every copy
  return tex;
}

/** Generate a filled atlas's mipmaps. */
function mipmapAtlas(renderer, tex) {
  const gl = renderer.getContext();
  renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(tex).__webglTexture);
  gl.generateMipmap(gl.TEXTURE_2D);
  tex.generateMipmaps = true;
}

const _box = new THREE.Box2(), _at = new THREE.Vector2();

/**
 * Copy a tile's picture (`src`, a texture of tile.width x tile.height x scale) and its ring of
 * wrapped edges (PAD x scale texels: the opposite edges, what a repeat shows next; the
 * corners from the opposite corners) into its place in `dst`, scaled.
 */
function copyTile(renderer, src, dst, t, scale) {
  const copy = (x0, y0, x1, y1, dx, dy) => {
    _box.min.set(x0, y0); _box.max.set(x1, y1); _at.set(dx, dy);
    renderer.copyTextureToTexture(src, dst, _box, _at);
  };
  const w = t.width * scale, h = t.height * scale, x = t.x * scale, y = t.y * scale, p = PAD * scale;
  copy(0, 0, w, h, x, y);
  copy(w - p, 0, w, h, x - p, y);
  copy(0, 0, p, h, x + w, y);
  copy(0, h - p, w, h, x, y - p);
  copy(0, 0, w, p, x, y + h);
  copy(w - p, h - p, w, h, x - p, y - p);
  copy(0, h - p, p, h, x + w, y - p);
  copy(w - p, 0, w, p, x - p, y + h);
  copy(0, 0, p, p, x + w, y + h);
}

// A compressed texture (the release's KTX2s) can't be copied into an RGBA atlas: it is drawn
// into a render target first, texel for texel (texelFetch: scaled up by repeating texels, as
// 'pixelated') or filtered (a larger picture drawn smaller, from its mipmaps). The target has
// the texture's colour space, so the GPU's sRGB decode on reading and encode on writing cancel.
const _decode = new THREE.Mesh(
  new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { map: { value: null }, size: { value: new THREE.Vector2() }, nearest: { value: true } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D map;
uniform vec2 size;
uniform bool nearest;
layout(location = 0) out highp vec4 colour;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  colour = nearest ? texelFetch(map, ivec2(uv * vec2(textureSize(map, 0))), 0) : texture(map, uv);
}`,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  }));
_decode.frustumCulled = false;
const _decodeCamera = new THREE.Camera();

/** `src` drawn into a new w x h render target (dispose it after use). */
function decoded(renderer, src, w, h, nearest) {
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, colorSpace: src.colorSpace });
  const { uniforms } = _decode.material;
  uniforms.map.value = src;
  uniforms.size.value.set(w, h);
  uniforms.nearest.value = nearest;
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(_decode, _decodeCamera);
  renderer.setRenderTarget(before);
  uniforms.map.value = null;
  src.dispose();   // its GPU copy: the atlas holds the texels now
  return rt;
}

/** copyTile from a texture of any kind: a compressed one drawn at the tile's size x scale first. */
function copyAnyTile(renderer, src, dst, t, scale, nearest) {
  if (!src.isCompressedTexture) { copyTile(renderer, src, dst, t, scale); return; }
  const rt = decoded(renderer, src, t.width * scale, t.height * scale, nearest);
  copyTile(renderer, rt.texture, dst, t, scale);
  rt.dispose();
}

/**
 * Fill the atlases on the GPU: each tile's picture and its one-texel ring of wrapped edges,
 * copied from the glTF textures' images (exact: no canvas, so no premultiplied alpha).
 */
function buildAtlases(renderer, tiles, sources, atlasCount, atlasSize) {
  const atlases = [];
  for (let i = 0; i < atlasCount; i++) atlases.push(newAtlas(renderer, atlasSize, atlasSize, false, `static atlas ${i}`));
  for (const t of tiles) copyAnyTile(renderer, sources.get(t.id), atlases[t.atlas], t, 1, true);
  return atlases;
}

/**
 * The atlases of a batched world (batchStatic's group.batch) again at `scale` times the size,
 * the same layout (the meshes' tiles and the materials' atlasSize stay in the layout's
 * texels): each tile `imageOf(source)` - a Promise of a picture of any size (the hi-res
 * pack's; or a compressed texture, the release's KTX2), drawn at the tile's - or, for null,
 * the game's own texture scaled up. Mipmapped (the shader holds the level of detail within
 * the ring). Resolves to the atlases; swap them in with swapAtlases.
 */
export async function scaledAtlases(renderer, batch, scale, imageOf) {
  const { tiles, sources, atlasCount, atlasSize } = batch;
  const atlases = [];
  for (let i = 0; i < atlasCount; i++) atlases.push(newAtlas(renderer, atlasSize * scale, atlasSize, true, `static atlas ${i} x${scale}`));
  const images = tiles.map((t) => imageOf(t.id));   // all asked for at once: the pack's queue orders them
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i], pack = await images[i], game = sources.get(t.id);
    if (pack ? pack.isCompressedTexture : game.isCompressedTexture) {
      copyAnyTile(renderer, pack || game, atlases[t.atlas], t, scale, !pack);
      continue;
    }
    const bitmap = await createImageBitmap(pack || game.image, {
      resizeWidth: t.width * scale, resizeHeight: t.height * scale, resizeQuality: pack ? 'high' : 'pixelated',
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    const src = new THREE.Texture(bitmap);
    src.flipY = false;
    src.premultiplyAlpha = false;
    src.colorSpace = THREE.SRGBColorSpace;
    copyTile(renderer, src, atlases[t.atlas], t, scale);
    src.dispose();
    bitmap.close();
  }
  for (const tex of atlases) mipmapAtlas(renderer, tex);
  return atlases;
}

/** Draw a batched world (batchStatic's group) from `atlases` (its own, or scaledAtlases'). */
export function swapAtlases(batched, atlases) {
  const { materials } = batched.batch;
  for (const [index, material] of materials) {
    if (index < 0) continue;
    const atlas = atlases[index];
    material.map = atlas;
    material.userData.atlasScale.value = atlas.image.width / (atlas.userData.layoutSize || atlas.image.width);
    batched.userData.atlasScale = material.userData.atlasScale.value;   // the probe reads it
  }
}

/**
 * Replace the meshes under `roots` with the batched ones (a Group "static" added to
 * `scene`); the emptied roots leave the scene. Returns the group ({ atlases, meshes:
 * batched count, from: original count } in userData; the layout for scaledAtlases -
 * { tiles, sources, atlasCount, atlasSize, atlases, materials: [[atlas index, material]] } -
 * as .batch).
 */
export function batchStatic(scene, roots, renderer, options = {}) {
  const cellSize = options.cell || CELL, atlasSize = options.atlasSize || ATLAS_SIZE;
  const { meshes, tiles, groups, atlasCount } = planBatches(roots, { cell: cellSize, atlasSize });
  const sources = new Map();
  for (const o of meshes) if (o.material.map) sources.set(o.material.map.source, o.material.map);
  const atlases = buildAtlases(renderer, tiles, sources, atlasCount, atlasSize);
  const materials = new Map();
  const out = new THREE.Group();
  out.name = 'static';
  for (const g of groups) {
    const mk = `${g.atlas}|${drawKey(g.sample)}`;
    let material = materials.get(mk);
    if (!material) materials.set(mk, material = atlasMaterial(g.sample, g.atlas >= 0 ? atlases[g.atlas] : null));
    const mesh = new THREE.Mesh(mergeParts(g.parts, g.textured), material);
    mesh.name = `static ${g.key}`;
    mesh.renderOrder = g.renderOrder;
    out.add(mesh);
  }
  for (const o of meshes) {
    o.removeFromParent();
    o.geometry.dispose();   // never uploaded; this and the parser's caches (scene.js releaseGltf) free the arrays
  }
  // Prune what is left empty; a root with nothing left leaves the scene.
  const prune = (node) => {
    for (const c of node.children.slice()) prune(c);
    if (!node.isMesh && node.children.length === 0 && node.parent) node.removeFromParent();
  };
  for (const root of roots) prune(root);
  out.userData = { atlases: atlases.length, tiles: tiles.length, meshes: out.children.length, from: meshes.length };
  out.batch = { tiles, sources, atlasCount, atlasSize, atlases, materials: [...materials].map(([k, m]) => [parseInt(k, 10), m]) };
  scene.add(out);
  return out;
}