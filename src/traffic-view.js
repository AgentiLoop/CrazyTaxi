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
// The darkening pass is fogged: the game darkens the shaded colour before the
// fog is mixed in, so a far shadow fades with the road (black blended at 50%
// after fogging would stay a grey box on the fogged road).
import * as THREE from 'three';
import { loadGltf, makeUnlit, toUnlit, blendPass } from './scene.js';

const LAMP = /^lamp_([ab])_(near|far)_(\d)_/;
// Shadow volumes farther than this from the camera are hidden: past it the depth
// buffer is too coarse for the stencil test and the volume shows as a grey box.
const SHADOW_DIST = 600;
// entryCarPut stops drawing cars past 1800 (src/dc-car.js): fade them in with a screen
// dither between these camera distances instead of popping in at the edge.
const FADE_NEAR = 1400, FADE_FAR = 1750;
const faded = new WeakSet();

/** Dither a traffic material out with its fragments' distance from the camera. */
function fadeIn(mat) {
  if (!mat || faded.has(mat)) return;
  faded.add(mat);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying float vFadeDist;\n' + shader.vertexShader.replace(
      '#include <project_vertex>', '#include <project_vertex>\n  vFadeDist = length(mvPosition.xyz);');
    shader.fragmentShader = 'varying float vFadeDist;\n' + shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
  float fadeA = clamp((${FADE_FAR.toFixed(1)} - vFadeDist) / ${(FADE_FAR - FADE_NEAR).toFixed(1)}, 0.0, 1.0);
  if (fadeA < 1.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= fadeA) discard;`);
  };
  mat.customProgramCacheKey = () => 'trafficFade';
}

const volume = (side, zPass) => new THREE.MeshBasicMaterial({
  side, colorWrite: false, depthWrite: false, transparent: true, fog: false,
  stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: zPass,
});
/**
 * The darkening pass: halves the colour the way the game does, before its fog is mixed
 * in. Black at 50% blended over an already fogged pixel left a dark box on the fogged
 * road at distance (and none close up on a black road); fogging this pass's black adds
 * back 0.5 x fogFactor x fogColor, giving dst / 2 + fogFactor / 2 x fogColor =
 * mix(colour / 2, fogColor, fogFactor) for any road colour, so a far shadow fades out.
 */
export function shadowDarken(params) {
  return new THREE.MeshBasicMaterial({
    color: 0x000000, opacity: 0.5, transparent: true, depthWrite: false, depthTest: false, fog: true,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ZeroStencilOp,
    ...params,
  });
}

const SHADOW_PASSES = [
  [volume(THREE.FrontSide, THREE.IncrementWrapStencilOp), 10],
  [volume(THREE.BackSide, THREE.DecrementWrapStencilOp), 10],
  [shadowDarken(), 11],
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
      const fade = (mat) => { fadeIn(mat); fadeIn(blendPass(mat)); };
      for (const s of Object.values(scenes)) {
        s.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach(fade); });
      }
      for (const u of variants.values()) u.forEach(fade);
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
    const wheels = [], painted = [], shadows = [], lampSets = { near: {}, far: {} };
    for (const part of [near, far]) {
      for (const o of [...part.children]) {
        if (o.name.startsWith('wheel_')) wheels.push(o);
        else if (o.name.startsWith('shadow_')) {
          if (part === near) { root.add(o); shadows.push(o); } // the shadow stays on the ground under the body
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
    return { type, root, body, near, far, lamps, wheels, painted, shadows, lampSets, wheelAngle: 0, colour: null, model };
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
  update(cars, camera) {
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
      // The cable car's (P_Cable) volume showed as a grey box too: its shadow is not drawn.
      const shadowOn = this.types[c.type].name !== 'P_Cable' &&
        (!camera || inst.root.position.distanceTo(camera.position) < SHADOW_DIST);
      for (const s of inst.shadows) s.visible = shadowOn;
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
    const detailed = true;                // distant cars draw the detailed model too, like the close ones
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
        if (!mat) continue;
        mesh.material = mat;
        // A paint with see-through texels draws twice (src/scene.js makeUnlit).
        const pass = blendPass(mat);
        let b = mesh.children.find((o) => o.name === `${mesh.name}#blend`);
        if (pass && !b) { b = new THREE.Mesh(mesh.geometry, pass); b.name = `${mesh.name}#blend`; mesh.add(b); }
        if (b) { b.visible = !!pass; if (pass) b.material = pass; }
      }
    }
  }

  clear() {
    for (const [id, inst] of this.instances) { this.release(inst); this.instances.delete(id); }
  }
}
