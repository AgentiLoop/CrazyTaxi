#!/usr/bin/env python3
"""Record the game - the player car, the traffic, the camera, the game system and the
customers - from the USA executable in the decomp's SH-4 simulator.

The game's own routines run over the disc's course points (SPLDCn.BIN), collision
(COLDCn.BIN), motions (MOTDC.BIN) and people models (POLDC0.BIN) with everything that
draws, plays or rumbles stubbed or captured - the same set-up as src/dc-car.js, which must
reproduce these traces bit for bit (tests/dc-car.test.mjs):

  set-up   the nl matrix stacks, nlInitHeapMemory, nlInitEvent, extRandomSeed(12345),
           init_GameSystem, InitColliObj, InitCollision, InitColliWall, init_CarMain,
           initCamera, SetStartCamera, InitKyakuStopArea, init_KyakuMain, Act_Init,
           entryCarPut(0), trafficControl(0)   (gameState0's order)
  a frame  camUpdate, exec_GameSystem, exec_CarMain, exec_KyakuMain, ExecKyakuArea,
           Act_Execute, entryCarPut(1), trafficControl(1), nlExecuteEvent, ExecColliObj
           (gameStateDrive's order)

The run is a fare: the 366-frame countdown (the game holds the cab until 60 frames remain),
60 frames standing, the cab moved beside the first waiting customer and held on the brake
for 140 frames (the customer gets in: the camera cut, the cab held by the game), 60 frames
of gas, the cab moved to the destination stop and held for 150 frames (the drop-off: the
rating, the pay, the get-out), then 60 frames of gas. 836 frames.

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
MOT_BASE, POL0_BASE = 0x0C880000, 0x0C390000
MATRIX_STACK, MATRIX_STACK_SIZE = 0x0C1BF7B8, 16   # the game's own buffer for the nl matrix stacks
HEAP, HEAP_SIZE = 0x0C177768, 0x30000
VIEW_MATRIX = 0x0C2B0830                 # camUpdate stores the view matrix here
CAMERA, CAM_MODE, FOV = 0x0C1775C0, 0x0C1775E0, 0x0C177624
GS, GAME_STATE, GAME_COUNTER = 0x0C1EC4A8, 0x0C1EC50C, 0x0C1EC510
EVENT_LIST, STOP_TABLE, LANDMARK = 0x0C177748, 0x0C177270, 0x0C0E37DC
FRAME_COUNTER = 0x0C1EC050             # the main loop's frame count: +1 after every frame (a traffic car's horn when &127 == 0)
CASH_CAP = 9999999
FN = dict(initMatrixStack=0x0C0765E0,
          initHeap=0x0C02937C, initEvent=0x0C0294F6, seed=0x0C048AA0, initColliObj=0x0C031D3C,
          initCollision=0x0C030CC4, initColliWall=0x0C033374, initCarMain=0x0C023696,
          initGameSystem=0x0C02D10C, execGameSystem=0x0C02D2D0,
          initCamera=0x0C026768, camUpdate=0x0C02693C, camSnapToCar=0x0C0288C2, setStartCamera=0x0C028FC6,
          initKyakuStopArea=0x0C034B40, initKyakuMain=0x0C025FD4, execKyakuMain=0x0C026076,
          execKyakuArea=0x0C034A88, actInit=0x0C05FDD8, actExecute=0x0C05FF20,
          execCarMain=0x0C023CF2, entryCarPut=0x0C043BA2, trafficControl=0x0C041ACC,
          executeEvent=0x0C0296B6, execColliObj=0x0C031EE4)
KYAKU_TASK_EXEC = 0x0C0248AC
PUT_CAR, PUT_TRAIN = 0x0C0434D0, 0x0C0437FE
HUMAN_DRAW, VSKL_IP_PLAY, FCV_PLAY_BUFFER = 0x0C0689D4, 0x0C0693D8, 0x0C065F6C
SOUND_REQUEST, VOICE_REQUEST, SET_LANDMARK, MUSIC_START = 0x0C071338, 0x0C0720E8, 0x0C030802, 0x0C02DA56
# The sound (src/dc-car.js's hooks, src/audio.js): init_CarSound and exec_CarSound run and
# drive the sound driver's interactive controls (nlsndIcsControl, stubbed); Voice_Request and
# gdc_PlayStreamSongDisk run (recorded) over stubbed ADX stream calls; Voice_Init,
# gdc_InitStreamSongDisk at the start, gdc_ExecStreamSongDisk and Voice_Execute each frame.
ICS_CONTROL = 0x0C07E88A
VOICE_INIT, VOICE_EXECUTE, INIT_SONG_DISK, EXEC_SONG_DISK = 0x0C071FA4, 0x0C072022, 0x0C02DA28, 0x0C02DAB0
SONG_REMAIN, NOT_PLAYING = 0x0C02D7F8, 0x58764           # gdc_GetStreamSongRemainTime: frames left; this while not playing
STREAM_STUBS = {0x0C02DCFC, 0x0C02DD14, 0x0C02DD50, 0x0C02DBDC, 0x0C02DC78, 0x0C02DC0C, 0x0C02DC1A,   # the voice streams
                0x0C02D734, 0x0C02D75A, 0x0C15000E}                                                  # the song stream
# Stubbed: drawing (nlObjPutUseViewMatrix, PutMVObj - putPlayerCar itself runs: its GetRotVec
# stores the cab's rotation vectors at +0x30 for the collision objects), rumble,
# effects, the replay, course loading, the navigation, the trick bonus display, fog, the
# shadow mode register, PutLandmark and the HUD routines the game system and the customer
# code call into.
STUBS = {0x0C035884, 0x0C036A40, 0x0C04B14A, 0x0C078FC0, 0x0C03858C, 0x0C04AE88,
         0x0C0206DC, 0x0C05E1D0, 0x0C035C40, 0x0C035F68, 0x0C036A90,
         0x0C02E3F4, 0x0C02A814, 0x0C042364, 0x0C07A210, 0x0C0460C4, 0x0C030868,
         0x0C0521C8, 0x0C0526B8, 0x0C052316, 0x0C0523B2, 0x0C052716, 0x0C052678, 0x0C05273E, 0x0C05296C, 0x0C05ACCC,
         ICS_CONTROL} | STREAM_STUBS
COUNTDOWN = 366       # frames (0x0C1EC510); the cab is released when 60 remain
IDENTITY = [0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000, 0, 0, 0, 0, 0x3F800000]
IDLE = dict(steer=0.0, accel=0.0, brake=0.0, drive=0, reverse=0)
HELD = dict(IDLE, brake=1.0)
GAS = dict(IDLE, accel=1.0)
# The fare (see the module doc): (first frame, input, teleport) in order.
SCRIPT = [(0, IDLE, None), (COUNTDOWN + 60, HELD, 'customer'), (COUNTDOWN + 200, GAS, None),
          (COUNTDOWN + 260, HELD, 'stop'), (COUNTDOWN + 410, GAS, None)]
FRAMES = COUNTDOWN + 470


class CarSim:
    def __init__(self, sh4sim, disc, city):
        self.sh4sim = sh4sim
        m = sh4sim.Memory()
        m.load(EXE_BASE, open(f'{disc}/1ST_READ.BIN', 'rb').read())
        m.load(SPL_BASE, open(f'{disc}/SPLDC{city + 1}.BIN', 'rb').read())
        m.load(COL_BASE, open(f'{disc}/COLDC{city + 1}.BIN', 'rb').read())
        m.load(MOT_BASE, open(f'{disc}/MOTDC.BIN', 'rb').read())
        m.load(POL0_BASE, open(f'{disc}/POLDC0.BIN', 'rb').read())
        self.m = m
        self.cars, self.people, self.sounds, self.voices = [], [], [], []
        self.landmark_mode, self.music = -1, False
        self.customer_time_total = 0
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
        m.load(0x0C2881F0, bytes(m.read(0x0C09C5C0 + i, 1) for i in range(16)))   # the settings' defaults (50 s)
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
        self.call(VOICE_INIT)
        self.call(INIT_SONG_DISK)
        self.call(FN['initGameSystem'])
        self.call(FN['initColliObj'], r4=0)
        self.call(FN['initCollision'])
        self.call(FN['initColliWall'])
        self.call(FN['initCarMain'])
        self.call(FN['initCamera'], r4=0)
        self.call(FN['setStartCamera'])
        self.call(FN['initKyakuStopArea'])
        self.call(FN['initKyakuMain'])
        self.call(FN['actInit'])
        self.call(FN['entryCarPut'], r4=0)
        self.call(FN['trafficControl'], r4=0)
        self.cars, self.people, self.sounds, self.voices = [], [], [], []

    def r32(self, a):
        return self.m.read(a, 4)

    def rs32(self, a):
        v = self.m.read(a, 4)
        return v - 0x100000000 if v & 0x80000000 else v

    def r16(self, a):
        return self.m.read(a, 2)

    def rs16(self, a):
        v = self.m.read(a, 2)
        return v - 0x10000 if v & 0x8000 else v

    def rf(self, a):
        return self.sh4sim.bits_f(self.m.read(a, 4))

    def w32(self, a, v):
        self.m.load(a, struct.pack('<I', v & 0xFFFFFFFF))

    def w16(self, a, v):
        self.m.load(a, struct.pack('<H', v & 0xFFFF))

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
        bits_f = sim.bits_f

        def xmtrx(c):
            return [bits_f(b) for b in c.xf]

        def on_call(c, target, kind, at):
            target &= 0xFFFFFFFF
            if target in (PUT_CAR, PUT_TRAIN):
                self.cars.append(self.car_state(c.r[4], c.r[5]))
            elif target == HUMAN_DRAW:
                self.people.append(dict(kind='v', chara=c.r[5], motion=c.r[4], frame=c.r[6], matrix=xmtrx(c)))
            elif target == VSKL_IP_PLAY:
                self.people.append(dict(kind='blend', chara=self.r32(c.r[15]), motion=c.r[4], frame=c.r[5],
                                        motionB=c.r[6], frameB=c.r[7], weight=bits_f(c.fr[4]), matrix=xmtrx(c)))
            elif target == FCV_PLAY_BUFFER:
                b = c.r[4]
                buf = [[self.rf(b + 12 * i + 4 * j) if i < 5 else self.rs32(b + 12 * i + 4 * j) for j in range(3)]
                       for i in range(17)]
                self.people.append(dict(kind='fcv', chara=c.r[5], buffer=buf, matrix=xmtrx(c)))
            elif target == SOUND_REQUEST:
                self.sounds.append(dict(word=c.r[4], channel=c.r[5]))
            elif target == SET_LANDMARK:
                self.landmark_mode = c.r[4] - 0x100000000 if c.r[4] & 0x80000000 else c.r[4]
            elif target == SONG_REMAIN:
                c.r[0] = NOT_PLAYING
                c.fr[0] = 0
                c.pc = c.pr
                return True
            elif target not in STUBS:
                # Recorded, then run: Voice_Request queues the script on its channel, and
                # gdc_PlayStreamSongDisk runs the jukebox over the stubbed stream.
                if target == VOICE_REQUEST:
                    self.voices.append(dict(id=c.r[4], channel=c.r[5]))
                elif target == MUSIC_START:
                    self.music = True
                if kind == 'call':
                    c.inside.append(c.pr)
                return False
            c.r[0] = 0
            c.fr[0] = 0
            c.pc = c.pr
            return True
        cpu.on_call = on_call
        while cpu.pc != sim.SENTINEL:
            if cpu.steps > 50000000:
                raise RuntimeError('step limit at %08X' % cpu.pc)
            cpu.step()
        self.m.writes.clear()             # the simulator's write log is not needed here
        return cpu

    def move_to(self, x, y, z, heading=0):
        """src/dc-car.js moveTo: the standing cab put at a spot."""
        for base in (CAR + 0x78, CAR + 0x8C):
            self.wf(base, x); self.wf(base + 4, y); self.wf(base + 8, z)
        for a in (CAR + 0x84, CAR + 0x88, CAR + 0x98, CAR + 0x9C):
            self.w16(a, 0)
        for a in (CAR + 0x86, CAR + 0x9A, CAR + 0xF4):
            self.w16(a, heading)
        for w in range(4):
            b = CAR + 0x1A0 + w * 0x84 + 0x68
            self.wf(b, x); self.wf(b + 4, y); self.wf(b + 8, z)
        for i in range(3):
            self.wf(CAR + 0xFC + 4 * i, 0.0); self.wf(CAR + 0x108 + 4 * i, 0.0)
        self.wf(CAR + 0x15C, 0.0); self.wf(CAR + 0x160, 0.0)
        self.call(FN['camSnapToCar'], r4=0)

    def frame(self, steer, accel, brake, drive, reverse):
        """One frame (src/dc-car.js update); returns the events."""
        g = GS
        before = (self.r32(g + 4), self.r32(g + 0x14), self.r32(GAME_STATE))
        self.sounds, self.voices, self.music = [], [], False
        self.call(FN['camUpdate'], r4=0)
        self.call(FN['execGameSystem'])
        self.call(EXEC_SONG_DISK)
        self.wf(0x0C1EC014, steer)
        self.wf(0x0C1EC018, accel)
        self.wf(0x0C1EC01C, brake)
        self.m.load(0x0C1EBF87, bytes([drive, reverse]))
        self.call(FN['execCarMain'])
        self.cars, self.people = [], []
        self.call(FN['execKyakuMain'])
        self.call(FN['execKyakuArea'])
        self.call(FN['actExecute'])
        self.call(FN['entryCarPut'], r4=1)
        self.call(FN['trafficControl'], r4=1)
        self.call(FN['executeEvent'])
        self.call(FN['execColliObj'])
        self.call(VOICE_EXECUTE)
        self.w32(FRAME_COUNTER, (self.r32(FRAME_COUNTER) + 1) & 0xFFFFFFFF)   # the main loop counts the frame
        events = []
        aboard, delivered = self.r32(g + 4), self.r32(g + 0x14)
        if aboard and not before[0]:
            self.customer_time_total = self.rs32(g + 0x44)
            events.append('in')
        elif before[0] and not aboard:
            if delivered > before[1]:
                fare, time_money, tips = self.r32(g + 0x2C), self.r32(g + 0x28), self.r32(g + 0x30)
                self.w32(g + 0x20, min(CASH_CAP, self.r32(g + 0x20) + fare + time_money + tips))
                self.w32(g + 0x2C, 0); self.w32(g + 0x28, 0); self.w32(g + 0x30, 0)
                events.append('out')
            else:
                events.append('eject')
        if self.r32(GAME_STATE) == 2 and before[2] != 2:
            events.append('timeUp')
        return events

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

    def game_system(self):
        """GSystem as src/dc-car.js gameSystem() reads it."""
        g = GS
        return dict(state=self.r32(GAME_STATE), counter=self.rs32(GAME_COUNTER),
                    started=self.r32(g), aboard=self.r32(g + 4), frames=self.r32(g + 8), time=self.rs32(g + 0xC),
                    pending=self.rs32(g + 0x10), delivered=self.r32(g + 0x14), route=self.rf(g + 0x1C),
                    cash=self.r32(g + 0x20), timeMoney=self.r32(g + 0x28), fare=self.r32(g + 0x2C), tips=self.r32(g + 0x30),
                    trip=self.rf(g + 0x34), level=self.r32(g + 0x3C), customerTime=self.rs32(g + 0x44),
                    fastLimit=self.r32(g + 0x4C), speedyLimit=self.r32(g + 0x50), chain=self.r32(g + 0x58),
                    pickedUp=self.r32(g + 0x5C), customerTimeTotal=self.customer_time_total,
                    landmark=self.r32(LANDMARK), landmarkMode=self.landmark_mode)

    def customers(self):
        """The customer tasks in the event list (src/dc-car.js customers())."""
        out = []
        e = self.r32(EVENT_LIST)
        while e:
            if self.r32(e + 0xC) == KYAKU_TASK_EXEC:
                rec, p = self.r32(e + 0x14), e + 0x1C
                out.append(dict(task=e, record=rec, request=self.r32(rec), kind=self.r32(rec + 4),
                                spot=[self.rf(rec + 8 + 4 * i) for i in range(3)],
                                chara=self.r32(p), pos=[self.rf(p + 4 + 4 * i) for i in range(3)], heading=self.r16(p + 0x10),
                                state=self.r32(p + 0x20), sub=self.r32(p + 0x24),
                                phase=self.r32(e + 0x174), k=self.rf(e + 0x194), slot=self.r32(e + 0x19C),
                                stop=(self.r32(e + 0x198) - STOP_TABLE) // 24 - 1))
            e = self.r32(e + 8)
        return out

    def state(self):
        c = CAR
        return {'pos': [self.rf(c + 0x78 + 4 * i) for i in range(3)],
                'ang': [self.rs16(c + 0x84 + 2 * i) for i in range(3)],
                'speed': self.rf(c + 0x15C), 'rpm': self.rf(c + 0x158), 'gear': self.r32(c + 0x120),
                'steer': [self.rs16(c + 0x1A0 + w * 0x84 + 0x80) for w in range(4)],
                'control': self.r32(c + 0x54),
                'ground': self.r32(0x0C177210) & 0xFFFFFFFF,
                'carEntryNum': self.r32(0x0C2A2168), 'trafficLevel': self.r32(0x0C29F82C),
                'cars': self.cars,
                'live': [self.car_state(self.r32(0x0C2A218C + 4 * i), -1) for i in range(self.r32(0x0C2A2188))],
                'camera': self.camera(), 'gs': self.game_system(), 'customers': self.customers(),
                'people': self.people, 'sounds': self.sounds, 'voices': self.voices, 'music': self.music}


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


def fix_tail_jumps(sh4sim):
    """The decomp's simulator treats a jump inside a deep callee (a function the traced routine
    called, tracked in cpu.inside) as the callee's own branch and never asks on_call about it,
    so a tail jump to a hooked routine - Sound_Request is tail-jumped from 8 sites, e.g. the
    passenger's shout at 0x0C060F18 - ran the real routine instead of the hook and was never
    recorded. src/sh4.js consults its hooks on every transfer; do the same for the hooked
    addresses (the deep callee's return is popped as the hook returns for it)."""
    HOOKED = STUBS | {PUT_CAR, PUT_TRAIN, HUMAN_DRAW, VSKL_IP_PLAY, FCV_PLAY_BUFFER, SOUND_REQUEST, SET_LANDMARK,
                      SONG_REMAIN, VOICE_REQUEST, MUSIC_START}
    orig_go = sh4sim.CPU.go

    def go(self, target, call, at):
        t = target & 0xFFFFFFFF
        if self.inside and call not in ('call', 'rts') and t in HOOKED and self.on_call:
            if self.on_call(self, t, 'jump', at):
                if self.inside and self.inside[-1] == self.pc:
                    self.inside.pop()
                return
        orig_go(self, target, call, at)
    sh4sim.CPU.go = go


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
    fix_tail_jumps(sh4sim)
    sim = CarSim(sh4sim, args.disc, args.city)
    start = sim.state()
    frames = []
    teleports = []
    inp = IDLE
    for f in range(args.frames):
        for first, script_input, where in SCRIPT:
            if f != first:
                continue
            inp = script_input
            if where == 'customer':      # beside the first waiting customer's spot
                t = sim.customers()[0]
                x, y, z = t['spot']
                sim.move_to(x + 30, y, z)
                teleports.append(dict(frame=f, to=[x + 30, y, z]))
            elif where == 'stop':        # the rider's destination: the stop entry's centre
                t = [c for c in sim.customers() if c['request'] == 5][0]
                entry = STOP_TABLE + 24 * (t['stop'] + 1)
                x, y, z = (sim.rf(entry + 4 + 4 * i) for i in range(3))
                sim.move_to(x, y, z)
                teleports.append(dict(frame=f, to=[x, y, z]))
        events = sim.frame(**inp)
        st = sim.state()
        st['input'] = inp
        st['events'] = events
        frames.append(st)
        if f % 30 == 29 or events:
            gs = st['gs']
            print(f'frame {f + 1}: {len(st["cars"])} cars drawn, {len(st["people"])} people, state {gs["state"]} '
                  f'time {gs["time"]} cash {gs["cash"]} camera mode {st["camera"]["mode"]} {events}', file=sys.stderr)
    with open(args.output, 'w') as fh:
        json.dump({'city': args.city, 'start': start, 'countdown': COUNTDOWN, 'teleports': teleports, 'frames': frames}, fh)
    print(f'{args.output}: {len(frames)} frames, final pos {frames[-1]["pos"]}, cash {frames[-1]["gs"]["cash"]}')


if __name__ == '__main__':
    main()
