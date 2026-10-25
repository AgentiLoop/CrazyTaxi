import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView, roadGraph, routeTree, nearestPoint } from '../src/minimap.js';

test('fitView centres the wider side inside the padding', () => {
  const { scale, ox, oz } = fitView([[-100, 0, -50], [100, 5, 50]], 100);
  assert.equal(scale, 0.46);                 // 92 px for the 200 units across
  assert.ok(Math.abs(ox + -100 * scale - 4) < 1e-9);   // the west edge at the padding
  assert.ok(Math.abs(oz + -50 * scale - 27) < 1e-9);   // the narrower side centred
  assert.ok(Math.abs(oz + 50 * scale - 73) < 1e-9);
});

test('the route takes the shorter way round through next and neighbour links', () => {
  const fields = ['index', 'role', 'next', 'branch', 'neighbour', 'points'];
  // A square of lanes 1 -> 2 -> 3 -> 1, and lane 4 beside lane 1 joined only as its neighbour.
  const courses = { course_fields: fields, courses: [
    [0, 'line', 0, 0, 0, [[0, 0, 0]]],
    [1, 'stage', 2, 0, 4, [[0, 0, 0], [100, 0, 0]]],
    [2, 'stage', 3, 0, 0, [[100, 0, 10], [100, 0, 100]]],
    [3, 'stage', 1, 0, 0, [[90, 0, 100], [0, 0, 100], [0, 0, 10]]],
    [4, 'stage', 0, 0, 1, [[0, 0, 40], [100, 0, 40]]],
  ] };
  const g = roadGraph(courses);
  assert.equal(g.pts.length, 9);   // the line course is not a road to route on
  const to = nearestPoint(g.pts, [0, 0, 100]);
  const { dist, prev } = routeTree(g, to);
  const path = [];
  for (let i = nearestPoint(g.pts, [100, 0, 100], dist); i >= 0; i = prev[i]) path.push(g.pts[i]);
  assert.deepEqual(path, [[100, 0, 100], [90, 0, 100], [0, 0, 100]]);   // not back round lanes 2 and 1
  assert.ok(dist[nearestPoint(g.pts, [100, 0, 40])] < Infinity);         // lane 4 is reachable
});
