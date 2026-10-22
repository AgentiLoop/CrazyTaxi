#!/usr/bin/env python3
"""Extract the replay cut tables: the car start states, cameras and passengers behind REC*.BIN.

The recorded drives (extract_replays.py) only hold inputs. The USA executable (1ST_READ.BIN) holds
the rest, read the way the game reads it:

* setReplayType (USA 0x0C04ADF8) sets the frame limit 5400 and, by the city mode (0x0C1EBF2C),
  points 0x0C2A3F68 at a car snapshot table (Arcade 0x0C0A3600, Original 0x0C0B1700) and
  0x0C2A3F6C at a point table (Arcade 0x0C0F2CF0, Original 0x0C0F2E88).
* replayChangeControl (USA 0x0C04B794) is called with type 1 or 2 by the advertise drive set-up
  (0x0C02B504: city mode 0 -> 1, else 2) and with 3 by the ending (0x0C02CB4A). Type 1 uses the cut
  table 0x0C0F18F0, type 2 0x0C0F1DF0, type 3 0x0C0F22F0 (Arcade) or 0x0C0F27F0 (Original); each
  has 40 rows of 32 bytes. Once the replay frame (0x0C1EC05C) reaches row +0x00 it applies the row
  and moves to the next, so the rows in use are those before the first frame >= 5400.
* A row (field names from the game's own debug printer, strings at 0x0C0C2218-0x0C0C22B4):
    +0x00 frame ("frameNo")             +0x04 camera only ("camChgOnly"; 1 = no car or passenger change)
    +0x08 snapshot ("startCarNo")       +0x0C camera style       +0x10 character
    +0x14 point / destination stop      +0x18, +0x1C passed on to EndPsg_Start (not traced)
* Snapshot n is 960 bytes at table + 960 n: word 0 "carType" and the 956-byte player car block the
  row copies over Car_Data (USA 0x0C176E4C; position +0x78, velocity +0x0C, matrix +0xB4).
* The camera style goes to SetAdvCamera (USA 0x0C028F8E) with point +0x14 (0 -> camera mode 0,
  -1 -> style 0 and camera mode 6); ExecAdvCamera (0x0C028972) runs style 1 inline, 2 chase
  (0x0C028ABA), 3 random (0x0C028BD0), 4 fixed (0x0C028F04).
* In the ending (0x0C1EBF54 != 0) a row with character >= 23 starts EndPsg_Start (USA 0x0C070F04)
  with (character, +0x14, +0x18, +0x1C); it hands +0x14 to Psg_Init (0x0C06A41E) as the passenger's
  destination stop (+0x140), so +0x14 is also the stop whose landmark name the tool shows.

The tool refuses to run unless the pool words, instructions and debug strings above are the
ones in the USA executable (POOL, CODE, STRINGS). Checks: each advertise table's row frames must
equal the frames where extract_replays.py finds the random generator reseeded; every used
snapshot must be non-empty with an orthonormal matrix and +0x00 == +0x78; every point index must
be inside its table and every ending stop inside its city's landmark names. With --customers
(extract_customers.py output) every point n below the city's stop count must lie within stop n's
area radius (the point table is per destination stop; the game's recorder fills entry n from
getReplayPassenger with the passenger's spot). Positions are world
coordinates (the space of models/BINCn.glb). Stdlib only; no upstream imports.
"""
import argparse
import html
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_customers import Executable, landmark_names
    from tools.extract_replays import FILES, ROLES, parse, rng_sync
    from tools.extract_models import digest
except ImportError:  # run as a script from the tools directory
    from extract_customers import Executable, landmark_names
    from extract_replays import FILES, ROLES, parse, rng_sync
    from extract_models import digest

LOAD = 0x0C010000
FRAME_LIMIT = 5400
ROWS, ROW = 40, 32
SNAPSHOTS, SNAPSHOT, CAR_DATA = 60, 960, 956
POINTS = 34  # the Arcade point table runs up to the Original one
CAR_POSITION, CAR_VELOCITY, CAR_MATRIX = 0x78, 0x0C, 0xB4
FIRST_CHARACTER = 23
SNAPSHOT_TABLES = (0x0C0A3600, 0x0C0B1700)  # by city (Game_No 0 Arcade, 1 Original)
POINT_TABLES = (0x0C0F2CF0, 0x0C0F2E88)
# file (extract_replays.FILES order) -> (replay type, cut table)
CUT_TABLES = ((1, 0x0C0F18F0), (2, 0x0C0F1DF0), (3, 0x0C0F22F0), (3, 0x0C0F27F0))
CAMERA_STYLES = {0: "camera mode 0", -1: "camera mode 6", 1: "ExecAdvCamera inline", 2: "ExecAdvCameraChase",
                 3: "ExecAdvCameraRandom", 4: "ExecAdvCameraFixed"}
POOL = {  # setReplayType
        0x0C04AE64: 0x0C0F18D8, 0x0C04AE6C: 0x0C2A3F68, 0x0C04AE70: 0x0C2A3F6C, 0x0C04AE74: 0x0C1EBF2C,
        0x0C04AE78: SNAPSHOT_TABLES[0], 0x0C04AE7C: POINT_TABLES[0], 0x0C04AE80: SNAPSHOT_TABLES[1],
        0x0C04AE84: POINT_TABLES[1],
        # replayChangeControl: cut tables, city mode, snapshot pointer, frame, car copy, camera, ending
        0x0C04B8B4: CUT_TABLES[0][1], 0x0C04B8B8: CUT_TABLES[1][1], 0x0C04B8BC: 0x0C1EBF2C,
        0x0C04B8C0: CUT_TABLES[2][1], 0x0C04B8C4: CUT_TABLES[3][1], 0x0C04B98C: 0x0C2A3F68,
        0x0C04BA98: 0x0C1EC05C, 0x0C04BBE8: 0x0C176E4C, 0x0C04BBEC: 0x0C080A2C, 0x0C04BBF8: 0x0C028F8E,
        0x0C04BC00: 0x0C2A3F6C, 0x0C04BC08: 0x0C1EBF54, 0x0C04BC0C: 0x0C070F04,
        # debug printer strings
        0x0C04C244: 0x0C0C222C, 0x0C04C248: 0x0C0C2240,
        # callers: advertise (type by city mode) and ending
        0x0C02B570: 0x0C04B794, 0x0C02B578: 0x0C1EBF2C, 0x0C02CBB4: 0x0C04B794,
        # SetAdvCamera / ExecAdvCamera style word; EndPsg_Start -> Psg_Init
        0x0C0290D4: 0x0C0E3C38, 0x0C028A30: 0x0C0E3C38, 0x0C071014: 0x0C06A41E}
HALFWORDS = {0x0C04AE3C: FRAME_LIMIT, 0x0C04B984: SNAPSHOT, 0x0C04BBDC: CAR_DATA}
CODE = {0x0C04AE28: 0x2532,  # setReplayType Arcade: snapshot table -> @0x0C2A3F68
        0x0C04AE2C: 0x2412,  #                       point table -> @0x0C2A3F6C
        0x0C04AE32: 0x2502,  # Original: snapshot table
        0x0C04AE34: 0x2432,  #           point table
        0x0C04B802: 0x8801, 0x0C04B80E: 0x8802, 0x0C04B81A: 0x8803,  # type 1 / 2 / 3
        0x0C04B82E: 0xE328,  # mov #40,r3           rows per table
        0x0C04BA2C: 0x62E2,  # mov.l @r14,r2        row +0x00 frame
        0x0C04BA30: 0x3323,  # cmp/ge r2,r3         replay frame >= row frame
        0x0C04BA3E: 0x50E1,  # mov.l @(4,r14),r0    row +0x04 camera only
        0x0C04BA40: 0x8801,  # cmp/eq #1,r0
        0x0C04BB0E: 0x52E2,  # mov.l @(8,r14),r2    row +0x08 snapshot
        0x0C04BB20: 0x7204,  # add #4,r2            skip carType, copy 956 bytes
        0x0C04BB48: 0x52E3,  # mov.l @(12,r14),r2   row +0x0C camera style
        0x0C04BB7A: 0x54E5,  # mov.l @(20,r14),r4   row +0x14 point
        0x0C04BB86: 0x55E3,  # mov.l @(12,r14),r5   SetAdvCamera(point, style)
        0x0C04BB8E: 0x52E4,  # mov.l @(16,r14),r2   row +0x10 character
        0x0C04BB90: 0xE317,  # mov #23,r3
        0x0C04BBA8: 0x55E5, 0x0C04BBAC: 0x57E7, 0x0C04BBAE: 0x56E6, 0x0C04BBB2: 0x54E4,  # EndPsg_Start args
        0x0C04C124: 0x5311,  # debug: camChgOnly = row +0x04
        0x0C04C13A: 0x5312,  # debug: startCarNo = row +0x08
        0x0C04C146: 0x6132,  # debug: carType = snapshot word 0
        0x0C02B508: 0xE401, 0x0C02B50A: 0xE402,  # advertise: type 1 (Arcade) / 2
        0x0C02CB4A: 0xE403,  # ending: type 3
        0x0C028F94: 0xE204, 0x0C028F9A: 0xE503,  # SetAdvCamera: style > 4 or < 0 -> 3
        0x0C028FA2: 0x2252,  # mov.l r5,@r2        style -> 0x0C0E3C38
        0x0C028976: 0x8801, 0x0C02897A: 0x8802, 0x0C02897E: 0x8803, 0x0C028982: 0x8804,
        0x0C02898E: 0xA094, 0x0C028992: 0xA11D, 0x0C028996: 0xA2B5,  # bra chase / random / fixed
        0x0C070F0C: 0x1F51,  # EndPsg_Start: save r5 (row +0x14)
        0x0C070F36: 0x65F2,  # r5 = character
        0x0C070F38: 0x56F1}  # r6 = row +0x14 -> Psg_Init param (passenger +0x140)
STRINGS = {0x0C0C2218: b"    changeNo.%d \n\0", 0x0C0C222C: b"  camChgOnly:%d \n\0",
           0x0C0C2240: b"  startCarNo:%d[carType:%d] \n\0", 0x0C0C2260: b"     frameNo:%d/%d(%d->%d) \n\0",
           0x0C0C22B4: b"  Car_Data[]_size->%d \n\0"}


def check_code(exe):
    for address, value in sorted(POOL.items()):
        if exe.word(address) != value:
            raise ValueError("pool word 0x%08X is 0x%X, expected 0x%X" % (address, exe.word(address), value))
    for address, value in sorted(HALFWORDS.items()):
        if exe.word(address, "<H") != value:
            raise ValueError("pool halfword 0x%08X is not %d" % (address, value))
    for address, op in sorted(CODE.items()):
        if exe.word(address, "<H") != op:
            raise ValueError("instruction at 0x%08X is not 0x%04X" % (address, op))
    for address, text in sorted(STRINGS.items()):
        if exe.data[address - LOAD:address - LOAD + len(text)] != text:
            raise ValueError("debug string at 0x%08X is not %r" % (address, text))


def read_rows(exe, table):
    """(rows in use, rows after them): rows apply in order until a frame reaches the limit."""
    rows = [list(struct.unpack_from("<8i", exe.data, table - LOAD + ROW * k)) for k in range(ROWS)]
    used = []
    for row in rows:
        if row[0] >= FRAME_LIMIT:
            break
        if used and row[0] <= used[-1][0]:
            raise ValueError("cut table 0x%08X: frame %d does not follow %d" % (table, row[0], used[-1][0]))
        used.append(row)
    if len(used) == ROWS:
        raise ValueError("cut table 0x%08X has no end row" % table)
    return used, len(rows) - len(used)


def read_snapshot(exe, table, index):
    if not 0 <= index < SNAPSHOTS:
        raise ValueError("snapshot %d outside table 0x%08X" % (index, table))
    at = table + SNAPSHOT * index
    car = exe.data[at + 4 - LOAD:at + 4 - LOAD + CAR_DATA]
    if not any(car):
        raise ValueError("snapshot %d of 0x%08X is empty" % (index, table))
    origin = struct.unpack_from("<3f", car, 0)
    position = struct.unpack_from("<3f", car, CAR_POSITION)
    matrix = list(struct.unpack_from("<16f", car, CAR_MATRIX))
    rows = [matrix[0:3], matrix[4:7], matrix[8:11]]
    error = max(abs(sum(rows[a][k] * rows[b][k] for k in range(3)) - (a == b)) for a in range(3) for b in range(3))
    if origin != position or error > 1e-3 or matrix[3::4] != [0.0, 0.0, 0.0, 1.0]:
        raise ValueError("snapshot %d of 0x%08X is not a car block" % (index, table))
    return dict(index=index, address=at, car_type=exe.word(at, "<i"), position=list(position),
                velocity=list(struct.unpack_from("<3f", car, CAR_VELOCITY)), matrix=matrix)


def read_point(exe, city, index):
    if not 0 <= index < POINTS:
        raise ValueError("point %d outside table 0x%08X" % (index, POINT_TABLES[city]))
    return [exe.word(POINT_TABLES[city] + 12 * index + 4 * k, "<f") for k in range(3)]


def check_points(points, customers, city):
    """Distance from point n to stop n's centre; raises if a point is outside its stop's radius."""
    stops = [s for s in customers["stop_sets"] if s["game_no"] == city and s["mini_game_no"] == 0]
    if len(stops) != 1:
        raise ValueError("customers manifest has no stop set for game %d" % city)
    result = []
    for stop in stops[0]["stops"]:
        n = stop["index"]
        distance = math.dist(points[n], stop["centre"])
        if distance > stop["radius"]:
            raise ValueError("point %d is %.0f from stop %d (radius %.0f)" % (n, distance, n, stop["radius"]))
        result.append(dict(stop=n, distance=round(distance, 3), radius=stop["radius"]))
    return result
def svg_map(cuts, size=420):
    """Top view of each cut's car (dot) and camera point (ring), labelled by row."""
    spots = [c["snapshot"]["position"] for c in cuts if c["snapshot"]]
    spots += [c["camera"]["point"] for c in cuts if c["camera"].get("point")]
    if not spots:
        return ""
    xs, zs = [p[0] for p in spots], [p[2] for p in spots]
    x0, z0 = min(xs), min(zs)
    scale = (size - 20) / max(max(xs) - x0, max(zs) - z0, 1)
    marks = []
    for cut in cuts:
        if cut["snapshot"]:
            x, _, z = cut["snapshot"]["position"]
            marks.append('<circle cx="%.1f" cy="%.1f" r="3" fill="#fc4"/><text x="%.1f" y="%.1f" fill="#aaa" '
                         'font-size="9">%d</text>' % (10 + (x - x0) * scale, 10 + (z - z0) * scale,
                                                      14 + (x - x0) * scale, 8 + (z - z0) * scale, cut["row"]))
        if cut["camera"].get("point"):
            x, _, z = cut["camera"]["point"]
            marks.append('<circle cx="%.1f" cy="%.1f" r="5" fill="none" stroke="#4af"/>'
                         % (10 + (x - x0) * scale, 10 + (z - z0) * scale))
    return '<svg width="%d" height="%d" style="background:#111">%s</svg>' % (size, size, "".join(marks))


def extract(source, output, customers=None):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    exe = Executable((source / "1ST_READ.BIN").read_bytes())
    check_code(exe)
    names, bases = landmark_names(exe)
    stop_counts = [bases[1] - bases[0], len(names) - bases[1]]
    if customers is not None:
        customers = json.loads((Path(customers) / "manifest.json").read_text())
    point_tables = []
    for city, city_name in enumerate(("Arcade", "Original")):
        points = [read_point(exe, city, n) for n in range(POINTS)]
        entry = dict(city=city_name, address=POINT_TABLES[city],
                     points=[dict(index=n, position=points[n],
                                  landmark=names[bases[city] + n] if n < stop_counts[city] else None)
                             for n in range(POINTS)])
        if customers is not None:
            entry["stop_check"] = check_points(points, customers, city)
        point_tables.append(entry)
    manifest = dict(schema=1, executable=dict(path="1ST_READ.BIN", sha256=digest(exe.data)),
                    frame_limit=FRAME_LIMIT, row_size=ROW, rows_per_table=ROWS,
                    snapshot=dict(size=SNAPSHOT, count=SNAPSHOTS, car_data=CAR_DATA, position=CAR_POSITION,
                                  velocity=CAR_VELOCITY, matrix=CAR_MATRIX),
                    snapshot_tables=dict(zip(("Arcade", "Original"), SNAPSHOT_TABLES)),
                    point_tables=point_tables, points_per_table=POINTS,
                    camera_styles={str(k): v for k, v in sorted(CAMERA_STYLES.items())}, files=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi replay cuts</title>',
            '<style>body{font-family:system-ui;background:#222;color:white}td,th{padding:2px 6px;'
            'text-align:left}</style><h1>Local Crazy Taxi replay cuts</h1><p>Each row restores a car '
            'snapshot (yellow dot) and sets a camera (blue ring: its point) at a frame of the recorded '
            'drive.</p>']
    for name, (kind, city_name), (replay_type, table) in zip(FILES, ROLES, CUT_TABLES):
        city = 0 if city_name == "Arcade" else 1
        columns = parse((source / name).read_bytes())
        gaps, reseeded = rng_sync(columns["random"])
        used, unused = read_rows(exe, table)
        frames = [row[0] for row in used]
        if kind == "advertise" and frames != reseeded:
            raise ValueError("%s: cut frames %s are not the reseed frames %s" % (name, frames, reseeded))
        cuts = []
        for number, row in enumerate(used):
            frame, camera_only, snapshot, style, character, point, extra_18, extra_1c = row
            end = frames[number + 1] if number + 1 < len(frames) else FRAME_LIMIT
            camera = dict(style=style, routine=CAMERA_STYLES.get(style, "ExecAdvCameraRandom"))
            if style not in (0, -1) and camera_only != 1:
                camera.update(point_index=point, point=read_point(exe, city, point))
            cut = dict(row=number, frame=frame, end_frame=end, camera_only=camera_only, camera=camera,
                       snapshot=None if camera_only == 1 else read_snapshot(exe, SNAPSHOT_TABLES[city], snapshot),
                       character=character, extra_18=extra_18, extra_1c=extra_1c,
                       random_frames_in_sync=sum(1 for g in gaps[frame:end] if g is not None))
            if kind == "ending" and camera_only != 1 and character >= FIRST_CHARACTER:
                if not 0 <= point < stop_counts[city]:
                    raise ValueError("%s row %d: stop %d outside %s" % (name, number, point, city_name))
                cut["passenger"] = dict(character=character, destination_stop=point,
                                        landmark=names[bases[city] + point], end_psg_args=[extra_18, extra_1c])
            cuts.append(cut)
        manifest["files"].append(dict(source=name, kind=kind, city=city_name, replay_type=replay_type,
                                      cut_table=table, rows_used=len(used), rows_unused=unused,
                                      reseed_frames=reseeded, cut_frames_are_reseed_frames=frames == reseeded,
                                      cuts=cuts))
        lines = []
        for cut in cuts:
            snap = cut["snapshot"]
            passenger = cut.get("passenger")
            lines.append("<tr><td>%d</td><td>%d-%d</td><td>%s</td><td>%s</td><td>%s</td><td>%d</td></tr>" % (
                cut["row"], cut["frame"], cut["end_frame"] - 1,
                "%d (type %d) %s" % (snap["index"], snap["car_type"], ", ".join("%.0f" % v for v in snap["position"]))
                if snap else "camera only", html.escape(cut["camera"]["routine"]),
                html.escape("%d %s (stop %d)" % (passenger["character"], passenger["landmark"],
                                                passenger["destination_stop"])) if passenger else "",
                cut["random_frames_in_sync"]))
        page.append("<h2>%s (%s, %s, type %d)</h2><p>%d rows from 0x%08X; random generator reseeded at %d "
                    "frames.</p><table><tr><th>row</th><th>frames</th><th>snapshot</th><th>camera</th>"
                    "<th>passenger</th><th>frames in sync</th></tr>%s</table>%s"
                    % (html.escape(name), kind, city_name, replay_type, len(used), table, len(reseeded),
                       "".join(lines), svg_map(cuts)))
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".replay-cuts-", dir=output.parent))
    try:
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
    parser.add_argument("--customers", type=Path, help="extract_customers.py output: check points against stops")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output, args.customers)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Decoded %d replay cut tables (%d cuts) into %s" % (
        len(manifest["files"]), sum(f["rows_used"] for f in manifest["files"]), args.output))


if __name__ == "__main__":
    main()
