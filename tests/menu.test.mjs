// node --test: the game's menu code (src/dc-menu.js) run in the SH-4 interpreter.
// Skipped when local-assets (user-provided game data) is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastMenu, PAD } from '../src/dc-menu.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const EXE = new URL('disc/1ST_READ.BIN', ROOT);
const SPRITES = new URL('sprites/manifest.json', ROOT);
const have = existsSync(EXE);

/** The text drawn this frame, one string per line (pfPutc's glyphs grouped by y; spaces are not drawn). */
function lines(menu) {
  const rows = new Map();
  for (const d of menu.draws) if (d.kind === 'glyph') rows.set(Math.round(d.y), (rows.get(Math.round(d.y)) || '') + d.char);
  return [...rows.values()];
}

/** Press one button for a frame, then let the screen settle. */
function press(menu, button, settle = 60) {
  menu.update(button);
  for (let i = 0; i < settle && menu.update(0); i++);
}

function start() {
  const menu = new DreamcastMenu(new Uint8Array(readFileSync(EXE)));
  for (let i = 0; i < 90; i++) menu.update(0);
  return menu;
}

test('the top menu: the game draws its seven modes, its sprite banks are the English ones', { skip: !have }, () => {
  const menu = start();
  assert.deepEqual(menu.files, ['sprMENU.BIN', 'sprMENG.BIN']);
  const text = lines(menu);
  for (const label of ['ARCADE', 'ORIGINAL', 'CRAZYBOX', 'OPTIONS', 'RECORDS', 'SAVE&LOAD', 'EXIT']) assert.ok(text.includes(label), `${label} in ${text}`);
  assert.deepEqual(menu.state(), { depth: 0, items: [0, 0, 0, 0, 4] });
});

test('the cursor: down and up move it, up from ARCADE wraps to EXIT', { skip: !have }, () => {
  const menu = start();
  press(menu, PAD.DOWN);
  assert.equal(menu.state().items[0], 1);
  press(menu, PAD.UP);
  press(menu, PAD.UP);
  assert.equal(menu.state().items[0], 6);
});

test('the rules screen (ARCADE), B back, ORIGINAL -> WORK FOR 3 MINUTES: menuSetMode reports mode 1, rule 1', { skip: !have }, () => {
  const menu = start();
  press(menu, PAD.A);
  assert.equal(menu.state().depth, 1);
  const text = lines(menu);
  for (const label of ['PLAYBYARCADERULES', 'WORKFOR3MINUTES', 'WORKFOR5MINUTES', 'WORKFOR10MINUTES']) assert.ok(text.includes(label), `${label} in ${text}`);
  press(menu, PAD.B);
  assert.equal(menu.state().depth, 0);
  press(menu, PAD.DOWN);
  press(menu, PAD.A);               // ORIGINAL
  press(menu, PAD.DOWN);
  press(menu, PAD.A);               // WORK FOR 3 MINUTES
  assert.deepEqual(menu.result, { mode: 1, item: 1 });
  assert.equal(menu.update(0), false);
});

test('every sprite the menu draws has a texture in the sprite manifest; glyphs and sprites are on the 640 x 480 screen', { skip: !have || !existsSync(SPRITES) }, () => {
  const numbers = new Set();
  for (const bank of JSON.parse(readFileSync(SPRITES, 'utf8')).banks) for (const t of bank.textures) if (t.png) numbers.add(t.texture_number);
  const menu = start();
  let sprites = 0, glyphs = 0;
  for (const screen of [0, PAD.A, PAD.B, PAD.DOWN, PAD.DOWN, PAD.DOWN, PAD.A]) {   // top, rules, top, OPTIONS
    if (screen) press(menu, screen, 90);
    for (const d of menu.draws) {
      assert.ok(numbers.has(d.texture), `texture ${d.texture}`);
      if (d.kind === 'glyph') {
        glyphs++;
        assert.ok(d.width > 0 && d.height > 0 && d.x >= 0 && d.x < 640 && d.y >= 0 && d.y < 480, JSON.stringify(d));
      } else sprites++;
    }
  }
  assert.ok(sprites > 1000 && glyphs > 200, `${sprites} sprites, ${glyphs} glyphs`);
});

const MOTIONS = new URL('disc/MOTDC.BIN', ROOT);

test('the driver select (MOTDC.BIN): after ARCADE the game shows its drivers, right changes the driver, A decides, the pick motion plays, result.cab', { skip: !have || !existsSync(MOTIONS) }, () => {
  const menu = new DreamcastMenu(new Uint8Array(readFileSync(EXE)), { motions: new Uint8Array(readFileSync(MOTIONS)) });
  for (let i = 0; i < 90; i++) menu.update(0);
  press(menu, PAD.A);                              // ARCADE
  press(menu, PAD.A, 60);                          // PLAY BY ARCADE RULES (the menu fades, then the select; the pad works from its 16th frame)
  assert.equal(menu.screen, 'select');
  assert.equal(menu.result, null);
  const figure = () => menu.draws.find((d) => d.kind === 'human');
  assert.equal(figure().character, 0x3b);          // the first driver (characters/manifest.json select_screen)
  assert.equal(menu.select().cab, 0);
  assert.equal(menu.select().background, 0xFFE64023);
  assert.ok(menu.draws.filter((d) => d.kind === 'sprite').length > 20);
  const count = Number(lines(menu).find((l) => /^\d+$/.test(l)));
  assert.ok(count >= 13 && count <= 15, `the count ${count}`);
  const tiles = menu.draws.filter((d) => d.kind === 'sprite').map((d) => d.texture);
  press(menu, PAD.RIGHT, 30);
  assert.equal(menu.select().cab, 1);
  assert.equal(figure().character, 0x3c);
  assert.notDeepEqual(menu.draws.filter((d) => d.kind === 'sprite').map((d) => d.texture), tiles, 'the driver\'s card changes');
  const m = figure().matrix;
  assert.ok(Math.abs(m[12] - 12) < 1e-3 && Math.abs(m[14] + 33) < 1e-3, `the figure stands at x 12, z -33: ${m}`);
  assert.deepEqual(menu.view().slice(12, 15), [0, -10, 0]);   // CarSel_Camera: the eye 10 up
  const p = menu.projection();                                 // nlPerspective(0x1D28, 4/3, 0.3, 300)
  assert.ok(Math.abs(p[5] - 1 / Math.tan(0x1D28 / 65536 * Math.PI)) < 1e-4 && Math.abs(p[0] * 4 / 3 - p[5]) < 1e-4 && p[11] === -1, `${p}`);
  menu.update(PAD.A);
  assert.equal(menu.select().state, 1);
  let frames = 0;
  while (menu.update(0)) assert.ok(++frames < 600, 'the pick motion ends');
  assert.deepEqual(menu.result, { mode: 0, item: 0, cab: 1, reverse: 0 });
});

test('the title: the logo slides in, PRESS START BUTTON blinks, it waits for START, then the top menu; EXIT comes back', { skip: !have }, () => {
  const menu = new DreamcastMenu(new Uint8Array(readFileSync(EXE)), { title: true });
  assert.equal(menu.screen, 'title');
  menu.update(0);
  const logo = menu.draws.filter((d) => d.kind === 'sprite').map((d) => d.texture);
  for (let n = 100; n <= 112; n++) assert.ok(logo.includes(n), `logo piece ${n} in ${logo}`);
  const x0 = menu.draws.find((d) => d.texture === 100).x;
  for (let i = 0; i < 30; i++) menu.update(0);
  assert.ok(menu.draws.find((d) => d.texture === 100).x < x0, 'the logo slides in from the right');
  assert.ok(lines(menu).includes('PRESSSTARTBUTTON'), lines(menu).join('|'));
  let blinked = false;
  for (let i = 0; i < 1200; i++) {                 // the title restarts in place of the replays
    assert.equal(menu.update(0), true);
    if (!lines(menu).length) blinked = true;
  }
  assert.ok(blinked, 'PRESS START BUTTON blinks');
  assert.equal(menu.screen, 'title');
  press(menu, PAD.START, 90);
  assert.equal(menu.screen, 'menu');
  assert.ok(lines(menu).includes('ARCADE'), lines(menu).join('|'));
  press(menu, PAD.UP);                             // EXIT
  press(menu, PAD.A, 120);
  assert.equal(menu.screen, 'title');
  assert.equal(menu.result, null);
});
