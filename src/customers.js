// Customers: who stands where, when they appear, when they get in and when they
// are delivered. A port of the rules in exec_KyakuMain / kyakuTaskStart /
// kyakuTaskExec (decomp src/gen_ji.c, gen_as.c, gen_ls.c; docs/engine.md) over the
// extracted customer tables (local-assets/customers/manifest.json). Pure JS.
//
// Customer records (40 bytes in the exe): a spot, the nearest course-0 point
// (line index), three destination stops with their route lengths.
// exec_KyakuMain, every frame, for every idle record: with d = carLine - line
// wrapped into (-N/2, N/2], the customer appears when d < 8 (never more than 7
// points behind the cab) and the spot is nearer than 1100 (Original: 700).
// kyakuTaskStart picks destinations[(kyakuFrame / 600) % 3] and the customer's
// "k" = clamp((route - 2000) / 17000, 0, 1): it shrinks the pick-up circle
// (100 - 60k, MakeKyakuTakeArea) and the pick-up distance (130 - 60k).
// kyakuTaskExec phase 1: the cab stops for them when the spot is within 500 and
// within 130 - 60k, |speed| <= 0.15 units/frame and the heights differ by < 50.
// Phase 2: delivered when inside the destination stop's drop radius with
// |speed| <= 0.15 and a yaw rate under 16/65536 of a turn per frame; the customer
// time reaching 0 ejects them (GS_GuestEject).

export const SPAWN_DIST = { arcade: 1100, original: 700 };     // 0x0C179820
export const DESPAWN_DIST = { arcade: 1200, original: 750 };   // 0x0C179824
export const LINE_WINDOW = 8;
export const DEST_PERIOD = 600;
export const PICKUP_MAX = 500;
export const PICKUP_NEAR = 130;
export const PICKUP_SHRINK = 60;
export const PICKUP_HEIGHT = 50;
export const CIRCLE_RADIUS = 100;
export const CIRCLE_SHRINK = 60;
export const STOP_SPEED = 0.15;                 // units per frame
export const STOP_YAW = 16 * Math.PI * 2 / 65536; // radians per frame
export const BOARD_FRAMES = 90;                 // the get-in / get-out cut (placeholder length)
export const K_FAR = 2000;
export const K_SPAN = 17000;

export const IDLE = 0, WAITING = 1, BOARDING = 2, RIDING = 3, LEAVING = 4, DONE = 5;

/** Nearest course-0 point to pos; hint = the previous answer to keep the search short. */
export function nearestLineIndex(points, pos, hint = -1, window = 12) {
  let best = -1, bd = Infinity;
  const test = (i) => {
    const p = points[i];
    const dx = p[0] - pos.x, dz = p[2] - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  };
  const n = points.length;
  if (hint >= 0) {
    for (let k = -window; k <= window; k++) test(((hint + k) % n + n) % n);
    // Accept the local answer unless it drifted far (a recovery jump).
    if (bd < 400 * 400) return best;
  }
  for (let i = 0; i < n; i++) test(i);
  return best;
}

export function customerK(route) {
  return Math.min(1, Math.max(0, (route - K_FAR) / K_SPAN));
}

export class Customers {
  /**
   * @param {object} set customer_sets entry (manifest.json)
   * @param {object} stops stop_sets entry
   * @param {number[][]} line course 0's points (for the line window)
   * @param {'arcade'|'original'} city
   */
  constructor(set, stops, line, city = 'arcade') {
    this.city = city;
    this.line = line;
    this.stops = stops.stops;
    this.spawnDist = SPAWN_DIST[city];
    this.despawnDist = DESPAWN_DIST[city];
    this.records = set.customers.map((c) => ({
      index: c.index, kind: c.kind, character: c.character,
      pos: { x: c.position[0], y: c.position[1], z: c.position[2] },
      line: c.line_index_in_file,
      destinations: c.destinations, routes: c.route_lengths_in_file,
      state: IDLE, k: 0, dest: -1, route: 0, timer: 0, rating: -1,
    }));
    this.frame = 0;          // 0x0C1794EC
    this.rider = null;       // the record in the cab
    this.events = [];        // what happened this frame, for the HUD/scene
    this.carLine = -1;
  }

  /** @param car { pos, speed (units/frame), yawRate (rad/frame) }, gs = GameSystem */
  update(car, gs) {
    this.events.length = 0;
    this.carLine = nearestLineIndex(this.line, car.pos, this.carLine);
    const n = this.line.length;
    for (const r of this.records) {
      const dx = r.pos.x - car.pos.x, dz = r.pos.z - car.pos.z;
      const dist = Math.hypot(dx, dz);
      switch (r.state) {
        case IDLE: {
          if (this.rider) break;
          let d = this.carLine - r.line;
          if (d > n >> 1) d -= n;
          else if (d < -(n >> 1)) d += n;
          if (d < LINE_WINDOW && dist < this.spawnDist) this.spawn(r);
          break;
        }
        case WAITING: {
          if (dist > this.despawnDist) { r.state = IDLE; this.events.push({ type: 'despawn', record: r }); break; }
          if (this.rider || gs.state !== 1) break;
          const near = PICKUP_NEAR - PICKUP_SHRINK * r.k;
          if (dist < PICKUP_MAX && dist < near && Math.abs(car.speed) <= STOP_SPEED &&
              Math.abs(r.pos.y - car.pos.y) < PICKUP_HEIGHT) {
            r.state = BOARDING;
            r.timer = BOARD_FRAMES;
            this.rider = r;
            this.events.push({ type: 'stop', record: r });
          }
          break;
        }
        case BOARDING: {
          if (--r.timer <= 0) {
            r.state = RIDING;
            gs.guestIn(r.route);
            this.events.push({ type: 'in', record: r, stop: this.stops[r.dest] });
          }
          break;
        }
        case RIDING: {
          if (gs.customerTime <= 0) {
            gs.guestEject();
            r.state = LEAVING; r.timer = BOARD_FRAMES; r.rating = -1;
            r.pos = { ...car.pos };
            this.events.push({ type: 'eject', record: r });
            break;
          }
          const s = this.stops[r.dest];
          const sx = s.centre[0] - car.pos.x, sz = s.centre[2] - car.pos.z;
          if (Math.hypot(sx, sz) < s.radius && Math.abs(car.speed) <= STOP_SPEED && Math.abs(car.yawRate) < STOP_YAW) {
            r.rating = gs.guestOut();
            r.state = LEAVING; r.timer = BOARD_FRAMES;
            r.pos = { ...car.pos };
            this.events.push({ type: 'out', record: r, rating: r.rating, paid: gs.paid });
          }
          break;
        }
        case LEAVING: {
          if (--r.timer <= 0) {
            r.state = DONE;
            this.rider = null;
            this.events.push({ type: 'gone', record: r });
          }
          break;
        }
        default: break;
      }
    }
    this.frame++;
  }

  spawn(r) {
    const slot = Math.trunc(this.frame / DEST_PERIOD) % 3;
    const dest = r.destinations[slot];
    if (dest < 0 || !this.stops[dest]) return;   // no stop in this slot (assumed: not shown)
    r.dest = dest;
    r.route = r.routes[slot];
    r.k = customerK(r.route);
    r.state = WAITING;
    r.rating = -1;
    this.events.push({ type: 'spawn', record: r });
  }

  /** The cab is held while a customer gets in or out. */
  get holding() {
    return !!this.rider && (this.rider.state === BOARDING || this.rider.state === LEAVING);
  }

  circleRadius(r) { return CIRCLE_RADIUS - CIRCLE_SHRINK * r.k; }

  /** Bearing from the cab to the rider's stop, in the game's heading sense (forward = (sin h, cos h)). */
  destinationBearing(carPos) {
    if (!this.rider || this.rider.state !== RIDING) return null;
    const c = this.stops[this.rider.dest].centre;
    return Math.atan2(c[0] - carPos.x, c[2] - carPos.z);
  }
}
