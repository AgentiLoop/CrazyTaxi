// Mod: "Spidey", a 5th driver. He drives Axel's cab (cab 0) as Axel's figure (character 1,
// local-assets/characters/characters/char_01.glb) in a red and blue web suit: each part's
// own texture kept as shading (its luminance) under the suit colour, black web lines over
// the red parts, Axel's hair hidden and white eyes on the mask. Y puts him in (src/main.js,
// src/boot.js); ?driver=spidey carries him from the driver select into the city.
import * as THREE from 'three';

export const SPIDEY_CHARACTER = 1;   // Axel's figure: the driver of cab 0 (FcvPlayBuffer's character = cab + 1)
export const SPIDEY_CAB = 0;         // Axel's cab

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
