// node --test: the game's own car physics and traffic (src/dc-car.js running the
// USA executable in src/sh4.js) against traces recorded by the decomp's SH-4
// simulator (tools/car_trace.py), plus the behaviours the game relies on.
// Skipped without local-assets/disc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastCar, STEP, carFiles } from '../src/dc-car.js';
import { START } from '../src/start.js';
import { KIND_NAMES } from '../src/collision.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const have = existsSync(new URL('disc/COLDC2.BIN', ROOT));
const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const json = (path) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));

function make(city = 0) {
  const files = carFiles(city);
  const data = {};
  for (const k in files) data[k] = readFileSync(new URL(files[k], ROOT));
  return new DreamcastCar(data, { city });
}

const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false };
const GAS = { ...IDLE, accel: 1 };
const CAR = 0x0C176E4C;
const MOVING = 4, PARKED = 0x10, ON_SCREEN = 0x10000;
const RAIL = (type) => type >= 15;

for (const [city, name] of [[0, 'car-trace-arcade.json'], [1, 'car-trace-original.json']]) {
  test(`city ${city}: every frame of the recorded run - the cab and every traffic car - matches the simulator bit for bit`, { skip: !have }, () => {
    const car = make(city);
    const trace = fixture(name);
    assert.deepEqual([car.pos.x, car.pos.y, car.pos.z], trace.start.pos);
    assert.equal(car.carCount, trace.start.carEntryNum);
    let drawn = 0, live = 0;
    for (let f = 0; f < trace.frames.length; f++) {
      const fr = trace.frames[f], inp = fr.input;
      car.stickX = inp.steer;    // the keyboard shaping is not part of the game
      car.update({ steer: inp.steer, accel: inp.accel, brake: inp.brake, drive: !!inp.drive, reverse: !!inp.reverse });
      const cpu = car.cpu;
      const got = {
        pos: [car.pos.x, car.pos.y, car.pos.z],
        ang: [cpu.rs16(CAR + 0x84), cpu.rs16(CAR + 0x86), cpu.rs16(CAR + 0x88)],
        speed: cpu.rf(CAR + 0x15C), rpm: cpu.rf(CAR + 0x158), gear: car.gear,
        steer: [0, 1, 2, 3].map((w) => cpu.rs16(CAR + 0x1A0 + w * 0x84 + 0x80)),
        ground: cpu.r32(0x0C177210),
        carEntryNum: car.carCount, trafficLevel: car.trafficLevel,
        cars: car.cars.map((c) => c.raw),
        live: car.liveCars().map((c) => c.raw),
      };
      const { input, ...want } = fr;
      assert.deepEqual(got, want, `frame ${f}`);
      drawn += got.cars.length; live += got.live.length;
    }
    assert.equal(car.recoveries, 0);
    assert.ok(drawn > 1000 && live > 4000, `${drawn} drawn, ${live} live car-frames`);
  });
}

test('the Arcade start is init_CarMain\'s: course 0 last point + 135 z, heading 0x5000, on #hodou', { skip: !have }, () => {
  const car = make(0);
  assert.ok(Math.abs(car.pos.x - START.arcade.x) < 1e-3 && Math.abs(car.pos.z - START.arcade.z) < 1e-3);
  assert.equal(car.cpu.r16(CAR + 0x86), 0x5000);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.equal(KIND_NAMES[car.groundKind], '#hodou');
  assert.ok(Math.abs(car.pos.y - 1504) < 0.5, `settled y ${car.pos.y}`);
  assert.equal(car.speed, 0);
  assert.ok(Math.abs(car.pos.x - START.arcade.x) < 0.05 && Math.abs(car.pos.z - START.arcade.z) < 0.05);
});

test('full throttle along the main line: gears climb, 100 km/h within 4 s, the road is #road', { skip: !have }, () => {
  const car = make(0);
  car.place({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  car.stickX = 0;
  const gears = new Set(), kinds = new Set();
  let top = 0;
  for (let i = 0; i < 240; i++) {
    car.update(GAS);
    gears.add(car.gear); kinds.add(KIND_NAMES[car.groundKind]);
    top = Math.max(top, car.kmh());
  }
  assert.ok(gears.has(1) && gears.has(2) && gears.has(3), [...gears].join());
  assert.ok(top > 100, `top ${top}`);
  assert.ok(kinds.has('#road'), [...kinds].join());
  assert.equal(car.recoveries, 0);
  assert.ok(car.pos.x - START.arcade.x > 800, `moved ${car.pos.x - START.arcade.x}`);
});

test('the brake stops the cab; A backs it up; B drives again', { skip: !have }, () => {
  const car = make(0);
  car.place({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  for (let i = 0; i < 120; i++) car.update(GAS);
  assert.ok(car.speed > 0);
  for (let i = 0; i < 180; i++) car.update({ ...IDLE, brake: 1 });
  assert.ok(Math.abs(car.speed) < 1, `speed ${car.speed}`);
  for (let i = 0; i < 60; i++) car.update({ ...GAS, reverse: true });
  assert.equal(car.gear, 0);
  assert.ok(car.speed < 0);
  for (let i = 0; i < 90; i++) car.update({ ...GAS, drive: true });
  assert.ok(car.gear >= 1);
  assert.ok(car.speed > 0);
});

test('the steering stick curve: dead zone 0.04, quadratic to 0.1, linear to 4320 at full stick', { skip: !have }, () => {
  const car = make(0);
  const steerFor = (s) => { car.stickX = s; car.update({ ...IDLE, steer: s }); return car.cpu.rs16(CAR + 0x114); };
  assert.equal(steerFor(0.03), 0);
  assert.equal(steerFor(0.08), -Math.trunc(0.04 * 0.04 / 0.06 * 4500));   // -(s - 0.04)^2 / 0.06 * 4500
  assert.ok(Math.abs(steerFor(0.3) + 0.26 * 4500) <= 1);                 // -(s - 0.04) * 4500
  assert.ok(Math.abs(steerFor(-1) - 0.96 * 4500) <= 1);                 // 4320 at full stick: the 0x1100 clamp is never reached
  assert.ok(Math.abs(steerFor(1) + 0.96 * 4500) <= 1);
  assert.ok(Math.abs(car.wheelSteer[2] / car.wheelSteer[0]) < 0.05, 'the rear wheels hardly steer at full lock');
  steerFor(0.3);
  assert.equal(car.wheelSteer[0], car.steer);
  assert.ok(Math.abs(car.wheelSteer[2] / car.wheelSteer[0] - 0.37) < 0.01, 'the rear wheels steer 0.37 of the front below 0x600');
});

test('held (countdown, customer getting in): no throttle, no speed', { skip: !have }, () => {
  const car = make(0);
  car.place({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  car.hold = true;
  for (let i = 0; i < 60; i++) car.update(GAS);
  assert.equal(car.speed, 0);
  car.hold = false;
  for (let i = 0; i < 60; i++) car.update(GAS);
  assert.ok(car.speed > 0);
});

test('out of the world: carGroundCheck puts the cab on the nearest course point, lifted by 30', { skip: !have }, () => {
  const car = make(0);
  car.place({ x: 30000, y: 1500, z: 30000, heading: 0 });
  car.update(IDLE);
  assert.equal(car.recoveries, 1);
  assert.ok(car.pos.x < 20000);
  assert.equal(car.speed, 0);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.equal(car.recoveries, 1);
  assert.ok(car.onGround);
});

// --- the traffic ---

for (const [city, name] of [[0, 'arcade'], [1, 'original']]) {
  test(`${name}: traffic cars appear around the cab, follow their course lines and move`, { skip: !have }, () => {
    const car = make(city);
    const courses = json(`courses/${name}.json`);
    const F = courses.course_fields;
    const points = courses.courses.map((c) => c[F.indexOf('points')]);
    const before = new Map();
    let moved = 0, checked = 0, maxOff = 0;
    for (let i = 0; i < 180; i++) {
      car.update(GAS);
      for (const c of car.liveCars()) {
        if (RAIL(c.type)) continue;
        const p = points[c.course][c.point];
        const off = Math.hypot(c.x - p[0], c.z - p[2]);
        if (c.flags & MOVING) { maxOff = Math.max(maxOff, off); checked++; }
        assert.ok(Math.hypot(c.x - car.pos.x, c.z - car.pos.z) < 1100 + 500 + 30 + 60,
          `car ${c.type} at ${Math.hypot(c.x - car.pos.x, c.z - car.pos.z)} from the cab`);
        const b = before.get(c.id);
        if (b && (b.x !== c.x || b.z !== c.z)) moved++;
        before.set(c.id, { x: c.x, z: c.z });
      }
    }
    assert.ok(car.carCount >= 8, `${car.carCount} cars`);
    assert.ok(checked > 500 && maxOff < 40, `${checked} moving car-frames, at most ${maxOff} off their course point (lane changes)`);
    assert.ok(moved > 500, `${moved} car-frames moved`);
    assert.equal(car.trafficLevel, 0);
  });
}

test('the test camera (at the cab, looking +x) sees the cars ahead; the drawn list is a subset of the live cars', { skip: !have }, () => {
  const car = make(0);
  let drawn = 0;
  for (let i = 0; i < 60; i++) {
    car.update(IDLE);
    const live = new Set(car.liveCars().map((c) => c.id));
    for (const c of car.cars) {
      assert.ok(live.has(c.id));
      assert.ok(c.detail === 0 || c.detail === 1);
      assert.ok(c.flags & ON_SCREEN);
      assert.ok(c.x > car.pos.x, 'ahead of the camera');
      drawn++;
    }
  }
  assert.ok(drawn > 100, `${drawn} drawn car-frames`);
  // A camera looking the other way (-x) sees only the cars behind.
  car.setCamera([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, car.pos.z, -car.pos.y, -car.pos.x, 1], 60);
  car.update(IDLE);
  for (const c of car.cars) assert.ok(c.x < car.pos.x, 'behind the cab');
  car.setCamera(null);
  car.update(IDLE);
  assert.ok(car.cars.length > 0);
});

test('a traffic car that stands still long enough on a taken road, parked cars and the rail vehicles exist', { skip: !have }, () => {
  const car = make(1);
  const types = new Set(), flags = new Set();
  for (let i = 0; i < 120; i++) {
    car.update(IDLE);
    for (const c of car.liveCars()) { types.add(c.type); if (c.flags & PARKED) flags.add('parked'); if (RAIL(c.type)) flags.add('rail'); }
  }
  assert.ok(types.size >= 5, [...types].join());
  assert.ok(flags.has('rail'), 'the Original city has trains');
});

test('driving into a traffic car: the game\'s collision objects slow the cab and shove the car', { skip: !have }, () => {
  const car = make(0);
  for (let i = 0; i < 60; i++) car.update(GAS);
  const target = car.liveCars().find((c) => (c.flags & MOVING) && !RAIL(c.type) && c.x > car.pos.x && Math.abs(c.heading - Math.PI / 2) < 0.1);
  assert.ok(target, 'a car drives ahead along +x');
  car.moveTo({ x: target.x - 120, y: target.y + 1, z: target.z, heading: Math.PI / 2 });
  let hit = null, peak = 0;
  for (let i = 0; i < 120 && !hit; i++) {
    const v0 = car.speed;
    car.update(GAS);
    peak = Math.max(peak, v0);
    const t = car.liveCars().find((c) => c.id === target.id);
    if (t && car.speed < v0 * 0.7 && t.speed > target.speed * 2) hit = { frame: i, before: v0, after: car.speed, carSpeed: t.speed };
  }
  assert.ok(hit, `no collision: peak ${peak}`);
  assert.ok(hit.before > 150, `the cab was fast: ${hit.before}`);
  assert.ok(hit.carSpeed > 2, `the traffic car was shoved: ${hit.carSpeed} u/frame`);
});

test('moving the cab far away removes the traffic left behind', { skip: !have }, () => {
  const car = make(0);
  for (let i = 0; i < 60; i++) car.update(IDLE);
  assert.ok(car.liveCars().filter((c) => !RAIL(c.type)).length >= 5);
  car.moveTo({ x: START.arcade.x + 4000, y: START.arcade.y, z: START.arcade.z, heading: 0 });
  car.update(IDLE);
  assert.equal(car.liveCars().filter((c) => !RAIL(c.type)).length, 0, 'the old cars are gone');
  for (let i = 0; i < 5; i++) car.update(IDLE);
  const now = car.liveCars().filter((c) => !RAIL(c.type));
  assert.ok(now.length >= 5, 'new cars around the new spot');
  assert.equal(now.filter((c) => Math.hypot(c.x - car.pos.x, c.z - car.pos.z) > 1700).length, 0);
});

test('a frame of the game - the cab and the traffic - is cheap enough for 60 Hz', { skip: !have }, () => {
  const car = make(0);
  for (let i = 0; i < 60; i++) car.update(GAS);
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) car.update({ ...GAS, steer: 0.3 });
  const ms = (performance.now() - t0) / 120;
  assert.ok(ms < 8, `${ms} ms per frame`);
});

test('STEP is the Dreamcast frame', () => {
  assert.equal(STEP, 1 / 60);
});
