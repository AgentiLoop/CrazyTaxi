"""Synthetic Sound_Request fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_audio as audio
from tools import extract_sound_uses as su
from tests.test_extract_audio import driver, dtpk, requests

LOAD = su.LOAD
SR = su.SOUND_REQUEST


class Asm:
    """A tiny SH-4 assembler: ops go at `at`, literal words into a pool further on."""

    def __init__(self, size=0x800, start=0x100, pool=0x200):
        self.data = bytearray(size)
        self.at = LOAD + start
        self.pool = LOAD + pool

    def op(self, value):
        struct.pack_into("<H", self.data, self.at - LOAD, value)
        self.at += 2
        return self.at - 2

    def literal(self, register, value):
        """mov.l @(disp,PC),Rn reading a new pool word holding `value`."""
        disp = (self.pool - ((self.at & ~3) + 4)) // 4
        assert 0 <= disp < 256
        struct.pack_into("<I", self.data, self.pool - LOAD, value)
        self.pool += 4
        return self.op(0xD000 | register << 8 | disp)

    def word(self, address, value):
        struct.pack_into("<I", self.data, address - LOAD, value)

    def branch(self, opcode, target):
        """bt/bf (8-bit) or bra (12-bit) from the current address to `target`."""
        disp = (target - (self.at + 4)) // 2
        if opcode == 0xA000:
            return self.op(0xA000 | disp & 0xFFF)
        return self.op(opcode | disp & 0xFF)


def mov_imm(n, value):
    return 0xE000 | n << 8 | value & 0xFF


def mov(m, n):
    return 0x6003 | n << 8 | m << 4


def jsr(n):
    return 0x400B | n << 8


NOP = 0x0009
RTS = 0x000B


def build():
    """Seven Sound_Request sites (see the comments) and a 4-entry request table at LOAD + 0x700."""
    asm = Asm()
    asm.literal(13, SR)                 # r13 = Sound_Request, kept across calls
    # 1: constant word and channel
    asm.literal(4, 0x000505A9)
    one = asm.op(jsr(13))
    asm.op(mov_imm(5, 0))
    # 2: two paths, each with its own word and channel
    bt = asm.at
    asm.op(0x8900)                      # bt L1 (patched below)
    asm.literal(4, 0x000102A9)
    bra = asm.at
    asm.op(0xA000)                      # bra L2 (patched below)
    asm.op(mov_imm(5, 0))
    l1 = asm.at
    asm.literal(4, 0x000108A9)
    asm.op(mov_imm(5, 1))
    l2 = asm.at
    two = asm.op(jsr(13))
    asm.op(NOP)
    struct.pack_into("<H", asm.data, bt - LOAD, 0x8900 | (l1 - (bt + 4)) // 2)
    struct.pack_into("<H", asm.data, bra - LOAD, 0xA000 | (l2 - (bra + 4)) // 2)
    # 3: a word set before an unrelated call is lost (r0-r7 do not survive calls)
    asm.op(mov_imm(4, 0x29))
    asm.literal(2, 0x0C020000)
    asm.op(jsr(2))
    asm.op(NOP)
    three = asm.op(jsr(13))
    asm.op(mov_imm(5, 2))
    # 4: a table read whose index is masked: and #3,r0; mov r0,r4; shll2 r4
    asm.op(0xC903)
    asm.op(mov(0, 4))
    asm.op(0x4408)
    asm.literal(0, LOAD + 0x700)
    four = asm.op(jsr(13))
    asm.op(0x044E)                      # mov.l @(r0,r4),r4 in the delay slot
    # 5: a table read with an unknown index: the run of request words
    asm.op(0x54E2)                      # mov.l @(8,r14),r4
    asm.op(0x4408)
    asm.literal(0, LOAD + 0x700)
    asm.op(mov_imm(5, 1))
    five = asm.op(jsr(13))
    asm.op(0x044E)
    # 6: unresolved (a field of an object)
    asm.op(0x54E3)                      # mov.l @(12,r14),r4
    six = asm.op(jsr(13))
    asm.op(mov_imm(5, 0))
    # 7: a tail jump
    asm.literal(3, SR)
    asm.literal(4, 0x000005A9)
    asm.op(mov_imm(5, 0))
    seven = asm.op(0x432B)              # jmp @r3
    asm.op(NOP)
    for index, word in enumerate((0x000102A9, 0x000108A9, 0x000505A9, 0x000005A9, 0x000105A9)):
        asm.word(LOAD + 0x700 + 4 * index, word)
    return asm, (one, two, three, four, five, six, seven)


KNOWN = set(su.driver_request(w) for w in (0x000505A9, 0x000102A9, 0x000108A9, 0x000005A9, 0x000105A9))


class SoundUseTests(unittest.TestCase):
    def test_driver_request_reverses_bytes(self):
        self.assertEqual(su.driver_request(0x000505A9), 0xA9050500)
        self.assertEqual(su.driver_request(0x000BA9), 0xA90B0000)

    def test_written_registers(self):
        self.assertEqual(su.written(mov_imm(4, 1)), {4})
        self.assertEqual(su.written(mov(5, 4)), {4})
        self.assertEqual(su.written(0x2342), set())       # mov.l r4,@r3
        self.assertEqual(su.written(0x2FE6), {15})        # mov.l r14,@-r15
        self.assertEqual(su.written(0x6EF6), {14, 15})    # mov.l @r15+,r14
        self.assertEqual(su.written(jsr(3)), set())
        self.assertEqual(su.written(0xC903), {0})         # and #3,r0
        self.assertEqual(su.written(0x8801), set())       # cmp/eq #1,r0

    def test_find_calls(self):
        asm, sites = build()
        found = dict((s["site"], s) for s in su.find_calls(bytes(asm.data), KNOWN))
        self.assertEqual(sorted(found), list(sites))
        one, two, three, four, five, six, seven = sites
        self.assertEqual(found[one]["pairs"], [(0x000505A9, 0)])
        self.assertEqual(found[two]["pairs"], [(0x000102A9, 0), (0x000108A9, 1)])
        self.assertEqual(found[three]["pairs"], [(su.UNKNOWN, 2)])
        (value, _), = found[four]["pairs"]
        self.assertEqual(value[:3], ("table", LOAD + 0x700, "mask"))
        self.assertEqual(value[3], ((0, 0x000102A9), (1, 0x000108A9), (2, 0x000505A9), (3, 0x000005A9)))
        (value, channel), = found[five]["pairs"]
        self.assertEqual((value[2], len(value[3]), channel), ("run", 5, 1))
        self.assertEqual(found[six]["pairs"], [(su.UNKNOWN, 0)])
        self.assertEqual((found[seven]["via"], found[seven]["pairs"]), ("jmp", [(0x000005A9, 0)]))

    def test_masked_table_entries_must_be_requests(self):
        asm, _ = build()
        asm.word(LOAD + 0x708, 0x12345678)
        with self.assertRaises(ValueError):
            su.find_calls(bytes(asm.data), KNOWN)

    def test_pool_words_that_decode_as_loads_are_not_pools(self):
        asm = Asm(start=0x100, pool=0x180)
        asm.literal(1, 0)                   # pool word 0x180, filled in below
        asm.op(RTS)
        asm.op(NOP)
        asm.at, asm.pool = LOAD + 0x200, LOAD + 0x300
        asm.literal(13, SR)
        asm.literal(4, 0x000505A9)
        site = asm.op(jsr(13))
        asm.op(mov_imm(5, 0))
        # the pool word's low half decodes as mov.w @(disp,PC) reading the call itself
        asm.word(LOAD + 0x180, 0x9000 | (site - (LOAD + 0x180 + 4)) // 2)
        code = su.Code(bytes(asm.data))
        self.assertIn(LOAD + 0x180, code.data)
        self.assertNotIn(site, code.data)
        self.assertEqual([s["pairs"] for s in su.find_calls(bytes(asm.data), KNOWN)], [[(0x000505A9, 0)]])

    def test_code_checks(self):
        exe = bytearray(0x0C07EB20 - LOAD)
        for address, value in su.GAME_CODE.items():
            struct.pack_into("<H", exe, address - LOAD, value)
        for address, value in su.GAME_POOL.items():
            struct.pack_into("<I", exe, address - LOAD, value)
        sound = bytearray(driver())
        for address, value in su.DRIVER_CODE.items():
            struct.pack_into("<I", sound, address, value)
        su.check_code(bytes(exe), bytes(sound))
        bad = bytearray(exe)
        struct.pack_into("<H", bad, 0x0C071366 - LOAD, 0x2352)
        with self.assertRaises(ValueError):
            su.check_code(bytes(bad), bytes(sound))
        bad = bytearray(sound)
        struct.pack_into("<I", bad, 0x0754, 0)
        with self.assertRaises(ValueError):
            su.check_code(bytes(exe), bytes(bad))

    def test_extract(self):
        asm, sites = build()
        exe = bytearray(0x0C07EB20 - LOAD)
        exe[:len(asm.data)] = asm.data
        for address, value in su.GAME_CODE.items():
            struct.pack_into("<H", exe, address - LOAD, value)
        for address, value in su.GAME_POOL.items():
            struct.pack_into("<I", exe, address - LOAD, value)
        sound = bytearray(driver())
        for address, value in su.DRIVER_CODE.items():
            struct.pack_into("<I", sound, address, value)
        play = b"\x80\x90\x00\x7f\x00\xff"  # one note-on of playback 0
        pack = dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20", [(0, 0, 0)], request_chunk=requests([
            (0xA902, [play] * 2), (0xA905, [play] * 6), (0xA908, [play] * 2)]))
        empty = dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(bytes(exe))
            (source / audio.SOUND_DRIVER).write_bytes(bytes(sound))
            for name in audio.DTPK_SOURCES:
                (source / name).write_bytes(pack if name == "SNDDC0.BIN" else empty)
            wavs = Path(tmp) / "audio"
            (wavs / "SNDDC0").mkdir(parents=True)
            (wavs / "manifest.json").write_text("{}")
            (wavs / "SNDDC0" / "0000.wav").write_bytes(b"RIFF")
            manifest = su.extract(source, Path(tmp) / "out", wavs)
            self.assertEqual(manifest["counts"], dict(sites=7, constant=3, table=2, unresolved=2, requests=10,
                                                      requests_with_constant_sites=4, requests_reached=5))
            by = dict((r["request"], r) for r in manifest["requests"])
            self.assertEqual(by["0xA9050500"]["sites"], [sites[0]])
            self.assertEqual(by["0xA9050500"]["table_sites"], [sites[3], sites[4]])
            self.assertEqual([c["function"] for c in by["0xA9050500"]["decomp_callers"]],
                             ["Put_Remain_Time", "Put_Remain_Time_Mode2"])
            self.assertEqual(by["0xA9050100"]["table_sites"], [sites[4]])
            self.assertEqual(by["0xA9050500"]["wavs"], ["../audio/SNDDC0/0000.wav"])
            self.assertIn("0x00BA9", manifest["decomp_only"])
            self.assertEqual(manifest["usa_only"], [])
            written = json.loads((Path(tmp) / "out" / "manifest.json").read_text())
            self.assertEqual(written["counts"], manifest["counts"])
            self.assertIn("Put_Remain_Time", (Path(tmp) / "out" / "index.html").read_text())
            with self.assertRaises(ValueError):
                su.extract(source, Path(tmp) / "out")
            (source / "SNDDC0.BIN").write_bytes(dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20", [(0, 0, 0)],
                                                     request_chunk=requests([(0xA905, [play] * 6)])))
            with self.assertRaises(ValueError):  # the constant 0x000102A9 is no longer requested
                su.extract(source, Path(tmp) / "out2")


if __name__ == "__main__":
    unittest.main()
