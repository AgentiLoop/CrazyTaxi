// src/static-batch.js: the atlas packing and the merging of the world's meshes (the GPU
// side - the atlas copies and the shader - is checked in the browser: tools/mac-probe.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { packTiles, wrapCode, mergeParts, planBatches, atlasMaterial, PAD } from '../src/static-batch.js';

test('packTiles: every tile inside its atlas, ringed by PAD, none overlapping', () => {
  const tiles = [];
  for (let i = 0; i < 300; i++) tiles.push({ id: i, width: [64, 32, 128, 16][i % 4], height: [64, 32, 128, 64][i % 4] });
  const placed = packTiles(tiles, 1024);
  assert.equal(placed.length, 300);
  const byAtlas = new Map();
  for (const t of placed) {
    assert.ok(t.x >= PAD && t.y >= PAD && t.x + t.width + PAD <= 1024 && t.y + t.height + PAD <= 1024, JSON.stringify(t));
    const list = byAtlas.get(t.atlas) || [];
    for (const o of list) {
      const apart = t.x + t.width + PAD <= o.x - PAD || o.x + o.width + PAD <= t.x - PAD || t.y + t.height + PAD <= o.y - PAD || o.y + o.height + PAD <= t.y - PAD;
      assert.ok(apart, `${JSON.stringify(t)} overlaps ${JSON.stringify(o)}`);
    }
    list.push(t);
    byAtlas.set(t.atlas, list);
  }
  assert.ok(byAtlas.size >= 2, 'more texels than one 1024 atlas holds');
  assert.throws(() => packTiles([{ id: 'big', width: 4096, height: 8 }], 2048));
});

test('wrapCode: repeat 0, clamp 1, mirror 2', () => {
  assert.equal(wrapCode(THREE.RepeatWrapping), 0);
  assert.equal(wrapCode(THREE.ClampToEdgeWrapping), 1);
  assert.equal(wrapCode(THREE.MirroredRepeatWrapping), 2);
});

function quad(material, { color = null, x = 0, z = 0 } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 2, 2, 0, 2], 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(color, 4));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, 0, z);
  return m;
}

function texture(w, h) {
  const t = new THREE.Texture({ width: w, height: h });
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

test('planBatches: one group per (atlas, way of drawing, cell); textures packed once per source', () => {
  const tex = texture(64, 64), tex2 = texture(32, 32);
  const opaque = new THREE.MeshBasicMaterial({ map: tex });
  const opaqueToo = new THREE.MeshBasicMaterial({ map: tex2, color: 0xff0000 });   // another texture and colour: same way of drawing
  const sameTexture = new THREE.MeshBasicMaterial({ map: tex.clone() });            // a clone shares the source
  const masked = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 });
  const blended = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const plain = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const root = new THREE.Group();
  root.add(quad(opaque), quad(opaqueToo), quad(sameTexture), quad(masked), quad(blended), quad(plain), quad(opaque, { x: 9000 }));
  const hidden = quad(opaque); hidden.visible = false; root.add(hidden);
  const { tiles, groups, atlasCount } = planBatches([root], { cell: 4000 });
  assert.equal(tiles.length, 2, 'two sources');
  assert.equal(atlasCount, 1);
  const keys = groups.map((g) => g.parts.length).sort();
  // opaque x3 in cell 0, masked, blended, plain, opaque in the far cell
  assert.deepEqual(keys, [1, 1, 1, 1, 3]);
  assert.equal(groups.filter((g) => !g.textured).length, 1);
  assert.equal(groups.reduce((n, g) => n + g.parts.length, 0), 7, 'the hidden mesh is left out');
});

test('mergeParts: world positions, colour = material x vertex, tile and wrap per vertex', () => {
  const tex = texture(64, 32);
  const m = new THREE.MeshBasicMaterial({ map: tex, color: 0x808080, vertexColors: true, opacity: 0.5 });
  const a = quad(m, { color: [1, 1, 1, 1, 0.5, 0.5, 0.5, 1, 0, 0, 0, 0.25, 1, 0, 0, 1], x: 10, z: 20 });
  const b = quad(new THREE.MeshBasicMaterial({ map: tex }), { x: -5 });
  a.updateMatrixWorld(true); b.updateMatrixWorld(true);
  const tile = { x: 100, y: 200, width: 64, height: 32 };
  const g = mergeParts([{ mesh: a, tile }, { mesh: b, tile }], true);
  assert.equal(g.attributes.position.count, 8);
  assert.equal(g.index.count, 12);
  assert.deepEqual([...g.index.array.slice(6, 12)], [4, 5, 6, 4, 6, 7], 'the second quad\'s indices offset');
  assert.deepEqual([g.attributes.position.getX(0), g.attributes.position.getZ(0)], [10, 20]);
  assert.deepEqual([g.attributes.position.getX(4), g.attributes.position.getZ(4)], [-5, 0]);
  const c = g.attributes.color;
  const grey = m.color.r;
  assert.ok(Math.abs(c.getX(1) - grey * 0.5) < 1e-6 && Math.abs(c.getW(2) - 0.5 * 0.25) < 1e-6, 'material colour x vertex colour, opacity x vertex alpha');
  assert.deepEqual([c.getX(4), c.getY(4), c.getZ(4), c.getW(4)], [1, 1, 1, 1]);
  assert.deepEqual([...g.attributes.tile.array.slice(0, 4)], [100, 200, 64, 32]);
  assert.deepEqual([...g.attributes.wrap.array.slice(0, 2)], [0, 1]);
  assert.equal(g.attributes.uv.getX(1), 2, 'the uv is the mesh\'s own (the shader wraps it inside the tile)');
  assert.equal(g.attributes.normal, undefined, 'unlit: no normals kept');
  assert.ok(g.boundingSphere.radius > 0);
});

test('atlasMaterial: draws as the sample does, with the atlas and vertex colours', () => {
  const sample = new THREE.MeshBasicMaterial({ alphaTest: 0.998, transparent: false, depthWrite: true, color: 0xff00ff });
  const atlas = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
  const m = atlasMaterial(sample, atlas);
  assert.equal(m.map, atlas);
  assert.equal(m.alphaTest, 0.998);
  assert.equal(m.vertexColors, true);
  assert.equal(m.color.getHex(), 0xffffff);
  assert.equal(typeof m.onBeforeCompile, 'function');
  const shader = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>' };
  m.onBeforeCompile(shader);
  assert.deepEqual(shader.uniforms.atlasSize.value.toArray(), [4, 4]);
  assert.match(shader.vertexShader, /vTile = tile/);
  assert.match(shader.fragmentShader, /fract\(u\.x\)/);
  assert.equal(atlasMaterial(sample, null).onBeforeCompile, THREE.Material.prototype.onBeforeCompile, 'untextured: the stock shader');
});
