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

Keys: arrows / WASD drive and steer, X = Drive gear (B), Z = Reverse gear (A),
C camera, R restart. Stop inside a customer's circle to pick them up, stop at
the landmark (the arrow and picture show where) to drop them off.

## What is in the game so far

* `src/collision.js` - the game's ground and wall lookups (`GetCollision2D`,
  `CheckColliWall`) ported from the decomp over `local-assets/collision/*.json`.
  Checked against the extracted courses: all 25,712 Arcade stage course points
  land on `#road` within 2 units.
* `src/start.js` - the start spots and headings `init_CarMain` uses (Arcade:
  course 0's last point moved 135 along z, heading 0x5000; Original fixed values).
* `src/dc-car.js` + `src/sh4.js` - the cab and the traffic are driven by the
  game's own code: `init_CarMain` / `exec_CarMain` (carGearbox, carWheelForces,
  carAngularMotion, carWheelCollision, carGroundCheck...), `entryCarPut`,
  `trafficControl` (where cars appear and vanish: a circle of 1100 units around a
  point 500 ahead of the cab, sections of 15 course points, the density level),
  `nlExecuteEvent` (every traffic car, train, cable car and signal is an event:
  pcarDrive, carSteering, carResistance, carBalance, the course occupancy grid)
  and `ExecColliObj` (the collision boxes: the cab hits the traffic and the
  traffic hits back) from `1ST_READ.BIN` run in a small SH-4 interpreter over the
  disc's course points (`SPLDCn.BIN`) and collision (`COLDCn.BIN`) at their
  Dreamcast addresses, with the drawing, sound, rumble and effects calls
  stubbed. Every frame - the cab and every traffic car - matches the decomp's
  SH-4 simulator bit for bit (`tests/fixtures/car-trace-*.json`, recorded by
  `tools/car_trace.py`; the simulator's 64-bit `fmov` pairs are corrected there:
  the SH-4 keeps `FR[2k]` at the lower address, which is how `nlPushMatrix`'s two
  load paths agree and how `MultiRot4Vec` builds a rotation). The file documents
  the Car_Data fields the game uses (position +0x78, angles +0x84, speed +0x15C
  in units per frame, gear +0x120, the four wheel records at +0x1A0 - all four
  wheels steer, the collision object at +0x00 whose rotation `putPlayerCar`'s
  `GetRotVec` stores), the traffic car record (+0x78 type, +0x7C colour, +0x84
  flags, +0x8C position, +0xA4 angles, +0xC8 brake, +0xCC speed, +0xD4 course
  point) and the pad mapping (TaxiSW: stick, triggers, B = Drive, A = Reverse).
* `src/traffic-view.js` - the traffic drawn as `putCarModel` draws it: the
  extracted vehicle models (`local-assets/vehicles/traffic`, near/far detail by
  the game's 400 unit rule, the camera's clipping cone and 1800 unit draw
  distance applied by `entryCarPut` itself from the three.js camera), the body
  tinted with the car's colour (KHR_materials_variants paints), lifted and tilted
  by its suspension, wheels spun by 0.2 x the speed, brake lamps.
* `src/game.js` - the run's numbers, ported from the USA executable's GSystem
  code: 50 s start (option table 0x0C0896C0), a customer's time
  `int(route x 0.11 + 240 + option) x minuteScale + levelExtra`, the fare
  `route x 2.5` cents, ratings (SPEEDY from 1500 frames left: +5 s and the
  time money = frames left x 10 cents; FAST over 300: +2 s), the level that
  rises every 1200 trip-meter units, "pick someone up" nags, time up.
* `src/customers.js` - who stands where (`local-assets/customers`): a customer
  appears within 1100 units (Original 700) when at most 7 course-0 points behind
  the cab, with destination `(frame / 600) % 3` of their three; picked up when
  the cab stops within `130 - 60k` of the spot (`k` = route length 2000..19000
  mapped to 0..1, also the circle's size 100 - 60k); delivered inside the stop's
  radius, stopped, not turning; ejected when their time runs out.
* `src/customer-view.js` - the extracted characters on the street (idle poses
  and "hey taxi" waves from `motions.glb`, facing the cab) with the coloured
  pick-up circle.
* `src/hud.js` - clock, cash, customer time bar (green/yellow/red at the rating
  limits), destination picture + name (`local-assets/landmarks`), arrow, fare card,
  countdown and TIME UP.
* `src/main.js`, `src/scene.js` - the city (`BINCn.glb`), its set objects
  (`OBJDCn.glb`) and `cab_0.glb` drawn unlit (texture x vertex colour, as the
  Dreamcast does), a chase camera.
* `tools/browser-check.mjs` - headless Chrome smoke run (drives, then runs one
  fare by teleporting to a customer and their stop; screenshots).

Not yet: pedestrians, the passenger in the cab and the get-in/get-out cut, the
game's camera, the trick bonuses' display (Crazy Through etc. are counted:
`car.tricks`), traffic horns and turn signals, HUD sprites, sound, Crazy Box.

Asset extraction is documented in [docs/asset-extraction.md](docs/asset-extraction.md).
