#!/usr/bin/env python3
"""Decode stand-alone PowerVR (.PVR) files on the disc, e.g. 0GDTEX.PVR, to PNG (stdlib only).

Format reference: supplied decomp tools/model_map.py pvrt_at and tools/textures.py decode
(optional GBIX chunk, then PVRT: u32 length, u8 pixel format, u8 data type, u16 0, u16 width, u16 height).
Pixels are decoded with tools/extract_textures.decode.
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools import extract_textures as tex
except ImportError:  # run as a script from tools/
    import extract_textures as tex


def parse(data):
    """Header fields and payload of a whole PVR file; the PVRT length must cover exactly the rest of the file."""
    at, global_index = 0, None
    if data[:4] == b"GBIX":
        if len(data) < 8:
            raise ValueError("truncated GBIX chunk")
        size = struct.unpack_from("<I", data, 4)[0]
        if size < 4 or 8 + size > len(data):
            raise ValueError("bad GBIX length")
        global_index = struct.unpack_from("<I", data, 8)[0]
        at = 8 + size
    if data[at:at + 4] != b"PVRT" or at + 16 > len(data):
        raise ValueError("no PVRT chunk")
    length, pixel_format, data_type, reserved, width, height = struct.unpack_from("<IBBHHH", data, at + 4)
    if reserved:
        raise ValueError("reserved header bytes are not zero")
    if at + 8 + length != len(data):
        raise ValueError("PVRT length does not match the file size")
    _, size = tex.layout(width, height, data_type)
    payload = data[at + 16:]
    if len(payload) != size:
        raise ValueError("payload is %d bytes, layout needs %d" % (len(payload), size))
    return dict(global_index=global_index, width=width, height=height, data_type=data_type,
                pixel_format=pixel_format, header_offset=at, payload=payload)


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    files = sorted(p for p in source.iterdir() if p.suffix.upper() == ".PVR")
    if not files:
        raise ValueError("no .PVR files in source")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".pvr-", dir=output.parent))
    manifest = dict(schema=1, files=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi PVR files</title>',
            '<style>body{font-family:system-ui;background:#222;color:white}img{image-rendering:pixelated;'
            'background:repeating-conic-gradient(#888 0 25%,#ddd 0 50%) 0 0/16px 16px}</style>',
            '<h1>Stand-alone PVR files</h1>']
    try:
        for path in files:
            data = path.read_bytes()
            info = parse(data)
            payload = info.pop("payload")
            rgba = tex.decode(payload, info["width"], info["height"], info["data_type"], info["pixel_format"])
            encoded = tex.png_bytes(info["width"], info["height"], rgba)
            name = path.stem + ".png"
            (staging / name).write_bytes(encoded)
            alpha = sorted({rgba[i] for i in range(3, len(rgba), 4)})
            manifest["files"].append(dict(info, source=path.name, size=len(data), sha256=tex.digest(data),
                                          png=name, rgba_sha256=tex.digest(rgba), png_sha256=tex.digest(encoded),
                                          alpha_levels=len(alpha), opaque=alpha == [255]))
            page.append('<h2>%s</h2><img src="%s" width="%d"><p>%dx%d, data type %d, pixel format %d</p>'
                        % (html.escape(path.name), name, info["width"] * 2, info["width"], info["height"],
                           info["data_type"], info["pixel_format"]))
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "index.html").write_text("\n".join(page) + "\n")
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Decoded %d PVR files into %s" % (len(manifest["files"]), args.output))


if __name__ == "__main__":
    main()
