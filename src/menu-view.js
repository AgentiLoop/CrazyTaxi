// Draws what the game's menu code sent to the PowerVR this frame (DreamcastMenu.draws,
// src/dc-menu.js) on a 2D canvas: the 640 x 480 screen scaled to the canvas, the
// sprites and glyphs from local-assets/sprites (texture number -> PNG through the
// manifest), farther (smaller 1/z) first, each tinted by its vertex colour the way
// the PowerVR modulates a texture (texture x colour, alpha x alpha). With ?hires=1 a sprite
// is drawn from the hi-res texture pack's image once it has loaded (src/scene.js hiresImage);
// its size and layout stay the game's.
import { hiresImage } from './scene.js';
const SCREEN_W = 640, SCREEN_H = 480;

export class MenuView {
  /** @param {HTMLCanvasElement} canvas @param {string} assets local-assets/ URL @param {object} manifest sprites/manifest.json */
  constructor(canvas, assets, manifest) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = assets;
    this.paths = new Map();
    for (const bank of manifest.banks) {
      for (const t of bank.textures) if (t.png) this.paths.set(t.texture_number, t.png);
    }
    this.images = new Map();     // texture number -> HTMLImageElement (loading or loaded)
    this.hires = new Map();      // texture number -> the pack's ImageBitmap (?hires=1)
    this.tinted = new Map();     // 'texture:r,g,b' -> canvas
  }

  image(n) {
    let im = this.images.get(n);
    if (!im) {
      const path = this.paths.get(n);
      if (!path) return null;
      im = new Image();
      im.src = this.assets + 'sprites/' + path;
      this.images.set(n, im);
      im.decode().then(() => hiresImage('sprites/' + path, im)).then((b) => { if (b) this.hires.set(n, b); }, () => {});
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  /** The texture multiplied by an RGB colour (alpha kept). */
  tint(n, im, colour) {
    if (colour[0] === 1 && colour[1] === 1 && colour[2] === 1) return im;
    const key = `${n}:${im.width}:${colour.map((c) => Math.round(c * 255)).join(',')}`;
    let c = this.tinted.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = `rgb(${colour.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(im, 0, 0);
      this.tinted.set(key, c);
    }
    return c;
  }

  /**
   * @param {object[]} draws DreamcastMenu.draws
   * @param {{background?: number, scene?: HTMLCanvasElement|null}} [under] the clear colour (ARGB) and a
   *   3D picture (SelectView) drawn before the sprites
   */
  render(draws, under = {}) {
    const { canvas, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const bg = under.background ?? 0;
    ctx.fillStyle = `rgb(${(bg >>> 16) & 255},${(bg >>> 8) & 255},${bg & 255})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (under.scene) ctx.drawImage(under.scene, 0, 0, canvas.width, canvas.height);
    const k = canvas.width / SCREEN_W;
    const sorted = draws.filter((d) => d.kind !== 'human').map((d, i) => [d, i]).sort((a, b) => a[0].depth - b[0].depth || a[1] - b[1]);
    for (const [d] of sorted) {
      const im = this.image(d.texture);
      if (!im || d.alpha <= 0) continue;
      const W = im.naturalWidth, H = im.naturalHeight;
      const sx = Math.min(d.uLeft, d.uRight) * W, sw = Math.abs(d.uRight - d.uLeft) * W;
      const sy = Math.min(d.vTop, d.vBottom) * H, sh = Math.abs(d.vBottom - d.vTop) * H;
      if (sw <= 0 || sh <= 0) continue;
      let x0, y0, w, h, angle = 0;
      if (d.kind === 'sprite') {
        // nlSprPut's corners: (1..3 - anchor) x half the scaled size, about x, y.
        w = W * d.scaleX; h = H * d.scaleY;
        x0 = (1 - d.anchor[0]) * w / 2; y0 = (1 - d.anchor[1]) * h / 2;
        angle = d.angle;
      } else {
        w = d.width; h = d.height; x0 = 0; y0 = 0;
      }
      ctx.setTransform(k, 0, 0, k, d.x * k, d.y * k);
      if (angle) ctx.transform(Math.cos(angle), -Math.sin(angle), Math.sin(angle), Math.cos(angle), 0, 0);
      ctx.translate(x0 + w / 2, y0 + h / 2);
      ctx.scale(d.uLeft > d.uRight ? -1 : 1, d.vTop > d.vBottom ? -1 : 1);
      ctx.globalAlpha = Math.min(1, d.alpha);
      const src = this.hires.get(d.texture) || im, fx = src.width / W, fy = src.height / H;
      ctx.imageSmoothingEnabled = src !== im || d.kind === 'glyph' || !!d.filter;   // the pack's: scaled down smoothly
      ctx.drawImage(this.tint(d.texture, src, d.colour), sx * fx, sy * fy, sw * fx, sh * fy, -w / 2, -h / 2, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
}
