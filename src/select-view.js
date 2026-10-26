// The driver select's 3D part: the driver figure the game draws with
// humanDraw(motion, character, frame) (DreamcastMenu.draws kind 'human', with XMTRX,
// the figure's world matrix), drawn by three.js into its own canvas that MenuView puts
// at the figure's depth (~1/33): over the driver's art (1/z ~0.002), under the help
// bar and the timer (1/z = 1). The camera is the game's: the view matrix CarSel_Camera stores and
// nd_CarSelInit's projection, both used as they are.
//
// The figure is the extracted character (local-assets/characters/characters/char_NN.glb,
// NN = the character index in hex: bone_0..15 with the parts as child meshes) posed by
// its motions.glb clip (the clip name is the motion's address, characters/manifest.json
// `motions`). humanDraw's frame f is played as record f mod (frames - 1) + 1, as the
// V motions are (VSklPlay): the clip's key f mod (frames - 1) at 30 keys a second.
import * as THREE from 'three';
import { loadGltf, makeUnlit } from './scene.js';
import { spideySkin } from './spidey.js';
import { spmanSkin } from './spman.js';

const KEYS_PER_SECOND = 30;

export class SelectView {
  /** @param {string} assets the local-assets/ URL */
  constructor(assets) {
    this.assets = assets;
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.clips = null;                 // motion address -> { clip, frames }
    this.figures = new Map();          // character (or 'spidey:' / 'spman:' character) -> { group, mixer, actions } (null while loading)
    this.spidey = '';                  // the mod: the figure drawn as 'spidey' (src/spidey.js) or 'spman' (src/spman.js; the select's Axel is its own character)
    this.ready = Promise.all([
      fetch(`${assets}characters/manifest.json`).then((r) => r.json()),
      loadGltf(`${assets}characters/motions.glb`),
    ]).then(([manifest, gltf]) => {
      const byName = new Map(gltf.animations.map((c) => [c.name, c]));
      this.clips = new Map();
      for (const m of manifest.motions) {
        const clip = byName.get(m.name);
        if (clip) this.clips.set(m.address, { clip, frames: m.frames });
      }
    });
  }

  /** Spidey or SPMAN in ('spidey' / 'spman': the figures are drawn as him) or out (''). */
  setSpidey(driver) {
    this.spidey = driver;
  }

  figure(character) {
    const spidey = this.spidey, key = spidey ? `${spidey}:${character}` : character;
    if (!this.figures.has(key)) {
      this.figures.set(key, null);
      loadGltf(`${this.assets}characters/characters/char_${character.toString(16).padStart(2, '0')}.glb`).then(async (g) => {
        const body = spidey === 'spman' ? await spmanSkin(makeUnlit(g.scene), this.assets) : spidey ? spideySkin(makeUnlit(g.scene)) : makeUnlit(g.scene);
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.add(body);
        this.scene.add(group);
        this.figures.set(key, { group, mixer: new THREE.AnimationMixer(body), actions: new Map() });
      });
    }
    return this.figures.get(key);
  }

  pose(fig, motion, frame) {
    const m = this.clips && this.clips.get(motion);
    if (!m) return;
    let action = fig.actions.get(motion);
    if (!action) {
      action = fig.mixer.clipAction(m.clip);
      fig.actions.set(motion, action);
    }
    for (const a of fig.actions.values()) if (a !== action) a.stop();
    action.play();
    const n = m.frames - 1;
    action.time = (((frame % n) + n) % n) / KEYS_PER_SECOND;
    fig.mixer.update(0);
  }

  /**
   * @param {object[]} draws DreamcastMenu.draws (the 'human' ones are drawn)
   * @param {number[]} view DreamcastMenu.view()   @param {number[]} projection DreamcastMenu.projection()
   * @param {number} width @param {number} height the picture's size in pixels
   * @returns {HTMLCanvasElement|null} the picture, null when there is no figure
   */
  render(draws, view, projection, width, height) {
    const humans = draws.filter((d) => d.kind === 'human');
    for (const fig of this.figures.values()) if (fig) fig.group.visible = false;
    if (!humans.length) return null;
    for (const h of humans) {
      const fig = this.figure(h.character);
      if (!fig) continue;
      fig.group.visible = true;
      fig.group.matrix.fromArray(h.matrix);
      fig.group.matrixWorldNeedsUpdate = true;
      this.pose(fig, h.motion, h.frame);
    }
    if (this.canvas.width !== width || this.canvas.height !== height) this.renderer.setSize(width, height, false);
    this.camera.matrix.fromArray(view).invert();          // render() derives matrixWorld and its inverse (= view) from it
    this.camera.matrixWorldNeedsUpdate = true;
    this.camera.projectionMatrix.fromArray(projection);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }
}
