#!/usr/bin/env python3
"""Decode the destination pictures in LANDDC1-2.AFS to PNG, named from the executable's own tables.

Each LANDDCn.AFS entry is one raw texture payload with no header. The game streams the entry it
needs into a fixed buffer and re-uploads one sprite texture from it: that texture's record is the
SPRCOMM table entry that points outside SPRCOMM.BIN (extract_sprites.py lists it as "external").
So the record gives the payload format (128x128 twiddled RGB565 in the USA build) and is checked
here two ways: its size must equal every non-empty AFS entry, and its address must sit in a code
literal pool next to the literals naming the LANDDC files (the loader passes both).

Destination names come from one list of string pointers and a (city base, city base) pair that
indexes into it by Game_No (0 Arcade -> LANDDC1, 1 Original -> LANDDC2). The game's landmark routine
loads picture i and later draws name base[Game_No][i] with the same i, so each entry is listed with
the name that formula gives. Which entries a run actually requests (the customer's destination
field) was not traced; entries whose formula falls outside the list get no name.

Everything is found by shape; no regional addresses are used. Stdlib only; no upstream imports.
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_audio import afs_entries
    from tools.extract_sprites import LOAD, discover_tables, texture_numbers
    from tools.extract_textures import decode, digest, png_bytes
except ImportError:  # run as a script from the tools directory
    from extract_audio import afs_entries
    from extract_sprites import LOAD, discover_tables, texture_numbers
    from extract_textures import decode, digest, png_bytes

FILES = ("LANDDC1.AFS", "LANDDC2.AFS")
CITIES = ("Arcade", "Original")
POOL_WINDOW = 0x40
MIN_NAMES = 8


def c_string(executable, address):
    """Printable NUL-terminated string at an executable address, else None."""
    at = address - LOAD
    if not 0 <= at < len(executable):
        return None
    end = executable.find(b"\0", at)
    if end < 0 or not 2 <= end - at <= 64 or not all(32 <= c < 127 for c in executable[at:end]):
        return None
    return executable[at:end].decode("ascii")


def white_frame(rgba, width, height, thickness=2):
    """True when every pixel within `thickness` of the edge is opaque white (the pictures' frame)."""
    for y in range(height):
        for x in range(width):
            if min(x, y, width - 1 - x, height - 1 - y) < thickness:
                at = (y * width + x) * 4
                if rgba[at:at + 4] != b"\xff\xff\xff\xff":
                    return False
    return True


def find_file_name(executable, name):
    """Address of the file name string (any letter case); exactly one copy must exist."""
    lower, hits = executable.lower(), []
    needle = name.lower().encode() + b"\0"
    at = lower.find(needle)
    while at >= 0:
        hits.append(LOAD + at)
        at = lower.find(needle, at + 1)
    if len(hits) != 1:
        raise ValueError("%s: expected one name string, found %d" % (name, len(hits)))
    return hits[0]


def literals(executable, value):
    """Aligned executable addresses holding the 32-bit value."""
    needle, found = struct.pack("<I", value), []
    at = executable.find(needle)
    while at >= 0:
        if at % 4 == 0:
            found.append(LOAD + at)
        at = executable.find(needle, at + 1)
    return found


def find_stream_target(executable, sprite_files, entry_size, name_addresses):
    """The external sprite record whose size is the entry size and whose buffer is pooled with the names."""
    tables = discover_tables(executable, {name: len(data) for name, data in sprite_files.items()})
    numbers = texture_numbers(executable, tables)
    name_pools = [a for address in name_addresses for a in literals(executable, address)]
    found = []
    for bank, table in sorted(tables.items()):
        for index, entry in enumerate(table["entries"]):
            if not entry["external"] or entry["size"] != entry_size:
                continue
            pools = [a for a in literals(executable, entry["address"] | 0x0C000000)
                     if any(abs(a - n) <= POOL_WINDOW for n in name_pools)]
            if pools:
                found.append(dict(bank=bank, index=index, texture_number=numbers[bank] + index,
                                  record=table["address"] + 16 * index, buffer=entry["address"] | 0x0C000000,
                                  pool_literal=pools[0], width=entry["width"], height=entry["height"],
                                  data_type=entry["data_type"], pixel_format=entry["pixel_format"]))
    if len(found) != 1:
        raise ValueError("expected one streamed sprite record, found %d" % len(found))
    return found[0]


def find_name_table(executable, cities):
    """(list address, names, [city base address]) from the only string-pointer run with a base pair."""
    runs, current = [], []
    for at in range(0, len(executable) - 3, 4):
        if c_string(executable, struct.unpack_from("<I", executable, at)[0]) is not None:
            current.append(LOAD + at)
            continue
        if len(current) >= MIN_NAMES:
            runs.append(current)
        current = []
    if len(current) >= MIN_NAMES:
        runs.append(current)
    found = []
    for run in runs:
        start, end = run[0], run[-1] + 4
        for at in literals(executable, start):
            offset = at - LOAD
            if offset + 4 * cities > len(executable):
                continue
            bases = list(struct.unpack_from("<%dI" % cities, executable, offset))
            if all(start <= b < end and (b - start) % 4 == 0 for b in bases) and len(set(bases)) == cities:
                names = [c_string(executable, struct.unpack_from("<I", executable, a - LOAD)[0]) for a in run]
                found.append((start, at, names, bases))
    if len(found) != 1:
        raise ValueError("expected one destination name table, found %d" % len(found))
    return found[0]


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    archives = [(source / name).read_bytes() for name in FILES]
    sprite_files = {path.name: path.read_bytes() for path in sorted(source.glob("SPR*.BIN"))}
    entries = [afs_entries(data) for data in archives]
    sizes = {size for listing in entries for _, size in listing}
    if len(sizes) != 1:
        raise ValueError("LANDDC entries differ in size")
    entry_size = sizes.pop()
    name_addresses = [find_file_name(executable, name) for name in FILES]
    target = find_stream_target(executable, sprite_files, entry_size, name_addresses)
    start, pair, names, bases = find_name_table(executable, len(FILES))
    manifest = dict(schema=1, executable=dict(path="1ST_READ.BIN", sha256=digest(executable)),
                    stream_target=target, file_name_strings=dict(zip(FILES, name_addresses)),
                    name_list=dict(address=start, count=len(names), city_bases=pair,
                                   bases=[dict(city=CITIES[k], address=b, first=(b - start) // 4)
                                          for k, b in enumerate(bases)]),
                    files=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi destination pictures</title>',
               '<style>body{font-family:system-ui;background:#222;color:white}figure{display:inline-block;'
               'margin:8px;width:160px;vertical-align:top}img{width:128px;height:128px}'
               'figcaption{font-size:12px}</style>',
               '<h1>Local Crazy Taxi destination pictures</h1><p>Each picture is shown with the name the '
               'game draws for the same index (base[Game_No][index]). Which indices a run uses was not traced.</p>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".landmarks-", dir=output.parent))
    try:
        for k, (name, data, listing) in enumerate(zip(FILES, archives, entries)):
            folder = name.split(".")[0]
            (staging / folder).mkdir()
            first = (bases[k] - start) // 4
            record = dict(source=name, city=CITIES[k], size=len(data), sha256=digest(data), entries=[])
            gallery.append("<h2>%s (%s)</h2>" % (html.escape(name), CITIES[k]))
            for index, (offset, size) in enumerate(listing):
                payload = data[offset:offset + size]
                label = names[first + index] if first + index < len(names) else None
                item = dict(index=index, offset=offset, size=size, payload_sha256=digest(payload), name=label)
                if not any(payload):
                    item["empty"] = True
                else:
                    rgba = decode(payload, target["width"], target["height"], target["data_type"],
                                  target["pixel_format"])
                    png = png_bytes(target["width"], target["height"], rgba)
                    relative = "%s/%02d.png" % (folder, index)
                    (staging / relative).write_bytes(png)
                    item.update(png=relative, rgba_sha256=digest(rgba), png_sha256=digest(png),
                                white_frame=white_frame(rgba, target["width"], target["height"]))
                    gallery.append('<figure><img src="%s"><figcaption>%d: %s</figcaption></figure>'
                                   % (relative, index, html.escape(label or "(no name)")))
                record["entries"].append(item)
            duplicates = {}
            for item in record["entries"]:
                duplicates.setdefault(item["payload_sha256"], []).append(item["index"])
            record["identical_entries"] = [v for v in duplicates.values() if len(v) > 1]
            manifest["files"].append(record)
        shared = {}
        for record in manifest["files"]:
            for item in record["entries"]:
                if not item.get("empty"):
                    shared.setdefault(item["payload_sha256"], []).append([record["source"], item["index"]])
        manifest["shared_between_files"] = [v for v in shared.values() if len({s for s, _ in v}) > 1]
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
        (staging / "index.html").write_text("\n".join(gallery) + "\n")
        if output.exists():
            raise ValueError("output already exists")
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    pictures = sum(1 for f in manifest["files"] for e in f["entries"] if not e.get("empty"))
    print("Decoded %d destination pictures into %s" % (pictures, args.output))


if __name__ == "__main__":
    main()
