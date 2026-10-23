// A small SH-4 interpreter, enough to run the game's own routines (the player
// car's physics) over the extracted data. Single precision FPU only (the game
// runs with FPSCR.PR = 0), no MMU, no interrupts, no double precision, no
// privileged state beyond what user code touches. The hardware's fsca is a
// table; here it is Math.sin/cos rounded to float, which agrees to the last bit
// almost always and never matters for the game.
//
// Memory is the Dreamcast's 16 MB of RAM at 0x0C000000 (P1/P2 mirrors fold
// together). Reads outside it return 0 and writes are dropped. The stack lives
// at the top of RAM, above the data the game loads.
//
// Calls: `hooks` maps a code address to a function; a call or jump to that
// address runs the function instead (it returns right away, r0/fr0 = 0 unless
// the hook sets them). That stubs out the rendering, sound and effects a
// routine would otherwise reach.

export const RAM_BASE = 0x0C000000;
export const RAM_SIZE = 0x01000000;
export const STACK_TOP = 0x0CFC0000;
const SENTINEL = 0x0EADBEE0;

export class SH4 {
  constructor() {
    this.ram = new Uint8Array(RAM_SIZE);
    this.view = new DataView(this.ram.buffer);
    this.r = new Int32Array(16);
    this.fbits = new Uint32Array(32);          // fr0-15 then xf0-15, swapped by frchg
    this.fvals = new Float32Array(this.fbits.buffer);
    this.fb = 0;                               // offset of the front bank (0 or 16)
    this.t = 0; this.s = 0; this.q = 0; this.mq = 0;
    this.sz = 0;
    this.gbr = 0; this.mach = 0; this.macl = 0; this.pr = 0; this.pc = 0; this.fpul = 0;
    this.steps = 0;
    this.hooks = new Map();
  }

  // --- memory ---
  load(addr, bytes) { this.ram.set(bytes, addr & 0x00FFFFFF); }
  inRam(a) { return (a & 0x1F000000) === 0x0C000000; }
  r8(a) { return this.inRam(a) ? this.ram[a & 0x00FFFFFF] : 0; }
  r16(a) { return this.inRam(a) ? this.view.getUint16(a & 0x00FFFFFF, true) : 0; }
  r32(a) { return this.inRam(a) ? this.view.getUint32(a & 0x00FFFFFF, true) : 0; }
  rf(a) { return this.inRam(a) ? this.view.getFloat32(a & 0x00FFFFFF, true) : 0; }
  w8(a, v) { if (this.inRam(a)) this.ram[a & 0x00FFFFFF] = v; }
  w16(a, v) { if (this.inRam(a)) this.view.setUint16(a & 0x00FFFFFF, v, true); }
  w32(a, v) { if (this.inRam(a)) this.view.setUint32(a & 0x00FFFFFF, v >>> 0, true); }
  wf(a, v) { if (this.inRam(a)) this.view.setFloat32(a & 0x00FFFFFF, v, true); }
  rs16(a) { return (this.r16(a) << 16) >> 16; }
  rs32(a) { return this.r32(a) | 0; }

  // --- FPU helpers ---
  f(n) { return this.fvals[this.fb + n]; }
  setf(n, x) { this.fvals[this.fb + n] = x; }
  fbitsGet(n) { return this.fbits[this.fb + n]; }
  fbitsSet(n, b) { this.fbits[this.fb + n] = b >>> 0; }
  xfGet(n) { return this.fbits[(16 - this.fb) + n]; }
  xfSet(n, b) { this.fbits[(16 - this.fb) + n] = b >>> 0; }
  xf(n) { return this.fvals[(16 - this.fb) + n]; }

  /** Run from entry until it returns; the registers set in regs ({r4: ..., fr4: ...}). */
  call(entry, regs = {}, limit = 4000000) {
    this.r[15] = STACK_TOP - 0x100;
    for (const k in regs) {
      if (k[0] === 'f') this.setf(+k.slice(2), regs[k]);
      else this.r[+k.slice(1)] = regs[k] | 0;
    }
    this.pr = SENTINEL;
    this.pc = entry;
    const stop = this.steps + limit;
    while (this.pc !== SENTINEL) {
      if (this.steps > stop) throw new Error(`SH4: more than ${limit} instructions from ${entry.toString(16)} (pc ${this.pc.toString(16)})`);
      this.step(false);
    }
    return this.r[0];
  }

  /** A transfer of control to target: a hook runs instead of the callee (a hook returning false lets the callee run). */
  go(target, isCall) {
    const h = this.hooks.get(target >>> 0);
    if (h) {
      const ret = h(this);
      if (ret !== false) {
        this.r[0] = ret === undefined ? 0 : ret | 0;
        this.setf(0, 0);
        this.pc = this.pr;           // the callee returns at once (a tail jump returns for the caller)
        return;
      }
    }
    this.pc = target >>> 0;
  }

  branchSlot(target, isCall) {
    this.step(true);                // the delay slot runs first
    this.go(target, isCall);
  }

  step(inSlot) {
    const pc = this.pc;
    const op = this.r16(pc);
    this.steps++;
    this.pc = (pc + 2) >>> 0;
    const n = (op >> 8) & 15, m = (op >> 4) & 15, lo4 = op & 15, lo8 = op & 255, hi = op >> 12;
    const r = this.r;
    switch (hi) {
      case 0: {
        if (op === 0x0009) return;
        if (lo4 === 3 && (m === 8 || m === 9 || m === 0xa || m === 0xb)) return;   // pref/ocb*
        if (op === 0x000b) { if (inSlot) throw new Error('branch in a delay slot'); return this.branchSlot(this.pr >>> 0, false); }
        if (op === 0x0008) { this.t = 0; return; }
        if (op === 0x0018) { this.t = 1; return; }
        if (op === 0x0028) { this.mach = this.macl = 0; return; }
        if (op === 0x0048) { this.s = 0; return; }
        if (op === 0x0058) { this.s = 1; return; }
        if (op === 0x0019) { this.mq = this.q = this.t = 0; return; }
        if (lo8 === 0x02) { r[n] = this.sr(); return; }
        if (lo8 === 0x12) { r[n] = this.gbr; return; }
        if (lo8 === 0x0a) { r[n] = this.mach; return; }
        if (lo8 === 0x1a) { r[n] = this.macl; return; }
        if (lo8 === 0x2a) { r[n] = this.pr; return; }
        if (lo8 === 0x5a) { r[n] = this.fpul; return; }
        if (lo8 === 0x6a) { r[n] = this.getFpscr(); return; }
        if (lo8 === 0x29) { r[n] = this.t; return; }
        if (lo8 === 0x03) { this.pr = (pc + 4) >>> 0; return this.branchSlot((pc + 4 + r[n]) >>> 0, true); }   // bsrf
        if (lo8 === 0x23) { return this.branchSlot((pc + 4 + r[n]) >>> 0, false); }                             // braf
        if (lo8 === 0xc3) { this.w32(r[n], r[0]); return; }                                                     // movca.l
        if (lo4 === 4) { this.w8(r[n] + r[0], r[m]); return; }
        if (lo4 === 5) { this.w16(r[n] + r[0], r[m]); return; }
        if (lo4 === 6) { this.w32(r[n] + r[0], r[m]); return; }
        if (lo4 === 7) { this.macl = Math.imul(r[n], r[m]); return; }
        if (lo4 === 0xc) { r[n] = (this.r8(r[m] + r[0]) << 24) >> 24; return; }
        if (lo4 === 0xd) { r[n] = (this.r16(r[m] + r[0]) << 16) >> 16; return; }
        if (lo4 === 0xe) { r[n] = this.r32(r[m] + r[0]); return; }
        break;
      }
      case 1: this.w32(r[n] + lo4 * 4, r[m]); return;
      case 2: {
        switch (lo4) {
          case 0: this.w8(r[n], r[m]); return;
          case 1: this.w16(r[n], r[m]); return;
          case 2: this.w32(r[n], r[m]); return;
          case 4: { const v = r[m]; r[n] = r[n] - 1; this.w8(r[n], v); return; }
          case 5: { const v = r[m]; r[n] = r[n] - 2; this.w16(r[n], v); return; }
          case 6: { const v = r[m]; r[n] = r[n] - 4; this.w32(r[n], v); return; }
          case 7: this.q = r[n] >>> 31; this.mq = r[m] >>> 31; this.t = this.q ^ this.mq; return;
          case 8: this.t = (r[n] & r[m]) === 0 ? 1 : 0; return;
          case 9: r[n] &= r[m]; return;
          case 0xa: r[n] ^= r[m]; return;
          case 0xb: r[n] |= r[m]; return;
          case 0xc: { const x = r[n] ^ r[m]; this.t = ((x & 0xFF) === 0 || (x & 0xFF00) === 0 || (x & 0xFF0000) === 0 || (x & 0xFF000000) === 0) ? 1 : 0; return; }
          case 0xd: r[n] = (r[m] << 16) | (r[n] >>> 16); return;
          case 0xe: this.macl = Math.imul(r[n] & 0xFFFF, r[m] & 0xFFFF); return;
          case 0xf: this.macl = Math.imul((r[n] << 16) >> 16, (r[m] << 16) >> 16); return;
        }
        break;
      }
      case 3: {
        const a = r[n], b = r[m];
        switch (lo4) {
          case 0: this.t = a === b ? 1 : 0; return;
          case 2: this.t = (a >>> 0) >= (b >>> 0) ? 1 : 0; return;
          case 3: this.t = a >= b ? 1 : 0; return;
          case 4: this.div1(n, m); return;
          case 5: { const p = BigInt(a >>> 0) * BigInt(b >>> 0); this.mach = Number(p >> 32n) | 0; this.macl = Number(p & 0xFFFFFFFFn) | 0; return; }
          case 6: this.t = (a >>> 0) > (b >>> 0) ? 1 : 0; return;
          case 7: this.t = a > b ? 1 : 0; return;
          case 8: r[n] = a - b; return;
          case 0xa: { const v = (a >>> 0) - (b >>> 0) - this.t; r[n] = v; this.t = v < 0 ? 1 : 0; return; }
          case 0xb: { const v = a - b; r[n] = v; this.t = (v < -0x80000000 || v > 0x7FFFFFFF) ? 1 : 0; return; }
          case 0xc: r[n] = a + b; return;
          case 0xd: { const p = BigInt(a) * BigInt(b); this.mach = Number(BigInt.asIntN(32, p >> 32n)); this.macl = Number(BigInt.asIntN(32, p)); return; }
          case 0xe: { const v = (a >>> 0) + (b >>> 0) + this.t; r[n] = v; this.t = v > 0xFFFFFFFF ? 1 : 0; return; }
          case 0xf: { const v = a + b; r[n] = v; this.t = (v < -0x80000000 || v > 0x7FFFFFFF) ? 1 : 0; return; }
        }
        break;
      }
      case 4: {
        if (lo4 === 0xc) {   // shad
          const sh = r[m];
          if (sh >= 0) r[n] = r[n] << (sh & 31);
          else r[n] = (sh & 31) ? r[n] >> ((-sh) & 31) : (r[n] < 0 ? -1 : 0);
          return;
        }
        if (lo4 === 0xd) {   // shld
          const sh = r[m];
          if (sh >= 0) r[n] = r[n] << (sh & 31);
          else r[n] = (sh & 31) ? r[n] >>> ((-sh) & 31) : 0;
          return;
        }
        const x = r[n];
        switch (lo8) {
          case 0x00: this.t = x >>> 31; r[n] = x << 1; return;
          case 0x01: this.t = x & 1; r[n] = x >>> 1; return;
          case 0x20: this.t = x >>> 31; r[n] = x << 1; return;
          case 0x21: this.t = x & 1; r[n] = x >> 1; return;
          case 0x04: this.t = x >>> 31; r[n] = (x << 1) | this.t; return;
          case 0x05: this.t = x & 1; r[n] = (x >>> 1) | (this.t << 31); return;
          case 0x24: { const t = x >>> 31; r[n] = (x << 1) | this.t; this.t = t; return; }
          case 0x25: { const t = x & 1; r[n] = (x >>> 1) | (this.t << 31); this.t = t; return; }
          case 0x08: r[n] = x << 2; return;
          case 0x09: r[n] = x >>> 2; return;
          case 0x18: r[n] = x << 8; return;
          case 0x19: r[n] = x >>> 8; return;
          case 0x28: r[n] = x << 16; return;
          case 0x29: r[n] = x >>> 16; return;
          case 0x10: r[n] = x - 1; this.t = r[n] === 0 ? 1 : 0; return;
          case 0x11: this.t = x >= 0 ? 1 : 0; return;
          case 0x15: this.t = x > 0 ? 1 : 0; return;
          case 0x1b: { const v = this.r8(x); this.t = v === 0 ? 1 : 0; this.w8(x, v | 0x80); return; }
          case 0x0b: this.pr = (pc + 4) >>> 0; return this.branchSlot(x >>> 0, true);   // jsr
          case 0x2b: return this.branchSlot(x >>> 0, false);                            // jmp
          case 0x0a: this.mach = x; return;
          case 0x1a: this.macl = x; return;
          case 0x2a: this.pr = x; return;
          case 0x5a: this.fpul = x; return;
          case 0x6a: this.setFpscr(x); return;
          case 0x1e: this.gbr = x; return;
          case 0x0e: this.setSr(x); return;
          case 0x02: case 0x12: case 0x22: case 0x52: case 0x62: case 0x13: {
            const v = { 0x02: this.mach, 0x12: this.macl, 0x22: this.pr, 0x52: this.fpul, 0x62: this.getFpscr(), 0x13: this.gbr }[lo8];
            r[n] = x - 4; this.w32(r[n], v); return;
          }
          case 0x06: case 0x16: case 0x26: case 0x56: case 0x66: case 0x17: {
            const v = this.r32(x) | 0; r[n] = x + 4;
            if (lo8 === 0x06) this.mach = v; else if (lo8 === 0x16) this.macl = v; else if (lo8 === 0x26) this.pr = v;
            else if (lo8 === 0x56) this.fpul = v; else if (lo8 === 0x66) this.setFpscr(v); else this.gbr = v;
            return;
          }
        }
        break;
      }
      case 5: r[n] = this.r32(r[m] + lo4 * 4); return;
      case 6: {
        const v = r[m];
        switch (lo4) {
          case 0: r[n] = (this.r8(v) << 24) >> 24; return;
          case 1: r[n] = (this.r16(v) << 16) >> 16; return;
          case 2: r[n] = this.r32(v); return;
          case 3: r[n] = v; return;
          case 4: { const x = (this.r8(v) << 24) >> 24; if (n !== m) r[m] = v + 1; r[n] = x; return; }
          case 5: { const x = (this.r16(v) << 16) >> 16; if (n !== m) r[m] = v + 2; r[n] = x; return; }
          case 6: { const x = this.r32(v); if (n !== m) r[m] = v + 4; r[n] = x; return; }
          case 7: r[n] = ~v; return;
          case 8: r[n] = (v & 0xFFFF0000) | ((v & 0xFF) << 8) | ((v >>> 8) & 0xFF); return;
          case 9: r[n] = (v << 16) | (v >>> 16); return;
          case 0xa: { const t = (v !== 0 || this.t !== 0) ? 1 : 0; r[n] = -v - this.t; this.t = t; return; }
          case 0xb: r[n] = -v; return;
          case 0xc: r[n] = v & 0xFF; return;
          case 0xd: r[n] = v & 0xFFFF; return;
          case 0xe: r[n] = (v << 24) >> 24; return;
          case 0xf: r[n] = (v << 16) >> 16; return;
        }
        break;
      }
      case 7: r[n] = r[n] + ((lo8 << 24) >> 24); return;
      case 8: {
        const d = lo4;
        switch (n) {
          case 0: this.w8(r[m] + d, r[0]); return;
          case 1: this.w16(r[m] + d * 2, r[0]); return;
          case 4: r[0] = (this.r8(r[m] + d) << 24) >> 24; return;
          case 5: r[0] = (this.r16(r[m] + d * 2) << 16) >> 16; return;
          case 8: this.t = r[0] === ((lo8 << 24) >> 24) ? 1 : 0; return;
          case 9: case 0xb: case 0xd: case 0xf: {
            if (inSlot) throw new Error('branch in a delay slot');
            const take = this.t === ((n === 9 || n === 0xd) ? 1 : 0);
            const target = (pc + 4 + ((lo8 << 24) >> 24) * 2) >>> 0;
            if (n === 9 || n === 0xb) { if (take) this.pc = target; return; }
            this.step(true);
            if (take) this.pc = target;
            return;
          }
        }
        break;
      }
      case 9: r[n] = (this.r16(pc + 4 + lo8 * 2) << 16) >> 16; return;
      case 0xa: { if (inSlot) throw new Error('branch in a delay slot'); const d = ((op & 0xFFF) << 20) >> 20; return this.branchSlot((pc + 4 + d * 2) >>> 0, false); }
      case 0xb: { if (inSlot) throw new Error('branch in a delay slot'); const d = ((op & 0xFFF) << 20) >> 20; this.pr = (pc + 4) >>> 0; return this.branchSlot((pc + 4 + d * 2) >>> 0, true); }
      case 0xc: {
        const g = this.gbr;
        switch (n) {
          case 0: this.w8(g + lo8, r[0]); return;
          case 1: this.w16(g + lo8 * 2, r[0]); return;
          case 2: this.w32(g + lo8 * 4, r[0]); return;
          case 3: throw new Error(`trapa at ${pc.toString(16)}`);
          case 4: r[0] = (this.r8(g + lo8) << 24) >> 24; return;
          case 5: r[0] = (this.r16(g + lo8 * 2) << 16) >> 16; return;
          case 6: r[0] = this.r32(g + lo8 * 4); return;
          case 7: r[0] = ((pc & ~3) + 4 + lo8 * 4) | 0; return;
          case 8: this.t = (r[0] & lo8) === 0 ? 1 : 0; return;
          case 9: r[0] &= lo8; return;
          case 0xa: r[0] ^= lo8; return;
          case 0xb: r[0] |= lo8; return;
          default: {
            const a = g + r[0], v = this.r8(a);
            if (n === 0xc) { this.t = (v & lo8) === 0 ? 1 : 0; return; }
            if (n === 0xd) { this.w8(a, v & lo8); return; }
            if (n === 0xe) { this.w8(a, v ^ lo8); return; }
            this.w8(a, v | lo8); return;
          }
        }
      }
      case 0xd: r[n] = this.r32((pc & ~3) + 4 + lo8 * 4); return;
      case 0xe: r[n] = (lo8 << 24) >> 24; return;
      case 0xf: return this.fpu(op, n, m, lo4);
    }
    throw new Error(`SH4: unknown instruction ${op.toString(16)} at ${pc.toString(16)}`);
  }

  sr() { return 0x40000000 | (this.mq << 9) | (this.q << 8) | (this.s << 1) | this.t; }
  setSr(x) { this.t = x & 1; this.s = (x >> 1) & 1; this.q = (x >> 8) & 1; this.mq = (x >> 9) & 1; }
  getFpscr() { return 0x00040001 | (this.sz << 20) | ((this.fb ? 1 : 0) << 21); }
  setFpscr(v) {
    const fr = (v >> 21) & 1;
    if (fr !== (this.fb ? 1 : 0)) this.fb = 16 - this.fb;
    this.sz = (v >> 20) & 1;
    if ((v >> 19) & 1) throw new Error('SH4: double precision is not implemented');
  }

  div1(n, m) {
    const r = this.r;
    const oldq = this.q;
    this.q = r[n] >>> 31;
    const tmp2 = r[m] >>> 0;
    r[n] = (r[n] << 1) | this.t;
    const tmp0 = r[n] >>> 0;
    let tmp1;
    if (oldq === 0) {
      if (this.mq === 0) {
        r[n] = r[n] - tmp2; tmp1 = (r[n] >>> 0) > tmp0 ? 1 : 0;
        this.q = this.q === 0 ? tmp1 : (tmp1 === 0 ? 1 : 0);
      } else {
        r[n] = r[n] + tmp2; tmp1 = (r[n] >>> 0) < tmp0 ? 1 : 0;
        this.q = this.q === 0 ? (tmp1 === 0 ? 1 : 0) : tmp1;
      }
    } else if (this.mq === 0) {
      r[n] = r[n] + tmp2; tmp1 = (r[n] >>> 0) < tmp0 ? 1 : 0;
      this.q = this.q === 0 ? tmp1 : (tmp1 === 0 ? 1 : 0);
    } else {
      r[n] = r[n] - tmp2; tmp1 = (r[n] >>> 0) > tmp0 ? 1 : 0;
      this.q = this.q === 0 ? (tmp1 === 0 ? 1 : 0) : tmp1;
    }
    this.t = this.q === this.mq ? 1 : 0;
  }

  fpu(op, n, m, lo4) {
    if (op === 0xF3FD) { this.sz ^= 1; return; }                       // fschg
    if (op === 0xFBFD) { this.fb = 16 - this.fb; return; }              // frchg
    if (lo4 === 0xd) {
      switch (m) {
        case 0: this.fbitsSet(n, this.fpul); return;                    // fsts
        case 1: this.fpul = this.fbitsGet(n) | 0; return;               // flds
        case 2: this.setf(n, this.fpul | 0); return;                    // float
        case 3: {                                                       // ftrc
          const x = this.f(n);
          let v;
          if (x !== x) v = 0x80000000;
          else if (x >= 2147483648) v = 0x7FFFFFFF;
          else if (x <= -2147483648) v = 0x80000000;
          else v = Math.trunc(x);
          this.fpul = v | 0; return;
        }
        case 4: this.fbitsSet(n, this.fbitsGet(n) ^ 0x80000000); return;   // fneg
        case 5: this.fbitsSet(n, this.fbitsGet(n) & 0x7FFFFFFF); return;   // fabs
        case 6: { const x = this.f(n); this.setf(n, x >= 0 ? Math.sqrt(x) : NaN); return; }
        case 7: { const x = this.f(n); this.setf(n, x > 0 ? 1 / Math.sqrt(x) : Infinity); return; }   // fsrra
        case 8: this.fbitsSet(n, 0); return;
        case 9: this.fbitsSet(n, 0x3F800000); return;
        case 0xe: {                                                     // fipr fvm,fvn
          const vn = (n >> 2) * 4, vm = (n & 3) * 4;
          let s = 0;
          for (let i = 0; i < 4; i++) s += this.f(vm + i) * this.f(vn + i);
          this.setf(vn + 3, s); return;
        }
        case 0xf: {
          if ((n & 1) === 0) {                                          // fsca fpul,drn
            const a = 2 * Math.PI * (this.fpul & 0xFFFF) / 65536;
            this.setf(n, Math.sin(a)); this.setf(n + 1, Math.cos(a)); return;
          }
          if ((n & 3) === 1) {                                          // ftrv xmtrx,fvn
            const vn = (n >> 2) * 4;
            const v0 = this.f(vn), v1 = this.f(vn + 1), v2 = this.f(vn + 2), v3 = this.f(vn + 3);
            for (let i = 0; i < 4; i++) {
              this.setf(vn + i, this.xf(i) * v0 + this.xf(i + 4) * v1 + this.xf(i + 8) * v2 + this.xf(i + 12) * v3);
            }
            return;
          }
          break;
        }
      }
      throw new Error(`SH4: FPU instruction ${op.toString(16)} not implemented`);
    }
    if (lo4 >= 6 && lo4 <= 0xc) return this.fmov(op, n, m, lo4);
    const a = this.f(n), b = this.f(m);
    switch (lo4) {
      case 0: this.setf(n, a + b); return;
      case 1: this.setf(n, a - b); return;
      case 2: this.setf(n, a * b); return;
      case 3: this.setf(n, b === 0 ? ((a === 0 || a !== a) ? NaN : (a > 0 ? 1 : -1) * (Object.is(b, -0) ? -Infinity : Infinity)) : a / b); return;
      case 4: this.t = a === b ? 1 : 0; return;
      case 5: this.t = a > b ? 1 : 0; return;
      case 0xe: this.setf(n, this.f(0) * b + a); return;                // fmac
    }
    throw new Error(`SH4: FPU instruction ${op.toString(16)} not implemented`);
  }

  fmov(op, n, m, lo4) {
    const r = this.r;
    if (!this.sz) {
      switch (lo4) {
        case 0xc: this.fbitsSet(n, this.fbitsGet(m)); return;
        case 8: this.fbitsSet(n, this.r32(r[m])); return;
        case 6: this.fbitsSet(n, this.r32(r[m] + r[0])); return;
        case 9: this.fbitsSet(n, this.r32(r[m])); r[m] = r[m] + 4; return;
        case 0xa: this.w32(r[n], this.fbitsGet(m)); return;
        case 7: this.w32(r[n] + r[0], this.fbitsGet(m)); return;
        case 0xb: r[n] = r[n] - 4; this.w32(r[n], this.fbitsGet(m)); return;
      }
      throw new Error(`SH4: fmov ${op.toString(16)}`);
    }
    // SZ = 1: register pairs; an odd number names XDn (the other bank). FR[2k]
    // moves to and from the lower address, FR[2k+1] the upper one (the SH-4 keeps
    // the high word of a double first in memory): nlPushMatrix's two paths - 16
    // single loads or 8 pair loads of the same matrix - agree only this way.
    const bank = (k) => (k & 1) ? (16 - this.fb) : this.fb;
    const get = (k) => { const b = bank(k) + (k & 14); return [this.fbits[b], this.fbits[b + 1]]; };
    const put = (k, hi, lo) => { const b = bank(k) + (k & 14); this.fbits[b] = hi; this.fbits[b + 1] = lo; };
    const load = (a) => [this.r32(a), this.r32(a + 4)];
    const store = (a, hi, lo) => { this.w32(a, hi); this.w32(a + 4, lo); };
    switch (lo4) {
      case 0xc: { const [h, l] = get(m); put(n, h, l); return; }
      case 8: { const [h, l] = load(r[m]); put(n, h, l); return; }
      case 6: { const [h, l] = load(r[m] + r[0]); put(n, h, l); return; }
      case 9: { const [h, l] = load(r[m]); put(n, h, l); r[m] = r[m] + 8; return; }
      case 0xa: { const [h, l] = get(m); store(r[n], h, l); return; }
      case 7: { const [h, l] = get(m); store(r[n] + r[0], h, l); return; }
      case 0xb: { const [h, l] = get(m); r[n] = r[n] - 8; store(r[n], h, l); return; }
    }
    throw new Error(`SH4: fmov ${op.toString(16)}`);
  }
}
