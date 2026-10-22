#!/usr/bin/env python3
"""Decode TEXDC banks using tables discovered in the supplied executable (stdlib only).

Format references: supplied decomp tools/model_map.py texture_lists/texture_size
and tools/textures.py decode. No fixed regional table addresses or upstream imports.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile
import zlib


FORMATS = (1, 2, 3, 4, 9, 13)
SIZES = {8 << n for n in range(8)}


def layout(width, height, data_type):
    """Return top-level byte offset and total encoded bytes, including mip levels."""
    if width not in SIZES or height not in SIZES:
        raise ValueError("dimensions must be powers of two from 8 to 1024")
    if data_type not in FORMATS:
        raise ValueError("unsupported data type")
    if data_type in (1, 2, 3, 4) and width != height:
        raise ValueError("square layout requires equal dimensions")
    prefix = 0
    if data_type == 2:
        prefix = 6 + sum(2 * s * s for s in SIZES if 2 <= s < width)
        # SIZES starts at 8; the 2x2 and 4x4 mip levels are also present.
        prefix += 2 * (4 + 16)
    elif data_type == 4:
        prefix = 2048 + 1 + sum((s // 2) ** 2 for s in (2, 4, *sorted(SIZES)) if s < width)
    elif data_type == 3:
        prefix = 2048
    return prefix, prefix + (width * height // 4 if data_type in (3, 4) else width * height * 2)


def spread(value):
    result = 0
    for bit in range(value.bit_length()):
        result |= ((value >> bit) & 1) << (2 * bit)
    return result


def pixel(word, pixel_format):
    if pixel_format == 0:
        return bytes(((word >> 10 & 31) * 255 // 31, (word >> 5 & 31) * 255 // 31,
                      (word & 31) * 255 // 31, 255 if word & 0x8000 else 0))
    if pixel_format == 1:
        return bytes(((word >> 11 & 31) * 255 // 31, (word >> 5 & 63) * 255 // 63,
                      (word & 31) * 255 // 31, 255))
    if pixel_format == 2:
        return bytes(((word >> 8 & 15) * 17, (word >> 4 & 15) * 17, (word & 15) * 17,
                      (word >> 12 & 15) * 17))
    raise ValueError("unsupported pixel format")


def decode(payload, width, height, data_type, pixel_format):
    """Decode the full-resolution level, explicitly reading little-endian words."""
    prefix, size = layout(width, height, data_type)
    if pixel_format not in (0, 1, 2):
        raise ValueError("unsupported pixel format")
    if len(payload) != size:
        raise ValueError("texture payload size mismatch")
    words = struct.unpack_from("<%dH" % (1024 if data_type in (3, 4) else width * height),
                               payload, 0 if data_type in (3, 4) else prefix)
    colors = [pixel(word, pixel_format) for word in words]
    twiddle = [spread(i) for i in range(max(width, height))]
    result = bytearray(width * height * 4)
    side = min(width, height)
    for y in range(height):
        for x in range(width):
            if data_type in (3, 4):
                code = payload[prefix + (twiddle[x // 2] << 1 | twiddle[y // 2])]
                index = code * 4 + (x & 1) * 2 + (y & 1)
            elif data_type == 9:
                index = y * width + x
            else:
                tile = (x // side + y // side) * side * side
                index = tile + (twiddle[x % side] << 1 | twiddle[y % side])
            at = (y * width + x) * 4
            result[at:at + 4] = colors[index]
    return bytes(result)


def png_bytes(width, height, rgba):
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA size mismatch")

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    rows = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def discover_tables(executable):
    """Find maximal runs; reject overlapping or non-32-byte-packed payloads."""
    def entry(at):
        if at + 16 > len(executable):
            return None
        dims, fmt, address, reserved = struct.unpack_from("<4I", executable, at)
        width, height, dt, pf = dims & 65535, dims >> 16, fmt >> 8, fmt & 255
        if address >> 24 not in (0x0C, 0x8C, 0xAC) or address % 32 or reserved or pf > 2:
            return None
        try:
            _, size = layout(width, height, dt)
        except ValueError:
            return None
        return dict(width=width, height=height, data_type=dt, pixel_format=pf,
                    address=address & 0x1FFFFFFF, size=size)

    tables, at = [], 0
    while at + 16 <= len(executable):
        first = entry(at)
        if first is None:
            at += 4
            continue
        start, entries = at, []
        while (current := entry(at)) is not None:
            current["offset"] = current["address"] - first["address"]
            entries.append(current)
            at += 16
        if all(b["offset"] == a["offset"] + ((a["size"] + 31) & ~31)
               for a, b in zip(entries, entries[1:])):
            last = entries[-1]
            tables.append(dict(executable_offset=start, data_address=first["address"],
                               size=last["offset"] + ((last["size"] + 31) & ~31), entries=entries))
    return tables


def match_table(tables, size):
    matches = [table for table in tables if table["size"] == size]
    if len(matches) != 1:
        raise ValueError("expected one packed texture table for %d bytes, found %d" % (size, len(matches)))
    return matches[0]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    tables = discover_tables(executable)
    banks = []
    for number in range(4):
        path = source / ("TEXDC%d.BIN" % number)
        data = path.read_bytes()
        banks.append((path.name, data, match_table(tables, len(data))))
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".textures-", dir=output.parent))
    manifest = dict(schema=1, executable=dict(path="1ST_READ.BIN", sha256=digest(executable)), banks=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi textures</title>',
               '<style>body{font-family:system-ui;background:#222;color:white}figure{display:inline-block;'
               'margin:8px}img{max-width:160px;max-height:160px;image-rendering:pixelated;'
               'background:repeating-conic-gradient(#888 0 25%,#ddd 0 50%) 0 0/16px 16px}</style>',
               '<h1>Local TEXDC textures</h1><p>Full-resolution levels; texture IDs follow executable table order.</p>']
    try:
        for name, data, table in banks:
            folder = staging / Path(name).stem
            folder.mkdir()
            bank = dict(source=name, size=len(data), sha256=digest(data),
                        table_executable_offset=table["executable_offset"],
                        data_address=table["data_address"], textures=[])
            gallery.append('<h2>%s</h2>' % html.escape(name))
            for number, item in enumerate(table["entries"]):
                payload = data[item["offset"]:item["offset"] + item["size"]]
                rgba = decode(payload, item["width"], item["height"], item["data_type"], item["pixel_format"])
                encoded = png_bytes(item["width"], item["height"], rgba)
                relative = '%s/%04d.png' % (folder.name, number)
                target = staging / relative
                target.write_bytes(encoded)
                if digest(target.read_bytes()) != digest(encoded):
                    raise ValueError("written PNG hash mismatch")
                bank["textures"].append(dict(item, id=number, png=relative,
                                             payload_sha256=digest(payload), rgba_sha256=digest(rgba),
                                             png_sha256=digest(encoded)))
                gallery.append('<figure><img loading="lazy" src="%s"><figcaption>%d: %dx%d</figcaption></figure>'
                               % (relative, number, item["width"], item["height"]))
            manifest["banks"].append(bank)
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "index.html").write_text("\n".join(gallery) + "\n")
        if output.exists():
            raise ValueError("output already exists")
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
    print("Decoded %d textures from %d banks into %s" %
          (sum(len(bank["textures"]) for bank in manifest["banks"]), len(manifest["banks"]), args.output))


if __name__ == "__main__":
    main()
