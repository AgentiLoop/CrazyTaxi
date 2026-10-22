"""Synthetic course line fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_courses as ec

LOAD = ec.LOAD
BASE = 0x0C328000


def course_file(courses, size=0x800):
    """courses: [[(x, y, z)]] packed back to back, each followed by its count; returns (data, [(p, c)])."""
    data = bytearray()
    where = []
    for points in courses:
        p = BASE + len(data)
        for point in points:
            data += struct.pack("<3f", *point)
        where.append((p, BASE + len(data)))
        data += struct.pack("<I", len(points))
    data += bytes(size - len(data))
    return bytes(data), where


ARCADE = [[(0, 5, 0), (30, 5, 0)], [(0, 0, 0), (30, 0, 0), (60, 0, 0)], [(100, 0, 0), (130, 0, 0)]]
ORIGINAL = [[(0, 1, 0), (0, 1, 30)]]
CRAZY = [[(0, 10, 0), (0, 10, 30)], [(5, 0, 5), (5, 0, 35)]]
EXE_POINTS = [(1, 2, 3), (4, 5, 6), (7, 8, 9)]


def fixture():
    """(executable, [SPLDC1, SPLDC2, SPLDC3]) with every table the tool looks for."""
    files, where = zip(*(course_file(c) for c in (ARCADE, ORIGINAL, CRAZY)))
    exe = bytearray(0x900)
    # code: mov.l @(0x40,pc),r1 ... and #15,r0; shll2 r0; fmov.s @(r0,r1),fr4
    struct.pack_into("<5H", exe, 0, 0xD10F, 0x0009, 0xC90F, 0x4008, 0xF416)
    struct.pack_into("<2I", exe, 0x40, LOAD + 0x100, LOAD + 0x200)  # pool: the speed table, the stage table
    struct.pack_into("<3fI", exe, 0x100, 0.5, 1.25, 2.0, 0x32)
    struct.pack_into("<15I", exe, 0x200, 1, 1, 2, 1, 1, 1, 0, 1, 1, 0, 2, 1, 7, 0, 0)
    infos = [(0, 0, 0, 0, 0, 0), (0x12, 8, 2, 2, 0, 2), (0x4011, 0, 1, 0, 1, 1),
             (0, 0, 0, 0, 0, 0), (0x32, 0, 0, 0, 0, 0),
             (0, 0, 0, 0, 0, 0), (2, 0, 1, 0, 1, 0), (1, 0, 2, 0, 2, 0)]
    for k, info in enumerate(infos):
        struct.pack_into("<6h", exe, 0x300 + 12 * k, *info)
    for k, point in enumerate(EXE_POINTS):
        struct.pack_into("<3f", exe, 0x700 + 12 * k, *point)
    struct.pack_into("<I", exe, 0x7F0, len(EXE_POINTS))  # an executable course's count, not after its points
    records = [list(where[0]), list(where[1]) + [(LOAD + 0x700, LOAD + 0x7F0)],
               list(where[2]) + [where[2][1]]]  # Crazy Box course 2 shares course 1's points
    tables, info = [], 0
    for f, recs in enumerate(records):
        tables.append((LOAD + 0x400 + 0x60 * f, len(recs)))
        for k, (p, c) in enumerate(recs):
            struct.pack_into("<3I", exe, 0x400 + 0x60 * f + 12 * k, p, c, LOAD + 0x300 + 12 * info)
            info += 1
    struct.pack_into("<6I", exe, 0x600, *[v for t in tables for v in t])
    return bytes(exe), list(files)


class ExtractCoursesTest(unittest.TestCase):
    def test_count_must_follow_points_in_the_file(self):
        exe, files = fixture()
        memory = ec.Memory(exe, files[0], BASE)
        course = ec.read_course(memory, LOAD + 0x400 + 12)
        self.assertEqual(course["points"], [[0.0, 0.0, 0.0], [30.0, 0.0, 0.0], [60.0, 0.0, 0.0]])
        self.assertEqual(course["info"], [0x12, 8, 2, 2, 0, 2])
        broken = bytearray(files[0])
        struct.pack_into("<I", broken, 28 + 36, 2)  # course 1's count no longer matches where it sits
        self.assertIsNone(ec.read_course(ec.Memory(exe, bytes(broken), BASE), LOAD + 0x400 + 12))

    def test_executable_points_keep_their_own_count(self):
        exe, files = fixture()
        course = ec.read_course(ec.Memory(exe, files[1], BASE), LOAD + 0x460 + 12)
        self.assertEqual(course["points"], [list(map(float, p)) for p in EXE_POINTS])

    def test_directory_and_shared_load_address(self):
        exe, files = fixture()
        directory, tables, base = ec.find_directory(exe, files)
        self.assertEqual((directory, base), (LOAD + 0x600, BASE))
        self.assertEqual(tables, [(LOAD + 0x400, 3), (LOAD + 0x460, 2), (LOAD + 0x4C0, 3)])
        with self.assertRaises(ValueError):  # Crazy Box's file read at a different address than the others
            ec.find_directory(exe, files[:2] + [bytes(12) + files[2][:-12]])

    def test_stage_table_is_the_longest_run(self):
        exe, _ = fixture()
        exe = bytearray(exe)
        struct.pack_into("<9I", exe, 0x800, 1, 1, 1, 1, 1, 1, 0, 1, 1)  # a shorter look-alike, referenced too
        struct.pack_into("<I", exe, 0x48, LOAD + 0x800)
        address, entries = ec.find_stage_table(bytes(exe), [3, 2, 3])
        self.assertEqual(address, LOAD + 0x200)
        self.assertEqual(entries, [(1, 1, 2), (1, 1, 1), (0, 1, 1), (0, 2, 1)])

    def test_speed_table_from_the_masked_index_code(self):
        exe, _ = fixture()
        speed = ec.find_speed_table(exe, [0, 2])
        self.assertEqual((speed["address"], speed["speeds"], speed["references"]), (LOAD + 0x100, [0.5, 1.25, 2.0], 1))
        with self.assertRaises(ValueError):
            ec.find_speed_table(exe, [3])

    def test_link_stats_measure_the_named_links(self):
        courses = [dict(index=k, points=[list(map(float, p)) for p in pts], info=list(info)) for k, (pts, info) in
                   enumerate([(ARCADE[0], (0,) * 6), (ARCADE[1], (0, 0, 2, 0, 2, 2)), (ARCADE[2], (0, 0, 1, 0, 1, 1))])]
        stats = ec.link_stats(courses, 1, 2)
        self.assertEqual(stats["next"], dict(links=2, median_gap=85.0, max_gap=130.0))
        self.assertEqual(stats["previous"], dict(links=2, median_gap=85.0, max_gap=130.0))
        self.assertEqual(stats["neighbour"]["symmetric"], 2)
        self.assertNotIn("branch", stats)

    def test_full_extraction(self):
        exe, files = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(exe)
            for n, data in enumerate(files):
                (source / ("SPLDC%d.BIN" % (n + 1))).write_bytes(data)
            out = Path(tmp) / "courses"
            manifest = ec.extract(source, out)
            self.assertEqual([f["courses"] for f in manifest["files"]], [3, 2, 3])
            arcade, original, crazy = manifest["files"]
            self.assertEqual(arcade["roles"], dict(line=1, stage=2))
            self.assertEqual(original["executable_courses"], [1])
            self.assertEqual(crazy["shared_points"], [[1, 2]])
            self.assertEqual(arcade["unreferenced_bytes"], [dict(offset=96, size=0x800 - 96)])
            self.assertEqual([r["name"] for r in crazy["runs"]], ["crazy_box_game_00", "crazy_box_game_01"])
            data = json.loads((out / "arcade.json").read_text())
            self.assertEqual(data["courses"][1][:9], [1, "stage", 0x12, 2, 8, 2, 2, 0, 2])
            self.assertEqual(data["speeds"], [0.5, 1.25, 2.0])
            glb = (out / "SPLDC3.glb").read_bytes()
            self.assertEqual(glb[:4], b"glTF")
            doc = json.loads(glb[20:20 + struct.unpack_from("<I", glb, 12)[0]])
            self.assertEqual([s["name"] for s in doc["scenes"]], ["all", "crazy_box_game_00", "crazy_box_game_01"])
            self.assertEqual({p["mode"] for m in doc["meshes"] for p in m["primitives"]}, {3})
            with self.assertRaises(ValueError):
                ec.extract(source, out)


if __name__ == "__main__":
    unittest.main()
