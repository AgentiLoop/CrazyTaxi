// src/overlays.js: the opaque details laid in the plane of another face move into pulled meshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { pullOverlays } from '../src/overlays.js';

/** A flat square (two triangles) at height y, `size` wide, centred on (x, z). */
function square(x, z, size, y, material) {
  const g = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(x, y, z);
  return new THREE.Mesh(g, material);
}

test('pullOverlays: a shadow inside the pavement moves to a pulled child, the pavement stays', () => {
  const pavement = new THREE.MeshBasicMaterial(), shadow = new THREE.MeshBasicMaterial();
  const root = new THREE.Group();
  const base = square(0, 0, 100, -1198, pavement);
  const over = square(10, 5, 8, -1198, shadow);
  root.add(base, over);
  assert.equal(pullOverlays(root), 2);
  assert.equal(base.children.length, 0);
  assert.equal(over.geometry.index.count, 0);
  const child = over.children[0];
  assert.equal(child.geometry.index.count, 6);
  assert.equal(child.material.userData.decal, true);
  assert.equal(child.material.polygonOffset, true);
  assert.equal(child.material.map, shadow.map);
});

test('pullOverlays: faces above the plane, meeting at an edge, facing away or see-through stay', () => {
  const a = new THREE.MeshBasicMaterial(), b = new THREE.MeshBasicMaterial();
  const root = new THREE.Group();
  root.add(square(0, 0, 100, 0, a));
  root.add(square(0, 0, 8, 2, b));       // 2 above: the depth buffer keeps them apart
  root.add(square(54, 0, 8, 0, b));      // beside the edge, sharing it
  const under = square(-20, 0, 8, 0, b);
  under.geometry.rotateX(Math.PI).translate(0, 0, -40);   // facing down
  root.add(under);
  const glass = new THREE.MeshBasicMaterial({ transparent: true });
  root.add(square(20, 0, 8, 0, glass));  // see-through: pulled already (scene.js toUnlit)
  assert.equal(pullOverlays(root), 0);
});

test('pullOverlays: a shadow cut into the pavement overlapping it by a sliver, a detail half off its edge', () => {
  const a = new THREE.MeshBasicMaterial(), b = new THREE.MeshBasicMaterial();
  const root = new THREE.Group();
  const pavement = square(-50, 0, 100, 0, a);   // x -100..0
  const shadow = square(9.8, 0, 20, 0, b);      // x -0.2..19.8: a sliver 0.2 wide on the pavement
  const half = square(0, 30, 8, 0, b);          // x -4..4
  root.add(pavement, shadow, half);
  pullOverlays(root);
  assert.equal(pavement.children.length, 0);
  assert.equal(shadow.children.length, 1);
  assert.equal(half.children.length, 1);
  assert.equal(half.geometry.index.count, 0);
});

test('pullOverlays: a detail on a detail is pulled one layer further', () => {
  const a = new THREE.MeshBasicMaterial(), b = new THREE.MeshBasicMaterial(), c = new THREE.MeshBasicMaterial();
  const root = new THREE.Group();
  const ground = square(0, 0, 100, 0, a), mid = square(0, 0, 20, 0, b), top = square(0, 0, 4, 0, c), same = square(30, 0, 8, 0, a);
  root.add(ground, mid, top, same);
  assert.equal(pullOverlays(root), 6);
  assert.equal(mid.children[0].material.polygonOffsetFactor, -1);
  assert.equal(top.children[0].material.polygonOffsetFactor, -2);
  assert.equal(top.children[0].material.userData.pull, 2);
  assert.equal(top.children[0].name.endsWith('#overlay2'), true);
  assert.equal(same.children.length, 1);   // the same material on itself: pulled as well
});