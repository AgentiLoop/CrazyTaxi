// The driving HUD (DOM, drawn over the canvas): the clock, the TOTAL EARNED / FARE
// board (top right), the customer's time bar, the destination (landmark picture +
// name, PutLandmark), the fare/rating card, "TIME UP", the start countdown and the
// D / R gear box (bottom right), all read from the game's own GSystem and customer
// tasks (src/dc-car.js; the arrow to the destination is 3D, src/nav-arrow.js).
// Layout and colours are approximations of the Dreamcast HUD (of its sprites in
// local-assets/sprites only the gear box is used; the fare board's drums are DOM
// text); the clock (M'SS"hh, yellow, top left) and the customer's time (over the
// passenger in the cab, green / yellow / red by the rating still reachable) use the
// cartoon digits (src/cartoon-digits.js). Sizes are fractions of the 640 x 480
// picture's height (#hud is the whole window; cqh = 1% of its height), so the HUD
// keeps its 4:3 look in the corners of a wider window.
import { formatMoney } from './dc-car.js';
import { DIGITS_CSS, gameTimeText } from './cartoon-digits.js';
import { hiresLink } from './scene.js';

export const RATING_NAMES = ['NORMAL', 'FAST', 'SPEEDY'];
const LANDMARK_DIR = { 'LANDDC1.AFS': 'landmarks/LANDDC1/', 'LANDDC2.AFS': 'landmarks/LANDDC2/' };
const CARD_FRAMES = 150;
const GEAR_SPRITES = ['sprites/SPRCOMM/0018.png', 'sprites/SPRCOMM/0017.png'];   // [reverse, drive]

export class Hud {
  /** @param digits a loaded CartoonDigits */
  constructor(root, assets, digits) {
    this.assets = assets;
    this.digits = digits;
    root.innerHTML = `
      <div id="hud-time"><div id="hud-clock"><span id="hud-clock-main"></span><span id="hud-clock-sub"></span></div></div>
      <div id="hud-board">
        <div class="label">TOTAL EARNED</div><div class="box"><span class="dollar">$</span><span id="hud-cash">0.00</span></div>
        <div class="label">FARE</div><div class="box fare"><span class="dollar">$</span><span id="hud-fare">0.00</span></div>
      </div>
      <div id="hud-bar"><div id="hud-bar-fill"></div></div>
      <div id="hud-rider" hidden></div>
      <div id="hud-dest" hidden><img id="hud-landmark" alt=""><div id="hud-dest-name"></div></div>
      <div id="hud-card" hidden></div>
      <div id="hud-big" hidden></div>
      <img id="hud-gear" alt="">
      <div id="hud-debug"></div>`;
    this.el = Object.fromEntries(['clock', 'clock-main', 'clock-sub', 'cash', 'fare', 'bar', 'bar-fill', 'rider', 'dest', 'landmark', 'dest-name', 'card', 'big', 'gear', 'debug']
      .map((k) => [k, root.querySelector(`#hud-${k}`)]));
    this.cardTimer = 0;
    this.goTimer = 0;
    // The D / R gear box (Put_GearBox: SPRCOMM sprites 17 and 18 centred at 582, 420), the
    // pack's picture under ?hires=1 (the extracted PNGs are upside down: CSS flips them).
    this.gearSrc = GEAR_SPRITES.map((png) => assets + png);
    this.gear = -1;
    Promise.all(GEAR_SPRITES.map(hiresLink)).then((urls) => {
      if (!urls.every(Boolean)) return;
      this.gearSrc = urls;
      this.el.gear.classList.add('pack');
      this.gear = -1;
    });
  }

  /**
   * @param gs car.gameSystem()   @param rider car.rider()   @param stops the city's stops (manifest)
   * @param events car.events of the frames since the last draw   @param car the cab (position, heading)
   * @param riderAt where the passenger's head is on the picture ({ x, y } as fractions of it, or null)
   */
  update(gs, rider, stops, events, car, riderAt, debugText) {
    const e = this.el;
    const clock = gameTimeText(gs.time);
    this.digits.set(e['clock-main'], clock.main);
    this.digits.set(e['clock-sub'], clock.sub);
    e.clock.classList.toggle('low', gs.time <= 600);
    e.cash.textContent = formatMoney(gs.cash).slice(1);
    e.fare.textContent = formatMoney(gs.fare).slice(1);
    const gear = car.gear === 0 ? 0 : 1;
    if (gear !== this.gear) { this.gear = gear; e.gear.src = this.gearSrc[gear]; }

    for (const ev of events) {
      if (ev.type === 'in' && ev.customer) {
        const lm = stops[ev.customer.stop].landmark;
        const png = LANDMARK_DIR[lm.file] + String(lm.entry).padStart(2, '0') + '.png';
        e.landmark.src = this.assets + png;
        e.landmark.classList.remove('pack');
        hiresLink(png).then((url) => {   // ?hires=1: the texture pack's picture, if it has one
          if (url && e.landmark.src.endsWith(png)) { e.landmark.src = url; e.landmark.classList.add('pack'); }
        });
        e['dest-name'].textContent = lm.name;
        e.dest.hidden = false;
      } else if (ev.type === 'out') {
        e.card.innerHTML = `<div class="rating r${ev.rating}">${RATING_NAMES[ev.rating]}</div>` +
          `<div>FARE ${formatMoney(ev.fare)}</div><div>TIME ${formatMoney(ev.timeMoney)}</div>` +
          (ev.tips ? `<div>TIP ${formatMoney(ev.tips)}</div>` : '') +
          `<div class="total">${formatMoney(ev.total)}</div>` + (ev.bonus ? `<div class="bonus">+${ev.bonus / 60} sec</div>` : '');
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

    e.bar.hidden = !gs.aboard;
    if (gs.aboard) {
      const frac = gs.customerTimeTotal ? gs.customerTime / gs.customerTimeTotal : 0;
      e['bar-fill'].style.width = `${(Math.max(0, frac) * 100).toFixed(1)}%`;
      e['bar-fill'].className = gs.customerTime >= gs.speedyLimit ? 'green' : gs.customerTime > gs.fastLimit ? 'yellow' : 'red';
    }
    // The customer's seconds over their head in the cab, coloured by the rating still reachable.
    if (gs.aboard && riderAt) {
      this.digits.set(e.rider, String(Math.max(0, Math.ceil(gs.customerTime / 60))));
      e.rider.className = gs.customerTime >= gs.speedyLimit ? 'green' : gs.customerTime > gs.fastLimit ? 'yellow' : 'red';
      e.rider.style.left = `${(riderAt.x * 100).toFixed(2)}%`;
      e.rider.style.top = `${(riderAt.y * 100).toFixed(2)}%`;
      e.rider.hidden = false;
    } else {
      e.rider.hidden = true;
    }

    if (gs.state === 0) {
      const n = Math.ceil((gs.counter - 60) / 60);
      e.big.textContent = gs.counter > 60 ? (n <= 3 ? String(n) : 'READY') : 'GO!';
      e.big.hidden = false;
      this.goTimer = 60;   // "GO!" lingers a second into the run
    } else if (gs.state === 2) {
      e.big.innerHTML = gs.counter < 0
        ? `TIME UP<div class="result">${formatMoney(gs.cash)}<br>${gs.delivered} customer${gs.delivered === 1 ? '' : 's'}<br><small>R to play again</small></div>`
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

export const HUD_CSS = DIGITS_CSS + `
#hud { position: fixed; inset: 0; pointer-events: none; container-type: size; font-family: "Arial Black", Impact, system-ui, sans-serif; color: #fff; text-shadow: 0 0.2cqh 0.2cqh #000, 0 0 0.6cqh #000; }
#hud-time { position: absolute; left: 2.5cqh; top: 1.67cqh; text-shadow: none; }
#hud-clock { font-size: 7.5cqh; line-height: 1; color: #ffe81e; white-space: nowrap; }
#hud-clock-main .cd + .cd { margin-left: -0.04em; }
#hud-clock-sub { font-size: 0.6em; margin-left: 0.08em; vertical-align: bottom; }
#hud-clock.low { color: #ff4040; }
#hud-rider { position: absolute; font-size: 4.6cqh; line-height: 1; color: #44e044; white-space: nowrap; transform: translate(-50%, -100%); text-shadow: none; }
#hud-rider .cd + .cd { margin-left: -0.04em; }
#hud-rider.yellow { color: #ffe81e; } #hud-rider.red { color: #ff4040; }
/* The fare board (hudDrawFareFrame: around 532, 96): the cash and the fare on white drums. */
#hud-board { position: absolute; right: 5.87cqh; top: 6.5%; width: 38.67cqh; text-align: center; }
#hud-board .label { font-size: 3.4cqh; line-height: 1.2; font-style: italic; letter-spacing: 0.06em; color: #fff; -webkit-text-stroke: 0.5px #b01818; text-shadow: 0 1px 1px #000, 0 0 3px #000; }
#hud-board .box { display: flex; align-items: baseline; margin: 0.3cqh 0 0.6cqh; padding: 0 1.2cqh; background: #fff; border: 0.4cqh solid #2a3b6e; border-radius: 0.8cqh; box-shadow: 0 0.4cqh 0.6cqh rgba(0,0,0,.5); color: #1c2a80; font-size: 3.8cqh; line-height: 1.25; text-shadow: none; font-variant-numeric: tabular-nums; }
#hud-board .box .dollar { color: #2a3b6e; margin-right: auto; }
#hud-board .box.fare { margin-left: 10%; font-size: 5.4cqh; }
#hud-bar { position: absolute; left: 2.5cqh; top: 10.83cqh; width: 27cqh; height: 1.67cqh; background: rgba(0,0,0,.5); border: 0.2cqh solid #fff; border-radius: 0.4cqh; }
#hud-bar-fill { height: 100%; width: 100%; }
#hud-bar-fill.green { background: #30e030; } #hud-bar-fill.yellow { background: #f0d020; } #hud-bar-fill.red { background: #f03030; }
#hud-dest { position: absolute; right: 5.87cqh; top: 33%; width: 16.67cqh; text-align: center; font-size: 1.56cqh; }
#hud-landmark { width: 13.33cqh; height: 13.33cqh; image-rendering: pixelated; border: 0.2cqh solid #fff; background: #000; }
#hud-landmark.pack { image-rendering: auto; transform: scaleY(-1); }  /* the extracted landmark PNGs are upright (sky on top), the pack's are stored upside down */
/* The gear box: a 64 x 64 sprite centred at (582, 420) of 640 x 480. */
#hud-gear { position: absolute; right: 12.08cqh; top: 87.5%; width: 13.33cqh; height: 13.33cqh; transform: translate(50%, -50%) scaleY(-1); image-rendering: pixelated; }
#hud-gear.pack { transform: translate(50%, -50%); image-rendering: auto; }
#hud-card { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; font-size: 2.7cqh; background: rgba(0,0,0,.55); padding: 1.46cqh 2.92cqh; border-radius: 1.04cqh; }
#hud-card .rating { font-size: 5cqh; } #hud-card .r2 { color: #30e030; } #hud-card .r1 { color: #f0d020; } #hud-card .r0 { color: #ff5050; }
#hud-card .total { font-size: 3.75cqh; color: #7cff7c; margin-top: 0.63cqh; } #hud-card .bonus { color: #ffe066; }
#hud-big { position: absolute; left: 50%; top: 35%; transform: translate(-50%, -50%); font-size: 10cqh; color: #ffe066; text-align: center; }
#hud-big .result { font-size: 3.33cqh; color: #fff; margin-top: 1.25cqh; } #hud-big small { font-size: 1.88cqh; color: #ccc; }
#hud-debug { position: absolute; left: 12px; bottom: 12px; font: 13px/1.4 system-ui, sans-serif; text-shadow: 0 1px 2px #000; white-space: pre; color: #ddd; }
`;
