// Crazy Taxi in three.js: the Arcade city, its set objects and a drivable cab
// over the game's own collision grid. Assets come from local-assets/ (written by
// tools/extract_all.py; never bundled).
import * as THREE from 'three';
import { Collision, KIND_NAMES } from './collision.js';
import { Car, STEP, WHEEL_RADIUS } from './car.js';
import { Input } from './input.js';
import { CITIES } from './start.js';
import { loadGltf, makeUnlit, ChaseCamera } from './scene.js';

const ASSETS = 'local-assets/';
const params = new URLSearchParams(location.search);
const cityName = CITIES[params.get('city')] ? params.get('city') : 'arcade';
const city = CITIES[cityName];

const status = document.getElementById('status');
const hud = document.getElementById('hud');
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
  const [colJson, courses] = await Promise.all([
    fetchJson(city.collision),
    fetchJson(city.collision.replace('collision/', 'courses/')),
  ]);
  const collision = new Collision(colJson);
  const F = courses.course_fields;
  const stagePoints = [];
  for (const c of courses.courses) {
    if (c[F.indexOf('role')] === 'stage') stagePoints.push(...c[F.indexOf('points')]);
  }

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
  car.place(city.start);
  const input = new Input();

  status.remove();
  hud.hidden = false;

  let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    const state = input.poll();
    if (state.resetPressed) car.place(city.start);
    if (state.cameraPressed) chase.mode = (chase.mode + 1) % 2;
    let steps = 0;
    while (acc >= STEP && steps < 6) {
      car.update(state);
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

    chase.update(car, dt);
    renderer.render(scene, camera);

    frames++;
    if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    hud.textContent = `${Math.round(car.kmh())} km/h  ${car.gear === 0 ? 'R' : 'D'}  ` +
      `${KIND_NAMES[car.groundKind] || '-'}  (${car.pos.x.toFixed(0)}, ${car.pos.y.toFixed(0)}, ${car.pos.z.toFixed(0)})  ${fps} fps`;
  }
  requestAnimationFrame(frame);

  // For tests and probes.
  window.__game = { car, collision, scene, camera, chase, renderer, cityName, wheelRadius: WHEEL_RADIUS };
}

main().catch((e) => {
  console.error(e);
  say(`Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`);
});
