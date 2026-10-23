// makeUnlit's draw-order handling of glTF BLEND materials (src/scene.js): solid ones
// become opaque and write depth, see-through ones draw twice (solid texels opaque,
// then a "#blend" child blended), opaque ones stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeUnlit, blendPass } from '../src/scene.js';

const mesh = (name, material, colours) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  if (colours) g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4));
  const m = new THREE.Mesh(g, material);
  m.name = name;
  return m;
};
const blend = (opts = {}) => new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, ...opts });

test('a BLEND material with nothing see-through is drawn opaque, writing depth', () => {
  const root = new THREE.Group();
  root.add(mesh('wheel_0', blend()));
  makeUnlit(root);
  const m = root.children[0];
  assert.equal(m.material.transparent, false);
  assert.equal(m.material.depthWrite, true);
  assert.equal(m.children.length, 0);
  assert.equal(blendPass(m.material), null);
});

test('see-through BLEND materials draw their solid texels opaque, then a blended child', () => {
  const root = new THREE.Group();
  root.add(mesh('glass', blend({ opacity: 0.5 })));
  root.add(mesh('fade', blend(), [1, 1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 1]));
  makeUnlit(root);
  for (const m of root.children) {
    assert.equal(m.material.transparent, false, m.name);
    assert.equal(m.material.depthWrite, true, m.name);
    assert.ok(m.material.alphaTest > 0.99, m.name);
    assert.equal(m.children.length, 1, m.name);
    const b = m.children[0];
    assert.equal(b.name, `${m.name}#blend`);
    assert.equal(b.geometry, m.geometry);
    assert.equal(b.material, blendPass(m.material));
    assert.equal(b.material.transparent, true);
    assert.equal(b.material.depthWrite, false);
  }
});

test('opaque materials keep their settings', () => {
  const root = new THREE.Group();
  root.add(mesh('road', new THREE.MeshStandardMaterial({ alphaTest: 0.5 })));
  makeUnlit(root);
  const m = root.children[0];
  assert.equal(m.material.transparent, false);
  assert.equal(m.material.alphaTest, 0.5);
  assert.equal(m.children.length, 0);
});
