// A map of the whole city in the bottom-left corner (not in the game: its only course map,
// goiToolCourseMap, is a developer tool). The roads are the run's traffic lanes (the "stage"
// courses and the main line of courses/<city>.json, tools/extract_courses.py), seen from above
// with north (-z) up; the cab is a yellow triangle along its heading, the destination of the
// customer aboard a green dot, and the shortest way there along the roads a green line. The
// roads are drawn once; each frame redraws only the marks.

const SIZE = 30;   // cqh: the map's side as a fraction of the picture's height
const PAD = 0.04;  // of the side, around the city

/** The scale and offset that fit the points' x / z bounds into a square of side `side`. */
export function fitView(points, side) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, , z] of points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const inner = side * (1 - 2 * PAD);
  const scale = inner / Math.max(x1 - x0, z1 - z0);
  return {
    scale,
    ox: (side - (x1 - x0) * scale) / 2 - x0 * scale,
    oz: (side - (z1 - z0) * scale) / 2 - z0 * scale,
  };
}

/** The roads as a graph: every point of the stage courses, joined along each course and from its
 *  end to the start of its next and branch courses and at both ends to its neighbour lane (both
 *  ways: the cab may drive against traffic). */
export function roadGraph(courses) {
  const F = courses.course_fields;
  const [IDX, ROLE, NEXT, BRANCH, NEIGHBOUR, PTS] =
    ['index', 'role', 'next', 'branch', 'neighbour', 'points'].map((f) => F.indexOf(f));
  const stages = courses.courses.filter((c) => c[ROLE] === 'stage');
  const pts = [], first = new Map(), last = new Map();
  for (const c of stages) {
    first.set(c[IDX], pts.length);
    for (const p of c[PTS]) pts.push(p);
    last.set(c[IDX], pts.length - 1);
  }
  const adj = pts.map(() => []);
  const join = (a, b) => {
    const w = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1], pts[a][2] - pts[b][2]);
    adj[a].push(b, w); adj[b].push(a, w);
  };
  for (const c of stages) {
    const end = last.get(c[IDX]);
    for (let i = first.get(c[IDX]); i < end; i++) join(i, i + 1);
    for (const n of [c[NEXT], c[BRANCH]]) if (first.has(n)) join(end, first.get(n));
    // A lane change into the parallel lane at both ends (some lanes connect only through it).
    const n = c[NEIGHBOUR];
    if (!first.has(n)) continue;
    for (const a of [first.get(c[IDX]), end]) {
      let best = -1, bd = Infinity;
      for (let i = first.get(n); i <= last.get(n); i++) {
        const d = (pts[i][0] - pts[a][0]) ** 2 + (pts[i][1] - pts[a][1]) ** 2 + (pts[i][2] - pts[a][2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      join(a, best);
    }
  }
  return { pts, adj };
}

/** Dijkstra from point `from`: each point's distance along the roads and the next point towards `from`. */
export function routeTree({ pts, adj }, from) {
  const dist = new Float64Array(pts.length).fill(Infinity), prev = new Int32Array(pts.length).fill(-1);
  dist[from] = 0;
  const heap = [[0, from]];
  while (heap.length) {
    const [d, a] = heap[0], tail = heap.pop();
    if (heap.length) { // sift the tail down from the root
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
        if (heap[c][0] >= tail[0]) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = tail;
    }
    if (d > dist[a]) continue;
    const e = adj[a];
    for (let k = 0; k < e.length; k += 2) {
      const b = e[k], nd = d + e[k + 1];
      if (nd >= dist[b]) continue;
      dist[b] = nd; prev[b] = a;
      let i = heap.push(null) - 1; // sift up
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= nd) break;
        heap[i] = heap[p]; i = p;
      }
      heap[i] = [nd, b];
    }
  }
  return { dist, prev };
}

/** The graph's point nearest [x, y, z]; with `dist`, only among the points it reaches. */
export function nearestPoint(pts, [x, y, z], dist) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (dist && dist[i] === Infinity) continue;
    const p = pts[i], d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export class Minimap {
  /** @param root the HUD element   @param courses courses/<city>.json */
  constructor(root, courses) {
    const at = courses.course_fields.indexOf('points'), role = courses.course_fields.indexOf('role');
    this.lines = courses.courses.filter((c) => c[role] !== 'other').map((c) => c[at]);
    this.graph = roadGraph(courses);
    this.tree = null; this.treeKey = '';
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud-map';
    root.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.roads = document.createElement('canvas');
    this.side = 0;
  }

  /** The shortest way along the roads from the cab to the destination, as graph points. */
  route(pos, target) {
    const key = target.join();
    if (key !== this.treeKey) {
      this.treeKey = key;
      this.tree = routeTree(this.graph, nearestPoint(this.graph.pts, target));
    }
    const out = [];
    for (let i = nearestPoint(this.graph.pts, [pos.x, pos.y, pos.z], this.tree.dist); i >= 0; i = this.tree.prev[i]) {
      out.push(this.graph.pts[i]);
    }
    return out;
  }

  /** Draws the roads for a map `side` pixels wide. */
  drawRoads(side) {
    this.side = side;
    this.view = fitView(this.lines.flat(), side);
    const { scale, ox, oz } = this.view;
    this.roads.width = this.roads.height = side;
    const g = this.roads.getContext('2d');
    g.fillStyle = 'rgba(10, 20, 30, 0.6)';
    g.fillRect(0, 0, side, side);
    g.strokeStyle = '#d8dde4';
    g.lineWidth = Math.max(1, side / 220);
    g.lineJoin = g.lineCap = 'round';
    g.beginPath();
    for (const pts of this.lines) {
      pts.forEach(([x, , z], i) => g[i ? 'lineTo' : 'moveTo'](ox + x * scale, oz + z * scale));
    }
    g.stroke();
  }

  /**
   * @param pos the cab's drawn position   @param heading its heading (the model's +z is its front)
   * @param target the destination's centre [x, y, z], or null
   */
  update(pos, heading, target) {
    const side = Math.round(this.canvas.clientHeight * Math.min(devicePixelRatio, 2));
    if (!side) return;
    if (side !== this.side) {
      this.canvas.width = this.canvas.height = side;
      this.drawRoads(side);
    }
    const { scale, ox, oz } = this.view, g = this.ctx;
    g.clearRect(0, 0, side, side);
    g.drawImage(this.roads, 0, 0);
    if (target) {
      // The shortest route there along the roads, from the cab through the road points.
      g.strokeStyle = '#30e030';
      g.lineWidth = side / 90;
      g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ox + pos.x * scale, oz + pos.z * scale);
      for (const [x, , z] of this.route(pos, target)) g.lineTo(ox + x * scale, oz + z * scale);
      g.lineTo(ox + target[0] * scale, oz + target[2] * scale);
      g.stroke();
    }
    if (target) {
      g.fillStyle = '#30e030';
      g.strokeStyle = '#000';
      g.lineWidth = side / 150;
      g.beginPath();
      g.arc(ox + target[0] * scale, oz + target[2] * scale, side / 40, 0, Math.PI * 2);
      g.fill(); g.stroke();
    }
    // The cab: forward is (sin h, cos h) in x / z, which is the map's x / down.
    const cx = ox + pos.x * scale, cy = oz + pos.z * scale, r = side / 28;
    g.save();
    g.translate(cx, cy);
    g.rotate(-heading);
    g.fillStyle = '#ffe81e';
    g.strokeStyle = '#000';
    g.lineWidth = side / 150;
    g.beginPath();
    g.moveTo(0, r); g.lineTo(r * 0.6, -r * 0.6); g.lineTo(-r * 0.6, -r * 0.6); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }
}

export const MINIMAP_CSS = `
#hud-map { position: absolute; left: 2.5cqh; bottom: 6cqh; width: ${SIZE}cqh; height: ${SIZE}cqh; border: 0.25cqh solid #fff; border-radius: 0.8cqh; box-shadow: 0 0.3cqh 0.6cqh rgba(0,0,0,.6); }
`;
