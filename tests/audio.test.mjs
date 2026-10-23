// node --test: the sound (src/audio.js's pure parts, and what the game's code asks the
// sound driver for through src/dc-car.js's hooks). Skipped without local-assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DreamcastCar, carFiles } from '../src/dc-car.js';
import { requestKey, splitRate, dbGain } from '../src/audio.js';

const ROOT = new URL('../local-assets/', import.meta.url);
const have = existsSync(new URL('disc/COLDC2.BIN', ROOT)) && existsSync(new URL('audio/manifest.json', ROOT));
const json = (path) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));

/** A sink that records every call (the stream status answers: not playing). */
function recorder() {
  const log = [];
  const sink = new Proxy({}, {
    get: (_, name) => (...args) => {
      log.push([name, ...args]);
      if (name === 'songRemain') return 0x58764;
      return 0;
    },
  });
  return { sink, log };
}

function make(city, audio) {
  const files = carFiles(city);
  const data = {};
  for (const k in files) data[k] = readFileSync(new URL(files[k], ROOT));
  return new DreamcastCar(data, { city, audio });
}

const IDLE = { steer: 0, accel: 0, brake: 0, drive: false, reverse: false };

test('Sound_Request words name the manifest\'s requests: 0x000505A9 is request 0xA9050500 (id A905, sequence 5)', () => {
  assert.equal(requestKey(0x000505A9), '0xA9050500');
  assert.equal(requestKey(0x102A9), '0xA9020100');   // sound_uses: word 66217 = request 0xA9020100
  assert.equal(requestKey(0x10A9), '0xA9100000');    // the skid pack's first sequence
  assert.equal(requestKey(0xA9), '0xA9000000');
});

test('the song volume: ADXT_SetOutVol takes tenths of a decibel, -999 is silence', () => {
  assert.equal(dbGain(0), 1);
  assert.equal(dbGain(-999), 0);
  assert.ok(Math.abs(dbGain(-200) - 0.1) < 1e-9);
});

test('every request of every pack resolves to its playback definitions and WAVs; a split\'s pitch curve gives the manifest\'s rates at both ends', { skip: !have }, () => {
  const manifest = json('audio/manifest.json');
  let requests = 0, splits = 0;
  for (const pack of manifest.files) {
    for (const group of pack.requests || []) {
      for (const seq of group.sequences) {
        requests++;
        for (const e of seq.events || []) {
          if (e.kind !== 'note_on' && e.kind !== 'note_off') continue;
          const playback = pack.playbacks[e.playback];
          assert.ok(playback, `${seq.request}: playback ${e.playback}`);
          const sample = pack.sounds[playback.sample];
          assert.ok(sample && sample.wav && existsSync(new URL(`audio/${sample.wav}`, ROOT)), `${seq.request}: sample ${playback.sample}`);
          assert.ok(playback.rate > 1000);
        }
      }
    }
    for (const program of pack.instruments || []) {
      for (const split of program.splits) {
        splits++;
        // The manifest's rates go through the driver's 768-entry FNS table (rounded); the curve is continuous.
        for (const end of [split.at_low_key, split.at_high_key]) {
          const rate = splitRate(split, end.key);
          assert.ok(Math.abs(rate / end.rate - 1) < 1e-3, `${pack.source} program ${program.id} split ${split.id} key ${end.key}: ${rate} vs ${end.rate}`);
        }
        assert.ok(pack.sounds[split.sample].loop, 'an instrument sample loops');
      }
    }
  }
  assert.equal(requests, 102);
  assert.ok(splits >= 8);
});

test('the cab\'s sound: init_CarSound assigns the engine (bank 4 = SNDDC3, program 0) to slot 0 and the tyres (bank 1) to slots 1 and 2 with their volumes; exec_CarSound keys the engine from the rpm once the cab runs', { skip: !have }, () => {
  const { sink, log } = recorder();
  const car = make(0, sink);
  const programs = log.filter((l) => l[0] === 'icsControl' && l[2] === 0xA5).map((l) => [l[1], l[3]]);
  assert.deepEqual(programs, [[0, 0x400], [1, 0x100], [2, 0x101]]);
  const volumes = log.filter((l) => l[0] === 'icsControl' && l[2] === 0x10A5).map((l) => [l[1], l[3]]);
  assert.deepEqual(volumes.map((v) => v[0]), [0, 1, 2]);
  assert.ok(volumes.every((v) => v[1] > 0 && v[1] <= 127));
  assert.ok(log.some((l) => l[0] === 'reset'));
  log.length = 0;
  let n = 0;
  while (car.gameSystem().state === 0 && n++ < 400) car.update(IDLE);
  for (let i = 0; i < 120; i++) car.update({ ...IDLE, accel: 1 });
  const keys = log.filter((l) => l[0] === 'icsControl' && l[1] === 0 && l[2] === 0xA6).map((l) => l[3]);
  assert.ok(keys.length > 50, `${keys.length} engine keys`);
  // exec_CarSound: |rpm| * 0.004 below 4500, (|rpm| - 4500) * 0.0225 + 18 above, 2..98, plus a
  // sine of the frame counter (0x0C1EC050, counted up every frame as the main loop does).
  const rpm = Math.abs(car.rpm);
  const rpmKey = Math.min(98, Math.max(2, Math.trunc(rpm < 4500 ? rpm * 0.004 : (rpm - 4500) * 0.0225 + 18)));
  assert.ok(Math.abs(keys[keys.length - 1] - rpmKey) <= 1, `engine key ${keys[keys.length - 1]} for ${car.rpm} rpm`);
  assert.ok(keys[keys.length - 1] > keys[0], 'the engine rose with the throttle');
});

test('the music: gdc_PlayStreamSongDisk starts the first song of the jukebox (file 7 of SONG01.AFS) at the countdown\'s 60 at the settings\' volume, and gdc_ExecStreamSongDisk fades it over its last 120 frames and plays the next (5)', { skip: !have }, () => {
  const { sink, log } = recorder();
  let remain = 0x58764;
  const audio = new Proxy({}, { get: (_, name) => (...args) => {
    log.push([name, ...args]);
    if (name === 'songStart') remain = 0x58764;   // a fresh stream
    return name === 'songRemain' ? remain : 0;
  } });
  const car = make(0, audio);
  log.length = 0;
  while (car.gameSystem().counter !== 60) car.update(IDLE);
  assert.ok(car.musicCue);
  const songs = log.filter((l) => l[0] === 'songStart');
  assert.deepEqual(songs, [['songStart', 7]]);
  assert.deepEqual(log.filter((l) => l[0] === 'songVolume').map((l) => l[1]), [-44]);   // 200 * log10(76 / 127)
  log.length = 0;
  for (let i = 0; i < 10; i++) car.update(IDLE);
  assert.equal(log.filter((l) => l[0] === 'songStart').length, 0);
  remain = 100;   // the stream nears its end
  car.update(IDLE);
  for (let i = 0; i < 125; i++) { remain = Math.max(0, remain - 1); car.update(IDLE); }
  const fades = log.filter((l) => l[0] === 'songVolume').map((l) => l[1]);
  assert.ok(fades.length > 50, `${fades.length} volume steps`);
  assert.ok(fades[0] === -44 && fades[fades.length - 2] <= -100 && fades[fades.length - 1] === -44, `fade ${fades.slice(0, 3)} ... ${fades.slice(-3)}`);
  assert.deepEqual(log.filter((l) => l[0] === 'songStart'), [['songStart', 5]]);
});

test('the voices: Voice_Request queues a script and Voice_Execute streams its clips (adxStartAfs2 with the file, the channel\'s volume), stepping on when the stream has ended', { skip: !have }, () => {
  const { sink, log } = recorder();
  const car = make(0, sink);
  let n = 0;
  while (car.gameSystem().state === 0 && n++ < 400) car.update(IDLE);
  log.length = 0;
  let requested = 0;
  for (let i = 0; i < 600 && !log.some((l) => l[0] === 'voiceStart'); i++) {
    car.update({ ...IDLE, accel: 1 });
    requested += car.voices.length;
  }
  const starts = log.filter((l) => l[0] === 'voiceStart');
  assert.ok(requested > 0 && starts.length > 0, `${requested} requests, ${starts.length} streams`);
  const [, ch, file] = starts[0];
  assert.ok(ch >= 0 && ch < 4 && file >= 0 && file < 699, `channel ${ch} file ${file}`);
  const vol = log.find((l) => l[0] === 'voiceVolume' && l[1] === ch);
  assert.ok(vol && vol[2] > 0 && vol[2] <= 127);
});
