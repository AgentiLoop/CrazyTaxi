#!/usr/bin/env python3
"""Decode the four recorded demo drives (REC*.BIN) to per-frame JSON input tracks.

Each file is a flat array of 20-byte frame records that the game's replay routine copies into the
player's input block once per frame: steering (-1..1), accelerator (0..1) and brake (0..1) as
float32, a gear-button word and the value the game's random generator returned on that frame:

    +0x00 f32 steering     +0x04 f32 accelerator     +0x08 f32 brake
    +0x0C u32 buttons: 0x200000 reverse held, 0x100000 drive held,
                       0x20 reverse pressed, 0x10 drive pressed (only on frames where the held bit rises)
    +0x10 u32 random value recorded for a sync check

The loader is found by shape: the executable's only literal pool holding the four file-name
pointers in a row, preceded by the buffer address and its capacity. The pool order is
(Adv/Arcade, Adv/Original, End/Arcade, End/Original), matching the names.

The random column is checked against the game's generator (seed = seed * 1103515245 + 12345,
value = (seed >> 16) & 0x7FFF, reseeded to 12345 before a drive): each frame's value must follow
the previous one within MAX_GAP calls, or be reached within MAX_GAP calls of a fresh reseed. The
calls per frame, the reseed frames and the number of frames that match go into the manifest.

Stdlib only; no upstream imports; no regional addresses are used.
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_landmarks import find_file_name, literals
    from tools.extract_sprites import LOAD
    from tools.extract_textures import digest
except ImportError:  # run as a script from the tools directory
    from extract_landmarks import find_file_name, literals
    from extract_sprites import LOAD
    from extract_textures import digest

FILES = ("RECADVAC.BIN", "RECADVDC.BIN", "RECENDAC.BIN", "RECENDDC.BIN")
ROLES = (("advertise", "Arcade"), ("advertise", "Original"), ("ending", "Arcade"), ("ending", "Original"))
RECORD = 20
REVERSE_HELD, DRIVE_HELD, REVERSE_PRESSED, DRIVE_PRESSED = 0x200000, 0x100000, 0x20, 0x10
KNOWN_BUTTONS = REVERSE_HELD | DRIVE_HELD | REVERSE_PRESSED | DRIVE_PRESSED
RAND_MUL, RAND_ADD, RAND_SEED = 1103515245, 12345, 12345
MAX_GAP = 1024


def rand_value(state):
    return (state >> 16) & 0x7FFF


def rng_sync(values, seed=RAND_SEED, max_gap=MAX_GAP):
    """(calls per frame, reseeded frames): generator calls up to each recorded value, None when not found.

    A value equal to the first output after the seed is a reseed (the game reseeds before each
    drive and at other points; count 1). Otherwise it must follow the previous frame's state within
    max_gap calls. Unmatched frames lose the state until the next reseed.
    """
    first = (seed * RAND_MUL + RAND_ADD) & 0xFFFFFFFF
    state, steps, reseeded = None, [], []
    for frame, value in enumerate(values):
        found = None
        if value == rand_value(first):
            found = (first, 1)
            reseeded.append(frame)
        elif state is not None:
            current = state
            for calls in range(1, max_gap + 1):
                current = (current * RAND_MUL + RAND_ADD) & 0xFFFFFFFF
                if rand_value(current) == value:
                    found = (current, calls)
                    break
        state = found[0] if found else None
        steps.append(found[1] if found else None)
    return steps, reseeded


def parse(data):
    """Columns of a recording; raises if the size or button bits are unexpected."""
    if len(data) % RECORD or not data:
        raise ValueError("recording size %d is not a multiple of %d" % (len(data), RECORD))
    frames = [struct.unpack_from("<3f2I", data, at) for at in range(0, len(data), RECORD)]
    columns = dict(steering=[], accelerator=[], brake=[], buttons=[], random=[])
    previous = 0
    for number, (steer, accel, brake, buttons, value) in enumerate(frames):
        if buttons & ~KNOWN_BUTTONS:
            raise ValueError("frame %d: unknown button bits %#x" % (number, buttons))
        if not (-1 <= steer <= 1 and 0 <= accel <= 1 and 0 <= brake <= 1) or value > 0x7FFF:
            raise ValueError("frame %d: value out of range" % number)
        for pressed, held in ((REVERSE_PRESSED, REVERSE_HELD), (DRIVE_PRESSED, DRIVE_HELD)):
            if buttons & pressed and not (buttons & held and not previous & held):
                raise ValueError("frame %d: press bit without a rising held bit" % number)
        previous = buttons
        for key, item in zip(columns, (steer, accel, brake, buttons, value)):
            columns[key].append(item)
    return columns


def find_loader(executable, sizes):
    """(pool address, buffer, capacity, name addresses) from the pool listing all four names in order."""
    names = [find_file_name(executable, name) for name in FILES]
    found = []
    for at in literals(executable, names[0]):
        offset = at - LOAD
        if offset < 12 or offset + 16 > len(executable):
            continue
        if list(struct.unpack_from("<4I", executable, offset)) != names:
            continue
        buffer, capacity = struct.unpack_from("<2I", executable, offset - 12)
        if buffer >> 24 == 0x0C and buffer % 4 == 0 and max(sizes) <= capacity < 0x100000:
            found.append((at, buffer, capacity))
    if len(found) != 1:
        raise ValueError("expected one recording loader pool, found %d" % len(found))
    return found[0] + (names,)


def chart(columns, width=900, height=60, step=6):
    """Inline SVG: steering (blue, centred), accelerator (green) and brake (red), every `step` frames."""
    count = len(columns["steering"])
    lines = []
    for key, colour, centre in (("steering", "#4af", True), ("accelerator", "#4c4", False), ("brake", "#f55", False)):
        points = []
        for frame in range(0, count, step):
            value = columns[key][frame]
            y = height / 2 - value * height / 2 if centre else height - value * height
            points.append("%.1f,%.1f" % (frame * width / count, y))
        lines.append('<polyline fill="none" stroke="%s" points="%s"/>' % (colour, " ".join(points)))
    return '<svg width="%d" height="%d" style="background:#111">%s</svg>' % (width, height, "".join(lines))


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    recordings = [(source / name).read_bytes() for name in FILES]
    pool, buffer, capacity, names = find_loader(executable, [len(d) for d in recordings])
    manifest = dict(schema=1, executable=dict(path="1ST_READ.BIN", sha256=digest(executable)),
                    loader=dict(pool=pool, buffer=buffer, capacity=capacity,
                                file_name_strings=dict(zip(FILES, names))),
                    record=dict(size=RECORD, fields=["steering", "accelerator", "brake", "buttons", "random"],
                                buttons=dict(reverse_held=REVERSE_HELD, drive_held=DRIVE_HELD,
                                             reverse_pressed=REVERSE_PRESSED, drive_pressed=DRIVE_PRESSED)),
                    random=dict(multiplier=RAND_MUL, increment=RAND_ADD, seed=RAND_SEED, max_gap=MAX_GAP),
                    files=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi recorded drives</title>',
            '<style>body{font-family:system-ui;background:#222;color:white}</style>',
            '<h1>Local Crazy Taxi recorded drives</h1><p>Blue: steering (centre line = straight), '
            'green: accelerator, red: brake.</p>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".replays-", dir=output.parent))
    try:
        for name, data, (kind, city) in zip(FILES, recordings, ROLES):
            columns = parse(data)
            gaps, reseeded = rng_sync(columns["random"])
            in_sync = sum(1 for g in gaps if g is not None)
            relative = name.split(".")[0].lower() + ".json"
            track = dict(source=name, kind=kind, city=city, frames=len(columns["steering"]), **columns)
            (staging / relative).write_text(json.dumps(track, separators=(",", ":")) + "\n")
            presses = {key: sum(1 for b in columns["buttons"] if b & bit)
                       for key, bit in (("reverse_pressed", REVERSE_PRESSED), ("drive_pressed", DRIVE_PRESSED))}
            manifest["files"].append(dict(source=name, kind=kind, city=city, size=len(data), sha256=digest(data),
                                          json=relative, frames=len(columns["steering"]), presses=presses,
                                          random_frames_in_sync=in_sync, random_reseed_frames=reseeded,
                                          random_calls_per_frame=gaps))
            page.append("<h2>%s (%s, %s)</h2><p>%d frames; random values match the generator on %d "
                        "(%d reseeds).</p>%s" % (html.escape(name), kind, city, len(columns["steering"]),
                                                 in_sync, len(reseeded), chart(columns)))
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
        (staging / "index.html").write_text("\n".join(page) + "\n")
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
    print("Decoded %d recorded drives into %s" % (len(manifest["files"]), args.output))


if __name__ == "__main__":
    main()
