# CrazyTaxi

A three.js reconstruction of the Sega Dreamcast *Crazy Taxi* (USA, MK-51035),
built from data extracted from the user's own disc. No game assets are in this
repository.

## Run

```sh
python3 tools/extract_all.py '<Crazy Taxi (USA).7z or .chd>' --output local-assets   # once, ~2 min
npm install
npm run dev        # http://127.0.0.1:5173/  (add ?city=original for the Original city)
npm test           # node --test tests/*.test.mjs (skips data tests without local-assets/)
```

### The Mac app

`mac/` is a macOS app (Swift, one `WKWebView`) that plays the built game without a
browser or a dev server: it serves `dist/` and `local-assets/` from disk over its own
URL scheme.

```sh
npm run build && mac/build.sh     # -> mac/build/CrazyTaxi.app (finds the repo folder by itself; --root PATH to point elsewhere)
tools/mac-probe.sh 30             # unattended 60 fps check in the app: one JSON line a second, then a summary
```

The world (city and set objects) is merged into a few draw calls at load
(`src/static-batch.js`: one texture atlas, one mesh per cell and way of drawing) -
~300 draw calls a frame instead of ~3,000, 60 fps in the app on an M4 at 2560 x 1920
where it was 40-47. `?batch=0` draws the single meshes again. The hi-res pack (`?hires=1`,
or H in game) draws the same batches from atlases four times the size with the pack's
pictures in the tiles (a 64 x 64 game texture is the pack at 256; 8192 x 8192, mipmapped).

Keys: arrows / WASD drive and steer, X = Drive gear (B), Z = Reverse gear (A),
R restart. Xbox controller (any standard-layout pad): left stick / D-pad steer, A (or RT)
gas, B (or LT) brake, RB or right stick forward Drive gear, LB or right stick back Reverse gear, Menu (≡) pause,
View restart, Y hi-res pack; in the menus D-pad / left stick, A choose, B back, Menu = Start.
Stop beside a customer (inside their circle) to pick them up, stop at
the landmark (the arrow and picture show where) to drop them off.

## What is in the game so far

* `src/collision.js` - the game's ground and wall lookups (`GetCollision2D`,
  `CheckColliWall`) ported from the decomp over `local-assets/collision/*.json`.
  Checked against the extracted courses: all 25,712 Arcade stage course points
  land on `#road` within 2 units.
* `src/start.js` - the start spots and headings `init_CarMain` uses (Arcade:
  course 0's last point moved 135 along z, heading 0x5000; Original fixed values).
* `src/dc-car.js` + `src/sh4.js` - the game runs by its own code. `init_CarMain` /
  `exec_CarMain` (carGearbox, carWheelForces, carAngularMotion, carWheelCollision,
  carGroundCheck...), `entryCarPut`, `trafficControl` (where cars appear and
  vanish: a circle of 1100 units around a point 500 ahead of the cab, sections of
  15 course points, the density level), `nlExecuteEvent` (every traffic car,
  train, cable car, signal and customer task is an event: pcarDrive, carSteering,
  carResistance, carBalance, the course occupancy grid, kyakuTaskExec),
  `ExecColliObj` (the collision boxes: the cab hits the traffic and the traffic
  hits back), `initCamera` / `camUpdate` (the chase camera: the eye eased by
  homing vectors to 60 behind and 15 above the cab plus a smoothed speed term,
  the target 17 ahead and 5 up, the eye pulled in front of walls by
  `GetCollision`, the view matrix and the 60 degree perspective; the get-in and
  get-out cuts, modes 9 and 10), `SetStartCamera` / `ExecStartCamera` (the
  countdown's swoop around the cab, widening to 70 degrees), `init_GameSystem` /
  `exec_GameSystem` (the 366 frame countdown that releases the cab when 60
  remain, the 50 s clock from the settings' defaults, the customer's time, time
  up), `init_KyakuMain` / `exec_KyakuMain` and the customer tasks (who waits
  where, the stop beside them, GS_GuestIn's time and fare, Psg_Execute's
  state machine: the get-in that holds the cab, the ride, the drop-off's rating
  and time money, the get-out), `Act_Init` / `Act_Execute` (the driver) from
  `1ST_READ.BIN` run in a small SH-4 interpreter over the disc's course points
  (`SPLDCn.BIN`), collision (`COLDCn.BIN`), motions (`MOTDC.BIN`) and people
  models (`POLDC0.BIN`) at their Dreamcast addresses, with the drawing, sound,
  rumble, effects and HUD calls stubbed or captured. Every frame of a recorded
  fare - the countdown, the cab moved beside a customer, the get-in, 60 frames of
  driving, the drop-off at the stop: the cab, the camera, every traffic car,
  GSystem, every customer task and every figure drawn - matches the decomp's
  SH-4 simulator bit for bit in both cities (`tests/fixtures/car-trace-*.json`,
  recorded by `tools/car_trace.py`; the simulator's 64-bit `fmov` pairs are
  corrected there: the SH-4 keeps `FR[2k]` at the lower address, which is how
  `nlPushMatrix`'s two load paths agree and how `MultiRot4Vec` builds a
  rotation). The file documents the Car_Data fields the game uses (position
  +0x78, angles +0x84, speed +0x15C in units per frame, gear +0x120, control
  +0x54, the four wheel records at +0x1A0 - all four wheels steer, the collision
  object at +0x00 whose rotation `putPlayerCar`'s `GetRotVec` stores), GSystem
  (0x0C1EC4A8: time, cash, fare, the customer's time and limits), a customer task
  (the record, the passenger struct, the phase, the destination's stop entry),
  the traffic car record (+0x78 type, +0x7C colour, +0x84 flags, +0x8C position,
  +0xA4 angles, +0xC8 brake, +0xCC speed, +0xD4 course point) and the pad mapping
  (TaxiSW: stick, triggers, B = Drive, A = Reverse). The HUD's fare roll, which
  pays the cash in the game, does not run: the cash is paid the frame the
  customer is delivered.
* `src/traffic-view.js` - the traffic drawn as `putCarModel` draws it: the
  extracted vehicle models (`local-assets/vehicles/traffic`, near/far detail by
  the game's 400 unit rule, the camera's clipping cone and 1800 unit draw
  distance applied by `entryCarPut` itself from the game's own view matrix), the body
  tinted with the car's colour (KHR_materials_variants paints), lifted and tilted
  by its suspension, wheels spun by 0.2 x the speed, brake lamps.
* `src/people.js` - the people drawn as the game draws them: the interpreter
  captures `humanDraw` / `VSklIpPlay` (the V motions of the customers at the
  kerb, played from `motions.glb` at the game's frame) and `FcvPlayBuffer` (the
  key-curve poses of the driver, the get-in and get-out and the passenger in
  the cab, rebuilt from the game's 17-vector pose buffer with the same root,
  torso, head and two-bone solver math as `tools/extract_fcv_motions.py`) with
  each figure's world matrix, and poses the extracted characters
  (`local-assets/characters/char_NN.glb`) from them; the pick-up circle
  (100 - 60k) and the destination's drop circle.
* `src/hud.js` - clock, cash, customer time bar (green/yellow/red at the rating
  limits), destination picture + name (`local-assets/landmarks`), arrow, fare card,
  countdown and TIME UP, all read from the game's GSystem and customer tasks.
* `src/main.js`, `src/scene.js` - the city (`BINCn.glb`), its set objects
  (`OBJDCn.glb`) and `cab_0.glb` drawn unlit (texture x vertex colour, as the
  Dreamcast does) through the game's camera: its view matrix on the three.js
  camera, its horizontal field of view across a 4:3 picture whose vertical view
  is kept while the width fills the window (near 3, far 15000, the decomp's
  reading of the projection); the game's own culling of the traffic and the
  people (`SetNewClippingAngle`) is widened with the window, so nothing pops in
  at the sides; the HUD scales with the height and sits in the corners.
* `src/audio.js` - the sound, from what the game's code asks its sound driver
  for (the interpreter hooks the calls), over the WAVs `tools/extract_audio.py`
  wrote (`local-assets/audio`) with Web Audio: the effects (`Sound_Request`'s
  words name the DTPK requests of the loaded packs - horns, bells, the skids,
  the fare's jingles; note-on velocity, playback rate, looping samples held until
  their note-off), the cab's engine and tyres (`init_CarSound` / `exec_CarSound`
  run and drive `nlsndIcsControl`: the engine program of `SNDDC3.BIN` keyed from
  the rpm, its splits looped at the pitch curve's rate, the tyre programs of
  `SNDDC1.BIN`), the voices (`Voice_Request` queues a script, `Voice_Execute`
  streams its clips of `VOICE01.AFS` on four channels through the ADX stream
  calls) and the music (`gdc_PlayStreamSongDisk` at the countdown's 60, the
  jukebox of four songs of `SONG01.AFS`, `gdc_ExecStreamSongDisk`'s fade over
  the last 120 frames, `ADXT_SetOutVol`'s decibels). Browsers start audio on the
  first key or click; a song cued before that starts where it would be.
* `tools/browser-check.mjs` - headless Chrome smoke run (drives, then runs one
  fare by moving the cab beside a customer and on to their stop; screenshots).

Not yet: the sound's finer points (velocity and key volume curves, pans, the
AICA envelopes), pedestrians, the trick
bonuses' display (Crazy Through etc. are counted: `car.tricks`), turn signals,
HUD sprites, Crazy Box.

Asset extraction is documented in [docs/asset-extraction.md](docs/asset-extraction.md).
