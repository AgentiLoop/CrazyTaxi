// Opaque overlays. The city lays some details flat on a larger face of another material:
// the building shadows on the concrete beside Pizza Hut (TEXDC1 119 on 163) are triangles
// in the very plane of the pavement. The PowerVR draws them after the pavement and keeps
// them; here the two interpolate a slightly different depth per pixel and fight, so the
// shadows crawl as the camera moves. Each such triangle (all of it on coplanar faces of
// another material, each larger than itself) moves into a mesh of its own whose material
// is pulled toward the eye like the see-through layers (static-batch.js pullDecal).
import * as THREE from 'three';
import { pullDecal } from './static-batch.js';

const PLANE = 0.05;      // units off the base's plane still "on" it
const PARALLEL = 0.999;  // normals' dot
const CELL = 64;

/** A triangle's corners in world space, its unit normal, plane offset and area. */
function triangles(mesh) {
  const g = mesh.geometry, pos = g.attributes.position, index = g.index;
  const n = index ? index.count : pos.count;
  const out = [];
  for (let i = 0; i + 2 < n; i += 3) {
    const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(mesh.matrixWorld));
    const cross = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
    const len = cross.length();
    if (len < 1e-6) { out.push(null); continue; }
    const normal = cross.divideScalar(len);
    out.push({ mesh, i, v, normal, d: normal.dot(v[0]), area: len / 2 });
  }
  return out;
}

const _t = new THREE.Triangle(), _b = new THREE.Vector3();

/** True when p (on t's plane) lies inside triangle t. */
function inside(t, p) {
  _t.set(t.v[0], t.v[1], t.v[2]).getBarycoord(p, _b);
  return _b.x >= -1e-4 && _b.y >= -1e-4 && _b.z >= -1e-4;
}

/**
 * Split the opaque overlay triangles of the meshes under `root` (after makeUnlit) into child
 * meshes drawn pulled toward the eye. Returns how many triangles moved.
 */
export function pullOverlays(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && !Array.isArray(o.material) && !o.material.transparent && !o.material.userData.decal && o.geometry.attributes.position) meshes.push(o);
  });
  const all = [];
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const mesh of meshes) {
    for (const t of triangles(mesh)) {
      if (!t) continue;
      all.push(t);
      const box = new THREE.Box3().setFromPoints(t.v);
      for (let x = Math.floor(box.min.x / CELL); x <= Math.floor(box.max.x / CELL); x++)
        for (let y = Math.floor(box.min.y / CELL); y <= Math.floor(box.max.y / CELL); y++)
          for (let z = Math.floor(box.min.z / CELL); z <= Math.floor(box.max.z / CELL); z++) {
            const k = key(x, y, z);
            let cell = grid.get(k);
            if (!cell) grid.set(k, cell = []);
            cell.push(t);
          }
    }
  }
  const covered = (t, p) => {
    const cell = grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    if (!cell) return false;
    for (const u of cell) {
      if (u.mesh.material === t.mesh.material || u.area <= t.area) continue;
      if (u.normal.dot(t.normal) < PARALLEL || Math.abs(u.normal.dot(p) - u.d) > PLANE) continue;
      if (inside(u, p)) return true;
    }
    return false;
  };
  const overlays = new Map();   // mesh -> first indices of its overlay triangles
  const c = new THREE.Vector3(), p = new THREE.Vector3();
  for (const t of all) {
    c.copy(t.v[0]).add(t.v[1]).add(t.v[2]).divideScalar(3);
    if (!covered(t, c)) continue;
    // the corners, a little in (a shared edge of two bases is on both)
    if (!t.v.every((v) => covered(t, p.copy(v).lerp(c, 0.05)))) continue;
    let list = overlays.get(t.mesh);
    if (!list) overlays.set(t.mesh, list = []);
    list.push(t.i);
  }
  const pulled = new Map();
  let moved = 0;
  for (const [mesh, list] of overlays) {
    const g = mesh.geometry, n = g.index ? g.index.count : g.attributes.position.count;
    const take = new Set(list);
    const keep = [], over = [];
    for (let i = 0; i + 2 < n; i += 3) {
      const tri = [0, 1, 2].map((k) => (g.index ? g.index.getX(i + k) : i + k));
      (take.has(i) ? over : keep).push(...tri);
    }
    const base = g.clone();
    base.setIndex(keep);
    const top = g.clone();
    top.setIndex(over);
    mesh.geometry = base;   // a clone: a geometry shared by other instances is left whole
    let m = pulled.get(mesh.material);
    if (!m) {
      m = mesh.material.clone();
      m.polygonOffset = true;   // its own batches (static-batch.js drawKey)
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
      pullDecal(m);
      pulled.set(mesh.material, m);
    }
    const o = new THREE.Mesh(top, m);
    o.name = `${mesh.name}#overlay`;
    o.renderOrder = mesh.renderOrder;
    mesh.add(o);
    moved += over.length / 3;
  }
  return moved;
}
