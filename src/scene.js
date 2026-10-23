// Scene building: the extracted glTF files drawn the way the Dreamcast draws
// them - unlit, texture times vertex colour - and the chase camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

export function loadGltf(url, onProgress) {
  return new Promise((resolve, reject) => loader.load(url, resolve, onProgress, reject));
}

/** Replace the PBR materials with unlit ones (the game has no real-time lighting on the city). */
export function makeUnlit(root) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => {
      let u = cache.get(m);
      if (!u) {
        u = new THREE.MeshBasicMaterial({
          map: m.map || null,
          color: m.color,
          vertexColors: !!o.geometry.attributes.color,
          transparent: m.transparent,
          alphaTest: m.alphaTest,
          opacity: m.opacity,
          side: m.side,
          depthWrite: m.depthWrite,
        });
        u.name = m.name;
        cache.set(m, u);
      }
      return u;
    });
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
}
