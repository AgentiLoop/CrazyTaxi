"""Synthetic sprite fixtures: no game files or upstream modules required."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_sprites as spr
from tools import extract_textures as tex

LOAD = spr.LOAD


def record(width, height, dt, pf, address):
    return struct.pack('<4I', height << 16 | width, dt << 8 | pf, address, 0)


END = b'\xff' * 16


def fixture_executable():
    """A loader call (table, selectors), a 16-entry palette upload, and the data they name."""
    code = struct.pack('<12H',
                       0xD405,   # 00 mov.l table,r4
                       0xD506,   # 02 mov.l selectors,r5
                       0xD106,   # 04 mov.l loader,r1
                       0x410B,   # 06 jsr @r1
                       0x0009,   # 08 nop
                       0xE400,   # 0a mov #0,r4
                       0xD505,   # 0c mov.l palette,r5
                       0xD106,   # 0e mov.l upload,r1
                       0x410B,   # 10 jsr @r1
                       0xE610,   # 12 mov #16,r6 (delay slot)
                       0x000B,   # 14 rts
                       0x0009)   # 16 nop
    pool = struct.pack('<5I', LOAD + 0x60, LOAD + 0x4C, LOAD + 0x100, LOAD + 0x2C, LOAD + 0x200)
    palette = struct.pack('<16H', *[0xF000 | i * 0x111 for i in range(15)], 0x0000)
    selectors = struct.pack('<2I', 0, 0)
    pair = b'\0' * 4 + struct.pack('<2I', 7, LOAD + 0x60)
    table = record(8, 8, 5, 2, 0x0CB40000) + record(8, 8, 1, 1, 0x0CB40020) + END
    exe = code + pool + palette + selectors + pair + table
    assert len(code + pool) == 0x2C and len(code + pool + palette + selectors) == 0x54 and exe.index(table) == 0x60
    return exe + b'\0' * (0x300 - len(exe))


class SpriteTests(unittest.TestCase):
    def test_payload_sizes(self):
        self.assertEqual(spr.payload_size(8, 8, 5), 32)
        self.assertEqual(spr.payload_size(16, 8, 7), 128)
        self.assertEqual(spr.payload_size(8, 8, 1), 128)
        with self.assertRaises(ValueError):
            spr.payload_size(12, 8, 7)

    def test_four_bit_low_nibble_first_and_selector(self):
        ram = [None] * 1024
        ram[32:48] = [0xF000 | i for i in range(16)]
        payload = bytes([0x21]) + bytes(31)  # twiddled index 0 -> 1, index 1 (x0, y1) -> 2
        rgba = spr.decode_palettised(payload, 8, 8, 5, 2, ram)
        self.assertEqual(rgba[0:4], bytes((0, 0, 17, 255)))
        self.assertEqual(rgba[8 * 4:8 * 4 + 4], bytes((0, 0, 34, 255)))

    def test_eight_bit_bank_and_rectangle_twiddle(self):
        ram = [0x0000] * 1024
        ram[256 + 5] = 0xFF00  # bank 1 (selector 16): opaque red
        payload = bytearray(128)
        payload[64] = 5  # 16x8: second 8x8 block starts at x=8
        rgba = spr.decode_palettised(bytes(payload), 16, 8, 7, 16, ram)
        self.assertEqual(rgba[8 * 4:8 * 4 + 4], bytes((255, 0, 0, 255)))
        self.assertEqual(rgba[0:4], bytes(4))
        self.assertEqual(spr.decode_palettised(bytes(payload), 16, 8, 7, 0x1F, ram), rgba)

    def test_unloaded_palette_entry_and_size_are_rejected(self):
        with self.assertRaises(ValueError):
            spr.decode_palettised(bytes(32), 8, 8, 5, 0, [None] * 1024)
        with self.assertRaises(ValueError):
            spr.decode_palettised(bytes(31), 8, 8, 5, 0, [0] * 1024)

    def test_scan_tracks_delay_slot_and_pool_constants(self):
        calls = spr.scan_calls(fixture_executable())
        self.assertIn(dict(site=LOAD + 6, function=LOAD, target=LOAD + 0x100,
                           r4=LOAD + 0x60, r5=LOAD + 0x4C, r6=None), calls)
        self.assertIn(dict(site=LOAD + 0x10, function=LOAD, target=LOAD + 0x200,
                           r4=0, r5=LOAD + 0x2C, r6=16), calls)

    def test_scan_follows_forward_branch_registers(self):
        code = struct.pack('<10H',
                           0xE407,   # 00 mov #7,r4
                           0xA002,   # 02 bra 0x0a
                           0xE509,   # 04 mov #9,r5 (delay slot)
                           0xE403,   # 06 mov #3,r4 (other path)
                           0xE501,   # 08 mov #1,r5
                           0xD101,   # 0a mov.l @(0x10),r1
                           0x410B,   # 0c jsr @r1
                           0x0009,   # 0e nop
                           0x1234, 0x0C01)
        found = {(c['r4'], c['r5']) for c in spr.scan_calls(code + bytes(16)) if c['target'] == 0x0C011234}
        self.assertEqual(found, {(7, 9), (3, 1)})

    def test_discover_tables_and_external_records(self):
        exe = bytes(16) + record(8, 8, 7, 2, 0x0CB40000) + record(8, 8, 1, 1, 0x0CB40040) \
            + record(8, 8, 1, 1, 0x0CE98000) + END
        tables = spr.discover_tables(exe, {'SPRX.BIN': 192})
        entries = tables['SPRX.BIN']['entries']
        self.assertEqual(tables['SPRX.BIN']['executable_offset'], 16)
        self.assertEqual([e['external'] for e in entries], [False, False, True])
        with self.assertRaises(ValueError):
            spr.discover_tables(exe, {'SPRX.BIN': 200})

    def test_texture_number_pairs_are_unique(self):
        tables = dict(A=dict(address=LOAD + 0x40))
        exe = struct.pack('<2I', 5, LOAD + 0x40)
        self.assertEqual(spr.texture_numbers(exe, tables), dict(A=5))
        with self.assertRaises(ValueError):
            spr.texture_numbers(exe * 2, tables)

    def test_extract_writes_pngs_manifest_and_refuses_overwrite(self):
        exe = fixture_executable()
        sprite = bytes([0x10] * 32) + struct.pack('<64H', *([0xF800] * 64))
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'disc'
            source.mkdir()
            (source / '1ST_READ.BIN').write_bytes(exe)
            (source / 'SPRX.BIN').write_bytes(sprite)
            output = Path(folder) / 'sprites'
            manifest = spr.extract(source, output)
            self.assertEqual(manifest['palette_uploads'], [dict(start=0, address=LOAD + 0x2C, count=16)])
            bank = manifest['banks'][0]
            self.assertEqual((bank['selector_address'], bank['first_texture_number']), (LOAD + 0x4C, 7))
            self.assertEqual([t['texture_number'] for t in bank['textures']], [7, 8])
            first = bank['textures'][0]
            palette = [0xF000 | i * 0x111 for i in range(15)]
            # each byte 0x10: even twiddled index -> 0, odd -> 1; odd indices are odd rows
            expected = b''.join(bytes(((palette[y & 1] >> 8 & 15) * 17,) * 3 + (255,))
                                for y in range(8) for _ in range(8))
            self.assertEqual(first['rgba_sha256'], hashlib.sha256(expected).hexdigest())
            png = (output / first['png']).read_bytes()
            self.assertEqual(hashlib.sha256(png).hexdigest(), first['png_sha256'])
            self.assertEqual(png, tex.png_bytes(8, 8, expected))
            self.assertEqual(json.loads((output / 'manifest.json').read_text())['banks'][0]['source'], 'SPRX.BIN')
            self.assertTrue((output / 'index.html').exists())
            with self.assertRaises(ValueError):
                spr.extract(source, output)


if __name__ == '__main__':
    unittest.main()
