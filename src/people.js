// The people, drawn as the game draws them: every frame the interpreter (src/dc-car.js)
// captures the game's own draw calls - humanDraw(motion, character, frame) and
// VSklIpPlay(a, fa, b, fb, weight) for the V motions (the customers standing at the
// kerb: motions.glb's clips), FcvPlayBuffer(buffer, character) for the key-curve
// poses (the driver, the get-in and get-out, the passenger in the cab) - each with
// the figure's world matrix. The extracted characters (local-assets/characters/
// char_NN.glb: bone_0..15 with the parts as child meshes) are posed from them.
//
// A V motion's record for frame f is f mod (frames - 1) + 1 (VSklPlay); the clips hold
// records 1 .. frames - 1 then 1 again at 30 keys per second, so record r is key r - 1.
// An Fcv pose buffer (tagFCVIPBUFFER, 17 vectors) is rebuilt as FcvPlayBuffer does
// (tools/extract_fcv_motions.py has the same math and its derivation): [0] the root
// position, [1]-[4] the hands' and feet's targets in the figure's axes, [5]-[16]
// Rz * Ry * Rx angle triples (0x10000 = a turn): root = angles [5] then a quarter turn
// about y; torso [6]; head [7] after a quarter turn back about z; per limb the
// shoulder or hip angles ([8], [10], [13], [15]), the two-bone solver (fcvSolveIK: aim
// +x at the target, twist about x to keep the old z plane, bend both segments about z
// by the law of cosines) and the hand or foot angles ([9], [11], [14], [16]).
// (The pick-up circle, the dollar marker and the destination: src/kyaku-marks.js.)
import * as THREE from 'three';
import { loadGltf, makeUnlit } from './scene.js';
import { spideySkin, SPIDEY_CHARACTER } from './spidey.js';

const FRAME_RATE = 30;
const TURN = 0x10000;
const QUARTER = 0x4000;
// Per limb (left hand, right hand, left foot, right foot): target slot, root angles,
// end angles, solver lengths (0 arm, 1 leg), bones (root, middle, end).
const LIMBS = [[1, 8, 9, 0, [4, 3, 2]], [2, 10, 11, 0, [7, 6, 5]], [3, 13, 14, 1, [11, 10, 9]], [4, 15, 16, 1, [14, 13, 12]]];

// --- 3 x 3 matrices as row-major arrays of 9 ---
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
  return o;
}
function apply(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function applyT(m, v) {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}
const column = (m, c) => [m[c], m[3 + c], m[6 + c]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function sinCos(angle) {
  const r = (((angle % TURN) + TURN) % TURN) * 2 * Math.PI / TURN;
  return [Math.sin(r), Math.cos(r)];
}
function rotX(a) { const [s, c] = sinCos(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
function rotY(a) { const [s, c] = sinCos(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
function rotZ(a) { const [s, c] = sinCos(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
/** fcvRotate: Rz(z) * Ry(y) * Rx(x). */
const fcvRotate = (v) => mul(mul(rotZ(v[2]), rotY(v[1])), rotX(v[0]));
function axisAngle([x, y, z], s, c) {
  const t = 1 - c;
  return [x * x * t + c, x * y * t - z * s, x * z * t + y * s,
    x * y * t + z * s, y * y * t + c, y * z * t - x * s,
    x * z * t - y * s, y * z * t + x * s, z * z * t + c];
}
const toAngle = (rad) => Math.trunc(rad * TURN / (2 * Math.PI)) & 0xFFFF;
const gameAcos = (x) => (Math.abs(x) > 1 ? 0 : toAngle(Math.acos(x)));

/** fcvSolveIK: the rotation to post-multiply onto m, the two bends (angle units), the distance. */
function solveIK(m, shoulder, target, [upper, lower]) {
  const d = [target[0] - shoulder[0], target[1] - shoulder[1], target[2] - shoulder[2]];
  const distance = Math.hypot(d[0], d[1], d[2]);
  const u = distance ? d.map((v) => v / distance) : [0, 0, 0];
  const local = applyT(m, u);
  const axis = [0, -local[2], local[1]];
  const s = Math.hypot(axis[1], axis[2]);
  const c = local[0];
  let aim;
  if (s !== 0) aim = axisAngle(axis.map((v) => v / s), s, c);
  else if (c < 0) aim = axisAngle([0, 0, 1], 0, -1);
  else aim = I3;
  const aimed = mul(m, aim);
  const zNew = column(aimed, 2);
  const twist = toAngle(Math.atan2(dot(column(m, 1), zNew), dot(column(m, 2), zNew)));
  const rotation = mul(aim, rotX(-twist));
  if (distance === 0) return [rotation, 0, 0];
  const bend1 = gameAcos((upper * upper - lower * lower + distance * distance) / (upper * distance * 2));
  const bend2 = -gameAcos((distance * distance - upper * upper - lower * lower) / (upper * lower * 2));
  return [rotation, bend1, bend2];
}

/**
 * FcvPlayBuffer's pose: { rotations: 16 row-major 3x3 matrices by bone, root: [x, y, z] }.
 * bind = the 13 bind vectors (head, then per limb offset, segment 1, segment 2),
 * lengths = { arm: [upper, lower], leg: [upper, lower] }.
 */
export function fcvPose(buffer, bind, lengths) {
  const local = new Array(16).fill(I3);
  const root = mul(fcvRotate(buffer[5]), rotY(QUARTER));
  local[0] = root;
  local[8] = fcvRotate(buffer[6]);
  const torso = mul(root, local[8]);
  local[1] = mul(rotZ(-QUARTER), fcvRotate(buffer[7]));
  local[15] = fcvRotate(buffer[12]);
  const hips = mul(root, local[15]);
  LIMBS.forEach(([target, first, end, mode, bones], limb) => {
    const parent = mode === 0 ? torso : hips;
    const offset = bind[1 + 3 * limb];
    const o = apply(parent, offset);
    const shoulder = [buffer[0][0] + o[0], buffer[0][1] + o[1], buffer[0][2] + o[2]];
    const m = mul(parent, fcvRotate(buffer[first]));
    const [rotation, bend1, bend2] = solveIK(m, shoulder, buffer[target], mode === 0 ? lengths.arm : lengths.leg);
    local[bones[0]] = mul(mul(fcvRotate(buffer[first]), rotation), rotZ(bend1));
    local[bones[1]] = rotZ(bend2);
    local[bones[2]] = fcvRotate(buffer[end]);
  });
  return { rotations: local, root: buffer[0] };
}

/** The clip key for V motion frame f (VSklPlay: record f mod (frames - 1) + 1). */
export function vKey(frame, frames) {
  const n = frames - 1;
  return ((frame % n) + n) % n;
}

export class PeopleView {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.models = new Map();        // character -> Promise<Object3D>
    this.pool = new Map();          // character -> instances
    this.ready = null;
    this.clips = new Map();         // motion address -> { clip, frames }
    this.bind = null; this.lengths = null;
    this.drawn = 0;
    this.spidey = false;            // the mod: Axel's figure drawn as Spidey (src/spidey.js)
  }

  /** Spidey in (true) or out: Axel's figure is loaded again, suited or not. */
  setSpidey(on) {
    if (on === this.spidey) return;
    this.spidey = on;
    for (const inst of this.pool.get(SPIDEY_CHARACTER) || []) this.scene.remove(inst.group);
    this.pool.delete(SPIDEY_CHARACTER);
    this.models.delete(SPIDEY_CHARACTER);
  }

  /** The motion clips and the Fcv skeleton constants (characters/ and fcv_motions/ manifests). */
  load() {
    if (!this.ready) {
      this.ready = Promise.all([
        fetch(`${this.assets}characters/manifest.json`).then((r) => r.json()),
        fetch(`${this.assets}fcv_motions/manifest.json`).then((r) => r.json()),
        loadGltf(`${this.assets}characters/motions.glb`),
      ]).then(([chars, fcv, gltf]) => {
        const byName = new Map(gltf.animations.map((c) => [c.name, c]));
        for (const m of chars.motions) {
          const clip = byName.get(m.name);
          if (clip) this.clips.set(m.address, { clip, frames: m.frames });
        }
        this.bind = fcv.bind_offsets.vectors;
        this.lengths = { arm: fcv.solver_lengths.arm, leg: fcv.solver_lengths.leg };
      });
    }
    return this.ready;
  }

  character(ch) {
    if (!this.models.has(ch)) {
      // File names are the character index in hex (char_2a.glb).
      const p = loadGltf(`${this.assets}characters/characters/char_${ch.toString(16).padStart(2, '0')}.glb`)
        .then((g) => (ch === SPIDEY_CHARACTER && this.spidey ? spideySkin(makeUnlit(g.scene)) : makeUnlit(g.scene)));
      this.models.set(ch, p);
    }
    return this.models.get(ch);
  }

  instance(ch, n) {
    let list = this.pool.get(ch);
    if (!list) { list = []; this.pool.set(ch, list); }
    while (list.length <= n) {
      const inst = { group: new THREE.Group(), body: null, bones: null, mixer: null, actions: new Map(), used: false };
      inst.group.matrixAutoUpdate = false;
      this.scene.add(inst.group);
      list.push(inst);
      this.character(ch).then((model) => {
        inst.body = model.clone();
        inst.bones = new Map();
        inst.body.traverse((o) => { if (o.name.startsWith('bone_')) inst.bones.set(+o.name.slice(5), o); });
        inst.mixer = new THREE.AnimationMixer(inst.body);
        inst.group.add(inst.body);
      });
    }
    return list[n];
  }

  action(inst, address) {
    const m = this.clips.get(address);
    if (!m) return null;
    let a = inst.actions.get(address);
    if (!a) {
      a = inst.mixer.clipAction(m.clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      inst.actions.set(address, a);
    }
    return { action: a, frames: m.frames };
  }

  poseV(inst, draws) {
    for (const a of inst.actions.values()) { a.enabled = false; a.weight = 0; }
    for (const [address, frame, weight] of draws) {
      const m = this.action(inst, address);
      if (!m) continue;
      m.action.enabled = true;
      m.action.weight = weight;
      m.action.play();
      m.action.time = vKey(frame, m.frames) / FRAME_RATE;
    }
    inst.mixer.update(0);
    inst.fcv = false;
    inst.raw = null;
  }

  /**
   * The pose buffer averaged with the last game frame's. drvJolt rocks the driver by the
   * cab's acceleration (the second difference of its position); scraping a wall or riding
   * a bump flips it every frame, a 60 Hz shake of the body and head. The two-frame mean
   * cancels that flip and keeps the slower sway and the head's turn.
   */
  steady(inst, buffer) {
    if (buffer === inst.raw) return inst.steadied;   // the same game frame drawn again
    const prev = inst.raw;
    inst.raw = buffer;
    inst.steadied = prev ? buffer.map((v, i) => v.map((x, j) => (i < 5
      ? (x + prev[i][j]) / 2
      : x + ((((prev[i][j] - x) % TURN) + TURN + TURN / 2) % TURN - TURN / 2) / 2))) : buffer;
    return inst.steadied;
  }

  poseFcv(inst, buffer) {
    if (!inst.fcv) {
      inst.mixer.stopAllAction();
      inst.fcv = true;
    }
    const pose = fcvPose(this.steady(inst, buffer), this.bind, this.lengths);
    const m4 = new THREE.Matrix4();
    for (const [bone, node] of inst.bones) {
      const r = pose.rotations[bone];
      m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
      node.quaternion.setFromRotationMatrix(m4);
      if (bone === 0) node.position.set(pose.root[0], pose.root[1], pose.root[2]);
    }
  }

  /** @param people car.people this frame */
  update(people) {
    for (const list of this.pool.values()) for (const inst of list) inst.used = false;
    if (this.bind) {
      const count = new Map();
      for (const p of people) {
        const n = count.get(p.chara) || 0;
        count.set(p.chara, n + 1);
        const inst = this.instance(p.chara, n);
        if (!inst.group.visible) inst.raw = null;   // not drawn last frame: nothing to average with
        inst.used = true;
        inst.group.matrix.fromArray(p.matrix);
        inst.group.matrixWorldNeedsUpdate = true;
        if (!inst.body) continue;
        if (p.kind === 'fcv') this.poseFcv(inst, p.buffer);
        else if (p.kind === 'v') this.poseV(inst, [[p.motion, p.frame, 1]]);
        else this.poseV(inst, [[p.motion, p.frame, 1 - p.weight], [p.motionB, p.frameB, p.weight]]);
      }
    }
    this.drawn = 0;
    for (const list of this.pool.values()) for (const inst of list) { inst.group.visible = inst.used; if (inst.used) this.drawn++; }
  }

  clear() {
    for (const list of this.pool.values()) for (const inst of list) inst.group.visible = false;
  }
}
