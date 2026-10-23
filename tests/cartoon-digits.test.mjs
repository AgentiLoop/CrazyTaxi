// The cartoon digits (src/cartoon-digits.js): the glyph boxes read from the SVGs in
// local-assets/fonts/cartoon_digits/svg and the symbols made of them; the HUD's clock text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { glyphBox, symbolMarkup, gameTimeText, DIGITS_DIR } from '../src/cartoon-digits.js';

const DIR = new URL(`../local-assets/${DIGITS_DIR}`, import.meta.url);
const have = fs.existsSync(DIR);
const texts = have ? [...Array(10).keys()].map((n) => fs.readFileSync(new URL(`${n}.svg`, DIR), 'utf8')) : [];

test('glyphBox: every digit sits inside the 512 picture, the 1 is the narrowest and all share a height', { skip: !have }, () => {
  const boxes = texts.map(glyphBox);
  for (const [n, b] of boxes.entries()) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 512 && b.y + b.h <= 512, `${n}: ${JSON.stringify(b)}`);
    assert.ok(b.w > 100 && b.h > 300, `${n}: too small ${JSON.stringify(b)}`);
  }
  assert.equal(boxes.indexOf(boxes.reduce((a, b) => (b.w < a.w ? b : a))), 1, 'the 1 is the narrowest');
  const heights = boxes.map((b) => b.h);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 60, `heights ${heights.map((h) => h.toFixed(0))}`);
});

test('symbolMarkup: the white fill becomes currentColor, the outline and shadow stay black', { skip: !have }, () => {
  const s = symbolMarkup(texts[3], 'cd-3', { x: 10, y: 20, w: 300, h: 400 });
  assert.ok(s.startsWith('<symbol id="cd-3" viewBox="10 20 300 400"'));
  assert.ok(s.endsWith('</symbol>'));
  assert.ok(!s.includes('#fff'));
  assert.ok(s.includes('fill="currentColor"'));
  assert.ok(s.includes('stroke="#000" stroke-width="320"'));
  assert.ok(s.includes('translate(320,-320)'));
});

test('gameTimeText: minutes, seconds and hundredths from frames', () => {
  assert.deepEqual(gameTimeText(9511), { main: "2'38\"", sub: '51' });
  assert.deepEqual(gameTimeText(3000), { main: "0'50\"", sub: '00' });
  assert.deepEqual(gameTimeText(59), { main: "0'00\"", sub: '98' });
  assert.deepEqual(gameTimeText(-30), { main: "0'00\"", sub: '00' });
});
