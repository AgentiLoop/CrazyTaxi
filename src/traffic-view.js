// The traffic drawn as putCarModel / putTrainModel draw it: each car entryCarPut
// lists (src/dc-car.js, TrafficCar) gets the extracted vehicle model of its type
// (local-assets/vehicles/traffic/type_NN_*.glb: scenes "near" - body, shadow,
// wheels -, "far" - the simple body - and "lamps"), the body tinted with its
// colour (the KHR_materials_variants paint "paint_NN", baked by the extractor),
// placed by the car's position and pitch/heading/roll, the body lifted and
// tilted by its suspension (+0xF8 + 0xFC, +0xAA, +0xAE), the wheels spun by
// 0.2 x the speed per frame, the brake lamps (lamp set index 2) on while the
// car brakes. The game's turn signals (night only) and the ground-fitted shadow
// transform are not reproduced: the shadow sits under the body.
// The shadow model is a modifier volume (PutMVObj: an open-bottomed box whose
// face colour is meaningless), so it is drawn as one: its front faces in front
// of the scene add 1 to the stencil, its back faces in front subtract 1, then
// the pixels left non-zero are darkened (and the stencil cleared). Needs a
// renderer with stencil: true (src/main.js). The darkness is a guess (50%).
import * as THREE from 'three';
import { loadGltf, makeUnlit, toUnlit } from './scene.js';

const LAMP = /^lamp_([ab])_(near|far)_(\d)_/;

const volume = (side, zPass) => new THREE.MeshBasicMaterial({
  side, colorWrite: false, depthWrite: false, transparent: true, fog: false,
  stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: zPass,
});
const SHADOW_PASSES = [
  [volume(THREE.FrontSide, THREE.IncrementWrapStencilOp), 10],
  [volume(THREE.BackSide, THREE.DecrementWrapStencilOp), 10],
  [new THREE.MeshBasicMaterial({
    color: 0x000000, opacity: 0.5, transparent: true, depthWrite: false, depthTest: false, fog: false,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ZeroStencilOp,
  }), 11],
];

/** Replace a shadow mesh's (opaque, garbage-coloured) material by the three volume passes. */
function shadowVolume(mesh) {
  const [first, ...rest] = SHADOW_PASSES;
  mesh.material = first[0];
  mesh.renderOrder = first[1];
  for (const [material, order] of rest) {
    const pass = new THREE.Mesh(mesh.geometry, material);
    pass.renderOrder = order;
    mesh.add(pass);
  }
}

export class TrafficView {
  /**
   * @param {THREE.Scene} scene
   * @param {string} assets the local-assets/ URL prefix
   * @param {object} manifest local-assets/vehicles/manifest.json
   */
  constructor(scene, assets, manifest) {
    this.scene = scene;
    this.assets = assets;
    this.types = manifest.traffic;          // by index: { glb, name, ... }
    this.models = new Map();                // type -> { near, far, lamps, variants } or a promise
    this.instances = new Map();             // car id -> instance
    this.pool = new Map();                  // type -> spare instances
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);
    this.drawn = 0;
  }

  model(type) {
    let m = this.models.get(type);
    if (m) return m;
    const entry = this.types[type];
    if (!entry) return null;
    m = loadGltf(this.assets + 'vehicles/' + entry.glb).then((gltf) => {
      const cache = new Map();
      const scenes = {};
      for (const s of gltf.scenes) scenes[s.name] = makeUnlit(s, cache);
      const variants = new Map();
      for (const [mesh, byName] of gltf.variants) {
        const u = new Map();
        for (const [name, mat] of byName) u.set(name, toUnlit(mat, true, cache));
        variants.set(mesh, u);
      }
      const loaded = { near: scenes.near, far: scenes.far, lamps: scenes.lamps, variants };
      this.models.set(type, loaded);
      return loaded;
    });
    this.models.set(type, m);
    return m;
  }

  /** A new instance of a loaded model: root > [shadow, body > [near/far parts, lamps]]. */
  build(type, model) {
    const root = new THREE.Group();
    root.name = `car_${type}`;
    const body = new THREE.Group();
    root.add(body);
    const near = model.near ? model.near.clone() : new THREE.Group();
    const far = model.far ? model.far.clone() : new THREE.Group();
    const lamps = model.lamps ? model.lamps.clone() : new THREE.Group();
    body.add(near, far, lamps);
    const wheels = [], painted = [], lampSets = { near: {}, far: {} };
    for (const part of [near, far]) {
      for (const o of [...part.children]) {
        if (o.name.startsWith('wheel_')) wheels.push(o);
        else if (o.name.startsWith('shadow_')) {
          if (part === near) root.add(o);          // the shadow stays on the ground under the body
          else o.visible = false;
          const meshes = [];
          o.traverse((m) => { if (m.isMesh) meshes.push(m); });
          meshes.forEach(shadowVolume);
        }
      }
    }
    for (const o of lamps.children) {
      const m = LAMP.exec(o.name);
      if (m) { (lampSets[m[2]][m[3]] ||= []).push(o); o.visible = false; }
    }
    root.traverse((o) => { if (o.isMesh && model.variants.has(o.name)) painted.push(o); });
    this.group.add(root);
    return { type, root, body, near, far, lamps, wheels, painted, lampSets, wheelAngle: 0, colour: null, model };
  }

  take(type) {
    const spare = this.pool.get(type);
    if (spare && spare.length) { const i = spare.pop(); i.root.visible = true; return i; }
    const model = this.models.get(type);
    if (!model || model.then) return null;      // still loading
    return this.build(type, model);
  }

  release(inst) {
    inst.root.visible = false;
    (this.pool.get(inst.type) || this.pool.set(inst.type, []).get(inst.type)).push(inst);
  }

  /** @param {import('./dc-car.js').TrafficCar[]} cars the cars drawn this frame */
  update(cars) {
    const seen = new Set();
    this.drawn = 0;
    for (const c of cars) {
      let inst = this.instances.get(c.id);
      if (inst && inst.type !== c.type) { this.release(inst); this.instances.delete(c.id); inst = null; }
      if (!inst) {
        const m = this.model(c.type);
        if (!m) continue;
        inst = this.take(c.type);
        if (!inst) continue;
        inst.wheelAngle = 0;
        this.instances.set(c.id, inst);
      }
      seen.add(c.id);
      this.pose(inst, c);
      this.drawn++;
    }
    for (const [id, inst] of this.instances) {
      if (!seen.has(id)) { this.release(inst); this.instances.delete(id); }
    }
  }

  pose(inst, c) {
    inst.root.position.set(c.x, c.y, c.z);
    inst.root.rotation.set(c.pitch, c.heading, c.roll, 'YXZ');
    inst.body.position.y = c.bodyY;
    inst.body.rotation.set(c.bodyPitch, 0, c.bodyRoll, 'XZY');
    const detailed = c.detail === 0 || !inst.model.far;
    inst.near.visible = detailed;
    inst.far.visible = !detailed;
    inst.wheelAngle += 0.2 * c.speed;
    for (const w of inst.wheels) w.rotation.x = inst.wheelAngle;
    const lit = detailed ? 'near' : 'far';
    for (const level of ['near', 'far']) {
      for (const idx in inst.lampSets[level]) {
        const on = level === lit && c.brake > 0.01 && idx === '2';
        for (const o of inst.lampSets[level][idx]) o.visible = on;
      }
    }
    if (inst.colour !== c.colour) {
      inst.colour = c.colour;
      const name = `paint_${String(c.colour).padStart(2, '0')}`;
      for (const mesh of inst.painted) {
        const v = inst.model.variants.get(mesh.name);
        const mat = c.colour >= 0 && v.get(name);
        if (mat) mesh.material = mat;
      }
    }
  }

  clear() {
    for (const [id, inst] of this.instances) { this.release(inst); this.instances.delete(id); }
  }
}
