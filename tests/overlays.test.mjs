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

test('pullOverlays: faces above the plane, over the edge or of the same material stay', () => {
  const a = new THREE.MeshBasicMaterial(), b = new THREE.MeshBasicMaterial();
  const root = new THREE.Group();
  root.add(square(0, 0, 100, 0, a));
  root.add(square(0, 0, 8, 2, b));       // 2 above: the depth buffer keeps them apart
  root.add(square(49, 0, 8, 0, b));      // half off the edge
  root.add(square(-20, 0, 8, 0, a));     // the same material
  const glass = new THREE.MeshBasicMaterial({ transparent: true });
  root.add(square(20, 0, 8, 0, glass));  // see-through: pulled already (scene.js toUnlit)
  assert.equal(pullOverlays(root), 0);
});
