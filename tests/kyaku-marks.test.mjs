// src/kyaku-marks.js: the dollar marker's octagonal ring becomes round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundRing } from '../src/kyaku-marks.js';

test('roundRing: an octagon band becomes a 32-sided one through the same corners', () => {
  const positions = [], uvs = [];
  const corner = (k, r) => [r * Math.cos(k * Math.PI / 4), r * Math.sin(k * Math.PI / 4), 0];
  for (let k = 0; k < 8; k++) {   // the band between radius 11.5 and 16, across the -x axis too
    const [a, b, c, d] = [corner(k, 11.5), corner(k + 1, 11.5), corner(k, 16), corner(k + 1, 16)];
    positions.push(...a, ...b, ...c, ...b, ...d, ...c);
    uvs.push(0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1);
  }
  const out = roundRing(positions, uvs);
  assert.equal(out.positions.length, positions.length * 16);
  assert.equal(out.uvs.length, uvs.length * 16);
  const angles = new Set();
  for (let i = 0; i < out.positions.length; i += 3) {
    const [x, y, z] = out.positions.slice(i, i + 3);
    const r = Math.hypot(x, y);
    assert.ok(r > 11.5 - 1e-4 && r < 16 + 1e-4, `radius ${r}`);
    assert.equal(z, 0);
    if (Math.abs(r - 16) < 1e-4) angles.add(Math.round(Math.atan2(y, x) / (Math.PI / 16) + 32) % 32);
  }
  assert.equal(angles.size, 32);   // the outer edge: every 11.25 degrees, on the circle
});
