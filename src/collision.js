// Course collision: a port of the game's GetCollision2D and CheckColliWall
// (decomp src/collide.c) over the JSON tools/extract_collision.py writes.
// Pure JS, no three.js, so node tests can run it.

const FLT_MAX = 3.4028234663852886e38;

// Surface row: [a, b, c, d, radius, c0, c1, c2, c3, kind, shape] (corners are [x, y, z]).
const S_A = 0, S_B = 1, S_C = 2, S_D = 3, S_RADIUS = 4, S_CORNER = 5, S_KIND = 9, S_SHAPE = 10;
// Wall row: [a, b, end_x, end_z, d, top, bottom, length].
const W_A = 0, W_B = 1, W_EX = 2, W_EZ = 3, W_D = 4, W_TOP = 5, W_BOTTOM = 6, W_LENGTH = 7;
// Pole row: [x, z, radius, top, bottom].
const P_X = 0, P_Z = 1, P_RADIUS = 2, P_TOP = 3, P_BOTTOM = 4;

export const KIND_NAMES = [
  '#road', '#rokata', '#kabe', '#grass', '#shougai', '#water', '#ikenai', '#puddle',
  '#tuti', '#suna', '#hodou', '#rock', '#jump', '#slope', '#sea', '#ice', '#high_road',
  '#tosub_slop', '#sub_slope', '#tosub_hodo', '#sub_hodou', '#sub_road',
];

/** GetCollision2DHeight: is (x, z) over surface e, and at what height? */
export function surfaceHeight(x, z, e) {
  const c0 = e[S_CORNER], c1 = e[S_CORNER + 1], c2 = e[S_CORNER + 2], c3 = e[S_CORNER + 3];
  const dx0 = c0[0] - x, dz0 = c0[2] - z;
  if (dz0 * dz0 + dx0 * dx0 > e[S_RADIUS] * e[S_RADIUS]) return null;
  const dx1 = c1[0] - x, dz1 = c1[2] - z;
  let fx, fz;
  if (e[S_SHAPE] === 3) {
    fx = dx1; fz = dz1;
  } else {
    if (0 > dx0 * dz1 - dz0 * dx1) return null;
    fx = dx0; fz = dz0;
  }
  const dx2 = c2[0] - x, dz2 = c2[2] - z;
  if (0 > dx1 * dz2 - dz1 * dx2) return null;
  const dx3 = c3[0] - x, dz3 = c3[2] - z;
  if (0 > dz3 * dx2 - dx3 * dz2) return null;
  if (0 > fz * dx3 - fx * dz3) return null;
  return (-(e[S_A] * x) - e[S_C] * z - e[S_D]) / e[S_B];
}

class Grid {
  constructor(header, cells) {
    this.x0 = header.x0;
    this.z0 = header.z0;
    this.columns = header.columns;
    this.count = header.cells;
    this.size = header.size;
    this.cells = new Map();
    for (const c of cells) this.cells.set(c[0], c);
  }

  cellAt(x, z) {
    const cx = Math.floor(x / this.size) - this.x0;
    const cz = Math.floor(z / this.size) - this.z0;
    const idx = cz * this.columns + cx;
    if (idx < 0 || idx >= this.count) return null;
    return this.cells.get(idx) || null;
  }
}

export class Collision {
  /** @param {object} json one run of extract_collision.py (arcade.json, original.json, ...) */
  constructor(json) {
    this.city = json.city;
    this.surfaces = json.ground.surfaces;
    this.ground = new Grid(json.ground.header, json.ground.cells);
    this.walls = json.walls.walls;
    this.poles = json.walls.poles;
    this.wallGrid = new Grid(json.walls.header, json.walls.cells);
    this._hts = [];
    this._ents = [];
  }

  /**
   * GetCollision2D: the ground under (x, y, z). `tol` is how far above the best
   * floor a higher surface may still be taken. Returns null when nothing is
   * there, else { y, nx, ny, nz, kind }.
   */
  groundAt(x, y, z, tol = 0) {
    const cell = this.ground.cellAt(x, z);
    if (!cell) return null;
    const list = cell[4];
    const hts = this._hts, ents = this._ents;
    let hbelow = -FLT_MAX, hlow = FLT_MAX, best = -1, belowi = 0, k = 0;
    for (let i = 0; i < list.length; i++) {
      const e = this.surfaces[list[i]];
      if (e[S_KIND] === 13) continue;
      const h = surfaceHeight(x, z, e);
      if (h === null) continue;
      if (h > hbelow) {
        if (!(h > y)) { hbelow = h; belowi = k; }
        if (hlow > h) { best = k; hlow = h; }
        ents[k] = e;
        hts[k] = h;
        k++;
      }
    }
    if (k === 0) return null;
    if (hlow > hbelow) {
      belowi = best;
    } else {
      best = belowi;
      hlow = y;
    }
    for (;;) {
      for (let j = k - 1; j >= 0; j--) {
        if (hts[j] > hlow && !(hts[j] > tol + hlow)) { best = j; hlow = hts[j]; }
      }
      if (best === belowi) break;
      belowi = best;
    }
    const e = ents[best];
    return { y: hts[best], nx: e[S_A], ny: e[S_B], nz: e[S_C], kind: e[S_KIND] };
  }

  /** CheckColliWallSegment. Fills q (t, px, pz); returns 0, 1 or 2. */
  _segment(q, w) {
    const y = q.y;
    if (y > w[W_TOP]) return 0;
    if (w[W_BOTTOM] - q.radius > y) return 0;
    const x = q.x, z = q.z;
    const dist = w[W_B] * z + x * w[W_A] + w[W_D];
    const R = q.radius;
    const along = (w[W_EX] - x) * w[W_B] - (w[W_EZ] - z) * w[W_A];
    if (!(R > dist)) return 0;
    if (!(dist > -R)) return 0;
    if (0 > along) {
      if (!(along > -R)) return 0;
      const dx = x - w[W_EX], dz = z - w[W_EZ];
      const d = Math.sqrt(dz * dz + dx * dx);
      if (!(R > d)) return 0;
      const inv = 1 / d;
      q.t = R - d;
      q.px = inv * dx;
      q.pz = inv * dz;
      return 2;
    }
    if (!(w[W_LENGTH] > along)) return 0;
    q.px = w[W_A];
    q.pz = w[W_B];
    q.t = R - dist;
    return 1;
  }

  /** CheckColliWallPole. */
  _pole(q, p) {
    const y = q.y;
    if (y > p[P_TOP]) return 0;
    if (p[P_BOTTOM] - q.radius > y) return 0;
    const dx = q.x - p[P_X], dz = q.z - p[P_Z];
    const d = Math.sqrt(dz * dz + dx * dx);
    if (!(q.radius + p[P_RADIUS] > d)) return 0;
    const inv = 1 / d;
    q.px = inv * dx;
    q.pz = inv * dz;
    q.t = q.radius + p[P_RADIUS] - d;
    return 2;
  }

  /**
   * CheckColliWall: push pos ({x, y, z}, changed in place) out of the walls and
   * poles of its cell. Returns the wall normal it pushed along, or null.
   */
  pushOutOfWalls(pos, radius) {
    const cell = this.wallGrid.cellAt(pos.x, pos.z);
    if (!cell) return null;
    const q = { x: pos.x, y: pos.y, z: pos.z, radius, t: 0, px: 0, pz: 0 };
    let inner = -FLT_MAX, outer = FLT_MAX, third = FLT_MAX;
    let nearX = 0, nearZ = 0, farX = 0, farZ = 0, otherX = 0, otherZ = 0;
    const walls = cell[1];
    for (let i = 0; i < walls.length; i++) {
      const res = this._segment(q, this.walls[walls[i]]);
      if (res === 1) {
        if (q.t > radius) {
          if (outer > q.t) { farX = q.px; farZ = q.pz; outer = q.t; }
        } else if (q.t > inner) {
          nearX = q.px; nearZ = q.pz; inner = q.t;
        }
      } else if (res === 2) {
        if (third > q.t) { otherX = q.px; otherZ = q.pz; third = q.t; }
      }
    }
    let hit = null;
    if (inner > 0) {
      pos.x += inner * nearX; pos.z += inner * nearZ;
      hit = { x: nearX, z: nearZ, depth: inner };
    } else if (2 * radius > outer) {
      pos.x += outer * farX; pos.z += outer * farZ;
      hit = { x: farX, z: farZ, depth: outer };
    } else if (radius > third) {
      pos.x += third * otherX; pos.z += third * otherZ;
      hit = { x: otherX, z: otherZ, depth: third };
    }
    q.x = pos.x; q.z = pos.z; // the game's q.pos points at pos itself
    const poles = cell[2];
    for (let i = 0; i < poles.length; i++) {
      if (this._pole(q, this.poles[poles[i]])) {
        pos.x += q.t * q.px; pos.z += q.t * q.pz;
        return { x: q.px, z: q.pz, depth: q.t };
      }
    }
    return hit;
  }
}
