"""Synthetic motion-use fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_motion_uses as mu
from tests.test_extract_fcv_motions import BASE, fixture_motdc

LOAD = mu.LOAD
FUNCS = dict((name, start) for start, _, name in mu.FUNCTIONS)


def load_op(register, site, pool):
    """mov.l @(disp, PC), Rn at `site` reading the word at `pool`."""
    disp = (pool - ((site & ~3) + 4)) // 4
    assert 0 <= disp < 256 and pool % 4 == 0
    return 0xD000 | register << 8 | disp


class Exe:
    def __init__(self, size=0x400):
        self.data = bytearray(size)

    def op(self, at, value):
        struct.pack_into("<H", self.data, at - LOAD, value)

    def word(self, at, value):
        struct.pack_into("<I", self.data, at - LOAD, value)

    def load(self, site, pool, value):
        self.op(site, load_op(1, site, pool))
        self.word(pool, value)


class MotionUseTests(unittest.TestCase):
    def test_pool_loads_decode_displacement_and_alignment(self):
        exe = Exe()
        exe.load(LOAD + 0x12, LOAD + 0x20, 0x11223344)
        exe.load(LOAD + 0x40, LOAD + 0x48, 0x55667788)
        self.assertEqual(mu.pool_loads(bytes(exe.data)),
                         [(LOAD + 0x12, LOAD + 0x20, 0x11223344), (LOAD + 0x40, LOAD + 0x48, 0x55667788)])

    def test_tables_stop_at_non_motion_words_and_other_table_starts(self):
        motions = {0x0C880000 + 0x100 * k: None for k in range(6)}
        a = list(motions)
        exe = Exe()
        exe.word(LOAD + 0x200, a[0])
        exe.word(LOAD + 0x204, a[1])
        exe.word(LOAD + 0x208, a[2])  # starts a second table
        exe.word(LOAD + 0x20C, a[3])
        exe.word(LOAD + 0x210, 0x41A00000)
        exe.word(LOAD + 0x214, a[4])
        functions = ((LOAD + 0x10, 0x40, "first"),)
        exe.load(LOAD + 0x10, LOAD + 0x100, LOAD + 0x200)
        exe.load(LOAD + 0x12, LOAD + 0x104, LOAD + 0x208)
        exe.load(LOAD + 0x14, LOAD + 0x108, a[5])
        exe.op(LOAD + 0x80, 0x2FE6)
        exe.load(LOAD + 0x84, LOAD + 0x10C, a[4])
        uses, tables = mu.find_uses(bytes(exe.data), motions, functions)
        self.assertEqual(tables, {LOAD + 0x200: a[:2], LOAD + 0x208: a[2:4]})
        self.assertEqual([(u["site"], u["function"], u["function_address"], u["motion"], u["table"]) for u in uses],
                         [(LOAD + 0x10, "first", LOAD + 0x10, None, LOAD + 0x200),
                          (LOAD + 0x12, "first", LOAD + 0x10, None, LOAD + 0x208),
                          (LOAD + 0x14, "first", LOAD + 0x10, a[5], None),
                          (LOAD + 0x84, None, LOAD + 0x80, a[4], None)])

    def test_push_runs_start_at_their_first_push(self):
        motions = {0x0C880000: None}
        exe = Exe()
        exe.op(LOAD + 0x40, 0x2FE6)  # mov.l r14,@-r15; mov.l r13,@-r15; sts.l pr,@-r15
        exe.op(LOAD + 0x42, 0x2FD6)
        exe.op(LOAD + 0x44, 0x4F22)
        exe.load(LOAD + 0x50, LOAD + 0x100, 0x0C880000)
        uses, _ = mu.find_uses(bytes(exe.data), motions, ())
        self.assertEqual(uses[0]["function_address"], LOAD + 0x40)

    def test_groups_follow_name_prefixes(self):
        self.assertEqual([mu.group(n) for n in ("psgEnterState0", "Psg_Init", "EndPsg_ClearIpBuff",
                                                "Drv_StartHorn", "Chat_Getoff", "HesLate", None)],
                         ["customer", "customer", "customer", "driver", "chat", "other", "other"])

    def test_entries_need_a_call_pointer_or_push(self):
        exe = Exe(0x100)
        functions = ((LOAD + 0x10, 4, "pushed"), (LOAD + 0x20, 4, "pointed"), (LOAD + 0x30, 4, "bare"))
        exe.op(LOAD + 0x10, 0x4F22)
        exe.word(LOAD + 0x80, LOAD + 0x20)
        self.assertEqual(mu.confirm_entries(bytes(exe.data), functions), ["bare"])

    def test_function_table_is_ordered_and_disjoint(self):
        for (a, size, _), (b, _, _) in zip(mu.FUNCTIONS, mu.FUNCTIONS[1:]):
            self.assertLessEqual(a + size, b)

    def test_full_extraction(self):
        motdc, fcv_offsets, _ = fixture_motdc()
        _, v = mu.find_motions(motdc)
        v_addresses = [BASE + o for o, _ in sorted(v)]
        fcv_addresses = [BASE + o for o in fcv_offsets]
        exe = Exe(mu.CODE_END - LOAD + 0x400)
        for start, _, _ in mu.FUNCTIONS:
            exe.op(start, 0x2FE6)
        data = mu.CODE_END  # tables live after the code
        state0 = FUNCS["psgEnterState0"]
        for k in range(5):
            exe.word(data + 8 * k, v_addresses[k % 2])
            exe.load(state0 + 2 + 2 * k, state0 + 0x40 + 4 * k, data + 8 * k)
        drive = FUNCS["Drv_StartDrive"]
        exe.load(drive + 2, (drive + 0x20) & ~3, fcv_addresses[1])
        exe.load(drive + 4, (drive + 0x24) & ~3, fcv_addresses[1])
        exe.word(data + 0x100, fcv_addresses[0])  # a data reference only
        with tempfile.TemporaryDirectory() as tmp:
            disc = Path(tmp) / "disc"
            disc.mkdir()
            (disc / "MOTDC.BIN").write_bytes(motdc)
            (disc / "1ST_READ.BIN").write_bytes(bytes(exe.data))
            manifest = mu.extract(disc, Path(tmp) / "out")
            out = Path(tmp) / "out"
            self.assertEqual(manifest["counts"], {"Fcv": {"motions": 2, "used": 1}, "V": {"motions": 2, "used": 2}})
            self.assertEqual(manifest["sites"], 7)
            routines = dict((r["key"], r) for r in manifest["routines"])
            self.assertEqual(set(routines), {"psgEnterState0", "Drv_StartDrive"})
            self.assertEqual([t["label"] for t in routines["psgEnterState0"]["tables"]],
                             list(mu.TABLE_LABELS["psgEnterState0"]))
            self.assertEqual(routines["Drv_StartDrive"]["group"], "driver")
            self.assertEqual(routines["Drv_StartDrive"]["motions"], ["fcv_001_%06x" % fcv_offsets[1]])
            by_name = dict((m["name"], m) for m in manifest["motions"])
            first = by_name["fcv_000_000000"]
            self.assertEqual((first["uses"], first["other_words"]), ([], [data + 0x100]))
            v0 = by_name["motion_%06x" % (v_addresses[0] - BASE)]
            self.assertEqual([u["label"] for u in v0["uses"]],
                             ["idle, motion set A", "calling out", "mini game 8 boyfriend"])
            self.assertEqual(v0["groups"], ["customer"])
            self.assertEqual(json.loads((out / "manifest.json").read_text()), manifest)
            self.assertIn("Drv_StartDrive", (out / "index.html").read_text())
            with self.assertRaises(ValueError):
                mu.extract(disc, out)
            exe.op(FUNCS["HesLate"], 0)
            (disc / "1ST_READ.BIN").write_bytes(bytes(exe.data))
            with self.assertRaises(ValueError):
                mu.extract(disc, Path(tmp) / "bad")


if __name__ == "__main__":
    unittest.main()
