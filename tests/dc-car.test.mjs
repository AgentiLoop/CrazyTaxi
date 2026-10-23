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

/**
 * Bit for bit, except that two values both within 1e-9 of zero count as equal: a standing
 * traffic car's speed (1e-12, zero in effect) depends on the last bit of fsca, which both
 * simulators take from their libm's sine instead of the SH-4's table. Returns the count
 * of such near-zero differences.
 */
function assertSame(got, want, path) {
  if (Array.isArray(want)) {
    assert.equal(got.length, want.length, `${path}: length`);
    let n = 0;
    for (let i = 0; i < want.length; i++) n += assertSame(got[i], want[i], `${path}[${i}]`);
    return n;
  }
  if (want && typeof want === 'object') {
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${path}: keys`);
    let n = 0;
    for (const k of Object.keys(want)) n += assertSame(got[k], want[k], `${path}.${k}`);
    return n;
  }
  if (got === want) return 0;
  if (typeof got === 'number' && Math.abs(got) < 1e-9 && Math.abs(want) < 1e-9) return 1;
  return assert.fail(`${path}: ${got} !== ${want}`);
}

for (const [city, name] of [[0, 'car-trace-arcade.json'], [1, 'car-trace-original.json']]) {
  test(`city ${city}: every frame of the recorded run - the countdown with the start camera, then driving: the cab, the camera and every traffic car - matches the simulator bit for bit`, { skip: !have }, () => {
    const car = make(city);
    const trace = fixture(name);
    car.startIntro();           // the countdown begins: SetStartCamera
    assert.deepEqual([car.pos.x, car.pos.y, car.pos.z], trace.start.pos);
    assert.equal(car.carCount, trace.start.carEntryNum);
    assert.equal(trace.countdown, 366);
    let drawn = 0, live = 0, nearZero = 0;
    for (let f = 0; f < trace.frames.length; f++) {
      const fr = trace.frames[f], inp = fr.input;
      car.stickX = inp.steer;    // the keyboard shaping is not part of the game
      car.intro = fr.intro;
      car.hold = fr.hold;
      car.update({ steer: inp.steer, accel: inp.accel, brake: inp.brake, drive: !!inp.drive, reverse: !!inp.reverse });
      const cpu = car.cpu;
      const cam = car.camera();
      const got = {
        pos: [car.pos.x, car.pos.y, car.pos.z],
        ang: [cpu.rs16(CAR + 0x84), cpu.rs16(CAR + 0x86), cpu.rs16(CAR + 0x88)],
        speed: cpu.rf(CAR + 0x15C), rpm: cpu.rf(CAR + 0x158), gear: car.gear,
        steer: [0, 1, 2, 3].map((w) => cpu.rs16(CAR + 0x1A0 + w * 0x84 + 0x80)),
        ground: cpu.r32(0x0C177210),
        carEntryNum: car.carCount, trafficLevel: car.trafficLevel,
        cars: car.cars.map((c) => c.raw),
        live: car.liveCars().map((c) => c.raw),
        camera: { eye: cam.eye, target: cam.target, angles: cam.angles, mode: cam.mode, fov: cam.fov, view: Array.from(cam.view) },
      };
      const { input, intro, hold, ...want } = fr;
      nearZero += assertSame(got, want, `frame ${f}`);
      drawn += got.cars.length; live += got.live.length;
    }
    assert.equal(car.recoveries, 0);
    assert.ok(drawn > 1000 && live > 4000, `${drawn} drawn, ${live} live car-frames`);
    assert.ok(nearZero < 200, `${nearZero} near-zero differences`);
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

// --- the camera ---

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const flat = (v) => Math.hypot(v[0], v[2]);

test('the chase camera (camUpdate mode 0): the eye 60 behind and 15 above the standing cab, the target 17 ahead and 5 up; the view matrix is three.js\'s look-at', { skip: !have }, () => {
  const car = make(0);
  for (let i = 0; i < 300; i++) car.update(IDLE);   // the homing vectors settle
  const cam = car.camera();
  const pos = [car.pos.x, car.pos.y, car.pos.z], f = car.forward();
  assert.equal(cam.mode, 0);
  assert.equal(cam.fov, 60);
  const eye = sub(cam.eye, pos), target = sub(cam.target, pos);
  assert.ok(Math.abs(flat(eye) - 60) < 0.5 && Math.abs(eye[1] - 15) < 0.5, `eye offset ${eye}`);
  assert.ok(Math.abs(flat(target) - 17) < 0.5 && Math.abs(target[1] - 5) < 0.5, `target offset ${target}`);
  assert.ok(dot(eye, [f.x, 0, f.z]) < -59, 'behind the cab');
  assert.ok(dot(target, [f.x, 0, f.z]) > 16, 'ahead of the cab');
  // Column major: row 2 of the rotation is the camera's back direction, the translation -R * eye.
  const back = sub(cam.eye, cam.target), n = Math.hypot(...back);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(cam.view[2 + 4 * i] - back[i] / n) < 1e-3, `view row 2 ${i}`);
  const t = [0, 1, 2].map((r) => -(cam.view[r] * cam.eye[0] + cam.view[4 + r] * cam.eye[1] + cam.view[8 + r] * cam.eye[2]));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(cam.view[12 + i] - t[i]) < 0.05, `view translation ${i}: ${cam.view[12 + i]} vs ${t[i]}`);
  assert.equal(cam.view[15], 1);
});

test('the chase camera follows the moving cab and the countdown plays the start camera (mode 7, the eye swinging round the cab, the view widening to 70 degrees)', { skip: !have }, () => {
  const car = make(0);
  const modes = new Set(), fovs = new Set();
  let minDist = Infinity, maxDist = 0;
  car.startIntro(); car.hold = true;
  for (let i = 0; i < 365; i++) {
    if (i === 305) car.hold = false;
    car.update(IDLE);
    const cam = car.camera();
    modes.add(cam.mode); fovs.add(cam.fov);
    if (i > 0 && cam.mode === 7) { const d = flat(sub(cam.eye, [car.pos.x, car.pos.y, car.pos.z])); minDist = Math.min(minDist, d); maxDist = Math.max(maxDist, d); }
  }
  assert.ok(modes.has(7) && modes.has(0), [...modes].join());
  assert.ok(fovs.has(70) && fovs.has(60), [...fovs].join());
  assert.ok(minDist < 40 && maxDist > 25, `start camera distance ${minDist}..${maxDist}`);
  car.intro = false;
  assert.equal(car.speed, 0);
  for (let i = 0; i < 240; i++) {
    car.update(GAS);
    const cam = car.camera();
    const d = flat(sub(cam.eye, [car.pos.x, car.pos.y, car.pos.z]));
    assert.ok(d > 40 && d < 130, `frame ${i}: the eye ${d} from the cab`);
    assert.ok(dot(sub(cam.target, cam.eye), sub([car.pos.x, car.pos.y, car.pos.z], cam.eye)) > 0, 'looking at the cab');
  }
  assert.ok(car.kmh() > 100);
});

test('the drawn traffic is inside the game camera\'s cone within 1800 and (but for a car removed the same frame) a subset of the live cars', { skip: !have }, () => {
  const car = make(0);
  let drawn = 0, gone = 0;
  for (let i = 0; i < 300; i++) {
    car.update(i < 240 ? IDLE : GAS);
    const cam = car.camera();
    const fwd = sub(cam.target, cam.eye), n = Math.hypot(...fwd);
    const live = new Set(car.liveCars().map((c) => c.id));
    for (const c of car.cars) {
      if (!live.has(c.id)) gone++;   // drawn by entryCarPut, then removed by trafficControl the same frame
      assert.ok(c.detail === 0 || c.detail === 1);
      assert.ok(c.flags & ON_SCREEN);
      const d = sub([c.x, c.y, c.z], cam.eye);
      const along = dot(d, fwd) / n;
      assert.ok(along > 0 && along < 1800 + 60, `car at ${along} along the view`);
      drawn++;
    }
  }
  assert.ok(drawn > 100, `${drawn} drawn car-frames`);
  assert.ok(gone < drawn / 20, `${gone} of ${drawn} drawn cars removed the same frame`);
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
