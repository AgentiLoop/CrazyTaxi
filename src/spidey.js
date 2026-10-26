// Mod: "Spidey", a 5th driver. He drives Axel's cab (cab 0) as Axel's figure (character 1,
// local-assets/characters/characters/char_01.glb) in a red and blue web suit: each part's
// own texture kept as shading (its luminance) under the suit colour, black web lines over
// the red parts, Axel's hair hidden and white eyes on the mask. Y puts him in (src/main.js,
// src/boot.js); ?driver=spidey carries him from the driver select into the city.
import * as THREE from 'three';
import { loadGltf, makeUnlit } from './scene.js';
import { spmanSkin } from './spman.js';

export const SPIDEY_CHARACTER = 1;   // Axel's figure: the driver of cab 0 (FcvPlayBuffer's character = cab + 1)
export const SPIDEY_CAB = 0;         // Axel's cab
// Y goes Axel ('') -> SPIDEY ('spidey', this suit) -> SPMAN ('spman', src/spman.js) -> Axel; ?driver= carries it.
const DRIVERS = ['', 'spidey', 'spman'];
export const nextDriver = (driver) => DRIVERS[(DRIVERS.indexOf(driver) + 1) % DRIVERS.length];
export const driverParam = (value) => (DRIVERS.includes(value) ? value : '');

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

/** Repaints a loaded character model (from makeUnlit) as Spidey, in place; returns it. */
export function spideySkin(root) {
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

export const AXEL_HEAD_SHOT = 94;      // SPRCOMM 94: Axel's head shot card (128 x 128)
export const AXEL_BW_HEAD_SHOT = 395;  // SPRGAME 155: Axel's black and white head shot (64 x 64, grey ground)

/**
 * Spidey's head shots in the place of Axel's: the colour card (SPRCOMM 94: a 3 px #c5c5c5 rim
 * with round corners about a white ground) and the black and white one (SPRGAME 155: grey
 * ground), the suited model's head filling them as the others' do, upside down as the extracted
 * PNGs are. driver 'spman': SPMAN's head (src/spman.js). Resolves to { small: 128 x 128 Image,
 * big: 512 x 512 canvas, bwSmall: 64 x 64 Image, bwBig: 512 x 512 canvas }.
 */
export async function spideyHeadShot(assets, driver = 'spidey') {
  const g = await loadGltf(`${assets}characters/characters/char_${SPIDEY_CHARACTER.toString(16).padStart(2, '0')}.glb`);
  const root = driver === 'spman' ? await spmanSkin(makeUnlit(g.scene), assets) : spideySkin(makeUnlit(g.scene));
  root.updateMatrixWorld(true);
  let head = null;
  root.traverse((o) => { if (!head && o.name.startsWith('head_') && !o.name.startsWith('head_extra')) head = o; });
  const sphere = root.userData.spmanHead || new THREE.Box3().setFromObject(head).getBoundingSphere(new THREE.Sphere());
  // The head bone's axes: +x where the face looks, +y up the head; seen a little from one side.
  const e = head.parent.matrixWorld.elements;
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const look = new THREE.Vector3(e[0], e[1], e[2]).normalize().applyAxisAngle(up, 0.35);
  // Framed as close as the other drivers' cards: the head fills the card, the neck at its foot.
  // SPMAN's head sits lower in its sphere: aim lower so his head rides higher in the card.
  const target = sphere.center.clone().addScaledVector(up, (driver === 'spman' ? 0.02 : 0.25) * sphere.radius);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.copy(target).addScaledVector(look, (driver === 'spman' ? 3.0 : 2.3) * sphere.radius);
  camera.up.copy(up);
  camera.lookAt(target);
  const scene = new THREE.Scene();
  scene.add(root);
  const S = 512;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(S, S, false);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  const card = (ground, rim, size, radius, bw) => {
    const big = document.createElement('canvas');
    big.width = big.height = S;
    const c = big.getContext('2d');
    const k = S / size;
    c.translate(0, S); c.scale(1, -1);   // upside down
    const shape = (inset, r) => { c.beginPath(); c.roundRect(inset * k, inset * k, S - 2 * inset * k, S - 2 * inset * k, r * k); };
    if (rim) { shape(0, radius); c.fillStyle = rim; c.fill(); }
    shape(rim ? 3 : 0, rim ? radius - 3 : radius); c.fillStyle = ground; c.fill(); c.clip();
    c.drawImage(renderer.domElement, 0, 0, S, S);
    if (bw) {
      const px = c.getImageData(0, 0, S, S), d = px.data;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      c.putImageData(px, 0, 0);
    }
    const small = document.createElement('canvas');
    small.width = small.height = size;
    const s = small.getContext('2d');
    s.imageSmoothingQuality = 'high';
    s.drawImage(big, 0, 0, size, size);
    const im = new Image();
    im.src = small.toDataURL();
    return im.decode().then(() => ({ small: im, big }));
  };
  const colour = await card('#fff', '#c5c5c5', 128, 14, false);
  const bw = await card('#bdbebd', null, 64, 4, true);
  renderer.dispose();
  renderer.forceContextLoss();
  return { ...colour, bwSmall: bw.small, bwBig: bw.big };
}

