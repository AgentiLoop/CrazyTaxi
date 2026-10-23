// Start-up: the game's menu (src/dc-menu.js, drawn by src/menu-view.js), then the
// city the player chose (src/main.js reads ?city=). With ?city= in the address the
// menu is skipped (the browser checks start a city directly).
//
// Keys in the menu, as the Dreamcast pad: arrows / WASD = d-pad, Z / Enter / Space =
// A (choose), X / Escape / Backspace = B (back), Q = Start.
import { DreamcastMenu, PAD, MODES } from './dc-menu.js';
import { MenuView } from './menu-view.js';
import { letterbox } from './scene.js';

const ASSETS = 'local-assets/';
const STEP = 1000 / 60;
const KEYS = {
  ArrowUp: PAD.UP, KeyW: PAD.UP, ArrowDown: PAD.DOWN, KeyS: PAD.DOWN,
  ArrowLeft: PAD.LEFT, KeyA: PAD.LEFT, ArrowRight: PAD.RIGHT, KeyD: PAD.RIGHT,
  KeyZ: PAD.A, Enter: PAD.A, Space: PAD.A,
  KeyX: PAD.B, Escape: PAD.B, Backspace: PAD.B,
  KeyQ: PAD.START,
};
const CITIES = { 0: 'arcade', 1: 'original' };

const status = document.getElementById('status');

async function fetchOk(path) {
  const r = await fetch(ASSETS + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

/** Run the menu until a city is chosen; resolves with the menu's result. */
async function runMenu() {
  status.textContent = 'Loading the menu...';
  const [exe, manifest] = await Promise.all([
    fetchOk('disc/1ST_READ.BIN').then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    fetchOk('sprites/manifest.json').then((r) => r.json()),
  ]);
  const menu = new DreamcastMenu(exe);
  const canvas = document.createElement('canvas');
  canvas.id = 'menu';
  canvas.style.position = 'fixed';
  document.body.append(canvas);
  const view = new MenuView(canvas, ASSETS, manifest);
  const resize = () => {
    const box = letterbox(innerWidth, innerHeight);
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
    Object.assign(canvas.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  };
  addEventListener('resize', resize);
  resize();
  status.style.display = 'none';

  let held = 0;
  const down = (e) => { if (KEYS[e.code]) { e.preventDefault(); held |= KEYS[e.code]; } };
  const up = (e) => { if (KEYS[e.code]) held &= ~KEYS[e.code]; };
  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('blur', () => { held = 0; });
  window.__menu = menu;   // for tests and probes

  return new Promise((resolve) => {
    let last = performance.now(), acc = 0;
    function frame(now) {
      acc = Math.min(acc + now - last, STEP * 6);
      last = now;
      while (acc >= STEP) {
        acc -= STEP;
        if (menu.update(held)) continue;
        const city = menu.result && CITIES[menu.result.mode];
        if (city) {
          removeEventListener('resize', resize);
          removeEventListener('keydown', down);
          removeEventListener('keyup', up);
          canvas.remove();
          resolve({ city, ...menu.result });
          return;
        }
        // EXIT (back to the title, not ported yet) or the Crazy Box (not playable yet):
        // the menu starts over.
        if (menu.result) console.warn(`menu: ${MODES[menu.result.mode]} is not playable yet`);
        menu.init();
      }
      view.render(menu.draws);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

async function boot() {
  if (!new URLSearchParams(location.search).has('city')) {
    const choice = await runMenu();
    history.replaceState(null, '', `?city=${choice.city}`);
    status.style.display = '';
  }
  await import('./main.js');
}

boot().catch((e) => {
  console.error(e);
  status.style.display = '';
  status.textContent = `Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`;
});
