"""Synthetic replay cut fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_replay_cuts as rc
from tools import extract_customers as cu
from tests.test_extract_replays import generator_values, drive

LOAD = rc.LOAD
SIZE = 0x0C0F3100 - LOAD
NAME_DATA = 0x0C0E8000  # free space in the fixture for the destination names
NAMES = ["Arcade %d" % k for k in range(3)] + ["Original %d" % k for k in range(5)]
ADV_FRAMES = ([0, 4, 9], [0, 6])
FRAMES = 12


def u32(exe, at, value, fmt="<I"):
    struct.pack_into(fmt, exe, at - LOAD, value)


def snapshot(exe, table, index, position, car_type=1):
    at = table + rc.SNAPSHOT * index
    u32(exe, at, car_type, "<i")
    car = at + 4
    struct.pack_into("<3f", exe, car - LOAD, *position)
    struct.pack_into("<3f", exe, car + rc.CAR_POSITION - LOAD, *position)
    struct.pack_into("<3f", exe, car + rc.CAR_VELOCITY - LOAD, 0.0, 0.0, 2.0)
    struct.pack_into("<16f", exe, car + rc.CAR_MATRIX - LOAD, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, *position, 1)


def rows(exe, table, items):
    """items: (frame, camera_only, snapshot, style, character, point, extra_18, extra_1c); rest end at 5400."""
    for k in range(rc.ROWS):
        row = items[k] if k < len(items) else (rc.FRAME_LIMIT, 0, 0, 3, 0, 0, 0, 0)
        struct.pack_into("<8i", exe, table + rc.ROW * k - LOAD, *row)


def fixture():
    exe = bytearray(SIZE)
    for at, value in rc.POOL.items():
        u32(exe, at, value)
    for at, value in rc.HALFWORDS.items():
        u32(exe, at, value, "<H")
    for at, op in rc.CODE.items():
        u32(exe, at, op, "<H")
    for at, text in rc.STRINGS.items():
        exe[at - LOAD:at - LOAD + len(text)] = text
    strings, free = [], NAME_DATA + 4 * (len(NAMES) + 1)
    for text in NAMES:
        exe[free - LOAD:free - LOAD + len(text)] = text.encode()
        strings.append(free)
        free += 16
    for k, at in enumerate(strings):
        u32(exe, NAME_DATA + 4 * k, at)
    u32(exe, cu.LANDMARK_NAME_BASES, NAME_DATA)
    u32(exe, cu.LANDMARK_NAME_BASES + 4, NAME_DATA + 12)
    for city in range(2):
        for n in range(rc.SNAPSHOTS - 1):
            snapshot(exe, rc.SNAPSHOT_TABLES[city], n, (100.0 * n, 5.0, 1000.0 * city), car_type=n % 4)
        for n in range(rc.POINTS):
            struct.pack_into("<3f", exe, rc.POINT_TABLES[city] + 12 * n - LOAD, 100.0 * n + 3, 5.0, 1000.0 * city)
    for (_, table), frames in zip(rc.CUT_TABLES[:2], ADV_FRAMES):
        rows(exe, table, [(f, 0, k, 1 + k % 4, 23, 0, 0, 0) for k, f in enumerate(frames)])
    rows(exe, rc.CUT_TABLES[2][1], [(2, 0, 40, 4, 30, 1, 0, 77), (7, 0, 41, 4, -1, 2, 0, 0)])
    rows(exe, rc.CUT_TABLES[3][1], [(3, 0, 40, 4, 41, 4, 1, -5), (8, 1, 0, -1, 23, 0, 0, 0)])
    return exe


def gaps_with_reseeds(frames):
    return [0 if n in frames else 1 + n % 3 for n in range(FRAMES)]


def write_disc(folder, exe):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "1ST_READ.BIN").write_bytes(bytes(exe))
    recordings = [gaps_with_reseeds(ADV_FRAMES[0]), gaps_with_reseeds(ADV_FRAMES[1]),
                  gaps_with_reseeds([0]), gaps_with_reseeds([0])]
    for name, gaps in zip(rc.FILES, recordings):
        (folder / name).write_bytes(drive(FRAMES, generator_values(gaps)))
    return folder


def customers(folder, shift=0.0):
    """An extract_customers manifest with stop n centred on point n (moved by shift) and radius 10."""
    sets = [dict(game_no=city, mini_game_no=0, stops=[dict(index=n, centre=[100.0 * n + 3 + shift, 5.0, 1000.0 * city],
                                                           radius=10.0) for n in range(count)])
            for city, count in ((0, 3), (1, 5))]
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_text(json.dumps(dict(stop_sets=sets)))
    return folder


class ReplayCutTests(unittest.TestCase):
    def run_extract(self, exe, extra=None, **kw):
        with tempfile.TemporaryDirectory() as tmp:
            disc = write_disc(Path(tmp) / "disc", exe)
            if extra:
                extra(disc)
            manifest = rc.extract(disc, Path(tmp) / "out", **kw)
            page = (Path(tmp) / "out" / "index.html").read_text()
            written = json.loads((Path(tmp) / "out" / "manifest.json").read_text())
            return manifest, page, written

    def test_full_extract(self):
        manifest, page, written = self.run_extract(fixture())
        self.assertEqual(written, json.loads(json.dumps(manifest)))
        files = manifest["files"]
        self.assertEqual([f["replay_type"] for f in files], [1, 2, 3, 3])
        self.assertEqual([f["rows_used"] for f in files], [3, 2, 2, 2])
        self.assertTrue(files[0]["cut_frames_are_reseed_frames"])
        adv = files[0]["cuts"]
        self.assertEqual([(c["frame"], c["end_frame"]) for c in adv], [(0, 4), (4, 9), (9, rc.FRAME_LIMIT)])
        self.assertEqual(adv[1]["snapshot"]["index"], 1)
        self.assertEqual(adv[1]["snapshot"]["car_type"], 1)
        self.assertEqual(adv[1]["snapshot"]["position"], [100.0, 5.0, 0.0])
        self.assertEqual(adv[1]["camera"]["routine"], "ExecAdvCameraChase")
        self.assertEqual(adv[0]["camera"]["point"], [3.0, 5.0, 0.0])
        self.assertNotIn("passenger", adv[0])
        end = files[2]["cuts"]
        self.assertEqual(end[0]["passenger"], dict(character=30, destination_stop=1, landmark="Arcade 1",
                                                   end_psg_args=[0, 77]))
        self.assertEqual(end[0]["camera"]["routine"], "ExecAdvCameraFixed")
        self.assertNotIn("passenger", end[1])
        original = files[3]["cuts"]
        self.assertEqual(original[0]["passenger"]["landmark"], "Original 4")
        self.assertIsNone(original[1]["snapshot"])
        self.assertNotIn("point", original[1]["camera"])
        self.assertEqual(original[1]["camera"]["routine"], "camera mode 6")
        self.assertEqual(manifest["point_tables"][1]["points"][4]["landmark"], "Original 4")
        self.assertIsNone(manifest["point_tables"][0]["points"][3]["landmark"])
        self.assertIn("Arcade 1", page)

    def test_deterministic(self):
        first = self.run_extract(fixture())[2]
        self.assertEqual(first, self.run_extract(fixture())[2])

    def test_pool_word_checked(self):
        exe = fixture()
        u32(exe, 0x0C04AE78, 0x0C0A3604)
        with self.assertRaisesRegex(ValueError, "pool word 0x0C04AE78"):
            self.run_extract(exe)

    def test_instruction_and_string_checked(self):
        exe = fixture()
        u32(exe, 0x0C02CB4A, 0xE404, "<H")
        with self.assertRaisesRegex(ValueError, "instruction at 0x0C02CB4A"):
            self.run_extract(exe)
        exe = fixture()
        exe[0x0C0C222C - LOAD] = ord("X")
        with self.assertRaisesRegex(ValueError, "debug string"):
            self.run_extract(exe)

    def test_cut_frames_must_be_reseed_frames(self):
        exe = fixture()
        rows(exe, rc.CUT_TABLES[0][1], [(0, 0, 0, 3, 23, 0, 0, 0), (5, 0, 1, 3, 23, 0, 0, 0)])
        with self.assertRaisesRegex(ValueError, "not the reseed frames"):
            self.run_extract(exe)

    def test_rows_must_increase_and_end(self):
        exe = fixture()
        rows(exe, rc.CUT_TABLES[0][1], [(0, 0, 0, 3, 23, 0, 0, 0), (0, 0, 1, 3, 23, 0, 0, 0)])
        with self.assertRaisesRegex(ValueError, "does not follow"):
            rc.read_rows(cu.Executable(bytes(exe)), rc.CUT_TABLES[0][1])
        rows(exe, rc.CUT_TABLES[0][1], [(k, 0, 0, 3, 23, 0, 0, 0) for k in range(rc.ROWS)])
        with self.assertRaisesRegex(ValueError, "no end row"):
            rc.read_rows(cu.Executable(bytes(exe)), rc.CUT_TABLES[0][1])

    def test_empty_snapshot_rejected(self):
        exe = fixture()
        rows(exe, rc.CUT_TABLES[2][1], [(2, 0, rc.SNAPSHOTS - 1, 4, 30, 1, 0, 0)])
        with self.assertRaisesRegex(ValueError, "is empty"):
            self.run_extract(exe)

    def test_snapshot_must_be_car_block(self):
        exe = fixture()
        struct.pack_into("<f", exe, rc.SNAPSHOT_TABLES[0] + 4 + rc.CAR_MATRIX - LOAD, 2.0)
        with self.assertRaisesRegex(ValueError, "not a car block"):
            self.run_extract(exe)

    def test_stop_and_point_ranges(self):
        exe = fixture()
        rows(exe, rc.CUT_TABLES[2][1], [(2, 0, 40, 4, 30, 3, 0, 0)])
        with self.assertRaisesRegex(ValueError, "stop 3 outside Arcade"):
            self.run_extract(exe)
        exe = fixture()
        rows(exe, rc.CUT_TABLES[2][1], [(2, 0, 40, 4, 30, rc.POINTS, 0, 0)])
        with self.assertRaisesRegex(ValueError, "point 34 outside"):
            self.run_extract(exe)

    def test_points_checked_against_customer_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = customers(Path(tmp) / "good")
            manifest = self.run_extract(fixture(), customers=good)[0]
            self.assertEqual([len(t["stop_check"]) for t in manifest["point_tables"]], [3, 5])
            self.assertEqual(manifest["point_tables"][0]["stop_check"][2]["distance"], 0.0)
            bad = customers(Path(tmp) / "bad", shift=50.0)
            with self.assertRaisesRegex(ValueError, "point 0 is 50 from stop 0"):
                self.run_extract(fixture(), customers=bad)


if __name__ == "__main__":
    unittest.main()
