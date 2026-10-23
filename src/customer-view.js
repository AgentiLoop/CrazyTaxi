// Customers on the street: the extracted character models (local-assets/
// characters/char_NN.glb, bone tree + part meshes) playing an idle V motion from
// motions.glb, facing the cab (psgFaceTaxi; drawn at heading + 0x8000, so the
// model's front is -z), with the coloured pick-up circle (MakeKyakuTakeArea,
// radius 100 - 60k) on the ground. Riding customers are not drawn in the cab yet.
import * as THREE from 'three';
import { loadGltf, makeUnlit } from './scene.js';
import { WAITING } from './customers.js';

// Psg_IsMotionSetA (docs/engine.md): these characters play animation set A.
const SET_A = new Set([1, 2, 3, 0x18, 0x1A, 0x1F, 0x20, 0x21, 0x23, 0x24, 0x26, 0x29, 0x2A, 0x2C, 0x2E, 0x30, 0x31, 0x33, 0x34, 0x37, 0x39]);
// psgEnterState0's tables (USA): idles 0x0C0D4914 (10, set A) / 0x0C0D493C (6, set B) -
// most are 2-frame standing poses - and the "hey taxi" calls 0x0C0D4954 (7) /
// 0x0C0D4970 (5) (which set uses which call table is assumed).
const IDLE_A = ['motion_25b018', 'motion_25b33c', 'motion_25b660', 'motion_25b984', 'motion_25bca8', 'motion_263244', 'motion_263568', 'motion_26388c', 'motion_267fc0', 'motion_26bf38'];
const IDLE_B = ['motion_26c25c', 'motion_26c580', 'motion_27081c', 'motion_274ab8', 'motion_2704f8', 'motion_274794'];
const CALL_A = ['motion_283914', 'motion_2a4f2c', 'motion_28f5f0', 'motion_28f914', 'motion_28fc38', 'motion_297990', 'motion_2a5250'];
const CALL_B = ['motion_2895f0', 'motion_28f2cc', 'motion_29d66c', 'motion_2a4c08', 'motion_2ac030'];
// Clip times are seconds at the nominal 30 fps (characters/manifest.json frame_rate).
const CALL_RANGE = 600;        // the cab this near: wave now and then (placeholder)
const CALL_GAP = [2, 6];       // seconds between waves (placeholder)

const CIRCLE_COLOURS = [0x30e030, 0xf0d020, 0xf03030];   // by k thirds (assumed colour bands)
const EXIT_SIDE = 14;

export class CustomerView {
  constructor(scene, assets, collision) {
    this.scene = scene;
    this.assets = assets;
    this.collision = collision;
    this.models = new Map();       // character -> Promise<Object3D>
    this.clips = null;             // Promise<Map<name, AnimationClip>>
    this.live = new Map();         // record -> { group, mixer, circle }
    this.clock = 0;
  }

  character(ch) {
    if (!this.models.has(ch)) {
      // File names are the character index in hex (char_2a.glb).
      const p = loadGltf(`${this.assets}characters/characters/char_${ch.toString(16).padStart(2, '0')}.glb`)
        .then((g) => makeUnlit(g.scene));
      this.models.set(ch, p);
    }
    return this.models.get(ch);
  }

  motions() {
    if (!this.clips) {
      this.clips = loadGltf(`${this.assets}characters/motions.glb`)
        .then((g) => new Map(g.animations.map((c) => [c.name, c])));
    }
    return this.clips;
  }

  async show(r, car) {
    const [model, clips] = await Promise.all([this.character(r.character), this.motions()]);
    if (this.live.has(r) || r.state === 0) return;      // despawned while loading
    const group = new THREE.Group();
    const body = model.clone();
    group.add(body);
    const setA = SET_A.has(r.character);
    const pick = (names) => clips.get(names[Math.floor(Math.random() * names.length)]);
    const mixer = new THREE.AnimationMixer(body);
    const idleClip = pick(setA ? IDLE_A : IDLE_B);
    let idle = null, wave = null;
    if (idleClip) {
      idle = mixer.clipAction(idleClip);
      idle.time = Math.random() * idleClip.duration;
      idle.play();
    }
    const waveClip = pick(setA ? CALL_A : CALL_B);
    if (waveClip && idle) {
      wave = mixer.clipAction(waveClip);
      wave.setLoop(THREE.LoopOnce, 1);
      mixer.addEventListener('finished', () => { idle.reset().play(); });
    }
    const circle = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 48),
      new THREE.MeshBasicMaterial({ color: CIRCLE_COLOURS[Math.min(2, Math.floor(r.k * 3))], transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    );
    circle.rotation.x = -Math.PI / 2;
    const rad = 100 - 60 * r.k;
    circle.scale.set(rad, rad, 1);
    circle.position.y = 0.6;
    group.add(circle);
    this.place(group, r.pos);
    this.scene.add(group);
    this.live.set(r, { group, mixer, circle, body, idle, wave, nextWave: CALL_GAP[0] + Math.random() * (CALL_GAP[1] - CALL_GAP[0]) });
    this.face(group, car);
  }

  place(group, pos) {
    const g = this.collision.groundAt(pos.x, pos.y + 20, pos.z, 1);
    group.position.set(pos.x, g ? g.y : pos.y, pos.z);
  }

  face(group, car) {
    const h = Math.atan2(car.pos.x - group.position.x, car.pos.z - group.position.z);
    group.rotation.y = h + Math.PI;
  }

  hide(r) {
    const v = this.live.get(r);
    if (!v) return;
    this.scene.remove(v.group);
    v.circle.geometry.dispose();
    v.circle.material.dispose();
    this.live.delete(r);
  }

  clear() {
    for (const r of [...this.live.keys()]) this.hide(r);
  }

  /** Apply this frame's customer events and animate. */
  update(customers, car, dt) {
    for (const ev of customers.events) {
      const r = ev.record;
      switch (ev.type) {
        case 'spawn': this.show(r, car); break;
        case 'despawn': case 'gone': this.hide(r); break;
        case 'stop': { const v = this.live.get(r); if (v) v.circle.visible = false; break; }
        case 'in': this.hide(r); break;
        case 'out': case 'eject': {
          // Out on the kerb side of the cab (psgPickExitSide: placeholder = the cab's left).
          const f = car.forward();
          r.pos = { x: car.pos.x + f.z * EXIT_SIDE, y: car.pos.y, z: car.pos.z - f.x * EXIT_SIDE };
          this.show(r, car).then(() => { const v = this.live.get(r); if (v) v.circle.visible = false; });
          break;
        }
        default: break;
      }
    }
    for (const [r, v] of this.live) {
      v.mixer.update(dt);
      if (r.state !== WAITING) continue;
      this.face(v.group, car);
      if (!v.wave) continue;
      v.nextWave -= dt;
      if (v.nextWave <= 0) {
        v.nextWave = CALL_GAP[0] + Math.random() * (CALL_GAP[1] - CALL_GAP[0]);
        const d = Math.hypot(car.pos.x - v.group.position.x, car.pos.z - v.group.position.z);
        if (d < CALL_RANGE && !v.wave.isRunning()) { v.idle.stop(); v.wave.reset().play(); }
      }
    }
  }
}