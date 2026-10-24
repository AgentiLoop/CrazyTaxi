#!/usr/bin/env python3
"""Encode a matched texture pack's model textures (textures/TEXDCn) as KTX2 (Basis Universal ETC1S).

src/scene.js swaps the pack into the models' textures; from a KTX2 it gets a GPU-compressed
texture (KTX2Loader transcodes it to BC / ETC2 / ASTC), so it downloads and sits in VRAM a
few times smaller than the JPEG/PNG decoded to RGBA. What the browser does to a pack image
before drawing it is done here once instead, as a compressed texture can't be redrawn:
  - flipped upside down (the extracted PNGs, and so the glTF textures, are stored that way;
    packImage decodes with imageOrientation 'flipY');
  - scaled to at most --cap texels a side (Lanczos), rounded to a multiple of 4 (the block
    size of the GPU formats);
  - where the game's texture has see-through texels, its alpha scaled up multiplies the
    pack's (scene.js cutByAlpha); where it has none the pack's alpha is dropped (drawn opaque
    anyway), and the file is encoded without alpha.
Writes <out>/<png with .ktx2> with a full mip chain and adds ktx2, ktx2_width, ktx2_height to
each such entry of <out>/manifest.json (which must be a copy of the pack's).
Needs Pillow and basisu (brew install basis_universal)."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile

from PIL import Image


def ktx2_size(w, h, cap):
    """w x h scaled to at most cap on its longer side, each rounded to a multiple of 4."""
    s = min(1, cap / max(w, h))
    return max(4, round(w * s / 4) * 4), max(4, round(h * s / 4) * 4)


def prepare(pack_file, game_png, cap):
    """The pack image as the game draws it: flipped, scaled, cut by the game's alpha. (image, has_alpha)"""
    with Image.open(pack_file) as im:
        im = im.convert("RGBA").transpose(Image.FLIP_TOP_BOTTOM)
    size = ktx2_size(im.width, im.height, cap)
    with Image.open(game_png) as g:
        game_alpha = g.convert("RGBA").getchannel("A")
    if game_alpha.getextrema()[0] == 255:
        return im.convert("RGB").resize(size, Image.LANCZOS), False
    im = im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")
    a = Image.composite(im.getchannel("A"), Image.new("L", size, 0), game_alpha.resize(size, Image.BICUBIC))
    # composite(x, 0, mask) = x * mask / 255: the pack's alpha times the game's
    im.putalpha(a)
    return im, True


def encode(job):
    src, game, dst, cap, quality = job
    img, alpha = prepare(src, game, cap)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "in.png"
        img.save(png)
        subprocess.run(["basisu", "-ktx2", "-mipmap", "-q", str(quality), "-max_threads", "2",
                        "-quiet", str(png), "-output_file", str(dst)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return img.size, alpha


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pack", default="local-assets/texture_pack", help="tools/match_texture_pack.py output")
    ap.add_argument("--game", default="local-assets", help="the extracted textures (textures/TEXDCn/*.png)")
    ap.add_argument("--out", required=True, help="the release's hires folder (with manifest.json)")
    ap.add_argument("--cap", type=int, default=1024)
    ap.add_argument("--quality", type=int, default=255, help="basisu ETC1S -q (1-255)")
    args = ap.parse_args()
    pack, game, out = Path(args.pack), Path(args.game), Path(args.out)
    manifest = json.loads((out / "manifest.json").read_text())
    entries = [t for t in manifest["textures"] if t.get("link") and t["png"].startswith("textures/")]
    jobs = [(pack / t["link"], game / t["png"], out / (t["png"][:-4] + ".ktx2"), args.cap, args.quality)
            for t in entries]
    with ThreadPoolExecutor(max(1, (os.cpu_count() or 4) // 2)) as ex:
        results = list(ex.map(encode, jobs))
    for t, ((w, h), _), job in zip(entries, results, jobs):
        t["ktx2"], t["ktx2_width"], t["ktx2_height"] = str(job[2].relative_to(out)), w, h
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(j[2].stat().st_size for j in jobs)
    print(f"ktx2: {len(jobs)} textures ({sum(a for _, a in results)} with alpha), {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
