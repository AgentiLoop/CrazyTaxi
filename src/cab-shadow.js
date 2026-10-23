// The cab's shadow, built the way the game builds it. putPlayerCar calls
// PutMVObj(cab type) (USA 0x0C03858C) in the body's matrix: the car's position,
// heading/pitch/roll (+0x86/+0x84/+0x88), the body tilt (+0xAC about x, +0xB0 about z)
// and the 1.2 drop. PutMVObj hands the cab's list of shadow pieces
// (tools/extract_vehicles.py: the GLB's "shadow" scene) and the shadow settings
// (USA 0x0C2840F4, set at boot by 0x0C038388: flag bit 0 clear = a directional
// light, +0x14 length 100) to the library's shadow volume routine (0x0C07B630).
// That routine brings the light into the model's frame, then for each piece
// (0x0C07B760) marks every face whose normal points away from the light
// (dot(normal, light) < 0; 0x0C07BAF0), draws those faces twice - in place and
// moved 100 units away from the light - and joins the two copies along each edge
// used by exactly one marked face (0x0C07C130). Each piece ends its own closed
// modifier volume.
// The light is the game's: gameState0 (USA ~0x0C02BFD6) calls SetLight(0x2200, b)
// (USA 0x0C02FE80; light = (cos a sin b, sin a, cos a cos b) at 0x0C26BEE0,
// pointing towards the light) with b = 0x6100 in Crazy Box mini game 1 (CourseMode
// 2, MiniGame_No 1), else 0x2900 - run here in the interpreter.
// The PowerVR modifier volume darkens what lies inside any volume, but only polygons
// whose PCW shadow bit (7) is set (the GLB node extras "shadowed": the cab's wheels
// have it, its body does not). Here the visible surfaces of the cab's parts without it
// first set stencil bit 7; then each piece flips stencil bit 0 for each of its faces in
// front of the scene where bit 7 is clear (inside = odd), and its pixels with bit 0
// set move up to the "shadowed" bits 1-6; the last pass darkens every pixel with a
// shadowed bit and clears the stencil. The darkness is the traffic shadows' guess
// (50%). Needs a renderer with stencil: true.
import * as THREE from 'three';

const TURN = Math.PI * 2 / 65536;
const CAR = 0x0C176E4C;
const SET_LIGHT = 0x0C02FE80, LIGHT = 0x0C26BEE0;
const COURSE_MODE = 0x0C1EBF2C, MINI_GAME_NO = 0x0C1EBF34;
const LENGTH = 100;
const BODY_DROP = 1.2;
const ORDER = 20;   // after the traffic shadows (10, 11), which leave the stencil cleared
const UNAFFECTED = 0x80;

const shield = new THREE.MeshBasicMaterial({
  colorWrite: false, depthWrite: false, transparent: true, fog: false,
  stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilRef: UNAFFECTED, stencilWriteMask: UNAFFECTED,
  stencilZPass: THREE.ReplaceStencilOp,
});
const flip = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide, colorWrite: false, depthWrite: false, transparent: true, fog: false,
  stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 0, stencilFuncMask: UNAFFECTED,
  stencilWriteMask: 1, stencilZPass: THREE.InvertStencilOp,
});
const collect = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide, colorWrite: false, depthWrite: false, depthTest: false, transparent: true, fog: false,
  stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 1, stencilFuncMask: 1,
  stencilZPass: THREE.IncrementStencilOp,
});
const darken = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide, color: 0x000000, opacity: 0.5, transparent: true, depthWrite: false, depthTest: false,
  fog: false, stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 0, stencilFuncMask: 0x7E,
  stencilZPass: THREE.ZeroStencilOp,
});

/** One piece's volume this frame, in the body's frame: [x, y, z, ...] triangles (see the header). */
export function pieceVolume(piece, light, out) {
  const { vertices, faces, normals, edges, faceEdges } = piece;
  const [lx, ly, lz] = light;
  const used = new Uint8Array(edges.length);
  let n = 0;
  const put = (k, far) => {
    out[n++] = vertices[3 * k] - (far ? lx * LENGTH : 0);
    out[n++] = vertices[3 * k + 1] - (far ? ly * LENGTH : 0);
    out[n++] = vertices[3 * k + 2] - (far ? lz * LENGTH : 0);
  };
  for (let f = 0; f < faces.length; f++) {
    const [nx, ny, nz] = normals[f];
    if (!(nx * lx + ny * ly + nz * lz < 0)) continue;
    for (const e of faceEdges[f]) used[e]++;
    for (const far of [false, true]) for (const k of faces[f]) put(k, far);
  }
  for (let e = 0; e < edges.length; e++) {
    if (used[e] !== 1) continue;
    const [a, b] = edges[e];
    put(a, false); put(b, false); put(b, true);
    put(a, false); put(b, true); put(a, true);
  }
  return n / 3;
}

export class CabShadow {
  /**
   * @param {THREE.Scene} scene
   * @param {object} gltf the cab GLB (its "shadow" scene)
   * @param {import('./dc-car.js').DreamcastCar} car
   * @param {THREE.Object3D} model the drawn cab (its parts' node extras "shadowed")
   */
  constructor(scene, gltf, car, model) {
    this.car = car;
    const box1 = car.cpu.r32(COURSE_MODE) === 2 && car.cpu.r32(MINI_GAME_NO) === 1;
    car.call(SET_LIGHT, { r4: 0x2200, r5: box1 ? 0x6100 : 0x2900 });
    this.light = new THREE.Vector3(car.cpu.rf(LIGHT), car.cpu.rf(LIGHT + 4), car.cpu.rf(LIGHT + 8));
    const unaffected = [];
    model.traverse((o) => {
      let p = o;
      while (p && p.userData.shadowed === undefined) p = p.parent;
      if (o.isMesh && p && p.userData.shadowed === 0) unaffected.push(o);
    });
    for (const o of unaffected) {
      const mesh = new THREE.Mesh(o.geometry, shield);
      mesh.renderOrder = ORDER - 1;
      o.add(mesh);
    }
    this.unaffected = unaffected.length;
    this.group = new THREE.Group();
    this.group.name = 'cab-shadow';
    this.group.matrixAutoUpdate = false;
    this.pieces = [];
    const source = gltf.scenes.find((s) => s.name === 'shadow');
    const meshes = [];
    if (source) source.traverse((o) => { if (o.isMesh) meshes.push(o); });
    meshes.forEach((o, i) => {
      const g = o.geometry, d = o.userData;
      const faces = [];
      for (let k = 0; k < g.index.count; k += 3) faces.push([g.index.getX(k), g.index.getX(k + 1), g.index.getX(k + 2)]);
      const piece = { vertices: Array.from(g.attributes.position.array), faces, normals: d.normals, edges: d.edges, faceEdges: d.face_edges };
      const buffer = new Float32Array((2 * faces.length + 2 * piece.edges.length) * 9);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(buffer, 3).setUsage(THREE.DynamicDrawUsage));
      for (const [material, order] of [[flip, ORDER + 2 * i], [collect, ORDER + 2 * i + 1], [darken, ORDER + 2 * meshes.length]]) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = order;
        mesh.frustumCulled = false;
        this.group.add(mesh);
      }
      this.pieces.push({ piece, geometry, buffer });
    });
    scene.add(this.group);
    this.rotation = new THREE.Matrix4();
    this.local = new THREE.Vector3();
  }

  /** The body's matrix as putPlayerCar builds it, and every piece's volume for the light. */
  update() {
    const cpu = this.car.cpu, m = this.group.matrix, r = this.rotation, t = new THREE.Matrix4();
    const angle = (o) => cpu.rs16(CAR + o) * TURN;
    r.makeRotationY(angle(0x86))
      .multiply(t.makeRotationX(angle(0x84))).multiply(t.makeRotationZ(angle(0x88)))
      .multiply(t.makeRotationX(angle(0xAC))).multiply(t.makeRotationZ(angle(0xB0)));
    m.makeTranslation(cpu.rf(CAR + 0x78), cpu.rf(CAR + 0x7C), cpu.rf(CAR + 0x80)).multiply(r)
      .multiply(t.makeTranslation(0, -BODY_DROP, 0));
    this.group.matrixWorldNeedsUpdate = true;
    // The light in the body's frame: the rotation's transpose (0x0C077990) times the light.
    const l = this.local.copy(this.light).applyMatrix4(r.transpose());
    const light = [l.x, l.y, l.z];
    for (const p of this.pieces) {
      const count = pieceVolume(p.piece, light, p.buffer);
      p.geometry.setDrawRange(0, count);
      p.geometry.attributes.position.needsUpdate = true;
    }
  }
}
