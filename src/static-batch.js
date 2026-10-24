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
// draw-order tool reads the meshes by name); the hi-res pack (?hires=1) keeps the single
// meshes too, its textures being far too large for an atlas.
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
  return [m.alphaTest, m.side, m.transparent ? 1 : 0, m.opacity, m.depthWrite ? 1 : 0, m.depthTest ? 1 : 0, m.blending].join('|');
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
`;
// Replaces <map_fragment>: the uv wrapped inside the tile (repeat: the ring of wrapped
// texels makes the filtering right across the seam; clamp and mirror: kept half a texel
// inside, as the hardware clamps), then the atlas.
const ATLAS_MAP = /* glsl */`
#ifdef USE_MAP
  vec2 u = vMapUv;
  vec2 inset = 0.5 / vTile.zw;
  vec2 t;
  if (vWrap.x < 0.5) t.x = fract(u.x);
  else t.x = clamp(vWrap.x < 1.5 ? u.x : 1.0 - abs(fract(u.x * 0.5) * 2.0 - 1.0), inset.x, 1.0 - inset.x);
  if (vWrap.y < 0.5) t.y = fract(u.y);
  else t.y = clamp(vWrap.y < 1.5 ? u.y : 1.0 - abs(fract(u.y * 0.5) * 2.0 - 1.0), inset.y, 1.0 - inset.y);
  vec4 sampledDiffuseColor = texture2D(map, (vTile.xy + t * vTile.zw) / atlasSize);
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/** A MeshBasicMaterial drawing one atlas the way `sample` (a batched material) draws. */
export function atlasMaterial(sample, atlas) {
  const m = new THREE.MeshBasicMaterial({
    map: atlas, vertexColors: true, color: 0xffffff,
    alphaTest: sample.alphaTest, side: sample.side, transparent: sample.transparent, opacity: 1,
    depthWrite: sample.depthWrite, depthTest: sample.depthTest, blending: sample.blending,
  });
  m.name = `atlas ${drawKey(sample)}`;
  if (atlas) {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.atlasSize = { value: new THREE.Vector2(atlas.image.width, atlas.image.height) };
      shader.vertexShader = ATLAS_VERTEX + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vTile = tile;\n  vWrap = wrap;');
      shader.fragmentShader = ATLAS_FRAGMENT + shader.fragmentShader.replace('#include <map_fragment>', ATLAS_MAP);
    };
    m.customProgramCacheKey = () => 'static-atlas';
  }
  return m;
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

/**
 * Fill the atlases on the GPU: each tile's picture and its one-texel ring of wrapped edges,
 * copied from the glTF textures' images (exact: no canvas, so no premultiplied alpha).
 */
function buildAtlases(renderer, tiles, sources, atlasCount, atlasSize) {
  const atlases = [];
  for (let i = 0; i < atlasCount; i++) {
    const tex = new THREE.DataTexture(new Uint8Array(atlasSize * atlasSize * 4), atlasSize, atlasSize, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.premultiplyAlpha = false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    tex.name = `static atlas ${i}`;
    renderer.initTexture(tex);
    atlases.push(tex);
  }
  const box = new THREE.Box2(), at = new THREE.Vector2();
  const copy = (src, dst, x0, y0, x1, y1, dx, dy) => {
    box.min.set(x0, y0); box.max.set(x1, y1); at.set(dx, dy);
    renderer.copyTextureToTexture(src, dst, box, at);
  };
  for (const t of tiles) {
    const src = sources.get(t.id), dst = atlases[t.atlas];
    const w = t.width, h = t.height, x = t.x, y = t.y;
    copy(src, dst, 0, 0, w, h, x, y);
    // The ring: the opposite edges (what a repeat shows next), the corners from the opposite corners.
    copy(src, dst, w - 1, 0, w, h, x - 1, y);
    copy(src, dst, 0, 0, 1, h, x + w, y);
    copy(src, dst, 0, h - 1, w, h, x, y - 1);
    copy(src, dst, 0, 0, w, 1, x, y + h);
    copy(src, dst, w - 1, h - 1, w, h, x - 1, y - 1);
    copy(src, dst, 0, h - 1, 1, h, x + w, y - 1);
    copy(src, dst, w - 1, 0, w, 1, x - 1, y + h);
    copy(src, dst, 0, 0, 1, 1, x + w, y + h);
  }
  return atlases;
}

/**
 * Replace the meshes under `roots` with the batched ones (a Group "static" added to
 * `scene`); the emptied roots leave the scene. Returns the group ({ atlases, meshes:
 * batched count, from: original count } in userData).
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
  for (const o of meshes) o.removeFromParent();
  // Prune what is left empty; a root with nothing left leaves the scene.
  const prune = (node) => {
    for (const c of node.children.slice()) prune(c);
    if (!node.isMesh && node.children.length === 0 && node.parent) node.removeFromParent();
  };
  for (const root of roots) prune(root);
  out.userData = { atlases: atlases.length, tiles: tiles.length, meshes: out.children.length, from: meshes.length };
  scene.add(out);
  return out;
}
