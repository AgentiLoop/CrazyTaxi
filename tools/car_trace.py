#!/usr/bin/env python3
"""Record the player car, the traffic and the camera from the USA executable in the decomp's
SH-4 simulator.

The game's own routines run over the disc's course points (SPLDCn.BIN) and collision
(COLDCn.BIN) with everything that draws, plays or rumbles stubbed - the same set-up as
src/dc-car.js, which must reproduce these traces bit for bit (tests/dc-car.test.mjs):

  set-up   the nl matrix stacks, nlInitHeapMemory, nlInitEvent, extRandomSeed(12345),
           InitColliObj, InitCollision, InitColliWall, init_CarMain, initCamera,
           SetStartCamera, entryCarPut(0), trafficControl(0)   (gameState0's order)
  a frame  camUpdate, [ExecStartCamera during the countdown], exec_CarMain, entryCarPut(1),
           trafficControl(1), nlExecuteEvent, ExecColliObj   (gameStateDrive's order)

The run is the game's: a 366-frame countdown (the start camera plays, the cab is held until
60 frames remain), then 420 frames of driving.

    python3 tools/car_trace.py --decomp <crazy-taxi-decomp dir> --disc local-assets/disc \
        --city 0 --output tests/fixtures/car-trace-arcade.json

The decomp's tools/sh4sim.py is imported from --decomp (stdlib otherwise).
"""
import argparse
import json
import struct
import sys

CAR = 0x0C176E4C
EXE_BASE, SPL_BASE, COL_BASE = 0x0C010000, 0x0C328000, 0x0CB40000
MATRIX_STACK, MATRIX_STACK_SIZE = 0x0C1BF7B8, 16   # the game's own buffer for the nl matrix stacks
HEAP, HEAP_SIZE = 0x0C177768, 0x30000
VIEW_MATRIX = 0x0C2B0830                 # camUpdate stores the view matrix here
CAMERA, CAM_MODE, FOV = 0x0C1775C0, 0x0C1775E0, 0x0C177624
FN = dict(initMatrixStack=0x0C0765E0,
          initHeap=0x0C02937C, initEvent=0x0C0294F6, seed=0x0C048AA0, initColliObj=0x0C031D3C,
          initCollision=0x0C030CC4, initColliWall=0x0C033374, initCarMain=0x0C023696,
          initCamera=0x0C026768, camUpdate=0x0C02693C, setStartCamera=0x0C028FC6,
          execStartCamera=0x0C029120,
          execCarMain=0x0C023CF2, entryCarPut=0x0C043BA2, trafficControl=0x0C041ACC,
          executeEvent=0x0C0296B6, execColliObj=0x0C031EE4)
PUT_CAR, PUT_TRAIN = 0x0C0434D0, 0x0C0437FE
# Stubbed: drawing (nlObjPutUseViewMatrix, PutMVObj - putPlayerCar itself runs: its GetRotVec
# stores the cab's rotation vectors at +0x30 for the collision objects), sound, rumble,
# effects, the replay, the trip meter, course loading, the navigation, the trick bonus
# display, fog, the shadow mode register.
STUBS = {0x0C0208D6, 0x0C035884, 0x0C036A40, 0x0C04B14A, 0x0C078FC0, 0x0C03858C, 0x0C04AE88,
         0x0C0206DC, 0x0C05E1D0, 0x0C020A10, 0x0C035C40, 0x0C035F68, 0x0C036A90, 0x0C02D0EE,
         0x0C02E3F4, 0x0C02A814, 0x0C071338, 0x0C042364, 0x0C07A210, 0x0C0460C4}
COUNTDOWN = 366       # frames (0x0C1EC510); the cab is released when 60 remain
FRAMES = 420          # of driving after it
IDENTITY = [0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000]
HELD = dict(steer=0.0, accel=0.0, brake=1.0, drive=0, reverse=0)


def script(f):
    """Gas, a right turn, brake, reverse, drive again with a left turn."""
    steer = accel = brake = 0.0
    drive = rev = 0
    if f < 150:
        accel = 1.0
    elif f < 230:
        accel, steer = 1.0, 0.6
    elif f < 290:
        brake = 1.0
    elif f < 350:
        accel, rev = 1.0, 1
    else:
        accel, drive, steer = 1.0, 1, -0.4
    return dict(steer=steer, accel=accel, brake=brake, drive=drive, reverse=rev)


class CarSim:
    def __init__(self, sh4sim, disc, city):
        self.sh4sim = sh4sim
        m = sh4sim.Memory()
        m.load(EXE_BASE, open(f'{disc}/1ST_READ.BIN', 'rb').read())
        m.load(SPL_BASE, open(f'{disc}/SPLDC{city + 1}.BIN', 'rb').read())
        m.load(COL_BASE, open(f'{disc}/COLDC{city + 1}.BIN', 'rb').read())
        self.m = m
        self.cars = []
        self.w32(0x0C1EBF2C, city)        # CourseMode
        self.w32(0x0C1EBF30, city)        # Game_No
        self.w32(0x0C1EBF34, 0)           # MiniGame_No
        self.w32(0x0C177208, 0)           # cab type
        self.w32(0x0C17720C, 0)           # ReverseMode
        m.load(0x0C1EC07C, b'\x01')       # the normal start
        self.w32(0x0C1EBF54, 1)           # MainMode 1: the game
        self.w32(0x0C2A2B28, 2)           # GoiTool flags (GoiTool(0)): traffic on
        self.w32(0x0C2A2B10, 0)           # EndingFlag
        self.w32(0x0C2A4C98, 0)           # SubwayFlag
        table, count = self.r32(0x0C0C718C + city * 8), self.r32(0x0C0C718C + city * 8 + 4)
        self.w32(0x0C2A4350, table)
        self.w32(0x0C2A4354, count)
        rec = table + self.r16(0x0C0C2B64 + city * 2) * 12
        self.w32(0x0C29F7E8, self.r32(rec))
        self.w32(0x0C29F7EC, self.r32(self.r32(rec + 4)))
        self.call(FN['initMatrixStack'], r4=MATRIX_STACK, r5=MATRIX_STACK_SIZE)
        self.w32(HEAP - 4, HEAP)
        self.call(FN['initHeap'], r4=HEAP, r5=HEAP_SIZE)
        self.call(FN['initEvent'])
        self.call(FN['seed'], r4=0x3039)
        self.call(FN['initColliObj'], r4=0)
        self.call(FN['initCollision'])
        self.call(FN['initColliWall'])
        self.call(FN['initCarMain'])
        self.call(FN['initCamera'], r4=0)
        self.call(FN['setStartCamera'])
        self.w32(CAR + 0x54, 1)           # the car is released
        self.call(FN['entryCarPut'], r4=0)
        self.call(FN['trafficControl'], r4=0)

    def r32(self, a):
        return self.m.read(a, 4)

    def r16(self, a):
        return self.m.read(a, 2)

    def rs16(self, a):
        v = self.m.read(a, 2)
        return v - 0x10000 if v & 0x8000 else v

    def rf(self, a):
        return self.sh4sim.bits_f(self.m.read(a, 4))

    def w32(self, a, v):
        self.m.load(a, struct.pack('<I', v & 0xFFFFFFFF))

    def wf(self, a, v):
        self.m.load(a, struct.pack('<f', v))

    def call(self, entry, **regs):
        sim = self.sh4sim
        cpu = sim.CPU(self.m)
        cpu.lo, cpu.hi = entry, entry + 2
        cpu.r[15] = sim.STACK_TOP - 0x100
        for k, v in regs.items():
            cpu.r[int(k[1:])] = v & 0xFFFFFFFF
        cpu.xf = list(IDENTITY)           # XMTRX: the world matrix (nlPushMatrix(0) copies it)
        cpu.pr = sim.SENTINEL
        cpu.pc = entry

        def on_call(c, target, kind, at):
            target &= 0xFFFFFFFF
            if target in (PUT_CAR, PUT_TRAIN):
                self.cars.append(self.car_state(c.r[4], c.r[5]))
            elif target not in STUBS:
                if kind == 'call':
                    c.inside.append(c.pr)
                return False
            c.r[0] = 0
            c.fr[0] = 0
            c.pc = c.pr
            return True
        cpu.on_call = on_call
        while cpu.pc != sim.SENTINEL:
            if cpu.steps > 20000000:
                raise RuntimeError('step limit at %08X' % cpu.pc)
            cpu.step()
        self.m.writes.clear()             # the simulator's write log is not needed here
        return cpu

    def frame(self, steer, accel, brake, drive, reverse, intro=False, hold=False):
        """One frame; intro: the countdown's start camera runs; hold: the cab is held (no control)."""
        self.call(FN['camUpdate'], r4=0)
        if intro:
            self.call(FN['execStartCamera'])
        self.wf(0x0C1EC014, steer)
        self.wf(0x0C1EC018, accel)
        self.wf(0x0C1EC01C, brake)
        self.m.load(0x0C1EBF87, bytes([drive, reverse]))
        control = self.r32(CAR + 0x54)
        if hold:
            self.w32(CAR + 0x54, 0)
        elif control in (0, 3):
            self.w32(CAR + 0x54, 1)
        self.call(FN['execCarMain'])
        self.cars = []
        self.call(FN['entryCarPut'], r4=1)
        self.call(FN['trafficControl'], r4=1)
        self.call(FN['executeEvent'])
        self.call(FN['execColliObj'])

    def car_state(self, p, detail):
        """A traffic car as putCarModel sees it: pointer, type, colour, flags, position, rotation,
        body offset and tilt, brake, speed, course point, detail (-1: from the live list)."""
        return [p, self.r32(p + 0x78), self.r32(p + 0x7C), self.r32(p + 0x84),
                self.rf(p + 0x8C), self.rf(p + 0x90), self.rf(p + 0x94),
                self.rs16(p + 0xA4), self.rs16(p + 0xA6), self.rs16(p + 0xA8),
                self.rf(p + 0xF8), self.rf(p + 0xFC), self.rs16(p + 0xAA), self.rs16(p + 0xAE),
                self.rf(p + 0xC8), self.rf(p + 0xCC), self.r32(p + 0xD4), detail]

    def camera(self):
        """The camera camUpdate left: eye, target, angles, mode, field of view, the view matrix."""
        c = CAMERA
        return {'eye': [self.rf(c + 4 * i) for i in range(3)],
                'target': [self.rf(c + 12 + 4 * i) for i in range(3)],
                'angles': [self.rs16(c + 24 + 2 * i) for i in range(3)],
                'mode': self.r32(CAM_MODE), 'fov': self.rf(FOV),
                'view': [self.rf(VIEW_MATRIX + 4 * i) for i in range(16)]}

    def state(self):
        c = CAR
        return {'pos': [self.rf(c + 0x78 + 4 * i) for i in range(3)],
                'ang': [self.rs16(c + 0x84 + 2 * i) for i in range(3)],
                'speed': self.rf(c + 0x15C), 'rpm': self.rf(c + 0x158), 'gear': self.r32(c + 0x120),
                'steer': [self.rs16(c + 0x1A0 + w * 0x84 + 0x80) for w in range(4)],
                'ground': self.r32(0x0C177210) & 0xFFFFFFFF,
                'carEntryNum': self.r32(0x0C2A2168), 'trafficLevel': self.r32(0x0C29F82C),
                'cars': self.cars,
                'live': [self.car_state(self.r32(0x0C2A218C + 4 * i), -1) for i in range(self.r32(0x0C2A2188))],
                'camera': self.camera()}


def fix_pair_moves(sh4sim):
    """The decomp's simulator moves a 64-bit fmov pair with the low word first in memory. The
    SH-4 puts FR[2k] at the lower address and FR[2k+1] at the upper one (the high word of a
    double comes first): nlPushMatrix's two paths - 16 single loads or 8 pair loads of the same
    matrix - agree only that way, and the game's MultiRot4Vec builds rotations from vectors it
    stored one float at a time. src/sh4.js does the same."""
    M32 = 0xFFFFFFFF

    def fmov(self, op, n, m_, lo4):
        r, rd, wr = self.r, self.m.read, self.m.write
        if not self.sz:
            if lo4 == 0xc: self.fr[n] = self.fr[m_]; return
            if lo4 == 8: self.fr[n] = rd(r[m_], 4); return
            if lo4 == 6: self.fr[n] = rd(r[m_] + r[0], 4); return
            if lo4 == 9:
                self.fr[n] = rd(r[m_], 4); r[m_] = (r[m_] + 4) & M32; return
            if lo4 == 0xa: wr(r[n], 4, self.fr[m_]); return
            if lo4 == 7: wr(r[n] + r[0], 4, self.fr[m_]); return
            if lo4 == 0xb:
                r[n] = (r[n] - 4) & M32; wr(r[n], 4, self.fr[m_]); return

        def get(k):
            bank = self.xf if k & 1 else self.fr
            return bank[k & 14], bank[(k & 14) + 1]

        def put(k, hi, lo):
            bank = self.xf if k & 1 else self.fr
            bank[k & 14], bank[(k & 14) + 1] = hi, lo

        def load(a):
            return rd(a, 4), rd(a + 4, 4)

        def store(a, hi, lo):
            wr(a, 4, hi); wr(a + 4, 4, lo)
        if lo4 == 0xc: put(n, *get(m_)); return
        if lo4 == 8: put(n, *load(r[m_])); return
        if lo4 == 6: put(n, *load(r[m_] + r[0])); return
        if lo4 == 9:
            put(n, *load(r[m_])); r[m_] = (r[m_] + 8) & M32; return
        if lo4 == 0xa: store(r[n], *get(m_)); return
        if lo4 == 7: store(r[n] + r[0], *get(m_)); return
        if lo4 == 0xb:
            r[n] = (r[n] - 8) & M32; store(r[n], *get(m_)); return
    sh4sim.CPU.fmov = fmov


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--decomp', required=True, help='crazy-taxi-decomp checkout (for tools/sh4sim.py)')
    ap.add_argument('--disc', default='local-assets/disc')
    ap.add_argument('--city', type=int, default=0, help='0 Arcade, 1 Original')
    ap.add_argument('--frames', type=int, default=FRAMES)
    ap.add_argument('--output', required=True)
    args = ap.parse_args()
    sys.path.insert(0, f'{args.decomp}/tools')
    import sh4sim
    fix_pair_moves(sh4sim)
    sim = CarSim(sh4sim, args.disc, args.city)
    start = sim.state()
    frames = []
    counter = COUNTDOWN
    for f in range(COUNTDOWN + args.frames):
        # The game tick (0x0C02CC04) counts the countdown down first; the start camera runs while
        # it is positive and the cab is released when it reaches 60.
        counter = max(0, counter - 1)
        intro, hold = counter > 0, counter > 60
        inp = HELD if hold else script(f - COUNTDOWN) if f >= COUNTDOWN else dict(HELD, brake=0.0)
        sim.frame(**inp, intro=intro, hold=hold)
        st = sim.state()
        st['input'] = inp
        st['intro'] = intro
        st['hold'] = hold
        frames.append(st)
        if f % 30 == 29:
            print(f'frame {f + 1}: {len(st["cars"])} cars drawn, {st["carEntryNum"]} in traffic, '
                  f'camera mode {st["camera"]["mode"]}', file=sys.stderr)
    with open(args.output, 'w') as fh:
        json.dump({'city': args.city, 'start': start, 'countdown': COUNTDOWN, 'frames': frames}, fh)
    print(f'{args.output}: {len(frames)} frames, final pos {frames[-1]["pos"]}, {frames[-1]["carEntryNum"]} cars')


if __name__ == '__main__':
    main()
