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
