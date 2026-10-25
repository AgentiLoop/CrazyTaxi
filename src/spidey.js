// Mod: "Spidey", a 5th driver. He drives Axel's cab (cab 0) as Axel's figure (character 1,
// local-assets/characters/characters/char_01.glb). With local-assets/spidey/spiderman.glb
// (Spider-Man 2's own SPIDERMAN mesh record: a 60-bone skinned body, with spiderman.png)
// Axel's parts are hidden and that body is skinned onto his 16 bones (spiderman() below);
// without it Axel is painted in a red and blue web suit: each part's own texture kept as
// shading (its luminance) under the suit colour, black web lines over the red parts, Axel's
// hair hidden and white eyes on the mask. Y puts him in (src/main.js, src/boot.js);
// ?driver=spidey carries him from the driver select into the city.
import * as THREE from 'three';
import { loadGltf } from './scene.js';

export const SPIDEY_CHARACTER = 1;   // Axel's figure: the driver of cab 0 (FcvPlayBuffer's character = cab + 1)
export const SPIDEY_CAB = 0;         // Axel's cab

// The Spider-Man 2 body's 60 joints (its .XBSKEL hierarchy, as in the sp2 prototype's RIG):
// the Axel part each joint group follows and the joint whose bind position is pinned to that
// part's bone. 0 pelvis, 1-4 spine to neck, 5 head, 7/28 clavicles, 8-10 and 29-31 the arms,
// 11-25 and 32-46 fingers, 52-55 and 56-59 the legs; 6, 26, 27, 47-51 helpers (nearest joint's
// group). The arms and legs are matched to Axel's left and right by side, not by name.
const GROUPS = [
  { part: 'hips', anchor: 0, joints: [0] },
  { part: 'torso', anchor: 0, joints: [1, 2, 3, 4, 7, 28] },
  { part: 'head', anchor: 4, joints: [5] },
  ...[[8, 9, 10, 11], [29, 30, 31, 32]].flatMap(([u, f, h, k]) => [
    { part: 'upper_arm', anchor: u, joints: [u] }, { part: 'forearm', anchor: f, joints: [f] },
    { part: 'hand', anchor: h, joints: [h, ...Array.from({ length: 15 }, (_, i) => k + i)] }]),
  ...[52, 56].flatMap((t) => [
    { part: 'thigh', anchor: t, joints: [t] }, { part: 'shin', anchor: t + 1, joints: [t + 1] },
    { part: 'foot', anchor: t + 2, joints: [t + 2, t + 3] }]),
];
const HELPERS = [6, 26, 27, 47, 48, 49, 50, 51];
const TEXTURE_GAIN = 4;   // the `spiderman` DXT1 texture is stored at about a quarter intensity (sp2 play.mjs)
const SUIT_RED = [235, 20, 30], SUIT_BLUE = [25, 70, 235];   // the body's suit colours (sRGB, 0-255)
const WEB_GAIN = 1.5;     // the grey web lines' gain (darker than TEXTURE_GAIN's full intensity)
// The eye lens in the texture (u, v), its grey painted white (the black rim kept).
const EYE = [[200, 48], [211, 48], [231, 65], [232, 69], [220, 83], [214, 84], [209, 77], [204, 72], [200, 62]]
  .map(([x, y]) => [x / 512, y / 256]);

let body = null;   // the loaded Spider-Man 2 GLB (null: not in local-assets/)
function loadBody(assets) {
  if (!body) body = loadGltf(`${assets}spidey/spiderman.glb`).catch(() => null);
  return body;
}


const RED = new THREE.Color(0xd01820), BLUE = new THREE.Color(0x1a3fb8);
// Mesh name prefix -> suit colour and whether the web lines are drawn (red parts only).
const PARTS = [
  ['head_extra', null],              // Axel's hair: hidden under the mask
  ['head', RED], ['torso', RED], ['left_forearm', RED], ['right_forearm', RED],
  ['left_hand', RED], ['right_hand', RED], ['left_foot', RED], ['right_foot', RED],
  ['left_upper_arm', BLUE], ['right_upper_arm', BLUE], ['hips', BLUE],
  ['left_thigh', BLUE], ['right_thigh', BLUE], ['left_shin', BLUE], ['right_shin', BLUE],
];

function suit(material, color, web) {
  const m = material.clone();
  m.color = new THREE.Color(1, 1, 1);
  m.vertexColors = false;
  m.onBeforeCompile = (s) => {
    s.uniforms.suit = { value: color };
    s.fragmentShader = `uniform vec3 suit;\n${s.fragmentShader}`.replace('#include <map_fragment>', `#include <map_fragment>
      float shade = clamp(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) * 0.8 + 0.45, 0.35, 1.15);
      diffuseColor.rgb = suit * shade;
      ${web ? `#ifdef USE_MAP
      vec2 g = abs(fract(vMapUv * 10.0) - 0.5);
      float line = 1.0 - smoothstep(0.42, 0.47, max(g.x, g.y));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), 1.0 - line);
      #endif` : ''}`);
  };
  m.customProgramCacheKey = () => `spidey:${color.getHexString()}:${web}`;
  return m;
}

/**
 * Puts Spidey in a loaded character model (Axel's, from makeUnlit), in place; resolves to it:
 * the Spider-Man 2 body skinned onto Axel's bones, or (without that GLB) Axel painted.
 */
export async function spideySkin(root, assets) {
  const gltf = await loadBody(assets);
  return gltf ? spiderman(root, gltf) : paint(root);
}

/**
 * Axel's parts hidden and the Spider-Man 2 body added in their place, each of its 60 joints a
 * bone under the Axel bone of its group, so his motions move it. The body is fitted to Axel's
 * rest pose part by part: turned to face his way and scaled to his height, each group's anchor
 * joint put on its Axel bone's origin, a limb turned onto Axel's limb (Spider-Man's T-pose arms
 * come down to Axel's sides) and stretched to its length; hands and feet are turned onto the
 * line from the wrist or ankle to the middle of Axel's hand or foot.
 */
function spiderman(root, gltf) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const boneOf = (o) => { while (o && !o.name.startsWith('bone_')) o = o.parent; return o; };
  const inRoot = (o) => m.multiplyMatrices(toRoot, o.matrixWorld).clone();

  // Axel's parts (name without its address -> bone, bone origin, child bone origin, vertex centroid).
  const axel = new Map();
  let low = Infinity, high = -Infinity;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    o.visible = false;
    const node = o.parent && !o.parent.name.startsWith('bone_') ? o.parent : o;   // a multi-primitive part loads as a Group
    if (o.name.includes('#blend') || node.name.includes('_extra')) continue;
    const name = node.name.replace(/_[0-9a-f]+$/, ''), bone = boneOf(node);
    if (!axel.has(name)) {
      const child = bone.children.find((c) => c.name.startsWith('bone_'));
      axel.set(name, { bone, at: v.setFromMatrixPosition(inRoot(bone)).clone(),
        to: child && new THREE.Vector3().setFromMatrixPosition(inRoot(child)), sum: new THREE.Vector3(), n: 0 });
    }
    const p = axel.get(name), pos = o.geometry.attributes.position, world = inRoot(o);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(world);
      p.sum.add(v); p.n++;
      low = Math.min(low, v.y); high = Math.max(high, v.y);
    }
  }
  for (const p of axel.values()) p.centroid = p.sum.divideScalar(p.n);

  // The body: spiderman000's sections (spiderman001/002 are not the figure), their joint bind positions.
  const sections = [];
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh && o.skeleton.bones[0].name.startsWith('spiderman000_')) sections.push(o); });
  const joints = sections[0].skeleton.boneInverses.map((b) => new THREE.Vector3().setFromMatrixPosition(b.clone().invert()));
  const group = new Array(joints.length);
  GROUPS.forEach((g, i) => { for (const j of g.joints) group[j] = i; });
  for (const h of HELPERS) {
    let best = 0;
    joints.forEach((p, j) => { if (!HELPERS.includes(j) && p.distanceTo(joints[h]) < joints[best].distanceTo(joints[h])) best = j; });
    group[h] = group[best];
  }
  const sp = GROUPS.map(() => ({ sum: new THREE.Vector3(), n: 0 }));
  let spLow = Infinity, spHigh = -Infinity;
  for (const s of sections) {
    const pos = s.geometry.attributes.position, ji = s.geometry.attributes.skinIndex, wi = s.geometry.attributes.skinWeight;
    for (let i = 0; i < pos.count; i++) {
      let k = 0;
      for (let c = 1; c < 4; c++) if (wi.getComponent(i, c) > wi.getComponent(i, k)) k = c;
      v.fromBufferAttribute(pos, i);
      const g = sp[group[ji.getComponent(i, k)]];
      g.sum.add(v); g.n++;
      spLow = Math.min(spLow, v.y); spHigh = Math.max(spHigh, v.y);
    }
  }
  for (const g of sp) g.centroid = g.n ? g.sum.divideScalar(g.n) : null;

  // Facing (the feet point forward, y is up in both) and sides.
  const flat = (a) => new THREE.Vector3(a.x, 0, a.z).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const axelFoot = axel.get('left_foot'), spFoot = GROUPS.findIndex((g) => g.part === 'foot');
  const axelForward = flat(axelFoot.centroid.clone().sub(axelFoot.at));
  const spForward = flat(sp[spFoot].centroid.clone().sub(joints[GROUPS[spFoot].anchor]));
  const turn = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(spForward, axelForward));
  const axelLeft = up.clone().cross(axelForward), spLeft = up.clone().cross(spForward);
  const pelvis = joints[0], axelPelvis = axel.get('hips').at;
  const side = (j) => {   // 'left_' or 'right_': the Axel side the joint is on
    const s = Math.sign(joints[j].clone().sub(pelvis).dot(spLeft));
    return s === Math.sign(axel.get('left_hand').at.clone().sub(axelPelvis).dot(axelLeft)) ? 'left_' : 'right_';
  };
  const scale = (high - low) / (spHigh - spLow);

  // Each group's fit: Spider-Man 2 bind space -> Axel's root space, and its bones.
  const bones = new Array(joints.length), inverses = new Array(joints.length);
  GROUPS.forEach((g, i) => {
    const limb = !['hips', 'torso', 'head'].includes(g.part);
    const a = axel.get(limb ? side(g.anchor) + g.part : g.part);
    const fit = new THREE.Matrix4().makeTranslation(-joints[g.anchor].x, -joints[g.anchor].y, -joints[g.anchor].z)
      .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale)).premultiply(turn);
    if (limb) {
      const next = GROUPS[i + 1] && g.part !== 'hand' && g.part !== 'foot' ? joints[GROUPS[i + 1].anchor] : sp[i].centroid;
      const from = next.clone().applyMatrix4(fit), to = (a.to && g.part !== 'hand' && g.part !== 'foot' ? a.to : a.centroid).clone().sub(a.at);
      const d = to.clone().normalize();
      fit.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), d)));
      if (g.part !== 'hand' && g.part !== 'foot') {   // stretched along the limb to Axel's length
        const k = to.length() / from.length() - 1;
        fit.premultiply(new THREE.Matrix4().set(
          1 + k * d.x * d.x, k * d.x * d.y, k * d.x * d.z, 0,
          k * d.y * d.x, 1 + k * d.y * d.y, k * d.y * d.z, 0,
          k * d.z * d.x, k * d.z * d.y, 1 + k * d.z * d.z, 0, 0, 0, 0, 1));
      }
    }
    fit.premultiply(new THREE.Matrix4().makeTranslation(a.at.x, a.at.y, a.at.z));
    const inverse = inRoot(a.bone).invert().multiply(fit);
    for (const j of joints.keys()) {
      if (group[j] !== i) continue;
      bones[j] = new THREE.Bone();
      bones[j].name = `spidey_${j}`;
      a.bone.add(bones[j]);
      inverses[j] = inverse;
    }
  });

  // The suit's texture at its full intensity (8-bit texels x TEXTURE_GAIN, clamped), its red and
  // blue texels repainted bright red and blue (their brightness kept as shading), the web lines dark grey (x WEB_GAIN).
  const map = sections[0].material.map, canvas = document.createElement('canvas');
  canvas.width = map.image.width; canvas.height = map.image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(map.image, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height), d = px.data;
  const eye = new Path2D();   // the eye lens's outline (both eyes share these texels)
  for (const [u, v] of EYE) eye.lineTo(u * canvas.width, v * canvas.height);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let target = null, shade = 0;
    if (r > 1.3 * Math.max(g, b, 4)) { target = SUIT_RED; shade = r * TEXTURE_GAIN / 200; }
    else if (b > 1.3 * Math.max(r, 4) && b >= g) { target = SUIT_BLUE; shade = b * TEXTURE_GAIN / 160; }
    const x = (i / 4) % canvas.width + 0.5, y = Math.floor(i / 4 / canvas.width) + 0.5;
    if (target) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, target[c] * Math.min(1, 0.25 + 0.85 * shade));
    else if (ctx.isPointInPath(eye, x, y)) d[i] = d[i + 1] = d[i + 2] = 255 * Math.min(1, Math.max(0, (Math.max(r, g, b) - 20) / 20));
    else for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] * WEB_GAIN);
  }
  ctx.putImageData(px, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = map.flipY; texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = map.wrapS; texture.wrapT = map.wrapT;
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });

  const skeleton = new THREE.Skeleton(bones, inverses);
  for (const s of sections) {
    const mesh = new THREE.SkinnedMesh(s.geometry, material);
    mesh.name = 'spidey_body';
    mesh.frustumCulled = false;   // the bounds are the bind pose's
    root.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
  }
  return root;
}

/** Repaints a loaded character model (from makeUnlit) as Spidey, in place; returns it. */
function paint(root) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && !o.name.includes('#blend')) meshes.push(o); });
  let head = null;
  for (const o of meshes) {
    const node = o.parent && !o.parent.name.startsWith('bone_') ? o.parent : o;   // a multi-primitive part loads as a Group
    const part = PARTS.find(([p]) => node.name.startsWith(p));
    if (!part) continue;
    const [name, color] = part;
    if (!color) { node.visible = false; continue; }
    if (name === 'head' && !head) head = node;
    const web = color === RED;
    o.material = Array.isArray(o.material) ? o.material.map((m) => suit(m, color, web)) : suit(o.material, color, web);
    for (const c of o.children) c.visible = false;   // the blended passes would show Axel's colours
  }
  if (head) {
    // The mask's eyes: white with a black rim, on the face (+x in the head bone, where the nose points).
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff }), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const side of [-1, 1]) {
      for (const [material, r, x] of [[black, 0.3, 1.08], [white, 0.24, 1.12]]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), material);
        eye.scale.set(0.3, 1.05, 0.8);
        eye.position.set(x, 1.75, side * 0.36);
        eye.rotation.x = side * 0.5;
        head.parent.add(eye);
      }
    }
  }
  return root;
}
