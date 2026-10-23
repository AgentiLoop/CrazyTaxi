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
C camera, R reset to the start.

## What is in the game so far

* `src/collision.js` - the game's ground and wall lookups (`GetCollision2D`,
  `CheckColliWall`) ported from the decomp over `local-assets/collision/*.json`.
  Checked against the extracted courses: all 25,712 Arcade stage course points
  land on `#road` within 2 units.
* `src/start.js` - the start spots and headings `init_CarMain` uses (Arcade:
  course 0's last point moved 135 along z, heading 0x5000; Original fixed values).
* `src/car.js` - the cab: four wheel ground contacts, wall push at both axles,
  gearbox (A reverse / B drive), the out-of-world recovery onto the nearest
  stage point. Speeds, accelerations and grip are placeholders until
  `exec_CarMain` / `carCalcInertia` are ported.
* `src/main.js`, `src/scene.js` - the city (`BINCn.glb`), its set objects
  (`OBJDCn.glb`) and `cab_0.glb` drawn unlit (texture x vertex colour, as the
  Dreamcast does), a chase camera, HUD.
* `tools/browser-check.mjs` - headless Chrome smoke run (drives, screenshots).

Asset extraction is documented in [docs/asset-extraction.md](docs/asset-extraction.md).
