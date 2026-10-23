// node --test: the GSystem port (src/game.js) and the customer rules (src/customers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  GameSystem, formatMoney, STATE_COUNTDOWN, STATE_RUNNING, STATE_TIME_UP, START_COUNTDOWN,
  LEVEL_EXTRA, LEVEL_SPEEDY, TIME_UP_HOLD,
} from '../src/game.js';
import {
  Customers, customerK, nearestLineIndex, IDLE, WAITING, BOARDING, RIDING, LEAVING, DONE, BOARD_FRAMES, STOP_YAW,
} from '../src/customers.js';

function running() {
  const gs = new GameSystem();
  while (gs.state === STATE_COUNTDOWN) gs.tick();
  return gs;
}

test('the Arcade run starts with 50 seconds (option byte 4 of 0x0C0896C0) after a 366 frame countdown', () => {
  const gs = new GameSystem();
  assert.equal(gs.time, 3000);
  assert.equal(gs.state, STATE_COUNTDOWN);
  for (let i = 0; i < START_COUNTDOWN - 60; i++) { assert.equal(gs.controlOn, false); gs.tick(); }
  assert.equal(gs.controlOn, true);
  for (let i = 0; i < 60; i++) gs.tick();
  assert.equal(gs.state, STATE_RUNNING);
  assert.equal(gs.time, 3000);
  gs.tick();
  assert.equal(gs.time, 2999);
});

test('fixed-time modes: 3/5/10 minutes', () => {
  assert.equal(new GameSystem({ timeMode: 1 }).time, 10800);
  assert.equal(new GameSystem({ timeMode: 2 }).time, 18000);
  assert.equal(new GameSystem({ timeMode: 3 }).time, 36000);
  assert.equal(new GameSystem({ timeOption: 0 }).time, 4200);
});

test('GS_GuestIn: customer 0 of the Arcade table (route 6576.2583 to stop 0)', () => {
  const gs = running();
  gs.guestIn(6576.2583);
  // int(6576.2583 * 0.11 + 240 + 0) * 1.0 = 963, plus the level-0 extra 1800.
  assert.equal(gs.customerTime, 963 + LEVEL_EXTRA[0]);
  assert.equal(gs.customerTimeTotal, 2763);
  assert.equal(gs.pending, 963);
  assert.equal(gs.fare, 16440);             // int(6576.2583 * 2.5) cents = $164.40
  assert.equal(gs.speedyLimit, LEVEL_SPEEDY[0]);
  assert.equal(gs.fastLimit, 300);
  assert.equal(gs.aboard, true);
  assert.equal(gs.pickedUp, 1);
  // The pending time flows into the clock at 60 frames a frame.
  const t0 = gs.time;
  gs.tick();
  assert.equal(gs.time, t0 - 1 + 60);
  assert.equal(gs.pending, 903);
  assert.equal(gs.customerTime, 2762);
});

test('GS_GuestIn: the customer time never drops under 300 and the level extra is capped by the clock', () => {
  const gs = running();
  gs.time = 500; gs.pending = 0;
  gs.guestIn(0);
  assert.equal(gs.customerTime, 300 + 500);
  assert.equal(gs.levelExtra, 500);
});

test('GS_GuestIn: minute scale and the customer time option', () => {
  const gs = running();
  gs.frames = 3600 * 4;            // the 5th minute: x0.95
  gs.guestIn(10000);
  // Single-precision throughout: (1100 + 240) * 0.95 rounds to 1273.0, not 1272.99998.
  assert.equal(gs.customerTime, 1273 + 1800);
  const hard = new GameSystem({ customerOption: 7 });
  while (hard.state === STATE_COUNTDOWN) hard.tick();
  hard.guestIn(10000);
  assert.equal(hard.customerTime, Math.trunc(10000 * 0.11 + 240 - 360) + 1800);
});

test('GS_GuestOut ratings: speedy >= 1500 left (+300 frames), fast > 300 (+120), else normal; time money = left x 10', () => {
  for (const [left, rating, bonus] of [[1500, 2, 300], [1499, 1, 120], [301, 1, 120], [300, 0, 0], [0, 0, 0]]) {
    const gs = running();
    gs.guestIn(6576.2583);
    gs.pending = 0;
    gs.customerTime = left;
    assert.equal(gs.guestResult(), rating);
    assert.equal(gs.guestOut(), rating);
    assert.equal(gs.pending, bonus, `left ${left}`);
    assert.equal(gs.cash, 16440 + left * 10);
    assert.equal(gs.paid.total, 16440 + left * 10);
    assert.equal(gs.fare, 0);
    assert.equal(gs.timeMoney, 0);
    assert.equal(gs.aboard, false);
    assert.equal(gs.customers, 1);
    assert.equal(gs.chain, 1);
  }
});

test('fixed-time modes give no time for customers or ratings', () => {
  const gs = new GameSystem({ timeMode: 1 });
  while (gs.state === STATE_COUNTDOWN) gs.tick();
  gs.guestIn(9000);
  assert.equal(gs.pending, 0);
  gs.customerTime = 2000;
  gs.guestOut();
  assert.equal(gs.pending, 0);
  assert.equal(gs.paid.bonus, 0);
});

test('the cash is capped at $99,999.99', () => {
  const gs = running();
  gs.cash = 9999000;
  gs.guestIn(39003.527);
  gs.customerTime = 5000;
  gs.guestOut();
  assert.equal(gs.cash, 9999999);
});

test('GS_GuestEject: no pay, the chain and the level step back', () => {
  const gs = running();
  gs.guestIn(6000);
  gs.customerTime = 2000; gs.pending = 0; gs.guestOut();
  gs.guestIn(6000);
  gs.level = 2; gs.levelRaised = 1;
  gs.customerTime = 0;
  gs.guestEject();
  assert.equal(gs.aboard, false);
  assert.equal(gs.chain, 0);
  assert.equal(gs.level, 1);
  assert.equal(gs.fare, 0);
  assert.equal(gs.cash, 15000 + 20000);
});

test('the trip meter raises the level every 1200 units (12,000 driven)', () => {
  const gs = running();
  for (let i = 0; i < 100; i++) { gs.tripMeter(121); gs.tick(); }
  assert.equal(gs.level, 1);
  assert.ok(gs.tripB < 1200);
  gs.guestIn(0);
  assert.equal(gs.levelExtra, LEVEL_EXTRA[1]);
  assert.equal(gs.speedyLimit, LEVEL_SPEEDY[1]);
});

test('time up: state 2, control off, results after 150 frames', () => {
  const gs = running();
  gs.time = 3;
  gs.tick(); gs.tick(); gs.tick();
  assert.equal(gs.time, 0);
  assert.equal(gs.state, STATE_TIME_UP);
  assert.equal(gs.controlOn, false);
  assert.equal(gs.started, 3);
  for (let i = 0; i <= TIME_UP_HOLD; i++) gs.tick();
  assert.ok(gs.timeUpDone);
});

test('"pick someone up" nags after 900 frames without a fare, then every 600', () => {
  const gs = running();
  for (let i = 0; i < 901; i++) gs.tick();
  assert.equal(gs.nags, 1);
  for (let i = 0; i < 601; i++) gs.tick();
  assert.equal(gs.nags, 2);
});

test('formatMoney: cents to "$1,234.56"', () => {
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(16440), '$164.40');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
});

test('customerK: 0 up to a 2000 unit route, 1 from 19000', () => {
  assert.equal(customerK(1000), 0);
  assert.equal(customerK(2000), 0);
  assert.ok(Math.abs(customerK(10500) - 0.5) < 1e-9);
  assert.equal(customerK(30000), 1);
});

// A tiny city: a straight course 0 of 40 points 100 apart along +x, 3 customers, 2 stops.
function fakeWorld() {
  const line = Array.from({ length: 40 }, (_, i) => [i * 100, 0, 0]);
  const set = { customers: [
    { index: 0, kind: 0, character: 23, position: [500, 0, 40], line_index_in_file: 5, destinations: [0, 1, -1], route_lengths_in_file: [3000, 20000, 0] },
    { index: 1, kind: 1, character: 24, position: [2500, 0, 40], line_index_in_file: 25, destinations: [1, 1, 1], route_lengths_in_file: [5000, 5000, 5000] },
    { index: 2, kind: 2, character: 25, position: [3900, 0, 40], line_index_in_file: 39, destinations: [0, 0, 0], route_lengths_in_file: [500, 500, 500] },
  ] };
  const stops = { stops: [
    { index: 0, centre: [3000, 0, 0], radius: 150, landmark: { file: 'LANDDC1.AFS', entry: 0, name: 'A' } },
    { index: 1, centre: [1500, 0, 0], radius: 150, landmark: { file: 'LANDDC1.AFS', entry: 1, name: 'B' } },
  ] };
  return { line, set, stops };
}

const carAt = (x, z = 0, speed = 0) => ({ pos: { x, y: 0, z }, speed, yawRate: 0 });

test('nearestLineIndex: local search with a hint, full search after a jump', () => {
  const { line } = fakeWorld();
  assert.equal(nearestLineIndex(line, { x: 1240, z: 0 }), 12);
  assert.equal(nearestLineIndex(line, { x: 1260, z: 0 }, 12), 13);
  assert.equal(nearestLineIndex(line, { x: 3900, z: 0 }, 12), 39);
});

test('customers appear within 1100 units and at most 7 line points behind the cab', () => {
  const { line, set, stops } = fakeWorld();
  const c = new Customers(set, stops, line, 'arcade');
  const gs = running();
  c.update(carAt(0), gs);
  assert.equal(c.records[0].state, WAITING);     // 500 ahead
  assert.equal(c.records[1].state, IDLE);        // 2500 away
  c.update(carAt(1500), gs);                     // customer 0 is 10 points behind: never again; 1 is 1000 ahead
  assert.equal(c.records[1].state, WAITING);
  // Despawn past 1200, then back to idle so they can reappear.
  c.update(carAt(1800), gs);
  assert.equal(c.records[0].state, IDLE);
  c.update(carAt(1200), gs);                     // 7 points behind, 700 away
  assert.equal(c.records[0].state, WAITING);
});

test('the destination slot comes from the customer frame counter: (frame / 600) % 3', () => {
  const { line, set, stops } = fakeWorld();
  const gs = running();
  let c = new Customers(set, stops, line);
  c.update(carAt(0), gs);
  assert.equal(c.records[0].dest, 0);
  assert.equal(c.records[0].route, 3000);
  assert.ok(Math.abs(c.records[0].k - 1000 / 17000) < 1e-9);
  c = new Customers(set, stops, line);
  c.frame = 600;
  c.update(carAt(0), gs);
  assert.equal(c.records[0].dest, 1);
  assert.equal(c.records[0].route, 20000);
  assert.equal(c.records[0].k, 1);
  c = new Customers(set, stops, line);
  c.frame = 1200;                                // slot 2 is -1: not shown
  c.update(carAt(0), gs);
  assert.equal(c.records[0].state, IDLE);
});

test('pick-up: stopped within 130 - 60k of the spot, then GS_GuestIn after the get-in', () => {
  const { line, set, stops } = fakeWorld();
  const c = new Customers(set, stops, line);
  const gs = running();
  c.update(carAt(0), gs);
  const r = c.records[0];
  const near = 130 - 60 * r.k;
  c.update(carAt(500 - near - 1, 40, 0), gs);    // just outside
  assert.equal(r.state, WAITING);
  c.update(carAt(500 - near + 1, 40, 0.2), gs);  // inside but moving
  assert.equal(r.state, WAITING);
  c.update(carAt(500 - near + 1, 40, 0.1), gs);
  assert.equal(r.state, BOARDING);
  assert.ok(c.holding);
  assert.equal(gs.aboard, false);
  for (let i = 0; i < BOARD_FRAMES; i++) c.update(carAt(500 - near + 1, 40), gs);
  assert.equal(r.state, RIDING);
  assert.equal(gs.aboard, true);
  assert.equal(gs.fare, 7500);
  assert.ok(!c.holding);
  assert.equal(c.events.find((e) => e.type === 'in').stop.landmark.name, 'A');
  // Nobody else appears while someone is aboard.
  c.update(carAt(2500), gs);
  assert.equal(c.records[1].state, IDLE);
});

test('drop-off: inside the stop radius, stopped and not turning; rating paid; the cab is held while they get out', () => {
  const { line, set, stops } = fakeWorld();
  const c = new Customers(set, stops, line);
  const gs = running();
  c.update(carAt(0), gs);
  c.update(carAt(420), gs);
  for (let i = 0; i < BOARD_FRAMES; i++) c.update(carAt(420), gs);
  const r = c.records[0];
  assert.equal(r.state, RIDING);
  const bearing = c.destinationBearing({ x: 420, z: 0 });
  assert.ok(Math.abs(bearing - Math.PI / 2) < 1e-9);   // the stop is along +x
  c.update({ pos: { x: 2900, y: 0, z: 0 }, speed: 0, yawRate: STOP_YAW }, gs);   // turning
  assert.equal(r.state, RIDING);
  c.update(carAt(2900, 0, 0), gs);
  assert.equal(r.state, LEAVING);
  assert.equal(r.rating, 2);
  assert.equal(gs.customers, 1);
  assert.ok(gs.cash > 7500);
  assert.ok(c.holding);
  for (let i = 0; i < BOARD_FRAMES; i++) c.update(carAt(2900), gs);
  assert.equal(r.state, DONE);
  assert.equal(c.rider, null);
  assert.equal(c.destinationBearing({ x: 0, z: 0 }), null);
});

test('out of time: the customer is ejected without pay', () => {
  const { line, set, stops } = fakeWorld();
  const c = new Customers(set, stops, line);
  const gs = running();
  c.update(carAt(0), gs);
  c.update(carAt(420), gs);
  for (let i = 0; i < BOARD_FRAMES; i++) c.update(carAt(420), gs);
  gs.customerTime = 1;
  gs.tick();
  c.update(carAt(1000), gs);
  assert.equal(c.records[0].state, LEAVING);
  assert.equal(gs.aboard, false);
  assert.equal(gs.cash, 0);
  assert.equal(c.events[0].type, 'eject');
});

const MANIFEST = new URL('../local-assets/customers/manifest.json', import.meta.url);
const COURSES = new URL('../local-assets/courses/arcade.json', import.meta.url);
test('the Arcade table: customers near the start spot appear at once; every destination is a stop', { skip: !existsSync(MANIFEST) || !existsSync(COURSES) }, () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const courses = JSON.parse(readFileSync(COURSES, 'utf8'));
  const F = courses.course_fields;
  const line = courses.courses.find((k) => k[F.indexOf('role')] === 'line')[F.indexOf('points')];
  const set = m.customer_sets.find((s) => s.name === 'arcade');
  const stops = m.stop_sets.find((s) => s.game_no === 0 && s.mini_game_no === 0);
  const c = new Customers(set, stops, line, 'arcade');
  const gs = running();
  c.update(carAt(-196.698, 1835), gs);
  const waiting = c.records.filter((r) => r.state === WAITING);
  assert.ok(waiting.length >= 2, `${waiting.length} waiting`);
  assert.ok(waiting.some((r) => r.index === 0));
  for (const r of c.records) for (const d of r.destinations) assert.ok(d === -1 || stops.stops[d], `stop ${d}`);
  assert.equal(stops.stops.length, 33);
});
