"""tools/shrink_texture_pack.py on a synthetic matched pack: no game files required."""
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from tools import shrink_texture_pack as shrink


class ShrinkTexturePackTests(unittest.TestCase):
    def test_shrinks_linked_textures_and_records_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            pack = Path(tmp)
            (pack / "textures/TEXDC0").mkdir(parents=True)
            Image.new("RGB", (1024, 512), (200, 10, 10)).save(pack / "textures/TEXDC0/0000.jpg")
            Image.new("RGBA", (256, 256), (0, 0, 255, 255)).save(pack / "textures/TEXDC0/0001.png")
            see_through = Image.new("RGBA", (64, 64), (0, 255, 0, 0))
            see_through.paste((0, 255, 0, 255), (0, 0, 32, 64))
            see_through.save(pack / "textures/TEXDC0/0002.png")
            records = [dict(png="textures/TEXDC0/%04d.png" % n, link="textures/TEXDC0/%s" % name)
                       for n, name in enumerate(["0000.jpg", "0001.png", "0002.png"])]
            records.append(dict(png="textures/TEXDC0/0003.png"))  # unmatched
            (pack / "manifest.json").write_text(json.dumps(dict(textures=records)))

            count, _, _ = shrink.shrink_pack(pack, cap=512)

            self.assertEqual(count, 3)
            out = json.loads((pack / "manifest.json").read_text())
            self.assertEqual(out["small_cap"], 512)
            big, solid, cut, unmatched = out["textures"]
            self.assertEqual((big["small"], big["small_width"], big["small_height"]),
                             ("small/textures/TEXDC0/0000.webp", 512, 256))
            self.assertNotIn("small", unmatched)
            with Image.open(pack / solid["small"]) as im:
                self.assertEqual((im.size, im.mode), ((256, 256), "RGB"))  # alpha all 255: dropped
            with Image.open(pack / cut["small"]) as im:
                self.assertEqual(im.mode, "RGBA")
                self.assertEqual(im.getpixel((10, 10))[3], 255)
                self.assertEqual(im.getpixel((50, 10))[3], 0)


if __name__ == "__main__":
    unittest.main()
