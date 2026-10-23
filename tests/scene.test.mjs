// makeUnlit's draw-order handling of glTF BLEND materials (src/scene.js): solid ones
// become opaque and write depth, see-through ones draw twice (solid texels opaque,
// then a "#blend" child blended), opaque ones stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeUnlit, blendPass, hiresCap, packKey, fitSize, hiresImage, hiresLink, packSource } from '../src/scene.js';

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
test('the hi-res texture pack: ?hires picks the size cap, glTF image URIs map to manifest keys', () => {
  assert.equal(hiresCap(''), 0);
  assert.equal(hiresCap('?city=arcade&hires=0'), 0);
  assert.equal(hiresCap('?hires=1'), 512);
  assert.equal(hiresCap('?hires'), 512);
  assert.equal(hiresCap('?hires=1024'), 1024);
  assert.equal(packKey('../textures/TEXDC1/0046.png'), 'textures/TEXDC1/0046.png');
  assert.equal(packKey('../../textures/TEXDC0/0398.png'), 'textures/TEXDC0/0398.png');
  assert.equal(packKey('../sprites/SPRGAME/0001.png'), null);
  assert.deepEqual(fitSize(1024, 1024, 512), [512, 512]);
  assert.deepEqual(fitSize(3277, 1638, 512), [512, 256]);
  assert.deepEqual(fitSize(128, 64, 512), [128, 64]);
});
test('the hi-res texture pack: the pre-shrunk image is fetched when it is as large as the cap draws the pack image', () => {
  const t = { link: 'a.jpg', pack_width: 1024, pack_height: 1024, small: 'small/a.webp', small_width: 512, small_height: 512 };
  assert.deepEqual(packSource(t, 512), ['small/a.webp', 512, 512]);
  assert.deepEqual(packSource(t, 256), ['small/a.webp', 512, 512]);
  assert.deepEqual(packSource(t, 1024), ['a.jpg', 1024, 1024]);
  const tiny = { link: 'b.png', pack_width: 256, pack_height: 128, small: 'small/b.webp', small_width: 256, small_height: 128 };
  assert.deepEqual(packSource(tiny, 2048), ['small/b.webp', 256, 128]);
  assert.deepEqual(packSource({ link: 'c.jpg', pack_width: 1024, pack_height: 512 }, 512), ['c.jpg', 1024, 512]);
});
test('the hi-res texture pack is off without ?hires: no pack pictures for the menu and the HUD', async () => {
  assert.equal(await hiresLink('landmarks/LANDDC1/00.png'), null);
  assert.equal(await hiresImage('sprites/SPRADV/0000.png', null), null);
});
