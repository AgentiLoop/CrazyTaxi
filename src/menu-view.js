// Draws what the game's menu code sent to the PowerVR this frame (DreamcastMenu.draws,
// src/dc-menu.js) on a 2D canvas: the 640 x 480 screen scaled to the canvas, the
// sprites and glyphs from local-assets/sprites (texture number -> PNG through the
// manifest), farther (smaller 1/z) first, each tinted by its vertex colour the way
// the PowerVR modulates a texture (texture x colour, alpha x alpha). With ?hires=1 a sprite
// is drawn from the hi-res texture pack's image once it has loaded (src/scene.js hiresImage);
// its size and layout stay the game's.
import { hiresImage } from './scene.js';
const SCREEN_W = 640, SCREEN_H = 480;
// The driver figure's 1/z (SelectView): ~1/33, between the select's art and its text.
const FIGURE_DEPTH = 1 / 33;
// The title's CRAZY TAXI logo: sprites 100-112, drawn as one SVG (local-assets/crazy-taxi.svg)
// fitted to their box when it loads, else the sprites themselves.
const LOGO_FIRST = 100, LOGO_LAST = 112;

// Vector stand-ins for the menu's bitmaps (each falls back to the sprites until it is ready):
// - the item bars (SPRMENU 23-25 grey, 26-28 white: 8 x 32 left cap / middle / right cap
//   pieces, a 2 px #ccc rim with ~5 px round corners) -> one SVG rounded rectangle per bar;
// - pfPutc's glyphs (font textures 0, 118 and 3) -> a line of text in a web font;
// - the screens' title and help-bar pictures and the title's copyright (keyed by their
//   textures) -> text in a web font;
// - the save / load screens' message lines (MESSAGES) -> text in a web font, part by part.
// Every text is fitted to the ink box of the pixels it replaces, so the layout stays the game's.
const BAR_PIECES = new Map([[653, '#888'], [654, '#888'], [655, '#888'], [656, '#fff'], [657, '#fff'], [658, '#fff']]);
export const FONTS = ['100px "Anton"', '100px "Archivo Black"', '700 100px "Roboto Condensed"', '500 100px "Oswald"'];
const TITLE = { font: '400 "Anton"', ink: 'dark', fill: '#000' };
const HELP = { font: '700 "Roboto Condensed"', ink: 'light', fill: '#fff', stroke: '#000' };
const NAME = { ...TITLE, keepAspect: true };
const PICTURES = new Map([
  ['221,221,221,221', ['\u00A9 SEGA ENTERPRISES, LTD., 1999,2000', { font: '400 "Anton"', ink: 'alpha', fill: '#800' }]],
  ['645,646,647', ['MODE SELECTION', TITLE]],
  ['642,642', ['ARCADE', TITLE]],
  ['649,649', ['ORIGINAL', TITLE]],
  ['643,643,644', ['CRAZY BOX', TITLE]],
  ['648,648', ['OPTIONS', TITLE]],
  ['650,650', ['RECORDS', TITLE]],
  ['651,651,652', ['SAVE & LOAD', TITLE]],
  ['175,182,187', ['Use up/down to select.\u2003\u2003Use the A button to decide.', HELP]],
  ['175,183,188', ['Use up/down to select.\u2003\u2003Use left/right to set.', HELP]],
  // the driver select's name (SPRGAME 399-409: 128 x 128 tiles, black letters on white):
  // as tall as the bitmap's letters, at the font's own width
  ['399,400,401', ['AXEL', NAME]],
  ['402,403,404', ['B.D.JOE', NAME]],
  ['407,408,409', ['GENA', NAME]],
  ['405,406', ['GUS', NAME]],
]);
const PICTURE_TEXTURES = new Set([...PICTURES.keys()].flatMap((k) => k.split(',').map(Number)));
// The save / load screens' message lines (SPRMENG 935-972, SPRCENG 191-193: one 16 px high line
// each). '|' splits the parts around a gap the game fills itself (the slot 'A 1', a name).
const MESSAGE = { font: '400 "Archivo Black"', ink: 'light', stroke: '#000' };
const MESSAGES = new Map([
  [935, 'No VMU found.'],
  [936, 'To save your CRAZY TAXI data, you will need a VMU with'],
  [937, 'Blocks of free memory.'],
  [938, 'If you press the Start button to continue,'],
  [939, 'you will not be able to save your data.'],
  [940, 'Press A to create a new file.'],
  [941, 'Now saving... Please do not remove the VMU.'],
  [942, 'VMU in|is in use.'],
  [943, 'File saved to the VMU in|.'],
  [944, 'Not enough free memory blocks available on'],
  [945, 'the VMU in|.'],
  [946, 'File loaded from the VMU in|.'],
  [947, 'File has been saved to the VMU in|.'],
  [948, 'SAVE failed.'],
  [949, 'LOAD file?'],
  [950, 'Now loading... Please do not remove the VMU.'],
  [951, 'File loaded from the VMU in|.'],
  [952, 'LOAD failed.'],
  [953, 'Please enter your name.'],
  [954, 'Register as|?'],
  [955, 'This name already exists. Please use a different name.'],
  [956, 'has been registered.'],
  [957, 'Select the name you want to delete.'],
  [958, 'Delete|?'],
  [959, 'has been deleted.'],
  [960, 'Select the name you want to change.'],
  [961, 'Change from|to|?'],
  [962, 'The name has been changed from|to|.'],
  [963, 'Please select your name.'],
  [964, 'Register to|.'],
  [965, 'Register a new name.'],
  [966, "Don't register."],
  [967, 'Register data to|?'],
  [968, 'Data registered to|.'],
  [969, 'Overwrite file?'],
  [970, 'Overwriting will erase the previous file.'],
  [971, 'File saved to the VMU in|.'],
  [972, 'Start game without saving.'],
  [191, 'The controller has been removed, or no VMU is inserted.'],
  [192, 'Disk could not be read.'],
  [193, 'Please check the disk for dust and scratches.'],
]);
const MESSAGE_GAP = 20;   // texels of empty columns that separate two parts
const GLYPH_FONTS = new Map([
  [0, { font: '500 "Oswald"', ink: 'alpha' }],                           // the title's PRESS START BUTTON
  [118, { font: '400 "Archivo Black"', ink: 'alpha' }],                  // the menu items (drawn black)
  [3, { font: '400 "Archivo Black"', ink: 'light', stroke: '#000' }],    // white / yellow, outlined
]);

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
    this.logo = new Image();
    this.logo.src = assets + 'crazy-taxi.svg';
    this.bars = new Map();       // 'w,h,fill,k' -> SVG HTMLImageElement
    this.inks = new Map();       // 'texture:sx,sy,sw,sh:test' -> ink box in the source rectangle (0..1) or null
  }

  /** A sprite or glyph's screen box (640 x 480 units) and source rectangle, or null before its texture loads. */
  piece(d) {
    const im = this.image(d.texture);
    if (!im) return null;
    const W = im.naturalWidth, H = im.naturalHeight;
    const sx = Math.min(d.uLeft, d.uRight) * W, sw = Math.abs(d.uRight - d.uLeft) * W;
    const sy = Math.min(d.vTop, d.vBottom) * H, sh = Math.abs(d.vBottom - d.vTop) * H;
    let x = d.x, y = d.y, w = d.width, h = d.height;
    if (d.kind === 'sprite') {
      w = W * d.scaleX; h = H * d.scaleY;
      x += (1 - d.anchor[0]) * w / 2; y += (1 - d.anchor[1]) * h / 2;
    }
    return { im, sx, sy, sw, sh, x, y, w, h, flipX: d.uLeft > d.uRight, flipY: d.vTop > d.vBottom };
  }

  /**
   * The box (0..1 of the piece, screen orientation) of the pixels that are ink: 'alpha' = opaque,
   * 'dark' = opaque and dark, 'light' = opaque and light; null if there are none.
   */
  ink(d, p, test) {
    return this.inkParts(d, p, test, Infinity)[0] ?? null;
  }

  /** ink's boxes, left to right, one per run of columns split by `gap` or more empty texels. */
  inkParts(d, p, test, gap) {
    const key = `${d.texture}:${p.sx},${p.sy},${p.sw},${p.sh}:${test}:${gap}`;
    if (this.inks.has(key)) return this.inks.get(key);
    const c = document.createElement('canvas');
    const w = Math.max(1, Math.round(p.sw)), h = Math.max(1, Math.round(p.sh));
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(p.im, p.sx, p.sy, p.sw, p.sh, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const parts = [];   // [x0, y0, x1, y1] in texels
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4, lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
        if (px[i + 3] < 128 || (test === 'dark' && lum >= 128) || (test === 'light' && lum < 128)) continue;
        let b = parts[parts.length - 1];
        if (!b || x - b[2] >= gap) parts.push(b = [x, y, x + 1, y + 1]);
        b[1] = Math.min(b[1], y); b[2] = x + 1; b[3] = Math.max(b[3], y + 1);
      }
    }
    const boxes = parts.map(([x0, y0, x1, y1]) => {
      let box = [x0 / w, y0 / h, x1 / w, y1 / h];
      if (p.flipX) box = [1 - box[2], box[1], 1 - box[0], box[3]];
      if (p.flipY) box = [box[0], 1 - box[3], box[2], 1 - box[1]];
      return box;
    });
    if (p.flipX) boxes.reverse();
    this.inks.set(key, boxes);
    return boxes;
  }

  /** The union of the pieces' ink boxes on the screen, or null while a texture is loading. */
  inkBox(ds, test) {
    let box = null;
    for (const d of ds) {
      const p = this.piece(d);
      if (!p) return null;
      const b = this.ink(d, p, test);
      if (!b) continue;
      const x0 = p.x + b[0] * p.w, y0 = p.y + b[1] * p.h, x1 = p.x + b[2] * p.w, y1 = p.y + b[3] * p.h;
      box = box ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)] : [x0, y0, x1, y1];
    }
    return box;
  }

  /**
   * Text in a web font, its drawn shape stretched onto `box` (screen units) — or, with
   * style.keepAspect, as tall as the box at the font's own width, from the box's left.
   */
  text(text, style, box, fill, alpha) {
    const { ctx } = this;
    const k = this.canvas.width / SCREEN_W;
    const [weight, ...family] = style.font.split(' ');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${weight} 100px ${family.join(' ')}`;
    const m = ctx.measureText(text);
    const bw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, bh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (!(bw > 0 && bh > 0)) return;
    const sy = (box[3] - box[1]) * k / bh, sx = style.keepAspect ? sy : (box[2] - box[0]) * k / bw;
    ctx.setTransform(sx, 0, 0, sy, box[0] * k, box[1] * k);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const x = m.actualBoundingBoxLeft, y = m.actualBoundingBoxAscent;
    if (style.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.5 * k / sy;        // ~1.25 screen px outside the letters
      ctx.strokeStyle = style.stroke;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /** A menu bar as an SVG rounded rectangle (a 2 px #ccc rim), or null until the image has loaded. */
  bar(w, h, fill) {
    const k = this.canvas.width / SCREEN_W;
    const key = `${w},${h},${fill},${k}`;
    let im = this.bars.get(key);
    if (!im) {
      im = new Image();
      im.src = 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}" viewBox="0 0 ${w} ${h}">` +
        `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="4.5" fill="${fill}" stroke="#ccc" stroke-width="2"/></svg>`);
      this.bars.set(key, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  /**
   * The vector stand-in for the run of draws starting at sorted[i] (a bar, a line of glyphs or
   * a title / help picture): draws it and returns how many draws it covers, or 0 to draw
   * sorted[i] as a sprite.
   */
  vector(sorted, i) {
    const d = sorted[i][0];
    const run = [d];
    const same = (e, prev) => e.kind === d.kind && Math.abs(e.y - d.y) < 0.5 && e.alpha === d.alpha && e.depth === d.depth &&
      e.colour.every((c, j) => c === d.colour[j]) && e.x > prev.x;
    const colour = (hex) => {
      const v = parseInt(hex.slice(1), 16);
      const rgb = [(v >> 8) & 15, (v >> 4) & 15, v & 15].map((n, j) => Math.round(n * 17 * Math.min(1, Math.max(0, d.colour[j]))));
      return `rgb(${rgb.join(',')})`;
    };
    if (d.kind === 'sprite' && BAR_PIECES.has(d.texture)) {
      const fill = BAR_PIECES.get(d.texture);
      for (let j = i + 1; j < sorted.length; j++) {
        const e = sorted[j][0];
        if (!same(e, run[run.length - 1]) || BAR_PIECES.get(e.texture) !== fill) break;
        run.push(e);
      }
      const first = this.piece(run[0]), last = this.piece(run[run.length - 1]);
      if (!first || !last) return 0;
      const w = Math.round(last.x + last.w - first.x), h = Math.round(first.h);
      const im = this.bar(w, h, colour(fill));
      if (!im || d.alpha <= 0) return im ? run.length : 0;
      const k = this.canvas.width / SCREEN_W;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalAlpha = Math.min(1, d.alpha);
      this.ctx.drawImage(im, first.x * k, first.y * k, w * k, h * k);
      return run.length;
    }
    if (d.kind === 'glyph' && GLYPH_FONTS.has(d.texture)) {
      const style = GLYPH_FONTS.get(d.texture);
      let text = d.char;
      for (let j = i + 1; j < sorted.length; j++) {
        const e = sorted[j][0], prev = run[run.length - 1];
        if (!same(e, prev) || e.texture !== d.texture) break;
        const gap = e.x - (prev.x + prev.width);
        if (gap > d.height * 1.5) break;                 // another column
        text += (gap > d.height * 0.15 ? ' ' : '') + e.char;
        run.push(e);
      }
      const box = this.inkBox(run, style.ink);
      if (!box) return 0;
      if (d.alpha > 0) this.text(text, style, box, `rgb(${d.colour.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255)).join(',')})`, d.alpha);
      return run.length;
    }
    if (d.kind === 'sprite' && MESSAGES.has(d.texture)) {
      const p = this.piece(d);
      if (!p) return 0;
      let texts = MESSAGES.get(d.texture).split('|');
      let boxes = this.inkParts(d, p, MESSAGE.ink, MESSAGE_GAP);
      if (boxes.length !== texts.length) { texts = [texts.join(' ')]; boxes = [this.ink(d, p, MESSAGE.ink)]; }
      if (!boxes[0] || d.alpha <= 0) return 1;
      const fill = `rgb(${d.colour.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255)).join(',')})`;
      texts.forEach((text, j) => {
        const b = boxes[j];
        this.text(text, MESSAGE, [p.x + b[0] * p.w, p.y + b[1] * p.h, p.x + b[2] * p.w, p.y + b[3] * p.h], fill, d.alpha);
      });
      return 1;
    }
    if (d.kind === 'sprite' && PICTURE_TEXTURES.has(d.texture)) {
      for (let j = i + 1; j < sorted.length; j++) {
        const e = sorted[j][0];
        if (!same(e, { x: -Infinity }) || !PICTURE_TEXTURES.has(e.texture)) break;
        run.push(e);
      }
      const picture = PICTURES.get(run.map((e) => e.texture).join(','));
      if (!picture) return 0;
      const [text, style] = picture;
      const box = this.inkBox(run, style.ink);
      if (!box) return 0;
      if (d.alpha > 0) this.text(text, style, box, colour(style.fill), d.alpha);
      return run.length;
    }
    return 0;
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
   *   3D picture (SelectView) drawn at the figure's depth: over the far sprites (the driver's art,
   *   1/z ~0.002) and under the near ones (the help bar, the timer, 1/z = 1)
   */
  render(draws, under = {}) {
    const { canvas, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const bg = under.background ?? 0;
    ctx.fillStyle = `rgb(${(bg >>> 16) & 255},${(bg >>> 8) & 255},${bg & 255})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let scene = under.scene;
    const k = canvas.width / SCREEN_W;
    const sorted = draws.filter((d) => d.kind !== 'human').map((d, i) => [d, i]).sort((a, b) => a[0].depth - b[0].depth || a[1] - b[1]);
    const svg = this.logo.complete && this.logo.naturalWidth ? this.logo : null;
    let box = null;              // the logo sprites' screen box (their centre is x, y)
    if (svg) {
      for (const d of draws) {
        if (d.kind !== 'sprite' || d.texture < LOGO_FIRST || d.texture > LOGO_LAST) continue;
        const im = this.image(d.texture);
        if (!im) { box = null; break; }   // the box needs every piece's size
        const hw = im.naturalWidth * d.scaleX / 2, hh = im.naturalHeight * d.scaleY / 2;
        box = box || [Infinity, Infinity, -Infinity, -Infinity, d.alpha];
        box[0] = Math.min(box[0], d.x - hw); box[1] = Math.min(box[1], d.y - hh);
        box[2] = Math.max(box[2], d.x + hw); box[3] = Math.max(box[3], d.y + hh);
      }
    }
    let logoDrawn = false;
    for (let i = 0; i < sorted.length; i++) {
      const d = sorted[i][0];
      if (scene && d.depth >= FIGURE_DEPTH) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.drawImage(scene, 0, 0, canvas.width, canvas.height);
        scene = null;
      }
      const covered = this.vector(sorted, i);
      if (covered) { i += covered - 1; continue; }
      if (box && d.kind === 'sprite' && d.texture >= LOGO_FIRST && d.texture <= LOGO_LAST) {
        if (logoDrawn || box[4] <= 0) continue;
        logoDrawn = true;
        const bw = box[2] - box[0], bh = box[3] - box[1];
        const s = Math.min(bw / svg.naturalWidth, bh / svg.naturalHeight);
        const w = svg.naturalWidth * s, h = svg.naturalHeight * s;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.globalAlpha = Math.min(1, box[4]);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(svg, box[0] + (bw - w) / 2, box[1] + (bh - h) / 2, w, h);
        continue;
      }
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
      if (angle) {
        ctx.setTransform(k, 0, 0, k, d.x * k, d.y * k);
        ctx.transform(Math.cos(angle), -Math.sin(angle), Math.sin(angle), Math.cos(angle), 0, 0);
        ctx.translate(x0 + w / 2, y0 + h / 2);
      } else {
        // Snapped to whole canvas pixels, so tiled sprites (the backdrop's 16 x 16 tiles) meet
        // edge to edge instead of leaving anti-aliased hairlines between them.
        const L = Math.round((d.x + x0) * k), R = Math.round((d.x + x0 + w) * k);
        const T = Math.round((d.y + y0) * k), B = Math.round((d.y + y0 + h) * k);
        if (R <= L || B <= T) continue;
        ctx.setTransform(1, 0, 0, 1, (L + R) / 2, (T + B) / 2);
        w = R - L; h = B - T;
      }
      ctx.scale(d.uLeft > d.uRight ? -1 : 1, d.vTop > d.vBottom ? -1 : 1);
      ctx.globalAlpha = Math.min(1, d.alpha);
      const src = this.hires.get(d.texture) || im, fx = src.width / W, fy = src.height / H;
      ctx.imageSmoothingEnabled = src !== im || d.kind === 'glyph' || !!d.filter;   // the pack's: scaled down smoothly
      ctx.drawImage(this.tint(d.texture, src, d.colour), sx * fx, sy * fy, sw * fx, sh * fy, -w / 2, -h / 2, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (scene) ctx.drawImage(scene, 0, 0, canvas.width, canvas.height);
  }
}
