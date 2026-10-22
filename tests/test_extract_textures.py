"""Synthetic texture fixtures: no game files or upstream modules required."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

from tools import extract_textures as tex


def words(values):
    return struct.pack('<%dH' % len(values), *values)


def record(width=8, height=8, dt=9, pf=1, address=0x0C400000, reserved=0):
    return struct.pack('<4I', height << 16 | width, dt << 8 | pf, address, reserved)


class TextureTests(unittest.TestCase):
    def test_pixel_formats(self):
        self.assertEqual(tex.pixel(0xFC00, 0), bytes((255, 0, 0, 255)))
        self.assertEqual(tex.pixel(0x03E0, 0), bytes((0, 255, 0, 0)))
        self.assertEqual(tex.pixel(0x07E0, 1), bytes((0, 255, 0, 255)))
        self.assertEqual(tex.pixel(0x8123, 2), bytes((17, 34, 51, 136)))
        with self.assertRaises(ValueError):
            tex.pixel(0, 3)

    def test_layout_sizes(self):
        self.assertEqual(tex.layout(8, 8, 1), (0, 128))
        self.assertEqual(tex.layout(8, 8, 2), (46, 174))
        self.assertEqual(tex.layout(16, 16, 2), (174, 686))
        self.assertEqual(tex.layout(8, 8, 3), (2048, 2064))
        self.assertEqual(tex.layout(8, 8, 4), (2054, 2070))
        self.assertEqual(tex.layout(16, 16, 4), (2070, 2134))
        self.assertEqual(tex.layout(8, 16, 13), (0, 256))

    def test_reject_bad_dimensions_formats_and_length(self):
        for w, h, dt in ((0, 8, 1), (12, 8, 9), (2048, 8, 9), (8, 16, 1),
                         (8, 16, 2), (16, 8, 3), (16, 8, 4), (8, 8, 5)):
            with self.subTest(w=w, h=h, dt=dt), self.assertRaises(ValueError):
                tex.layout(w, h, dt)
        for dt in tex.FORMATS:
            _, size = tex.layout(8, 8, dt)
            for length in (0, size - 1, size + 1):
                with self.subTest(dt=dt, length=length), self.assertRaises(ValueError):
                    tex.decode(bytes(length), 8, 8, dt, 1)
        with self.assertRaises(ValueError):
            tex.decode(bytes(128), 8, 8, 1, 3)

    def test_linear_little_endian(self):
        rgba = tex.decode(words([0xF800, 0x07E0, 0x001F] + [0] * 61), 8, 8, 9, 1)
        self.assertEqual(rgba[:12], bytes((255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255)))

    def test_twiddle_and_mip_top_level(self):
        values = [0] * 64
        values[2], values[1], values[8], values[4] = 0xF800, 0x07E0, 0x001F, 0xFFFF
        for dt, prefix in ((1, b''), (2, bytes([255]) * 46)):
            rgba = tex.decode(prefix + words(values), 8, 8, dt, 1)
            for x, y, color in ((1, 0, (255, 0, 0, 255)), (0, 1, (0, 255, 0, 255)),
                                (2, 0, (0, 0, 255, 255)), (0, 2, (255, 255, 255, 255))):
                at = (y * 8 + x) * 4
                self.assertEqual(rgba[at:at + 4], bytes(color))

    def test_rectangular_twiddled_tiles_both_axes(self):
        for w, h, x, y in ((16, 8, 8, 0), (8, 16, 0, 8)):
            values = [0] * 128
            values[64] = 0xF800
            rgba = tex.decode(words(values), w, h, 13, 1)
            at = (y * w + x) * 4
            self.assertEqual(rgba[at:at + 4], bytes((255, 0, 0, 255)))
            self.assertEqual(rgba[:4], bytes((0, 0, 0, 255)))

    def test_vq_codebook_orientation_and_indices(self):
        book = [0] * 1024
        book[4:8] = [0xF800, 0x07E0, 0x001F, 0xFFFF]
        indices = bytearray(16)
        indices[2] = 1  # Block x=1, y=0, encoded in Morton order.
        for dt, mip in ((3, b''), (4, bytes([255]) * 6)):
            rgba = tex.decode(words(book) + mip + indices, 8, 8, dt, 1)
            self.assertEqual(rgba[8:16], bytes((255, 0, 0, 255, 0, 0, 255, 255)))
            self.assertEqual(rgba[40:48], bytes((0, 255, 0, 255, 255, 255, 255, 255)))
            self.assertEqual(rgba[:4], bytes((0, 0, 0, 255)))

    def test_all_supported_pixel_and_layout_combinations(self):
        for dt in tex.FORMATS:
            for pf in (0, 1, 2):
                prefix, size = tex.layout(8, 8, dt)
                if dt in (3, 4):
                    payload = words([0xFFFF] * 1024) + bytes(size - 2048)
                else:
                    payload = bytes(prefix) + words([0xFFFF] * 64)
                self.assertEqual(tex.decode(payload, 8, 8, dt, pf), bytes([255]) * 256)

    def test_png_crc_and_scanlines(self):
        rgba = bytes(range(256))
        png = tex.png_bytes(8, 8, rgba)
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        at, tags, compressed = 8, [], b''
        while at < len(png):
            size = struct.unpack_from('>I', png, at)[0]
            tag, body = png[at + 4:at + 8], png[at + 8:at + 8 + size]
            self.assertEqual(struct.unpack_from('>I', png, at + 8 + size)[0], zlib.crc32(tag + body))
            tags.append(tag)
            if tag == b'IHDR':
                self.assertEqual(struct.unpack('>IIBBBBB', body), (8, 8, 8, 6, 0, 0, 0))
            if tag == b'IDAT':
                compressed += body
            at += 12 + size
        self.assertEqual(tags, [b'IHDR', b'IDAT', b'IEND'])
        self.assertEqual(zlib.decompress(compressed), b''.join(b'\0' + rgba[y * 32:(y + 1) * 32] for y in range(8)))
        with self.assertRaises(ValueError):
            tex.png_bytes(8, 8, rgba[:-1])

    def test_table_discovery_alignment_aliases_and_padding(self):
        for address in (0x0C400000, 0x8C400000, 0xAC400000):
            data = bytes(4) + record(dt=2, address=address) + record(address=address + 192)
            table, = tex.discover_tables(data)
            self.assertEqual(table['executable_offset'], 4)
            self.assertEqual(table['data_address'], 0x0C400000)
            self.assertEqual(table['size'], 320)
            self.assertEqual([e['offset'] for e in table['entries']], [0, 192])

    def test_reject_invalid_table_records(self):
        for data in (record(reserved=1), record(address=0x0D400000), record(address=0x0C400001),
                     record(pf=3), record(dt=5), record()[:-1], bytes(16)):
            self.assertEqual(tex.discover_tables(data), [])

    def test_reject_overlapping_descending_and_gapped_tables(self):
        for offset in (0, -32, 96, 160):
            self.assertEqual(tex.discover_tables(record() + record(address=0x0C400000 + offset)), [])

    def test_ambiguous_or_missing_size_match(self):
        tables = tex.discover_tables(record() + bytes(16) + record())
        with self.assertRaisesRegex(ValueError, 'found 2'):
            tex.match_table(tables, 128)
        with self.assertRaisesRegex(ValueError, 'found 0'):
            tex.match_table(tables, 127)

    def fixture(self, root):
        source = root / 'disc'
        source.mkdir()
        executable = bytearray()
        for index, height in enumerate((8, 16, 32, 64)):
            executable += record(height=height) + bytes(16)
            (source / ('TEXDC%d.BIN' % index)).write_bytes(words([0xF800] * (8 * height)))
        (source / '1ST_READ.BIN').write_bytes(executable)
        return source

    def test_extract_manifest_gallery_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            output = root / 'textures'
            manifest = tex.extract(source, output)
            self.assertEqual(manifest, json.loads((output / 'manifest.json').read_text()))
            self.assertEqual(len(manifest['banks']), 4)
            for bank in manifest['banks']:
                item, = bank['textures']
                png = (output / item['png']).read_bytes()
                self.assertEqual(hashlib.sha256(png).hexdigest(), item['png_sha256'])
                self.assertEqual(hashlib.sha256((source / bank['source']).read_bytes()).hexdigest(), bank['sha256'])
                self.assertEqual(item['id'], 0)
                self.assertIn(item['png'], (output / 'index.html').read_text())
            with self.assertRaisesRegex(ValueError, 'already exists'):
                tex.extract(source, output)
            self.assertEqual(manifest, json.loads((output / 'manifest.json').read_text()))

    def test_missing_bank_and_decode_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            output = root / 'textures'
            with patch.object(tex, 'decode', side_effect=ValueError('synthetic failure')):
                with self.assertRaisesRegex(ValueError, 'synthetic failure'):
                    tex.extract(source, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob('.textures-*')), [])
            (source / 'TEXDC3.BIN').unlink()
            with self.assertRaises(FileNotFoundError):
                tex.extract(source, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob('.textures-*')), [])


if __name__ == '__main__':
    unittest.main()
