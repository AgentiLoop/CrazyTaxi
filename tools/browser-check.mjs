// Headless smoke test: load the page from a running vite dev server, wait for
// the game, hold the gas for a few seconds and save screenshots + the car state;
// then run a fare by moving the cab beside a waiting customer (the game's own
// customer code takes over: the get-in, the ride, the drop-off) and on to the
// destination stop.
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
  const gs = c.gameSystem();
  const tasks = c.customers();
  const rider = c.rider();
  return {
    pos: { ...c.pos }, kmh: c.kmh(), kind: c.groundKind, onGround: c.onGround, recoveries: c.recoveries, heading: c.heading, control: c.control,
    gs: { state: gs.state, counter: gs.counter, time: gs.time, cash: gs.cash, aboard: gs.aboard, customerTime: gs.customerTime, level: gs.level, delivered: gs.delivered },
    waiting: tasks.filter((t) => t.request < 5).length, tasks: tasks.length, people: g.people.drawn, rider: rider ? { chara: rider.chara, phase: rider.phase, stop: rider.stop } : null,
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
      arrow: g.navArrow.mesh.visible ? Math.round(g.navArrow.mesh.rotation.y * 180 / Math.PI) : null,
      card: document.getElementById('hud-card').hidden ? null : document.getElementById('hud-card').textContent },
  };
});
await page.waitForTimeout(1500);
console.log('start', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/00-start.png` });
// The 366 frame countdown holds the cab; wait it out.
await page.waitForFunction(() => window.__game.car.gameSystem().state === 1, null, { timeout: 20000 });
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

// The fare: put the cab beside the first waiting customer and hold the brake.
const first = await page.evaluate(() => {
  const g = window.__game;
  const t = g.car.customers().find((x) => x.request < 5);
  if (!t) return null;
  g.car.moveTo({ x: t.spot[0] + 30, y: t.spot[1], z: t.spot[2], heading: 0 });
  return { chara: t.chara, stop: t.stop, k: t.k, spot: t.spot };
});
console.log('customer', JSON.stringify(first));
await page.keyboard.down('ArrowDown');
await page.waitForFunction(() => window.__game.car.gameSystem().aboard === 1, null, { timeout: 10000 });
await page.waitForTimeout(1200);     // the get-in cut
await page.screenshot({ path: `${out}/04-getin.png` });
const boarded = await snap();
boarded.landmark = await page.evaluate(() => document.getElementById('hud-landmark').src);
console.log('boarded', JSON.stringify(boarded));
// Wait until the game gives the cab back (the get-in done), then go to the destination.
await page.waitForFunction(() => window.__game.car.control !== 0, null, { timeout: 10000 });
await page.waitForTimeout(300);
console.log('riding', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/05-riding.png` });
await page.evaluate(() => {
  const g = window.__game, r = g.car.rider(), s = g.stops[r.stop];
  g.car.moveTo({ x: s.centre[0], y: s.centre[1], z: s.centre[2], heading: 0 });
});
await page.waitForFunction(() => window.__game.car.gameSystem().delivered === 1, null, { timeout: 10000 });
await page.waitForTimeout(800);
const dropped = await snap();
console.log('dropped', JSON.stringify(dropped));
await page.screenshot({ path: `${out}/06-dropoff.png` });
await page.waitForFunction(() => window.__game.car.control !== 0, null, { timeout: 10000 });
await page.keyboard.up('ArrowDown');
console.log('after', JSON.stringify(await snap()));
const info = await page.evaluate(() => ({ calls: window.__game.renderer?.info?.render, debug: document.getElementById('hud-debug').textContent }));
console.log(JSON.stringify(info));
writeFileSync(`${out}/errors.json`, JSON.stringify(errors, null, 1));
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
