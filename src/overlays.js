// Opaque overlays. The city lays some details flat on other faces: the building shadows on
// the concrete beside Pizza Hut (TEXDC1 119 on 163) are triangles in the very plane of the
// pavement, and the shadows along the sidewalks (119 on 145) are cut into the pavement with
// edges that overlap it by a sliver. The PowerVR draws them after the pavement and keeps
// them; here the two interpolate a slightly different depth per pixel and fight, so the
// shadows crawl as the camera moves. Every triangle that overlaps a coplanar face larger
// than itself (the same size: the later one) moves into a mesh of its own whose material is
// pulled toward the eye like the see-through layers (static-batch.js pullDecal), once per
// layer under it: a detail on a detail on the pavement is pulled twice.
import * as THREE from 'three';
import { pullDecal } from './static-batch.js';

const PLANE = 0.05;      // units off the other's plane still "on" it
const PARALLEL = 0.999;  // normals' dot
const OVERLAP = 0.01;    // square units shared: less is two faces meeting at an edge
const MAX_LAYER = 4;
const CELL = 64;

/** A triangle's corners in world space, its unit normal, plane offset, area and bounds. */
function triangles(mesh, out) {
  const g = mesh.geometry, pos = g.attributes.position, index = g.index;
  const n = index ? index.count : pos.count;
  for (let i = 0; i + 2 < n; i += 3) {
    const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(mesh.matrixWorld));
    const cross = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
    const len = cross.length();
    if (len < 1e-6) continue;
    const normal = cross.divideScalar(len);
    out.push({ mesh, i, v, normal, d: normal.dot(v[0]), area: len / 2, order: out.length, box: new THREE.Box3().setFromPoints(v) });
  }
}

/** The triangle's corners in 2D, dropping the axis its normal is nearest. */
function flat(t, normal) {
  const x = Math.abs(normal.x), y = Math.abs(normal.y), z = Math.abs(normal.z);
  const [a, b] = x >= y && x >= z ? ['y', 'z'] : y >= z ? ['z', 'x'] : ['x', 'y'];
  return t.v.map((p) => [p[a], p[b]]);
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** The area two convex polygons share (Sutherland-Hodgman). */
export function sharedArea(subject, clipper) {
  if (signedArea(clipper) < 0) clipper = clipper.slice().reverse();
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const [ax, ay] = clipper[i], [bx, by] = clipper[(i + 1) % clipper.length];
    const side = (p) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if ((sp >= 0) !== (sq >= 0)) {
        const k = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
      }
      if (sq >= 0) out.push(q);
    }
  }
  return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
}

/** True when t and u lie in one plane (facing the same way) and share more than OVERLAP. */
function overlap(t, u) {
  if (!t.box.intersectsBox(u.box) || t.normal.dot(u.normal) < PARALLEL) return false;
  for (const p of u.v) if (Math.abs(t.normal.dot(p) - t.d) > PLANE) return false;
  return sharedArea(flat(t, t.normal), flat(u, t.normal)) > OVERLAP;
}

/**
 * Split the opaque overlay triangles of the meshes under `root` (after makeUnlit) into child
 * meshes drawn pulled toward the eye, one per layer. Returns how many triangles moved.
 */
export function pullOverlays(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && !Array.isArray(o.material) && !o.material.transparent && !o.material.userData.decal && o.geometry.attributes.position) meshes.push(o);
  });
  const all = [];
  for (const mesh of meshes) triangles(mesh, all);
  const grid = new Map();
  for (const t of all) {
    const { min, max } = t.box;
    for (let x = Math.floor(min.x / CELL); x <= Math.floor(max.x / CELL); x++)
      for (let y = Math.floor(min.y / CELL); y <= Math.floor(max.y / CELL); y++)
        for (let z = Math.floor(min.z / CELL); z <= Math.floor(max.z / CELL); z++) {
          const k = `${x},${y},${z}`;
          let cell = grid.get(k);
          if (!cell) grid.set(k, cell = { x, y, z, list: [] });
          cell.list.push(t);
        }
  }
  // each overlapping pair once (in the cell of its bounds' common corner): the smaller (the
  // same size: the later) lies on the other
  const below = new Map();
  const at = (a, b) => Math.floor(Math.max(a, b) / CELL);
  for (const { x, y, z, list: cell } of grid.values()) {
    for (let a = 0; a < cell.length; a++) {
      for (let b = a + 1; b < cell.length; b++) {
        let t = cell[a], u = cell[b];
        if (at(t.box.min.x, u.box.min.x) !== x || at(t.box.min.y, u.box.min.y) !== y || at(t.box.min.z, u.box.min.z) !== z) continue;
        if (!overlap(t, u)) continue;
        if (u.area < t.area || (u.area === t.area && u.order > t.order)) [t, u] = [u, t];
        let list = below.get(t);
        if (!list) below.set(t, list = []);
        list.push(u);
      }
    }
  }
  const layers = new Map();
  const layerOf = (t) => {
    let l = layers.get(t);
    if (l === undefined) {
      const under = below.get(t);
      l = under ? Math.min(MAX_LAYER, 1 + Math.max(...under.map(layerOf))) : 0;
      layers.set(t, l);
    }
    return l;
  };
  const overlays = new Map();   // mesh -> first index -> layer
  for (const t of below.keys()) {
    let byIndex = overlays.get(t.mesh);
    if (!byIndex) overlays.set(t.mesh, byIndex = new Map());
    byIndex.set(t.i, layerOf(t));
  }
  const pulled = new Map();   // material -> layer -> pulled clone
  let moved = 0;
  for (const [mesh, byIndex] of overlays) {
    const g = mesh.geometry, n = g.index ? g.index.count : g.attributes.position.count;
    const parts = new Map([[0, []]]);
    for (let i = 0; i + 2 < n; i += 3) {
      const layer = byIndex.get(i) || 0;
      if (!parts.has(layer)) parts.set(layer, []);
      parts.get(layer).push(...[0, 1, 2].map((k) => (g.index ? g.index.getX(i + k) : i + k)));
    }
    const base = g.clone();
    base.setIndex(parts.get(0));
    mesh.geometry = base;   // a clone: a geometry shared by other instances is left whole
    let byLayer = pulled.get(mesh.material);
    if (!byLayer) pulled.set(mesh.material, byLayer = new Map());
    for (const [layer, index] of [...parts].filter(([l]) => l > 0).sort((a, b) => a[0] - b[0])) {
      let m = byLayer.get(layer);
      if (!m) {
        m = mesh.material.clone();
        m.polygonOffset = true;   // its own batches (static-batch.js drawKey)
        m.polygonOffsetFactor = -layer;
        m.polygonOffsetUnits = -2 * layer;
        pullDecal(m, layer);
        byLayer.set(layer, m);
      }
      const top = g.clone();
      top.setIndex(index);
      const o = new THREE.Mesh(top, m);
      o.name = `${mesh.name}#overlay${layer > 1 ? layer : ''}`;
      o.renderOrder = mesh.renderOrder;
      mesh.add(o);
      moved += index.length / 3;
    }
  }
  return moved;
}
