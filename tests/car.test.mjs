// node --test: the cab over the extracted Arcade collision (skipped without local-assets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Collision, KIND_NAMES } from '../src/collision.js';
import { Car, STEP } from '../src/car.js';
import { START } from '../src/start.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const COL = new URL('collision/arcade.json', ROOT);
const COURSES = new URL('courses/arcade.json', ROOT);
const have = existsSync(COL) && existsSync(COURSES);
const load = (u) => JSON.parse(readFileSync(u, 'utf8'));

const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false, drivePressed: false, reversePressed: false };

function setup() {
  const collision = new Collision(load(COL));
  const courses = load(COURSES);
  const F = courses.course_fields;
  const pts = [];
  for (const c of courses.courses) if (c[F.indexOf('role')] === 'stage') pts.push(...c[F.indexOf('points')]);
  const car = new Car(collision, pts);
  car.place(START.arcade);
  return { car, collision };
}

test('placed at the Arcade start the cab rests on the ground and stays put', { skip: !have }, () => {
  const { car } = setup();
  assert.ok(Math.abs(car.pos.y - 1502) < 0.5, `y ${car.pos.y}`);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.equal(car.speed, 0);
  assert.ok(Math.abs(car.pos.x - START.arcade.x) < 1e-6);
  assert.ok(Math.abs(car.pos.z - START.arcade.z) < 1e-6);
  assert.equal(car.recoveries, 0);
  assert.ok(car.onGround);
});

test('full throttle along the main line from the start keeps to the road', { skip: !have }, () => {
  const { car } = setup();
  // Course 0 runs along +x past the start (z 1700); the start spot itself faces across the road.
  car.place({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  const gas = { ...IDLE, accel: 1 };
  const kinds = new Set();
  let top = 0;
  for (let i = 0; i < 60 * 8; i++) {
    car.update(gas);
    kinds.add(KIND_NAMES[car.groundKind]);
    top = Math.max(top, car.kmh());
  }
  assert.ok(kinds.has('#road'), [...kinds].join());
  assert.ok(top > 120 && top < 200, `top ${top}`);
  assert.equal(car.recoveries, 0);
  const moved = Math.hypot(car.pos.x - START.arcade.x, car.pos.z - 1700);
  assert.ok(moved > 1500, `moved ${moved}`);
});

test('the start spot faces across the road: full throttle meets the far kerb wall', { skip: !have }, () => {
  const { car } = setup();
  let hits = 0;
  for (let i = 0; i < 60 * 6; i++) {
    car.update({ ...IDLE, accel: 1 });
    if (car.lastWall) hits++;
  }
  assert.ok(hits > 0);
  assert.equal(car.recoveries, 0);
  assert.ok(car.pos.z < 1600 && car.pos.z > 1400, `z ${car.pos.z}`);
});

test('brake stops the cab without rolling it backwards', { skip: !have }, () => {
  const { car } = setup();
  for (let i = 0; i < 120; i++) car.update({ ...IDLE, accel: 1 });
  assert.ok(car.speed > 0);
  for (let i = 0; i < 240; i++) car.update({ ...IDLE, brake: 1 });
  assert.equal(car.speed, 0);
});

test('reverse gear backs up, drive gear goes forward again', { skip: !have }, () => {
  const { car } = setup();
  for (let i = 0; i < 60; i++) car.update({ ...IDLE, accel: 1, reverse: true });
  assert.equal(car.gear, 0);
  assert.ok(car.speed < 0);
  car.update({ ...IDLE, drivePressed: true, drive: true });
  assert.equal(car.gear, 1);
  for (let i = 0; i < 180; i++) car.update({ ...IDLE, accel: 1 });
  assert.ok(car.speed > 0);
});

test('a wall stops the cab (driving -z from the start into the kerb walls)', { skip: !have }, () => {
  const { car, collision } = setup();
  // Find the nearest wall straight behind the start, drive the heading at it.
  car.place({ ...START.arcade, heading: Math.PI }); // forward = (0, 0, -1)
  let hits = 0;
  for (let i = 0; i < 60 * 10; i++) {
    car.update({ ...IDLE, accel: 1 });
    if (car.lastWall) hits++;
  }
  assert.ok(hits > 0, 'never touched a wall');
  assert.equal(car.recoveries, 0);
  // Still over ground, never through it.
  const g = collision.groundAt(car.pos.x, car.pos.y + 6, car.pos.z, 1);
  assert.ok(g && Math.abs(g.y - car.pos.y) < 2, `off the ground: ${JSON.stringify(g)} vs ${car.pos.y}`);
});

test('out of the world: recovery onto the nearest stage point lifted by 30', { skip: !have }, () => {
  const { car } = setup();
  car.pos.x = 30000; car.pos.z = 30000;
  car.update(IDLE);
  assert.equal(car.recoveries, 1);
  assert.ok(car.pos.x < 20000);
  assert.equal(car.speed, 0);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.ok(car.onGround);
  assert.equal(car.recoveries, 1);
});

test('STEP is the Dreamcast frame', () => {
  assert.equal(STEP, 1 / 60);
});

const ORIG = new URL('collision/original.json', ROOT);
test('Original start spots rest on the ground (init_CarMain fixed values)', { skip: !existsSync(ORIG) }, () => {
  const collision = new Collision(load(ORIG));
  for (const [name, start, kind] of [['original', START.original, '#road'], ['original_reverse', START.original_reverse, '#hodou']]) {
    const car = new Car(collision, []);
    car.place(start);
    assert.ok(Math.abs(car.pos.y - start.y) < 3, `${name} y ${car.pos.y} vs ${start.y}`);
    for (let i = 0; i < 60; i++) car.update(IDLE);
    assert.ok(car.onGround, name);
    assert.equal(KIND_NAMES[car.groundKind], kind, name);
    assert.equal(car.recoveries, 0, name);
  }
});
