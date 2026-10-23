"""Synthetic Flycast texture pack fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from tools import match_texture_pack as pack
from tools.extract_textures import png_bytes


class TexturePackTests(unittest.TestCase):
    def test_xxh32_reference_vectors(self):
        self.assertEqual(pack.xxh32(b"", 0), 0x02CC5D05)
        self.assertEqual(pack.xxh32(b"abc", 0), 0x32D153FF)
        self.assertEqual(pack.xxh32(b"Nobody inspects the spammish repetition", 0), 0xE2293B2F)

    def test_texture_hash_regions_and_tcw(self):
        body = bytes(range(128))  # 8x8 16-bit top level
        self.assertEqual(pack.texture_hash(body, 8, 8, 1, 1), pack.xxh32(body) ^ 0x08000000)
        self.assertEqual(pack.texture_hash(body, 8, 8, 9, 2), pack.xxh32(body) ^ 0x14000000)
        # mipmapped: top level 2 bytes before extract_textures.layout's 46-byte prefix
        mip = bytes(44) + body
        self.assertEqual(pack.texture_hash(mip, 8, 8, 2, 0), pack.xxh32(body) ^ 0x80000000)
        # VQ: codebook + top-level indices
        codebook, indices = bytes(range(256)) * 8, bytes(16)
        self.assertEqual(pack.texture_hash(codebook + indices, 8, 8, 3, 1),
                         pack.xxh32(codebook + indices) ^ 0x48000000)
        prefix = 2048 + 1 + 1 + 4  # codebook, 1x1, 2x2, 4x4 index levels
        vq_mip = codebook + bytes(prefix - 2048) + indices
        self.assertEqual(pack.texture_hash(vq_mip, 8, 8, 4, 2), pack.xxh32(codebook + indices) ^ 0xD0000000)

    def test_palette_hash(self):
        ram = [None] * 1024
        ram[32:48] = range(0xF000, 0xF010)
        payload = bytes(32)  # 8x8 4-bit
        palette = struct.pack("<16I", *range(0xF000, 0xF010))
        self.assertEqual(pack.palette_hash(payload, 5, 2, ram),
                         pack.xxh32(payload) ^ pack.xxh32(palette) ^ 0x28000000)
        ram[256:512] = [0x1234] * 256
        self.assertEqual(pack.palette_hash(bytes(64), 7, 0x1F, ram),
                         pack.xxh32(bytes(64)) ^ pack.xxh32(struct.pack("<256I", *[0x1234] * 256)) ^ 0x30000000)

    def test_pack_index_reads_leading_hex_like_flycast(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("1a2b.png", "1A2B-.png", "d1b3bff8bkp.jpg", "notes.txt", "zz.png"):
                Path(folder, name).write_bytes(b"")
            index = pack.pack_index(folder)
        self.assertEqual(index, {0x1A2B: ["1A2B-.png", "1a2b.png"], 0x1B3BFF8B: ["d1b3bff8bkp.jpg"]})

    def test_image_size(self):
        with tempfile.TemporaryDirectory() as folder:
            png = Path(folder, "a.png")
            png.write_bytes(png_bytes(3, 2, bytes(24)))
            jpg = Path(folder, "b.jpg")
            jpg.write_bytes(b"\xff\xd8\xff\xe0\x00\x04ab\xff\xc0\x00\x0b\x08\x00\x30\x00\x40\x01\x01\x11\x00")
            self.assertEqual(pack.image_size(png), (3, 2))
            self.assertEqual(pack.image_size(jpg), (64, 48))

    def test_match_links_and_manifest(self):
        textures = [("TEXDC0", 0, "textures/TEXDC0/0000.png", 8, 8, 0xABC),
                    ("TEXDC0", 1, "textures/TEXDC0/0001.png", 8, 8, 0xDEF)]
        with tempfile.TemporaryDirectory() as folder:
            source, store = Path(folder, "disc"), Path(folder, "pack")
            source.mkdir(), store.mkdir()
            Path(store, "abc.PNG").write_bytes(png_bytes(32, 32, bytes(32 * 32 * 4)))
            Path(store, "123.png").write_bytes(b"")
            with patch.object(pack, "game_textures", return_value=iter(textures)):
                manifest = pack.match(source, store, Path(folder, "out"))
            self.assertEqual((manifest["matched_textures"], manifest["game_textures"]), (1, 2))
            self.assertEqual(manifest["unmatched_pack_files"], ["123.png"])
            record = manifest["textures"][0]
            self.assertEqual((record["pack_file"], record["pack_width"], record["link"]),
                             ("abc.PNG", 32, "textures/TEXDC0/0000.png"))
            self.assertTrue(Path(folder, "out", record["link"]).resolve().samefile(Path(store, "abc.PNG")))
            saved = json.loads(Path(folder, "out", "manifest.json").read_text())
            self.assertEqual(saved["groups"], {"TEXDC0": {"matched": 1, "total": 2}})
            with self.assertRaises(ValueError):
                pack.match(source, store, Path(folder, "out"))


if __name__ == "__main__":
    unittest.main()
