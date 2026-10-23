// The cartoon digits (local-assets/fonts/cartoon_digits/svg/0.svg .. 9.svg: a white
// digit with a black outline and a black drop shadow in a 512 x 512 picture) for the
// HUD's clock and the customer's time over the cab. Each SVG becomes a <symbol> whose
// white fill is currentColor, so a digit takes the CSS `color` of its element (yellow
// for the clock, green / yellow / red for the customer's time). The symbols' viewBox is
// the digit's own box (a common height, the glyph's width) so the digits pack as the
// game's do; the shadow overhangs to the right and below (overflow visible) and the
// next digit draws over it.
const SVG_NS = 'http://www.w3.org/2000/svg';
export const DIGITS_DIR = 'fonts/cartoon_digits/svg/';
const SCALE = 0.1;      // the path group: translate(0, 512) scale(0.1, -0.1)
const STROKE = 16;      // half the outline's stroke-width 320, in picture pixels
export const SHADOW = 32;   // the outline copy's translate(320, -320) (right and down on screen)

/**
 * The box of the digit's white path (M x y, then relative c curves, z) plus its outline,
 * in the 512 x 512 picture (without the shadow). The curves are sampled.
 */
export function glyphBox(svgText) {
  const m = /<path fill="#fff"[^>]*\sd="([^"]*)"/.exec(svgText);
  if (!m) throw new Error('cartoon digit: no white path');
  const tok = m[1].match(/[a-zA-Z]|-?\d*\.?\d+/g);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  let x = 0, y = 0, cmd = '', i = 0;
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) { cmd = tok[i++]; if (cmd === 'z' || cmd === 'Z') continue; }
    if (cmd === 'M') { x = +tok[i++]; y = +tok[i++]; see(x, y); cmd = 'L'; }
    else if (cmd === 'm') { x += +tok[i++]; y += +tok[i++]; see(x, y); cmd = 'l'; }
    else if (cmd === 'L') { x = +tok[i++]; y = +tok[i++]; see(x, y); }
    else if (cmd === 'l') { x += +tok[i++]; y += +tok[i++]; see(x, y); }
    else if (cmd === 'c' || cmd === 'C') {
      const rel = cmd === 'c';
      const [x1, y1, x2, y2, x3, y3] = tok.slice(i, i + 6).map(Number);
      i += 6;
      const p1 = rel ? [x + x1, y + y1] : [x1, y1], p2 = rel ? [x + x2, y + y2] : [x2, y2], p3 = rel ? [x + x3, y + y3] : [x3, y3];
      for (let t = 0.125; t < 1; t += 0.125) {
        const u = 1 - t;
        see(u * u * u * x + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * y + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]);
      }
      x = p3[0]; y = p3[1]; see(x, y);
    } else throw new Error(`cartoon digit: path command ${cmd}`);
  }
  // Picture coordinates: X = 0.1 x, Y = 512 - 0.1 y.
  return {
    x: SCALE * minX - STROKE, y: 512 - SCALE * maxY - STROKE,
    w: SCALE * (maxX - minX) + 2 * STROKE, h: SCALE * (maxY - minY) + 2 * STROKE,
  };
}

/** The SVG's drawing as a <symbol id="cd-N"> with the given viewBox and the white fill as currentColor. */
export function symbolMarkup(svgText, id, box) {
  const inner = svgText.slice(svgText.indexOf('>', svgText.indexOf('<svg')) + 1, svgText.lastIndexOf('</svg>'));
  return `<symbol id="${id}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" overflow="visible">` +
    inner.replace(/fill="#fff"/g, 'fill="currentColor"') + '</symbol>';
}

/** The clock as the game shows it: minutes'seconds" (main) and hundredths (sub), from frames. */
export function gameTimeText(frames) {
  const t = Math.max(0, frames);
  const secs = Math.floor(t / 60);
  return {
    main: `${Math.floor(secs / 60)}'${String(secs % 60).padStart(2, '0')}"`,
    sub: String(Math.floor((t % 60) * 100 / 60)).padStart(2, '0'),
  };
}

// The marks' outline is drawn outward only: the stroke goes under the fill (paint-order),
// so only its outer half shows, and it is twice the digits' outline (set by load()).
const MARK_EM = 0.8;    // the marks' font size, in the clock's em
export const DIGITS_CSS = `
.cd { display: inline-block; height: 1em; overflow: visible; vertical-align: baseline; }
.cd-mark { display: inline-block; font: 900 ${MARK_EM}em/1 "Arial Black", Impact, sans-serif; vertical-align: top; margin-top: -0.08em; -webkit-text-stroke: var(--cd-mark-stroke, 0.09em) #000; paint-order: stroke fill; text-shadow: 0.03em 0.03em 0 #000, 0.06em 0.06em 0 #000, 0.09em 0.09em 0 #000, 0.12em 0.12em 0 #000; }
`;

// The ' and " ticks (1/100 em, y down from the clock's top): a wedge from a round top of
// radius r1 to a round bottom of radius r2, the two circles joined by their tangents.
const TICK = { top: 12, bottom: 40, r1: 9, r2: 6, gap: 7 };
function tickPath(cx) {
  const { top, bottom, r1, r2 } = TICK;
  const s = (r1 - r2) / (bottom - top), c = Math.sqrt(1 - s * s);
  const f = (v) => v.toFixed(2);
  return `M${f(cx + r1 * c)} ${f(top - r1 * s)}L${f(cx + r2 * c)} ${f(bottom - r2 * s)}` +
    `A${r2} ${r2} 0 1 1 ${f(cx - r2 * c)} ${f(bottom - r2 * s)}L${f(cx - r1 * c)} ${f(top - r1 * s)}` +
    `A${r1} ${r1} 0 0 1 ${f(cx + r1 * c)} ${f(top - r1 * s)}Z`;
}

export class CartoonDigits {
  constructor(assets) {
    this.assets = assets;
    this.boxes = null;    // per digit: the symbol's viewBox
    this.height = 0;
  }

  /** Fetches the ten SVGs and puts their symbols into the document. */
  async load() {
    const texts = await Promise.all([...Array(10).keys()].map((n) =>
      fetch(`${this.assets}${DIGITS_DIR}${n}.svg`).then((r) => { if (!r.ok) throw new Error(`${n}.svg: HTTP ${r.status}`); return r.text(); })));
    const boxes = texts.map(glyphBox);
    // One baseline and height for all ten; each its own width.
    const top = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
    this.height = bottom - top;
    this.boxes = boxes.map((b) => ({ x: b.x, y: top, w: b.w, h: this.height }));
    // The digits' outline shows STROKE picture pixels outside the fill: the marks' the same.
    document.documentElement.style.setProperty('--cd-mark-stroke', `${(2 * STROKE / this.height / MARK_EM).toFixed(4)}em`);
    const sprite = document.createElementNS(SVG_NS, 'svg');
    sprite.setAttribute('width', '0'); sprite.setAttribute('height', '0');
    sprite.style.position = 'absolute';
    sprite.innerHTML = texts.map((t, n) => symbolMarkup(t, `cd-${n}`, this.boxes[n])).join('');
    document.body.prepend(sprite);
  }

  /** One glyph element: a digit as the cartoon font, ' and " as round-ended ticks, anything else as outlined text. */
  glyph(ch) {
    const n = ch.charCodeAt(0) - 48;
    let el;
    if (this.boxes && n >= 0 && n <= 9) {
      el = document.createElementNS(SVG_NS, 'svg');
      el.setAttribute('class', 'cd');
      el.style.width = `${(this.boxes[n].w / this.height).toFixed(3)}em`;
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', `#cd-${n}`);
      el.append(use);
    } else if (ch === "'" || ch === '"') {
      el = this.tick(ch === '"' ? 2 : 1);
    } else {
      el = document.createElement('span');
      el.className = 'cd-mark';
      el.textContent = ch;
    }
    el.dataset.ch = ch;
    return el;
  }

  /** `count` tapered ticks with round ends, in 1/100 em: the digits' outline, a stepped drop shadow. */
  tick(count) {
    const sw = this.height ? 200 * STROKE / this.height : 8;   // full stroke; half shows outside the fill
    const o = sw / 2, step = 2 * TICK.r1 + TICK.gap;
    const w = 2 * (o + TICK.r1) + (count - 1) * step;
    let d = '';
    for (let i = 0; i < count; i++) d += tickPath(o + TICK.r1 + i * step);
    const shape = `d="${d}" stroke="#000" stroke-width="${sw.toFixed(2)}" stroke-linejoin="round"`;
    let inner = '';
    for (let i = 1; i <= 8; i++) inner += `<path ${shape} fill="#000" transform="translate(${1.2 * i} ${1.2 * i})"/>`;
    inner += `<path ${shape} fill="currentColor" paint-order="stroke fill"/>`;
    const el = document.createElementNS(SVG_NS, 'svg');
    el.setAttribute('class', 'cd');
    el.setAttribute('viewBox', `0 0 ${w.toFixed(2)} 100`);
    el.setAttribute('overflow', 'visible');
    el.style.width = `${(w / 100).toFixed(3)}em`;
    el.innerHTML = inner;
    return el;
  }

  /** Shows `text` in `el` (glyphs reused where the character is unchanged). */
  set(el, text) {
    if (el.dataset.text === text) return;
    el.dataset.text = text;
    const kids = el.children;
    for (let i = 0; i < text.length; i++) {
      if (i < kids.length) {
        if (kids[i].dataset.ch !== text[i]) kids[i].replaceWith(this.glyph(text[i]));
      } else {
        el.append(this.glyph(text[i]));
      }
    }
    while (kids.length > text.length) kids[kids.length - 1].remove();
  }
}
