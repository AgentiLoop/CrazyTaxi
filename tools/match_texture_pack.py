#!/usr/bin/env python3
"""Match a Flycast custom texture pack (e.g. MK-51035) to the game's textures (stdlib only).

Flycast names each replacement <hex hash>.png/.jpg, the hash being XXH32 (seed 7) of the
texture as it sits in video RAM (flycast core/rend/TexCache.cpp ComputeHash):
  plain     XXH32(top mip level) ^ (TCW & 0xFC000000)
  VQ        XXH32(2048-byte codebook + top level indices) ^ (TCW & 0xFC000000)
  palette   XXH32(indices) ^ XXH32(palette RAM words) ^ (TCW & 0xF8000000)
with TCW bit 31 mipmapped, 30 VQ, 29-27 pixel format (5 = 4-bit, 6 = 8-bit palette),
26 scan order (1 = not twiddled). The 16-bit mipmapped TEXDC textures (type 2) keep their
top level 2 bytes before extract_textures.layout's prefix.

Writes <output>/manifest.json and, per matched texture, a symlink named after the game
texture (TEXDC0/0012.png -> pack file, keeping the pack file's extension)."""
import argparse
import json
import os
from pathlib import Path
import struct

try:
    from tools import extract_sprites as spr
    from tools.extract_textures import discover_tables, layout, match_table
except ImportError:  # run as a script from the tools directory
    import extract_sprites as spr
    from extract_textures import discover_tables, layout, match_table

P1, P2, P3, P4, P5 = 2654435761, 2246822519, 3266489917, 668265263, 374761393
M32 = 0xFFFFFFFF
LANDMARK_SIZE = 128 * 128 * 2  # twiddled RGB565
IMAGE_TYPES = (".png", ".jpg", ".jpeg")


def _rotl(x, r):
    return (x << r | x >> (32 - r)) & M32


def xxh32(data, seed=7):
    n, at = len(data), 0
    if n >= 16:
        v = [(seed + P1 + P2) & M32, (seed + P2) & M32, seed, (seed - P1) & M32]
        words = struct.unpack_from("<%dI" % (n // 16 * 4), data)
        for k in range(0, len(words), 4):
            for lane in range(4):
                v[lane] = _rotl((v[lane] + words[k + lane] * P2) & M32, 13) * P1 & M32
        h = (_rotl(v[0], 1) + _rotl(v[1], 7) + _rotl(v[2], 12) + _rotl(v[3], 18)) & M32
        at = n // 16 * 16
    else:
        h = (seed + P5) & M32
    h = (h + n) & M32
    while at + 4 <= n:
        h = _rotl((h + struct.unpack_from("<I", data, at)[0] * P3) & M32, 17) * P4 & M32
        at += 4
    while at < n:
        h = _rotl((h + data[at] * P5) & M32, 11) * P1 & M32
        at += 1
    h ^= h >> 15
    h = h * P2 & M32
    h ^= h >> 13
    h = h * P3 & M32
    return h ^ h >> 16


def tcw_bits(data_type, pixel_format):
    return ((0x80000000 if data_type in (2, 4) else 0) | (0x40000000 if data_type in (3, 4) else 0)
            | pixel_format << 27 | (0x04000000 if data_type == 9 else 0))


def texture_hash(payload, width, height, data_type, pixel_format):
    """Flycast hash of a TEXDC/SPR texture payload (types 1, 2, 3, 4, 9, 13)."""
    prefix = layout(width, height, data_type)[0]
    if data_type in (3, 4):
        body = payload[:2048] + payload[prefix:prefix + width * height // 4]
    else:
        if data_type == 2:
            prefix -= 2
        body = payload[prefix:prefix + width * height * 2]
    return xxh32(body) ^ tcw_bits(data_type, pixel_format)


def palette_hash(payload, data_type, selector, ram):
    """Flycast hash of a 4-bit (Kamui type 5) or 8-bit (type 7) palettised texture."""
    start, count, fmt = (selector * 16, 16, 5) if data_type == 5 else ((selector & 0x30) * 16, 256, 6)
    palette = struct.pack("<%dI" % count, *((word or 0) for word in ram[start:start + count]))
    return xxh32(payload) ^ xxh32(palette) ^ fmt << 27


def image_size(path):
    """(width, height) of a PNG or baseline/progressive JPEG, else None."""
    with open(path, "rb") as handle:
        head = handle.read(32)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
        if head[:2] != b"\xff\xd8":
            return None
        handle.seek(2)
        while True:
            marker = handle.read(2)
            if len(marker) < 2 or marker[0] != 0xFF:
                return None
            if marker[1] in (0xD8, 0x01) or 0xD0 <= marker[1] <= 0xD7:
                continue
            length = struct.unpack(">H", handle.read(2))[0]
            if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">xHH", handle.read(5))
                return width, height
            handle.seek(length - 2, 1)


def pack_index(pack):
    """hash -> sorted file names; Flycast parses the leading hex digits of each name."""
    index = {}
    for name in sorted(os.listdir(pack)):
        if not name.lower().endswith(IMAGE_TYPES):
            continue
        digits = ""
        for char in name.rsplit(".", 1)[0]:
            if char not in "0123456789abcdefABCDEF":
                break
            digits += char
        if digits:
            index.setdefault(int(digits, 16) & M32, []).append(name)
    return index


def game_textures(source):
    """Yield (group, id, png, width, height, hash) for TEXDC, SPR and LANDDC textures."""
    executable = (source / "1ST_READ.BIN").read_bytes()
    tables = discover_tables(executable)
    for number in range(4):
        data = (source / ("TEXDC%d.BIN" % number)).read_bytes()
        for index, item in enumerate(match_table(tables, len(data))["entries"]):
            payload = data[item["offset"]:item["offset"] + item["size"] + 2]
            yield ("TEXDC%d" % number, index, "textures/TEXDC%d/%04d.png" % (number, index),
                   item["width"], item["height"],
                   texture_hash(payload, item["width"], item["height"], item["data_type"], item["pixel_format"]))
    files = {path.name: path.read_bytes() for path in sorted(source.glob("SPR*.BIN"))}
    sprite_tables = spr.discover_tables(executable, {name: len(data) for name, data in files.items()})
    selectors, uploads = spr.recover_loads(executable, sprite_tables)
    ram = spr.palette_ram(executable, uploads)
    for name in sorted(files):
        data, entries = files[name], sprite_tables[name]["entries"]
        address = selectors[name]
        values = (struct.unpack_from("<%dI" % len(entries), executable, address - spr.LOAD)
                  if address else (0,) * len(entries))
        stem = Path(name).stem
        for index, item in enumerate(entries):
            if item["external"]:
                continue
            payload = data[item["offset"]:item["offset"] + item["size"]]
            if item["data_type"] in spr.PALETTE_TYPES:
                value = palette_hash(payload, item["data_type"], values[index], ram)
            else:
                value = texture_hash(payload, item["width"], item["height"], item["data_type"],
                                     item["pixel_format"])
            yield stem, index, "sprites/%s/%04d.png" % (stem, index), item["width"], item["height"], value
    for path in sorted(source.glob("LANDDC*.AFS")):
        data = path.read_bytes()
        if data[:4] != b"AFS\0":
            raise ValueError("%s is not an AFS archive" % path.name)
        for index in range(struct.unpack_from("<I", data, 4)[0]):
            offset, size = struct.unpack_from("<II", data, 8 + 8 * index)
            if size < LANDMARK_SIZE:
                continue
            yield (path.stem, index, "landmarks/%s/%02d.png" % (path.stem, index), 128, 128,
                   xxh32(data[offset:offset + LANDMARK_SIZE]) ^ tcw_bits(1, 1))


def match(source, pack, output):
    source, pack, output = Path(source).resolve(), Path(pack).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    index = pack_index(pack)
    textures, used, groups = [], set(), {}
    for group, number, png, width, height, value in game_textures(source):
        names = index.get(value, [])
        record = dict(group=group, id=number, png=png, width=width, height=height, hash="%x" % value)
        counts = groups.setdefault(group, [0, 0])
        counts[1] += 1
        if names:
            size = image_size(pack / names[0])
            record.update(pack_file=names[0], pack_width=size[0] if size else None,
                          pack_height=size[1] if size else None)
            if len(names) > 1:
                record["pack_duplicates"] = names[1:]
            counts[0] += 1
            used.add(value)
        textures.append(record)
    unused = [name for value, names in sorted(index.items()) if value not in used for name in names]
    manifest = dict(schema=1, pack=str(pack), pack_hashes=len(index), hash="flycast XXH32 seed 7",
                    matched_textures=sum(c[0] for c in groups.values()), game_textures=len(textures),
                    matched_pack_hashes=len(used),
                    groups={name: dict(matched=c[0], total=c[1]) for name, c in groups.items()},
                    unmatched_pack_files=unused, textures=textures)
    output.mkdir(parents=True)
    for record in textures:
        if "pack_file" in record:
            link = output / Path(record["png"]).with_suffix(Path(record["pack_file"]).suffix.lower())
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(pack / record["pack_file"])
            record["link"] = link.relative_to(output).as_posix()
    (output / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("pack", type=Path, help="Flycast texture pack folder (<hash>.png/.jpg)")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = match(args.source, args.pack, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, "error: %s\n" % error)
    for name, counts in manifest["groups"].items():
        print("%-8s %4d / %4d" % (name, counts["matched"], counts["total"]))
    print("Matched %d of %d game textures; %d of %d pack hashes used, %d pack files unmatched"
          % (manifest["matched_textures"], manifest["game_textures"], manifest["matched_pack_hashes"],
             manifest["pack_hashes"], len(manifest["unmatched_pack_files"])))


if __name__ == "__main__":
    main()
