// The Crazy Box games' own 3D objects as the game draws them (car.objects, src/dc-car.js:
// nlObjPutUseViewMatrixTrnsl - Crazy Balloons' 20 balloons): each is a model of the game's
// at its address (POLDC0.BIN at 0x0C390000; POLDC1-3, the city's, at 0x0C5E0000), placed by
// XMTRX (the world matrix with its scale), see-through by the call's alpha (0.8) and
// coloured by the fade colour (nlObjPutSetFadeColorBase: the balloon's own of ten).
// The models are untextured; they are lit by the scene's light (the nav arrow's), so the
// round balloons read as round.
// The set objects SetObjFly draws (`setObject`: Crazy Bowling's pins, flying when hit) are
// the textured models as the props show them (unlit), placed by XMTRX.
import * as THREE from 'three';
import { loadGltf, makeUnlit } from './scene.js';

const POL0 = 0x0C390000, POL_CITY = 0x0C5E0000;

/** The extracted model file for a model address, CourseMode the city loaded. */
export function modelFile(address, courseMode) {
  const [file, base] = address >= POL_CITY ? [`POLDC${courseMode + 1}`, POL_CITY] : ['POLDC0', POL0];
  return `models/${file}/${(address - base).toString(16).padStart(6, '0')}.glb`;
}

export class BoxObjects {
  constructor(scene, assets, courseMode) {
    this.scene = scene;
    this.assets = assets;
    this.courseMode = courseMode;
    this.models = new Map();   // address -> { parts: geometry list, unlit: the textured scene } (null while loading or missing)
    this.pool = [];            // the meshes, reused frame to frame
    this.copies = new Map();   // address -> the set objects' copies of its textured scene, reused frame to frame
    this.drawn = 0;
  }

  model(address) {
    if (!this.models.has(address)) {
      this.models.set(address, null);
      loadGltf(this.assets + modelFile(address, this.courseMode)).then((gltf) => {
        const parts = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => { if (o.isMesh) parts.push(o.geometry.clone().applyMatrix4(o.matrixWorld)); });
        this.models.set(address, { parts, unlit: makeUnlit(gltf.scene) });
      }, (e) => console.warn(`Crazy Box model 0x${address.toString(16)}: ${e.message}`));
    }
    return this.models.get(address);
  }

  /** @param {{model: number, matrix: Float32Array, colour?: number[], alpha?: number, setObject?: boolean}[]} objects */
  update(objects) {
    let n = 0, p = 0;
    const used = new Map();
    for (const o of objects) {
      const m = this.model(o.model);
      if (!m) continue;
      if (o.setObject) {
        const k = used.get(o.model) || 0;
        used.set(o.model, k + 1);
        let list = this.copies.get(o.model);
        if (!list) this.copies.set(o.model, list = []);
        let copy = list[k];
        if (!copy) {
          copy = m.unlit.clone();
          copy.matrixAutoUpdate = false;
          this.scene.add(copy);
          list.push(copy);
        }
        copy.matrix.fromArray(o.matrix);
        copy.matrixWorldNeedsUpdate = true;
        copy.visible = true;
        n++;
        continue;
      }
      for (const g of m.parts) {
        let mesh = this.pool[p];
        if (!mesh) {
          mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false }));
          mesh.matrixAutoUpdate = false;
          this.scene.add(mesh);
          this.pool.push(mesh);
        }
        mesh.geometry = g;
        mesh.matrix.fromArray(o.matrix);
        mesh.matrixWorldNeedsUpdate = true;
        mesh.material.color.setRGB(o.colour[0], o.colour[1], o.colour[2]);
        mesh.material.opacity = o.alpha;
        mesh.visible = true;
        n++;
        p++;
      }
    }
    for (let i = p; i < this.pool.length; i++) this.pool[i].visible = false;
    for (const [address, list] of this.copies) for (let i = used.get(address) || 0; i < list.length; i++) list[i].visible = false;
    this.drawn = n;
  }
}
