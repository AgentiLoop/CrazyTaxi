// The navigation arrow while a customer is aboard: the game's own model (POLDC0.BIN
// 0xDBAB8, "Arrow", 30 vertices: a flat four-sided head on an octagonal shaft, tip at
// -z, 0.25 long at scale 1) the way ExecArrow (decomp gen_mh.c) draws it: at (0, 20, -70)
// in CAMERA space (70 in front of the eye, 20 up - over the cab's nose from the chase
// camera), scale 100, turned by the shortest rotation from its axis to the direction of
// the destination (so it also tilts down a little as the stop gets close), roll 0.
// Its colour is the fade colour the caller sets from the distance to the stop
// (0x0C0E37A0 USA, five RGB steps from 200 to 1800): red, orange, yellow, lime, green.
// It is lit (nlObjPutSetLightDirectionV), the one lit object in the unlit city: a
// directional light along the game's light (SetLight, toward (0.567, 0.741, 0.359)).
// The fly-in (a Bezier from far ahead) and the spin at the stop are not reproduced.
import * as THREE from 'three';
import { loadGltf } from './scene.js';

export const ARROW_MODEL = 'models/POLDC0/0dbab8.glb';
const ARROW_SCALE = 100;
const ARROW_AT = new THREE.Vector3(0, 20, -70);   // camera space
const AXIS = new THREE.Vector3(0, 0, -1);          // the model's tip
const COLOURS = [[1, 0, 0], [1, 0.4, 0], [1, 1, 0], [0.7, 1, 0.1], [0, 1, 0.35]];

/** The arrow's colour at a distance from the stop (the caller's fade colour). */
export function arrowColour(distance) {
  const t = Math.min(4, Math.max(0, (distance - 200) / 1600 * 4));
  const i = Math.min(3, Math.floor(t)), f = t - i;
  const a = COLOURS[i], b = COLOURS[i + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

export class NavArrow {
  constructor(scene, assets) {
    this.material = new THREE.MeshLambertMaterial({ color: 0x00ff59, fog: false });
    this.mesh = new THREE.Group();
    this.mesh.visible = false;
    this.mesh.scale.setScalar(ARROW_SCALE);
    scene.add(this.mesh);
    this.ready = loadGltf(assets + ARROW_MODEL).then((gltf) => {
      gltf.scene.traverse((o) => { if (o.isMesh) { o.material = this.material; o.renderOrder = 1; } });
      this.mesh.add(gltf.scene);
    });

    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(0.567, 0.741, 0.359);
    scene.add(light, new THREE.AmbientLight(0xffffff, 0.9));
    this._dir = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._inv = new THREE.Quaternion();
  }

  /**
   * @param camera the game's camera, already placed for this frame (GameCamera.apply)
   * @param pos the cab's drawn position (the distance for the colour)
   * @param target the destination's centre [x, y, z], or null to hide the arrow
   */
  update(camera, pos, target) {
    this.mesh.visible = !!target;
    if (!target) return;
    camera.updateMatrixWorld();
    this.mesh.position.copy(ARROW_AT).applyMatrix4(camera.matrixWorld);
    // The shortest rotation from the tip to the stop, in camera space (nlRotateV), then the camera's.
    this._inv.copy(camera.quaternion).invert();
    this._dir.set(target[0], target[1], target[2]).sub(this.mesh.position).applyQuaternion(this._inv).normalize();
    this._q.setFromUnitVectors(AXIS, this._dir);
    this.mesh.quaternion.copy(camera.quaternion).multiply(this._q);
    const d = Math.hypot(target[0] - pos.x, target[1] - pos.y, target[2] - pos.z);
    this.material.color.setRGB(...arrowColour(d));
  }
}
