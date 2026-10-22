#!/usr/bin/env python3
"""Convert Crazy Taxi's course lines (SPLDC1-3) into glTF line views and runtime JSON.

SPLDCn.BIN is loaded whole at one address for the run's city (CourseMode 0 Arcade, 1 Original,
2 Crazy Box) and holds only points. Everything else is in the executable:

* A directory of three (table, count) pairs, one per CourseMode (the CourseTableSet accessor).
* A course table of 12-byte records: a pointer to the points (x, y, z floats), a pointer to the
  point count (the 32-bit word right after the points) and a pointer to a 12-byte info record.
  A few Original courses keep their points in the executable, with their counts in a separate
  executable array.
* Info: six halfwords. Word 0 is flags; its low nibble indexes the speed table (code reads
  it through `@(8, record)`, then `& 15`). Halfword 1 is kept raw (bit 3
  is set when halfword 3 is non-zero). Halfwords 2-5 are course numbers, named here from the
  geometry they agree with: next (its start lies past this course's end), branch (a second
  next), previous (its end lies before this start) and neighbour (the parallel lane, ~40-50 away).
* A stage table of 12-byte entries (flag, first course, course count) indexed by
  Game_No + MiniGame_No: the courses each run searches (getNearLineIndexAll); the role "stage".
  Course 0 is the city's main line (the car's nearest point on it drives the Arcade
  visibility lists); courses in no run's range are "other" (the decomp's engine notes put the Arcade
  cable-car lines at 288/289).

Everything is found by shape and checked against the files; no regional addresses are used.
Positions are world coordinates, the same space as extract_models.py's BINCn.glb.
Stdlib only; no upstream imports.
"""
import argparse
import html
import json
import math
from pathlib import Path
import shutil
import statistics
import struct
import tempfile

try:
    from tools.extract_models import Gltf, digest
    from tools.extract_characters import LOAD, words
    from tools.extract_collision import f32
except ImportError:  # run as a script from the tools directory
    from extract_models import Gltf, digest
    from extract_characters import LOAD, words
    from extract_collision import f32

RECORD = 12
INFO = 12
CITIES = ("Arcade", "Original", "Crazy Box")
NAMES = ("arcade", "original", "crazy_box")
MAX_COURSES = 4096
MAX_POINTS = 1 << 16
SECTOR = 2048
ROLE_COLOURS = dict(line=[1.0, 1.0, 1.0, 1.0], other=[0.2, 0.9, 1.0, 1.0])
SPEED_COLOURS = [[0.4, 0.4, 1.0, 1.0], [0.3, 0.8, 0.3, 1.0], [0.9, 0.9, 0.2, 1.0], [1.0, 0.6, 0.1, 1.0],
                 [1.0, 0.25, 0.25, 1.0], [1.0, 0.3, 0.9, 1.0], [0.7, 0.5, 1.0, 1.0], [0.6, 0.6, 0.6, 1.0]]


class Memory:
    """The executable at LOAD and one SPLDC file at `base`."""

    def __init__(self, executable, data, base):
        self.executable, self.data, self.base = executable, data, base

    def where(self, address, size):
        for blob, start in ((self.data, self.base), (self.executable, LOAD)):
            if start is not None and start <= address and address + size <= start + len(blob) and address % 4 == 0:
                return blob, address - start
        return None

    def word(self, address):
        hit = self.where(address, 4)
        return None if hit is None else struct.unpack_from("<I", *hit)[0]

    def in_file(self, address, size):
        return self.base <= address and address + size <= self.base + len(self.data)


def read_course(memory, address):
    """The course record at `address` as a dict, or None when it does not hold together."""
    p, c, info = (memory.word(address + 4 * k) for k in range(3))
    if None in (p, c, info):
        return None
    count = memory.word(c)
    if count is None or not 0 < count <= MAX_POINTS:
        return None
    if memory.in_file(p, RECORD * count) and c - p != RECORD * count:  # in the file the count follows the points
        return None
    hit = memory.where(p, RECORD * count)
    if hit is None or not (LOAD <= info and info + INFO <= LOAD + len(memory.executable)) or info % 2:
        return None
    values = struct.unpack_from("<%df" % (3 * count), *hit)
    if not all(math.isfinite(v) and abs(v) < 1e6 for v in values):
        return None
    points = [list(values[3 * k:3 * k + 3]) for k in range(count)]
    return dict(record=address, points_address=p, count_address=c, info_address=info, points=points,
                info=list(struct.unpack_from("<6h", memory.executable, info - LOAD)))


def table_bases(executable, data, table, count):
    """Sector-aligned load addresses of `data` for which all `count` records at `table` read back."""
    w = words(executable)
    first = (table - LOAD) // 4
    if first < 0 or first + 3 * count > len(w):
        return []
    in_exe = lambda a: LOAD <= a < LOAD + len(executable)
    probe = next((w[first + 3 * k + 1] for k in range(count) if not in_exe(w[first + 3 * k + 1])), None)
    if probe is None:
        return []
    found = []
    for base in range((probe - len(data)) // SECTOR * SECTOR, probe + 1, SECTOR):
        if base < 0:
            continue
        memory = Memory(executable, data, base)
        if all(read_course(memory, table + RECORD * k) for k in range(count)):
            found.append(base)
    return found


def find_directory(executable, files):
    """(directory address, [(table, count)], base): the three (table, count) pairs whose tables read
    every record against SPLDC1-3 loaded at one shared address."""
    w = words(executable)
    hits = []
    for i in range(len(w) - 6):
        pairs = [(w[i + 2 * k], w[i + 2 * k + 1]) for k in range(3)]
        if not all(LOAD <= t < LOAD + len(executable) and t % 4 == 0 and 0 < n <= MAX_COURSES for t, n in pairs):
            continue
        bases = None
        for f, (t, n) in enumerate(pairs):
            found = set(table_bases(executable, files[f], t, n))
            bases = found if bases is None else bases & found
            if not bases:
                break
        if bases:
            hits.append((LOAD + 4 * i, pairs, sorted(bases)))
    if len(hits) != 1 or len(hits[0][2]) != 1:
        raise ValueError("course directory not found uniquely (%d candidates)" % len(hits))
    address, pairs, (base,) = hits[0]
    return address, pairs, base


def find_stage_table(executable, counts):
    """(address, entries): the run of 12-byte (flag, first, count) entries for Game_No + MiniGame_No,
    entries 0 and 1 within the Arcade and Original tables, then the longest run within Crazy Box's."""
    w = words(executable)
    ok = lambda i, n: w[i] in (0, 1) and w[i + 2] > 0 and w[i + 1] + w[i + 2] <= n
    literals = set(w)
    hits = []
    for i in range(len(w) - 9):
        if not (ok(i, counts[0]) and ok(i + 3, counts[1])):
            continue
        games = 0
        while i + 3 * (2 + games) + 2 < len(w) and ok(i + 3 * (2 + games), counts[2]):
            games += 1
        if games and LOAD + 4 * i in literals:
            hits.append((LOAD + 4 * i, [tuple(w[i + 3 * k:i + 3 * k + 3]) for k in range(2 + games)]))
    # short runs of small triples are common; the table is the one with by far the most mini games
    hits.sort(key=lambda h: len(h[1]))
    if not hits or len(hits[-1][1]) < 4 or (len(hits) > 1 and len(hits[-2][1]) == len(hits[-1][1])):
        raise ValueError("stage course table not found uniquely (%d candidates)" % len(hits))
    return hits[-1]


def find_speed_table(executable, used):
    """(address, speeds): the float table that code indexes with `(info word & 15) << 2`
    (and #15,r0; shll2 r0; fmov.s @(r0,Rm),FRn with Rm loaded by a pc-relative mov.l)."""
    half = struct.unpack_from("<%dH" % (len(executable) // 2), executable)
    found = {}
    for k in range(len(half) - 2):
        if half[k] != 0xC90F or half[k + 1] != 0x4008 or half[k + 2] & 0xF00F != 0xF006:
            continue
        m = (half[k + 2] >> 4) & 15
        for j in range(k - 1, max(k - 24, -1), -1):
            if half[j] >> 12 == 0xD and (half[j] >> 8) & 15 == m:
                pc = LOAD + 2 * j
                literal = (pc & ~3) + 4 + 4 * (half[j] & 0xFF)
                if LOAD <= literal < LOAD + len(executable):
                    value = struct.unpack_from("<I", executable, literal - LOAD)[0]
                    found[value] = found.get(value, 0) + 1
                break
    tables = [a for a in found if LOAD <= a < LOAD + len(executable)]
    if len(tables) != 1:
        raise ValueError("speed table not found uniquely (%d candidates)" % len(tables))
    address = tables[0]
    speeds = []
    while len(speeds) < 16:
        v, = struct.unpack_from("<f", executable, address - LOAD + 4 * len(speeds))
        if not (math.isfinite(v) and 1e-3 < v < 1e3):
            break
        speeds.append(f32(v))
    if not speeds or max(used) >= len(speeds):
        raise ValueError("speed table shorter than the indices used")
    return dict(address=address, references=found[address], speeds=speeds)


def unreferenced(data, base, courses):
    covered = bytearray(len(data))
    for c in courses:
        if c["in_file"]:
            covered[c["points_address"] - base:c["count_address"] + 4 - base] = b"\1" * (c["count_address"] + 4
                                                                                          - c["points_address"])
    gaps, k = [], 0
    while k < len(data):
        if covered[k]:
            k += 1
            continue
        j = k
        while j < len(data) and not covered[j]:
            j += 1
        gaps.append(dict(offset=k, size=j - k))
        k = j
    return gaps


def link_stats(courses, first, count):
    """Median and largest gaps that justify the link names, over a run's stage courses."""
    out = {}
    tests = dict(next=(2, -1, 0), branch=(3, -1, 0), previous=(4, 0, -1))
    span = courses[first:first + count]
    for name, (field, mine, theirs) in tests.items():
        gaps = [math.dist(c["points"][mine], courses[c["info"][field]]["points"][theirs])
                for c in span if 0 < c["info"][field] < len(courses)]
        if gaps:
            out[name] = dict(links=len(gaps), median_gap=round(statistics.median(gaps), 2), max_gap=round(max(gaps), 2))
    gaps = []
    for c in span:
        n = c["info"][5]
        if 0 < n < len(courses):
            mid = c["points"][len(c["points"]) // 2]
            gaps.append(min(math.dist(mid, q) for q in courses[n]["points"]))
    if gaps:
        out["neighbour"] = dict(links=len(gaps), median_distance=round(statistics.median(gaps), 2),
                                max_distance=round(max(gaps), 2),
                                symmetric=sum(1 for c in span if 0 < c["info"][5] < len(courses)
                                              and courses[c["info"][5]]["info"][5] == c["index"]))
    return out


class Builder(Gltf):
    def __init__(self):
        Gltf.__init__(self, None, None, "")
        self.doc["asset"]["generator"] = "CrazyTaxi tools/extract_courses.py"
        self.doc["scenes"] = []
        self.colours = {}

    def colour(self, name, rgba):
        if name not in self.colours:
            self.doc["materials"].append(dict(name=name, pbrMetallicRoughness=dict(
                baseColorFactor=rgba, metallicFactor=0.0, roughnessFactor=1.0)))
            self.colours[name] = len(self.doc["materials"]) - 1
        return self.colours[name]

    def line(self, course, material, extras):
        flat = [c for p in course["points"] for c in p]
        prim = dict(attributes=dict(POSITION=self.accessor(flat, 5126, 3, 34962, True)), material=material, mode=3)
        name = "course_%03d" % course["index"]
        self.doc["meshes"].append(dict(name=name, primitives=[prim]))
        self.doc["nodes"].append(dict(name=name, mesh=len(self.doc["meshes"]) - 1, extras=extras))
        return len(self.doc["nodes"]) - 1


def material_for(builder, course):
    if course["role"] == "stage":
        s = course["speed_index"]
        return builder.colour("stage_speed_%d" % s, SPEED_COLOURS[min(s, len(SPEED_COLOURS) - 1)])
    return builder.colour(course["role"], ROLE_COLOURS[course["role"]])


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    files = [(source / ("SPLDC%d.BIN" % n)).read_bytes() for n in (1, 2, 3)]
    directory, tables, base = find_directory(executable, files)
    stage_address, stage = find_stage_table(executable, [n for _, n in tables])
    cities = []
    for f, (table, count) in enumerate(tables):
        memory = Memory(executable, files[f], base)
        courses = []
        for k in range(count):
            c = read_course(memory, table + RECORD * k)
            c["index"] = k
            c["in_file"] = memory.in_file(c["points_address"], RECORD * len(c["points"]))
            c["speed_index"] = c["info"][0] & 15
            courses.append(c)
        cities.append(courses)
    speed = find_speed_table(executable, [c["speed_index"] for courses in cities for c in courses])
    # runs: Game_No 0 Arcade, 1 Original, 2 Crazy Box + MiniGame_No
    runs = [dict(city=0, name="arcade", game=None, entry=0), dict(city=1, name="original", game=None, entry=1)]
    runs += [dict(city=2, name="crazy_box_game_%02d" % g, game=g, entry=2 + g) for g in range(len(stage) - 2)]
    for run in runs:
        flag, first, count = stage[run["entry"]]
        run.update(flag=flag, first=first, count=count)
    for f, courses in enumerate(cities):
        in_stage = set()
        for run in runs:
            if run["city"] == f:
                in_stage.update(range(run["first"], run["first"] + run["count"]))
        for c in courses:
            c["role"] = "line" if c["index"] == 0 else "stage" if c["index"] in in_stage else "other"
    manifest = dict(schema=1, load_address=base, directory=directory,
                    course_tables=[dict(city=CITIES[f], table=t, count=n) for f, (t, n) in enumerate(tables)],
                    stage_table=stage_address, speed_table=speed,
                    sources=dict([("1ST_READ.BIN", dict(size=len(executable), sha256=digest(executable)))]
                                 + [("SPLDC%d.BIN" % (n + 1), dict(size=len(d), sha256=digest(d)))
                                    for n, d in enumerate(files)]),
                    files=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi course lines</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
               '<h1>Local Crazy Taxi course lines</h1><p>World coordinates, the same space as models/BINCn.glb. '
               'Course 0 (the main line) is white, stage courses (traffic lanes) are coloured by speed index, '
               'other lines cyan. '
               'Each JSON file holds one city\'s courses with their links and each run\'s course range.</p><table>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".courses-", dir=output.parent))
    try:
        for f, courses in enumerate(cities):
            builder = Builder()
            nodes = {}
            for c in courses:
                extras = dict(index=c["index"], role=c["role"], flags=c["info"][0] & 0xFFFF, speed_index=c["speed_index"],
                              raw1=c["info"][1], next=c["info"][2], branch=c["info"][3], previous=c["info"][4],
                              neighbour=c["info"][5], points=len(c["points"]))
                nodes[c["index"]] = builder.line(c, material_for(builder, c), extras)
            city_runs = [r for r in runs if r["city"] == f]
            builder.doc["scenes"].append(dict(name="all", nodes=[nodes[k] for k in sorted(nodes)]))
            if f == 2:
                for run in city_runs:
                    builder.doc["scenes"].append(dict(name=run["name"], extras=dict(mini_game=run["game"]),
                                                      nodes=[nodes[k] for k in range(run["first"],
                                                                                     run["first"] + run["count"])]))
            data = dict(schema=1, city=CITIES[f], source="SPLDC%d.BIN" % (f + 1), load_address=base,
                        speeds=speed["speeds"],
                        runs=[dict(name=r["name"], mini_game=r["game"], flag=r["flag"], first=r["first"],
                                   count=r["count"]) for r in city_runs],
                        course_fields=["index", "role", "flags", "speed_index", "raw1", "next", "branch", "previous",
                                       "neighbour", "points"],
                        courses=[[c["index"], c["role"], c["info"][0] & 0xFFFF, c["speed_index"], c["info"][1]]
                                 + c["info"][2:6] + [[[f32(v) for v in p] for p in c["points"]]] for c in courses])
            relative_json = "%s.json" % NAMES[f]
            blob = (json.dumps(data, separators=(",", ":")) + "\n").encode()
            (staging / relative_json).write_bytes(blob)
            relative = "SPLDC%d.glb" % (f + 1)
            glb = builder.glb()
            (staging / relative).write_bytes(glb)
            roles = {}
            for c in courses:
                roles[c["role"]] = roles.get(c["role"], 0) + 1
            shared = {}
            for c in courses:
                shared.setdefault(c["points_address"], []).append(c["index"])
            manifest["files"].append(dict(
                file="SPLDC%d.BIN" % (f + 1), city=CITIES[f], glb=relative, glb_sha256=digest(glb), json=relative_json,
                json_sha256=digest(blob), courses=len(courses), points=sum(len(c["points"]) for c in courses),
                roles=roles, executable_courses=[c["index"] for c in courses if not c["in_file"]],
                shared_points=[v for v in shared.values() if len(v) > 1],
                unreferenced_bytes=unreferenced(files[f], base, courses),
                runs=[dict(name=r["name"], mini_game=r["game"], flag=r["flag"], first=r["first"], count=r["count"],
                           links=link_stats(courses, r["first"], r["count"])) for r in city_runs]))
            gallery.append('<tr><td>%s</td><td><a href="%s">%s</a></td><td><a href="%s">%s</a></td><td>%d courses, '
                           '%d points</td></tr>' % (html.escape(CITIES[f]), relative, relative, relative_json,
                                                    relative_json, len(courses),
                                                    sum(len(c["points"]) for c in courses)))
        gallery.append("</table>")
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
    print("Converted %d courses into %s" % (sum(f["courses"] for f in manifest["files"]), args.output))


if __name__ == "__main__":
    main()
