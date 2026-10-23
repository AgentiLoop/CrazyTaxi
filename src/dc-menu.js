// The game's own menus (MainMode 3: InitMenu, then Menu every frame) running in the
// SH-4 interpreter (src/sh4.js) over 1ST_READ.BIN, USA addresses. Nothing about the
// screens is written here: the top menu (ARCADE, ORIGINAL, CRAZY BOX, OPTIONS,
// RECORDS, SAVE & LOAD, EXIT), the rules screen, the options, the slides and the
// cursor all come from the game's code and tables. What the code would send to the
// PowerVR is captured instead:
//
// - nlSprPut(record) (0x0C07D018), every 2D sprite: the record holds the sprite
//   number (= the texture number of local-assets/sprites/manifest.json), the
//   position of its top-left corner on the 640 x 480 screen, 1/z, the scale, the UVs,
//   the rotation, the alpha, the blend mode and flags (0x2000: tinted by the fade
//   colour nlObjPutSetFadeColor keeps at 0x0C148678; 0x10/0x20: the u/v flips). The
//   texture's size is its manifest size.
// - pfPutc(char) (0x0C03055E), every character of text (the menu labels): the
//   glyph from the current font's table (pfSetFont), the pen, the size and the
//   colour, computed as pfPutc computes its quad.
//
// The 2D textures sit upside down in video memory: nlSprPut draws v = 1 - v (unless
// flag 0x20) and the fonts' row tables run bottom-up, so a quad's top edge samples
// the PNG's lower row. MenuView (src/menu-view.js) draws exactly those UVs.
//
// Stubbed: the middleware (GD file system, ADX, the memory card, Kamui: every call
// into 0x0C140000-0x0C180000), the file loader (0x0C02D4E2: the menu's sprite banks
// are only texture uploads; the names are kept), the sprite bank uploads, the sound
// driver's busy wait and the memory card load at start (callLoadData). The menu's
// choice ends the run: menuSetMode (0x0C03EB32) would set MainMode 1 and load the
// city; here it is caught and reported as `result` instead.
import { SH4 } from './sh4.js';

const EXE_BASE = 0x0C010000;

const G = {
  mainMode: 0x0C1EBF54, subMode: 0x0C1EBF58,
  frameCounter: 0x0C1EC050,
  taxiSW: 0x0C1EBF6C,                 // the pad: +0 held, +4 pressed, +8 released, +0xC last held, +0x10/+0x16 stick (0x8000 = centre)
  language: 0x0C29EEC8,               // 0 Japanese (sprMJAP), else English (sprMENG)
  menu: 0x0C29EEE0,                   // menu state: +0 depth, +4 + 4 * depth the item chosen at each depth (GetMenuMode(k) = +4 + 4k)
  fade: 0x0C148678,                   // nlObjPutSetFadeColor's RGB floats
  font: 0x0C26BEF4, glyphs: 0x0C26BEF0, // pfSetFont: the font, its glyph table (16 bytes per character from ' ')
  penX: 0x0C0EC040, penY: 0x0C0EC044,
  fontScale: 0x0C26BEFC, fontHeight: 0x0C26BF0C, fontUV: 0x0C26BF14,
  fontTexture: 0x0C0EC048,            // per font: the SPRCOMM texture
  glyphVTop: 0x0C08CBEC, glyphVBottom: 0x0C08CC18,   // per glyph row: the v of the top and the bottom edge
  textColour: 0x0C0EC020,             // pfColor: the vertices' ARGB
  textZ: 0x0C0EBFD8,                  // the glyph quad's z (pfSetZ)
};

const FN = {
  initMatrixStack: 0x0C0765E0,
  pfInit: 0x0C03022C, initMenu: 0x0C040FF8, menu: 0x0C0410B0,
  menuSetMode: 0x0C03EB32,
  sprPut: 0x0C07D018, putc: 0x0C03055E,
  fileLoad: 0x0C02D4E2,
  soundRequest: 0x0C071338,
};
const STUBS = [
  0x0C07CAC8, 0x0C07CF16,             // sprite bank uploads (table, selectors)
  0x0C072C90,                         // the sprite numbers' release
  0x0C07E564,                         // waits on the sound driver's register (0xA08000B4)
  0x0C03FE1C,                         // callLoadData: the memory card load at start
];
const MIDDLEWARE = [0x0C140000, 0x0C180000];
const MATRIX_STACK = 0x0C1BF7B8, MATRIX_STACK_SIZE = 16;
const IDENTITY = [0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000];
const TURN = Math.PI * 2 / 65536;

/** Dreamcast pad bits (TaxiSW +0 / +4). */
export const PAD = {
  C: 0x01, B: 0x02, A: 0x04, START: 0x08, UP: 0x10, DOWN: 0x20, LEFT: 0x40, RIGHT: 0x80,
  Y: 0x200, X: 0x400,
};

/** The top menu's modes (menu state +4) and the city each starts. */
export const MODES = ['arcade', 'original', 'crazy box'];

export class DreamcastMenu {
  /** @param {Uint8Array} exe 1ST_READ.BIN   @param {{english?: boolean}} opts */
  constructor(exe, opts = {}) {
    const cpu = new SH4();
    this.cpu = cpu;
    cpu.load(EXE_BASE, exe);
    for (const a of STUBS) cpu.hooks.set(a, () => 0);
    // The middleware: return at once (0) from any call into it.
    const go = cpu.go.bind(cpu);
    cpu.go = (target, isCall) => {
      const t = target >>> 0;
      if (t >= MIDDLEWARE[0] && t < MIDDLEWARE[1] && !cpu.hooks.has(t)) {
        cpu.r[0] = 0; cpu.setf(0, 0); cpu.pc = cpu.pr;
        return;
      }
      go(target, isCall);
    };
    cpu.hooks.set(FN.fileLoad, (c) => { this.files.push(this.string(c.r[5] >>> 0)); return 0; });
    cpu.hooks.set(FN.sprPut, (c) => { this.sprite(c.r[4] >>> 0); return 0; });
    cpu.hooks.set(FN.putc, (c) => { this.glyph(c.r[4] << 24 >> 24); return false; });
    cpu.hooks.set(FN.soundRequest, (c) => { this.sounds.push(c.r[4] >>> 0); return 0; });
    cpu.hooks.set(FN.menuSetMode, () => {
      this.result = { mode: cpu.r32(G.menu + 4), item: cpu.r32(G.menu + 8) };
      return 0;
    });
    this.english = opts.english !== false;
    /** @type {object[]} this frame's sprites and glyphs, in the order the game drew them */
    this.draws = [];
    this.files = [];
    this.sounds = [];
    this.result = null;
    this.held = 0;
    this.frames = 0;
    this.init();
  }

  /** InitMenu, as MainMode 3 starts it. */
  init() {
    const cpu = this.cpu;
    cpu.w32(G.language, this.english ? 1 : 0);
    this.call(FN.initMatrixStack, { r4: MATRIX_STACK, r5: MATRIX_STACK_SIZE });
    cpu.w32(G.mainMode, 3);
    cpu.w32(G.subMode, 0);
    this.call(FN.pfInit, { r4: 0 });     // InitSys: the text printer (font 0, aspect 1, size 1)
    this.call(FN.initMenu);
    this.result = null;
    this.held = 0;
  }

  call(fn, regs) {
    for (let i = 0; i < 16; i++) this.cpu.xfSet(i, IDENTITY[i]);
    return this.cpu.call(fn, regs, 20000000);
  }

  string(a) {
    let s = '';
    for (let ch; (ch = this.cpu.r8(a++));) s += String.fromCharCode(ch);
    return s;
  }

  /**
   * One frame of the menu (MainLoop: the pad, the mode's handler, the frame count).
   * @param {number} buttons PAD bits held this frame
   * @returns {boolean} false once the menu has left (a mode was chosen: `result`, or EXIT)
   */
  update(buttons = 0) {
    const cpu = this.cpu;
    const sw = G.taxiSW;
    cpu.w32(sw + 4, buttons & ~this.held);
    cpu.w32(sw + 8, this.held & ~buttons);
    cpu.w32(sw + 12, this.held);
    cpu.w32(sw, buttons);
    cpu.w16(sw + 0x10, 0x8000);
    cpu.w16(sw + 0x16, 0x8000);
    this.held = buttons;
    this.draws = [];
    this.sounds = [];
    if (cpu.r32(G.mainMode) !== 3 || this.result) return false;
    this.call(FN.menu);
    cpu.w32(G.frameCounter, cpu.r32(G.frameCounter) + 1);
    this.frames++;
    return !this.result && cpu.r32(G.mainMode) === 3;
  }

  /** The menu state: depth and the item chosen at each depth (GetMenuMode). */
  state() {
    const cpu = this.cpu;
    const depth = cpu.rs32(G.menu);
    return { depth, items: [0, 1, 2, 3, 4].map((k) => cpu.rs32(G.menu + 4 + 4 * k)) };
  }

  /** nlSprPut's record (see the header). */
  sprite(p) {
    const cpu = this.cpu;
    const flags = cpu.r32(p + 52);
    const mode = cpu.rs32(p + 48);
    const u0 = cpu.rf(p + 24), v0 = cpu.rf(p + 28), u1 = cpu.rf(p + 32), v1 = cpu.rf(p + 36);
    const tint = flags & 0x2000 ? [cpu.rf(G.fade), cpu.rf(G.fade + 4), cpu.rf(G.fade + 8)] : [1, 1, 1];
    this.draws.push({
      kind: 'sprite',
      texture: cpu.r32(p),
      x: cpu.rf(p + 4), y: cpu.rf(p + 8),
      depth: 1 / cpu.rf(p + 12),
      scaleX: cpu.rf(p + 16), scaleY: cpu.rf(p + 20),
      // The edges' texture coordinates as the PowerVR samples them (u across, v down the quad).
      uLeft: flags & 0x10 ? 1 - u0 : u0, uRight: flags & 0x10 ? 1 - u1 : u1,
      vTop: flags & 0x20 ? v0 : 1 - v0, vBottom: flags & 0x20 ? v1 : 1 - v1,
      angle: cpu.rs32(p + 40) * TURN,
      anchor: flags & 15 ? [flags & 3, (flags >> 2) & 3] : [1, 1],   // the corner table (1..3) minus this: [1, 1] = top-left at x, y
      alpha: mode === 0 ? 1 : cpu.rf(p + 44),
      colour: tint,
      filter: !!(flags & 0x1000),
    });
  }

  /** pfPutc's quad for character c (before it runs: the pen is where this glyph goes). */
  glyph(c) {
    if (c < 32 || c > 127) return;
    const cpu = this.cpu;
    const g = cpu.r32(G.glyphs) + (c - 32) * 16;
    const left = cpu.rf(g), width = cpu.rf(g + 4), row = cpu.r32(g + 8);
    if (left < 0) return;                         // a space: the pen only moves
    const x = cpu.rf(G.penX), y = cpu.rf(G.penY);
    const scale = cpu.rf(G.fontScale), height = cpu.rf(G.fontHeight), uv = cpu.rf(G.fontUV);
    const argb = cpu.r32(G.textColour);
    this.draws.push({
      kind: 'glyph', char: String.fromCharCode(c),
      texture: cpu.r32(G.fontTexture + 4 * cpu.r32(G.font)),
      x, y, width: scale * width, height,
      depth: cpu.rf(G.textZ),
      uLeft: left * uv, uRight: (left + width) * uv,
      vTop: cpu.rf(G.glyphVTop + 4 * row), vBottom: cpu.rf(G.glyphVBottom + 4 * row),
      alpha: (argb >>> 24) / 255,
      colour: [((argb >>> 16) & 255) / 255, ((argb >>> 8) & 255) / 255, (argb & 255) / 255],
    });
  }
}
