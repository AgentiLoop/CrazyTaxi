// The customers' marks, drawn the way the game draws them (decomp, EU addresses; the USA
// ones in src/dc-car.js). Their state comes from the game's own code running in the
// interpreter: ExecKyakuArea, MakeKyakuTakeArea and psgPutMarker all run every frame.
//
// The pick-up circle (kyakuTaskExec -> FUN_0c07b9e0, the line drawer): the line loop
// MakeKyakuTakeArea built in the task (+0x1A0: 12 points on a circle of radius
// 100 - 60k, each at the ground under it + 3, then the first again), in the ARGB
// colour its table gives for k * 4 (red, orange, yellow, lime, green). Drawn while the
// cab is within 450 of the customer (on the ground plane) and the camera mode is
// 0, 1, 2, 10 or 11. Lines are 3 pixels thick on the 480-line picture (nlLineSetThickness).
//
// The dollar over a waiting customer (psgPutMarker): a ring of texture 116 (TEXDC0)
// spinning about y (+0x180, +0x100 a frame) - the flat one (USA 0x0C0EA510) when the
// camera is more than 1000 away, else the thick one (0x0C0E9A10) - and the "$"
// (0x0C0EA130, grey 0.8) facing the camera at its centre, both in the fade colour for
// k * 4 (red, orange, yellow, lime, green), at the passenger + (0, +0x17C, 0): the
// height bounces (+0x178 falls 0.025 a frame; under 35 it is set to 35 and goes up at
// 0.7 again). Half size when Car_Data +0x58 is set.
//
// The destination (PutKyakuStopArea(stop, 5), while riding, within 2000, camera
// mode 0-2): a 10 high wall around the stop's polygon, its face colour (0, glow, 0),
// blended ONE + dst * SRC_ALPHA (alpha 0.8) - green added over the scene - and five
// line loops of the polygon in ARGB (0xDF, 0, glow, 0) at 10 + 10 * phase, then every
// 10 above. ExecKyakuArea: phase += 0.05 a frame (wrapping), angle += 2048, glow =
// 0.5 + 0.25 sin(angle) - a pulse every 32 frames while the rings rise.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { gameTexture } from './scene.js';

const RING_FAR = 0x0C0EA510, RING_NEAR = 0x0C0E9A10, DOLLAR = 0x0C0EA130;
const MARKER_TEXTURE = 'textures/TEXDC0/0116.png';
const LINE_PIXELS = 3;          // on the 480-line picture
const WALL_HEIGHT = 10;
const STOP_RINGS = 5;
const LINE_ORDER = 30;          // after the shadow volumes (traffic 10, 11; cab 20)
const PICKUP_RANGE = 450, STOP_RANGE = 2000, NEAR_RING = 1000;
const SRGB = THREE.SRGBColorSpace;   // the game's colours are the picture's values

/** An nlObjPut model in the game's memory as non-indexed triangles: [{ texture, face [a, r, g, b], positions, uvs }]. */
export function readModel(cpu, address) {
  const records = [];
  for (let p = address + 24; ((cpu.r32(p) & 0xFCFFFF00) >>> 0) === 0x80000000;) {
    const face = [0, 1, 2, 3].map((i) => cpu.rf(p + 44 + 4 * i));
    const positions = [], uvs = [], seen = new Map();
    let q = p + 80;
    const end = q + cpu.r32(p + 76);
    while (q < end) {
      const gflag = cpu.r32(q), count = cpu.r32(q + 4);
      q += 8;
      const strip = [];
      for (let i = 0, n = gflag & 8 ? count * 3 : count; i < n; i++) {
        const x = cpu.rf(q);
        if (!Number.isFinite(x) || Math.abs(x) > 1e9) {   // a reference to an earlier vertex
          strip.push(seen.get(q + cpu.rs32(q + 4) + 8));
          q += 8;
        } else {
          const v = [x, cpu.rf(q + 4), cpu.rf(q + 8), cpu.rf(q + 24), cpu.rf(q + 28)];
          seen.set(q, v);
          strip.push(v);
          q += 32;
        }
      }
      const tris = [];
      if (gflag & 8) for (let k = 0; k < strip.length; k += 3) tris.push(strip.slice(k, k + 3));
      else for (let k = 0; k + 2 < strip.length; k++) tris.push([strip[k], strip[k + 1], strip[k + 2]]);
      for (const t of tris) for (const v of t) { positions.push(v[0], v[1], v[2]); uvs.push(v[3], v[4]); }
    }
    records.push({ texture: cpu.rs32(p + 32), face, positions, uvs });
    p = end;
  }
  return records;
}

/**
 * The marker's ring is an octagon about z. Round it: each triangle is cut into n * n in
 * (angle, radius, z) about the axis and put back, so its straight edges become arcs
 * through the octagon's corners (n = 4: a 32-sided ring). UVs interpolate as before.
 */
export function roundRing(positions, uvs, n = 4) {
  const P = [], U = [];
  for (let t = 0; t < positions.length; t += 9) {
    const v = [0, 1, 2].map((i) => {
      const [x, y, z] = positions.slice(t + 3 * i, t + 3 * i + 3);
      return [Math.atan2(y, x), Math.hypot(x, y), z, uvs[(t / 3 + i) * 2], uvs[(t / 3 + i) * 2 + 1]];
    });
    for (const w of v) {   // the same side of the -x axis as the first corner; the axis itself takes any angle
      if (w[1] < 1e-6) continue;
      while (w[0] - v[0][0] > Math.PI) w[0] -= 2 * Math.PI;
      while (v[0][0] - w[0] > Math.PI) w[0] += 2 * Math.PI;
    }
    const at = (i, j) => {   // barycentric (i, j, n - i - j) / n
      const a = i / n, b = j / n, c = 1 - a - b;
      return v[0].map((_, k) => a * v[0][k] + b * v[1][k] + c * v[2][k]);
    };
    const put = (p) => { P.push(p[1] * Math.cos(p[0]), p[1] * Math.sin(p[0]), p[2]); U.push(p[3], p[4]); };
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        [at(i + 1, j), at(i, j + 1), at(i, j)].forEach(put);
        if (i + j + 2 <= n) [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)].forEach(put);
      }
    }
  }
  return { positions: P, uvs: U };
}

export class KyakuMarks {
  constructor(scene, assets) {
    this.scene = scene;
    this.texture = gameTexture(assets + MARKER_TEXTURE);
    this.texture.flipY = false;   // the models' UVs are for the PNGs as extracted
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.models = null;
    this.markers = new Map();     // task -> { group, near, far, dollar, material, dollarMaterial }
    this.pickups = new Map();     // task -> Line2
    this.stop = null;             // { key, wall, rings: Line2[] }
    this.stopWallMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    });
    this.lines = 0;               // line loops made so far, for their stencil values
    this.resolution = new THREE.Vector2();
  }

  /**
   * A translucent line's material. Line2 draws each segment as its own quad with round
   * ends, so at every corner two of them overlap and the colour blends twice. The stencil
   * stops that: a pixel takes the loop's value when drawn and refuses a second fragment
   * with the same value. Each loop has its own value (bits 0-6, 0x10 .. 0x7F; the shadow
   * volumes use the others and leave zero where they drew) and draws after them
   * (renderOrder LINE_ORDER), so the two never meet.
   */
  lineMaterial() {
    return new LineMaterial({
      color: 0xffffff, linewidth: LINE_PIXELS, transparent: true, depthWrite: false,
      stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 0x10 + this.lines++ % 0x70,
      stencilFuncMask: 0x7F, stencilWriteMask: 0x7F, stencilZPass: THREE.ReplaceStencilOp,
    });
  }

  line(points, material) {
    const g = new LineGeometry();
    g.setPositions(points.flat());
    const l = new Line2(g, material);
    l.computeLineDistances();
    l.renderOrder = LINE_ORDER;
    this.scene.add(l);
    return l;
  }

  /** The marker's three models (read once from the executable in the interpreter's memory). */
  meshes(cpu) {
    const build = (address, material) => {
      const group = new THREE.Group();
      for (let r of readModel(cpu, address)) {
        if (address !== DOLLAR) r = { ...r, ...roundRing(r.positions, r.uvs) };
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(r.positions, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(r.uvs, 2));
        const m = material.clone();
        m.userData.face = r.face;
        group.add(new THREE.Mesh(g, m));
      }
      return group;
    };
    const ring = new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide });
    const plain = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.models = { near: build(RING_NEAR, ring), far: build(RING_FAR, ring), dollar: build(DOLLAR, plain) };
  }

  marker(task) {
    let m = this.markers.get(task);
    if (!m) {
      const clone = (g) => { const c = g.clone(); c.traverse((o) => { if (o.isMesh) o.material = o.material.clone(); }); return c; };
      m = { spin: new THREE.Group(), near: clone(this.models.near), far: clone(this.models.far), dollar: clone(this.models.dollar) };
      m.spin.add(m.near, m.far);
      this.scene.add(m.spin, m.dollar);
      this.markers.set(task, m);
    }
    return m;
  }

  static tint(group, rgb) {
    group.traverse((o) => {
      if (!o.isMesh) return;
      const f = o.material.userData.face;   // [a, r, g, b]
      o.material.color.setRGB(f[1] * rgb[0], f[2] * rgb[1], f[3] * rgb[2], SRGB);
    });
  }

  /**
   * @param car the DreamcastCar after this frame's steps
   * @param customers car.customers()
   * @param camera the camera, placed for this frame
   * @param renderer for the lines' pixel size
   */
  update(car, customers, camera, renderer) {
    if (!this.models) this.meshes(car.cpu);
    renderer.getDrawingBufferSize(this.resolution);
    const px = LINE_PIXELS * this.resolution.y / 480;
    const fx = car.kyakuArea();
    const mode = fx.camMode;
    const cab = car.pos;
    const flat = (p) => Math.hypot(p[0] - cab.x, p[2] - cab.z);
    const seenMarks = new Set(), seenPickups = new Set();
    // The Crazy Box: the marks the game itself drew this frame (car.marksDrawn) - its games
    // choose whom they mark (game 8 only the boyfriends; game 15 shows no stop area).
    const drawn = car.marksDrawn;
    let rider = null;
    for (const c of customers) {
      if (c.request === 5) rider = { ...c, ...car.marks(c.task) };
      if (!drawn && (c.request >= 5 || c.phase !== 1)) continue;
      const t = { ...c, ...car.marks(c.task) };
      // waiting at the kerb, a destination chosen
      const waiting = c.request < 5 && c.phase === 1 && t.hasStop && [0, 1, 2, 10, 11].includes(mode);
      if (drawn ? drawn.markers.has(t.task) : waiting) {
        // psgPutMarker
        const m = this.marker(t.task);
        seenMarks.add(t.task);
        const at = new THREE.Vector3(t.pos[0], t.pos[1] + t.markerY, t.pos[2]);
        const near = drawn ? drawn.markers.get(t.task) === RING_NEAR : camera.position.distanceTo(at) <= NEAR_RING;
        m.near.visible = near; m.far.visible = !near;
        const s = fx.markerHalf ? 0.5 : 1;
        m.spin.position.copy(at);
        m.spin.rotation.set(0, t.markerSpin * Math.PI * 2 / 65536, 0);
        m.spin.scale.setScalar(s);
        m.dollar.position.copy(at);
        m.dollar.quaternion.copy(camera.quaternion);
        m.dollar.scale.setScalar(s);
        const rgb = car.markerColour(t.k);
        KyakuMarks.tint(m.spin, rgb);
        KyakuMarks.tint(m.dollar, rgb);
      }
      // The pick-up circle
      if (t.takeArea && (drawn ? drawn.takeAreas.has(t.task) : waiting && flat(t.spot) < PICKUP_RANGE)) {
        seenPickups.add(t.task);
        let l = this.pickups.get(t.task);
        if (!l) {
          const c = t.takeArea.colour;
          const mat = this.lineMaterial();
          mat.color.setRGB((c >>> 16 & 255) / 255, (c >>> 8 & 255) / 255, (c & 255) / 255, SRGB);
          mat.opacity = (c >>> 24) / 255;
          l = this.line(t.takeArea.points, mat);
          this.pickups.set(t.task, l);
        }
        l.material.linewidth = px;
        l.material.resolution.copy(this.resolution);
      }
    }
    for (const [task, m] of this.markers) {
      if (seenMarks.has(task)) continue;
      for (const g of [m.spin, m.dollar]) {
        this.scene.remove(g);
        g.traverse((o) => { if (o.isMesh) o.material.dispose(); });   // the geometry is the shared model's
      }
      this.markers.delete(task);
    }
    for (const [task, l] of this.pickups) {
      if (seenPickups.has(task)) continue;
      this.scene.remove(l); l.geometry.dispose(); l.material.dispose();
      this.pickups.delete(task);
    }

    // PutKyakuStopArea
    const stop = rider && rider.phase === 2 && rider.hasStop ? rider.stop : -1;
    const area = stop >= 0 && [0, 1, 2].includes(mode) ? car.stopArea(stop) : null;
    const centre = area && area.reduce((a, p) => [a[0] + p[0] / area.length, a[1], a[2] + p[2] / area.length], [0, 0, 0]);
    if (area && (drawn ? drawn.stopArea : flat(centre) < STOP_RANGE)) {
      if (!this.stop || this.stop.key !== stop) {
        this.clearStop();
        const loop = [...area, area[0]];
        const pos = [];
        for (let i = 0; i + 1 < loop.length; i++) {
          const [a, b] = [loop[i], loop[i + 1]];
          pos.push(a[0], a[1], a[2], b[0], b[1], b[2], a[0], a[1] + WALL_HEIGHT, a[2],
            b[0], b[1], b[2], b[0], b[1] + WALL_HEIGHT, b[2], a[0], a[1] + WALL_HEIGHT, a[2]);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const wall = new THREE.Mesh(g, this.stopWallMaterial);
        this.scene.add(wall);
        const rings = [];
        for (let i = 0; i < STOP_RINGS; i++) {
          const mat = this.lineMaterial();
          mat.opacity = 0xDF / 255;
          rings.push(this.line(loop, mat));
        }
        this.stop = { key: stop, wall, rings };
      }
      this.stopWallMaterial.color.setRGB(0, fx.glow, 0, SRGB);
      this.stop.rings.forEach((l, i) => {
        l.material.color.setRGB(0, Math.min(255, Math.trunc(fx.glow * 255)) / 255, 0, SRGB);
        l.material.linewidth = px;
        l.material.resolution.copy(this.resolution);
        l.position.y = WALL_HEIGHT + WALL_HEIGHT * fx.phase + WALL_HEIGHT * i;
      });
    } else {
      this.clearStop();
    }
  }

  clearStop() {
    if (!this.stop) return;
    this.scene.remove(this.stop.wall);
    this.stop.wall.geometry.dispose();
    for (const l of this.stop.rings) { this.scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
    this.stop = null;
  }

  clear() {
    for (const m of this.markers.values()) for (const g of [m.spin, m.dollar]) this.scene.remove(g);
    this.markers.clear();
    for (const l of this.pickups.values()) { this.scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
    this.pickups.clear();
    this.clearStop();
  }
}
