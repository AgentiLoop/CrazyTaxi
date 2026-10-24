// The game runs by its own code: the player's cab, the traffic, the camera, the
// run's clock and cash (GSystem) and the customers - who waits where, the stop, the
// get-in and get-out animations and camera cuts, the ride, the fare - from the USA
// executable (1ST_READ.BIN, code at 0x0C010000) execute in the SH-4 interpreter
// (src/sh4.js) over the city's course points (SPLDCn.BIN at 0x0C328000), collision
// (COLDCn.BIN at 0x0CB40000), the people's motions (MOTDC.BIN at 0x0C880000) and
// models (POLDC0.BIN at 0x0C390000), exactly as on the Dreamcast. Everything the
// routines would draw, play or rumble is stubbed or captured (hooks): the physics,
// the traffic, the passenger state machine (Psg_Execute), the driver (Act_Execute)
// and the game system are the original.
//
// Set-up (gameState0's order): the nl matrix stacks, nlInitHeapMemory, nlInitEvent,
// extRandomSeed(12345), init_GameSystem, InitColliObj, InitCollision, InitColliWall,
// init_CarMain, initCamera, SetStartCamera, InitKyakuStopArea, init_KyakuMain,
// Act_Init, entryCarPut(0), trafficControl(0). A frame (gameStateDrive's order):
// camUpdate, exec_GameSystem (the countdown: the start camera, the cab released at
// 60; the run: the clock, the customer's time; time up), exec_CarMain, exec_KyakuMain,
// ExecKyakuArea, Act_Execute, entryCarPut(1), trafficControl(1), nlExecuteEvent (every
// traffic car, train, signal and customer task is an event), ExecColliObj.
//
// GSystem (USA 0x0C1EC4A8; the decomp's EU 0x0C1EE788): +0x00 started, +0x04 aboard,
// +0x08 frames, +0x0C time, +0x10 pending bonus time, +0x14 delivered, +0x1C route,
// +0x20 cash (cents), +0x28 time money, +0x2C fare, +0x30 tips, +0x34 trip meter,
// +0x3C level, +0x44 customer time, +0x4C/+0x50 the FAST/SPEEDY limits, +0x58 chain,
// +0x5C picked up; the state at 0x0C1EC50C (0 countdown, 1 run, 2 time up), its
// counter 0x0C1EC510 (366 frames; 150 at time up). The HUD's fare roll (0x0C053FFA)
// adds fare + time money + tips into the cash when the card has rolled; the HUD does
// not run here, so the cash is paid the frame the customer is delivered.
//
// A customer task (kyakuTaskStart: set_event(0x248, kyakuTaskExec)): +0x0C the event
// function, +0x14 the customer record (40 bytes: +0 request state, +4 kind, +8 spot,
// +0x14 line index, +0x18 three destination stops, +0x1C three route lengths),
// +0x1C the passenger (tagPASSENGER: +0 character, +4 position, +0x10 heading,
// +0x20 state, +0x24 sub-state, +0x34 motion, +0x38 frame, +0x3C the Fcv pose buffer),
// +0x174 phase (1 waiting / getting in, 2 riding, then the get-out), +0x194 k,
// +0x198 the destination's entry in the stop table (0x0C177270, 24 bytes; entry
// 1 + stop), +0x19C the destination slot.
//
// People are captured as the game draws them: humanDraw(motion, character, frame)
// and VSklIpPlay(a, fa, b, fb, weight) play V motions (the standing customers), and
// FcvPlayBuffer(buffer, character) the key-curve poses (the driver, the get-in and
// get-out, the passenger in the cab) - with XMTRX, the world matrix of the figure.
//
// The camera (USA 0x0C1775C0; the decomp's EU 0x0C179840): +0x00 eye, +0x0C target,
// +0x18 three angles, +0x24 the camera matrix; the mode at 0x0C1775E0 (0 the chase
// camera: target = car + (0, 5, 17) in the car's axes, eye = car + (0, 15 + s/3,
// -60 - s + speed * k) with a smoothed speed term s, both eased by homing vectors,
// the eye pulled in front of walls by GetCollision; 7 the start camera, which
// SetStartCamera/ExecStartCamera play during the countdown; 9 the get-in and get-out
// cuts, KyaCamera). camUpdate rebuilds the perspective (60 degrees across a 4:3
// screen, 70 in parts of the start camera) and stores the view matrix at 0x0C2B0830,
// which entryCarPut's clipping (CheckClippingProject3D, the angle's 1/sin and 1/tan
// at 0x0C13DBC8/CC) uses.
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
import { readSprite, readGlyph, SAVE_SIZE } from './dc-menu.js';

export const STEP = 1 / 60;
export const WHEEL_RADIUS = 2.964;   // the drawn wheel (cab_0.glb); the physics uses +0x12C = 2.87
const TURN = Math.PI * 2 / 65536;
export const DC_ASPECT = 4 / 3;      // the Dreamcast's picture: the camera's field of view spans its width

const EXE_BASE = 0x0C010000;
const SPL_BASE = 0x0C328000;
const MOT_BASE = 0x0C880000;
const POL0_BASE = 0x0C390000;
const COL_BASE = 0x0CB40000;
const OBJ_BASE = 0x0CE90000, OBJ_SIZE = 0x8000;   // loadCity: gdc_FileLoad(OBJDCn, 0x8000), the set objects' groups
const CAR = 0x0C176E4C;
export const CASH_CAP = 9999999;
export const CRAZY_BOX = 2;           // Game_No / CourseMode of the Crazy Box

const G = {
  courseMode: 0x0C1EBF2C, gameNo: 0x0C1EBF30, miniGameNo: 0x0C1EBF34,
  cabType: 0x0C177208, reverseMode: 0x0C17720C, groundKind: 0x0C177210,
  startMode: 0x0C1EC07C,              // byte: 1 = the normal game start
  mainMode: 0x0C1EBF54,               // 1 = the game (not the attract demo)
  goiToolFlags: 0x0C2A2B28,           // GoiTool(0) sets 2: traffic on (getGoiToolFlag(2))
  endingFlag: 0x0C2A2B10, subwayFlag: 0x0C2A4C98,
  fov: 0x0C177624,                    // the camera's field of view (60; 70 in the start camera): the perspective, the clipping, entryCarPut's detail choice
  clipSin: 0x0C13DBC8, clipTan: 0x0C13DBCC,   // SetNewClippingAngle: 1 / sin, 1 / tan of the half angle
  viewMatrix: 0x0C2B0830,             // the view matrix camUpdate stores (column major; nlProjectScreen3D reads it)
  camera: 0x0C1775C0, camMode: 0x0C1775E0,    // eye, target, angles; the mode (VR_mode)
  heapPtr: 0x0C177764,
  options: 0x0C2881F0, optionDefaults: 0x0C09C5C0,
  menu: 0x0C29EEE0,                   // the menu state: +4 the mode, +8 the rules (init_GameSystem's start time: 0 arcade 50 s, 1/2/3 the 3/5/10 minute work)
  courseTable: 0x0C2A4350, courseCount: 0x0C2A4354,
  lineTable: 0x0C29F7E8, lineCount: 0x0C29F7EC,
  courseDirectory: 0x0C0C718C,        // {table, count} per city
  courseLineTbl: 0x0C0C2B64,          // course index words by Game_No + MiniGame_No
  stick: 0x0C1EC014, accel: 0x0C1EC018, brake: 0x0C1EC01C,
  buttonB: 0x0C1EBF87, buttonA: 0x0C1EBF88,
  taxiSW: 0x0C1EBF6C,                 // the pad: +0 held, +4 pressed, +8 released, +0xC last held, +0x10/+0x16 stick (0x8000 = centre)
  language: 0x0C29EEC8,               // 0 Japanese, else English
  carEntryNum: 0x0C2A2168, carListCount: 0x0C2A2188, carList: 0x0C2A218C,   // up to 100 cars
  carControlArea: 0x0C29F7D8, trafficLevel: 0x0C29F82C,
  gs: 0x0C1EC4A8, gameState: 0x0C1EC50C, gameCounter: 0x0C1EC510,
  frameCounter: 0x0C1EC050,           // the main loop's frame count (+1 after every frame; a traffic car's horn fires when &127 == 0, exec_CarSound's engine wobble)
  eventList: 0x0C177748,              // nlInitEvent's list: head, tail; an event: +4 prev, +8 next, +0xC function
  stopTable: 0x0C177270,              // kyakuInitStops' stop entries (24 bytes: stop, centre, +0x14 drop radius; entry 1 + stop)
  landmarkPicture: 0x0C0E37DC,        // the destination's landmark picture (PutLandmark draws it)
  // gdc_CourseStartLoadReq in the Crazy Box: the first course by MiniGame_No, a pointer to the
  // counts; the CourseMode 2 table of AFS entries by course (130; the decomp's EU 0x0C08D21C).
  boxCourseFirst: 0x0C0C71BC, boxCourseCount: 0x0C1231F0, boxCourseEntries: 0x0C08C7D4,
};
// The nl library's matrix stack: 16 (+1) matrices at 0x0C1BF7B8, as the game's start-up
// passes them to the init routine, which fills the slot descriptors at 0x0C2B067C
// (12 bytes each: u16 depth, u16 max, base, current; slot 0 = the current one, its
// index at 0x0C2B0678; 1 the model-view stack, 2 the camera, 3 the projection).
const MATRIX_STACK = 0x0C1BF7B8, MATRIX_STACK_SIZE = 16;
const HEAP = 0x0C177768, HEAP_SIZE = 0x30000;   // nlMalloc's block (events, grids)
const IDENTITY = [0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000];

const FN = {
  initMatrixStack: 0x0C0765E0,
  initHeap: 0x0C02937C, initEvent: 0x0C0294F6, seed: 0x0C048AA0, initColliObj: 0x0C031D3C,
  initCollision: 0x0C030CC4, initColliWall: 0x0C033374,
  initGameSystem: 0x0C02D10C, execGameSystem: 0x0C02D2D0,
  initCarMain: 0x0C023696, execCarMain: 0x0C023CF2,
  initCamera: 0x0C026768, camUpdate: 0x0C02693C, camSnapToCar: 0x0C0288C2,
  setStartCamera: 0x0C028FC6,
  setClippingAngle: 0x0C06A1FC,       // SetNewClippingAngle(fov): camUpdate calls it each frame
  initKyakuStopArea: 0x0C034B40, initKyakuMain: 0x0C025FD4, execKyakuMain: 0x0C026076, execKyakuArea: 0x0C034A88,
  kyakuTaskExec: 0x0C0248AC,
  actInit: 0x0C05FDD8, actExecute: 0x0C05FF20,
  // The Crazy Box: Init_DCmini (gameState0, after init_CarMain), execDCmini (gameStateDrive,
  // after trafficControl): the game by MiniGame_No, its rules and its 2D overlay.
  initDCmini: 0x0C05A4CC, execDCmini: 0x0C05A9D8,
  // callTryAgain: the game is over (Exec_Fault 180 frames after a fault, or the clear) - the
  // TRY AGAIN window (SetWindow(2)), voice 0x275, the songs stopped. The window's code does
  // not run here, so the game calls it again every frame: only the first call runs.
  callTryAgain: 0x0C03FC9A,
  // The window it opens (SetWindow(2): the table 0x0C09D340, windowTryAgain 0x0C03DCFE and its
  // two items, YES -> windowRetry, NO -> windowGoMenu) runs as Pause_ExecRenderTexture1st
  // runs it while the game stands still: menuReadPad(1) (the pad from TaxiSW), ExecWindow.
  // windowRetry / windowGoMenu are caught (`choice`): they would reload the course or the menu.
  menuReadPad: 0x0C03AB56, execWindow: 0x0C03AAC0,
  windowRetry: 0x0C03D356, windowGoMenu: 0x0C03D386,
  // The text printer (InitSys: pfInit(0)) and pfPutc, every character the windows print.
  pfInit: 0x0C03022C, putc: 0x0C03055E,
  soundCommand: 0x0C07EA8C,           // the menus' cursor and decide sounds: the sound driver's command ring
  // End_Excellent: the clear's record window has been up 210 frames (Exec_Excellent) - the
  // game moves on (sub mode 2: gameState2 goes back to the Crazy Box's menu) and is over too.
  endExcellent: 0x0C05AC28,
  // BupInit (the boot's set-up): the settings' defaults, the four players' records
  // (saveBufferInit: the default name, no box cleared, every rank empty), the rankings'
  // defaults. Put_Record_Window's CheckRanking then files a clear in the player's record
  // (the box's ranks, the cleared bit CheckBoxFlag unlocks the next boxes by).
  bupInit: 0x0C039994,
  // The Crazy Box's 2D overlay is the game's own: execDCmini's Put_JumpDistance, the games'
  // timers and counts, Start_Fault / Start_Excellent's banners, and Put_ReadySetGo (the
  // READY / GO countdown and its two voices, stubbed in the other modes) all end in
  // nlSprPut(record), which is kept as `sprites` (readSprite, the menu's) for MenuView.
  sprPut: 0x0C07D018, putReadySetGo: 0x0C05ACCC,
  // The Crazy Box's own 3D objects: nlObjPutUseViewMatrixTrnsl(model, alpha) (Crazy Balloons'
  // Exec_Balloon: its 20 balloons, POLDC0 0xDF828, 2.4 times; 4.8 times POLDC3 0x1998 once
  // hit), drawn in XMTRX with the fade colour nlObjPutSetFadeColorBase sets (0x0C148678).
  objPutTrnsl: 0x0C079030, fadeColourBase: 0x0C148678,
  // The set objects (OBJDCn.BIN's groups, loaded at 0x0CE90000): InitSetObject picks the
  // groups a run opens (the Crazy Box: a range per game - Crazy Bowling's pins are group 0),
  // ExecSetObject opens them (each group an event: setObjGroupExec), SetObjFly moves and
  // draws each object with nlObjPutUseViewMatrix; setObjHitPin counts the pins knocked down.
  initSetObject: 0x0C037728, execSetObject: 0x0C03768A, setObjFly: 0x0C036ED0, setObjFlyEnd: 0x0C03734C,
  objPut: 0x0C078FC0,
  // ExecArrow's guide arrow (Crazy Bowling's over the next lane, Exec_DCmini_Game1's near the
  // goal; green by nlObjPutSetFadeColor): nlObjPut(model) from its call at 0x0C035488, XMTRX
  // the arrow in view space (camUpdate's view matrix, this frame's, already applied).
  arrowPut: 0x0C078F90, execArrowPut: 0x0C035488,
  entryCarPut: 0x0C043BA2, trafficControl: 0x0C041ACC, executeEvent: 0x0C0296B6, execColliObj: 0x0C031EE4,
  putCarModel: 0x0C0434D0, putTrainModel: 0x0C0437FE,
  putPlayerCar: 0x0C0203E8, putPlayerCarByView: 0x0C0200E4,
  setTechnicalBonus: 0x0C042364,
  humanDraw: 0x0C0689D4, vsklIpPlay: 0x0C0693D8, fcvPlayBuffer: 0x0C065F6C,
  soundRequest: 0x0C071338, voiceRequest: 0x0C0720E8, setLandmark: 0x0C030802,
  // The sound (see src/audio.js): the sound driver's interactive controls (the engine
  // and tyres, from init_CarSound and exec_CarSound), the voice channels' script player
  // (Voice_Init, Voice_Execute -> Voice_ExecuteChannel -> the ADX voice stream calls)
  // and the song jukebox (gdc_InitStreamSongDisk, gdc_PlayStreamSongDisk at the
  // countdown's 60, gdc_ExecStreamSongDisk each frame -> the ADX song stream calls).
  icsControl: 0x0C07E88A,                                     // nlsndIcsControl(slot, command, value)
  voiceInit: 0x0C071FA4, voiceExecute: 0x0C072022,
  voiceStreamStart: 0x0C02DCFC,                               // adxStartAfs2(channel, file)
  voiceStreamVol: 0x0C02DD14, voiceStreamPan: 0x0C02DD50,     // gdc_StreamVoiceVol(channel, level), gdc_StreamVoicePan
  voiceStreamStat: 0x0C02DBDC, voiceStreamTime: 0x0C02DC78,   // gdc_GetStreamVoiceStat2, gdc_GetStreamVoicePlayTime (frames)
  voiceStreamStop: 0x0C02DC0C, voiceStreamStopAll: 0x0C02DC1A,
  initSongDisk: 0x0C02DA28, playSongDisk: 0x0C02DA56, execSongDisk: 0x0C02DAB0,
  songStreamStart: 0x0C02D734,                                // adxStartAfs1(channel, file)
  songStreamStopAll: 0x0C02D75A, songStreamRemain: 0x0C02D7F8,   // gdc_StopStreamSongAll, gdc_GetStreamSongRemainTime (frames)
  adxtSetOutVol: 0x0C15000E,                                  // ADXT_SetOutVol(handle, tenths of dB): the song's volume and fades
};
// Routines the game reaches that draw, play, rumble or feed other systems:
// stubbed (they return 0).
const STUBS = [
  0x0C035884, // InitEffect
  0x0C036A40, // InitSpark
  0x0C04B14A, // getReplayPoint
  0x0C03858C, // PutMVObj (the cab's shadow volume; putPlayerCar itself runs: its GetRotVec
              // stores the cab's rotation vectors at +0x30, which the collision objects need)
  0x0C04AE88, // replay
  0x0C0206DC, // carRumble
  0x0C05E1D0, // ndPuru2Start
  0x0C035C40, // SetEffect
  0x0C035F68, // ExecEffect
  0x0C036A90, // ExecSpark
  0x0C02E3F4, // gdc_CoursePointLoadReq
  0x0C02A814, // navi_GetRouteDataC
  0x0C07A210, // nlObjPutMvInit (a PVR register)
  0x0C0460C4, // RailroadAreaCheck (fog by the rails)
  0x0C078FC0, // nlObjPutUseViewMatrix (every model draw: the cab, the cable; it writes the
              // renderer's state over the matrix stack descriptor here)
  0x0C030868, // PutLandmark (the HUD's destination picture; SetLandmark is captured)
  // The HUD's sprites the game system and the customer code call into (hudDraw itself
  // does not run): the countdown figures, the clock's time bonus roll, the fare
  // card, "pick someone up", the arrow and the result screen; the Crazy Box's
  // Put_ReadySetGo (0x0C05ACCC) runs in the Crazy Box (FN.putReadySetGo).
  0x0C0521C8, 0x0C0526B8, 0x0C052316, 0x0C0523B2, 0x0C052716, 0x0C052678, 0x0C05273E, 0x0C05296C, 0x0C05ACCC,
];

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
   * @param {{exe: Uint8Array, courses: Uint8Array, collision: Uint8Array, motions: Uint8Array, people: Uint8Array}} data the disc files
   * @param {{city?: number, cab?: number, rules?: number, reverse?: boolean}} opts city 0 Arcade, 1 Original; rules 0 arcade, 1/2/3 the 3/5/10 minute work
   */
  constructor(data, opts = {}) {
    const cpu = new SH4();
    this.cpu = cpu;
    cpu.load(EXE_BASE, data.exe);
    cpu.load(SPL_BASE, data.courses);
    cpu.load(COL_BASE, data.collision);
    if (data.motions) cpu.load(MOT_BASE, data.motions);
    if (data.people) cpu.load(POL0_BASE, data.people);
    this.setObjectFile = data.objects ? data.objects.subarray(0, OBJ_SIZE) : null;
    for (const a of STUBS) cpu.hooks.set(a, () => 0);
    /** @type {object[]} the Crazy Box: the sprites nlSprPut drew this frame (see FN.sprPut) */
    this.sprites = [];
    if (opts.city === CRAZY_BOX) {
      cpu.hooks.delete(FN.putReadySetGo);
      cpu.hooks.set(FN.sprPut, (c) => { this.sprites.push(readSprite(c, c.r[4] >>> 0)); return 0; });
      // The windows' text (the TRY AGAIN window's, the records'): pfPutc's glyphs with the sprites.
      cpu.hooks.set(FN.putc, (c) => { const g = readGlyph(c, c.r[4] << 24 >> 24); if (g) this.sprites.push(g); return false; });
      cpu.hooks.set(FN.soundCommand, (c) => { const word = c.r[4] >>> 0; this.sounds.push({ word, channel: -1 }); if (this.audio) this.audio.sound(word); return 0; });
      cpu.hooks.set(FN.objPutTrnsl, (c) => {
        const matrix = new Float32Array(16);
        for (let i = 0; i < 16; i++) matrix[i] = c.xf(i);
        const colour = [0, 1, 2].map((i) => c.rf(FN.fadeColourBase + i * 4));
        this.objects.push({ model: c.r[4] >>> 0, matrix, colour, alpha: c.f(4) });
        return 0;
      });
      // The set objects SetObjFly draws (textured, opaque); every other model draw stays stubbed.
      cpu.hooks.set(FN.objPut, (c) => {
        const pr = c.pr >>> 0;
        if (pr >= FN.setObjFly && pr < FN.setObjFlyEnd) this.objects.push({ model: c.r[4] >>> 0, matrix: xmtrx(c), setObject: true });
        return 0;
      });
      cpu.hooks.set(FN.arrowPut, (c) => {
        if ((c.pr >>> 0) === FN.execArrowPut) {
          const view = new Float32Array(16);
          for (let i = 0; i < 16; i++) view[i] = c.rf(G.viewMatrix + 4 * i);
          const colour = [0, 1, 2].map((i) => c.rf(FN.fadeColourBase + i * 4));
          this.objects.push({ model: c.r[4] >>> 0, matrix: xmtrx(c), view, colour, alpha: 1 });
        }
        return false;
      });
    }
    /** @type {object[]} the Crazy Box: the models its games drew this frame (see FN.objPutTrnsl) */
    this.objects = [];
    // getNearLineIndexAll runs only from carGroundCheck's out-of-world recovery here: count it, then let it run.
    cpu.hooks.set(0x0C048ED2, () => { this.recoveries++; return false; });
    // SetNewClippingAngle(fov): the clipping half angle the traffic (CheckClippingProject3D)
    // and the people (CheckClipping) are culled with is the 4:3 picture's horizontal one.
    // On a wider picture (aspect, from the window; the vertical view is kept) the angle
    // widens with it, so nothing pops in at the sides; at 4:3 the game's own code runs.
    cpu.hooks.set(FN.setClippingAngle, (c) => {
      if (this.aspect === DC_ASPECT) return false;
      const half = Math.atan(Math.tan(c.f(4) * Math.PI / 360) * this.aspect / DC_ASPECT);
      cpu.wf(G.clipSin, 1 / Math.sin(half));
      cpu.wf(G.clipTan, 1 / Math.tan(half));
      return 0;
    });
    // entryCarPut draws a car: keep it for the renderer instead.
    const put = (c) => { this.cars.push(new TrafficCar(c, c.r[4], c.r[5])); return 0; };
    cpu.hooks.set(FN.putCarModel, put);
    cpu.hooks.set(FN.putTrainModel, put);
    // exec_CarMain draws the cab (putPlayerCarByView; putPlayerCar for cabs 4+) BEFORE it
    // moves it, so the cab on screen - like the camera (camUpdate runs first) and the
    // driver and passenger, drawn in its body matrix +0xB4 - is a frame behind the
    // physics. Keep the pose it draws; the routine itself runs (GetRotVec, +0xB4).
    const drawn = () => { this.readPose(this.drawn); return false; };
    cpu.hooks.set(FN.putPlayerCar, drawn);
    cpu.hooks.set(FN.putPlayerCarByView, drawn);
    // setTechnicalBonus(kind, count): the trick bonuses (Crazy Through...) - counted, not displayed yet.
    cpu.hooks.set(FN.setTechnicalBonus, (c) => { if ((c.r[4] | 0) >= 0) this.tricks.push({ kind: c.r[4] | 0, count: c.r[5] | 0 }); return 0; });
    // The people, as drawn (see the header); XMTRX holds the figure's world matrix.
    const xmtrx = (c) => { const m = new Float32Array(16); for (let i = 0; i < 16; i++) m[i] = c.xf(i); return m; };
    cpu.hooks.set(FN.humanDraw, (c) => {
      this.people.push({ kind: 'v', chara: c.r[5], motion: c.r[4] >>> 0, frame: c.r[6], matrix: xmtrx(c) });
      return 0;
    });
    cpu.hooks.set(FN.vsklIpPlay, (c) => {
      this.people.push({ kind: 'blend', chara: c.r32(c.r[15]), motion: c.r[4] >>> 0, frame: c.r[5], motionB: c.r[6] >>> 0, frameB: c.r[7], weight: c.f(4), matrix: xmtrx(c) });
      return 0;
    });
    cpu.hooks.set(FN.fcvPlayBuffer, (c) => {
      const b = c.r[4] >>> 0, buffer = new Array(17);
      for (let i = 0; i < 17; i++) {
        const a = b + 12 * i;
        buffer[i] = i < 5 ? [c.rf(a), c.rf(a + 4), c.rf(a + 8)] : [c.rs32(a), c.rs32(a + 4), c.rs32(a + 8)];
      }
      this.people.push({ kind: 'fcv', chara: c.r[5], buffer, matrix: xmtrx(c) });
      return 0;
    });
    // The sound (src/audio.js plays it through `audio`; the lists are kept for tests).
    // Sound_Request(word, channel): the one-shot effects - horns, bells, the trick jingles.
    cpu.hooks.set(FN.soundRequest, (c) => {
      const word = c.r[4] >>> 0;
      this.sounds.push({ word, channel: c.r[5] });
      if (this.audio) this.audio.sound(word);
      return 0;
    });
    // Voice_Request(script, channel, volume, pan) runs: it queues the script on its channel's
    // slot, which Voice_Execute plays step by step through the stream calls below.
    cpu.hooks.set(FN.voiceRequest, (c) => { this.voices.push({ id: c.r[4], channel: c.r[5] }); return false; });
    cpu.hooks.set(FN.voiceStreamStart, (c) => { if (this.audio) this.audio.voiceStart(c.r[4], c.r[5]); return 0; });
    cpu.hooks.set(FN.voiceStreamVol, (c) => { if (this.audio) this.audio.voiceVolume(c.r[4], c.r[5] << 24 >> 24); return 0; });
    cpu.hooks.set(FN.voiceStreamPan, () => 0);
    cpu.hooks.set(FN.voiceStreamStat, (c) => (this.audio ? this.audio.voicePlaying(c.r[4]) : 0));
    cpu.hooks.set(FN.voiceStreamTime, (c) => (this.audio ? this.audio.voicePlayTime(c.r[4]) : 0));
    cpu.hooks.set(FN.voiceStreamStop, (c) => { if (this.audio) this.audio.voiceStop(c.r[4]); return 0; });
    cpu.hooks.set(FN.voiceStreamStopAll, () => { if (this.audio) this.audio.voiceStopAll(); return 0; });
    // The engine and tyres: nlsndIcsControl(slot, command, value) from init_CarSound / exec_CarSound.
    cpu.hooks.set(FN.icsControl, (c) => { if (this.audio) this.audio.icsControl(c.r[4], c.r[5], c.r[6]); return 0; });
    // The songs: gdc_PlayStreamSongDisk runs (exec_GameSystem calls it when the cab is
    // released); the ADX stream it drives is the audio's.
    cpu.hooks.set(FN.playSongDisk, () => { this.musicCue = true; return false; });
    cpu.hooks.set(FN.songStreamStart, (c) => { if (this.audio) this.audio.songStart(c.r[5]); return 0; });
    cpu.hooks.set(FN.songStreamStopAll, () => { if (this.audio) this.audio.songStop(); return 0; });
    cpu.hooks.set(FN.songStreamRemain, () => (this.audio ? this.audio.songRemain() : 0x58764));
    cpu.hooks.set(FN.adxtSetOutVol, (c) => { if (this.audio) this.audio.songVolume(c.r[5] | 0); return 0; });
    cpu.hooks.set(FN.setLandmark, (c) => { this.landmark = c.r[4] | 0; return 0; });
    cpu.hooks.set(FN.callTryAgain, () => {
      if (this.tryAgain) return 0;
      this.tryAgain = true;
      return false;
    });
    cpu.hooks.set(FN.endExcellent, () => { this.tryAgain = this.cleared = true; this.choice = 'menu'; return false; });
    cpu.hooks.set(FN.windowRetry, () => { this.choice = 'retry'; return 0; });
    cpu.hooks.set(FN.windowGoMenu, () => { this.choice = 'menu'; return 0; });
    this.audio = opts.audio || null;
    this.aspect = DC_ASPECT;              // the picture's width / height the culling is for (main.js: the window's)
    this.city = opts.city || 0;
    this.cab = opts.cab || 0;
    // The Crazy Box (city 2): MiniGame_No is the game (0-15; menuSetMode: the box's item - 2).
    this.miniGame = this.city === CRAZY_BOX ? opts.miniGame || 0 : 0;
    // CourseMode, the city whose data is loaded: the Crazy Box's own, but game 15 drives
    // the Arcade city (menuSetMode); Game_No stays 2 (Init_DCmini, execDCmini).
    this.courseMode = courseModeOf(this.city, this.miniGame);
    cpu.w32(G.courseMode, this.courseMode);
    cpu.w32(G.gameNo, this.city);
    cpu.w32(G.miniGameNo, this.miniGame);
    cpu.w32(G.cabType, this.cab);
    cpu.w32(G.reverseMode, opts.reverse ? 1 : 0);
    cpu.w32(G.menu + 4, this.city);
    cpu.w32(G.menu + 8, this.city === CRAZY_BOX ? this.miniGame + 2 : opts.rules || 0);
    cpu.w8(G.startMode, 1);
    cpu.w32(G.mainMode, 1);
    cpu.w32(G.goiToolFlags, 2);
    cpu.w32(G.endingFlag, 0);
    cpu.w32(G.subwayFlag, 0);
    // The settings (0x0C2881F0): the boot's set-up (0x0C0399B4) copies the defaults in -
    // byte 1 the start time (4: 50 s), byte 2 the customer time offset (3: none).
    this.call(FN.bupInit);
    for (let i = 0; i < 16; i++) cpu.w8(G.options + i, cpu.r8(G.optionDefaults + i));
    // The memory card's save (the settings and the records, see save()), when there is one.
    if (opts.save) cpu.ram.set(opts.save.subarray(0, SAVE_SIZE), G.options & 0x00FFFFFF);
    // The Crazy Box's windows print with the text printer: InitSys's language (English) and pfInit(0).
    if (this.city === CRAZY_BOX) {
      cpu.w32(G.language, 1);
      this.call(FN.pfInit, { r4: 0 });
    }
    // CourseTableSet(city) and init_GameSystem's course line.
    const table = cpu.r32(G.courseDirectory + this.courseMode * 8), count = cpu.r32(G.courseDirectory + this.courseMode * 8 + 4);
    cpu.w32(G.courseTable, table); cpu.w32(G.courseCount, count);
    const rec = table + cpu.r32(G.courseLineTbl + (this.city + this.miniGame) * 4) * 12;
    cpu.w32(G.lineTable, cpu.r32(rec)); cpu.w32(G.lineCount, cpu.r32(cpu.r32(rec + 4)));

    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.heading = 0; this.pitch = 0; this.roll = 0;
    this.bodyPitch = 0; this.bodyRoll = 0;   // the body's tilt on the chassis (+0xAC about x, +0xB0 about z)
    this.speed = 0;            // units per second (+0x15C * 60)
    this.steer = 0;            // front wheel angle, rad
    this.wheelSteer = [0, 0, 0, 0];
    this.wheelHeight = [0, 0, 0, 0];   // the drawn wheel hub's height in the car's frame
    this.wheelSpin = 0;
    /** The cab as the game draws it this frame (see the putPlayerCar hook): what the renderer should show. */
    this.drawn = { pos: { x: 0, y: 0, z: 0 }, pitch: 0, heading: 0, roll: 0, bodyPitch: 0, bodyRoll: 0, wheelSteer: [0, 0, 0, 0], wheelHeight: [0, 0, 0, 0] };
    this.gear = 1;
    this.rpm = 0;
    this.groundKind = -1;
    this.onGround = true;
    this.yawRate = 0;          // heading change per frame, rad
    this.recoveries = 0;
    this.stickX = 0;
    this.frames = 0;
    /** @type {TrafficCar[]} the traffic cars entryCarPut drew this frame */
    this.cars = [];
    this.tricks = [];
    this.people = [];
    this.sounds = [];
    this.voices = [];
    this.events = [];
    this.landmark = -1;
    this.musicCue = false;
    this.customerTimeTotal = 0;
    this.paid = null;
    this.init();
  }

  /** The game's set-up (gameState0): matrix stacks, heap, events, RNG, the game system, collision objects, init_CarMain, the camera, the customers, the driver, the traffic. */
  init() {
    const cpu = this.cpu;
    this.tryAgain = false;
    this.cleared = false;
    this.choice = null;   // the end's choice: 'retry' (the TRY AGAIN window's YES) or 'menu' (NO, or after a clear)
    this.held = 0;
    this.call(FN.initMatrixStack, { r4: MATRIX_STACK, r5: MATRIX_STACK_SIZE });
    cpu.w32(G.heapPtr, HEAP);
    this.call(FN.initHeap, { r4: HEAP, r5: HEAP_SIZE });
    this.call(FN.initEvent);
    this.call(FN.seed, { r4: 0x3039 });
    // The sound's set-up (InitSys / gameState2 / loadCity): the voice channels, the jukebox
    // (the master volume from the settings' byte 4), the engine's controls off.
    this.call(FN.voiceInit);
    this.call(FN.initSongDisk);
    if (this.audio) this.audio.reset();
    this.call(FN.initGameSystem);
    this.call(FN.initColliObj, { r4: this.cab });
    this.call(FN.initCollision);
    // InitCollision runs InitColliWall itself (for the Crazy Box with MiniGame_No's walls).
    if (this.courseMode !== CRAZY_BOX) this.call(FN.initColliWall);
    // The Crazy Box's set objects (Crazy Bowling's pins...): the file afresh, InitSetObject.
    if (this.setObjects) {
      cpu.load(OBJ_BASE, this.setObjectFile);
      this.call(FN.initSetObject);
    }
    this.call(FN.initCarMain);
    if (this.city === CRAZY_BOX) this.call(FN.initDCmini);
    this.call(FN.initCamera, { r4: 0 });
    if (this.city !== CRAZY_BOX) this.call(FN.setStartCamera);
    this.call(FN.initKyakuStopArea);
    if (this.kyaku) this.call(FN.initKyakuMain);
    this.call(FN.actInit);
    this.call(FN.entryCarPut, { r4: 0 });
    this.call(FN.trafficControl, { r4: 0 });
    this.stickX = 0;
    this.cars = [];
    this.tricks = [];
    this.people = [];
    this.sounds = [];
    this.voices = [];
    this.events = [];
    this.musicCue = false;
    this.customerTimeTotal = 0;
    this.paid = null;
    this.readBack();
    this.readPose(this.drawn);
  }

  /** A routine with XMTRX = the world matrix (identity), as the frame leaves it for the game's code. */
  call(fn, regs) {
    for (let i = 0; i < 16; i++) this.cpu.xfSet(i, IDENTITY[i]);
    // init_KyakuMain's stop set-up searches every course point per stop: 9.5 M instructions in the Original city.
    return this.cpu.call(fn, regs, 50000000);
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
    this.call(FN.camSnapToCar, { r4: 0 });   // the camera's homing vectors start over on the car
    this.readBack();
    this.readPose(this.drawn);
  }

  forward() {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  /**
   * The game's camera this frame (camUpdate): eye, target (world), the horizontal field of
   * view in degrees across the 4:3 screen, the mode (0 chase, 7 the start camera, 9 the
   * get-in/out cut) and the view matrix (16 floats, column major - three.js
   * camera.matrixWorldInverse's layout).
   */
  camera() {
    const cpu = this.cpu, c = G.camera;
    const view = new Float32Array(16);
    for (let i = 0; i < 16; i++) view[i] = cpu.rf(G.viewMatrix + 4 * i);
    return {
      eye: [cpu.rf(c), cpu.rf(c + 4), cpu.rf(c + 8)],
      target: [cpu.rf(c + 12), cpu.rf(c + 16), cpu.rf(c + 20)],
      angles: [cpu.rs16(c + 24), cpu.rs16(c + 26), cpu.rs16(c + 28)],
      fov: cpu.rf(G.fov), mode: cpu.r32(G.camMode), view,
    };
  }

  /** The run's numbers (GSystem; see the header). Money in cents, times in frames. */
  gameSystem() {
    const cpu = this.cpu, g = G.gs;
    return {
      state: cpu.r32(G.gameState), counter: cpu.rs32(G.gameCounter),
      started: cpu.r32(g), aboard: cpu.r32(g + 4), frames: cpu.r32(g + 8), time: cpu.rs32(g + 0xC),
      pending: cpu.rs32(g + 0x10), delivered: cpu.r32(g + 0x14), route: cpu.rf(g + 0x1C),
      cash: cpu.r32(g + 0x20), timeMoney: cpu.r32(g + 0x28), fare: cpu.r32(g + 0x2C), tips: cpu.r32(g + 0x30),
      trip: cpu.rf(g + 0x34), level: cpu.r32(g + 0x3C), customerTime: cpu.rs32(g + 0x44),
      fastLimit: cpu.r32(g + 0x4C), speedyLimit: cpu.r32(g + 0x50), chain: cpu.r32(g + 0x58), pickedUp: cpu.r32(g + 0x5C),
      customerTimeTotal: this.customerTimeTotal, landmark: cpu.r32(G.landmarkPicture), landmarkMode: this.landmark,
    };
  }

  /** Every customer task alive (the event list; see the header), in the list's order. */
  customers() {
    const cpu = this.cpu, out = [];
    for (let e = cpu.r32(G.eventList); e; e = cpu.r32(e + 8)) {
      if (cpu.r32(e + 0xC) !== FN.kyakuTaskExec) continue;
      const rec = cpu.r32(e + 0x14), p = e + 0x1C;
      out.push({
        task: e, record: rec, request: cpu.r32(rec), kind: cpu.r32(rec + 4),
        spot: [cpu.rf(rec + 8), cpu.rf(rec + 12), cpu.rf(rec + 16)],
        chara: cpu.r32(p), pos: [cpu.rf(p + 4), cpu.rf(p + 8), cpu.rf(p + 12)], heading: cpu.r16(p + 0x10),
        state: cpu.r32(p + 0x20), sub: cpu.r32(p + 0x24),
        phase: cpu.r32(e + 0x174), k: cpu.rf(e + 0x194), slot: cpu.r32(e + 0x19C),
        stop: ((cpu.r32(e + 0x198) - G.stopTable) / 24 | 0) - 1,
      });
    }
    return out;
  }

  /** The customer who boarded (request state 5: getting in, riding or getting out), if any. */
  rider() {
    return this.customers().find((t) => t.request === 5) || null;
  }

  /**
   * One 60 Hz frame (see the header for the order). input: { steer, accel, brake, drive, reverse }.
   * Afterwards `events` lists what happened: in (a customer boarded), out (delivered: rating,
   * paid), eject (gave up), timeUp.
   */
  update(input) {
    const cpu = this.cpu, g = G.gs;
    this.events = [];
    this.sprites = [];
    this.objects = [];
    this.sounds = [];
    this.voices = [];
    this.musicCue = false;
    const before = { aboard: cpu.r32(g + 4), delivered: cpu.r32(g + 0x14), state: cpu.r32(G.gameState) };
    // The camera first (gameStateDrive's order): it follows the last frame's car.
    this.call(FN.camUpdate, { r4: 0 });
    this.call(FN.execGameSystem);
    this.call(FN.execSongDisk);   // the jukebox: fades the song out over its last 120 frames, then the next of four
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
    const h0 = cpu.r16(CAR + 0x86);
    this.call(FN.execCarMain);
    const dh = ((cpu.r16(CAR + 0x86) - h0 + 0x8000) & 0xFFFF) - 0x8000;
    this.yawRate = dh * TURN;
    this.frames++;
    this.readBack();
    this.wheelSpin += cpu.rf(CAR + 0x160) * 2 * Math.PI / 3600;   // wheel rpm -> rad per frame
    // The customers (exec_KyakuMain starts the tasks; they run in nlExecuteEvent), the
    // pick-up area, the driver, then the traffic: entryCarPut(1) rebuilds the course
    // occupancy grid and draws (here: lists) the cars inside the camera's cone,
    // trafficControl spawns and removes, nlExecuteEvent drives every car and every
    // customer task, ExecColliObj resolves the collisions.
    this.cars = [];
    this.tricks = [];
    this.people = [];
    if (this.kyaku) this.call(FN.execKyakuMain);
    if (this.setObjects) this.call(FN.execSetObject);
    if (this.courseMode !== CRAZY_BOX || this.miniGame !== 0) this.call(FN.execKyakuArea);
    this.call(FN.actExecute);
    this.call(FN.entryCarPut, { r4: 1 });
    this.call(FN.trafficControl, { r4: 1 });
    if (this.city === CRAZY_BOX) this.call(FN.execDCmini);
    this.call(FN.executeEvent);
    this.call(FN.execColliObj);
    this.call(FN.voiceExecute);   // the system tick after the game's frame: the voice channels' scripts
    cpu.w32(G.frameCounter, (cpu.r32(G.frameCounter) + 1) >>> 0);   // the main loop counts the frame (0x0C1EC050)
    // What the game system recorded this frame.
    const aboard = cpu.r32(g + 4), delivered = cpu.r32(g + 0x14);
    if (aboard && !before.aboard) {
      this.customerTimeTotal = cpu.rs32(g + 0x44);
      this.events.push({ type: 'in', customer: this.rider() });
    } else if (before.aboard && !aboard) {
      if (delivered > before.delivered) {
        // GS_GuestOut rated and set the time money; the HUD's fare roll pays (0x0C053FFA).
        const fare = cpu.r32(g + 0x2C), timeMoney = cpu.r32(g + 0x28), tips = cpu.r32(g + 0x30);
        const left = timeMoney / 10;
        const rating = left <= cpu.r32(g + 0x4C) ? 0 : left >= cpu.r32(g + 0x50) ? 2 : 1;
        const total = fare + timeMoney + tips;
        cpu.w32(g + 0x20, Math.min(CASH_CAP, cpu.r32(g + 0x20) + total));
        cpu.w32(g + 0x2C, 0); cpu.w32(g + 0x28, 0); cpu.w32(g + 0x30, 0);
        this.paid = { rating, fare, timeMoney, tips, total, bonus: [0, 120, 300][rating] };
        this.events.push({ type: 'out', ...this.paid });
      } else {
        this.events.push({ type: 'eject' });
      }
    }
    if (cpu.r32(G.gameState) === 2 && before.state !== 2) this.events.push({ type: 'timeUp' });
  }

  /** Whether the set objects run: the Crazy Box's (OBJDCn.BIN given). */
  get setObjects() { return this.city === CRAZY_BOX && !!this.setObjectFile; }

  /** Whether the customers run: everywhere but the Crazy Box's games 0-3 (gameState0, gameStateDrive). */
  get kyaku() { return this.courseMode !== CRAZY_BOX || this.miniGame > 3; }

  /**
   * The Crazy Box course's BINC3 entries this game loads (gdc_CourseStartLoadReq: the courses
   * first[MiniGame_No] .. + count[MiniGame_No], each the AFS entry gdc_CourseReq reads from the
   * CourseMode 2 table), or null outside the Crazy Box course (game 15 is in the Arcade city).
   * BINC3 holds every game's pieces in the same space; only these are drawn.
   */
  courseEntries() {
    if (this.courseMode !== CRAZY_BOX) return null;
    const cpu = this.cpu, first = cpu.r32(G.boxCourseFirst + 4 * this.miniGame);
    const count = cpu.r32(cpu.r32(G.boxCourseCount) + 4 * this.miniGame);
    const out = [];
    for (let i = first; i < first + count; i++) out.push(cpu.r32(G.boxCourseEntries + 4 * i));
    return out;
  }

  /**
   * The Crazy Box game's state (USA addresses of the decomp's 0x0C2A992C etc.): flags (0x20 Start_Fault,
   * 0x10 Start_Excellent; game 0 starts with 4), the fault's reason and the game's score word.
   * Exec_Fault ends the game 180 frames after a fault; `over`: the game has ended (callTryAgain,
   * or End_Excellent after the clear - which takes 0x10 off, `excellent` stays).
   */
  crazyBox() {
    const cpu = this.cpu;
    const flags = cpu.r16(0x0C2A6E24);
    return { flags, fault: !!(flags & 0x20), excellent: !!(flags & 0x10) || this.cleared, reason: cpu.r32(0x0C2A6E28), score: cpu.rs32(0x0C2A6DEC), over: this.tryAgain };
  }

  /**
   * One frame of the window callTryAgain opened (the game stands still, as gameStateDrive
   * does while Pause_ExecRenderTexture1st runs it): the pad into TaxiSW, menuReadPad(1),
   * ExecWindow (windowTryAgain: the window opening, the cursor, YES / NO; A on YES ->
   * windowRetry, A on NO or B -> windowGoMenu), the voices. Afterwards `sprites` holds the
   * window's sprites and text and `choice` is set once a choice is made.
   * @param {number} buttons the pad bits held this frame (dc-menu's PAD)
   */
  windowFrame(buttons = 0) {
    const cpu = this.cpu, sw = G.taxiSW;
    this.sprites = [];    // the game's models (`objects`) stay as they were drawn
    this.sounds = [];
    this.voices = [];
    cpu.w32(sw + 4, buttons & ~this.held);
    cpu.w32(sw + 8, this.held & ~buttons);
    cpu.w32(sw + 12, this.held);
    cpu.w32(sw, buttons);
    cpu.w16(sw + 0x10, 0x8000);
    cpu.w16(sw + 0x16, 0x8000);
    this.held = buttons;
    this.call(FN.menuReadPad, { r4: 1 });
    this.call(FN.execWindow);
    this.call(FN.voiceExecute);
    cpu.w32(G.frameCounter, (cpu.r32(G.frameCounter) + 1) >>> 0);
  }

  /**
   * The memory card's save as the game keeps it in RAM: the settings at 0x0C2881F0, the
   * players' records from +0x10 (0x788 bytes each: the name, +4 the boxes cleared, +0x3C8
   * the boxes' ranks) and the rankings - the 0x25B0 bytes BupInit backs up.
   */
  save() {
    const a = G.options & 0x00FFFFFF;
    return this.cpu.ram.slice(a, a + SAVE_SIZE);
  }

  /** How many traffic cars exist (CarEntryNum) and the density level (TrafficLevel). */
  get carCount() { return this.cpu.r32(G.carEntryNum); }
  get trafficLevel() { return this.cpu.r32(G.trafficLevel); }
  /** Car_Data + 0x54: 0 while the game holds the cab (the countdown, a customer getting in or out). */
  get control() { return this.cpu.r32(CAR + 0x54); }

  /** Every car that ran this frame (carEntry's list; the drawn ones are a subset in `cars`). */
  liveCars() {
    const cpu = this.cpu, n = cpu.r32(G.carListCount), out = [];
    for (let i = 0; i < n; i++) out.push(new TrafficCar(cpu, cpu.r32(G.carList + 4 * i), -1));
    return out;
  }

  /**
   * The cab's pose as putPlayerCar draws it: position, pitch/heading/roll, the body's tilt
   * on the chassis (+0xAC about x, +0xB0 about z), the wheels' steering and hub heights.
   */
  readPose(into) {
    const cpu = this.cpu;
    into.pos.x = cpu.rf(CAR + 0x78); into.pos.y = cpu.rf(CAR + 0x7C); into.pos.z = cpu.rf(CAR + 0x80);
    into.pitch = cpu.rs16(CAR + 0x84) * TURN;
    into.heading = cpu.r16(CAR + 0x86) * TURN;
    into.roll = cpu.rs16(CAR + 0x88) * TURN;
    into.bodyPitch = cpu.rs16(CAR + 0xAC) * TURN;
    into.bodyRoll = cpu.rs16(CAR + 0xB0) * TURN;
    for (let w = 0; w < 4; w++) into.wheelSteer[w] = cpu.rs16(CAR + 0x1A0 + w * 0x84 + 0x80) * TURN;
    // putPlayerCar draws each wheel's hub at y = radius (+0x12C) - suspension (+0x30 of
    // its record) - 0.7 in the car's frame; the front pair at the average of the two.
    const r = cpu.rf(CAR + 0x12C), s = (w) => cpu.rf(CAR + 0x1A0 + w * 0x84 + 0x30);
    into.wheelHeight[0] = into.wheelHeight[1] = r - (s(0) + s(1)) * 0.5 - 0.7;
    into.wheelHeight[2] = r - s(2) - 0.7;
    into.wheelHeight[3] = r - s(3) - 0.7;
  }

  readBack() {
    const cpu = this.cpu;
    this.readPose(this);
    this.vel.x = cpu.rf(CAR + 0xFC) * 60; this.vel.y = cpu.rf(CAR + 0x100) * 60; this.vel.z = cpu.rf(CAR + 0x104) * 60;
    this.speed = cpu.rf(CAR + 0x15C) * 60;
    this.rpm = cpu.rf(CAR + 0x158);
    this.gear = cpu.r32(CAR + 0x120);
    this.throttle = cpu.rf(CAR + 0x118);
    this.brake = cpu.rf(CAR + 0x11C);
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

/** CourseMode (the city loaded) for Game_No city and MiniGame_No game: the Crazy Box's game 15 is in the Arcade city. */
export function courseModeOf(city, game = 0) {
  return city === CRAZY_BOX && game === 15 ? 0 : city;
}

/** The disc files the game needs, by CourseMode (0 Arcade, 1 Original, 2 the Crazy Box; see courseModeOf). */
export function carFiles(city) {
  return {
    exe: 'disc/1ST_READ.BIN', courses: `disc/SPLDC${city + 1}.BIN`, collision: `disc/COLDC${city + 1}.BIN`,
    motions: 'disc/MOTDC.BIN', people: 'disc/POLDC0.BIN', objects: `disc/OBJDC${city + 1}.BIN`,
  };
}

/** "$ 1,234.56" from cents. */
export function formatMoney(cents) {
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  return `$${dollars.toLocaleString('en-US')}.${String(c).padStart(2, '0')}`;
}
