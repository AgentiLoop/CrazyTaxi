"""Synthetic recorded-drive fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_replays as rp

LOAD = rp.LOAD
BUFFER, CAPACITY = 0x0C30C000, 0x1C000


def fixture_executable(order=(0, 1, 2, 3), capacity=CAPACITY):
    """Mixed-case names at 0x100 and the loader pool (buffer, capacity, routine, four names) at 0x40."""
    exe = bytearray(0x200)
    names = [b"recAdvAC.BIN", b"recAdvDC.BIN", b"recEndAC.BIN", b"recEndDC.BIN"]
    for k, name in enumerate(names):
        exe[0x100 + 0x10 * k:0x100 + 0x10 * k + len(name)] = name
    pointers = [LOAD + 0x100 + 0x10 * k for k in order]
    struct.pack_into("<7I", exe, 0x40, BUFFER, capacity, LOAD + 0x80, *pointers)
    return bytes(exe)


def generator_values(gaps):
    """Recorded values for per-frame call counts; 0 means a reseed before the frame's single call."""
    state, values = None, []
    for gap in gaps:
        if gap == 0:
            state, gap = rp.RAND_SEED, 1
        for _ in range(gap):
            state = (state * rp.RAND_MUL + rp.RAND_ADD) & 0xFFFFFFFF
        values.append(rp.rand_value(state))
    return values


def recording(frames):
    return b"".join(struct.pack("<3f2I", *frame) for frame in frames)


def drive(count, seed_value):
    frames = []
    for n in range(count):
        buttons = 0
        if n in (3, 4):
            buttons = rp.REVERSE_HELD | (rp.REVERSE_PRESSED if n == 3 else 0)
        frames.append(((n % 5 - 2) / 2, 1.0 if n < 3 else 0.0, 0.5 if n >= 3 else 0.0, buttons,
                       seed_value[n]))
    return recording(frames)


class ReplayTests(unittest.TestCase):
    def test_generator_matches_continuations_and_reseeds(self):
        values = generator_values([0, 259, 24, 0, 30])
        steps, reseeded = rp.rng_sync(values)
        self.assertEqual(steps, [1, 259, 24, 1, 30])
        self.assertEqual(reseeded, [0, 3])
        self.assertEqual(values[0], 21468)  # first value after the 12345 reseed, as in every recording

    def test_unmatched_frame_loses_state_until_reseed(self):
        values = generator_values([0, 10, 20])
        values[1] ^= 1
        steps, reseeded = rp.rng_sync(values + generator_values([0, 5]))
        self.assertEqual((steps[1], steps[2]), (None, None))
        self.assertEqual(steps[3:], [1, 5])
        self.assertEqual(reseeded, [0, 3])

    def test_gap_limit(self):
        values = generator_values([0, 50])
        self.assertEqual(rp.rng_sync(values, max_gap=49)[0], [1, None])
        self.assertEqual(rp.rng_sync(values, max_gap=50)[0], [1, 50])

    def test_parse_columns(self):
        data = recording([(0.5, 1.0, 0.0, 0, 7), (-1.0, 0.0, 1.0, rp.DRIVE_HELD | rp.DRIVE_PRESSED, 8),
                          (0.0, 0.0, 1.0, rp.DRIVE_HELD, 9)])
        columns = rp.parse(data)
        self.assertEqual(columns["steering"], [0.5, -1.0, 0.0])
        self.assertEqual(columns["buttons"], [0, rp.DRIVE_HELD | rp.DRIVE_PRESSED, rp.DRIVE_HELD])
        self.assertEqual(columns["random"], [7, 8, 9])

    def test_parse_rejections(self):
        bad = [b"", bytes(21), recording([(0, 0, 0, 0x40, 0)]), recording([(2.0, 0, 0, 0, 0)]),
               recording([(0, 0, 0, 0, 0x8000)]),
               recording([(0, 0, 0, rp.REVERSE_PRESSED, 0)]),
               recording([(0, 0, 0, rp.DRIVE_HELD, 0), (0, 0, 0, rp.DRIVE_HELD | rp.DRIVE_PRESSED, 0)])]
        for data in bad:
            with self.assertRaises(ValueError):
                rp.parse(data)

    def test_loader_pool(self):
        pool, buffer, capacity, names = rp.find_loader(fixture_executable(), [108000])
        self.assertEqual((pool, buffer, capacity), (LOAD + 0x4C, BUFFER, CAPACITY))
        self.assertEqual(names, [LOAD + 0x100 + 0x10 * k for k in range(4)])

    def test_loader_rejects_other_orders_and_small_buffers(self):
        for exe, size in ((fixture_executable(order=(1, 0, 2, 3)), 100), (fixture_executable(), CAPACITY + 1),
                          (fixture_executable(capacity=0x200000), 100)):
            with self.assertRaises(ValueError):
                rp.find_loader(exe, [size])

    def test_full_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            disc = Path(temp) / "disc"
            disc.mkdir()
            (disc / "1ST_READ.BIN").write_bytes(fixture_executable())
            values = generator_values([0, 259, 412, 24, 0, 26])
            for name in rp.FILES:
                (disc / name).write_bytes(drive(6, values))
            output = Path(temp) / "out"
            manifest = rp.extract(disc, output)
            self.assertEqual(manifest["loader"]["buffer"], BUFFER)
            first = manifest["files"][0]
            self.assertEqual((first["kind"], first["city"], first["frames"]), ("advertise", "Arcade", 6))
            self.assertEqual(first["random_calls_per_frame"], [1, 259, 412, 24, 1, 26])
            self.assertEqual((first["random_frames_in_sync"], first["random_reseed_frames"]), (6, [0, 4]))
            self.assertEqual(first["presses"], dict(reverse_pressed=1, drive_pressed=0))
            self.assertEqual([f["city"] for f in manifest["files"]], ["Arcade", "Original"] * 2)
            track = json.loads((output / "recenddc.json").read_text())
            self.assertEqual((track["kind"], track["city"], track["frames"]), ("ending", "Original", 6))
            self.assertEqual(track["accelerator"][:4], [1.0, 1.0, 1.0, 0.0])
            self.assertIn("<svg", (output / "index.html").read_text())
            with self.assertRaises(ValueError):
                rp.extract(disc, output)


if __name__ == "__main__":
    unittest.main()
