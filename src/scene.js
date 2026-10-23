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
  return new Promise((resolve, reject) => loader.load(url, resolve, onProgress, reject));
}

/** An unlit copy of a glTF material (the game has no real-time lighting on the city). */
export function toUnlit(m, vertexColors, cache) {
  let u = cache && cache.get(m);
  if (!u) {
    u = new THREE.MeshBasicMaterial({
      map: m.map || null,
      color: m.color,
      vertexColors,
      transparent: m.transparent,
      alphaTest: m.alphaTest,
      opacity: m.opacity,
      side: m.side,
      depthWrite: m.depthWrite,
    });
    u.name = m.name;
    if (cache) cache.set(m, u);
  }
  return u;
}

/** Replace the PBR materials with unlit ones. */
export function makeUnlit(root, cache = new Map()) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const vc = !!o.geometry.attributes.color;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => toUnlit(m, vc, cache));
    o.material = Array.isArray(o.material) ? out : out[0];
  });
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
