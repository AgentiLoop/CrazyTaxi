// Headless smoke test: load the page from a running vite dev server, wait for
// the game, hold the gas for a few seconds and save screenshots + the car state.
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
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 180000 });
const snap = () => page.evaluate(() => {
  const c = window.__game.car;
  return { pos: { ...c.pos }, kmh: c.kmh(), kind: c.groundKind, onGround: c.onGround, recoveries: c.recoveries, heading: c.heading };
});
await page.waitForTimeout(1500);
console.log('start', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/00-start.png` });
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/01-drive.png` });
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1500);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(3000);
await page.keyboard.up('ArrowUp');
console.log('end', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/02-turned.png` });
const info = await page.evaluate(() => ({ calls: window.__game.renderer?.info?.render, hud: document.getElementById('hud').textContent }));
console.log(JSON.stringify(info));
writeFileSync(`${out}/errors.json`, JSON.stringify(errors, null, 1));
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
