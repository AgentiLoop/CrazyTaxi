// The Crazy Box games' own 3D objects as the game draws them (car.objects, src/dc-car.js:
// nlObjPutUseViewMatrixTrnsl - Crazy Balloons' 20 balloons): each is a model of the game's
// at its address (POLDC0.BIN at 0x0C390000; POLDC1-3, the city's, at 0x0C5E0000), placed by
// XMTRX (the world matrix with its scale), see-through by the call's alpha (0.8) and
// coloured by the fade colour (nlObjPutSetFadeColorBase: the balloon's own of ten).
// The models are untextured; they are lit by the scene's light (the nav arrow's), so the
// round balloons read as round.
import * as THREE from 'three';
import { loadGltf } from './scene.js';

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
    this.models = new Map();   // address -> geometry list (null while loading or missing)
    this.pool = [];            // the meshes, reused frame to frame
    this.drawn = 0;
  }

  geometry(address) {
    if (!this.models.has(address)) {
      this.models.set(address, null);
      loadGltf(this.assets + modelFile(address, this.courseMode)).then((gltf) => {
        const parts = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => { if (o.isMesh) parts.push(o.geometry.clone().applyMatrix4(o.matrixWorld)); });
        this.models.set(address, parts);
      }, (e) => console.warn(`Crazy Box model 0x${address.toString(16)}: ${e.message}`));
    }
    return this.models.get(address);
  }

  /** @param {{model: number, matrix: Float32Array, colour: number[], alpha: number}[]} objects */
  update(objects) {
    let n = 0;
    for (const o of objects) {
      const parts = this.geometry(o.model);
      if (!parts) continue;
      for (const g of parts) {
        let mesh = this.pool[n];
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
      }
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].visible = false;
    this.drawn = n;
  }
}
