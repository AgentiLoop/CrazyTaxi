// Crazy Taxi in three.js: the Arcade city, its set objects, a drivable cab over
// the game's own collision grid, and the fare loop (customers, time, cash).
// Assets come from local-assets/ (written by tools/extract_all.py; never bundled).
import * as THREE from 'three';
import { Collision, KIND_NAMES } from './collision.js';
import { Car, STEP, WHEEL_RADIUS } from './car.js';
import { Input } from './input.js';
import { CITIES } from './start.js';
import { loadGltf, makeUnlit, ChaseCamera } from './scene.js';
import { GameSystem } from './game.js';
import { Customers } from './customers.js';
import { CustomerView } from './customer-view.js';
import { Hud, HUD_CSS } from './hud.js';

const ASSETS = 'local-assets/';
const params = new URLSearchParams(location.search);
const cityName = CITIES[params.get('city')] ? params.get('city') : 'arcade';
const city = CITIES[cityName];
const GAME_NO = { arcade: 0, original: 1 }[cityName];

const status = document.getElementById('status');
const hudRoot = document.getElementById('hud');
const say = (t) => { status.textContent = t; };

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: document.getElementById('view') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const SKY = 0x7fb2e5;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 5000, 13000);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 2, 20000);
const chase = new ChaseCamera(camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function fetchJson(path) {
  const r = await fetch(ASSETS + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function progress(label) {
  return (e) => { if (e.total) say(`${label} ${Math.round(e.loaded / e.total * 100)}%`); };
}

async function main() {
  say('Loading collision...');
  const [colJson, courses, customerManifest] = await Promise.all([
    fetchJson(city.collision),
    fetchJson(city.collision.replace('collision/', 'courses/')),
    fetchJson('customers/manifest.json'),
  ]);
  const collision = new Collision(colJson);
  const F = courses.course_fields;
  const stagePoints = [];
  let line = null;
  for (const c of courses.courses) {
    const role = c[F.indexOf('role')];
    if (role === 'stage') stagePoints.push(...c[F.indexOf('points')]);
    if (role === 'line') line = c[F.indexOf('points')];
  }
  const customerSet = customerManifest.customer_sets.find((s) => s.name === cityName);
  const stopSet = customerManifest.stop_sets.find((s) => s.game_no === GAME_NO && s.mini_game_no === 0);

  say('Loading city...');
  const [cityGltf, propsGltf, cabGltf] = await Promise.all([
    loadGltf(ASSETS + city.models, progress('City')),
    loadGltf(ASSETS + city.props),
    loadGltf(ASSETS + 'vehicles/cabs/cab_0.glb'),
  ]);
  scene.add(makeUnlit(cityGltf.scene));
  scene.add(makeUnlit(propsGltf.scene));

  const cabModel = makeUnlit(cabGltf.scene);
  const wheelMeshes = [];
  cabModel.traverse((o) => { if (o.name.startsWith('wheel_')) wheelMeshes.push(o); });
  const wheels = wheelMeshes.map((o) => {
    // Spin about the axle inside a yaw pivot so the front wheels can steer.
    const pivot = new THREE.Group();
    pivot.position.copy(o.position);
    o.position.set(0, 0, 0);
    o.parent.add(pivot);
    pivot.add(o);
    return { pivot, mesh: o, front: pivot.position.z > 0 };
  });
  // The cab's +z is its front: rotate it by the heading directly.
  const cab = new THREE.Group();
  cab.add(cabModel);
  scene.add(cab);

  const car = new Car(collision, stagePoints);
  const input = new Input();
  const gs = new GameSystem();
  let customers;
  const view = new CustomerView(scene, ASSETS, collision);
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.append(style);
  const hud = new Hud(hudRoot, ASSETS);

  function restart() {
    car.place(city.start);
    gs.reset();
    customers = new Customers(customerSet, stopSet, line, cityName);
    view.clear();
  }
  restart();

  status.remove();
  hudRoot.hidden = false;

  let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const carState = { pos: car.pos, speed: 0, yawRate: 0 };
  const events = [];

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    const state = input.poll();
    if (state.resetPressed) restart();
    if (state.cameraPressed) chase.mode = (chase.mode + 1) % 2;
    let steps = 0;
    events.length = 0;
    while (acc >= STEP && steps < 6) {
      gs.tick();
      car.hold = !gs.controlOn || customers.holding;
      const before = { x: car.pos.x, z: car.pos.z };
      car.update(state);
      gs.tripMeter(Math.hypot(car.pos.x - before.x, car.pos.z - before.z));
      carState.speed = car.speed * STEP;   // units per frame, as the game measures it
      carState.yawRate = car.yawRate;
      customers.update(carState, gs);
      events.push(...customers.events);
      state.drivePressed = state.reversePressed = false;
      acc -= STEP;
      steps++;
    }

    cab.position.set(car.pos.x, car.pos.y, car.pos.z);
    euler.set(car.pitch, car.heading, car.roll);
    cab.quaternion.setFromEuler(euler);
    for (const w of wheels) {
      w.pivot.rotation.y = w.front ? car.steer : 0;
      w.mesh.rotation.x = car.wheelSpin;
    }

    customers.events.length = 0;
    customers.events.push(...events);
    view.update(customers, car, dt);
    chase.update(car, dt);
    renderer.render(scene, camera);

    frames++;
    if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    hud.update(gs, customers, car, events,
      `${Math.round(car.kmh())} km/h  ${car.gear === 0 ? 'R' : 'D'}  ${KIND_NAMES[car.groundKind] || '-'}  ` +
      `(${car.pos.x.toFixed(0)}, ${car.pos.y.toFixed(0)}, ${car.pos.z.toFixed(0)})  line ${customers.carLine}  lv ${gs.level}  ${fps} fps`);
  }
  requestAnimationFrame(frame);

  // For tests and probes.
  window.__game = {
    car, collision, scene, camera, chase, renderer, cityName, wheelRadius: WHEEL_RADIUS,
    gs, get customers() { return customers; }, view, restart,
  };
}

main().catch((e) => {
  console.error(e);
  say(`Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`);
});
