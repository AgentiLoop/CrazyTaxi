// Headless draw-order check: an auto-pilot drives the cab around the city (toward
// the nearest waiting customer, then the rider's destination; stuck or every 25 s
// it is put down at another stop) while every half second the frame is drawn three
// times with the game's camera:
//   A  the scene as the game draws it;
//   B  a reference in which every surface writes depth (see-through texels with any
//      alpha are kept, the empty ones dropped): each pixel shows the front-most surface;
//   ID the same front-most surface as a mesh number, plus whether its texel is solid
//      (alpha 1).
// The Dreamcast sorts its translucent polygons per pixel, so where the front-most
// surface is solid nothing can show through it: A must equal B there. A pixel
// (inside one mesh: its 3x3 neighbourhood has a single ID) that differs is a draw
// order mistake - something behind was drawn over it, like a far-side wheel over the
// body or a bush over a tree. The shadow volumes are hidden in all three passes.
// Usage: node tools/draw-order-check.mjs [url] [outdir] [seconds per city]
// (vite dev server running; playwright-core as for tools/browser-check.mjs)
// Exit code 1 when any sample has a mistake bigger than MIN_PIXELS.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.PW || '/tmp/ct-browser-check/node_modules/');
const { chromium } = require('playwright-core');

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const out = process.argv[3] || '/tmp/ct-draw-order';
const seconds = Number(process.argv[4] || 60);
const MIN_PIXELS = 40;      // a mistake smaller than this (in one mesh) is not reported
const TOLERANCE = 24;       // per channel
mkdirSync(out, { recursive: true });

// Runs in the page: the three passes and the comparison.
function checkFrame({ tolerance, minPixels, dump }) {
  const g = window.__game, { renderer, scene, camera } = g;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const st = window.__drawOrder ||= { ref: new WeakMap(), id: new WeakMap(), next: 1 };
  const meshes = [], hidden = [];
  scene.updateMatrixWorld();
  scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m.stencilWrite || m.colorWrite === false)) hidden.push(o);
    else meshes.push(o);
  });
  for (const o of hidden) o.visible = false;
  const read = () => { const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  // Every surface writes depth; see-through materials keep any texel with alpha.
  const front = (m) => {
    const r = m.clone();
    r.transparent = false; r.depthWrite = true; r.depthTest = true;
    r.alphaTest = m.transparent ? Math.max(1 / 255, m.alphaTest) : m.alphaTest;
    return r;
  };
  const refOf = (m) => { let r = st.ref.get(m); if (!r) { r = front(m); st.ref.set(m, r); } return r; };
  // A mesh's number as a colour: mode 'front' = the reference's surfaces (plus the solid
  // bit), 'game' = the game's own depth and sorting set-up (what A shows on top).
  const idOf = (o, m, k, mode) => {
    let list = st.id.get(o);
    if (!list) { list = { id: st.next++, front: [], game: [] }; st.id.set(o, list); }
    let r = list[mode][k];
    if (!r || r.source !== m) {
      if (mode === 'front') r = front(m);
      else {
        r = m.clone();
        r.blending = 0;   // THREE.NoBlending: the last fragment drawn wins
        r.alphaTest = Math.max(1 / 255, m.alphaTest);
      }
      r.source = m;
      const id = list.id, solidAlways = m.transparent ? 0 : 1;
      r.customProgramCacheKey = () => 'draw-order-id';
      r.onBeforeCompile = (s) => {
        s.uniforms.ctId = { value: { x: (id >> 15 & 255) / 255, y: (id >> 7 & 255) / 255, z: ((id & 127) * 2) / 255 } };
        s.uniforms.ctSolid = { value: solidAlways };
        s.fragmentShader = 'uniform vec3 ctId;\nuniform float ctSolid;\n' + s.fragmentShader
          .replace('#include <opaque_fragment>', 'float ctA = max(ctSolid, diffuseColor.a >= 0.996 ? 1.0 : 0.0);\n#include <opaque_fragment>')
          .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor = vec4(ctId.xy, ctId.z + ctA / 255.0, 1.0);');
      };
      list[mode][k] = r;
    }
    return r;
  };
  const originals = meshes.map((o) => o.material);
  const names = new Map();
  try {
    renderer.render(scene, camera);
    const a = read();
    meshes.forEach((o) => { o.material = Array.isArray(o.material) ? o.material.map(refOf) : refOf(o.material); });
    renderer.render(scene, camera);
    const b = read();
    const bg = scene.background, fog = scene.fog, clear = renderer.getClearColor(new bg.constructor());   // bg: a THREE.Color
    const alpha = renderer.getClearAlpha();
    scene.background = null; scene.fog = null;
    renderer.setClearColor(0x000000, 1);
    const idPass = (mode) => {
      meshes.forEach((o, i) => {
        const m = originals[i];
        o.material = Array.isArray(m) ? m.map((x, k) => idOf(o, x, k, mode)) : idOf(o, m, 0, mode);
        names.set(st.id.get(o).id, o);
      });
      renderer.render(scene, camera);
      return read();
    };
    const ids = idPass('front'), shown = idPass('game');
    scene.background = bg; scene.fog = fog;
    renderer.setClearColor(clear, alpha);

    const pix = (i) => (ids[i] << 16) | (ids[i + 1] << 8) | ids[i + 2];
    const per = new Map();
    let checked = 0;
    const bad = dump ? new Uint8Array(w * h) : null;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4, v = pix(i);
        if (!(v & 1) || v === 0) continue;                       // background or a see-through texel in front
        let same = true;
        for (let dy = -1; dy <= 1 && same; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (pix(((y + dy) * w + x + dx) * 4) !== v) { same = false; break; }
        }
        if (!same) continue;
        checked++;
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d <= tolerance) continue;
        const key = `${v >> 1}:${((shown[i] << 16) | (shown[i + 1] << 8) | shown[i + 2]) >> 1}`;
        per.set(key, (per.get(key) || 0) + 1);
        if (bad) bad[y * w + x] = 1;
      }
    }
    const path = (o) => {
      const parts = [];
      for (let p = o; p && p !== scene; p = p.parent) if (p.name) parts.unshift(p.name);
      return parts.slice(-4).join('/');
    };
    const label = (id) => (names.has(id) ? path(names.get(id)) : id ? `#${id}` : 'nothing');
    // Each mistake: the front-most solid surface (mesh) and what the game drew over it (over).
    const offenders = [...per].filter(([, n]) => n >= minPixels).sort((p, q) => q[1] - p[1])
      .map(([key, n]) => { const [f, s] = key.split(':').map(Number); return { mesh: label(f), over: label(s), pixels: n }; });
    let png = null;
    if (dump && offenders.length) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4, t = (y * w + x) * 4;
        const isBad = bad[(h - 1 - y) * w + x];
        img.data[t] = isBad ? 255 : a[s]; img.data[t + 1] = isBad ? 0 : a[s + 1]; img.data[t + 2] = isBad ? 255 : a[s + 2]; img.data[t + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      png = c.toDataURL('image/png');
    }
    return { checked, offenders, png, meshes: meshes.length };
  } finally {
    meshes.forEach((o, i) => { o.material = originals[i]; });
    for (const o of hidden) o.visible = true;
  }
}

// Runs in the page: where the auto-pilot wants to go, and the car's state.
function pilotState() {
  const g = window.__game, c = g.car;
  const gs = c.gameSystem();
  const rider = c.rider();
  let target = null;
  if (rider && rider.stop >= 0 && g.stops[rider.stop]) target = g.stops[rider.stop].centre;
  else {
    let best = Infinity;
    for (const t of c.customers()) {
      if (t.request >= 5) continue;
      const d = Math.hypot(t.spot[0] - c.pos.x, t.spot[2] - c.pos.z);
      if (d < best) { best = d; target = t.spot; }
    }
  }
  const dist = target ? Math.hypot(target[0] - c.pos.x, target[2] - c.pos.z) : Infinity;
  const want = target ? Math.atan2(target[0] - c.pos.x, target[2] - c.pos.z) : c.heading;
  let diff = want - c.heading;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return { state: gs.state, control: c.control, kmh: c.kmh(), diff, dist, yaw: c.yawRate, pos: [c.pos.x, c.pos.y, c.pos.z], stops: g.stops.length, aboard: gs.aboard, delivered: gs.delivered, drawn: g.traffic.drawn };
}

function teleport(seed) {
  const g = window.__game, s = g.stops[seed % g.stops.length];
  const t = g.car.customers().find((x) => x.request < 5);
  const heading = t ? Math.atan2(t.spot[0] - s.centre[0], t.spot[2] - s.centre[2]) : 0;
  g.car.moveTo({ x: s.centre[0], y: s.centre[1], z: s.centre[2], heading });
  return s.centre;
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const report = { cities: {} };
let failed = 0;
for (const city of ['arcade', 'original']) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}?city=${city}`);
  await page.waitForFunction(() => window.__game, null, { timeout: 180000 });
  const held = new Set();
  const keys = async (want) => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      if (want.has(k) && !held.has(k)) { await page.keyboard.down(k); held.add(k); }
      if (!want.has(k) && held.has(k)) { await page.keyboard.up(k); held.delete(k); }
    }
  };
  const samples = [], worst = [];
  let sign = 0, stuckSince = 0, lastJump = Date.now(), jumps = 0, n = 0;
  const start = Date.now();
  let nextCheck = start;
  while (Date.now() - start < seconds * 1000) {
    const s = await page.evaluate(pilotState);
    const now = Date.now();
    if (s.state === 2) { await keys(new Set()); await page.keyboard.press('KeyR'); await page.waitForTimeout(500); continue; }
    const want = new Set();
    if (s.control !== 0 && s.state === 1) {
      // Which way the right key turns the heading: learnt from the first turns.
      if (!sign && held.has('ArrowRight') && Math.abs(s.yaw) > 1e-4) sign = Math.sign(s.yaw);
      const turn = sign || 1;
      if (Math.abs(s.diff) > 0.1) want.add(s.diff * turn > 0 ? 'ArrowRight' : 'ArrowLeft');
      if (s.dist < 70) want.add('ArrowDown');
      else if (s.dist < 250 && s.kmh > 40) want.add('ArrowDown');
      else want.add('ArrowUp');
      if (s.kmh < 3 && s.dist >= 70) { stuckSince ||= now; } else stuckSince = 0;
      if ((stuckSince && now - stuckSince > 3000) || now - lastJump > 25000) {
        await keys(new Set());
        await page.evaluate(teleport, jumps++ * 7 + (city === 'arcade' ? 0 : 3));
        stuckSince = 0; lastJump = now;
        continue;
      }
    }
    await keys(want);
    if (now >= nextCheck) {
      nextCheck = now + 500;
      const r = await page.evaluate(checkFrame, { tolerance: TOLERANCE, minPixels: MIN_PIXELS, dump: true });
      const pixels = r.offenders.reduce((t, o) => t + o.pixels, 0);
      const sample = { i: n++, t: Math.round((now - start) / 100) / 10, pos: s.pos.map(Math.round), kmh: Math.round(s.kmh), traffic: s.drawn, meshes: r.meshes, checked: r.checked, pixels, offenders: r.offenders.slice(0, 8) };
      samples.push(sample);
      if (r.offenders.length) {
        failed++;
        console.log(city, JSON.stringify(sample));
        if (worst.length < 12) {
          const file = `${out}/${city}-${String(sample.i).padStart(3, '0')}.png`;
          writeFileSync(file, Buffer.from(r.png.split(',')[1], 'base64'));
          worst.push(file);
        }
      }
    }
    await page.waitForTimeout(50);
  }
  await keys(new Set());
  const bad = samples.filter((s) => s.offenders.length);
  const byMesh = {};
  for (const s of bad) for (const o of s.offenders) {
    const key = `${o.mesh} <- ${o.over}`.replace(/_[0-9a-f]{6}\b/g, '');
    byMesh[key] = (byMesh[key] || 0) + o.pixels;
  }
  report.cities[city] = { samples: samples.length, failing: bad.length, teleports: jumps, steerSign: sign, byMesh, images: worst, errors };
  console.log(city, `${samples.length} samples, ${bad.length} with draw-order mistakes, ${jumps} teleports, ${errors.length} page errors`);
  console.log(city, 'by mesh', JSON.stringify(Object.entries(byMesh).sort((p, q) => q[1] - p[1]).slice(0, 20)));
  writeFileSync(`${out}/${city}-samples.json`, JSON.stringify(samples, null, 1));
  await page.close();
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
process.exit(failed ? 1 : 0);
