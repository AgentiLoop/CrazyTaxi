import { PAD } from './dc-menu.js';

// Keyboard state. Dreamcast pad mapping (TaxiSW, docs/engine.md): R trigger
// accelerate, L trigger brake, B = Drive gear, A = Reverse gear, stick = steer.
const MAP = {
  ArrowUp: 'accel', KeyW: 'accel',
  ArrowDown: 'brake', KeyS: 'brake', Space: 'brake',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyX: 'drive',    // B button
  KeyZ: 'reverse',  // A button
  KeyR: 'reset',
  KeyP: 'pause',
};

// Xbox (W3C "standard" gamepad) buttons. The Dreamcast pad's A B X Y sit where the
// Xbox pad's do, so A is A and B is B; the triggers are the Dreamcast's analog L and R.
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9,
  LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};
const DEAD = 0.15;   // stick dead zone (worn sticks rest off centre); the game adds its own 0.04

/** The first connected standard-layout pad, or null. */
export function gamepad() {
  for (const p of globalThis.navigator?.getGamepads?.() ?? []) if (p?.connected && p.mapping === 'standard') return p;
  return null;
}

const axis = (v = 0) => Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD);
const value = (p, i) => p.buttons[i]?.value ?? 0;
const held = (p, i) => !!p.buttons[i]?.pressed;

/**
 * The pad as Dreamcast pad bits (PAD) for the menus and the TRY AGAIN window: D-pad or
 * left stick for the directions, A B X Y, Menu (≡) for START. 0 with no pad.
 */
export function padBits() {
  const p = gamepad();
  if (!p) return 0;
  const x = p.axes[0] ?? 0, y = p.axes[1] ?? 0;
  let bits = 0;
  if (held(p, BTN.UP) || y < -0.5) bits |= PAD.UP;
  if (held(p, BTN.DOWN) || y > 0.5) bits |= PAD.DOWN;
  if (held(p, BTN.LEFT) || x < -0.5) bits |= PAD.LEFT;
  if (held(p, BTN.RIGHT) || x > 0.5) bits |= PAD.RIGHT;
  if (held(p, BTN.A)) bits |= PAD.A;
  if (held(p, BTN.B)) bits |= PAD.B;
  if (held(p, BTN.X)) bits |= PAD.X;
  if (held(p, BTN.Y)) bits |= PAD.Y;
  if (held(p, BTN.MENU)) bits |= PAD.START;
  return bits;
}

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.pressed = new Set(); // rising edges since the last poll
    this.padHeld = new Set(); // the pad's actions down at the last poll
    target.addEventListener('keydown', (e) => {
      const k = MAP[e.code];
      if (!k) return;
      e.preventDefault();
      if (!this.down.has(k)) this.pressed.add(k);
      this.down.add(k);
    });
    target.addEventListener('keyup', (e) => {
      const k = MAP[e.code];
      if (k) this.down.delete(k);
    });
    target.addEventListener('blur', () => this.down.clear());
  }

  /**
   * Xbox pad in the cab: left stick (or D-pad) steers, RT accelerates, LT brakes (analog;
   * D-pad up / down digital), B or RB Drive gear, A or LB Reverse gear, Menu (≡) pause,
   * View reset, Y the hi-res pack (H). Returns null with no pad.
   */
  readPad() {
    const p = gamepad();
    if (!p) return null;
    const now = new Set();
    if (held(p, BTN.B) || held(p, BTN.RB)) now.add('drive');
    if (held(p, BTN.A) || held(p, BTN.LB)) now.add('reverse');
    if (held(p, BTN.MENU)) now.add('pause');
    if (held(p, BTN.VIEW)) now.add('reset');
    if (held(p, BTN.Y)) now.add('hires');
    const pressed = new Set([...now].filter((k) => !this.padHeld.has(k)));
    this.padHeld = now;
    const dpad = (held(p, BTN.RIGHT) ? 1 : 0) - (held(p, BTN.LEFT) ? 1 : 0);
    return {
      steer: dpad || axis(p.axes[0]),
      analog: !dpad,
      accel: Math.max(value(p, BTN.RT), held(p, BTN.UP) ? 1 : 0),
      brake: Math.max(value(p, BTN.LT), held(p, BTN.DOWN) ? 1 : 0),
      now, pressed,
    };
  }

  /** Steering -1..1, throttle/brake 0..1, and the buttons, then clears rising edges. */
  poll() {
    const d = this.down, p = this.pressed;
    const pad = this.readPad();
    if (pad?.pressed.has('hires')) dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH' }));
    const has = (k) => d.has(k) || !!pad?.now.has(k);
    const hit = (k) => p.has(k) || !!pad?.pressed.has(k);
    const keySteer = (d.has('right') ? 1 : 0) - (d.has('left') ? 1 : 0);
    const state = {
      // The keyboard wins while a key is down; the stick goes straight to the game.
      steer: keySteer || pad?.steer || 0,
      analog: !keySteer && !!pad?.analog,
      accel: Math.max(d.has('accel') ? 1 : 0, pad?.accel ?? 0),
      brake: Math.max(d.has('brake') ? 1 : 0, pad?.brake ?? 0),
      drive: has('drive'), reverse: has('reverse'),
      drivePressed: hit('drive'), reversePressed: hit('reverse'),
      resetPressed: hit('reset'), pausePressed: hit('pause'),
    };
    p.clear();
    return state;
  }
}
