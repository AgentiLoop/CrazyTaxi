#!/usr/bin/env python3
"""Turn an asset release's model textures (<lowres>/textures/TEXDCn/*.png and the PNGs embedded
in its .glb files) into KTX2 (Basis Universal ETC1S) and point the glTF files at them.

Each glTF texture with a PNG image gets the KTX2 image in place of it (same image index, a .ktx2
uri or the KTX2 bytes in the bufferView) under KHR_texture_basisu (required: src/scene.js sets
GLTFLoader's KTX2Loader), and `extras.alpha` = 'solid' / 'mask' / 'partial', the alpha values
the PNG held: a GPU-compressed texture can't be read back, and src/scene.js draws a texture by
them (textureAlpha). Stored the same way up as the PNGs (the models' UVs are for those), no
mipmaps (the game's samplers are all LINEAR), alpha only where the PNG has some below 255.
The PNGs under textures/ are deleted once encoded. Needs Pillow and basisu (brew install basis_universal)."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

from PIL import Image

BASISU = "KHR_texture_basisu"


def alpha_kind(im):
    a = im.convert("RGBA").getchannel("A")
    lo, hi = a.getextrema()
    if lo == 255:
        return "solid"
    hist = a.histogram()
    return "mask" if sum(hist[1:255]) == 0 else "partial"


def encode(png_bytes, quality):
    """(KTX2 bytes, alpha kind) for a PNG's bytes."""
    with Image.open(io.BytesIO(png_bytes)) as im:
        im.load()
        kind = alpha_kind(im)
        im = im.convert("RGB" if kind == "solid" else "RGBA")
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.png", Path(tmp) / "out.ktx2"
        im.save(src)
        subprocess.run(["basisu", "-ktx2", "-q", str(quality), "-max_threads", "2", "-quiet",
                        str(src), "-output_file", str(dst)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return dst.read_bytes(), kind


def read_glb(path):
    d = path.read_bytes()
    n = struct.unpack_from("<I", d, 12)[0]
    j = json.loads(d[20:20 + n])
    rest = d[20 + n:]
    binary = None
    if len(rest) >= 8 and struct.unpack_from("<I", rest, 4)[0] == 0x004E4942:
        binary = rest[8:8 + struct.unpack_from("<I", rest, 0)[0]]
    return j, binary


def write_glb(path, j, binary):
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<I", len(js)) + b"JSON" + js
    if binary is not None:
        binary = binary + b"\0" * (-len(binary) % 4)
        out += struct.pack("<I", len(binary)) + b"BIN\0" + binary
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(out)) + out)


def rebuild_buffer0(j, binary, replaced):
    """BIN chunk with bufferViews `replaced` ({index: bytes}) swapped in, every other range of
    buffer 0 (bufferViews, meshopt sources) copied at the same offset modulo 16."""
    ranges = []   # (old offset, length, owner dict, new bytes or None)
    for i, v in enumerate(j.get("bufferViews", [])):
        if v.get("buffer") == 0:
            ranges.append((v.get("byteOffset", 0), v["byteLength"], v, replaced.get(i)))
        m = v.get("extensions", {}).get("EXT_meshopt_compression")
        if m and m.get("buffer") == 0:
            ranges.append((m.get("byteOffset", 0), m["byteLength"], m, None))
    out = bytearray()
    for off, length, owner, new in sorted(ranges, key=lambda r: r[0]):
        out += b"\0" * ((off - len(out)) % 16)
        owner["byteOffset"] = len(out)
        data = new if new is not None else binary[off:off + length]
        owner["byteLength"] = len(data)
        out += data
    j["buffers"][0]["byteLength"] = len(out)
    return bytes(out)


def convert_glb(path, textures, quality):
    """Point a glb's textures at KTX2 images. `textures`: Path of a PNG -> (KTX2 Path, kind). True if changed."""
    j, binary = read_glb(path)
    images = j.get("images", [])
    kinds, replaced = {}, {}
    for i, im in enumerate(images):
        uri = im.get("uri")
        if uri and uri.endswith(".png"):
            png = (path.parent / uri).resolve()
            if png not in textures:
                continue
            kinds[i] = textures[png][1]
            im["uri"] = uri[:-4] + ".ktx2"
            im["mimeType"] = "image/ktx2"
        elif "bufferView" in im and im.get("mimeType") == "image/png":
            v = j["bufferViews"][im["bufferView"]]
            off = v.get("byteOffset", 0)
            replaced[im["bufferView"]], kinds[i] = encode(binary[off:off + v["byteLength"]], quality)
            im["mimeType"] = "image/ktx2"
    if not kinds:
        return False
    for t in j.get("textures", []):
        s = t.get("source")
        if s in kinds:
            del t["source"]
            t.setdefault("extensions", {})[BASISU] = {"source": s}
            t.setdefault("extras", {})["alpha"] = kinds[s]
    for key in ("extensionsUsed", "extensionsRequired"):
        if BASISU not in j.setdefault(key, []):
            j[key].append(BASISU)
    if replaced:
        binary = rebuild_buffer0(j, binary, replaced)
    write_glb(path, j, binary)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--release", default="asset-release/lowres", help="the release's lowres folder")
    ap.add_argument("--quality", type=int, default=255, help="basisu ETC1S -q (1-255)")
    args = ap.parse_args()
    root = Path(args.release).resolve()
    pngs = sorted((root / "textures").rglob("*.png"))
    workers = max(1, (os.cpu_count() or 4) // 2)

    def one(png):
        data, kind = encode(png.read_bytes(), args.quality)
        dst = png.with_suffix(".ktx2")
        dst.write_bytes(data)
        return png, (dst, kind)

    with ThreadPoolExecutor(workers) as ex:
        textures = dict(ex.map(one, pngs))
    glbs = sorted(root.rglob("*.glb"))
    with ThreadPoolExecutor(workers) as ex:
        changed = sum(ex.map(lambda g: convert_glb(g, textures, args.quality), glbs))
    before = sum(p.stat().st_size for p in pngs)
    after = sum(d.stat().st_size for d, _ in textures.values())
    for p in pngs:
        p.unlink()
    print(f"ktx2: {len(pngs)} textures {before / 1e6:.1f} -> {after / 1e6:.1f} MB, {changed} glb files pointed at them")


if __name__ == "__main__":
    main()
