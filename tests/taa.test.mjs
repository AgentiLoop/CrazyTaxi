// src/taa.js: the jitter sequence and which meshes the velocity pass draws (the GPU side -
// the reprojection, the history - is checked in the browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { halton, jitter, movesInVelocity, JITTER_FRAMES } from '../src/taa.js';
test('halton: the radical inverse', () => {
  assert.deepEqual([1, 2, 3, 4].map((i) => halton(i, 2)), [0.5, 0.25, 0.75, 0.125]);
  assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-12 && Math.abs(halton(2, 3) - 2 / 3) < 1e-12);
});
test('jitter: inside half a pixel, a cycle of JITTER_FRAMES, no two alike', () => {
  const seen = new Set();
  for (let n = 0; n < JITTER_FRAMES; n++) {
    const [x, y] = jitter(n);
    assert.ok(Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5);
    seen.add(`${x},${y}`);
    assert.deepEqual(jitter(n + JITTER_FRAMES), [x, y]);
  }
  assert.equal(seen.size, JITTER_FRAMES);
});
test('movesInVelocity: the opaque, depth-tested meshes that draw colour', () => {
  const g = new THREE.BufferGeometry();
  assert.equal(movesInVelocity(new THREE.Mesh(g, new THREE.MeshBasicMaterial())), true);
  assert.equal(movesInVelocity(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true }))), false);
  assert.equal(movesInVelocity(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false }))), false, 'a shadow volume');
  assert.equal(movesInVelocity(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ depthTest: false }))), false);
  assert.equal(movesInVelocity(new THREE.Group()), false);
});
