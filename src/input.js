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

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.pressed = new Set(); // rising edges since the last poll
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

  /** Steering -1..1, throttle/brake 0..1, and the buttons, then clears rising edges. */
  poll() {
    const d = this.down, p = this.pressed;
    const state = {
      steer: (d.has('right') ? 1 : 0) - (d.has('left') ? 1 : 0),
      accel: d.has('accel') ? 1 : 0,
      brake: d.has('brake') ? 1 : 0,
      drive: d.has('drive'), reverse: d.has('reverse'),
      drivePressed: p.has('drive'), reversePressed: p.has('reverse'),
      resetPressed: p.has('reset'), pausePressed: p.has('pause'),
    };
    p.clear();
    return state;
  }
}
