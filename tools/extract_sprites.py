#!/usr/bin/env python3
"""Decode the SPR*.BIN sprite banks to PNG using tables and palettes found in 1ST_READ.BIN.

Sprite files are headerless texture data. Their 16-byte texture records (dimensions,
Kamui type, data address, 0) sit in the executable as runs ended by an all-0xFF record;
a run whose packed data size equals a sprite file's size is that file's table. Besides
the TEXDC formats, sprites use 4- and 8-bit palettised twiddled textures (Kamui types 5
and 7). The palette selector of each texture and the palette RAM contents are not stored
in the files: the game passes a per-texture selector array with each table to its sprite
loader, and its menu loader copies four ARGB4444 palettes into palette RAM. Both are
recovered by tracking constant registers through the executable's SH-4 code, so no
regional addresses are hard-coded. Texture numbers come from the executable's
(texture offset, table) list. Stdlib only; format reference: supplied decomp
docs/engine.md and tools/textures.py (which does not decode palettised textures).
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_textures import decode, digest, layout, png_bytes, spread
except ImportError:  # run as a script from the tools directory
    from extract_textures import decode, digest, layout, png_bytes, spread

LOAD = 0x0C010000
PALETTE_TYPES = {5: 4, 7: 8}  # Kamui palettised (twiddled) type -> bits per pixel
PALETTE_SIZE = 1024


def payload_size(width, height, data_type):
    if data_type in PALETTE_TYPES:
        if width not in (8 << n for n in range(8)) or height not in (8 << n for n in range(8)):
            raise ValueError("dimensions must be powers of two from 8 to 1024")
        return width * height * PALETTE_TYPES[data_type] // 8
    return layout(width, height, data_type)[1]


def read_record(executable, at):
    if not 0 <= at <= len(executable) - 16:
        return None
    dims, fmt, address, reserved = struct.unpack_from("<4I", executable, at)
    width, height, data_type, pixel_format = dims & 65535, dims >> 16, fmt >> 8, fmt & 255
    if address >> 24 not in (0x0C, 0x8C, 0xAC) or address % 32 or reserved or pixel_format > 2:
        return None
    try:
        size = payload_size(width, height, data_type)
    except ValueError:
        return None
    return dict(width=width, height=height, data_type=data_type,
                pixel_format=pixel_format, address=address & 0x1FFFFFFF, size=size)


def read_table(executable, at):
    """Records from at up to the all-0xFF terminator, or None if any record is malformed."""
    entries = []
    while at + 16 <= len(executable):
        if struct.unpack_from("<4I", executable, at) == (0xFFFFFFFF,) * 4:
            return entries
        entry = read_record(executable, at)
        if entry is None:
            return None
        entries.append(entry)
        at += 16
    return None


def discover_tables(executable, sizes):
    """Map file name -> table for each sprite file whose size one terminated run packs exactly.

    Records outside the packed range (e.g. a render target) are kept as external."""
    found = {}
    for at in range(0, len(executable) - 16, 4):
        if read_record(executable, at) is None or read_record(executable, at - 16) is not None:
            continue  # not the start of a run
        entries = read_table(executable, at)
        if not entries:
            continue
        base, end, offset = entries[0]["address"], 0, 0
        for entry in entries:
            entry["offset"] = entry["address"] - base
            entry["external"] = not 0 <= entry["offset"] < max(sizes.values())
            if not entry["external"]:
                if entry["offset"] != offset:
                    break
                offset = (entry["offset"] + entry["size"] + 31) & ~31
                end = entry["offset"] + entry["size"]
        else:
            for name, size in sizes.items():
                if size in (end, offset):
                    if name in found:
                        raise ValueError("two tables match %s" % name)
                    for entry in entries:
                        entry["external"] = entry["external"] or entry["offset"] >= size
                    found[name] = dict(executable_offset=at, address=LOAD + at, data_address=base,
                                       entries=entries)
    missing = sorted(set(sizes) - set(found))
    if missing:
        raise ValueError("no texture table for %s" % ", ".join(missing))
    return found

def sh4_step(executable, word, pc, regs):
    """Apply one SH-4 instruction to the known-constant registers; return its control action.

    Tracks mov #imm, mov.w/mov.l @(disp,pc) and mov Rm,Rn; any other instruction forgets
    the registers it may write."""
    top, n, m = word >> 12, word >> 8 & 15, word >> 4 & 15

    def forget(*numbers):
        for number in numbers:
            regs.pop(number, None)

    def read(fmt, address):
        offset = address - LOAD
        return struct.unpack_from(fmt, executable, offset)[0] if 0 <= offset <= len(executable) - 4 else None

    if top == 0xD:
        value = read("<I", (pc & ~3) + 4 + (word & 255) * 4)
        forget(n)
        if value is not None:
            regs[n] = value
    elif top == 0x9:
        value = read("<h", pc + 4 + (word & 255) * 2)
        forget(n)
        if value is not None:
            regs[n] = value & 0xFFFFFFFF
    elif top == 0xE:
        regs[n] = ((word & 255) - 256 if word & 128 else word & 255) & 0xFFFFFFFF
    elif top == 0x6 and word & 15 == 3:
        if m in regs:
            regs[n] = regs[m]
        else:
            forget(n)
    elif top == 0x4 and word & 255 == 0x0B:
        return "call", regs.get(n)
    elif top == 0xB or (top == 0 and word & 255 in (0x03, 0x23)):
        return "call", None
    elif top == 0xA:
        displacement = word & 0xFFF
        return "branch", pc + 4 + 2 * (displacement - 4096 if displacement & 0x800 else displacement)
    elif word == 0x000B:
        return "return", None
    elif top == 0x2 and word & 15 in (0, 1, 2, 8, 9, 10, 11):
        if word & 15 >= 9:
            forget(n)  # and/xor/or write Rn; stores and tst do not
    elif top == 0x1 or (top == 0 and word & 15 in (4, 5, 6)) or (top == 0x3 and word & 15 in (0, 2, 3, 6, 7)):
        pass  # stores and compares
    elif top in (0x8, 0xC):
        forget(0)
    else:
        forget(n, m, 0)
    return None


def scan_calls(executable):
    """Linear SH-4 pass: every jsr/bsr with the r4-r6 values known as constants at the call.

    Delay slots run before the call; calls clobber r0-r7; rts forgets everything. A forward
    bra also carries its registers to the target, which is followed up to its first call."""
    calls, regs, function, pending, forks = [], {}, LOAD, None, {}

    def record(site, state, target):
        calls.append(dict(site=site, function=function, target=target,
                          r4=state.get(4), r5=state.get(5), r6=state.get(6)))

    def follow(at, state):
        delay = None
        for _ in range(32):
            if not 0 <= at <= len(executable) - 2:
                return
            action = sh4_step(executable, struct.unpack_from("<H", executable, at)[0], LOAD + at, state)
            if delay is not None:
                if delay[0] == "call":
                    record(LOAD + at - 2, state, delay[1])
                return
            if action is not None:
                delay = action
            at += 2

    for at in range(0, len(executable) - 1, 2):
        pc = LOAD + at
        for state in forks.pop(pc, ()):
            follow(at, state)
        action = sh4_step(executable, struct.unpack_from("<H", executable, at)[0], pc, regs)
        if pending is not None:  # the instruction just handled was a delay slot
            kind, target = pending
            if kind == "call":
                record(pc - 2, regs, target)
                for number in range(8):
                    regs.pop(number, None)
            elif kind == "branch":
                if target > pc:
                    forks.setdefault(target, []).append(dict(regs))
            else:
                regs.clear()
                function = pc + 2
            pending = None
        elif action is not None:
            pending = action
    return calls


def recover_loads(executable, tables):
    """Per table: palette-selector array address (0 for none); plus the palette uploads."""
    addresses = {table["address"]: name for name, table in tables.items()}
    selectors, functions = {name: set() for name in tables}, set()
    calls = scan_calls(executable)
    for call in calls:
        name = addresses.get(call["r4"])
        if name is not None and call["target"] is not None and call["r5"] is not None \
                and (call["r5"] == 0 or 0 <= call["r5"] - LOAD < len(executable)):
            selectors[name].add(call["r5"])
            functions.add(call["function"])
    for name, values in selectors.items():
        if len(values) != 1:
            raise ValueError("%s: expected one palette selector array, found %d" % (name, len(values)))
    uploads = {}
    for call in calls:
        if call["function"] in functions and None not in (call["r4"], call["r5"], call["r6"]) \
                and call["r4"] % 16 == 0 and call["r6"] in (16, 256) \
                and call["r4"] + call["r6"] <= PALETTE_SIZE \
                and 0 <= call["r5"] - LOAD <= len(executable) - 2 * call["r6"]:
            uploads[call["r4"]] = (call["r5"], call["r6"])
    return {name: values.pop() for name, values in selectors.items()}, uploads


def palette_ram(executable, uploads):
    """Palette RAM as the uploads leave it (ARGB4444 words); None for entries never written."""
    ram = [None] * PALETTE_SIZE
    for start in sorted(uploads):
        address, count = uploads[start]
        ram[start:start + count] = struct.unpack_from("<%dH" % count, executable, address - LOAD)
    return ram


def decode_palettised(payload, width, height, data_type, selector, ram):
    """RGBA of a twiddled 4/8-bit texture. 4-bit: low nibble first; selector * 16 + index.
    8-bit: (selector & 0x30) * 16 + index, as the PowerVR palette selector works."""
    bits = PALETTE_TYPES[data_type]
    if len(payload) != width * height * bits // 8:
        raise ValueError("texture payload size mismatch")
    base = selector * 16 if bits == 4 else (selector & 0x30) * 16
    side, twiddle = min(width, height), [spread(i) for i in range(max(width, height))]
    result = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            index = (x // side + y // side) * side * side + (twiddle[x % side] << 1 | twiddle[y % side])
            value = payload[index >> 1] >> 4 * (index & 1) & 15 if bits == 4 else payload[index]
            word = ram[base + value]
            if word is None:
                raise ValueError("palette entry %d was never loaded" % (base + value))
            at = (y * width + x) * 4
            result[at:at + 4] = bytes(((word >> 8 & 15) * 17, (word >> 4 & 15) * 17,
                                       (word & 15) * 17, (word >> 12 & 15) * 17))
    return bytes(result)


def texture_numbers(executable, tables):
    """Common texture number of each table's first texture, from (offset, table) word pairs."""
    numbers = {}
    for name, table in tables.items():
        needle, hits = struct.pack("<I", table["address"]), []
        at = executable.find(needle)
        while at >= 0:
            if at % 4 == 0 and at >= 4:
                value = struct.unpack_from("<I", executable, at - 4)[0]
                if value < 4096:
                    hits.append(value)
            at = executable.find(needle, at + 1)
        if len(hits) != 1:
            raise ValueError("%s: expected one texture offset pair, found %d" % (name, len(hits)))
        numbers[name] = hits[0]
    return numbers


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    files = {path.name: path.read_bytes() for path in sorted(source.glob("SPR*.BIN"))}
    if not files:
        raise ValueError("no SPR*.BIN files in source")
    tables = discover_tables(executable, {name: len(data) for name, data in files.items()})
    selectors, uploads = recover_loads(executable, tables)
    ram = palette_ram(executable, uploads)
    numbers = texture_numbers(executable, tables)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".sprites-", dir=output.parent))
    manifest = dict(schema=1, executable=dict(path="1ST_READ.BIN", sha256=digest(executable)),
                    palette_format="ARGB4444",
                    palette_uploads=[dict(start=start, address=uploads[start][0], count=uploads[start][1])
                                     for start in sorted(uploads)],
                    banks=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi sprites</title>',
               '<style>body{font-family:system-ui;background:#222;color:white}figure{display:inline-block;'
               'margin:8px}img{max-width:256px;max-height:160px;image-rendering:pixelated;'
               'background:repeating-conic-gradient(#888 0 25%,#ddd 0 50%) 0 0/16px 16px}</style>',
               '<h1>Local SPR sprite textures</h1><p>Captions: texture number, size.</p>']
    try:
        for name in sorted(files):
            data, table = files[name], tables[name]
            selector_address = selectors[name]
            count = len(table["entries"])
            values = (struct.unpack_from("<%dI" % count, executable, selector_address - LOAD)
                      if selector_address else (0,) * count)
            folder = staging / Path(name).stem
            folder.mkdir()
            bank = dict(source=name, size=len(data), sha256=digest(data),
                        table_executable_offset=table["executable_offset"], data_address=table["data_address"],
                        selector_address=selector_address, first_texture_number=numbers[name], textures=[])
            gallery.append('<h2>%s</h2>' % html.escape(name))
            for index, item in enumerate(table["entries"]):
                record = dict(item, id=index, texture_number=numbers[name] + index, palette_selector=values[index])
                if item["external"]:
                    bank["textures"].append(record)
                    continue
                payload = data[item["offset"]:item["offset"] + item["size"]]
                if item["data_type"] in PALETTE_TYPES:
                    rgba = decode_palettised(payload, item["width"], item["height"], item["data_type"],
                                             values[index], ram)
                else:
                    rgba = decode(payload, item["width"], item["height"], item["data_type"], item["pixel_format"])
                encoded = png_bytes(item["width"], item["height"], rgba)
                relative = "%s/%04d.png" % (folder.name, index)
                (staging / relative).write_bytes(encoded)
                if digest((staging / relative).read_bytes()) != digest(encoded):
                    raise ValueError("written PNG hash mismatch")
                record.update(png=relative, payload_sha256=digest(payload), rgba_sha256=digest(rgba),
                              png_sha256=digest(encoded))
                bank["textures"].append(record)
                gallery.append('<figure><img loading="lazy" src="%s"><figcaption>%d: %dx%d</figcaption></figure>'
                               % (relative, record["texture_number"], item["width"], item["height"]))
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
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, "error: %s\n" % error)
    written = sum(1 for bank in manifest["banks"] for item in bank["textures"] if "png" in item)
    print("Decoded %d sprite textures from %d banks into %s" % (written, len(manifest["banks"]), args.output))


if __name__ == "__main__":
    main()
