// Start-up: the game's title screen, menu and driver select (src/dc-menu.js, drawn by
// src/menu-view.js and src/select-view.js), then the city the player chose (src/main.js
// reads ?city=; the chosen driver goes into ?cab=). With ?city= in the address the
// title and the menu are skipped (the browser checks start a city directly).
//
// Keys in the menu, as the Dreamcast pad: arrows / WASD = d-pad, Z / Enter / Space =
// A (choose), X / Escape / Backspace = B (back), Q = Start. On the title, which only
// takes START on the Dreamcast, the A keys press START too.
// An Xbox pad: D-pad / left stick, A, B, X, Y and Menu (≡) = Start (src/input.js padBits).
// Y (the key) puts the mod's 5th driver, Spidey, in Axel's place (src/spidey.js).
import { DreamcastMenu, PAD, MODES, loadSave } from './dc-menu.js';
import { padBits } from './input.js';
import { MenuView, FONTS } from './menu-view.js';
import { SelectView } from './select-view.js';
import { letterbox } from './scene.js';
import { GameAudio } from './audio.js';
import { SPIDEY_CAB } from './spidey.js';
// The menu's web fonts (src/menu-view.js draws its text with them).
import '@fontsource/anton/400.css';
import '@fontsource/archivo-black/400.css';
import '@fontsource/roboto-condensed/700.css';
import '@fontsource/oswald/500.css';

// The asset folder: local-assets/, or the asset release's (VITE_ASSETS=... at build or dev time).
const ASSETS = (import.meta.env && import.meta.env.VITE_ASSETS) || 'local-assets/';
const STEP = 1000 / 60;
const KEYS = {
  ArrowUp: PAD.UP, KeyW: PAD.UP, ArrowDown: PAD.DOWN, KeyS: PAD.DOWN,
  ArrowLeft: PAD.LEFT, KeyA: PAD.LEFT, ArrowRight: PAD.RIGHT, KeyD: PAD.RIGHT,
  KeyZ: PAD.A, Enter: PAD.A, Space: PAD.A,
  KeyX: PAD.B, Escape: PAD.B, Backspace: PAD.B,
  KeyQ: PAD.START,
};
const CITIES = { 0: 'arcade', 1: 'original', 2: 'crazybox' };

const status = document.getElementById('status');

async function fetchOk(path) {
  const r = await fetch(ASSETS + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

/** Run the menu until a city is chosen; resolves with the menu's result. box: open on the Crazy Box's box screen with that game's box chosen and cab as the CABBIE. */
async function runMenu(box, cab, spidey = false) {
  status.textContent = 'Loading the menu...';
  // The menus' sound (src/audio.js): the menu loop, the driver select's song, the cursor
  // and decide sounds and the voice, as the menu code requests them.
  const audio = new GameAudio(ASSETS);
  const [exe, manifest, motions] = await Promise.all([
    fetchOk('disc/1ST_READ.BIN').then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    fetchOk('sprites/manifest.json').then((r) => r.json()),
    fetchOk('disc/MOTDC.BIN').then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    Promise.all(FONTS.map((f) => document.fonts.load(f))).catch(() => {}),
    audio.load().catch((e) => console.warn(`menu audio: ${e.message}`)),
  ]);
  // START on the title asks for the menu loop (SONG01 0, the drum beat) and the voice
  // (VOICE01 672) at once: fetch them now so they don't start seconds late.
  if (audio.ctx) for (const sound of [audio.songs[0], audio.voiceFiles[672]]) audio.buffer(sound).catch(() => {});
  const startAudio = () => audio.start();
  for (const ev of ['keydown', 'pointerdown']) addEventListener(ev, startAudio);
  const menu = new DreamcastMenu(exe, { title: true, box, cab, motions, audio: audio.ctx ? audio : null, save: loadSave(localStorage) });
  const canvas = document.createElement('canvas');
  canvas.id = 'menu';
  canvas.style.position = 'fixed';
  document.body.append(canvas);
  const view = new MenuView(canvas, ASSETS, manifest);
  const select = new SelectView(ASSETS);
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
  // The mod: Y puts Spidey in Axel's place on the driver select (or takes him out again);
  // deciding on that card starts the city with Spidey driving Axel's cab (?driver=spidey).
  const toggleSpidey = (e) => { if (e.code === 'KeyY' && !e.repeat) spidey = !spidey; };
  addEventListener('keydown', toggleSpidey);
  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('blur', () => { held = 0; });
  window.__menu = menu;   // for tests and probes
  window.__select = select;

  return new Promise((resolve) => {
    let last = performance.now(), acc = 0;
    function frame(now) {
      acc = Math.min(acc + now - last, STEP * 6);
      last = now;
      while (acc >= STEP) {
        acc -= STEP;
        const pad = held | padBits();   // the keyboard and an Xbox pad (src/input.js)
        if (pad) startAudio();   // a pad press starts the sound as a key does
        if (menu.update(menu.screen === 'title' && pad & PAD.A ? pad | PAD.START : pad)) continue;
        const city = menu.result && CITIES[menu.result.mode];
        if (city) {
          removeEventListener('resize', resize);
          removeEventListener('keydown', down);
          removeEventListener('keydown', toggleSpidey);
          removeEventListener('keyup', up);
          for (const ev of ['keydown', 'pointerdown']) removeEventListener(ev, startAudio);
          if (audio.ctx) audio.ctx.close();   // the city's own audio (src/main.js) takes over
          canvas.remove();
          resolve({ city, ...menu.result, spidey: spidey && menu.result.cab === SPIDEY_CAB });
          return;
        }
        // EXIT (back to the title) is handled inside the game's code; anything else
        // starts the menu over.
        if (menu.result) console.warn(`menu: ${MODES[menu.result.mode]} is not playable`);
        menu.init();
      }
      const suited = spidey && menu.screen === 'select' && menu.select().cab === SPIDEY_CAB;
      select.setSpidey(suited);
      if (suited) view.rename.set('AXEL', { text: 'SPIDEY', box: 'BDJOE' }); else view.rename.delete('AXEL');
      view.render(menu.draws, menu.screen === 'select' ? {
        background: menu.select().background,
        scene: select.render(menu.draws, menu.view(), menu.projection(), canvas.width, canvas.height),
      } : {});
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (!params.has('city')) {
    // ?menu=crazybox&game=N&cab=C: a Crazy Box game ended (NO in its TRY AGAIN window, or a clear) - back to the box screen.
    const box = params.get('menu') === 'crazybox' ? Math.min(15, Math.max(0, parseInt(params.get('game'), 10) || 0)) : undefined;
    const choice = await runMenu(box, parseInt(params.get('cab'), 10) || 0, params.get('driver') === 'spidey');
    const extra = choice.city === 'crazybox' ? `game=${choice.game}` : `rules=${choice.item}`;
    history.replaceState(null, '', `?city=${choice.city}&cab=${choice.cab}&${extra}${choice.spidey ? '&driver=spidey' : ''}`);
    status.style.display = '';
  }
  await import('./main.js');
}

boot().catch((e) => {
  console.error(e);
  status.style.display = '';
  status.textContent = `Failed: ${e.message}. Run tools/extract_all.py into local-assets/ first.`;
});
