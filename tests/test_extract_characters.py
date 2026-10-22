"""Synthetic character fixtures: no game files or upstream modules required."""
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_characters as ec
from tools.extract_models import Gltf

LOAD = ec.LOAD
PUSH, POP, TRANSLATE, ROTATE, PUT, MODULO = (0x0C020000, 0x0C020100, 0x0C020200, 0x0C020300, 0x0C020400,
                                             0x0C020500)


def assemble(program, pool):
    """program: list of 16-bit words or ('pool', register, name); pool: {name: 32-bit value}.
    Returns bytes: the code, padding, then the literal pool."""
    code_end = len(program) * 2
    pool_at = (code_end + 3) & ~3
    names = list(pool)
    words = []
    for pc, item in enumerate(program):
        if isinstance(item, tuple):
            _, register, name = item
            address = pool_at + 4 * names.index(name)
            disp = (address - ((pc * 2 & ~3) + 4)) // 4
            assert 0 <= disp < 256
            words.append(0xD000 | register << 8 | disp)
        else:
            words.append(item)
    blob = struct.pack("<%dH" % len(words), *words)
    blob += bytes(pool_at - len(blob))
    return blob + struct.pack("<%dI" % len(names), *(pool[n] for n in names))


def draw_routine(table, bind, extra):
    """push; root; R0; part 1; (character 2: extra); T bind; R1; part 2; pop 1; rts."""
    program = [
        0x6853,              # mov r5,r8          (character)
        ('pool', 1, 'modulo'),
        0x410B, 0x0009,      # jsr @r1 ; nop      (unknown result in r0)
        0x6D03,              # mov r0,r13         (record pointer, unknown)
        ('pool', 0, 'table'),
        0x6C83,              # mov r8,r12
        0x4C08,              # shll2 r12
        0x0CCE,              # mov.l @(r0,r12),r12   (part array)
        ('pool', 9, 'push'), ('pool', 11, 'translate'), ('pool', 10, 'rotate'), ('pool', 14, 'put'),
        0x490B, 0xE400,      # jsr @r9 ; mov #0,r4
        0x4B0B, 0x64D3,      # jsr @r11 ; mov r13,r4
        0x64D3, 0x740C, 0x65D3,  # mov r13,r4 ; add #12,r4 ; mov r13,r5
        0x4A0B, 0x7518,      # jsr @r10 ; add #24,r5
        0x54C1,              # mov.l @(4,r12),r4
        0x4E0B, 0x0009,      # jsr @r14 ; nop
        0x6083,              # mov r8,r0
        0x8802,              # cmp/eq #2,r0
        0x8B02,              # bf +2 (skip the extra)
        ('pool', 4, 'extra'),
        0x4E0B, 0x0009,      # jsr @r14 ; nop
        ('pool', 4, 'bind'),
        0x4B0B, 0x0009,      # jsr @r11 ; nop
        0x64D3, 0x7424, 0x65D3,  # mov r13,r4 ; add #36,r4 ; mov r13,r5
        0x4A0B, 0x7530,      # jsr @r10 ; add #48,r5
        0x54C2,              # mov.l @(8,r12),r4
        0x4E0B, 0x0009,      # jsr @r14 ; nop
        ('pool', 1, 'pop'),
        0x410B, 0xE401,      # jsr @r1 ; mov #1,r4
        0x000B, 0x0009,      # rts ; nop
    ]
    pool = dict(modulo=MODULO, table=table, push=PUSH, translate=TRANSLATE, rotate=ROTATE, put=PUT,
                extra=extra, bind=bind, pop=POP)
    return assemble(program, pool)


def fixture():
    """Executable: draw routine at LOAD, bind vector, part arrays and their table."""
    base = 0x0C390000
    models = [0x100, 0x200, 0x300]
    data = bytearray(0x400)
    bind_at, arrays_at, table_at = 0x200, 0x240, 0x300
    struct.pack_into("<3f", data, bind_at, 4.5, 0.0, 0.0)
    for k in range(3):
        struct.pack_into("<16I", data, arrays_at + 64 * k, 0, base + models[0], base + models[1], *([0] * 13))
        struct.pack_into("<I", data, table_at + 4 * k, LOAD + arrays_at + 64 * k)
    code = draw_routine(LOAD + table_at, LOAD + bind_at, base + models[2])
    data[:len(code)] = code
    return bytes(data), base, models


class ExtractCharactersTest(unittest.TestCase):
    def test_draw_routine_runs_symbolically(self):
        executable, base, models = fixture()
        memory = [(LOAD, executable)]
        calls = ec.run_draw(memory, LOAD, (0x0C880000, 2, 1, 0))
        functions = ec.identify(calls, set(base + m for m in models))
        self.assertEqual(functions, dict(put=PUT, rotate=ROTATE, translate=TRANSLATE, push=PUSH, pop=POP))
        events = ec.events(calls, functions)
        self.assertEqual(events, [("push",), ("root",), ("rotate", 0), ("put", base + 0x100),
                                  ("put", base + 0x300), ("translate", LOAD + 0x200), ("rotate", 1),
                                  ("put", base + 0x200), ("pop", 1)])
        nodes, draws = ec.draw_tree(events, executable)
        self.assertEqual([(n["bone"], n["parent"]) for n in nodes], [(0, None), (1, 0)])
        self.assertEqual(nodes[0]["translation"], "root")
        self.assertEqual(nodes[1]["translation"], (4.5, 0.0, 0.0))
        self.assertEqual(draws, [(0, base + 0x100), (0, base + 0x300), (1, base + 0x200)])

    def test_branch_on_character_selects_extra(self):
        executable, base, models = fixture()
        calls = ec.run_draw([(LOAD, executable)], LOAD, (0x0C880000, 1, 1, 0))
        puts = [r4 for target, r4, _ in calls if target == PUT]
        self.assertEqual(puts, [base + 0x100, base + 0x200])

    def test_unresolved_branch_is_rejected(self):
        program = [0x6043, 0x8801, 0x8900, 0x000B, 0x0009]  # mov r4,r0 ; cmp/eq #1 ; bt ; rts
        code = assemble(program, {})
        with self.assertRaises(ValueError):
            ec.run_draw([(LOAD, code)], LOAD, (ec.Sym(), 0, 0, 0))

    def test_jump_table_braf(self):
        program = [0x6043,          # 00 mov r4,r0
                   0x4000,          # 02 shll r0
                   0x6103,          # 04 mov r0,r1
                   0xC702,          # 06 mova 0x10,r0
                   0x001D,          # 08 mov.w @(r0,r1),r0
                   0x0023,          # 0a braf r0 (target 0x0e + r0)
                   0x0009, 0x0009,  # 0c nop (delay slot), 0e
                   0x0006, 0x000A,  # 10 table: case 0 -> 0x14, case 1 -> 0x18
                   0x000B, 0x0009,  # 14 case 0: rts ; nop
                   0xB010, 0x0009,  # 18 case 1: bsr 0x3c ; nop
                   0x000B, 0x0009]  # 1c rts ; nop
        code = assemble(program, {})
        self.assertEqual(ec.run_draw([(LOAD, code)], LOAD, (0, 0, 0, 0)), [])
        calls = ec.run_draw([(LOAD, code)], LOAD, (1, 0, 0, 0))
        self.assertEqual([c[0] for c in calls], [LOAD + 0x3C])

    def test_unbalanced_stack_is_rejected(self):
        with self.assertRaises(ValueError):
            ec.draw_tree([("push",), ("rotate", 0)], b"")
        with self.assertRaises(ValueError):
            ec.draw_tree([("pop", 1)], b"")
        with self.assertRaises(ValueError):
            ec.draw_tree([("put", 1)], b"")

    def test_find_base_and_character_table(self):
        executable, base, models = fixture()
        self.assertEqual(ec.find_base(executable, models, 0x1000), base)
        # Eight or more characters are required; build a longer table.
        data = bytearray(executable) + bytearray(0x400)
        for k in range(10):
            struct.pack_into("<16I", data, 0x400 + 64 * k, 0, base + models[k % 3], *([0] * 14))
            struct.pack_into("<I", data, 0x380 + 4 * k, LOAD + 0x400 + 64 * k)
        table, arrays = ec.find_character_table(bytes(data), base, models)
        self.assertEqual(table, LOAD + 0x380)
        self.assertEqual(len(arrays), 10)

    def test_find_motions_confirms_base(self):
        base = 0x0C880000
        blob = bytearray()
        headers = []
        for frames in (2, 3):
            blob += bytes(ec.RECORD * frames)
            headers.append((len(blob), frames))
            blob += struct.pack("<iiI", frames, 15, base + len(blob) - frames * ec.RECORD)
        found_base, motions = ec.find_motions(bytes(blob))
        self.assertEqual(found_base, base)
        self.assertEqual(motions, headers)

    def test_quaternion_matches_columns(self):
        q, error = ec.quaternion((0.0, 1.0, 0.0), (-1.0, 0.0, 0.0))  # 90 degrees about +z
        self.assertAlmostEqual(error, 0.0)
        for got, want in zip(q, (0.0, 0.0, math.sqrt(0.5), math.sqrt(0.5))):
            self.assertAlmostEqual(got, want)
        q, error = ec.quaternion((2.0, 0.0, 0.0), (0.1, 1.0, 0.0))
        self.assertAlmostEqual(error, 1.0)
        for got, want in zip(q, (0.0, 0.0, 0.0, 1.0)):
            self.assertAlmostEqual(got, want)

    def test_world_positions_follow_parents(self):
        nodes = [dict(bone=0, parent=None, translation="root"), dict(bone=1, parent=0, translation=(2.0, 0.0, 0.0))]
        turn = (0.0, 0.0, math.sqrt(0.5), math.sqrt(0.5))
        world = ec.world_positions(nodes, [(turn, (0.0, 5.0, 0.0)), ((0.0, 0.0, 0.0, 1.0), (2.0, 0.0, 0.0))])
        self.assertEqual([round(v, 6) for v in world[1]], [0.0, 7.0, 0.0])

    def test_motion_animation_loops_and_has_no_buffer_targets(self):
        frames = 3
        blob = bytearray()
        for k in range(frames):
            vectors = [(0.0, 10.0 + k, 0.0)] + [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)] * 16
            blob += struct.pack("<99f", *[c for v in vectors for c in v])
        header = len(blob)
        nodes = [dict(bone=0, parent=None, translation="root"), dict(bone=1, parent=0, translation=(1.0, 0.0, 0.0))]
        gltf = Gltf(None, [], "")
        posed, _ = ec.pose(ec.record_vectors(bytes(blob), header, frames, 1), nodes)
        ids = ec.add_nodes(gltf, nodes, posed, "skeleton")
        ec.add_motion(gltf, ids, nodes, bytes(blob), header, frames, "m", dict(frames=frames))
        doc = gltf.doc
        animation = doc["animations"][0]
        self.assertEqual(len(animation["channels"]), 3)  # two rotations, one root translation
        times = doc["accessors"][animation["samplers"][0]["input"]]
        self.assertEqual(times["count"], frames)  # records 1, 2, then 1 again
        self.assertEqual(times["max"], [(frames - 1) / ec.FRAME_RATE])
        translation = [s for s, c in zip(animation["samplers"], animation["channels"])
                       if c["target"]["path"] == "translation"][0]
        view = doc["bufferViews"][doc["accessors"][translation["output"]]["bufferView"]]
        self.assertNotIn("target", view)
        values = struct.unpack_from("<9f", gltf.blob, view["byteOffset"])
        self.assertEqual([values[1], values[4], values[7]], [11.0, 12.0, 11.0])
        self.assertEqual(doc["nodes"][ids[0]]["translation"], [0.0, 11.0, 0.0])
        self.assertEqual(json.loads(json.dumps(doc))["nodes"][0]["children"], [ids[0]])

    def test_select_table_run(self):
        motions = {0x0C900000, 0x0C900100}
        data = bytearray(64 + 64)
        for k in range(3):
            struct.pack_into("<4I", data, 64 + 16 * k, 0x7100, 0x0C900000, 0x0C900100, 59 + k)
        found = ec.find_select_table(bytes(data), motions, 63)
        self.assertEqual([c for *_, c in found], [59, 60, 61])
        self.assertEqual(found[0][0], LOAD + 64)

    def test_extract_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "characters"
            out.mkdir()
            with self.assertRaises(ValueError):
                ec.extract(Path(tmp), Path(tmp), out)


if __name__ == "__main__":
    unittest.main()
