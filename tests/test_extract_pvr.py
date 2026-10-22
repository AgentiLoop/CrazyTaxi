"""Synthetic stand-alone PVR fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_pvr as pvr
from tools import extract_textures as tex


def pvr_file(width=8, height=8, data_type=1, pixel_format=2, words=None, gbix=None, extra=0):
    words = words if words is not None else [0xF000 | n for n in range(width * height)]
    payload = struct.pack("<%dH" % len(words), *words)
    body = struct.pack("<BBHHH", pixel_format, data_type, 0, width, height) + payload
    data = b"PVRT" + struct.pack("<I", len(body) + extra) + body
    if gbix is not None:
        data = b"GBIX" + struct.pack("<III", 8, gbix, 0) + data
    return data


class ParseTests(unittest.TestCase):
    def test_header_fields(self):
        info = pvr.parse(pvr_file(16, 16, 1, 1, words=[0] * 256))
        self.assertEqual((info["width"], info["height"], info["data_type"], info["pixel_format"]), (16, 16, 1, 1))
        self.assertIsNone(info["global_index"])
        self.assertEqual(len(info["payload"]), 512)

    def test_gbix_prefix(self):
        info = pvr.parse(pvr_file(gbix=1234))
        self.assertEqual((info["global_index"], info["header_offset"]), (1234, 16))

    def test_rejects_length_mismatch(self):
        with self.assertRaises(ValueError):
            pvr.parse(pvr_file(extra=2))
        with self.assertRaises(ValueError):
            pvr.parse(pvr_file() + b"\0\0")

    def test_rejects_missing_chunk_and_reserved(self):
        with self.assertRaises(ValueError):
            pvr.parse(b"XXXX" + bytes(12))
        data = bytearray(pvr_file())
        data[10] = 1
        with self.assertRaises(ValueError):
            pvr.parse(bytes(data))

    def test_twiddled_pixels_match_texture_decoder(self):
        data = pvr_file()
        info = pvr.parse(data)
        rgba = tex.decode(info["payload"], 8, 8, 1, 2)
        # Twiddled index 1 is (x=0, y=1); ARGB4444 0xF001 -> blue 17, alpha 255.
        self.assertEqual(rgba[8 * 4:8 * 4 + 4], bytes((0, 0, 17, 255)))


class ExtractTests(unittest.TestCase):
    def test_writes_png_manifest_and_page(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "disc"
            source.mkdir()
            (source / "0GDTEX.PVR").write_bytes(pvr_file(words=[0x0FFF] * 32 + [0xFFFF] * 32))
            (source / "OTHER.BIN").write_bytes(b"ignored")
            manifest = pvr.extract(source, Path(root) / "out")
            item = manifest["files"][0]
            self.assertEqual((item["source"], item["png"], item["opaque"], item["alpha_levels"]),
                             ("0GDTEX.PVR", "0GDTEX.png", False, 2))
            png = (Path(root) / "out" / "0GDTEX.png").read_bytes()
            self.assertTrue(png.startswith(b"\x89PNG"))
            self.assertEqual(tex.digest(png), item["png_sha256"])
            self.assertEqual(json.loads((Path(root) / "out" / "manifest.json").read_text()), manifest)
            self.assertTrue((Path(root) / "out" / "index.html").exists())
            with self.assertRaises(ValueError):
                pvr.extract(source, Path(root) / "out")

    def test_no_pvr_files_leaves_no_output(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                pvr.extract(root, Path(root) / "out")
            self.assertFalse((Path(root) / "out").exists())


if __name__ == "__main__":
    unittest.main()
