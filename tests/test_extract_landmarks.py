"""Synthetic destination picture fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_landmarks as lm
from tools import extract_textures as tex

LOAD = lm.LOAD
BUFFER = 0x0CE98000
NAMES = ["Place %02d" % n for n in range(10)]
SECOND_BASE = 6


def record(width, height, dt, pf, address):
    return struct.pack("<4I", height << 16 | width, dt << 8 | pf, address, 0)


def fixture_executable(buffer_offset=0x08):
    """Pool (two file names, buffer), a texture pair, a sprite table, strings, names and their base pair."""
    exe = bytearray(0x200)
    strings = b"LandDC1.AFS\0LandDC2.AFS\0" + b"".join(n.encode() + b"\0" for n in NAMES)
    exe[0x80:0x80 + len(strings)] = strings
    name_at = [LOAD + 0x80 + 24 + sum(len(n) + 1 for n in NAMES[:k]) for k in range(len(NAMES))]
    struct.pack_into("<2I", exe, 0x00, LOAD + 0x80, LOAD + 0x8C)
    struct.pack_into("<I", exe, buffer_offset, BUFFER)
    struct.pack_into("<2I", exe, 0x20, 0, LOAD + 0x40)  # (texture offset, table)
    exe[0x40:0x70] = record(8, 8, 1, 1, 0x0CB40000) + record(8, 8, 1, 1, BUFFER) + b"\xff" * 16
    struct.pack_into("<%dI" % len(NAMES), exe, 0x100, *name_at)
    struct.pack_into("<2I", exe, 0x100 + 4 * len(NAMES), LOAD + 0x100, LOAD + 0x100 + 4 * SECOND_BASE)
    return bytes(exe)


def picture(colour, frame=True):
    """An 8x8 twiddled RGB565 payload: a white 2-pixel frame around one colour."""
    words = [0] * 64
    for y in range(8):
        for x in range(8):
            edge = frame and min(x, y, 7 - x, 7 - y) < 2
            words[tex.spread(x) << 1 | tex.spread(y)] = 0xFFFF if edge else colour
    return struct.pack("<64H", *words)


def afs(payloads):
    count = len(payloads)
    data = bytearray(b"AFS\0" + struct.pack("<I", count))
    offset = (8 + 8 * count + 31) & ~31
    table, body = [], bytearray()
    for p in payloads:
        table.append((offset + len(body), len(p)))
        body += p
    for o, s in table:
        data += struct.pack("<II", o, s)
    data += bytes(offset - len(data)) + body
    return bytes(data)


class LandmarkTests(unittest.TestCase):
    def test_stream_target_is_the_pooled_external_record(self):
        exe = fixture_executable()
        names = [lm.find_file_name(exe, n) for n in lm.FILES]
        target = lm.find_stream_target(exe, {"SPRCOMM.BIN": bytes(128)}, 128, names)
        self.assertEqual((target["bank"], target["index"], target["texture_number"]), ("SPRCOMM.BIN", 1, 1))
        self.assertEqual((target["buffer"], target["pool_literal"]), (BUFFER, LOAD + 0x08))
        self.assertEqual((target["width"], target["data_type"], target["pixel_format"]), (8, 1, 1))

    def test_stream_target_needs_the_buffer_beside_the_file_names(self):
        exe = fixture_executable(buffer_offset=0x1F0)
        names = [lm.find_file_name(exe, n) for n in lm.FILES]
        with self.assertRaises(ValueError):
            lm.find_stream_target(exe, {"SPRCOMM.BIN": bytes(128)}, 128, names)

    def test_name_table_and_city_bases(self):
        start, pair, names, bases = lm.find_name_table(fixture_executable(), 2)
        self.assertEqual((start, pair), (LOAD + 0x100, LOAD + 0x100 + 4 * len(NAMES)))
        self.assertEqual(names, NAMES)
        self.assertEqual(bases, [LOAD + 0x100, LOAD + 0x100 + 4 * SECOND_BASE])

    def test_white_frame(self):
        self.assertTrue(lm.white_frame(tex.decode(picture(0x1234), 8, 8, 1, 1), 8, 8))
        self.assertFalse(lm.white_frame(tex.decode(picture(0x1234, frame=False), 8, 8, 1, 1), 8, 8))

    def test_full_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, out = Path(tmp) / "disc", Path(tmp) / "landmarks"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(fixture_executable())
            (source / "SPRCOMM.BIN").write_bytes(bytes(128))
            shared = picture(0x07E0)
            (source / "LANDDC1.AFS").write_bytes(afs([picture(0xF800), shared, bytes(128)]))
            (source / "LANDDC2.AFS").write_bytes(afs([picture(0x001F), picture(0x1234, frame=False), shared,
                                                      picture(0x4321), picture(0x5555)]))
            manifest = lm.extract(source, out)
            first, second = manifest["files"]
            self.assertEqual([e["name"] for e in first["entries"]], NAMES[:3])
            self.assertEqual([e["name"] for e in second["entries"]], NAMES[6:10] + [None])
            self.assertTrue(first["entries"][2]["empty"])
            self.assertNotIn("png", first["entries"][2])
            self.assertEqual([e["white_frame"] for e in second["entries"]], [True, False, True, True, True])
            self.assertEqual(manifest["shared_between_files"], [[["LANDDC1.AFS", 1], ["LANDDC2.AFS", 2]]])
            png = (out / "LANDDC1" / "00.png").read_bytes()
            self.assertEqual(png, tex.png_bytes(8, 8, tex.decode(picture(0xF800), 8, 8, 1, 1)))
            self.assertEqual(json.loads((out / "manifest.json").read_text())["name_list"]["count"], len(NAMES))
            with self.assertRaises(ValueError):
                lm.extract(source, out)


if __name__ == "__main__":
    unittest.main()
