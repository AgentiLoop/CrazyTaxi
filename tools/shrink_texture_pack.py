#!/usr/bin/env python3
"""Pre-shrink a matched texture pack (tools/match_texture_pack.py output) for the browser.

The pack's images are 4-32 times the game's size and the game draws them at most 512 texels
a side (src/scene.js ?hires=1): downloading them whole and scaling them in the browser moves
~750 MB. This writes, per matched texture, small/<link>.webp scaled (Lanczos, alpha
premultiplied) to at most --cap texels on its longer side, upright like the pack's, with
alpha only where the pack image has a texel below 255; and adds small, small_width and
small_height to each manifest entry. src/scene.js fetches the small image when it is at
least as large as it would draw the pack's. Needs Pillow with WebP."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import json
from pathlib import Path

from PIL import Image


def fit_size(w, h, cap):
    """w x h scaled to at most cap on its longer side (src/scene.js fitSize)."""
    s = min(1, cap / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def shrink(src, dst, cap, quality=90):
    """Write src scaled to at most cap a side as WebP; returns (width, height)."""
    with Image.open(src) as im:
        im.load()
        alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if alpha else "RGB")
        if alpha and im.getchannel("A").getextrema()[0] == 255:
            im, alpha = im.convert("RGB"), False
        size = fit_size(im.width, im.height, cap)
        if size != im.size:
            if alpha:
                im = im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")
            else:
                im = im.resize(size, Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "WEBP", quality=quality, alpha_quality=100, method=4)
        return im.size


def _shrink_job(job):
    return shrink(*job)


def shrink_pack(pack, cap=512, quality=90):
    """Shrink every linked texture of pack/manifest.json; returns (count, bytes before, bytes after)."""
    manifest_path = pack / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    records = [r for r in manifest["textures"] if r.get("link")]
    smalls = [Path("small") / Path(r["link"]).with_suffix(".webp") for r in records]
    jobs = [(pack / r["link"], pack / s, cap, quality) for r, s in zip(records, smalls)]
    with ProcessPoolExecutor() as pool:
        sizes = list(pool.map(_shrink_job, jobs, chunksize=8))
    count = before = after = 0
    for record, small, size in zip(records, smalls, sizes):
        record["small_width"], record["small_height"] = size
        record["small"] = small.as_posix()
        count += 1
        before += (pack / record["link"]).stat().st_size
        after += (pack / small).stat().st_size
    manifest["small_cap"] = cap
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    return count, before, after


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pack", type=Path, help="matched pack folder (manifest.json), e.g. local-assets/texture_pack")
    parser.add_argument("--cap", type=int, default=512, help="longest side in texels (default 512)")
    parser.add_argument("--quality", type=int, default=90, help="WebP quality (default 90)")
    args = parser.parse_args()
    count, before, after = shrink_pack(args.pack, args.cap, args.quality)
    print("Shrank %d textures to at most %d a side: %.1f MB -> %.1f MB"
          % (count, args.cap, before / 1e6, after / 1e6))


if __name__ == "__main__":
    main()
