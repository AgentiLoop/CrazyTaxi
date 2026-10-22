#!/usr/bin/env python3
"""Extract Crazy Taxi's customers: where each one waits, which stops it can ask for, and the stops.

All of it is static data in the USA executable (1ST_READ.BIN), read the way the game reads it:

* kyakuInitStops (USA 0x0C025640) picks one customer table by CourseMode (0x0C1EBF2C) and, for
  CourseMode 0 and 1, by ReverseMode (0x0C17720C, the decomp's name); Crazy Box (CourseMode 2) picks
  by MiniGame_No (0x0C1EBF34) through a jump table. A customer record is 40 bytes:
  +0 flag, +4 kind (-1 = unused), +8 x, y, z, +0x14 a line index the routine overwrites,
  +0x18 three signed destination stop numbers (-1 = none), +0x1B pad, +0x1C three floats the
  routine overwrites with route lengths.
* kyakuTaskStart (0x0C024718) asks for destination (frame counter / 600) % 3 and draws the
  customer as character table entry kind_to_character[kind] (USA 0x0C08A118).
* Stops come from two tables indexed [Game_No (0x0C1EBF30)][MiniGame_No]: a count (USA 0x0C0EC7C4)
  and an array of {point count, point pointer} areas (USA 0x0C0EC764). GetStopPosCenter
  (0x0C025A4C) takes the mean of an area's points as the stop centre and 1.2 times the farthest
  point's distance as its radius.
* Chat_TellDestination (0x0C060490) picks the destination line the customer speaks: in the Arcade
  city entry stop * 5 + slot of a 5-wide table (USA 0x0C0D1EE8); in the Original city a fixed
  Arcade-table row for the stops it shares (ORIGINAL_ROWS) and a rotating generic table
  (USA 0x0C0D217C) for the rest; in Crazy Box always the generic table. The slot is bits 29-31
  of passenger word +0x148 (not traced further).
* The id is a VOICE01.AFS file number. Chat_TellDestination writes it as a one-step voice script
  {id, start frame 2, length 0x7FFFFFFF} at 0x0C13D910 and queues it on channel 2 with
  Voice_Request (USA 0x0C0720E8). Voice_ExecuteChannel (0x0C072060) passes the step's id to
  0x0C02DCFC (adxStartAfs2), which calls ADXT_StartAfs (0x0C14F838) with partition 2, and
  gdc_SetStreamAFS loads partition 2 from "VOICE01.AFS" (name at 0x0C08B9BC). Before that it copies
  one of 12 reply steps (USA 0x0C0D2A2C) to 0x0C13D928 and queues it on channel 1: entry
  3 * (byte 0x0C2AA498 - 1) + (counter 0x0C13D898 % 3). What that byte selects (4 values, the
  driver is likely) was not traced.

The table addresses are the decomp's (EU) data addresses moved by -0x1200; the tool refuses to run
unless each is the literal the USA routine loads (POOL), the voice path instructions are the ones
above (CODE), and the Crazy Box jump table reaches each table's load. Every voice id must be a
VOICE01.AFS file; with --audio the matching extract_audio.py WAV (VOICE01/NNNN.wav) must exist and
the page links it. Positions are world coordinates (the space of models/BINCn.glb).
Stdlib only; no upstream imports.
"""
import argparse
import html
import json
import math
import os
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_models import digest
    from tools.extract_collision import f32
    from tools.extract_audio import afs_entries
except ImportError:  # run as a script from the tools directory
    from extract_models import digest
    from extract_collision import f32
    from extract_audio import afs_entries


LOAD = 0x0C010000
RECORD = 40
STOP_COUNTS = 0x0C0EC7C4
STOP_AREAS = 0x0C0EC764
KIND_TO_CHARACTER = 0x0C08A118
KINDS = 36
ARCADE_VOICES = 0x0C0D1EE8
GENERIC_VOICES = 0x0C0D217C
VOICE_SLOTS = 5
GENERIC_ROWS = 5
REPLIES = 0x0C0D2A2C  # 12 voice steps {id, start frame, length}
REPLY_GROUPS, REPLY_VARIANTS = 4, 3
VOICE_AFS = "VOICE01.AFS"
VOICE_AFS_NAME = 0x0C08B9BC
VOICE_FILE = "VOICE01/%04d.wav"  # extract_audio.py's name for VOICE01.AFS file n
# Original-city stop -> Arcade voice-table row (Chat_TellDestination's add #40, #55 ... per stop).
ORIGINAL_ROWS = {1: 8, 2: 11, 3: 12, 4: 13, 5: 14, 13: 19, 15: 22, 16: 7, 17: 9, 18: 30, 22: 26,
                 23: 17, 24: 17, 25: 17, 26: 17, 27: 17}
# (name, course_mode, reverse_mode, mini_game, table, records, game_no for stops)
TABLES = (
    ("arcade", 0, 0, None, 0x0C0D9E08, 246, 0),
    ("arcade_reverse", 0, 1, None, 0x0C0DC478, 202, 0),
    ("original", 1, 0, None, 0x0C0DE408, 246, 1),
    ("original_reverse", 1, 1, None, 0x0C0E0A78, 246, 1),
    ("course_mode_0_mini_game_15", 0, None, 15, 0x0C0E3750, 1, None),
    ("crazy_box_game_03", 2, None, 3, 0x0C0E3778, 1, 2),
    ("crazy_box_game_04", 2, None, 4, 0x0C0E30E8, 1, 2),
    ("crazy_box_game_05", 2, None, 5, 0x0C0E3110, 1, 2),
    ("crazy_box_game_06", 2, None, 6, 0x0C0E3138, 1, 2),
    ("crazy_box_game_07", 2, None, 7, 0x0C0E3160, 1, 2),
    ("crazy_box_game_08", 2, None, 8, 0x0C0E3188, 10, 2),
    ("crazy_box_game_09", 2, None, 9, 0x0C0E3318, 3, 2),
    ("crazy_box_game_10", 2, None, 10, 0x0C0E3390, 8, 2),
    ("crazy_box_game_11", 2, None, 11, 0x0C0E34D0, 7, 2),
    ("crazy_box_game_12", 2, None, 12, 0x0C0E35E8, 1, 2),
    ("crazy_box_game_13", 2, None, 13, 0x0C0E3610, 1, 2),
    ("crazy_box_game_14", 2, None, 14, 0x0C0E3638, 7, 2),
)
# USA literal-pool word -> the value the routine loads from it (kyakuInitStops, GetStopPosCenter,
# kyakuTaskStart, Chat_TellDestination).
POOL = {0x0C02576C: STOP_COUNTS, 0x0C025B44: STOP_AREAS, 0x0C025780: 0x0C0D9E08, 0x0C025774: 0x0C0DC478,
        0x0C025788: 0x0C0DE408, 0x0C025784: 0x0C0E0A78, 0x0C02577C: 0x0C0E3750, 0x0C025778: 0x0C1EBF2C,
        0x0C025770: 0x0C17720C, 0x0C025768: 0x0C1EBF30, 0x0C024840: KIND_TO_CHARACTER,
        0x0C024818: 600, 0x0C060524: ARCADE_VOICES, 0x0C060530: GENERIC_VOICES,
        # Chat_TellDestination: script buffer, reply table, length, reply selectors, Voice_Request
        0x0C060514: 0x0C13D910, 0x0C060518: REPLIES, 0x0C0606E8: 0x7FFFFFFF, 0x0C0606EC: 0x0C2AA498,
        0x0C0606F0: 0x0C13D898, 0x0C060700: 0x0C0720E8,
        # Voice_ExecuteChannel -> adxStartAfs2 -> ADXT_StartAfs; gdc_SetStreamAFS partition 2 name
        0x0C0721A0: 0x0C02DCFC, 0x0C02DDD4: 0x0C14F838, 0x0C02D7D0: VOICE_AFS_NAME}
POOL_HALFWORDS = {0x0C024818, 0x0C02575A, 0x0C02588E}
# USA instruction -> expected opcode on the destination voice path.
CODE = {0x0C060668: 0xE302,  # mov #2,r3            step start frame 2
        0x0C06066A: 0x1D31,  # mov.l r3,@(4,r13)    (r13 = 0x0C13D910)
        0x0C06066E: 0x1D22,  # mov.l r2,@(8,r13)    step length 0x7FFFFFFF
        0x0C060670: 0x7118,  # add #24,r1           reply step at +24
        0x0C0606B0: 0xE501,  # mov #1,r5            reply on channel 1
        0x0C0606C2: 0xE502,  # mov #2,r5            destination on channel 2
        0x0C0606CA: 0x64D3,  # mov r13,r4           ... the 0x0C13D910 script
        0x0C072080: 0x6552,  # mov.l @r5,r5         step word 0 is the file id
        0x0C02DD08: 0xE502,  # mov #2,r5            ADXT_StartAfs partition 2
        0x0C02D71C: 0xE402}  # mov #2,r4            ADXF_LoadPartition 2
JUMP = 0x0C0257A4  # braf base of the Crazy Box switch on MiniGame_No - 3 (12 halfword offsets)
JUMP_FIRST, JUMP_COUNT = 3, 12
LONG_STOPS = 1 << 12
MAX_POINTS = 1 << 10


class Executable:
    def __init__(self, data):
        self.data = data

    def word(self, address, fmt="<I"):
        offset = address - LOAD
        size = struct.calcsize(fmt)
        if offset < 0 or offset + size > len(self.data):
            raise ValueError("address 0x%08X outside the executable" % address)
        return struct.unpack_from(fmt, self.data, offset)[0]

    def floats(self, address, count):
        return [self.word(address + 4 * k, "<f") for k in range(count)]


def check_pool(exe):
    for address, value in sorted(POOL.items()):
        got = exe.word(address, "<H") if address in POOL_HALFWORDS else exe.word(address)
        if got != value:
            raise ValueError("pool word 0x%08X is 0x%X, expected 0x%X" % (address, got, value))
    for address, value in ((0x0C02575A, 202), (0x0C02588E, 246)):
        if exe.word(address, "<H") != value:
            raise ValueError("record count at 0x%08X is not %d" % (address, value))
    for address, op in sorted(CODE.items()):
        if exe.word(address, "<H") != op:
            raise ValueError("instruction at 0x%08X is not 0x%04X" % (address, op))
    name = VOICE_AFS.encode() + b"\0"
    if exe.data[VOICE_AFS_NAME - LOAD:VOICE_AFS_NAME - LOAD + len(name)] != name:
        raise ValueError("partition 2 name at 0x%08X is not %s" % (VOICE_AFS_NAME, VOICE_AFS))


def read_replies(exe):
    """The 12 reply steps: group = byte 0x0C2AA498 - 1, variant = counter % 3."""
    return [dict(group=k // REPLY_VARIANTS, variant=k % REPLY_VARIANTS,
                 voice=exe.word(REPLIES + 12 * k, "<i"), start_frame=exe.word(REPLIES + 12 * k + 4, "<i"),
                 length=exe.word(REPLIES + 12 * k + 8, "<i"))
            for k in range(REPLY_GROUPS * REPLY_VARIANTS)]


def jump_targets(exe):
    """Crazy Box switch: MiniGame_No -> the set of tables loaded into r14 near its case label."""
    targets = {}
    for k in range(JUMP_COUNT):
        label = JUMP + exe.word(JUMP + 2 * k, "<h")
        loads = set()
        for pc in range(label, label + 0x12, 2):
            op = exe.word(pc, "<H")
            if op >> 8 == 0xDE:  # mov.l @(disp, PC), r14
                loads.add(exe.word(((pc + 4) & ~3) + 4 * (op & 0xFF)))
        targets[JUMP_FIRST + k] = loads
    return targets


def check_tables(exe):
    targets = jump_targets(exe)
    for name, mode, _, mini, table, _, _ in TABLES:
        if mode == 2 and table not in targets.get(mini, ()):
            raise ValueError("Crazy Box game %d case does not load %s at 0x%08X" % (mini, name, table))
    spans = sorted((t, t + RECORD * n) for *_, t, n, _ in TABLES)
    for (_, end), (start, _) in zip(spans, spans[1:]):
        if end != start:
            raise ValueError("customer tables are not back to back at 0x%08X / 0x%08X" % (end, start))


def stop_count(exe, game, mini):
    return exe.word(exe.word(STOP_COUNTS + 4 * game) + 4 * mini, "<i")


def read_stops(exe, game, mini):
    count = stop_count(exe, game, mini)
    if not 0 <= count < LONG_STOPS:
        raise ValueError("bad stop count %d for Game_No %d MiniGame_No %d" % (count, game, mini))
    areas = exe.word(exe.word(STOP_AREAS + 4 * game) + 4 * mini)
    stops = []
    for s in range(count):
        n, points = exe.word(areas + 8 * s, "<i"), exe.word(areas + 8 * s + 4)
        if not 0 < n < MAX_POINTS:
            raise ValueError("stop %d has %d area points" % (s, n))
        area = [exe.floats(points + 12 * k, 3) for k in range(n)]
        centre = [sum(p[i] for p in area) / n for i in range(3)]
        radius = 1.2 * max(math.dist(centre, p) for p in area)
        stops.append(dict(index=s, centre=[f32(v) for v in centre], radius=f32(radius),
                          area=[[f32(v) for v in p] for p in area], area_address=points))
    return stops


def read_customers(exe, table, count):
    customers = []
    for k in range(count):
        flag, kind, x, y, z, line, d0, d1, d2, pad, r0, r1, r2 = struct.unpack_from(
            "<ii3fi3bb3f", exe.data, table + RECORD * k - LOAD)
        customers.append(dict(index=k, flag=flag, kind=kind, position=[f32(x), f32(y), f32(z)],
                              line_index_in_file=line, destinations=[d0, d1, d2], pad=pad,
                              route_lengths_in_file=[f32(r0), f32(r1), f32(r2)]))
    return customers


def nearest(points, position):
    return min(range(len(points)), key=lambda j: (points[j][0] - position[0]) ** 2 + (points[j][2] - position[2]) ** 2)


def voice_rows(exe, game, stops):
    """Per stop: the 5 voice ids Chat_TellDestination can request, or None for the generic line."""
    rows = []
    for s in range(stops):
        row = s if game == 0 else ORIGINAL_ROWS.get(s) if game == 1 else None
        rows.append(None if row is None else [exe.word(ARCADE_VOICES + 4 * (row * VOICE_SLOTS + v), "<i")
                                              for v in range(VOICE_SLOTS)])
    return rows


def svg_map(stops, customers):
    xs = [p[0] for s in stops for p in s["area"]] + [c["position"][0] for c in customers]
    zs = [p[2] for s in stops for p in s["area"]] + [c["position"][2] for c in customers]
    if not xs:
        return ""
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    span = max(x1 - x0, z1 - z0, 1.0)
    scale = 560.0 / span
    pt = lambda x, z: "%.1f,%.1f" % (20 + (x - x0) * scale, 20 + (z - z0) * scale)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" style="background:#111">']
    for s in stops:
        out.append('<polygon points="%s" fill="#3a6" fill-opacity="0.5" stroke="#6f9"/>'
                   % " ".join(pt(p[0], p[2]) for p in s["area"]))
        out.append('<text x="%s" y="%s" fill="#fff" font-size="10">%d</text>'
                   % (*pt(s["centre"][0], s["centre"][2]).split(","), s["index"]))
    for c in customers:
        if c["kind"] >= 0:
            x, y = pt(c["position"][0], c["position"][2]).split(",")
            out.append('<circle cx="%s" cy="%s" r="2" fill="#fc3"><title>customer %d kind %d to %s</title></circle>'
                       % (x, y, c["index"], c["kind"], c["destinations"]))
    out.append("</svg>")
    return "".join(out)


def extract(source, output, courses=None, audio=None):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    data = (source / "1ST_READ.BIN").read_bytes()
    exe = Executable(data)
    check_pool(exe)
    check_tables(exe)
    kinds = [exe.word(KIND_TO_CHARACTER + 4 * k, "<i") for k in range(KINDS)]
    generic = [[exe.word(GENERIC_VOICES + 4 * (r * VOICE_SLOTS + v), "<i") for v in range(VOICE_SLOTS)]
               for r in range(GENERIC_ROWS)]
    stop_sets = {}
    for game, minis in ((0, [0]), (1, [0]), (2, list(range(16)))):
        for mini in minis:
            stops = read_stops(exe, game, mini)
            if stops or game < 2:
                stop_sets[(game, mini)] = stops
    lines = {}
    if courses is not None:
        for game, city in ((0, "arcade"), (1, "original")):
            path = Path(courses) / ("%s.json" % city)
            if path.exists():
                lines[game] = json.loads(path.read_text())["courses"][0][-1]
    sets, checks = [], dict(destinations_within_stops=0, destinations=0, kinds_in_range=0, customers=0,
                            line_index_is_nearest_course0_point={})
    for name, mode, reverse, mini, table, count, game in TABLES:
        customers = read_customers(exe, table, count)
        stops_key = (game, 0 if game < 2 else mini) if game is not None else None
        stops = stop_sets.get(stops_key, []) if stops_key else []
        for c in customers:
            if c["kind"] < 0:
                continue
            checks["customers"] += 1
            checks["kinds_in_range"] += c["kind"] < KINDS
            c["character"] = kinds[c["kind"]] if c["kind"] < KINDS else None
            for d in c["destinations"]:
                if d >= 0 and stops_key is not None:
                    checks["destinations"] += 1
                    checks["destinations_within_stops"] += d < len(stops)
        if game in lines and mini is None:
            hit = sum(nearest(lines[game], c["position"]) == c["line_index_in_file"] for c in customers if c["kind"] >= 0)
            checks["line_index_is_nearest_course0_point"][name] = [hit, sum(c["kind"] >= 0 for c in customers)]
        sets.append(dict(name=name, course_mode=mode, reverse_mode=reverse, mini_game=mini, table=table,
                         records=count, stops=None if stops_key is None else
                         dict(game_no=stops_key[0], mini_game_no=stops_key[1], count=len(stops)),
                         customers=customers))
    if checks["kinds_in_range"] != checks["customers"] or checks["destinations_within_stops"] != checks["destinations"]:
        raise ValueError("customer kinds or destinations out of range: %s" % checks)
    stop_list = []
    for (game, mini), stops in sorted(stop_sets.items()):
        entry = dict(game_no=game, mini_game_no=mini, count=len(stops), stops=stops)
        if game < 2:
            rows = voice_rows(exe, game, len(stops))
            for s, row in zip(stops, rows):
                s["voices"] = row
        stop_list.append(entry)
    replies = read_replies(exe)
    voice_data = (source / VOICE_AFS).read_bytes()
    clips = len(afs_entries(voice_data))
    used = sorted({v for row in generic for v in row} | {r["voice"] for r in replies}
                  | {v for e in stop_list for s in e["stops"] for v in (s.get("voices") or [])})
    if not all(0 <= v < clips for v in used):
        raise ValueError("voice id outside %s's %d files" % (VOICE_AFS, clips))
    link = None
    if audio is not None:
        missing = [v for v in used if not (Path(audio) / (VOICE_FILE % v)).is_file()]
        if missing:
            raise ValueError("audio folder lacks %s" % (VOICE_FILE % missing[0]))
        base = os.path.relpath(Path(audio).absolute(), output)
        link = lambda v: '<a href="%s">%d</a>' % (html.escape(Path(base, VOICE_FILE % v).as_posix()), v)
    checks.update(voice_ids=len(used), voice_afs_files=clips)
    manifest = dict(schema=2, load_address=LOAD, record_size=RECORD,
                    sources={"1ST_READ.BIN": dict(size=len(data), sha256=digest(data)),
                             VOICE_AFS: dict(size=len(voice_data), sha256=digest(voice_data))},
                    addresses=dict(stop_counts=STOP_COUNTS, stop_areas=STOP_AREAS, kind_to_character=KIND_TO_CHARACTER,
                                   arcade_voices=ARCADE_VOICES, generic_voices=GENERIC_VOICES, jump_table=JUMP,
                                   replies=REPLIES),
                    destination_rule="kyakuTaskStart asks for destinations[(frame counter / 600) % 3]",
                    voice_rule="a voice id is %s file n (extract_audio.py %s); the destination line plays on "
                               "voice channel 2 from frame 2, the reply on channel 1 from its start frame"
                               % (VOICE_AFS, VOICE_FILE),
                    kind_to_character=kinds, generic_voices=generic, original_voice_rows=ORIGINAL_ROWS,
                    replies=replies, checks=checks, stop_sets=stop_list, customer_sets=sets, files=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi customers</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}a{color:#9cf}</style>',
               '<h1>Local Crazy Taxi customers and stops</h1><p>Top view (x right, z down). Green: stop areas with '
               'their numbers; yellow: customers (hover for kind and destinations). Numbers in the voice tables '
               'are %s files.</p>' % VOICE_AFS]
    show = link or str
    for e in stop_list:
        if e["game_no"] < 2:
            gallery.append("<h2>%s stop voices</h2><table>" % ("Arcade", "Original")[e["game_no"]])
            gallery.extend("<tr><td>stop %d</td><td>%s</td></tr>" % (s["index"], "generic" if not s["voices"] else
                           " ".join(show(v) for v in s["voices"])) for s in e["stops"])
            gallery.append("</table>")
    gallery.append("<h2>Generic destination voices</h2><table>%s</table>" % "".join(
        "<tr><td>row %d</td><td>%s</td></tr>" % (r, " ".join(show(v) for v in row)) for r, row in enumerate(generic)))
    gallery.append("<h2>Replies (channel 1)</h2><table>%s</table>" % "".join(
        "<tr><td>group %d variant %d</td><td>%s</td><td>frame %d</td></tr>"
        % (r["group"], r["variant"], show(r["voice"]), r["start_frame"]) for r in replies))
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".customers-", dir=output.parent))
    try:
        for s in sets:
            key = s["stops"]
            stops = stop_sets.get((key["game_no"], key["mini_game_no"]), []) if key else []
            used = sum(c["kind"] >= 0 for c in s["customers"])
            gallery.append("<h2>%s</h2><p>%d customers, %d stops, table 0x%08X</p>%s"
                           % (html.escape(s["name"]), used, len(stops), s["table"], svg_map(stops, s["customers"])))
        blob = (json.dumps(manifest, indent=1) + "\n").encode()
        (staging / "manifest.json").write_bytes(blob)
        page = ("\n".join(gallery) + "\n").encode()
        (staging / "index.html").write_bytes(page)
        manifest["files"] = [dict(path=p, size=len(b), sha256=digest(b)) for p, b in
                             (("index.html", page),)]
        (staging / "manifest.json").write_bytes((json.dumps(manifest, indent=1) + "\n").encode())
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    parser.add_argument("--courses", type=Path, help="extract_courses.py output, for the line-index check")
    parser.add_argument("--audio", type=Path, help="extract_audio.py output, to link the voice WAVs")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output, args.courses, args.audio)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Wrote %d customer tables (%d customers, %d destinations) and %d stop sets into %s"
          % (len(manifest["customer_sets"]), manifest["checks"]["customers"], manifest["checks"]["destinations"],
             len(manifest["stop_sets"]), args.output))


if __name__ == "__main__":
    main()
