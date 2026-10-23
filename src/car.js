// The player's cab: an arcade driving model over the game's own collision
// (src/collision.js). Pure JS so node tests can drive it.
//
// What is the game's: the start spot and heading (src/start.js), the ground
// lookup under each wheel, the wall push, and the out-of-world recovery onto the
// nearest stage course point lifted by 30 (carGroundCheck, docs/engine.md). The
// speeds, accelerations and grip below are placeholders until exec_CarMain /
// carCalcInertia are ported; they are tuned so the cab (about 54 units long,
// 1 unit ~ 9 cm) drives like the arcade: top speed ~ 190 km/h, 0-100 km/h in ~3 s.

export const STEP = 1 / 60;
const UNITS_PER_METRE = 11;
const G = 9.81 * UNITS_PER_METRE;

// Wheel contact points in the car's axes (+z forward), from cab_0.glb.
export const WHEELS = [
  { x: 6.9, z: 15.5, front: true },
  { x: -6.9, z: 15.5, front: true },
  { x: 6.5, z: -15.5, front: false },
  { x: -6.5, z: -15.5, front: false },
];
const WHEELBASE = 31;
const TRACK = 13.4;
export const WHEEL_RADIUS = 2.964;
const BODY_RADIUS = 10;      // wall test radius at each axle
const WHEEL_REACH = 6;       // how far above the wheel the ground may be found
const RECOVERY_LIFT = 30;
const HOLD_INPUT = { steer: 0, accel: 0, brake: 1, drive: false, reverse: false, drivePressed: false, reversePressed: false };

const TUNE = {
  topSpeed: 190 / 3.6 * UNITS_PER_METRE,      // ~580 u/s
  reverseSpeed: 50 / 3.6 * UNITS_PER_METRE,
  accel: 9.5 * UNITS_PER_METRE,
  brake: 22 * UNITS_PER_METRE,
  engineBrake: 2.5 * UNITS_PER_METRE,
  drag: 0.0028,                               // per unit speed, per second
  maxSteer: 0.62,                             // rad at rest
  steerRate: 5.5,                             // rad/s of steering wheel travel
  grip: 7,                                    // how fast velocity follows the heading (1/s)
  wallRestitution: 0.35,
};

export class Car {
  /**
   * @param {import('./collision.js').Collision} collision
   * @param {number[][]} recoveryPoints stage course points for the out-of-world reset
   */
  constructor(collision, recoveryPoints = []) {
    this.collision = collision;
    this.recoveryPoints = recoveryPoints;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.steer = 0;          // current wheel angle, rad
    this.gear = 1;           // 0 reverse, 1 drive (carGearbox keeps 0 or 1-5)
    this.speed = 0;          // along the heading, signed
    this.onGround = true;
    this.groundKind = -1;
    this.wheelSpin = 0;
    this.yawRate = 0;        // heading change per step (the game's (short)+0x198)
    this.hold = false;       // Car_Data +0x58: a customer is getting in or out
    this.lastWall = null;
    this.recoveries = 0;
  }

  place(start) {
    this.pos.x = start.x; this.pos.y = start.y; this.pos.z = start.z;
    this.heading = start.heading;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.speed = 0;
    this.steer = 0;
    this.pitch = this.roll = 0;
    this.gear = 1;
    this.settle();
  }

  forward() {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  /** Ground under a wheel, in world space. */
  wheelGround(w) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const x = this.pos.x + w.x * c + w.z * s;
    const z = this.pos.z - w.x * s + w.z * c;
    return this.collision.groundAt(x, this.pos.y + WHEEL_REACH, z, 1);
  }

  /** Put the car on the ground under its wheels (no motion). */
  settle() {
    const hs = WHEELS.map((w) => this.wheelGround(w));
    if (hs.every((h) => h)) this.pos.y = hs.reduce((a, h) => a + h.y, 0) / 4;
    this.fitToGround(hs);
  }

  fitToGround(hs) {
    if (!hs.every((h) => h)) return;
    const front = (hs[0].y + hs[1].y) / 2, rear = (hs[2].y + hs[3].y) / 2;
    const right = (hs[0].y + hs[2].y) / 2, left = (hs[1].y + hs[3].y) / 2;
    this.pitch = Math.atan2(rear - front, WHEELBASE);
    this.roll = Math.atan2(right - left, TRACK);
    this.groundKind = hs[2].kind;
  }

  /** One 60 Hz step. input: { steer, accel, brake, drive, reverse, drivePressed, reversePressed }. */
  update(input) {
    const dt = STEP;
    if (this.hold) input = HOLD_INPUT;
    const heading0 = this.heading;

    // Gearbox (carGearbox): A held = reverse, B pressed = drive.
    if (input.reverse) this.gear = 0;
    else if (input.drivePressed || (input.drive && this.gear === 0)) this.gear = 1;

    // Steering wheel moves toward the stick, less lock at speed.
    const lock = TUNE.maxSteer / (1 + Math.abs(this.speed) / 120);
    const target = input.steer * lock;
    const d = target - this.steer;
    const maxMove = TUNE.steerRate * dt;
    this.steer += Math.abs(d) <= maxMove ? d : Math.sign(d) * maxMove;

    // Longitudinal.
    let a = 0;
    if (this.onGround) {
      const dir = this.gear === 0 ? -1 : 1;
      if (input.accel) a += dir * TUNE.accel;
      if (input.brake) a -= Math.sign(this.speed || dir) * TUNE.brake;
      if (!input.accel && !input.brake) a -= Math.sign(this.speed) * Math.min(TUNE.engineBrake, Math.abs(this.speed) / dt);
      a -= TUNE.drag * this.speed * Math.abs(this.speed) / 10;
    }
    let speed = this.speed + a * dt;
    if (input.brake && !input.accel && Math.sign(speed) !== Math.sign(this.speed)) speed = 0;
    if (this.hold) speed = 0;
    const top = this.gear === 0 ? TUNE.reverseSpeed : TUNE.topSpeed;
    speed = Math.max(-TUNE.reverseSpeed, Math.min(top, speed));
    this.speed = speed;

    // Yaw from the bicycle model (rear-axle pivot).
    if (this.onGround && Math.abs(speed) > 0.5) {
      this.heading += speed / WHEELBASE * Math.tan(this.steer) * dt;
    }
    this.heading = ((this.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let dh = this.heading - heading0;
    if (dh > Math.PI) dh -= Math.PI * 2; else if (dh < -Math.PI) dh += Math.PI * 2;
    this.yawRate = dh;

    // Horizontal velocity follows the heading with finite grip (a little slide).
    const f = this.forward();
    const want = { x: f.x * speed, z: f.z * speed };
    if (this.onGround) {
      const k = Math.min(1, TUNE.grip * dt);
      this.vel.x += (want.x - this.vel.x) * k;
      this.vel.z += (want.z - this.vel.z) * k;
    }
    this.vel.y -= G * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    // Walls at both axles (CheckColliWall).
    this.lastWall = null;
    for (const zOff of [15.5, -15.5]) {
      const p = { x: this.pos.x + f.x * zOff, y: this.pos.y + 3, z: this.pos.z + f.z * zOff };
      const hit = this.collision.pushOutOfWalls(p, BODY_RADIUS);
      if (!hit) continue;
      this.pos.x = p.x - f.x * zOff;
      this.pos.z = p.z - f.z * zOff;
      const into = this.vel.x * hit.x + this.vel.z * hit.z;
      if (into < 0) {
        this.vel.x -= (1 + TUNE.wallRestitution) * into * hit.x;
        this.vel.z -= (1 + TUNE.wallRestitution) * into * hit.z;
        const along = this.vel.x * f.x + this.vel.z * f.z;
        this.speed = Math.sign(this.speed) * Math.min(Math.abs(this.speed), Math.abs(along));
        this.lastWall = hit;
      }
    }

    // Ground under the four wheels.
    const hs = WHEELS.map((w) => this.wheelGround(w));
    const found = hs.filter((h) => h);
    if (found.length === 0) {
      this.recover();
      this.onGround = false;
    } else {
      const groundY = found.reduce((s, h) => s + h.y, 0) / found.length;
      if (this.pos.y <= groundY + 0.05 || this.vel.y <= 0 && this.pos.y - groundY < 1.5) {
        this.pos.y = groundY;
        this.vel.y = 0;
        this.onGround = true;
        this.fitToGround(hs);
      } else {
        this.onGround = false;
      }
    }

    this.wheelSpin += this.speed / WHEEL_RADIUS * dt;
  }

  /** carGroundCheck's recovery: nearest stage course point, lifted by 30, at rest. */
  recover() {
    let best = null, bd = Infinity;
    for (const p of this.recoveryPoints) {
      const dx = p[0] - this.pos.x, dy = p[1] - this.pos.y, dz = p[2] - this.pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    this.pos.x = best[0]; this.pos.y = best[1] + RECOVERY_LIFT; this.pos.z = best[2];
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.speed = 0;
    this.recoveries++;
  }

  /** km/h for the HUD. */
  kmh() {
    return Math.abs(this.speed) / UNITS_PER_METRE * 3.6;
  }
}
