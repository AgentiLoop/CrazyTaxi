// The player's cab run by the game's own code: init_CarMain and exec_CarMain
// from the USA executable (1ST_READ.BIN, code at 0x0C010000) execute in the
// SH-4 interpreter (src/sh4.js) over the city's course points (SPLDCn.BIN at
// 0x0C328000) and collision (COLDCn.BIN at 0x0CB40000), exactly as on the
// Dreamcast. Everything the routine would draw, play or rumble is stubbed
// (hooks); the physics - carGearbox, carWheelForces, carAngularMotion,
// carWheelCollision, carGroundCheck and the rest - is the original.
//
// Car_Data (USA 0x0C176E4C; the decomp's EU 0x0C1790CC) as the code uses it:
//   +0x54  control: 3 at init, 1 = release (becomes 2 while driving), 0 = held
//          (the countdown and a customer getting in or out): no throttle, no speed
//   +0x78  position x y z           +0x84/86/88 pitch, heading, roll (1/65536 turn)
//   +0x8C  position copy (last frame)  +0xF4 heading of travel
//   +0xFC  velocity (units/frame)   +0x114 steering input (1/65536 turn, +-0x1100)
//   +0x118 throttle 0..1   +0x11C brake 0..1   +0x120 gear (0 reverse, 1-5)
//   +0x124 clutch (1 = engine drives the wheels)   +0x128 mass   +0x12C wheel radius
//   +0x154 engine torque  +0x158 engine rpm  +0x15C speed (units/frame)  +0x160 wheel rpm
//   +0x198/19A/19C yaw/pitch/roll rates
//   +0x1A0 four 0x84-byte wheel records: +0 ground kind, +0x68 world position,
//          +0x80 steering angle (carSteerWheels: the rear wheels steer 0.37 of the
//          front up to 0x600, then less and less - 123 at full lock)
// Input (TaxiSW, USA 0x0C1EBF6C): +0xA8 stick x, +0xAC right trigger, +0xB0 left
// trigger (floats), +0x1B B held (Drive), +0x1C A held (Reverse).
//
// One unit is 10 cm (exec_CarMain's debug speedometer: wheel rpm * radius *
// 2 pi * 0.006 km/h). Headings: forward = (sin h, 0, cos h).

import { SH4 } from './sh4.js';

export const STEP = 1 / 60;
export const WHEEL_RADIUS = 2.964;   // the drawn wheel (cab_0.glb); the physics uses +0x12C = 2.87
const TURN = Math.PI * 2 / 65536;

const EXE_BASE = 0x0C010000;
const SPL_BASE = 0x0C328000;
const COL_BASE = 0x0CB40000;
const CAR = 0x0C176E4C;

const G = {
  courseMode: 0x0C1EBF2C, gameNo: 0x0C1EBF30, miniGameNo: 0x0C1EBF34,
  cabType: 0x0C177208, reverseMode: 0x0C17720C, groundKind: 0x0C177210,
  startMode: 0x0C1EC07C,              // byte: 1 = the normal game start
  courseTable: 0x0C2A4350, courseCount: 0x0C2A4354,
  lineTable: 0x0C29F7E8, lineCount: 0x0C29F7EC,
  courseDirectory: 0x0C0C718C,        // {table, count} per city
  courseLineTbl: 0x0C0C2B64,          // course index words by Game_No + MiniGame_No
  matrixStack: 0x0C2B067C,            // u16 depth, u16 max, base, current
  stick: 0x0C1EC014, accel: 0x0C1EC018, brake: 0x0C1EC01C,
  buttonB: 0x0C1EBF87, buttonA: 0x0C1EBF88,
};
const MATRIX_STACK = 0x0CFD0000;

const FN = {
  initCollision: 0x0C030CC4, initColliWall: 0x0C033374,
  initCarMain: 0x0C023696, execCarMain: 0x0C023CF2,
};
// Routines exec_CarMain / init_CarMain reach that draw, play, rumble or feed
// other systems: stubbed (they return 0).
const STUBS = [
  0x0C032448, // SetColliObj
  0x0C0208D6, // init_CarSound
  0x0C035884, // InitEffect
  0x0C036A40, // InitSpark
  0x0C04B14A, // getReplayPoint
  0x0C0200E4, // putPlayerCarByView
  0x0C0203E8, // putPlayerCar
  0x0C04AE88, // replay
  0x0C0206DC, // carRumble
  0x0C05E1D0, // ndPuru2Start
  0x0C020A10, // exec_CarSound
  0x0C035C40, // SetEffect
  0x0C035F68, // ExecEffect
  0x0C036A90, // ExecSpark
  0x0C02D0EE, // GS_TripMetor (src/game.js keeps the trip meter)
  0x0C02E3F4, // gdc_CoursePointLoadReq
  0x0C02A814, // navi_GetRouteDataC
];

const HOLD_INPUT = { steer: 0, accel: 0, brake: 1, drive: false, reverse: false };
const STEER_RATE = 5;   // keyboard only: the stick value moves this much per second

export class DreamcastCar {
  /**
   * @param {{exe: Uint8Array, courses: Uint8Array, collision: Uint8Array}} data the disc files
   * @param {{city?: number, cab?: number, reverse?: boolean}} opts city 0 Arcade, 1 Original
   */
  constructor(data, opts = {}) {
    const cpu = new SH4();
    this.cpu = cpu;
    cpu.load(EXE_BASE, data.exe);
    cpu.load(SPL_BASE, data.courses);
    cpu.load(COL_BASE, data.collision);
    for (const a of STUBS) cpu.hooks.set(a, () => 0);
    // getNearLineIndexAll runs only from carGroundCheck's out-of-world recovery here: count it, then let it run.
    cpu.hooks.set(0x0C048ED2, () => { this.recoveries++; return false; });
    this.city = opts.city || 0;
    this.cab = opts.cab || 0;
    cpu.w32(G.courseMode, this.city);
    cpu.w32(G.gameNo, this.city);
    cpu.w32(G.miniGameNo, 0);
    cpu.w32(G.cabType, this.cab);
    cpu.w32(G.reverseMode, opts.reverse ? 1 : 0);
    cpu.w8(G.startMode, 1);
    // CourseTableSet(city) and init_GameSystem's course line.
    const table = cpu.r32(G.courseDirectory + this.city * 8), count = cpu.r32(G.courseDirectory + this.city * 8 + 4);
    cpu.w32(G.courseTable, table); cpu.w32(G.courseCount, count);
    const rec = table + cpu.r16(G.courseLineTbl + this.city * 2) * 12;
    cpu.w32(G.lineTable, cpu.r32(rec)); cpu.w32(G.lineCount, cpu.r32(cpu.r32(rec + 4)));
    cpu.w16(G.matrixStack, 0); cpu.w16(G.matrixStack + 2, 64);
    cpu.w32(G.matrixStack + 4, MATRIX_STACK); cpu.w32(G.matrixStack + 8, MATRIX_STACK);
    cpu.call(FN.initCollision);
    cpu.call(FN.initColliWall);

    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.heading = 0; this.pitch = 0; this.roll = 0;
    this.speed = 0;            // units per second (+0x15C * 60)
    this.steer = 0;            // front wheel angle, rad
    this.wheelSteer = [0, 0, 0, 0];
    this.wheelSpin = 0;
    this.gear = 1;
    this.rpm = 0;
    this.groundKind = -1;
    this.onGround = true;
    this.yawRate = 0;          // heading change per frame, rad
    this.hold = false;
    this.recoveries = 0;
    this.stickX = 0;
    this.frames = 0;
    this.init();
  }

  /** init_CarMain: the start spot for the city/reverse mode and every constant. */
  init() {
    const cpu = this.cpu;
    cpu.w16(G.matrixStack, 0); cpu.w32(G.matrixStack + 8, MATRIX_STACK);
    cpu.call(FN.initCarMain);
    cpu.w32(CAR + 0x54, 1);
    this.stickX = 0;
    this.readBack();
  }

  /** Put the car at a spot ({x, y, z, heading} in radians), as the start would. */
  place(start) {
    this.init();
    const cpu = this.cpu;
    const h = Math.round(start.heading / TURN) & 0xFFFF;
    for (const base of [CAR + 0x78, CAR + 0x8C]) {
      cpu.wf(base, start.x); cpu.wf(base + 4, start.y); cpu.wf(base + 8, start.z);
    }
    cpu.w16(CAR + 0x84, 0); cpu.w16(CAR + 0x86, h); cpu.w16(CAR + 0x88, 0);
    cpu.w16(CAR + 0x98, 0); cpu.w16(CAR + 0x9A, h); cpu.w16(CAR + 0x9C, 0);
    cpu.w16(CAR + 0xF4, h);
    for (let w = 0; w < 4; w++) {   // the wheel contact points start at the car
      const b = CAR + 0x1A0 + w * 0x84 + 0x68;
      cpu.wf(b, start.x); cpu.wf(b + 4, start.y); cpu.wf(b + 8, start.z);
    }
    this.readBack();
  }

  forward() {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  /** One 60 Hz frame of exec_CarMain. input: { steer, accel, brake, drive, reverse }. */
  update(input) {
    const cpu = this.cpu;
    if (this.hold) input = HOLD_INPUT;
    // Keyboard shaping: the stick slides toward the key; the game's own curve
    // (exec_CarMain: dead zone 0.04, quadratic to 0.1, then linear: 4320 =
    // 23.7 degrees at full stick, the 0x1100 clamp never reached) does the rest.
    const want = Math.max(-1, Math.min(1, input.steer));
    const d = want - this.stickX, step = STEER_RATE * STEP;
    this.stickX += Math.abs(d) <= step ? d : Math.sign(d) * step;
    cpu.wf(G.stick, this.stickX);
    cpu.wf(G.accel, input.accel);
    cpu.wf(G.brake, input.brake);
    cpu.w8(G.buttonB, input.drive ? 1 : 0);
    cpu.w8(G.buttonA, input.reverse ? 1 : 0);
    const control = cpu.r32(CAR + 0x54);
    if (this.hold) cpu.w32(CAR + 0x54, 0);
    else if (control === 0 || control === 3) cpu.w32(CAR + 0x54, 1);
    const h0 = cpu.r16(CAR + 0x86);
    cpu.call(FN.execCarMain);
    const dh = ((cpu.r16(CAR + 0x86) - h0 + 0x8000) & 0xFFFF) - 0x8000;
    this.yawRate = dh * TURN;
    this.frames++;
    this.readBack();
    this.wheelSpin += cpu.rf(CAR + 0x160) * 2 * Math.PI / 3600;   // wheel rpm -> rad per frame
  }

  readBack() {
    const cpu = this.cpu;
    this.pos.x = cpu.rf(CAR + 0x78); this.pos.y = cpu.rf(CAR + 0x7C); this.pos.z = cpu.rf(CAR + 0x80);
    this.vel.x = cpu.rf(CAR + 0xFC) * 60; this.vel.y = cpu.rf(CAR + 0x100) * 60; this.vel.z = cpu.rf(CAR + 0x104) * 60;
    this.pitch = cpu.rs16(CAR + 0x84) * TURN;
    this.heading = cpu.r16(CAR + 0x86) * TURN;
    this.roll = cpu.rs16(CAR + 0x88) * TURN;
    this.speed = cpu.rf(CAR + 0x15C) * 60;
    this.rpm = cpu.rf(CAR + 0x158);
    this.gear = cpu.r32(CAR + 0x120);
    this.throttle = cpu.rf(CAR + 0x118);
    this.brake = cpu.rf(CAR + 0x11C);
    for (let w = 0; w < 4; w++) this.wheelSteer[w] = cpu.rs16(CAR + 0x1A0 + w * 0x84 + 0x80) * TURN;
    this.steer = this.wheelSteer[0];
    const kind = cpu.r32(G.groundKind) | 0;
    this.groundKind = kind;
    this.onGround = kind !== -1;
  }

  /** World position of wheel w (the game's contact point, +0x68 of its record). */
  wheelPosition(w) {
    const b = CAR + 0x1A0 + w * 0x84 + 0x68;
    return { x: this.cpu.rf(b), y: this.cpu.rf(b + 4), z: this.cpu.rf(b + 8) };
  }

  /** km/h: one unit is 10 cm. */
  kmh() {
    return Math.abs(this.speed) * 0.36;
  }
}

/** The disc files the car needs, by city (0 Arcade, 1 Original). */
export function carFiles(city) {
  return { exe: 'disc/1ST_READ.BIN', courses: `disc/SPLDC${city + 1}.BIN`, collision: `disc/COLDC${city + 1}.BIN` };
}
