"""Synthetic customer fixtures: no game files or upstream modules required."""
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_customers as cu

LOAD = cu.LOAD
SIZE = 0x0C0F0000 - LOAD
STOP_DATA = 0x0C0EE000  # synthetic area records and points (free space in the fixture)
COUNTS = {0: [3], 1: [2], 2: [0, 0, 0, 1, 1, 1, 1, 7, 5, 3, 8, 7, 1, 1, 1, 8]}


class Exe:
    def __init__(self):
        self.data = bytearray(SIZE)
        self.free = STOP_DATA

    def u32(self, at, value, fmt="<I"):
        struct.pack_into(fmt, self.data, at - LOAD, value)

    def u16(self, at, value, fmt="<H"):
        struct.pack_into(fmt, self.data, at - LOAD, value)

    def alloc(self, size):
        at = self.free
        self.free += (size + 3) & ~3
        return at


def area(centre, half):
    x, y, z = centre
    return [(x - half, y, z - half), (x + half, y, z - half), (x + half, y, z + half), (x - half, y, z + half)]


def afs(count):
    """An AFS archive of count empty files."""
    end = 8 + 8 * count
    return b"AFS\0" + struct.pack("<I", count) + b"".join(struct.pack("<II", end, 0) for _ in range(count))


def fixture():
    exe = Exe()
    for at, value in cu.POOL.items():
        if at in cu.POOL_HALFWORDS:
            exe.u16(at, value)
        else:
            exe.u32(at, value)
    exe.u16(0x0C02575A, 202)
    exe.u16(0x0C02588E, 246)
    # Crazy Box switch: each case label loads its table into r14 from a pool word after the labels.
    labels = 0x0C0257BC
    pool = 0x0C025890
    for k in range(cu.JUMP_COUNT):
        mini = cu.JUMP_FIRST + k
        table = [t for _, mode, _, m, t, _, _ in cu.TABLES if mode == 2 and m == mini][0]
        label = labels + 4 * k
        exe.u16(cu.JUMP + 2 * k, label - cu.JUMP, "<h")
        exe.u16(label, 0xDE00 | (pool + 4 * k - ((label & ~3) + 4)) // 4)
        exe.u32(pool + 4 * k, table)
    # stop counts and areas: [game] -> per-mini arrays
    count_rows = exe.alloc(12)
    area_rows = exe.alloc(12)
    exe.u32(cu.STOP_COUNTS, count_rows)
    exe.u32(cu.STOP_AREAS, area_rows)
    for game, counts in COUNTS.items():
        counts_at = exe.alloc(4 * len(counts))
        areas_at = exe.alloc(4 * len(counts))
        exe.u32(cu.STOP_COUNTS + 4 * game, counts_at)
        exe.u32(cu.STOP_AREAS + 4 * game, areas_at)
        for mini, n in enumerate(counts):
            exe.u32(counts_at + 4 * mini, n)
            records = exe.alloc(8 * n)
            exe.u32(areas_at + 4 * mini, records)
            for s in range(n):
                points = area((100.0 * s + 1000 * game, 5.0, 50.0 * mini), 10.0)
                at = exe.alloc(12 * len(points))
                for k, p in enumerate(points):
                    struct.pack_into("<3f", exe.data, at + 12 * k - LOAD, *p)
                exe.u32(records + 8 * s, len(points))
                exe.u32(records + 8 * s + 4, at)
    for k in range(cu.KINDS):
        exe.u32(cu.KIND_TO_CHARACTER + 4 * k, 23 + k)
    for k in range(35 * cu.VOICE_SLOTS):
        exe.u32(cu.ARCADE_VOICES + 4 * k, 100 + k)
    for k in range(cu.GENERIC_ROWS * cu.VOICE_SLOTS):
        exe.u32(cu.GENERIC_VOICES + 4 * k, 300 + k)
    for k in range(cu.REPLY_GROUPS * cu.REPLY_VARIANTS):
        struct.pack_into("<3i", exe.data, cu.REPLIES + 12 * k - LOAD, 400 + k, 75, 0x7FFFFFFF)
    for at, op in cu.CODE.items():
        exe.u16(at, op)
    name = cu.VOICE_AFS.encode() + b"\0"
    exe.data[cu.VOICE_AFS_NAME - LOAD:cu.VOICE_AFS_NAME - LOAD + len(name)] = name
    for name, _, _, mini, table, count, game in cu.TABLES:
        stops = COUNTS[game][0 if game < 2 else mini] if game is not None else 8
        for k in range(count):
            kind = -1 if k % 7 == 6 else k % cu.KINDS
            dests = [k % stops, (k + 1) % stops, -1]
            struct.pack_into("<ii3fi3bb3f", exe.data, table + cu.RECORD * k - LOAD, 0, kind,
                             10.0 * k, 0.0, 0.0, k, *dests, 0, 1.0, 2.0, 3.0)
    return exe


class CustomerTests(unittest.TestCase):
    def test_pool_check_rejects_a_moved_table(self):
        exe = fixture()
        cu.check_pool(cu.Executable(bytes(exe.data)))
        exe.u32(0x0C025780, 0x0C0D9E0C)
        with self.assertRaisesRegex(ValueError, "pool word 0x0C025780"):
            cu.check_pool(cu.Executable(bytes(exe.data)))

    def test_jump_table_reaches_each_crazy_box_table(self):
        exe = fixture()
        targets = cu.jump_targets(cu.Executable(bytes(exe.data)))
        self.assertEqual(sorted(targets), list(range(3, 15)))
        self.assertIn(0x0C0E3188, targets[8])
        cu.check_tables(cu.Executable(bytes(exe.data)))
        exe.u32(0x0C025890 + 4 * 5, 0x0C0E3110)  # game 8's case now loads game 5's table
        with self.assertRaisesRegex(ValueError, "Crazy Box game 8"):
            cu.check_tables(cu.Executable(bytes(exe.data)))

    def test_tables_are_back_to_back(self):
        spans = sorted((t, t + cu.RECORD * n) for *_, t, n, _ in cu.TABLES)
        self.assertEqual(spans[0][0], 0x0C0D9E08)
        self.assertEqual(spans[-1][1], 0x0C0E37A0)
        self.assertTrue(all(a[1] == b[0] for a, b in zip(spans, spans[1:])))

    def test_stop_centre_and_radius_follow_get_stop_pos_center(self):
        exe = cu.Executable(bytes(fixture().data))
        stops = cu.read_stops(exe, 0, 0)
        self.assertEqual(len(stops), 3)
        self.assertEqual(stops[2]["centre"], [200.0, 5.0, 0.0])
        self.assertAlmostEqual(stops[2]["radius"], 1.2 * math.hypot(10, 10), places=4)
        self.assertEqual(len(cu.read_stops(exe, 2, 10)), 8)
        self.assertEqual(cu.read_stops(exe, 2, 0), [])

    def test_customer_record_layout(self):
        exe = cu.Executable(bytes(fixture().data))
        c = cu.read_customers(exe, 0x0C0D9E08, 3)[2]
        self.assertEqual((c["kind"], c["position"], c["line_index_in_file"], c["destinations"]),
                         (2, [20.0, 0.0, 0.0], 2, [2, 0, -1]))
        self.assertEqual(c["route_lengths_in_file"], [1.0, 2.0, 3.0])

    def test_voice_rows_by_city(self):
        exe = cu.Executable(bytes(fixture().data))
        self.assertEqual(cu.voice_rows(exe, 0, 2)[1], [105, 106, 107, 108, 109])
        rows = cu.voice_rows(exe, 1, 3)
        self.assertIsNone(rows[0])
        self.assertEqual(rows[1], [140 + v for v in range(5)])  # Original stop 1 -> Arcade row 8
        self.assertEqual(cu.voice_rows(exe, 2, 1), [None])

    def test_voice_path_check_rejects_another_partition(self):
        exe = fixture()
        exe.u16(0x0C02DD08, 0xE501)  # adxStartAfs2 now starts partition 1
        with self.assertRaisesRegex(ValueError, "instruction at 0x0C02DD08"):
            cu.check_pool(cu.Executable(bytes(exe.data)))
        exe = fixture()
        exe.data[cu.VOICE_AFS_NAME - LOAD:cu.VOICE_AFS_NAME - LOAD + 4] = b"SONG"
        with self.assertRaisesRegex(ValueError, "partition 2 name"):
            cu.check_pool(cu.Executable(bytes(exe.data)))

    def test_reply_steps(self):
        replies = cu.read_replies(cu.Executable(bytes(fixture().data)))
        self.assertEqual(len(replies), 12)
        self.assertEqual(replies[7], dict(group=2, variant=1, voice=407, start_frame=75, length=0x7FFFFFFF))

    def test_voice_ids_must_be_afs_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "1ST_READ.BIN").write_bytes(bytes(fixture().data))
            (Path(tmp) / cu.VOICE_AFS).write_bytes(afs(411))  # replies reach 411
            with self.assertRaisesRegex(ValueError, "outside VOICE01.AFS's 411 files"):
                cu.extract(tmp, Path(tmp) / "out")

    def test_audio_links_and_missing_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(bytes(fixture().data))
            (source / cu.VOICE_AFS).write_bytes(afs(500))
            audio = Path(tmp) / "audio"
            (audio / "VOICE01").mkdir(parents=True)
            for v in range(500):
                if v != 411:
                    (audio / (cu.VOICE_FILE % v)).write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "lacks VOICE01/0411.wav"):
                cu.extract(source, Path(tmp) / "out", audio=audio)
            (audio / (cu.VOICE_FILE % 411)).write_bytes(b"")
            manifest = cu.extract(source, Path(tmp) / "out", audio=audio)
            page = (Path(tmp) / "out" / "index.html").read_text()
            self.assertIn('<a href="../audio/VOICE01/0105.wav">105</a>', page)
            self.assertIn('<a href="../audio/VOICE01/0400.wav">400</a>', page)
            # 3 Arcade rows + Original row 8 + 25 generic + 12 replies
            self.assertEqual(manifest["checks"]["voice_ids"], 15 + 5 + 25 + 12)
            self.assertEqual(manifest["checks"]["voice_afs_files"], 500)

    def test_destination_out_of_range_is_rejected(self):
        exe = fixture()
        struct.pack_into("<b", exe.data, 0x0C0D9E08 + 0x18 - LOAD, 5)  # Arcade fixture has 3 stops
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "1ST_READ.BIN").write_bytes(bytes(exe.data))
            with self.assertRaisesRegex(ValueError, "out of range"):
                cu.extract(tmp, Path(tmp) / "out")

    def test_full_extraction(self):
        exe = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(bytes(exe.data))
            (source / cu.VOICE_AFS).write_bytes(afs(500))
            courses = Path(tmp) / "courses"
            courses.mkdir()
            line = [[10.0 * k, 0.0, 0.0] for k in range(300)]
            (courses / "arcade.json").write_text(json.dumps(dict(courses=[[0, "line", 0, 0, 0, 0, 0, 0, 0, line]])))
            manifest = cu.extract(source, Path(tmp) / "out", courses)
            again = cu.extract(source, Path(tmp) / "out2", courses)
            self.assertEqual((Path(tmp) / "out" / "manifest.json").read_bytes(),
                             (Path(tmp) / "out2" / "manifest.json").read_bytes())
            self.assertEqual(manifest, again)
            self.assertEqual(len(manifest["customer_sets"]), len(cu.TABLES))
            self.assertEqual([(s["game_no"], s["mini_game_no"]) for s in manifest["stop_sets"]][:3],
                             [(0, 0), (1, 0), (2, 3)])
            arcade = manifest["customer_sets"][0]
            self.assertEqual(arcade["stops"], dict(game_no=0, mini_game_no=0, count=3))
            used = [c for c in arcade["customers"] if c["kind"] >= 0]
            self.assertEqual(used[0]["character"], 23)
            self.assertEqual(manifest["checks"]["line_index_is_nearest_course0_point"]["arcade"], [len(used), len(used)])
            self.assertNotIn("original", manifest["checks"]["line_index_is_nearest_course0_point"])
            self.assertEqual(manifest["checks"]["destinations"], manifest["checks"]["destinations_within_stops"])
            self.assertIsNone(manifest["customer_sets"][4]["stops"])  # CourseMode 0, mini game 15
            self.assertTrue((Path(tmp) / "out" / "index.html").read_text().startswith("<!doctype html>"))
            with self.assertRaisesRegex(ValueError, "already exists"):
                cu.extract(source, Path(tmp) / "out")


if __name__ == "__main__":
    unittest.main()
