// Crazy Taxi in three.js: the Arcade city, its set objects, the cab, the traffic
// and the camera driven by the game's own code (exec_CarMain, trafficControl, the
// traffic events and camUpdate running in an SH-4 interpreter, src/dc-car.js) over
// the game's collision, and the fare loop (customers, time, cash).
// Assets come from local-assets/ (written by tools/extract_all.py; never bundled).
import * as THREE from 'three';
import { Collision, KIND_NAMES } from './collision.js';
import { DreamcastCar, STEP, WHEEL_RADIUS, carFiles } from './dc-car.js';
import { Input } from './input.js';
import { CITIES } from './start.js';
import { loadGltf, makeUnlit, GameCamera, letterbox } from './scene.js';
import { GameSystem, STATE_COUNTDOWN } from './game.js';
import { Customers } from './customers.js';
import { CustomerView } from './customer-view.js';
import { Hud, HUD_CSS } from './hud.js';
import { TrafficView } from './traffic-view.js';

const ASSETS = 'local-assets/';
const params = new URLSearchParams(location.search);
const cityName = CITIES[params.get('city')] ? params.get('city') : 'arcade';
const city = CITIES[cityName];
const GAME_NO = { arcade: 0, original: 1 }[cityName];

const status = document.getElementById('status');
const hudRoot = document.getElementById('hud');
const say = (t) => { status.textContent = t; };

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, stencil: true });   // stencil: the traffic's shadow volumes
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const SKY = 0x7fb2e5;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 5000, 13000);

// The Dreamcast's 4:3 picture (nlPerspective: near 3, far 15000), letterboxed in the window.
const camera = new THREE.PerspectiveCamera(45, 4 / 3, 3, 15000);
const gameCamera = new GameCamera(camera);

function resize() {
  const box = letterbox(innerWidth, innerHeight);
  renderer.setSize(box.width, box.height);
  for (const el of [canvas, hudRoot]) {
    el.style.left = `${box.x}px`; el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`; el.style.height = `${box.height}px`;
  }
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
  say('Loading collision...');
  const files = carFiles(GAME_NO);
  const [colJson, courses, customerManifest, vehicleManifest, exe, courseBytes, collisionBytes] = await Promise.all([
    fetchJson(city.collision),
    fetchJson(city.collision.replace('collision/', 'courses/')),
    fetchJson('customers/manifest.json'),
    fetchJson('vehicles/manifest.json'),
    fetchBytes(files.exe), fetchBytes(files.courses), fetchBytes(files.collision),
  ]);
  const collision = new Collision(colJson);
  const F = courses.course_fields;
  let line = null;
  for (const c of courses.courses) {
    if (c[F.indexOf('role')] === 'line') line = c[F.indexOf('points')];
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
  // The cab's +z is its front: rotate it by the heading directly.
  const cab = new THREE.Group();
  cab.add(cabModel);
  scene.add(cab);

  const car = new DreamcastCar({ exe, courses: courseBytes, collision: collisionBytes }, { city: GAME_NO });
  const input = new Input();
  const gs = new GameSystem();
  let customers;
  const view = new CustomerView(scene, ASSETS, collision);
  const traffic = new TrafficView(scene, ASSETS, vehicleManifest);
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.append(style);
  const hud = new Hud(hudRoot, ASSETS);

  function restart() {
    car.init();           // init_CarMain: the game's own start spot
    car.startIntro();     // the countdown's start camera
    gs.reset();
    customers = new Customers(customerSet, stopSet, line, cityName);
    view.clear();
    traffic.clear();
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
    let steps = 0;
    events.length = 0;
    while (acc >= STEP && steps < 6) {
      gs.tick();
      // The game tick plays the start camera while the countdown is positive.
      car.intro = gs.state === STATE_COUNTDOWN && gs.countdown > 0;
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
      w.pivot.position.y = car.wheelHeight[w.index];
      w.pivot.rotation.y = car.wheelSteer[w.index];
      w.mesh.rotation.x = car.wheelSpin;
    }

    customers.events.length = 0;
    customers.events.push(...events);
    traffic.update(car.cars);
    view.update(customers, car, dt);
    gameCamera.apply(car.camera());   // camUpdate's view: the traffic was culled with it
    renderer.render(scene, camera);

    frames++;
    if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    hud.update(gs, customers, car, events,
      `${Math.round(car.kmh())} km/h  ${car.gear === 0 ? 'R' : 'D' + car.gear}  ${Math.round(car.rpm)} rpm  ${KIND_NAMES[car.groundKind] || '-'}  ` +
      `(${car.pos.x.toFixed(0)}, ${car.pos.y.toFixed(0)}, ${car.pos.z.toFixed(0)})  line ${customers.carLine}  lv ${gs.level}  ` +
      `traffic ${car.carCount} (${traffic.drawn} drawn, level ${car.trafficLevel})  cam ${car.camera().mode}  ${fps} fps`);
  }
  requestAnimationFrame(frame);

  // For tests and probes.
  window.__game = {
    car, collision, scene, camera, gameCamera, renderer, cityName, wheelRadius: WHEEL_RADIUS,
    gs, get customers() { return customers; }, view, traffic, restart,
  };
}

main().catch((e) => {
  console.error(e);
  say(`Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`);
});
