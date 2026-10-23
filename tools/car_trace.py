#!/usr/bin/env python3
"""Record the player car's physics from the USA executable in the decomp's SH-4 simulator.

The game's init_CarMain and exec_CarMain run over the disc's course points (SPLDCn.BIN) and
collision (COLDCn.BIN) with everything that draws, plays or rumbles stubbed - the same set-up as
src/dc-car.js, which must reproduce these traces bit for bit (tests/dc-car.test.mjs).

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
MATRIX_STACK = 0x0CFD0000
INIT_STUBS = {0x0C032448, 0x0C0208D6, 0x0C035884, 0x0C036A40, 0x0C04B14A}
EXEC_STUBS = {0x0C0200E4, 0x0C0203E8, 0x0C04AE88, 0x0C0206DC, 0x0C05E1D0, 0x0C020A10, 0x0C035C40,
              0x0C035F68, 0x0C036A90, 0x0C02D0EE, 0x0C02E3F4, 0x0C02A814}
FRAMES = 420


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
        self.w32(0x0C1EBF2C, city)        # CourseMode
        self.w32(0x0C1EBF30, city)        # Game_No
        self.w32(0x0C1EBF34, 0)           # MiniGame_No
        self.w32(0x0C177208, 0)           # cab type
        self.w32(0x0C17720C, 0)           # ReverseMode
        m.load(0x0C1EC07C, b'\x01')       # the normal start
        table, count = self.r32(0x0C0C718C + city * 8), self.r32(0x0C0C718C + city * 8 + 4)
        self.w32(0x0C2A4350, table)
        self.w32(0x0C2A4354, count)
        rec = table + self.r16(0x0C0C2B64 + city * 2) * 12
        self.w32(0x0C29F7E8, self.r32(rec))
        self.w32(0x0C29F7EC, self.r32(self.r32(rec + 4)))
        m.load(0x0C2B067C, struct.pack('<HHII', 0, 64, MATRIX_STACK, MATRIX_STACK))
        self.call(0x0C030CC4, set())      # InitCollision
        self.call(0x0C033374, set())      # InitColliWall
        self.call(0x0C023696, INIT_STUBS) # init_CarMain
        self.w32(CAR + 0x54, 1)           # the car is released

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

    def call(self, entry, stubs):
        sim = self.sh4sim
        cpu = sim.CPU(self.m)
        cpu.lo, cpu.hi = entry, entry + 2
        cpu.r[15] = sim.STACK_TOP - 0x100
        cpu.pr = sim.SENTINEL
        cpu.pc = entry

        def on_call(c, target, kind, at):
            if (target & 0xFFFFFFFF) not in stubs:
                if kind == 'call':
                    c.inside.append(c.pr)
                return False
            c.r[0] = 0
            c.fr[0] = 0
            c.pc = c.pr
            return True
        cpu.on_call = on_call
        while cpu.pc != sim.SENTINEL:
            if cpu.steps > 4000000:
                raise RuntimeError('step limit at %08X' % cpu.pc)
            cpu.step()
        return cpu

    def frame(self, steer, accel, brake, drive, reverse):
        self.wf(0x0C1EC014, steer)
        self.wf(0x0C1EC018, accel)
        self.wf(0x0C1EC01C, brake)
        self.m.load(0x0C1EBF87, bytes([drive, reverse]))
        self.call(0x0C023CF2, EXEC_STUBS)

    def state(self):
        c = CAR
        return {'pos': [self.rf(c + 0x78 + 4 * i) for i in range(3)],
                'ang': [self.rs16(c + 0x84 + 2 * i) for i in range(3)],
                'speed': self.rf(c + 0x15C), 'rpm': self.rf(c + 0x158), 'gear': self.r32(c + 0x120),
                'steer': [self.rs16(c + 0x1A0 + w * 0x84 + 0x80) for w in range(4)],
                'ground': self.r32(0x0C177210) & 0xFFFFFFFF}


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
    sim = CarSim(sh4sim, args.disc, args.city)
    frames = []
    for f in range(args.frames):
        inp = script(f)
        sim.frame(**inp)
        st = sim.state()
        st['input'] = inp
        frames.append(st)
    with open(args.output, 'w') as fh:
        json.dump({'city': args.city, 'start': CarSim(sh4sim, args.disc, args.city).state(), 'frames': frames}, fh)
    print(f'{args.output}: {len(frames)} frames, final pos {frames[-1]["pos"]}')


if __name__ == '__main__':
    main()
