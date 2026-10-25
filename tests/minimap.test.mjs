import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView } from '../src/minimap.js';

test('fitView centres the wider side inside the padding', () => {
  const { scale, ox, oz } = fitView([[-100, 0, -50], [100, 5, 50]], 100);
  assert.equal(scale, 0.46);                 // 92 px for the 200 units across
  assert.ok(Math.abs(ox + -100 * scale - 4) < 1e-9);   // the west edge at the padding
  assert.ok(Math.abs(oz + -50 * scale - 27) < 1e-9);   // the narrower side centred
  assert.ok(Math.abs(oz + 50 * scale - 73) < 1e-9);
});
