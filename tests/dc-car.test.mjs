// node --test: the game's own car physics (src/dc-car.js running the USA
// executable in src/sh4.js) against traces recorded by the decomp's SH-4
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

function make(city = 0) {
  const files = carFiles(city);
  const data = {};
  for (const k in files) data[k] = readFileSync(new URL(files[k], ROOT));
  return new DreamcastCar(data, { city });
}

const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false };
const CAR = 0x0C176E4C;

for (const [city, name] of [[0, 'car-trace-arcade.json'], [1, 'car-trace-original.json']]) {
  test(`city ${city}: every frame of the recorded run matches the simulator bit for bit`, { skip: !have }, () => {
    const car = make(city);
    const trace = fixture(name);
    assert.deepEqual([car.pos.x, car.pos.y, car.pos.z], trace.start.pos);
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
      };
      const { input, ...want } = fr;
      assert.deepEqual(got, want, `frame ${f}`);
    }
    assert.equal(car.recoveries, 0);
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
    car.update({ ...IDLE, accel: 1 });
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
  for (let i = 0; i < 120; i++) car.update({ ...IDLE, accel: 1 });
  assert.ok(car.speed > 0);
  for (let i = 0; i < 180; i++) car.update({ ...IDLE, brake: 1 });
  assert.ok(Math.abs(car.speed) < 1, `speed ${car.speed}`);
  for (let i = 0; i < 60; i++) car.update({ ...IDLE, accel: 1, reverse: true });
  assert.equal(car.gear, 0);
  assert.ok(car.speed < 0);
  for (let i = 0; i < 90; i++) car.update({ ...IDLE, accel: 1, drive: true });
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
  for (let i = 0; i < 60; i++) car.update({ ...IDLE, accel: 1 });
  assert.equal(car.speed, 0);
  car.hold = false;
  for (let i = 0; i < 60; i++) car.update({ ...IDLE, accel: 1 });
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

test('a frame of exec_CarMain is cheap enough for 60 Hz', { skip: !have }, () => {
  const car = make(0);
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) car.update({ ...IDLE, accel: 1, steer: 0.3 });
  const ms = (performance.now() - t0) / 120;
  assert.ok(ms < 5, `${ms} ms per frame`);
});

test('STEP is the Dreamcast frame', () => {
  assert.equal(STEP, 1 / 60);
});
