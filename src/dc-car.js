// The player's cab and the traffic run by the game's own code: init_CarMain,
// exec_CarMain, entryCarPut, trafficControl, nlExecuteEvent (every traffic car,
// train and signal is an event) and ExecColliObj from the USA executable
// (1ST_READ.BIN, code at 0x0C010000) execute in the SH-4 interpreter (src/sh4.js)
// over the city's course points (SPLDCn.BIN at 0x0C328000) and collision
// (COLDCn.BIN at 0x0CB40000), exactly as on the Dreamcast. Everything the
// routines would draw, play or rumble is stubbed (hooks); the physics -
// carGearbox, carWheelForces, carAngularMotion, carWheelCollision,
// carGroundCheck, and for the traffic pcarDrive, carSteering, carResistance,
// carBalance, carMultiCollision, the course occupancy grid and the collision
// objects - is the original.
//
// Set-up (gameState0's order): nlInitHeapMemory, nlInitEvent, extRandomSeed(12345),
// InitColliObj, InitCollision, InitColliWall, init_CarMain, entryCarPut(0),
// trafficControl(0). A frame (gameStateDrive's order): exec_CarMain,
// entryCarPut(1), trafficControl(1), nlExecuteEvent, ExecColliObj.
//
// Car_Data (USA 0x0C176E4C; the decomp's EU 0x0C1790CC) as the code uses it:
//   +0x00  the cab's collision object (SetColliObj in init_CarMain; ExecColliObj hits it):
//          +0x30 forward and +0x3C up vectors, stored by putPlayerCar's GetRotVec
//   +0x54  control: 3 at init, 1 = release (becomes 2 while driving), 0 = held
//          (the countdown and a customer getting in or out): no throttle, no speed
//   +0x60  the cab's course point (trafficControl)
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
// A traffic car (the event's data; the decomp's engine notes, checked here):
//   +0x14 its collision object   +0x78 type (carTbl)   +0x7C colour (-1 none)
//   +0x84 flags: 1 alive, 4 moving, 8 collision object, 0x10 parked, 0x10000 on screen
//   +0x8C position   +0xA4/A6/A8 pitch, heading, roll   +0xAA/+0xAE body pitch/roll
//   +0xB0 radius (clipping)   +0xB8 wheel angle   +0xC8 brake   +0xCC speed (u/frame)
//   +0xD4 course point   +0xF8 + 0xFC body height
// The traffic lives in a circle of CarControlArea (1100; 900 while the word
// 0x0C177214, which init_CarMain clears, is set) around a point 500 ahead of the cab;
// entryCarPut draws the cars inside the camera's clipping cone within 1800 (the
// view matrix at 0x0C2B0830, the clipping angle at 0x0C13DBC8/CC).
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
  mainMode: 0x0C1EBF54,               // 1 = the game (not the attract demo)
  goiToolFlags: 0x0C2A2B28,           // GoiTool(0) sets 2: traffic on (getGoiToolFlag(2))
  endingFlag: 0x0C2A2B10, subwayFlag: 0x0C2A4C98,
  fov: 0x0C177624,                    // the camera's field of view (60): entryCarPut's detail choice
  clipSin: 0x0C13DBC8, clipTan: 0x0C13DBCC,   // SetNewClippingAngle: 1 / sin, 1 / tan of the half angle
  viewMatrix: 0x0C2B0830,             // nlProjectScreen3D's matrix (column major)
  heapPtr: 0x0C177764,
  courseTable: 0x0C2A4350, courseCount: 0x0C2A4354,
  lineTable: 0x0C29F7E8, lineCount: 0x0C29F7EC,
  courseDirectory: 0x0C0C718C,        // {table, count} per city
  courseLineTbl: 0x0C0C2B64,          // course index words by Game_No + MiniGame_No
  matrixStack: 0x0C2B067C,            // u16 depth, u16 max, base, current
  stick: 0x0C1EC014, accel: 0x0C1EC018, brake: 0x0C1EC01C,
  buttonB: 0x0C1EBF87, buttonA: 0x0C1EBF88,
  carEntryNum: 0x0C2A2168, carListCount: 0x0C2A2188, carList: 0x0C2A218C,   // up to 100 cars
  carControlArea: 0x0C29F7D8, trafficLevel: 0x0C29F82C,
};
const MATRIX_STACK = 0x0CFD0000;
const HEAP = 0x0C177768, HEAP_SIZE = 0x30000;   // nlMalloc's block (events, grids)
const CLIP_60 = [0x40000742, 0x3FDDC49A];       // SetNewClippingAngle(60)
const IDENTITY = [0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000];

const FN = {
  initHeap: 0x0C02937C, initEvent: 0x0C0294F6, seed: 0x0C048AA0, initColliObj: 0x0C031D3C,
  initCollision: 0x0C030CC4, initColliWall: 0x0C033374,
  initCarMain: 0x0C023696, execCarMain: 0x0C023CF2,
  entryCarPut: 0x0C043BA2, trafficControl: 0x0C041ACC, executeEvent: 0x0C0296B6, execColliObj: 0x0C031EE4,
  putCarModel: 0x0C0434D0, putTrainModel: 0x0C0437FE,
  setTechnicalBonus: 0x0C042364,
};
// Routines the game reaches that draw, play, rumble or feed other systems:
// stubbed (they return 0).
const STUBS = [
  0x0C0208D6, // init_CarSound
  0x0C035884, // InitEffect
  0x0C036A40, // InitSpark
  0x0C04B14A, // getReplayPoint
  0x0C03858C, // PutMVObj (the cab's shadow volume; putPlayerCar itself runs: its GetRotVec
              // stores the cab's rotation vectors at +0x30, which the collision objects need)
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
  0x0C071338, // Sound_Request (horns, bells, the trick jingles)
  0x0C07A210, // nlObjPutMvInit (a PVR register)
  0x0C0460C4, // RailroadAreaCheck (fog by the rails)
  0x0C078FC0, // nlObjPutUseViewMatrix (every model draw: the cab, the cable; it writes the
              // renderer's state over the matrix stack descriptor here)
];

const HOLD_INPUT = { steer: 0, accel: 0, brake: 1, drive: false, reverse: false };
const STEER_RATE = 5;   // keyboard only: the stick value moves this much per second

/** A traffic car as entryCarPut hands it to putCarModel / putTrainModel (see the header). */
export class TrafficCar {
  constructor(cpu, p, detail) {
    // The fields tools/car_trace.py records, in its order (read now: the frame moves on).
    this.raw = [p, cpu.r32(p + 0x78), cpu.r32(p + 0x7C), cpu.r32(p + 0x84),
      cpu.rf(p + 0x8C), cpu.rf(p + 0x90), cpu.rf(p + 0x94),
      cpu.rs16(p + 0xA4), cpu.rs16(p + 0xA6), cpu.rs16(p + 0xA8), cpu.rf(p + 0xF8), cpu.rf(p + 0xFC),
      cpu.rs16(p + 0xAA), cpu.rs16(p + 0xAE), cpu.rf(p + 0xC8), cpu.rf(p + 0xCC), cpu.r32(p + 0xD4), detail];
    const r = this.raw;
    this.id = p;
    this.type = r[1];
    this.colour = r[2] | 0;               // -1: none
    this.flags = r[3];
    this.x = r[4]; this.y = r[5]; this.z = r[6];
    this.pitch = r[7] * TURN; this.heading = (r[8] & 0xFFFF) * TURN; this.roll = r[9] * TURN;
    this.bodyY = r[10] + r[11];
    this.bodyPitch = r[12] * TURN; this.bodyRoll = r[13] * TURN;
    this.brake = r[14];
    this.speed = r[15];                   // units per frame; putCarModel spins the wheels by 0.2 of it
    this.point = r[16];
    this.detail = detail;                 // 0 the detailed model (within 400 of the camera), 1 the simple one
    this.course = cpu.r32(p + 0x80);
  }
}

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
    // entryCarPut draws a car: keep it for the renderer instead.
    const put = (c) => { this.cars.push(new TrafficCar(c, c.r[4], c.r[5])); return 0; };
    cpu.hooks.set(FN.putCarModel, put);
    cpu.hooks.set(FN.putTrainModel, put);
    // setTechnicalBonus(kind, count): the trick bonuses (Crazy Through...) - counted, not displayed yet.
    cpu.hooks.set(FN.setTechnicalBonus, (c) => { if ((c.r[4] | 0) >= 0) this.tricks.push({ kind: c.r[4] | 0, count: c.r[5] | 0 }); return 0; });
    this.city = opts.city || 0;
    this.cab = opts.cab || 0;
    cpu.w32(G.courseMode, this.city);
    cpu.w32(G.gameNo, this.city);
    cpu.w32(G.miniGameNo, 0);
    cpu.w32(G.cabType, this.cab);
    cpu.w32(G.reverseMode, opts.reverse ? 1 : 0);
    cpu.w8(G.startMode, 1);
    cpu.w32(G.mainMode, 1);
    cpu.w32(G.goiToolFlags, 2);
    cpu.w32(G.endingFlag, 0);
    cpu.w32(G.subwayFlag, 0);
    cpu.wf(G.fov, 60);
    // CourseTableSet(city) and init_GameSystem's course line.
    const table = cpu.r32(G.courseDirectory + this.city * 8), count = cpu.r32(G.courseDirectory + this.city * 8 + 4);
    cpu.w32(G.courseTable, table); cpu.w32(G.courseCount, count);
    const rec = table + cpu.r16(G.courseLineTbl + this.city * 2) * 12;
    cpu.w32(G.lineTable, cpu.r32(rec)); cpu.w32(G.lineCount, cpu.r32(cpu.r32(rec + 4)));
    cpu.w16(G.matrixStack, 0); cpu.w16(G.matrixStack + 2, 64);
    cpu.w32(G.matrixStack + 4, MATRIX_STACK); cpu.w32(G.matrixStack + 8, MATRIX_STACK);

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
    /** @type {TrafficCar[]} the traffic cars entryCarPut drew this frame */
    this.cars = [];
    this.tricks = [];
    this.view = null;          // the camera (setCamera); null = a test camera at the cab looking along +x
    this.init();
  }

  /** The game's set-up (gameState0): heap, events, RNG, collision objects, init_CarMain, the traffic. */
  init() {
    const cpu = this.cpu;
    cpu.w16(G.matrixStack, 0); cpu.w32(G.matrixStack + 8, MATRIX_STACK);
    cpu.w32(G.heapPtr, HEAP);
    this.call(FN.initHeap, { r4: HEAP, r5: HEAP_SIZE });
    this.call(FN.initEvent);
    this.call(FN.seed, { r4: 0x3039 });
    this.call(FN.initColliObj, { r4: this.cab });
    this.call(FN.initCollision);
    this.call(FN.initColliWall);
    this.call(FN.initCarMain);
    cpu.w32(CAR + 0x54, 1);
    this.call(FN.entryCarPut, { r4: 0 });
    this.call(FN.trafficControl, { r4: 0 });
    this.stickX = 0;
    this.cars = [];
    this.tricks = [];
    this.readBack();
  }

  /** A routine with XMTRX = the world matrix (identity), as the frame leaves it for the game's code. */
  call(fn, regs) {
    for (let i = 0; i < 16; i++) this.cpu.xfSet(i, IDENTITY[i]);
    return this.cpu.call(fn, regs);
  }

  /** Start over with the car at a spot ({x, y, z, heading} in radians). */
  place(start) {
    this.init();
    this.moveTo(start);
  }

  /** Move the standing car to a spot (the traffic goes on; the cars left behind are removed). */
  moveTo(start) {
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
    for (let i = 0; i < 3; i++) { cpu.wf(CAR + 0xFC + 4 * i, 0); cpu.wf(CAR + 0x108 + 4 * i, 0); }
    cpu.wf(CAR + 0x15C, 0); cpu.wf(CAR + 0x160, 0);
    this.readBack();
  }

  forward() {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  /**
   * The camera entryCarPut culls the traffic with: a column-major view matrix (three.js
   * camera.matrixWorldInverse.elements) and the horizontal field of view in degrees
   * (SetNewClippingAngle). null: the test camera.
   */
  setCamera(elements, fovDeg) {
    this.view = elements ? { m: Float32Array.from(elements), fov: fovDeg } : null;
  }

  /** The view matrix as the game stores it (column major, as three.js does). */
  writeView() {
    const cpu = this.cpu;
    if (!this.view) {
      // At the cab, looking along +x: out = (z - cz, y - cy, cx - x). The same camera as tools/car_trace.py.
      const m = new Uint32Array(16);
      m[2] = 0xBF800000;
      m[5] = m[8] = m[15] = 0x3F800000;
      m[12] = cpu.r32(CAR + 0x80) ^ 0x80000000;
      m[13] = cpu.r32(CAR + 0x7C) ^ 0x80000000;
      m[14] = cpu.r32(CAR + 0x78);
      for (let i = 0; i < 16; i++) cpu.w32(G.viewMatrix + 4 * i, m[i]);
      cpu.w32(G.clipSin, CLIP_60[0]); cpu.w32(G.clipTan, CLIP_60[1]);
      return;
    }
    const e = this.view.m;
    for (let i = 0; i < 16; i++) cpu.wf(G.viewMatrix + 4 * i, e[i]);
    const a = (((this.view.fov * 32768 / 360 + 0.5) | 0) & 0xFFFF) - 1;   // SetNewClippingAngle
    cpu.wf(G.clipSin, 1 / Math.sin(a * TURN)); cpu.wf(G.clipTan, 1 / Math.tan(a * TURN));
  }

  /** One 60 Hz frame: exec_CarMain, then the traffic. input: { steer, accel, brake, drive, reverse }. */
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
    this.call(FN.execCarMain);
    const dh = ((cpu.r16(CAR + 0x86) - h0 + 0x8000) & 0xFFFF) - 0x8000;
    this.yawRate = dh * TURN;
    this.frames++;
    this.readBack();
    this.wheelSpin += cpu.rf(CAR + 0x160) * 2 * Math.PI / 3600;   // wheel rpm -> rad per frame
    // The traffic: entryCarPut(1) rebuilds the course occupancy grid and draws
    // (here: lists) the cars on screen, trafficControl spawns and removes,
    // nlExecuteEvent drives every car, ExecColliObj resolves the collisions.
    this.writeView();
    this.cars = [];
    this.tricks = [];
    this.call(FN.entryCarPut, { r4: 1 });
    this.call(FN.trafficControl, { r4: 1 });
    this.call(FN.executeEvent);
    this.call(FN.execColliObj);
  }

  /** How many traffic cars exist (CarEntryNum) and the density level (TrafficLevel). */
  get carCount() { return this.cpu.r32(G.carEntryNum); }
  get trafficLevel() { return this.cpu.r32(G.trafficLevel); }

  /** Every car that ran this frame (carEntry's list; the drawn ones are a subset in `cars`). */
  liveCars() {
    const cpu = this.cpu, n = cpu.r32(G.carListCount), out = [];
    for (let i = 0; i < n; i++) out.push(new TrafficCar(cpu, cpu.r32(G.carList + 4 * i), -1));
    return out;
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
