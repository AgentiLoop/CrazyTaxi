// Headless smoke test: load the page from a running vite dev server, wait for
// the game, hold the gas for a few seconds and save screenshots + the car state;
// then run the fare loop by teleporting the cab to a waiting customer and on to
// the destination stop (the rules themselves are node-tested in tests/game.test.mjs).
// Usage: node tools/browser-check.mjs [url] [outdir]   (needs playwright-core; see PW env)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.PW || '/tmp/ct-browser-check/node_modules/');
const { chromium } = require('playwright-core');

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const out = process.argv[3] || '/tmp/ct-check';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 180000 });
const snap = () => page.evaluate(() => {
  const g = window.__game, c = g.car;
  const cs = g.customers;
  return {
    pos: { ...c.pos }, kmh: c.kmh(), kind: c.groundKind, onGround: c.onGround, recoveries: c.recoveries, heading: c.heading,
    gs: { state: g.gs.state, time: g.gs.time, cash: g.gs.cash, aboard: g.gs.aboard, customerTime: g.gs.customerTime, level: g.gs.level, customers: g.gs.customers },
    waiting: cs.records.filter((r) => r.state === 1).length, live: g.view.live.size, rider: cs.rider ? cs.rider.index : null,
    traffic: { cars: c.carCount, drawn: g.traffic.drawn, instances: g.traffic.instances.size, level: c.trafficLevel,
      types: [...new Set(c.cars.map((t) => t.type))].sort((a, b) => a - b) },
    camera: (() => {
      const k = c.camera();
      return { mode: k.mode, fov: k.fov, eye: k.eye.map(Math.round), target: k.target.map(Math.round), threeFov: Math.round(g.camera.fov),
        aspect: g.camera.aspect, size: [g.renderer.domElement.clientWidth, g.renderer.domElement.clientHeight] };
    })(),
    hud: { clock: document.getElementById('hud-clock').textContent, cash: document.getElementById('hud-cash').textContent,
      big: document.getElementById('hud-big').hidden ? null : document.getElementById('hud-big').textContent,
      dest: document.getElementById('hud-dest').hidden ? null : document.getElementById('hud-dest-name').textContent,
      arrow: document.getElementById('hud-arrow').hidden ? null : document.getElementById('hud-arrow').style.transform,
      card: document.getElementById('hud-card').hidden ? null : document.getElementById('hud-card').textContent },
  };
});
await page.waitForTimeout(1500);
console.log('start', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/00-start.png` });
// The 366 frame countdown holds the cab; wait it out.
await page.waitForFunction(() => window.__game.gs.state === 1, null, { timeout: 20000 });
console.log('go', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/01-go.png` });
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/02-drive.png` });
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1500);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(3000);
await page.keyboard.up('ArrowUp');
console.log('end', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/03-turned.png` });

// The fare loop: put the cab beside the first waiting customer, stopped.
const fare = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cs = g.customers;
  let r = cs.records.find((x) => x.state === 1);
  if (!r) {
    // Drive the cab (by teleport) to the first record whose destination slot is set.
    r = cs.records.find((x) => x.destinations[Math.trunc(cs.frame / 600) % 3] >= 0);
  }
  g.car.place({ x: r.pos.x + 30, y: r.pos.y, z: r.pos.z, heading: 0 });
  await wait(300);
  const spawned = r.state;
  await wait(2200);     // 90 frame get-in
  const after = { state: r.state, aboard: g.gs.aboard, fare: g.gs.fare, customerTime: g.gs.customerTime, dest: r.dest, route: r.route, k: r.k,
    destName: document.getElementById('hud-dest-name').textContent, landmark: document.getElementById('hud-landmark').src,
    arrow: document.getElementById('hud-arrow').style.transform, time: g.gs.time };
  // Teleport to the destination stop and stop there.
  const s = cs.stops[r.dest];
  g.car.place({ x: s.centre[0], y: s.centre[1], z: s.centre[2], heading: 0 });
  await wait(300);
  const landed = { state: r.state, rating: r.rating, cash: g.gs.cash, paid: g.gs.paid, card: document.getElementById('hud-card').textContent };
  await wait(2000);
  return { index: r.index, spawned, after, landed, gone: r.state, rider: cs.rider && cs.rider.index, live: g.view.live.size, cash: g.gs.cash, customers: g.gs.customers };
});
console.log('fare', JSON.stringify(fare));
await page.screenshot({ path: `${out}/04-dropoff.png` });
const info = await page.evaluate(() => ({ calls: window.__game.renderer?.info?.render, debug: document.getElementById('hud-debug').textContent }));
console.log(JSON.stringify(info));
writeFileSync(`${out}/errors.json`, JSON.stringify(errors, null, 1));
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
