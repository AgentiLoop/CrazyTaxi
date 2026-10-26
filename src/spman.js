// Mod: "SPMAN", the Y key's second driver: Spider-Man 2000's own Spider-Man (spidey.PSX,
// local-assets/characters/spman/ by tools/extract_spman.py) in Axel's place, after Spidey
// (src/spidey.js). Y goes Axel -> SPIDEY -> SPMAN -> Axel.
//
// His 16 parts keep their own skeleton (sp1's joints, scaled to the figure: ankles to neck
// as the figure's) and are moved by the Crazy Taxi figure's bones: each part turns as its
// bone turns from the figure's standing pose (the glb's own) and hangs from its parent part
// at sp1's joint, so the joints stay closed whatever the proportions. His reference pose
// (sp1's anim 132 frame 0) stands as the figure's does; the limbs are first turned onto the
// figure's limbs (upper arm, forearm, thigh, shin), the rest kept as they are.
import * as THREE from 'three';
import { releaseImage } from './scene.js';

// sp1 part -> the figure's bone (local-assets/characters manifest names: bone_15 hips,
// bone_8 torso, bone_1 head; arms 4/3/2 left, 7/6/5 right; legs 11/10/9 left, 14/13/12 right).
// sp1's +x is his left (the figure's -x).
const BONE = { 0: 15, 2: 8, 1: 8, 7: 1, 4: 4, 3: 3, 6: 2, 9: 7, 8: 6, 11: 5, 16: 11, 15: 10, 17: 9, 13: 14, 12: 13, 14: 12 };
// The limbs turned onto the figure's: sp1 part -> its child part (the far joint).
const LIMB = { 4: 3, 3: 6, 9: 8, 8: 11, 16: 15, 15: 17, 13: 12, 12: 14 };
const NECK = 7, ANKLES = [14, 17];

let loaded = null;   // assets URL -> Promise<{ data, materials }>
function load(assets) {
  if (!loaded || loaded.assets !== assets) {
    const dir = `${assets}characters/spman/`;
    const p = fetch(`${dir}spman.json`).then((r) => {
      if (!r.ok) throw new Error(`spman.json: HTTP ${r.status}`);
      return r.json();
    }).then(async (data) => {
      const loader = new THREE.TextureLoader();
      const maps = await Promise.all(data.textures.map((t) => loader.loadAsync(releaseImage(dir + t.file)).then((tex) => {
        tex.flipY = false;   // rows top-down, uv (0, 0) the first row
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })));
      const materials = data.textures.map((t, i) => new THREE.MeshBasicMaterial({ map: maps[i], side: THREE.DoubleSide, alphaTest: t.alpha ? 0.5 : 0 }));
      materials.push(new THREE.MeshBasicMaterial({ color: 0x808080, side: THREE.DoubleSide }));   // untextured faces
      return { data, materials };
    });
    loaded = { assets, p };
  }
  return loaded.p;
}

/**
 * Puts SPMAN on a loaded figure (makeUnlit'd glb scene: bone_0..15 with the parts as child
 * meshes): the figure's meshes are hidden and his skinned mesh added. Resolves to root.
 * root.userData.spmanHead: his head's bounding sphere in the figure's space (the head shot).
 */
export async function spmanSkin(root, assets) {
  const { data, materials } = await load(assets);
  root.updateMatrixWorld(true);
  const toModel = root.matrixWorld.clone().invert();
  const bones = new Map();
  root.traverse((o) => {
    if (o.name.startsWith('bone_')) bones.set(+o.name.slice(5), o);
    else if (o.isMesh) o.visible = false;
  });
  const rest = new Map([...bones].map(([b, o]) => [b, toModel.clone().multiply(o.matrixWorld)]));   // the standing pose, figure space
  const at = (b) => new THREE.Vector3().setFromMatrixPosition(rest.get(b));

  // sp1 (x his left, y down, z back) -> the figure's (x right, y up, z back), scaled ankles to neck, hips on the figure's.
  const J = data.joints;
  const ankle = (J[ANKLES[0]][1] + J[ANKLES[1]][1]) / 2;
  const k = (at(1).y - (at(9).y + at(12).y) / 2) / (ankle - J[NECK][1]);
  const hips = at(15), j0 = J[0];
  const map = (x, y, z, out = new THREE.Vector3()) => out.set(-(x - j0[0]) * k + hips.x, -(y - j0[1]) * k + hips.y, (z - j0[2]) * k + hips.z);
  const joints = J.map(([x, y, z]) => map(x, y, z));

  const n = data.parts.length;
  const position = new Float32Array(n * 3), skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    map(data.positions[3 * i], data.positions[3 * i + 1], data.positions[3 * i + 2], v).toArray(position, 3 * i);
    skinIndex[4 * i] = data.parts[i];
    skinWeight[4 * i] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  for (const g of data.groups) geometry.addGroup(g.start, g.count, g.texture < 0 ? materials.length - 1 : g.texture);

  // One bone per sp1 part, posed in world space by the rig after the figure's bones.
  const parts = J.map(() => {
    const b = new THREE.Bone();
    b.matrixAutoUpdate = false;
    b.matrixWorldAutoUpdate = false;
    return b;
  });
  const turn = J.map((_, p) => {   // the limbs onto the figure's limbs, figure space
    const q = new THREE.Matrix4();
    const c = LIMB[p];
    if (c !== undefined) {
      const from = joints[c].clone().sub(joints[p]).normalize();
      const to = at(BONE[c]).sub(at(BONE[p])).normalize();
      q.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(from, to));
    }
    return q;
  });
  const order = [];   // parents before children
  const visit = (p) => { if (BONE[p] !== undefined && !order.includes(p)) { if (p) visit(data.hierarchy[p]); order.push(p); } };
  for (let p = 0; p < J.length; p++) visit(p);
  const restInverse = new Map([...rest].map(([b, m]) => [b, m.clone().invert()]));

  const rig = new THREE.Object3D();
  const delta = J.map(() => new THREE.Matrix4()), linear = J.map(() => new THREE.Matrix3()), pos = J.map(() => new THREE.Vector3());
  const unjoint = joints.map((j) => new THREE.Matrix4().makeTranslation(-j.x, -j.y, -j.z));
  const off = new THREE.Vector3(), m = new THREE.Matrix4();
  rig.updateMatrixWorld = function (force) {
    THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
    for (const p of order) {
      // the bone's turn from its standing pose (world), then the limb's own turn onto the figure's
      delta[p].multiplyMatrices(bones.get(BONE[p]).matrixWorld, restInverse.get(BONE[p])).multiply(turn[p]);
      linear[p].setFromMatrix4(delta[p]);
      if (p === 0) pos[p].copy(joints[0]).applyMatrix4(delta[p]);
      else {
        // hung from the parent part at sp1's joint
        const q = data.hierarchy[p];
        pos[p].copy(pos[q]).add(off.subVectors(joints[p], joints[q]).applyMatrix3(linear[q]));
      }
      // part p's point x (figure's standing space) -> pos + linear(delta) (x - joint)
      parts[p].matrixWorld.copy(delta[p]).setPosition(0, 0, 0)
        .premultiply(m.makeTranslation(pos[p].x, pos[p].y, pos[p].z))
        .multiply(unjoint[p]);
    }
  };
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.name = 'spman';
  mesh.frustumCulled = false;
  mesh.bind(new THREE.Skeleton(parts, parts.map(() => new THREE.Matrix4())), new THREE.Matrix4());
  rig.add(...parts);
  root.add(rig, mesh);   // after the figure's bones: they are posed before the rig reads them

  const head = new THREE.Box3();
  for (let i = 0; i < n; i++) if (data.parts[i] === NECK) head.expandByPoint(v.fromArray(position, 3 * i));
  root.userData.spmanHead = head.getBoundingSphere(new THREE.Sphere());
  return root;
}
