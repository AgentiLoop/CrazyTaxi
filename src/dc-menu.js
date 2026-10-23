// The game's own title screen and menus running in the SH-4 interpreter (src/sh4.js)
// over 1ST_READ.BIN, USA addresses. Nothing about the screens is written here: the
// title (MainMode 0, the advertise handler's title states: the CRAZY TAXI logo
// sliding in, PRESS START BUTTON blinking), the top menu (MainMode 3: InitMenu, then
// Menu every frame: ARCADE, ORIGINAL, CRAZY BOX, OPTIONS, RECORDS, SAVE & LOAD, EXIT),
// the rules screen, the options, the slides and the cursor all come from the game's
// code and tables. What the code would send to the PowerVR is captured instead:
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
//
// The attract sequence between the titles (the SEGA logo, a 3D model, and the
// replays of recorded runs through the city) is not ported: whenever the advertise
// handler moves on to it (sub modes 0-5), the title starts again (sub mode 6,
// init_Title2). START on the title goes to the menu (GotoMenu, as the game does);
// EXIT in the menu comes back to the title (callGoBackAdvertise: sub mode 8).
//
// The driver select (with opts.motions = MOTDC.BIN, which the game loads at 0x0C880000
// during the SEGA logo): after ARCADE or ORIGINAL the game goes on to MainMode 1, sub
// mode 4 (gameState4: nd_CarSelInit) and 5 (gameState5: nd_CarSelExec every frame,
// called with the cab number's address 0x0C177208): the backdrop, the driver's name
// and card, the 15 second count, left/right to change the driver, A to decide, the
// driver's pick motion, then sub mode 0 (the game starts) - `result.cab`. The driver
// figure is captured from humanDraw(motion, character, frame) with XMTRX, its world
// matrix; the camera is the view matrix at 0x0C2B0830 and nd_CarSelInit's
// nlPerspective (0x1D28 = 41 degrees vertical, 4:3, 0.3 - 300); the clear colour comes
// from CarSel_SetBackColor (0x0C073850's ARGB). The Crazy Box skips the driver select
// in the game too (menuSetMode sets sub mode 0 for it).
import { SH4 } from './sh4.js';

const EXE_BASE = 0x0C010000;

const G = {
  mainMode: 0x0C1EBF54, subMode: 0x0C1EBF58,
  frameCounter: 0x0C1EC050,
  titleTimer: 0x0C1EBF60, titleTimer2: 0x0C0E4130,   // the title's frame counts (sub mode 7; it leaves at 309)
  startToPlay: 0x0C1EC058,            // InitSys sets 1: the title waits for START (0 = the arcade's credit screen, which leaves at once)
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
  cab: 0x0C177208, reverse: 0x0C17720C, // the driver (0-3; +4 with the bike command) and the reverse command
  selectState: 0x0C2A5148,            // nd_CarSelExec: 0 choosing, 1 decided, 2/3 the pick motion, 4 done
  view: 0x0C2B0830,                   // the view matrix (column major)
  menuFrom: 0x0C29EF30,               // GotoMenu: the MainMode and (+4) sub mode the menu was entered from
  options: 0x0C2881F0, optionDefaults: 0x0C09C5C0,   // the settings (+4: the music volume, 0-8) and their defaults
};
const MOTIONS = 0x0C880000;           // MOTDC.BIN's load address

const FN = {
  initMatrixStack: 0x0C0765E0,
  pfInit: 0x0C03022C, initMenu: 0x0C040FF8, menu: 0x0C0410B0,
  advertise: 0x0C02BB68,              // MainMode 0's handler (AdvExecState): the sub mode's state from the table at 0x0C08A4B4
  menuSetMode: 0x0C03EB32,
  sprPut: 0x0C07D018, putc: 0x0C03055E,
  fileLoad: 0x0C02D4E2,
  soundRequest: 0x0C071338,
  // The sound (src/audio.js plays it through opts.audio). The menu sends its cursor and
  // decide sounds straight to the driver's command ring (0x0C07EA8C, the word as
  // Sound_Request's); the songs run (gdc_PlaySong 0x0C02D95C: the menu loop, song 0,
  // when the menu is entered from the title or a game; the driver select's, song 2;
  // the fades 0x0C02D9BE) down to the ADX library's ADXT_StartAfs (partition 1 = SONG01)
  // and ADXT_SetOutVol; the voices (VOICE01 672 on entry from the title) through the voice stream calls.
  soundCommand: 0x0C07EA8C,
  songStreamStopAll: 0x0C02D75A, songStreamRemain: 0x0C02D7F8,
  adxtStartAfs: 0x0C14F838, adxtSetOutVol: 0x0C15000E,
  voiceStreamStart: 0x0C02DCFC, voiceStreamVol: 0x0C02DD14, voiceStreamPan: 0x0C02DD50,
  voiceStreamStat: 0x0C02DBDC, voiceStreamTime: 0x0C02DC78,
  voiceStreamStop: 0x0C02DC0C, voiceStreamStopAll: 0x0C02DC1A,
  gameState4: 0x0C02C3B4, gameState5: 0x0C02C3F2,   // MainMode 1's driver select (table 0x0C08A554)
  motionInit: 0x0C06A394,             // after MOTDC.BIN's load
  humanDraw: 0x0C0689D4,
  backColour: 0x0C073850,             // the clear colour (ARGB x 3)
};
const STUBS = [
  0x0C07CAC8, 0x0C07CF16,             // sprite bank uploads (table, selectors)
  0x0C072C90,                         // the sprite numbers' release
  0x0C07E564,                         // waits on the sound driver's register (0xA08000B4)
  0x0C03FE1C,                         // callLoadData: the memory card load at start
  0x0C02E5CA,                         // gdc_CourseStartLoadReq (the city's load)
];
const MIDDLEWARE = [0x0C140000, 0x0C180000];
const MATRIX_STACK = 0x0C1BF7B8, MATRIX_STACK_SIZE = 16;
const MATRIX_SLOTS = 0x0C2B067C;      // the stacks' descriptors (12 bytes: u16 depth, u16 max, base, current)
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
    const audio = opts.audio || null;
    this.audio = audio;
    const sound = (word) => { this.sounds.push(word); if (audio) audio.sound(word); };
    cpu.hooks.set(FN.soundRequest, (c) => { sound(c.r[4] >>> 0); return 0; });
    cpu.hooks.set(FN.soundCommand, (c) => { sound(c.r[4] >>> 0); return 0; });
    cpu.hooks.set(FN.adxtStartAfs, (c) => { if (c.r[5] === 1) { this.songs.push(c.r[6]); if (audio) audio.songStart(c.r[6]); } return 0; });
    cpu.hooks.set(FN.adxtSetOutVol, (c) => { if (audio) audio.songVolume(c.r[5] | 0); return 0; });
    cpu.hooks.set(FN.songStreamStopAll, () => { if (audio) audio.songStop(); return 0; });
    cpu.hooks.set(FN.songStreamRemain, () => (audio ? audio.songRemain() : 0x58764));
    cpu.hooks.set(FN.voiceStreamStart, (c) => { this.voices.push(c.r[5]); if (audio) audio.voiceStart(c.r[4], c.r[5]); return 0; });
    cpu.hooks.set(FN.voiceStreamVol, (c) => { if (audio) audio.voiceVolume(c.r[4], c.r[5] << 24 >> 24); return 0; });
    cpu.hooks.set(FN.voiceStreamPan, () => 0);
    cpu.hooks.set(FN.voiceStreamStat, (c) => (audio ? audio.voicePlaying(c.r[4]) : 0));
    cpu.hooks.set(FN.voiceStreamTime, (c) => (audio ? audio.voicePlayTime(c.r[4]) : 0));
    cpu.hooks.set(FN.voiceStreamStop, (c) => { if (audio) audio.voiceStop(c.r[4]); return 0; });
    cpu.hooks.set(FN.voiceStreamStopAll, () => { if (audio) audio.voiceStopAll(); return 0; });
    cpu.hooks.set(FN.menuSetMode, () => {
      const choice = { mode: cpu.r32(G.menu + 4), item: cpu.r32(G.menu + 8) };
      if (this.motions && choice.mode < 2) this.choice = choice;   // on to the driver select
      else if (choice.mode === 2) this.result = { ...choice, game: choice.item - 2, cab: cpu.r32(G.cab) };   // MiniGame_No = item - 2; CABBIE sets the cab
      else this.result = choice;
      return 0;
    });
    cpu.hooks.set(FN.humanDraw, (c) => {
      const matrix = new Array(16);
      for (let i = 0; i < 16; i++) matrix[i] = c.xf(i);
      this.draws.push({ kind: 'human', motion: c.r[4] >>> 0, character: c.r[5], frame: c.r[6], matrix });
      return false;
    });
    cpu.hooks.set(FN.backColour, (c) => { this.background = c.r[4] >>> 0; return false; });
    this.english = opts.english !== false;
    /** @type {object[]} this frame's sprites, glyphs and figures, in the order the game drew them */
    this.draws = [];
    this.files = [];
    this.sounds = [];
    this.songs = [];      // SONG01 files started
    this.voices = [];     // VOICE01 files started
    this.result = null;
    this.choice = null;
    this.background = 0xFF000000;
    this.held = 0;
    this.frames = 0;
    // The settings: the boot's set-up copies the defaults in (gdc_PlaySong's volume reads +4).
    for (let i = 0; i < 16; i++) cpu.w8(G.options + i, cpu.r8(G.optionDefaults + i));
    // +14: how many players' records are in use (BupInit starts it at 0, a new name adds
    // one). At 0 menuCrazyBoxHandler locks every box; one player (the default name, the
    // records at 0x0C288200 all zero) opens the boxes CheckBoxFlag allows: 1-1 to 1-3 at first.
    cpu.w8(G.options + 14, 1);
    this.motions = !!opts.motions;
    if (opts.motions) {
      cpu.load(MOTIONS, opts.motions);
      this.call(FN.motionInit);
    }
    if (opts.title) this.title();
    else this.init();
  }

  /** InitSys's part: the language, the matrix stacks, the text printer. */
  initSys() {
    const cpu = this.cpu;
    cpu.w32(G.language, this.english ? 1 : 0);
    cpu.w32(G.startToPlay, 1);
    this.call(FN.initMatrixStack, { r4: MATRIX_STACK, r5: MATRIX_STACK_SIZE });
    this.call(FN.pfInit, { r4: 0 });     // the text printer (font 0, aspect 1, size 1)
    this.result = null;
    this.choice = null;
    this.background = 0xFF000000;
    this.held = 0;
  }

  /** InitMenu, as MainMode 3 starts it. */
  init() {
    this.initSys();
    this.cpu.w32(G.mainMode, 3);
    this.cpu.w32(G.subMode, 0);
    this.call(FN.initMenu);
  }

  /** The title screen: MainMode 0 at sub mode 6 (init_Title2; the logo slides in, then PRESS START). */
  title() {
    this.initSys();
    this.cpu.w32(G.mainMode, 0);
    this.cpu.w32(G.subMode, 6);
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
    if (this.result) return false;
    const mode = cpu.r32(G.mainMode);
    if (mode === 0) {
      if (cpu.r32(G.subMode) < 6) cpu.w32(G.subMode, 6);   // the logo and the replays: not ported, the title again
      // The title leaves for the attract sequence after 309 frames, and coming back would
      // slide the logo in again: wind its timers back 240 frames instead so it stays put.
      if (cpu.r32(G.subMode) === 7 && cpu.r32(G.titleTimer) >= 300) {
        for (const t of [G.titleTimer, G.titleTimer2]) cpu.w32(t, cpu.r32(t) - 240);
      }
      this.call(FN.advertise);
      if (cpu.r32(G.mainMode) === 3) {   // START: GotoMenu (it keeps the mode it came from, which InitMenu clears)
        const from = [cpu.r32(G.menuFrom), cpu.r32(G.menuFrom + 4)];
        this.call(FN.initMenu);
        // The menu's first frame starts the menu loop (song 0) only when it was entered
        // from somewhere (0x0C03FB06) - and the voice when that was the title (sub mode 7 or 9).
        cpu.w32(G.menuFrom, from[0]);
        cpu.w32(G.menuFrom + 4, from[1]);
      }
    } else if (mode === 3) {
      this.call(FN.menu);
      if (this.choice) {                // menuSetMode's part: MainMode 1, sub mode 4 (gameState4)
        cpu.w32(G.mainMode, 1);
        cpu.w32(G.subMode, 4);
        this.call(FN.gameState4);
      }
    } else if (mode === 1 && this.choice) {
      this.call(FN.gameState5);         // nd_CarSelExec(0x0C177208)
      if (cpu.r32(G.subMode) === 0) {   // decided: the game starts
        this.result = { ...this.choice, cab: cpu.r32(G.cab), reverse: cpu.r32(G.reverse) };
      }
    } else {
      return false;
    }
    cpu.w32(G.frameCounter, cpu.r32(G.frameCounter) + 1);
    this.frames++;
    return !this.result && [0, 1, 3].includes(cpu.r32(G.mainMode));
  }

  /** 'title' (MainMode 0), 'menu' (MainMode 3) or 'select' (the driver select, MainMode 1). */
  get screen() {
    const mode = this.cpu.r32(G.mainMode);
    return mode === 0 ? 'title' : mode === 1 ? 'select' : 'menu';
  }

  /** The driver select: the driver shown (cab number), its state (0 choosing .. 4 done), the clear colour. */
  select() {
    const cpu = this.cpu;
    return { cab: cpu.r32(G.cab), state: cpu.r32(G.selectState), background: this.background };
  }

  /** The camera of the driver select (CarSel_Camera): the view matrix, column major. */
  view() {
    return Array.from({ length: 16 }, (_, i) => this.cpu.rf(G.view + 4 * i));
  }

  /** nd_CarSelInit's nlPerspective: the projection (matrix stack slot 3's current matrix), column major. */
  projection() {
    const m = this.cpu.r32(MATRIX_SLOTS + 12 * 3 + 8);
    return Array.from({ length: 16 }, (_, i) => this.cpu.rf(m + 4 * i));
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
