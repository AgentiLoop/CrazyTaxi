// node --test: the JS collision port against the extracted Arcade data.
// Skipped when local-assets (user-provided game data) is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Collision, KIND_NAMES, surfaceHeight } from '../src/collision.js';
import { START } from '../src/start.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const COL = new URL('collision/arcade.json', ROOT);
const COURSES = new URL('courses/arcade.json', ROOT);
const have = existsSync(COL) && existsSync(COURSES);
const load = (u) => JSON.parse(readFileSync(u, 'utf8'));

test('surfaceHeight: a flat quad', () => {
  const e = [0, 1, 0, -10, 100, [0, 10, 0], [10, 10, 0], [10, 10, 10], [0, 10, 10], 0, 4];
  assert.equal(surfaceHeight(5, 5, e), 10);
  assert.equal(surfaceHeight(50, 5, e), null);
  assert.equal(surfaceHeight(-1, 5, e), null);
});

test('Arcade stage course points sit on #road within 2 units (docs/asset-extraction.md)', { skip: !have }, () => {
  const col = new Collision(load(COL));
  const courses = load(COURSES);
  const F = courses.course_fields;
  let n = 0, bad = 0;
  for (const c of courses.courses) {
    if (c[F.indexOf('role')] !== 'stage') continue;
    for (const [x, y, z] of c[F.indexOf('points')]) {
      n++;
      const g = col.groundAt(x, y + 5, z);
      if (!g || KIND_NAMES[g.kind] !== '#road' || Math.abs(y - g.y) > 2) bad++;
    }
  }
  assert.equal(n, 25712);
  assert.equal(bad, 0);
});

test('Arcade start spot: course 0 last point + 135 z, on #hodou, road ahead', { skip: !have }, () => {
  const col = new Collision(load(COL));
  const courses = load(COURSES);
  const F = courses.course_fields;
  const pts = courses.courses[0][F.indexOf('points')];
  const last = pts[pts.length - 1];
  const s = START.arcade;
  assert.deepEqual([s.x, s.z], [last[0], last[2] + 135]);
  assert.ok(Math.abs(s.y - (last[1] + 0.2)) < 1e-6);
  const g = col.groundAt(s.x, s.y, s.z);
  assert.equal(KIND_NAMES[g.kind], '#hodou');
  const ahead = col.groundAt(s.x + Math.sin(s.heading) * 200, s.y, s.z + Math.cos(s.heading) * 200);
  assert.equal(KIND_NAMES[ahead.kind], '#road');
});

test('walls push a point out along the wall normal', { skip: !have }, () => {
  const col = new Collision(load(COL));
  // Wall 0: a = 0, b = -1, d = 3070.12 => the line z = 3070.12, normal (0, -1),
  // running from its end point toward +x for 139 units.
  const w = col.walls[0];
  const x = w[2] + 50, y = (w[5] + w[6]) / 2;
  const pos = { x, y, z: 3070.12 - 1 };
  const hit = col.pushOutOfWalls(pos, 5);
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.z], [w[0], w[1]]);
  assert.ok(Math.abs(pos.z - (3070.12 - 5)) < 1e-3);
  assert.equal(pos.x, x);
});
