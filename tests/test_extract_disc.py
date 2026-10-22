"""Synthetic disc fixtures only; no copyrighted game data required."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("extract_disc", Path(__file__).parents[1] / "tools" / "extract_disc.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def number(value):
    return struct.pack("<I", value) + struct.pack(">I", value)


def record(name, sector, size, directory=False):
    result = bytearray(33 + len(name) + (len(name) % 2 == 0))
    result[0] = len(result)
    result[2:10] = number(reader.HD_LBA + sector)
    result[10:18] = number(size)
    result[25] = 2 if directory else 0
    result[28:32] = b"\x01\x00\x00\x01"
    result[32] = len(name)
    result[33:33 + len(name)] = name
    return result


def fixture():
    sectors = [bytearray(reader.PAYLOAD) for _ in range(30)]
    sectors[0][:16] = b"SEGA SEGAKATANA "
    pvd = sectors[16]
    pvd[:7] = b"\x01CD001\x01"
    pvd[40:72] = b"SYNTHETIC".ljust(32, b" ")
    pvd[128:132] = b"\x00\x08\x08\x00"
    pvd[156:190] = record(b"\x00", 20, 4096, True)
    content = bytes(i % 251 for i in range(3001))
    root = record(b"\x00", 20, 4096, True) + record(b"\x01", 20, 4096, True)
    root += record(b"DATA.BIN;1", 24, len(content))
    sectors[20][:len(root)] = root
    nested = record(b"SUB", 22, 2048, True)
    sectors[21][:len(nested)] = nested
    child = record(b"ZERO.DAT;1", 26, 0)
    sectors[22][:len(child)] = child
    sectors[24][:2048] = content[:2048]
    sectors[25][:len(content) - 2048] = content[2048:]
    return sectors, content


class DiscTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.track = self.root / "track.bin"
        self.sectors, self.content = fixture()

    def write_track(self):
        with self.track.open("wb") as handle:
            for payload in self.sectors:
                self.assertEqual(len(payload), 2048)
                handle.write(reader.SYNC + b"\x00\x00\x00\x01" + payload + bytes(288))

    def assert_bad(self, text):
        self.write_track()
        with reader.RawTrack(self.track) as disc:
            with self.assertRaisesRegex(ValueError, text):
                disc.files()

    def test_extract_and_manifest(self):
        self.write_track()
        output = self.root / "out"
        result = reader.extract(self.track, output)
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(result["total_bytes"], len(self.content))
        self.assertEqual((output / "DATA.BIN").read_bytes(), self.content)
        self.assertEqual((output / "SUB/ZERO.DAT").read_bytes(), b"")
        self.assertEqual((output / "IP.BIN").stat().st_size, 32768)
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(self.track.read_bytes()).hexdigest())
        self.assertEqual(result, json.loads((output / "manifest.json").read_text()))
        for entry in result["files"] + [result["bootstrap"]]:
            self.assertEqual(entry["sha256"], hashlib.sha256((output / entry["path"]).read_bytes()).hexdigest())
        with self.assertRaises(FileExistsError):
            reader.extract(self.track, output)

    def test_bad_descriptor(self):
        self.sectors[16][1] = 0
        self.assert_bad("descriptor")

    def test_endian_disagreement(self):
        self.sectors[16][158] ^= 1
        self.assert_bad("endian")

    def test_extent_outside_track(self):
        self.sectors[20][70:78] = number(reader.HD_LBA + 100)
        self.assert_bad("outside")

    def test_directory_cycle(self):
        self.sectors[21][2:10] = number(reader.HD_LBA + 20)
        self.assert_bad("Cyclic")

    def test_traversal_and_unsafe_names(self):
        for raw in (b"..", b"../escape", b"/abs", b"a\\b", b"x:y", b"\x00", b";1"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                reader.safe_name(raw)

    def test_duplicate_path(self):
        duplicate = record(b"data.bin;1", 26, 0)
        self.sectors[21][:len(duplicate)] = duplicate
        self.assert_bad("Duplicate")

    def test_multi_extent_rejected(self):
        self.sectors[20][68 + 25] = 0x80
        self.assert_bad("multi-extent")

    def test_short_record(self):
        self.sectors[20][68] = 12
        self.assert_bad("record length")

    def test_truncated_track(self):
        self.write_track()
        with self.track.open("ab") as handle:
            handle.write(b"x")
        with self.assertRaisesRegex(ValueError, "multiple"):
            reader.RawTrack(self.track)

    def test_sector_mode_and_partial_cleanup(self):
        self.write_track()
        with self.track.open("r+b") as handle:
            handle.seek(24 * reader.SECTOR + 15)
            handle.write(b"\x02")
        output = self.root / "out"
        with self.assertRaisesRegex(ValueError, "Mode 1"):
            reader.extract(self.track, output)
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(".out-*")), [])


if __name__ == "__main__":
    unittest.main()
