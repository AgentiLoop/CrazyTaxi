// node --test: the cab shadow's volume builder (src/cab-shadow.js pieceVolume).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pieceVolume } from '../src/cab-shadow.js';

// A tetrahedron shell without its x+y+z face (as tools/extract_vehicles.py exports a piece).
const piece = {
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  edges: [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
  faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2]],
  faceEdges: [[2, 1, 0], [0, 4, 3], [3, 5, 2]],
  normals: [[0, 0, -1], [0, -1, 0], [-1, 0, 0]],
};

function edgeCounts(out, n) {
  const count = new Map();
  const key = (i) => [out[3 * i], out[3 * i + 1], out[3 * i + 2]].map((v) => v.toFixed(4)).join(',');
  for (let t = 0; t < n; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(t + e), b = key(t + (e + 1) % 3), k = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  return [...count.values()];
}

test('pieceVolume: faces away from the light, capped at both ends, closed', () => {
  const out = new Float32Array(2000);
  // Light from straight above: only the bottom face (normal -y) points away from it.
  let n = pieceVolume(piece, [0, 1, 0], out);
  assert.equal(n, 2 * 3 + 3 * 6);            // two caps + one quad per edge of the lone face
  assert.deepEqual([...out.slice(9, 12)], [0, -100, 0]);   // the far cap: moved 100 away from the light
  assert.ok(edgeCounts(out, n).every((c) => c % 2 === 0));
  // Light along (1, 1, 1): all three faces point away; the shared edges get no side.
  n = pieceVolume(piece, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], out);
  assert.equal(n, 3 * 2 * 3 + 3 * 6);
  assert.ok(edgeCounts(out, n).every((c) => c % 2 === 0));
  // Light from below: no face points away, nothing is drawn.
  assert.equal(pieceVolume(piece, [0, -1, 0], out), 0);
});
