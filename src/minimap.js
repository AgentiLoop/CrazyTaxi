// A map of the whole city in the bottom-left corner (not in the game: its only course map,
// goiToolCourseMap, is a developer tool). The roads are the run's traffic lanes (the "stage"
// courses and the main line of courses/<city>.json, tools/extract_courses.py), seen from above
// with north (-z) up; the cab is a yellow triangle along its heading, the destination of the
// customer aboard a green dot. The roads are drawn once; each frame redraws only the marks.

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

export class Minimap {
  /** @param root the HUD element   @param courses courses/<city>.json */
  constructor(root, courses) {
    const at = courses.course_fields.indexOf('points'), role = courses.course_fields.indexOf('role');
    this.lines = courses.courses.filter((c) => c[role] !== 'other').map((c) => c[at]);
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud-map';
    root.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.roads = document.createElement('canvas');
    this.side = 0;
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
