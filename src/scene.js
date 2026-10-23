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

/** The game's chase camera (placeholder values): behind and above the cab, looking a little ahead. */
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.eye = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.mode = 0;
    this._first = true;
    this._tmp = new THREE.Vector3();
  }

  update(car, dt) {
    const f = car.forward();
    const back = this.mode === 0 ? 95 : 55;
    const up = this.mode === 0 ? 38 : 22;
    const wantEye = this._tmp.set(car.pos.x - f.x * back, car.pos.y + up, car.pos.z - f.z * back);
    if (this._first) { this.eye.copy(wantEye); this._first = false; }
    else this.eye.lerp(wantEye, Math.min(1, 8 * dt));
    this.target.set(car.pos.x + f.x * 25, car.pos.y + 12, car.pos.z + f.z * 25);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.target);
  }

  /** The horizontal field of view in degrees (the game's clipping angle). */
  horizontalFov() {
    const v = this.camera.fov * Math.PI / 360;
    return Math.atan(Math.tan(v) * this.camera.aspect) * 360 / Math.PI;
  }
}
