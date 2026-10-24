// Crazy Taxi in three.js: the Arcade city, its set objects, the cab, the traffic,
// the camera, the customers and the run's clock and cash all driven by the game's
// own code (exec_CarMain, trafficControl, the traffic events, camUpdate,
// exec_GameSystem, exec_KyakuMain and the passenger tasks running in an SH-4
// interpreter, src/dc-car.js) over the game's collision.
// Assets come from local-assets/ (written by tools/extract_all.py; never bundled).
import * as THREE from 'three';
import { KIND_NAMES } from './collision.js';
import { DreamcastCar, STEP, WHEEL_RADIUS, CRAZY_BOX, carFiles, courseModeOf } from './dc-car.js';
import { Input } from './input.js';
import { CITIES } from './start.js';
import { loadGltf, makeUnlit, GameCamera, packView } from './scene.js';
import { PeopleView } from './people.js';
import { Hud, HUD_CSS } from './hud.js';
import { CartoonDigits } from './cartoon-digits.js';
import { TrafficView } from './traffic-view.js';
import { CabShadow } from './cab-shadow.js';
import { NavArrow } from './nav-arrow.js';
import { GameAudio } from './audio.js';
import { MenuView } from './menu-view.js';
import { loadSave, storeSave, PAD } from './dc-menu.js';
import { BoxObjects } from './box-objects.js';

// The asset folder: local-assets/, or the asset release's (VITE_ASSETS=... at build or dev time).
const ASSETS = (import.meta.env && import.meta.env.VITE_ASSETS) || 'local-assets/';
const params = new URLSearchParams(location.search);
// ?city=crazybox&game=N: the Crazy Box's game N (MiniGame_No 0-15, the menu's box - 2); its
// course is the Crazy Box's (BINC3, OBJDC3), but game 15 is driven in the Arcade city.
const CRAZY = params.get('city') === 'crazybox';
const MINI_GAME = CRAZY ? Math.min(15, Math.max(0, parseInt(params.get('game'), 10) || 0)) : 0;
const cityName = CRAZY ? 'crazybox' : CITIES[params.get('city')] ? params.get('city') : 'arcade';
const GAME_NO = CRAZY ? CRAZY_BOX : { arcade: 0, original: 1 }[cityName];
const COURSE_MODE = courseModeOf(GAME_NO, MINI_GAME);
const city = CITIES[['arcade', 'original', 'crazybox'][COURSE_MODE]];
// The driver from the driver select (boot.js puts it into ?cab=): 0 Axel .. 3 Gus.
const CAB = Math.min(3, Math.max(0, parseInt(params.get('cab'), 10) || 0));
// The rules from the menu (?rules=): 0 arcade, 1/2/3 the 3/5/10 minute work.
const RULES = Math.min(3, Math.max(0, parseInt(params.get('rules'), 10) || 0));

const status = document.getElementById('status');
const hudRoot = document.getElementById('hud');
const say = (t) => { status.textContent = t; };

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, stencil: true });   // stencil: the shadow volumes
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const SKY = 0x7fb2e5;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 5000, 13000);

// The Dreamcast's 4:3 picture (nlPerspective: near 3, far 15000) with its vertical view
// kept and its width the window's: the whole window is the picture, the HUD in its corners.
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 3, 15000);
const gameCamera = new GameCamera(camera);
packView(scene, camera, renderer);   // the texture pack's downloads: nearest the view first; its KTX2s' formats
let car = null;

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (car) car.aspect = camera.aspect;   // the game culls its traffic and people for this width
}
addEventListener('resize', resize);
resize();

async function fetchJson(path) {
  const r = await fetch(ASSETS + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function fetchBytes(path) {
  const r = await fetch(ASSETS + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function progress(label) {
  return (e) => { if (e.total) say(`${label} ${Math.round(e.loaded / e.total * 100)}%`); };
}

async function main() {
  say('Loading the game...');
  const files = carFiles(COURSE_MODE);
  const names = Object.keys(files);
  const [customerManifest, vehicleManifest, ...bytes] = await Promise.all([
    fetchJson('customers/manifest.json'),
    fetchJson('vehicles/manifest.json'),
    ...names.map((k) => fetchBytes(files[k])),
  ]);
  const data = Object.fromEntries(names.map((k, i) => [k, bytes[i]]));
  // The stops (none in the Crazy Box's games 0-2).
  const stopSet = customerManifest.stop_sets.find((s) => s.game_no === GAME_NO && s.mini_game_no === MINI_GAME);
  const stops = stopSet ? stopSet.stops : [];

  say('Loading city...');
  const people = new PeopleView(scene, ASSETS);
  const audio = new GameAudio(ASSETS);
  const digits = new CartoonDigits(ASSETS);
  const [cityGltf, propsGltf, cabGltf] = await Promise.all([
    loadGltf(ASSETS + city.models, progress('City')),
    loadGltf(ASSETS + city.props),
    loadGltf(ASSETS + `vehicles/cabs/cab_${CAB}.glb`),
    people.load(),
    audio.load(),
    digits.load(),
  ]);
  scene.add(makeUnlit(cityGltf.scene));
  scene.add(makeUnlit(propsGltf.scene));

  const cabModel = makeUnlit(cabGltf.scene);
  const wheelMeshes = [];
  // Only the wheel nodes: a multi-primitive wheel loads as a Group whose child meshes
  // are also named wheel_* and must not get pivots of their own.
  cabModel.traverse((o) => { if (o.name.startsWith('wheel_') && !o.parent.name.startsWith('wheel_')) wheelMeshes.push(o); });
  const wheels = wheelMeshes.map((o) => {
    // Spin about the axle inside a yaw pivot so the wheels can steer (the game
    // steers all four: carSteerWheels). Record order: front right, front left,
    // rear right, rear left (the model table init_CarMain reads).
    const pivot = new THREE.Group();
    pivot.position.copy(o.position);
    o.position.set(0, 0, 0);
    o.parent.add(pivot);
    pivot.add(o);
    const index = (pivot.position.z > 0 ? 0 : 2) + (pivot.position.x > 0 ? 0 : 1);
    return { pivot, mesh: o, index };
  });
  // The body (every part but the wheels) tilts on the chassis (putPlayerCar: +0xAC about
  // x, +0xB0 about z, then the model's 1.2 drop); the driver and the passenger are drawn
  // in that body matrix, so the seats must tilt with them.
  const body = new THREE.Group();
  body.rotation.order = 'XZY';
  for (const o of cabModel.children.filter((c) => !c.name.startsWith('wheel_'))) body.add(o);
  cabModel.add(body);
  // The cab's +z is its front: rotate it by the heading directly.
  const cab = new THREE.Group();
  cab.add(cabModel);
  scene.add(cab);

  car = new DreamcastCar(data, { city: GAME_NO, miniGame: MINI_GAME, cab: CAB, rules: RULES, audio, save: loadSave(localStorage) });
  car.aspect = camera.aspect;
  // The Crazy Box course (BINC3) holds every game's pieces in the same space: show this game's
  // (car.courseEntries(), the ones gdc_CourseStartLoadReq loads).
  const entries = car.courseEntries();
  if (entries) {
    const keep = new Set(entries.map((n) => `entry_${String(n).padStart(3, '0')}`));
    cityGltf.scene.traverse((o) => { if (/^entry_\d{3}$/.test(o.name)) o.visible = keep.has(o.name); });
  }
  // The Crazy Box's set objects run (ExecSetObject): they are drawn as SetObjFly draws them
  // (boxObjects: Crazy Bowling's pins of the lane in play, flying when hit), not the props.
  if (car.setObjects) propsGltf.scene.visible = false;
  // Browsers play nothing before a gesture: the first key or click starts the sound
  // (a song cued during the countdown picks up where it would be).
  for (const ev of ['keydown', 'pointerdown']) addEventListener(ev, () => audio.start(), { once: true });
  const cabShadow = new CabShadow(scene, cabGltf, car, cabModel);   // PutMVObj: the cab's shadow volume
  const input = new Input();
  const traffic = new TrafficView(scene, ASSETS, vehicleManifest);
  const navArrow = new NavArrow(scene, ASSETS);   // the game's arrow model, in front of the camera, to the destination
  const boxObjects = CRAZY ? new BoxObjects(scene, ASSETS, COURSE_MODE) : null;   // the Crazy Box games' own models (the balloons)
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  // The Crazy Box draws its own overlay (below): no money board (Put_Pass_Time is skipped there)
  // or countdown text of the HUD's, and no clock in Crazy Jump (game 0), whose time never
  // runs (it draws its own distance); the others' time runs out in a fault (reason 1) and
  // they draw no timer of their own.
  if (CRAZY) style.textContent += `#hud-board, #hud-big${MINI_GAME === 0 ? ', #hud-time' : ''} { display: none !important; }`;
  document.head.append(style);
  const hud = new Hud(hudRoot, ASSETS, digits);

  function restart() {
    car.init();           // gameState0: the game's own start - the countdown begins
    people.clear();
    traffic.clear();
  }
  restart();

  status.remove();
  hudRoot.hidden = false;

  // The Crazy Box's 2D overlay as the game draws it (car.sprites: execDCmini's distance,
  // timers and counts, the FAULT / EXCELLENT banners, Put_ReadySetGo's READY and GO), from
  // the game's sprites on a see-through canvas over the 4:3 middle of the picture.
  let boxView = null, boxCanvas = null;
  if (CRAZY) {
    boxCanvas = document.createElement('canvas');
    boxCanvas.style.cssText = 'position:fixed;top:0;left:50%;height:100vh;aspect-ratio:4/3;transform:translateX(-50%);pointer-events:none';
    document.body.append(boxCanvas);
    boxView = new MenuView(boxCanvas, ASSETS, await fetchJson('sprites/manifest.json'));
  }

  let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0;
  // The Crazy Box's end. callTryAgain (180 frames after a fault) opens the game's TRY AGAIN
  // window: the game stands still, its last frame dimmed (Pause_ExecRenderTexture1st draws
  // it at 0.4), and car.windowFrame runs the window with the pad - up / down, A (Z / Enter)
  // decides, B (X / Escape) is NO. YES plays the box again; NO goes back to the Crazy Box's
  // box screen (?menu=crazybox), as the game does after a clear (End_Excellent).
  let ending = false, leaving = false, frozen = [], pad = 0;
  const dim = document.createElement('div');
  dim.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0.6;pointer-events:none';
  dim.hidden = true;
  if (CRAZY) {
    boxCanvas.before(dim);
    const keys = {
      ArrowUp: PAD.UP, KeyW: PAD.UP, ArrowDown: PAD.DOWN, KeyS: PAD.DOWN,
      KeyZ: PAD.A, Enter: PAD.A, Space: PAD.A, KeyX: PAD.B, Escape: PAD.B, Backspace: PAD.B,
    };
    addEventListener('keydown', (e) => { if (keys[e.code]) pad |= keys[e.code]; });
    addEventListener('keyup', (e) => { if (keys[e.code]) pad &= ~keys[e.code]; });
    addEventListener('blur', () => { pad = 0; });
  }
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const events = [];
  const headPoint = new THREE.Vector3();

  // Where the passenger's head is on the picture ({ x, y } as fractions of it): the
  // rider's figure as the game drew it this frame (car.people: the one of their
  // character nearest the cab), 14 units (1.4 m) over its root; the cab's seat if the
  // figure is not drawn. null when there is no passenger or the point is behind the camera.
  function riderHead(rider) {
    if (!rider) return null;
    const d = car.drawn;
    let best = null, bestD = Infinity;
    for (const p of car.people) {
      if (p.chara !== rider.chara) continue;
      const dist = Math.hypot(p.matrix[12] - d.pos.x, p.matrix[14] - d.pos.z);
      if (dist < bestD) { best = p; bestD = dist; }
    }
    if (best) headPoint.set(best.matrix[12], best.matrix[13] + 14, best.matrix[14]);
    else headPoint.set(d.pos.x, d.pos.y + 12, d.pos.z);
    headPoint.project(camera);
    if (headPoint.z > 1) return null;
    return { x: (headPoint.x + 1) / 2, y: (1 - headPoint.y) / 2 };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    const state = input.poll();
    if (state.resetPressed) restart();
    let steps = 0;
    events.length = 0;
    while (acc >= STEP && steps < 6) {
      if (ending) car.windowFrame(pad);
      else car.update(state);
      events.push(...car.events);
      state.drivePressed = state.reversePressed = false;
      acc -= STEP;
      steps++;
    }
    if (CRAZY && !ending && car.crazyBox().over) {
      storeSave(localStorage, car.save());   // the records the game filed (a clear unlocks the next boxes)
      ending = true;
      dim.hidden = false;
      frozen = car.sprites.map((s) => ({ ...s, colour: s.colour.map((c) => c * 0.4) }));   // the last frame's overlay, dimmed
      car.events = [];
    }
    if (ending && car.choice === 'retry') {
      ending = false;
      dim.hidden = true;
      restart();
    } else if (ending && car.choice === 'menu' && !leaving) {
      leaving = true;
      location.search = `?menu=crazybox&game=${MINI_GAME}&cab=${CAB}`;
    }

    // The cab as the game draws it (car.drawn: the pose putPlayerCar saw, a frame
    // behind the physics like the camera and the people in the cab).
    const d = car.drawn;
    cab.position.set(d.pos.x, d.pos.y, d.pos.z);
    euler.set(d.pitch, d.heading, d.roll);
    cab.quaternion.setFromEuler(euler);
    body.rotation.set(d.bodyPitch, 0, d.bodyRoll);
    for (const w of wheels) {
      w.pivot.position.y = d.wheelHeight[w.index];
      w.pivot.rotation.y = d.wheelSteer[w.index];
      w.mesh.rotation.x = car.wheelSpin;
    }
    cabShadow.update();

    const customers = car.customers();
    const gs = car.gameSystem();
    const rider = car.rider();
    traffic.update(car.cars);
    people.update(car.people, customers, stops);
    if (boxObjects) boxObjects.update(car.objects);
    gameCamera.apply(car.camera());   // camUpdate's view: the traffic was culled with it
    // The Crazy Box: only while the game draws its own (some games carry fares without it).
    navArrow.update(camera, d.pos, gs.aboard && rider && rider.phase === 2 && (!CRAZY || car.navDrawn) ? stops[rider.stop].centre : null);
    renderer.render(scene, camera);
    if (boxView) {
      // The game's 640 x 480 screen is the 4:3 middle of the window (the vertical view is the game's).
      const h = Math.round(innerHeight * Math.min(devicePixelRatio, 2)), w = Math.round(h * 4 / 3);
      if (boxCanvas.width !== w || boxCanvas.height !== h) { boxCanvas.width = w; boxCanvas.height = h; }
      boxView.render(ending ? frozen.concat(car.sprites) : car.sprites, { clear: true });
    }

    frames++;
    if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    hud.update(gs, rider, stops, events, car, riderHead(rider),
      `${Math.round(car.kmh())} km/h  ${car.gear === 0 ? 'R' : 'D' + car.gear}  ${Math.round(car.rpm)} rpm  ${KIND_NAMES[car.groundKind] || '-'}  ` +
      `(${car.pos.x.toFixed(0)}, ${car.pos.y.toFixed(0)}, ${car.pos.z.toFixed(0)})  lv ${gs.level}  customers ${customers.length} (${people.drawn} people drawn)  ` +
      `traffic ${car.carCount} (${traffic.drawn} drawn, level ${car.trafficLevel})  cam ${car.camera().mode}  ${fps} fps`);
  }
  requestAnimationFrame(frame);

  // For tests and probes.
  window.__game = {
    car, scene, camera, gameCamera, renderer, cityName, wheelRadius: WHEEL_RADIUS, stops,
    people, traffic, cabShadow, navArrow, restart, audio, boxObjects,
  };
}

main().catch((e) => {
  console.error(e);
  say(`Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`);
});
