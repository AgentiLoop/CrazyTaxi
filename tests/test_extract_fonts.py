"""Synthetic font fixtures: no game files or upstream modules required."""
import struct
import unittest

from tools import extract_fonts as fonts

LOAD = fonts.LOAD


def metrics(drawable=70):
    rows = []
    for code in range(32, 128):
        if code - 32 < drawable:
            rows.append(struct.pack('<ffII', (code - 32) % 8 * 2, 2, (code - 32) // 8 % 8, 0))
        else:
            rows.append(struct.pack('<ffII', -1, 4, 0, 0))
    return b''.join(rows)


def executable(drawable=70):
    """Descriptor at 0, metrics for four fonts after it, then the shared V table."""
    textures = {10 + i: dict(width=16, height=16) for i in range(4)}
    metric_start = 80
    descriptor = struct.pack('<4I', 10, 11, 12, 13) + struct.pack('<4I', *(1 << 3 | 1,) * 4) \
        + struct.pack('<4I', *(LOAD + metric_start + i * 1536 for i in range(4))) \
        + struct.pack('<4f', *(1 / 16,) * 4) + struct.pack('<4f', *(2.0,) * 4)
    body = descriptor + metrics(drawable) * 4 + struct.pack('<22f', *(fonts.V_TOP + fonts.V_BOTTOM))
    return body, textures


class FontTests(unittest.TestCase):
    def test_discovers_descriptor_metrics_and_v_table(self):
        exe, textures = executable()
        address, v_address, found = fonts.discover_fonts(exe, textures)
        self.assertEqual((address, v_address), (LOAD, LOAD + 80 + 4 * 1536))
        self.assertEqual([f['texture_number'] for f in found], [10, 11, 12, 13])
        glyph = found[0]['glyphs'][33 - 32]
        self.assertEqual((glyph['character'], glyph['x'], glyph['width'], glyph['row'], glyph['advance']),
                         ('!', 2, 2, 0, 1))
        self.assertFalse(found[0]['glyphs'][-1]['drawable'])
        self.assertIsNone(found[0]['glyphs'][-1]['character'])

    def test_rejects_too_few_drawable_glyphs_or_bad_size_bits(self):
        exe, textures = executable(drawable=63)
        with self.assertRaises(ValueError):
            fonts.discover_fonts(exe, textures)
        exe, textures = executable()
        exe = exe[:16] + struct.pack('<I', 0) + exe[20:]
        with self.assertRaises(ValueError):
            fonts.discover_fonts(exe, textures)

    def test_crop_reverses_rows_as_pfputc_samples_v(self):
        width = height = 8
        rgba = b''.join(bytes((x, y, 0, 255)) for y in range(height) for x in range(width))
        w, h, pixels = fonts.crop_glyph(rgba, width, height, dict(drawable=True, x=2, width=2, row=0))
        self.assertEqual((w, h), (2, 1))
        self.assertEqual(pixels, bytes((2, 7, 0, 255, 3, 7, 0, 255)))
        w, h, pixels = fonts.crop_glyph(rgba, width, height, dict(drawable=True, x=0, width=1, row=8))
        self.assertEqual((w, h), (1, 4))
        self.assertEqual([pixels[i * 4 + 1] for i in range(4)], [7, 6, 5, 4])
        with self.assertRaises(ValueError):
            fonts.crop_glyph(rgba, width, height, dict(drawable=False, x=-1, width=2, row=0))


if __name__ == '__main__':
    unittest.main()
