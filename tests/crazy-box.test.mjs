// node --test: the Crazy Box in src/dc-car.js - Init_DCmini / execDCmini run the game picked
// by MiniGame_No in the Crazy Box course (game 15 in the Arcade city). Skipped without
// local-assets/disc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastCar, CRAZY_BOX, carFiles, courseModeOf } from '../src/dc-car.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const have = existsSync(new URL('disc/COLDC3.BIN', ROOT));
const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false };

function make(miniGame) {
  const files = carFiles(courseModeOf(CRAZY_BOX, miniGame));
  const data = {};
  for (const k in files) data[k] = readFileSync(new URL(files[k], ROOT));
  return new DreamcastCar(data, { city: CRAZY_BOX, miniGame });
}

test('game 15 is in the Arcade city, the others in the Crazy Box course', () => {
  assert.equal(courseModeOf(CRAZY_BOX, 15), 0);
  for (let g = 0; g < 15; g++) assert.equal(courseModeOf(CRAZY_BOX, g), CRAZY_BOX);
  assert.equal(courseModeOf(0, 15), 0);
  assert.equal(courseModeOf(1, 3), 1);
});

test('Crazy Jump: down the ramp, the jump ends in a fault with the distance', { skip: !have }, () => {
  const car = make(0);
  assert.equal(car.kyaku, false);
  assert.equal(car.crazyBox().flags, 4);
  assert.ok(car.pos.y > 5000, `starts at the top of the ramp (y ${car.pos.y})`);
  let n = 0;
  while (!car.crazyBox().fault && n < 1200) {
    car.update(n > 190 ? { ...IDLE, accel: 1 } : IDLE);
    n++;
  }
  const box = car.crazyBox();
  assert.ok(box.fault, 'faulted');
  assert.ok(box.score > 5000, `score ${box.score}`);
  assert.ok(car.pos.z > 0, `landed past the ramp (z ${car.pos.z})`);
  // Exec_Fault ends the game 180 frames later: it must run through.
  for (let i = 0; i < 200; i++) car.update(IDLE);
});

test('every game starts and runs its countdown', { skip: !have }, () => {
  for (const g of [2, 7, 15]) {
    const car = make(g);
    assert.equal(car.kyaku, g > 3);
    for (let i = 0; i < 400; i++) car.update(i > 190 ? { ...IDLE, accel: 1 } : IDLE);
    assert.equal(car.gameSystem().state, 1, `game ${g} running`);
    assert.ok(Number.isFinite(car.pos.x) && Number.isFinite(car.pos.y), `game ${g} position`);
  }
});
