// The driving HUD (DOM, drawn over the canvas): the clock, the cash, the
// customer's time bar, the destination (landmark picture + name, PutLandmark),
// the green arrow to the destination, the fare/rating card, "TIME UP" and the
// start countdown. Layout and colours are approximations of the Dreamcast HUD
// (its sprites in local-assets/sprites are not used yet).
import { formatMoney, RATING_NAMES, STATE_COUNTDOWN, STATE_TIME_UP } from './game.js';
import { RIDING } from './customers.js';

const LANDMARK_DIR = { 'LANDDC1.AFS': 'landmarks/LANDDC1/', 'LANDDC2.AFS': 'landmarks/LANDDC2/' };
const CARD_FRAMES = 150;

export class Hud {
  constructor(root, assets) {
    this.assets = assets;
    root.innerHTML = `
      <div id="hud-time"><span class="label">TIME</span><span id="hud-clock">0</span></div>
      <div id="hud-cash">$0.00</div>
      <div id="hud-bar"><div id="hud-bar-fill"></div></div>
      <div id="hud-dest" hidden><img id="hud-landmark" alt=""><div id="hud-dest-name"></div></div>
      <div id="hud-arrow" hidden>&#10148;</div>
      <div id="hud-card" hidden></div>
      <div id="hud-big" hidden></div>
      <div id="hud-debug"></div>`;
    this.el = Object.fromEntries(['clock', 'cash', 'bar', 'bar-fill', 'dest', 'landmark', 'dest-name', 'arrow', 'card', 'big', 'debug']
      .map((k) => [k, root.querySelector(`#hud-${k}`)]));
    this.cardTimer = 0;
    this.goTimer = 0;
    this.lastClock = null;
  }

  /** events = customers.events of this frame. */
  update(gs, customers, car, events, debugText) {
    const e = this.el;
    const secs = gs.seconds();
    if (secs !== this.lastClock) { e.clock.textContent = String(secs); this.lastClock = secs; }
    e.clock.classList.toggle('low', secs <= 10);
    e.cash.textContent = formatMoney(gs.cash);

    for (const ev of events) {
      if (ev.type === 'in') {
        const lm = ev.stop.landmark;
        e.landmark.src = this.assets + LANDMARK_DIR[lm.file] + String(lm.entry).padStart(2, '0') + '.png';
        e['dest-name'].textContent = lm.name;
        e.dest.hidden = false;
      } else if (ev.type === 'out') {
        const p = ev.paid;
        e.card.innerHTML = `<div class="rating r${ev.rating}">${RATING_NAMES[ev.rating]}</div>` +
          `<div>FARE ${formatMoney(p.fare)}</div><div>TIME ${formatMoney(p.timeMoney)}</div>` +
          (p.tips ? `<div>TIP ${formatMoney(p.tips)}</div>` : '') +
          `<div class="total">${formatMoney(p.total)}</div>` + (p.bonus ? `<div class="bonus">+${p.bonus / 60} sec</div>` : '');
        e.card.hidden = false;
        this.cardTimer = CARD_FRAMES;
        e.dest.hidden = true;
      } else if (ev.type === 'eject') {
        e.card.innerHTML = '<div class="rating r0">TOO SLOW</div>';
        e.card.hidden = false;
        this.cardTimer = CARD_FRAMES;
        e.dest.hidden = true;
      }
    }
    if (this.cardTimer > 0 && --this.cardTimer === 0) e.card.hidden = true;

    const riding = customers.rider && customers.rider.state === RIDING;
    e.bar.hidden = !riding;
    if (riding) {
      const frac = gs.customerTimeTotal ? gs.customerTime / gs.customerTimeTotal : 0;
      e['bar-fill'].style.width = `${(frac * 100).toFixed(1)}%`;
      e['bar-fill'].className = gs.customerTime >= gs.speedyLimit ? 'green' : gs.customerTime > gs.fastLimit ? 'yellow' : 'red';
      const bearing = customers.destinationBearing(car.pos);
      // Relative bearing: 0 = straight ahead; a positive turn of the game's heading
      // (toward +x from +z) is to the LEFT on screen in this right-handed world.
      let rel = bearing - car.heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      e.arrow.style.transform = `rotate(${(-90 - rel * 180 / Math.PI).toFixed(1)}deg)`;
      e.arrow.hidden = false;
    } else {
      e.arrow.hidden = true;
    }

    if (gs.state === STATE_COUNTDOWN) {
      const n = Math.ceil((gs.countdown - 60) / 60);
      e.big.textContent = gs.countdown > 60 ? (n <= 3 ? String(n) : 'READY') : 'GO!';
      e.big.hidden = false;
      this.goTimer = 60;   // "GO!" lingers a second into the run
    } else if (gs.state === STATE_TIME_UP) {
      e.big.innerHTML = gs.timeUpDone
        ? `TIME UP<div class="result">${formatMoney(gs.cash)}<br>${gs.customers} customer${gs.customers === 1 ? '' : 's'}<br><small>R to play again</small></div>`
        : 'TIME UP';
      e.big.hidden = false;
    } else if (this.goTimer > 0) {
      this.goTimer--;
    } else {
      e.big.hidden = true;
    }
    if (debugText !== undefined) e.debug.textContent = debugText;
  }
}

export const HUD_CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: "Arial Black", Impact, system-ui, sans-serif; color: #fff; text-shadow: 0 2px 2px #000, 0 0 6px #000; }
#hud-time { position: absolute; left: 24px; top: 16px; }
#hud-time .label { display: block; font-size: 16px; color: #ffe066; letter-spacing: 2px; }
#hud-clock { font-size: 64px; line-height: 1; color: #fff; }
#hud-clock.low { color: #ff5050; }
#hud-cash { position: absolute; right: 24px; top: 16px; font-size: 40px; color: #7cff7c; font-variant-numeric: tabular-nums; }
#hud-bar { position: absolute; left: 24px; top: 104px; width: 260px; height: 16px; background: rgba(0,0,0,.5); border: 2px solid #fff; border-radius: 4px; }
#hud-bar-fill { height: 100%; width: 100%; }
#hud-bar-fill.green { background: #30e030; } #hud-bar-fill.yellow { background: #f0d020; } #hud-bar-fill.red { background: #f03030; }
#hud-dest { position: absolute; right: 24px; top: 72px; width: 160px; text-align: center; font-size: 15px; }
#hud-landmark { width: 128px; height: 128px; image-rendering: pixelated; border: 2px solid #fff; background: #000; }
#hud-arrow { position: absolute; left: 50%; top: 24px; margin-left: -48px; font-size: 96px; line-height: 1; color: #30e030; transform-origin: 50% 50%; }
#hud-card { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; font-size: 26px; background: rgba(0,0,0,.55); padding: 14px 28px; border-radius: 10px; }
#hud-card .rating { font-size: 48px; } #hud-card .r2 { color: #30e030; } #hud-card .r1 { color: #f0d020; } #hud-card .r0 { color: #ff5050; }
#hud-card .total { font-size: 36px; color: #7cff7c; margin-top: 6px; } #hud-card .bonus { color: #ffe066; }
#hud-big { position: absolute; left: 50%; top: 35%; transform: translate(-50%, -50%); font-size: 96px; color: #ffe066; text-align: center; }
#hud-big .result { font-size: 32px; color: #fff; margin-top: 12px; } #hud-big small { font-size: 18px; color: #ccc; }
#hud-debug { position: absolute; left: 12px; bottom: 12px; font: 13px/1.4 system-ui, sans-serif; text-shadow: 0 1px 2px #000; white-space: pre; color: #ddd; }
`;
