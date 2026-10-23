// node --test: the game's own code - the car physics, the traffic, the camera, the game
// system and the customers (src/dc-car.js running the USA executable in src/sh4.js) -
// against traces recorded by the decomp's SH-4 simulator (tools/car_trace.py), plus the
// behaviours the game relies on. Skipped without local-assets/disc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastCar, STEP, carFiles, formatMoney } from '../src/dc-car.js';
import { START } from '../src/start.js';
import { KIND_NAMES } from '../src/collision.js';
import { fcvPose, vKey } from '../src/people.js';

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
const HELD = { ...IDLE, brake: 1 };
const CAR = 0x0C176E4C;
const MOVING = 4, PARKED = 0x10, ON_SCREEN = 0x10000;
const RAIL = (type) => type >= 15;

/** The countdown (366 frames; the game releases the cab when 60 remain): run until the run starts. */
function start(car) {
  let n = 0;
  while (car.gameSystem().state === 0 && n++ < 400) car.update(IDLE);
  assert.equal(car.gameSystem().state, 1);
  return car;
}

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

const plain = (v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);

for (const [city, name] of [[0, 'car-trace-arcade.json'], [1, 'car-trace-original.json']]) {
  test(`city ${city}: every frame of the recorded fare - the countdown, the cab, the camera, every traffic car, the game system, the customers and the people drawn - matches the simulator bit for bit`, { skip: !have }, () => {
    const car = make(city);
    const trace = fixture(name);
    assert.deepEqual([car.pos.x, car.pos.y, car.pos.z], trace.start.pos);
    assert.equal(car.carCount, trace.start.carEntryNum);
    assert.equal(trace.countdown, 366);
    const teleports = new Map(trace.teleports.map((t) => [t.frame, t.to]));
    let drawn = 0, live = 0, people = 0, nearZero = 0;
    const events = [];
    for (let f = 0; f < trace.frames.length; f++) {
      const fr = trace.frames[f], inp = fr.input;
      const to = teleports.get(f);
      if (to) car.moveTo({ x: to[0], y: to[1], z: to[2], heading: 0 });
      car.stickX = inp.steer;    // the keyboard shaping is not part of the game
      car.update({ steer: inp.steer, accel: inp.accel, brake: inp.brake, drive: !!inp.drive, reverse: !!inp.reverse });
      const cpu = car.cpu;
      const cam = car.camera();
      const got = {
        pos: [car.pos.x, car.pos.y, car.pos.z],
        ang: [cpu.rs16(CAR + 0x84), cpu.rs16(CAR + 0x86), cpu.rs16(CAR + 0x88)],
        speed: cpu.rf(CAR + 0x15C), rpm: cpu.rf(CAR + 0x158), gear: car.gear,
        steer: [0, 1, 2, 3].map((w) => cpu.rs16(CAR + 0x1A0 + w * 0x84 + 0x80)),
        control: car.control,
        ground: cpu.r32(0x0C177210),
        carEntryNum: car.carCount, trafficLevel: car.trafficLevel,
        cars: car.cars.map((c) => c.raw),
        live: car.liveCars().map((c) => c.raw),
        camera: { eye: cam.eye, target: cam.target, angles: cam.angles, mode: cam.mode, fov: cam.fov, view: Array.from(cam.view) },
        gs: car.gameSystem(),
        customers: car.customers(),
        people: car.people.map((p) => ({ ...p, matrix: plain(p.matrix) })),
        sounds: car.sounds, voices: car.voices, music: car.musicCue,
      };
      const { input, events: wantEvents, ...want } = fr;
      nearZero += assertSame(got, want, `frame ${f}`);
      assert.deepEqual(car.events.map((e) => e.type), wantEvents, `frame ${f}: events`);
      events.push(...car.events.map((e) => e.type));
      drawn += got.cars.length; live += got.live.length; people += got.people.length;
    }
    assert.equal(car.recoveries, 0);
    assert.deepEqual(events, ['in', 'out']);
    assert.ok(drawn > 500 && live > 4000, `${drawn} drawn, ${live} live car-frames`);
    assert.ok(people > 1200, `${people} people drawn`);   // 1459 Arcade, 1289 Original
    assert.ok(nearZero < 400, `${nearZero} near-zero differences`);   // 306 Arcade
    const gs = car.gameSystem();
    assert.equal(gs.delivered, 1);
    assert.ok(gs.cash > 0);
  });
}

// --- the cab ---

test('the Arcade start is init_CarMain\'s: course 0 last point + 135 z, heading 0x5000, on #hodou; the countdown holds the cab (control 3) and releases it when 60 frames remain', { skip: !have }, () => {
  const car = make(0);
  assert.ok(Math.abs(car.pos.x - START.arcade.x) < 1e-3 && Math.abs(car.pos.z - START.arcade.z) < 1e-3);
  assert.equal(car.cpu.r16(CAR + 0x86), 0x5000);
  assert.equal(car.control, 3);
  assert.deepEqual([car.gameSystem().state, car.gameSystem().counter], [0, 366]);
  for (let i = 0; i < 305; i++) {
    car.update(GAS);
    assert.equal(car.speed, 0, `frame ${i}: held`);
  }
  assert.equal(car.gameSystem().counter, 61);
  assert.equal(car.control, 3);
  car.update(GAS);
  assert.equal(car.gameSystem().counter, 60);
  assert.ok(car.control !== 3 && car.control !== 0, `released: control ${car.control}`);
  for (let i = 0; i < 60; i++) car.update(GAS);
  assert.equal(car.gameSystem().state, 1);
  assert.ok(car.speed > 0);
});

test('standing through the countdown the cab settles on #hodou at its start', { skip: !have }, () => {
  const car = make(0);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.equal(KIND_NAMES[car.groundKind], '#hodou');
  assert.ok(Math.abs(car.pos.y - 1504) < 0.5, `settled y ${car.pos.y}`);
  assert.equal(car.speed, 0);
  assert.ok(Math.abs(car.pos.x - START.arcade.x) < 0.05 && Math.abs(car.pos.z - START.arcade.z) < 0.05);
});

test('full throttle along the main line: gears climb, 100 km/h within 4 s, the road is #road', { skip: !have }, () => {
  const car = start(make(0));
  car.moveTo({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
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
  const car = start(make(0));
  car.moveTo({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  for (let i = 0; i < 120; i++) car.update(GAS);
  assert.ok(car.speed > 0);
  for (let i = 0; i < 180; i++) car.update(HELD);
  assert.ok(Math.abs(car.speed) < 1, `speed ${car.speed}`);
  for (let i = 0; i < 60; i++) car.update({ ...GAS, reverse: true });
  assert.equal(car.gear, 0);
  assert.ok(car.speed < 0);
  for (let i = 0; i < 90; i++) car.update({ ...GAS, drive: true });
  assert.ok(car.gear >= 1);
  assert.ok(car.speed > 0);
});

test('the steering stick curve: dead zone 0.04, quadratic to 0.1, linear to 4320 at full stick', { skip: !have }, () => {
  const car = start(make(0));
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

test('out of the world: carGroundCheck puts the cab on the nearest course point, lifted by 30', { skip: !have }, () => {
  const car = start(make(0));
  car.moveTo({ x: 30000, y: 1500, z: 30000, heading: 0 });
  car.update(IDLE);
  assert.equal(car.recoveries, 1);
  assert.ok(car.pos.x < 20000);
  assert.equal(car.speed, 0);
  for (let i = 0; i < 120; i++) car.update(IDLE);
  assert.equal(car.recoveries, 1);
  assert.ok(car.onGround);
});

// --- the game system ---

test('init_GameSystem: 50 s (the option table), the countdown state; the clock runs once the countdown ends and stops at time up', { skip: !have }, () => {
  const car = make(0);
  let gs = car.gameSystem();
  assert.deepEqual([gs.state, gs.counter, gs.time, gs.cash, gs.aboard, gs.delivered, gs.level], [0, 366, 50 * 60, 0, 0, 0, 0]);
  for (let i = 0; i < 366; i++) { car.update(IDLE); assert.equal(car.gameSystem().time, 3000, `frame ${i}: the clock waits`); }
  gs = car.gameSystem();
  assert.deepEqual([gs.state, gs.started, gs.time], [1, 1, 3000]);
  car.update(IDLE);
  assert.equal(car.gameSystem().time, 2999);
  // Time up: the state handler's counter runs 150 frames, the cab is held.
  car.cpu.w32(0x0C1EC4A8 + 0xC, 1);
  car.update(GAS);
  assert.deepEqual([car.gameSystem().state, car.gameSystem().counter, car.events.map((e) => e.type)], [2, 150, ['timeUp']]);
  for (let i = 0; i < 160; i++) car.update(GAS);
  assert.ok(car.gameSystem().counter < 0);
  assert.equal(car.control, 0);
  assert.equal(car.speed, 0);
});

// --- the customers ---

/** The fare by teleport: beside the first waiting customer, then to the destination; returns what happened. */
function fare(car, stops) {
  const first = car.customers()[0];
  assert.ok(first, 'a customer waits near the start');
  car.moveTo({ x: first.spot[0] + 30, y: first.spot[1], z: first.spot[2], heading: 0 });
  const log = { in: null, out: null, held: 0, modes: new Set(), charas: new Set(), kinds: new Set() };
  const step = (input) => {
    car.update(input);
    for (const e of car.events) if (e.type === 'in' || e.type === 'out') log[e.type] = { frame: car.frames, ...e, gs: car.gameSystem(), rider: car.rider() };
    if (car.control === 0) log.held++;
    log.modes.add(car.camera().mode);
    for (const p of car.people) { log.charas.add(p.chara); log.kinds.add(p.kind); }
  };
  for (let i = 0; i < 140; i++) step(HELD);
  for (let i = 0; i < 60; i++) step(GAS);
  const rider = car.rider();
  assert.ok(rider && rider.phase === 2, 'riding');
  const s = stops[rider.stop];
  car.moveTo({ x: s.centre[0], y: s.centre[1], z: s.centre[2], heading: 0 });
  for (let i = 0; i < 150; i++) step(HELD);
  log.first = first; log.stop = s; log.rider = rider;
  return log;
}

for (const [city, name] of [[0, 'arcade'], [1, 'original']]) {
  test(`${name}: a fare by the game's own customer code - the stop, GS_GuestIn's time and fare, the get-in cut holding the cab, the ride, the drop-off's rating and pay, the get-out cut`, { skip: !have }, () => {
    const car = start(make(city));
    const manifest = json('customers/manifest.json');
    const stops = manifest.stop_sets.find((s) => s.game_no === city && s.mini_game_no === 0).stops;
    const log = fare(car, stops);
    const { first } = log;
    // kyakuTaskStart: destination slot (frame / 600) % 3 of the record, k = clamp((route - 2000) / 17000).
    const cpu = car.cpu;
    const slot = first.slot;
    assert.equal(first.stop, (cpu.r8(first.record + 0x18 + slot) << 24) >> 24);
    const route = cpu.rf(first.record + 0x1C + 4 * slot);
    assert.ok(Math.abs(first.k - Math.min(1, Math.max(0, (route - 2000) / 17000))) < 1e-6);
    assert.equal(first.chara, 23 + first.kind);
    // GS_GuestIn within a few frames of stopping beside them.
    assert.ok(log.in, 'the customer got in');
    assert.ok(log.in.frame - car.frames + 350 < 12, `in at ${log.in.frame}`);
    assert.equal(log.in.gs.aboard, 1);
    assert.equal(log.in.gs.fare, Math.trunc(Math.fround(route * Math.fround(2.5))));
    assert.ok(log.in.gs.customerTime >= 300 && log.in.gs.customerTimeTotal === log.in.gs.customerTime);
    assert.equal(log.in.customer.task, first.task);
    assert.equal(log.in.customer.request, 5);
    // The get-in: the cab held (control 0) for the animation, the camera cut (mode 9), the passenger drawn by the Fcv player.
    assert.ok(log.held > 90 && log.held < 300, `held ${log.held} frames`);
    assert.ok(log.modes.has(9) && log.modes.has(10) && log.modes.has(0), [...log.modes].join());
    assert.ok(log.charas.has(first.chara) && log.kinds.has('fcv'), [...log.charas].join());
    assert.ok(log.stop.landmark && log.stop.landmark.name);
    // The drop-off: GS_GuestOut's rating from the time left, the time money = frames x 10, the pay, +300 frames pending for SPEEDY.
    const out = log.out;
    assert.ok(out, 'delivered');
    assert.equal(out.rating, 2);
    assert.equal(out.bonus, 300);
    assert.equal(out.total, out.fare + out.timeMoney + out.tips);
    assert.equal(out.gs.cash, out.total);
    assert.equal(out.gs.delivered, 1);
    assert.equal(out.gs.aboard, 0);
    assert.equal(out.gs.pending, log.in.gs.pending + 300);
    assert.equal(formatMoney(out.gs.cash), `$${Math.floor(out.gs.cash / 100).toLocaleString('en-US')}.${String(out.gs.cash % 100).padStart(2, '0')}`);
    assert.equal(car.gameSystem().fare, 0);
  });
}

test('customers wait within 1100 of the cab in the Arcade city (700 in the Original), each with a destination stop, drawn standing (a V motion) at their spot', { skip: !have }, () => {
  for (const [city, range] of [[0, 1100], [1, 700]]) {
    const car = make(city);
    for (let i = 0; i < 2; i++) car.update(IDLE);
    const tasks = car.customers();
    assert.ok(tasks.length >= 3, `${tasks.length} customers`);
    for (const t of tasks) {
      assert.ok(Math.hypot(t.spot[0] - car.pos.x, t.spot[2] - car.pos.z) < range + 1, `customer ${t.chara} at ${Math.hypot(t.spot[0] - car.pos.x, t.spot[2] - car.pos.z)}`);
      assert.ok(t.stop >= -1 && t.phase === 1 && t.request === 1);   // -1: no stop in this destination slot (the record's byte is -1)
      assert.ok(t.k >= 0 && t.k <= 1);
    }
    const standing = car.people.filter((p) => p.kind === 'v' || p.kind === 'blend');
    for (const p of standing) {
      const t = tasks.find((x) => x.chara === p.chara);
      assert.ok(t, `drawn customer ${p.chara} has a task`);
      assert.ok(Math.hypot(p.matrix[12] - t.pos[0], p.matrix[14] - t.pos[2]) < 1e-3, 'drawn at the passenger\'s position');
    }
  }
});

test('the driver sits in the cab: one Fcv pose per frame whose matrix rides with the car', { skip: !have }, () => {
  const car = start(make(0));
  car.moveTo({ x: START.arcade.x, y: START.arcade.y, z: 1700, heading: Math.PI / 2 });
  for (let i = 0; i < 120; i++) {
    car.update(GAS);
    const drivers = car.people.filter((p) => p.kind === 'fcv');
    assert.equal(drivers.length, 1, `frame ${i}: ${drivers.length} Fcv figures`);
    const d = drivers[0];
    assert.ok(Math.hypot(d.matrix[12] - car.pos.x, d.matrix[14] - car.pos.z) < 20, 'in the cab');
    assert.equal(d.buffer.length, 17);
    for (let k = 5; k < 17; k++) for (const v of d.buffer[k]) assert.ok(Number.isInteger(v), 'angle slots are ints');
  }
});

test('fcvPose: a zero buffer gives the root a quarter turn about y, the head a quarter turn back about z, every bone a proper rotation', () => {
  const fcv = have ? json('fcv_motions/manifest.json') : null;
  const bind = fcv ? fcv.bind_offsets.vectors : Array.from({ length: 13 }, (_, i) => (i % 3 === 0 ? [4.5, 0, 0] : [2.5, 0, 0]));
  const lengths = fcv ? { arm: fcv.solver_lengths.arm, leg: fcv.solver_lengths.leg } : { arm: [2.5, 2.5], leg: [4, 4.2] };
  const buffer = Array.from({ length: 17 }, () => [0, 0, 0]);
  buffer[1] = [3, 15, 1]; buffer[2] = [-3, 15, 1]; buffer[3] = [1, 2, 0]; buffer[4] = [-1, 2, 0];
  const pose = fcvPose(buffer, bind, lengths);
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  for (const r of pose.rotations) assert.ok(Math.abs(det(r) - 1) < 1e-6);
  assert.ok(Math.abs(pose.rotations[0][2] - 1) < 1e-6 && Math.abs(pose.rotations[0][6] + 1) < 1e-6, 'root = Ry(90 degrees)');
  assert.ok(Math.abs(pose.rotations[1][1] - 1) < 1e-6 && Math.abs(pose.rotations[1][3] + 1) < 1e-6, 'head = Rz(-90 degrees)');
  assert.deepEqual(pose.root, [0, 0, 0]);
  assert.equal(vKey(0, 85), 0);
  assert.equal(vKey(84, 85), 0);
  assert.equal(vKey(400, 85), 400 % 84);
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
    assert.ok(checked > 500 && maxOff < 60, `${checked} moving car-frames, at most ${maxOff} off their course point (lane changes)`);
    assert.ok(moved > 500, `${moved} car-frames moved`);
    assert.equal(car.trafficLevel, 3);   // the density level the game starts with (trafficControl(0) after init_GameSystem)
  });
}

// --- the camera ---

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const flat = (v) => Math.hypot(v[0], v[2]);

test('the chase camera (camUpdate mode 0): the eye 60 behind and 15 above the standing cab, the target 17 ahead and 5 up; the view matrix is three.js\'s look-at', { skip: !have }, () => {
  const car = start(make(0));
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

test('the countdown plays the start camera (mode 7, the eye swinging round the cab, the view widening to 70 degrees), then the chase camera follows the moving cab', { skip: !have }, () => {
  const car = make(0);
  const modes = new Set(), fovs = new Set();
  let minDist = Infinity, maxDist = 0;
  for (let i = 0; i < 366; i++) {
    car.update(IDLE);
    const cam = car.camera();
    modes.add(cam.mode); fovs.add(cam.fov);
    if (i > 0 && cam.mode === 7) { const d = flat(sub(cam.eye, [car.pos.x, car.pos.y, car.pos.z])); minDist = Math.min(minDist, d); maxDist = Math.max(maxDist, d); }
  }
  assert.ok(modes.has(7) && modes.has(0), [...modes].join());
  assert.ok(fovs.has(70) && fovs.has(60), [...fovs].join());
  assert.ok(minDist < 40 && maxDist > 25, `start camera distance ${minDist}..${maxDist}`);
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
    if (n === 0) continue;   // the start camera's first frame: eye == target
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

test('a wider picture (car.aspect): the clipping half angle the traffic and the people are culled with widens with it; at 4:3 the game\'s own SetNewClippingAngle runs', { skip: !have }, () => {
  const CLIP_SIN = 0x0C13DBC8, CLIP_TAN = 0x0C13DBCC;
  const run = (aspect) => {
    const car = make(0);
    car.aspect = aspect;
    let drawn = 0, people = 0;
    for (let i = 0; i < 300; i++) {
      car.update(i < 240 ? IDLE : GAS);
      drawn += car.cars.length; people += car.people.length;
    }
    return { sin: car.cpu.rf(CLIP_SIN), tan: car.cpu.rf(CLIP_TAN), drawn, people };
  };
  const dc = run(4 / 3), wide = run(16 / 9);
  // The game's own values for 60 degrees: 1 / nlSin, 1 / nlTan of the half angle (64K units).
  assert.ok(Math.abs(dc.sin - 2) < 1e-3 && Math.abs(dc.tan - Math.sqrt(3)) < 1e-3, `${dc.sin} ${dc.tan}`);
  const half = Math.atan(Math.tan(Math.PI / 6) * (16 / 9) / (4 / 3));
  assert.ok(Math.abs(wide.sin - 1 / Math.sin(half)) < 1e-6 && Math.abs(wide.tan - 1 / Math.tan(half)) < 1e-6, `${wide.sin} ${wide.tan}`);
  assert.ok(wide.drawn > dc.drawn, `${wide.drawn} car-frames at 16:9, ${dc.drawn} at 4:3`);
  assert.ok(wide.people >= dc.people, `${wide.people} people-frames at 16:9, ${dc.people} at 4:3`);
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
  const car = start(make(0));
  for (let i = 0; i < 60; i++) car.update(GAS);
  const target = car.liveCars().filter((c) => (c.flags & MOVING) && !RAIL(c.type) && c.speed > 1).sort((a, b) => a.speed - b.speed)[0];
  assert.ok(target, 'a moving car');
  // 60 units behind it, facing its way.
  car.moveTo({ x: target.x - 60 * Math.sin(target.heading), y: target.y + 1, z: target.z - 60 * Math.cos(target.heading), heading: target.heading });
  let hit = null, peak = 0;
  for (let i = 0; i < 300 && !hit; i++) {
    const v0 = car.speed;
    car.update(GAS);
    peak = Math.max(peak, v0);
    const t = car.liveCars().find((c) => c.id === target.id);
    if (t && car.speed < v0 * 0.8 && t.speed > target.speed * 1.5) hit = { frame: i, before: v0, after: car.speed, carSpeed: t.speed };
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

test('a frame of the game - the cab, the traffic, the customers, the driver - is cheap enough for 60 Hz', { skip: !have }, () => {
  const car = start(make(0));
  for (let i = 0; i < 60; i++) car.update(GAS);
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) car.update({ ...GAS, steer: 0.3 });
  const ms = (performance.now() - t0) / 120;
  assert.ok(ms < 8, `${ms} ms per frame`);
});

test('STEP is the Dreamcast frame', () => {
  assert.equal(STEP, 1 / 60);
});
