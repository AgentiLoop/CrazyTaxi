// node --test: the Crazy Box in src/dc-car.js - Init_DCmini / execDCmini run the game picked
// by MiniGame_No in the Crazy Box course (game 15 in the Arcade city). Skipped without
// local-assets/disc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastCar, CRAZY_BOX, carFiles, courseModeOf } from '../src/dc-car.js';
import { modelFile } from '../src/box-objects.js';
import { DreamcastMenu, PAD, SAVE_SIZE } from '../src/dc-menu.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const have = existsSync(new URL('disc/COLDC3.BIN', ROOT));
const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false };

function make(miniGame, save = null) {
  const files = carFiles(courseModeOf(CRAZY_BOX, miniGame));
  const data = {};
  for (const k in files) data[k] = readFileSync(new URL(files[k], ROOT));
  return new DreamcastCar(data, { city: CRAZY_BOX, miniGame, save });
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

test('the game ends: callTryAgain 180 frames after the fault sets over (once); init starts over', { skip: !have }, () => {
  const car = make(0);
  let n = 0, faultAt = -1;
  while (!car.crazyBox().over && n < 1500) {
    car.update(n > 190 ? { ...IDLE, accel: 1 } : IDLE);
    if (faultAt < 0 && car.crazyBox().fault) faultAt = n;
    n++;
  }
  assert.ok(car.crazyBox().over, 'over');
  assert.ok(n - faultAt >= 170 && n - faultAt <= 190, `ended ${n - faultAt} frames after the fault`);
  for (let i = 0; i < 30; i++) car.update(IDLE);
  car.init();
  assert.equal(car.crazyBox().over, false);
  assert.equal(car.crazyBox().fault, false);
});

test('the overlay is the game\'s sprites: READY / GO, the jump distance, FAULT', { skip: !have }, () => {
  const car = make(0);
  const seen = (n) => car.sprites.some((s) => s.texture === n);
  car.update(IDLE);
  assert.ok(seen(117), 'READY (Put_ReadySetGo, SPRCOMM 117)');
  assert.ok(seen(537) && seen(551), 'Put_JumpDistance (SPRBOX 537, 551)');
  const ready = car.sprites.find((s) => s.texture === 117);
  assert.deepEqual(ready.colour.map((c) => +c.toFixed(2)), [1, 0.64, 0.16], 'tinted by the fade colour');
  assert.ok(car.voices.length > 0, 'the READY voice');
  let go = false, n = 1;
  while (!car.crazyBox().fault && n < 1200) {
    car.update(n > 190 ? { ...IDLE, accel: 1 } : IDLE);
    go ||= seen(99);
    n++;
  }
  assert.ok(go, 'GO (SPRCOMM 99)');
  car.update(IDLE);
  assert.ok(seen(115), 'FAULT (Start_Fault, SPRCOMM 115)');
  for (const s of car.sprites) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0 && s.x <= 640 && s.y >= 0 && s.y <= 480, `on screen: ${s.texture} ${s.x},${s.y}`);
});

test('each game draws its own BINC3 entries (gdc_CourseStartLoadReq); 7 and 11 share a course', { skip: !have }, () => {
  const all = new Set();
  const of = {};
  for (let g = 0; g < 15; g++) {
    of[g] = make(g).courseEntries();
    assert.ok(of[g].length > 0 && of[g].every((n) => n >= 0 && n < 130), `game ${g}`);
    for (const n of of[g]) all.add(n);
  }
  assert.deepEqual(of[2], [81, 82, 83, 84, 85], 'Crazy Balloons: the 2 km field round the origin');
  assert.deepEqual(of[7], of[11]);
  assert.equal(all.size, 130, 'every entry belongs to a game');
});

test('the model files: POLDC0 at 0x0C390000, the city\'s POLDC at 0x0C5E0000', () => {
  assert.equal(modelFile(0x0C46F828, 2), 'models/POLDC0/0df828.glb');
  assert.equal(modelFile(0x0C5E1998, 2), 'models/POLDC3/001998.glb');
});

test('Crazy Balloons: the 20 balloons are drawn; driving into one pops it and counts down', { skip: !have }, () => {
  const BALLOON = 0x0C46F828, HIT = 0x0C5E1998;
  const car = make(2);
  car.update(IDLE);
  const balloons = car.objects.filter((o) => o.model === BALLOON);
  assert.equal(balloons.length, 20);
  assert.equal(new Set(balloons.map((o) => o.colour.join())).size, 10, 'ten colours');
  for (const o of balloons) {
    assert.ok(Math.abs(o.alpha - 0.8) < 1e-6, 'see-through 0.8');
    assert.ok(Math.abs(o.matrix[0] - 2.4) < 1e-4 && o.matrix[13] > 5 && o.matrix[13] < 20, 'scale 2.4, bouncing on the ground (radius 12)');
  }
  // The count (tens, ones: SPRCOMM digits 80-89 at 474 / 498, 90) starts at 20.
  const count = () => {
    const d = car.sprites.filter((s) => s.texture >= 80 && s.texture <= 89 && Math.abs(s.y - 90) < 1 && s.x < 510);
    return d.reduce((v, s) => v * 10 + s.texture - 80, 0);
  };
  assert.equal(count(), 20);
  let hit = false, n = 1;
  while (!hit && n < 1800) {
    let input = IDLE;
    if (n > 190) {
      let best = null, bd = Infinity;
      for (const o of car.objects) {
        if (o.model !== BALLOON) continue;
        const d = Math.hypot(o.matrix[12] - car.pos.x, o.matrix[14] - car.pos.z);
        if (d < bd) { bd = d; best = o; }
      }
      const e = Math.atan2(best.matrix[12] - car.pos.x, best.matrix[14] - car.pos.z) - car.heading;
      input = { ...IDLE, accel: 0.7, steer: Math.max(-1, Math.min(1, -Math.atan2(Math.sin(e), Math.cos(e)) * 3)) };
    }
    car.update(input);
    hit = car.objects.some((o) => o.model === HIT);
    n++;
  }
  assert.ok(hit, 'a balloon was hit (drawn 4.8 times, POLDC3 0x1998)');
  car.update(IDLE);
  assert.equal(count(), 19);
});

test('a clear is filed in the records (CheckRanking); the save opens 1-4 in the menu once 1-1 to 1-3 are cleared', { skip: !have }, () => {
  const START_EXCELLENT = 0x0C05ABE8;   // what each game calls when it is cleared
  let save = null;
  for (const g of [0, 1, 2]) {
    const car = make(g, save);
    let n = 0;
    for (; n < 1500 && !car.crazyBox().over; n++) {
      if (n === 300) car.call(START_EXCELLENT);
      car.update(n > 190 ? { ...IDLE, accel: 0.3 } : IDLE);
    }
    const box = car.crazyBox();
    assert.ok(box.over && box.excellent && !box.fault, `game ${g}: ${JSON.stringify(box)}`);
    assert.equal(car.choice, 'menu', 'after a clear the game goes back to the box screen (gameState2)');
    assert.ok(n > 300 + 200 && n < 300 + 230, `End_Excellent ends it after the record window's 210 frames (${n})`);
    save = car.save();
    assert.equal(save.length, SAVE_SIZE);
    assert.equal(save[0x14], (2 << g) - 1, `player 1's boxes cleared (+0x14) after game ${g}`);
  }
  const box4 = (s) => {
    const menu = new DreamcastMenu(new Uint8Array(readFileSync(new URL('disc/1ST_READ.BIN', ROOT))), { save: s });
    const press = (b, settle = 60) => { menu.update(b); for (let i = 0; i < settle && menu.update(0); i++); };
    for (let i = 0; i < 90; i++) menu.update(0);
    press(PAD.DOWN); press(PAD.DOWN); press(PAD.A, 100);   // CRAZY BOX
    for (let i = 0; i < 5; i++) press(PAD.DOWN);           // CABBIE, 1-1, 1-2, 1-3, 1-4
    press(PAD.A, 200);
    return menu.result;
  };
  assert.equal(box4(save)?.game, 3, 'with the save: box 1-4 (Crazy Bowling)');
  assert.notEqual(box4(null)?.game, 3, 'without it 1-4 stays locked');
});


test('the TRY AGAIN window is the game\'s: its text, the cursor, YES plays again, NO and B go back to the menu', { skip: !have }, () => {
  const ended = () => {
    const car = make(0);
    for (let n = 0; n < 1500 && !car.crazyBox().over; n++) car.update(n > 190 ? { ...IDLE, accel: 1 } : IDLE);
    assert.ok(car.crazyBox().over && car.crazyBox().fault);
    return car;
  };
  const text = (car) => {
    const rows = new Map();
    for (const s of car.sprites) if (s.kind === 'glyph') rows.set(s.y, (rows.get(s.y) || '') + s.char);
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map((r) => r[1]);
  };
  const lit = (car, ch) => car.sprites.find((s) => s.kind === 'glyph' && s.char === ch).colour[2] < 0.5;   // the cursor's item: orange
  const wait = (car) => { let k = 0; for (; k < 200 && !car.choice; k++) car.windowFrame(0); return k; };

  // YES (the cursor starts on it): A, then the window's 90-frame step -> windowRetry.
  let car = ended();
  car.windowFrame(0);
  assert.deepEqual(text(car), ['tryagain?', 'yes', 'no'], 'pfPutc\'s text (the font draws it in capitals)');
  assert.ok(car.sprites.every((s) => s.x >= 0 && s.x < 640 && s.y >= 0 && s.y < 480));
  assert.ok(lit(car, 'y') && !lit(car, 'o'), 'the cursor on YES');
  car.windowFrame(PAD.A);
  assert.equal(car.choice, null, 'not at once');
  const k = wait(car);
  assert.equal(car.choice, 'retry');
  assert.ok(k > 80 && k < 100, `windowEnterStep(90) (${k})`);
  car.init();
  assert.equal(car.choice, null);
  assert.equal(car.crazyBox().over, false);

  // NO: down, A -> windowGoMenu.
  car = ended();
  car.windowFrame(0);   // the window opens (windowOpenStep)
  car.windowFrame(PAD.DOWN);
  assert.ok(lit(car, 'o') && !lit(car, 'y'), 'the cursor on NO');
  assert.ok(car.sounds.length > 0, 'the cursor\'s sound');
  car.windowFrame(0);
  car.windowFrame(PAD.A);
  wait(car);
  assert.equal(car.choice, 'menu');

  // B on YES -> NO's way.
  car = ended();
  car.windowFrame(0);
  car.windowFrame(PAD.B);
  wait(car);
  assert.equal(car.choice, 'menu');
});
