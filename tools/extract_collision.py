#!/usr/bin/env python3
"""Convert Crazy Taxi's course collision (COLDC1-3) into glTF views and runtime JSON grids.

COLDCn.BIN is loaded whole at a fixed address and keeps absolute pointers. The executable
picks, per run, a ground grid and a wall grid: a pointer to an array of cell pointers inside
the file plus a 32-byte grid header held in the executable (InitCollision / InitColliWall):

* Grid header: first cell x, z, last cell x, z (ints, in cells), cells per row, rows, the
  cell count, the cell size (float). A point's cell is floor(x / size) - x0, floor(z / size) - z0.
* Ground cell: +0x00 top, +0x04 bottom (floats), +0x08 a halfword (kept raw), +0x0A the
  surface count, +0x0C the surface pointers.
* Surface (0x4C bytes): the plane a, b, c, d (y = -(a*x + c*z + d) / b), +0x10 a radius
  around the first corner, four corners (x, y, z), +0x44 the kind, +0x48 the shape
  (3: a triangle of corners 1-3, the first edge untested; 4: a quad).
* Wall cell: halfword wall count, halfword pole count, then the pointers (walls first).
* Wall (32 bytes): the line a*x + b*z + d (a, b at +0, +4, d at +0x10), an end point x, z at
  +8, +0xC, top +0x14, bottom +0x18, length +0x1C; it runs from the end point to
  (x - length * b, z + length * a). Pole (32 bytes): centre x, z at +8, +0xC, radius +0x10,
  top +0x14, bottom +0x18.
* Surface kinds: a table of 28-byte entries in the executable: bounce (float), a debug RGB
  colour (3 floats) and a 12-byte name ("#road", "#hodou", ...).

Everything is found by shape and checked against cell geometry; no regional addresses are
used. Arcade (COLDC1) and Original (COLDC2) have one ground and one wall grid each; Crazy
Box (COLDC3) has a pair per mini game, chosen through two executable tables indexed by
MiniGame_No (a cell-pointer table followed by an index into a header table).

Positions are world coordinates, the same space as extract_models.py's BINCn.glb.
Stdlib only; no upstream imports.
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
    from tools.extract_models import Gltf, digest
    from tools.extract_characters import LOAD, words
except ImportError:  # run as a script from the tools directory
    from extract_models import Gltf, digest
    from extract_characters import LOAD, words

HEADER = 32
SURFACE = 0x4C
WALL = 32
KIND = 28
CITIES = ("Arcade", "Original", "Crazy Box")
RAM_END = 0x0D000000
MAX_CELL_ITEMS = 4096


def f32(value):
    """The shortest decimal that reads back as the same 32-bit float."""
    packed = struct.pack("<f", value)
    for digits in range(6, 10):
        text = float("%.*g" % (digits, value))
        if struct.pack("<f", text) == packed:
            return text
    return value


def read_header(executable, address):
    """The grid header at `address`, or None when the 32 bytes are not one."""
    offset = address - LOAD
    if offset < 0 or offset + HEADER > len(executable) or offset % 4:
        return None
    x0, z0, x1, z1, columns, rows, cells = struct.unpack_from("<7i", executable, offset)
    size, = struct.unpack_from("<f", executable, offset + 28)
    if not (x0 <= x1 and z0 <= z1 and columns == x1 - x0 + 1 and rows == z1 - z0 + 1
            and cells == columns * rows and 0 < cells <= 1 << 20 and math.isfinite(size) and 1.0 <= size <= 10000.0):
        return None
    return dict(address=address, x0=x0, z0=z0, x1=x1, z1=z1, columns=columns, rows=rows, cells=cells, size=size)


def find_headers(executable):
    return [h for h in (read_header(executable, LOAD + o) for o in range(0, len(executable) - HEADER + 1, 4)) if h]


def find_kinds(executable):
    """(address, [kind]): the longest run of 28-byte entries named "#..." (NUL-terminated)."""
    def entry(offset):
        if offset < 0 or offset + KIND > len(executable):
            return None
        name = executable[offset + 16:offset + KIND]
        if name[:1] != b"#" or b"\0" not in name:
            return None
        text = name[:name.index(b"\0")]
        if any(c < 0x20 or c > 0x7E for c in text):
            return None
        values = struct.unpack_from("<4f", executable, offset)
        if not all(math.isfinite(v) and 0.0 <= v <= 16.0 for v in values):
            return None
        return dict(name=text.decode().strip(), bounce=f32(values[0]), colour=[f32(v) for v in values[1:]])

    best = (0, [])
    for start in range(0, len(executable) - KIND + 1, 4):
        if executable[start + 16:start + 17] != b"#" or entry(start - KIND):
            continue
        run = []
        while True:
            e = entry(start + KIND * len(run))
            if not e:
                break
            run.append(e)
        if len(run) > len(best[1]):
            best = (start, run)
    if len(best[1]) < 4:
        raise ValueError("no surface kind table")
    return LOAD + best[0], best[1]


def cell_box(header, index, margin):
    cx = index % header["columns"] + header["x0"]
    cz = index // header["columns"] + header["z0"]
    s = header["size"]
    return cx * s - margin, cz * s - margin, (cx + 1) * s + margin, (cz + 1) * s + margin


def outside(box, xs, zs, radius=0.0):
    return max(xs) + radius < box[0] or min(xs) - radius > box[2] or max(zs) + radius < box[1] \
        or min(zs) - radius > box[3]


def cell_pointers(data, base, header, array):
    offset = array - base
    if offset < 0 or offset % 4 or offset + 4 * header["cells"] > len(data):
        raise ValueError("cell array outside the file")
    pointers = struct.unpack_from("<%dI" % header["cells"], data, offset)
    if not any(pointers):
        raise ValueError("empty grid")
    for p in pointers:
        if p and not (0 <= p - base < len(data) and p % 2 == 0):
            raise ValueError("cell pointer outside the file")
    return pointers


def read_surface(data, offset, kinds):
    if offset < 0 or offset + SURFACE > len(data) or offset % 4:
        raise ValueError("surface outside the file")
    values = struct.unpack_from("<17f", data, offset)
    kind, shape = struct.unpack_from("<2i", data, offset + 0x44)
    if not all(math.isfinite(v) for v in values) or not 0 <= kind < kinds or shape not in (3, 4) \
            or abs(values[1]) < 1e-6:
        raise ValueError("not a surface")
    return dict(offset=offset, plane=list(values[0:4]), radius=values[4],
                corners=[list(values[5 + 3 * k:8 + 3 * k]) for k in range(4)], kind=kind, shape=shape)


def parse_ground(data, base, header, array, kinds, cache=None):
    """{cells: [(index, top, bottom, raw, [surface offsets])], surfaces: {offset: surface}}."""
    pointers = cell_pointers(data, base, header, array)
    cache = {} if cache is None else cache
    cells, surfaces = [], {}
    for index, p in enumerate(pointers):
        if not p:
            continue
        o = p - base
        if o % 4 or o + 12 > len(data):
            raise ValueError("ground cell outside the file")
        top, bottom, raw, count = struct.unpack_from("<2fhh", data, o)
        if not (0 <= count <= MAX_CELL_ITEMS and o + 12 + 4 * count <= len(data)) \
                or not (math.isfinite(top) and math.isfinite(bottom)):
            raise ValueError("not a ground cell")
        box = cell_box(header, index, 1.0)
        refs = []
        for q in struct.unpack_from("<%dI" % count, data, o + 12):
            s = q - base
            if s not in cache:
                cache[s] = read_surface(data, s, kinds)
            surface = cache[s]
            if outside(box, [c[0] for c in surface["corners"]], [c[2] for c in surface["corners"]]):
                raise ValueError("surface outside its cell")
            heights = [c[1] for c in surface["corners"]]
            if max(heights) > top + 0.01 or min(heights) < bottom - 0.01:
                raise ValueError("surface outside its cell's height range")
            surfaces[s] = surface
            refs.append(s)
        cells.append((index, top, bottom, raw, refs))
    listed = set((c[0], s) for c in cells for s in c[4])
    for s, surface in surfaces.items():
        points = outline(surface)
        if not near(listed, header, s, sum(p[0] for p in points) / len(points), sum(p[2] for p in points) / len(points)):
            raise ValueError("surface missing from the cells around its centre")
    return dict(cells=cells, surfaces=surfaces)


def home(header, x, z):
    """The grid index of the cell holding (x, z), as GetCollision2D computes it."""
    cx = int(math.floor(x / header["size"])) - header["x0"]
    cz = int(math.floor(z / header["size"])) - header["z0"]
    return cz * header["columns"] + cx


def near(listed, header, item, x, z):
    """Is `item` filed in the cell holding (x, z) or one next to it? (The files were built with a little slack:
    one Arcade wall of 3,607 misses the cell under its middle but sits in the neighbour.)"""
    centre = home(header, x, z)
    return any((centre + dz * header["columns"] + dx, item) in listed for dz in (-1, 0, 1) for dx in (-1, 0, 1))


def wall_ends(w):
    a, b, x, z, d, top, bottom, length = w
    return (x, z), (x - length * b, z + length * a)


def parse_walls(data, base, header, array):
    """{cells: [(index, [wall offsets], [pole offsets])], walls: {offset: values}, poles: {offset: values},
    margin: furthest an item lies outside a cell holding it}."""
    pointers = cell_pointers(data, base, header, array)
    cells, walls, poles, margin = [], {}, {}, 0.0
    limit = header["size"]  # items are filed into every cell within reach, never a whole cell away
    for index, p in enumerate(pointers):
        if not p:
            continue
        o = p - base
        if o % 4 or o + 4 > len(data):
            raise ValueError("wall cell outside the file")
        nw, npole = struct.unpack_from("<2h", data, o)
        if not (0 <= nw <= MAX_CELL_ITEMS and 0 <= npole <= MAX_CELL_ITEMS and nw + npole
                and o + 4 + 4 * (nw + npole) <= len(data)):
            raise ValueError("not a wall cell")
        cx = index % header["columns"] + header["x0"]
        cz = index // header["columns"] + header["z0"]
        s = header["size"]
        refs = ([], [])
        for n, q in enumerate(struct.unpack_from("<%dI" % (nw + npole), data, o + 4)):
            w = q - base
            if w < 0 or w % 4 or w + WALL > len(data):
                raise ValueError("wall outside the file")
            if n < nw:
                values = struct.unpack_from("<8f", data, w)
                inert = values[0] == 0.0 and values[1] == 0.0 and values[7] == 0.0  # never pushes (along < 0 fails)
                if not all(math.isfinite(v) for v in values) or values[7] < 0 or values[5] < values[6] - 0.01 \
                        or not (inert or abs(math.hypot(values[0], values[1]) - 1.0) <= 1e-3):
                    raise ValueError("not a wall")
                walls[w] = values
                if inert:
                    refs[0].append(w)
                    continue
                ends = wall_ends(values)
                xs, zs, r = [e[0] for e in ends], [e[1] for e in ends], 0.0
            else:
                values = struct.unpack_from("<2I5f", data, w)
                if not all(math.isfinite(v) for v in values[2:]) or values[4] < 0 or values[5] < values[6] - 0.01:
                    raise ValueError("not a pole")
                xs, zs, r = [values[2]], [values[3]], values[4]
                poles[w] = values
            gap = max(cx * s - max(xs) - r, min(xs) - r - (cx + 1) * s, cz * s - max(zs) - r,
                      min(zs) - r - (cz + 1) * s, 0.0)
            if gap > limit:
                raise ValueError("wall outside its cell")
            margin = max(margin, gap)
            refs[0 if n < nw else 1].append(w)
        cells.append((index, refs[0], refs[1]))
    listed = set((c[0], w) for c in cells for w in c[1] + c[2])
    for w, v in walls.items():
        if v[7] and not near(listed, header, w, v[2] - 0.5 * v[7] * v[1], v[3] + 0.5 * v[7] * v[0]):
            raise ValueError("wall missing from the cells around its middle")
    for w, v in poles.items():
        if not near(listed, header, w, v[2], v[3]):
            raise ValueError("pole missing from the cells around its centre")
    return dict(cells=cells, walls=walls, poles=poles, margin=margin)


def find_grids(executable, files, headers, kinds):
    """(base, [(file index, "ground"|"walls", array, header, parsed)]): every executable word that, under
    one 64 KiB-aligned load address shared by all files, is a valid cell array for some header."""
    w = words(executable)
    biggest = max(len(d) for d in files)
    bases = sorted(set(v for v in w if not v & 0xFFFF and LOAD + len(executable) <= v and v + biggest <= RAM_END))
    best = None
    for base in bases:
        found = []
        for f, data in enumerate(files):
            cache = {}
            arrays = sorted(set(v for v in w if 0 <= v - base < len(data) and not (v - base) % 4))
            if not arrays:
                continue
            # run[i]: how many words from word i on could be cell pointers (0 or even, inside the file)
            file_words = words(data)
            run = [0] * (len(file_words) + 1)
            for i in range(len(file_words) - 1, -1, -1):
                v = file_words[i]
                run[i] = run[i + 1] + 1 if v == 0 or (0 <= v - base < len(data) and not v & 1) else 0
            for array in arrays:
                for header in headers:
                    if run[(array - base) // 4] < header["cells"]:
                        continue
                    try:
                        found.append((f, "ground", array, header, parse_ground(data, base, header, array, len(kinds),
                                                                                 cache)))
                        continue
                    except (ValueError, struct.error):
                        pass
                    try:
                        found.append((f, "walls", array, header, parse_walls(data, base, header, array)))
                    except (ValueError, struct.error):
                        pass
        if found and (best is None or len(found) > len(best[1])):
            best = (base, found)
        elif found and len(found) == len(best[1]):
            raise ValueError("two collision load addresses fit equally")
    if best is None:
        raise ValueError("no collision grids found")
    return best


def size_of(grid):
    parsed = grid[4]
    items = len(parsed["surfaces"]) if grid[1] == "ground" else len(parsed["walls"]) + len(parsed["poles"])
    return items, len(parsed["cells"]), grid[3]["cells"]


def largest(grids, f, kind):
    """A city's own grid: of the cell arrays that read as `kind` in file f, the one holding the most surfaces
    (or walls and poles), then the most cells. Smaller fits are stray words or parts of other grids."""
    items = sorted((g for g in grids if g[0] == f and g[1] == kind), key=size_of)
    if not items:
        raise ValueError("COLDC%d: no %s grid" % (f + 1, kind))
    if len(items) > 1 and size_of(items[-1]) == size_of(items[-2]):
        raise ValueError("COLDC%d: two %s grids fit equally" % (f + 1, kind))
    return items[-1]


def mini_game_tables(executable, grids, kind):
    """[(array, header)] per MiniGame_No from the executable's cell-pointer table and the index table after
    it; the header table base is the one address every game's index agrees on."""
    by_array = {}
    for g in grids:
        if g[0] == 2 and g[1] == kind:
            by_array.setdefault(g[2], []).append(g)
    w = words(executable)
    best = (0, 0)
    for i in range(len(w)):
        if w[i] in by_array and not (i and w[i - 1] in by_array):
            n = 1
            while i + n < len(w) and w[i + n] in by_array:
                n += 1
            if n > best[1]:
                best = (i, n)
    i, n = best
    if n < 2 or i + 2 * n > len(w):
        raise ValueError("no Crazy Box %s table" % kind)
    arrays, indices = w[i:i + n], [v - (1 << 32) if v & 0x80000000 else v for v in w[i + n:i + 2 * n]]
    bases = None
    for array, index in zip(arrays, indices):
        options = set(g[3]["address"] - HEADER * index for g in by_array[array])
        bases = options if bases is None else bases & options
    if not bases:
        raise ValueError("Crazy Box %s headers do not share one table" % kind)

    def pick(table):
        return [[g for g in by_array[array] if g[3]["address"] == table + HEADER * index][0]
                for array, index in zip(arrays, indices)]

    # several bases fit only when headers repeat; then the one giving the largest grids, as for the cities
    scored = sorted((tuple(map(sum, zip(*[size_of(g) for g in pick(t)]))), t) for t in bases)
    if len(scored) > 1 and scored[-1][0] == scored[-2][0]:
        raise ValueError("Crazy Box %s headers fit two tables equally" % kind)
    table = scored[-1][1]
    chosen = pick(table)
    return dict(cells_table=LOAD + 4 * i, index_table=LOAD + 4 * (i + n), header_table=table, games=chosen)


def facing(points, normal):
    """Triangles over the corner indices, wound so their face normal points along `normal`."""
    tris = [(0, 1, 2)] if len(points) == 3 else [(0, 1, 2), (0, 2, 3)]
    a, b, c = points[0], points[1], points[2]
    u = [b[k] - a[k] for k in range(3)]
    v = [c[k] - a[k] for k in range(3)]
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    if sum(n[k] * normal[k] for k in range(3)) < 0:
        tris = [(t[0], t[2], t[1]) for t in tris]
    return tris


def outline(surface):
    corners = surface["corners"]
    return corners[1:4] if surface["shape"] == 3 else corners


class Builder(Gltf):
    def __init__(self):
        Gltf.__init__(self, None, None, "")
        self.doc["asset"]["generator"] = "CrazyTaxi tools/extract_collision.py"
        self.doc["scenes"] = []
        self.colours = {}

    def colour(self, name, rgba):
        if name not in self.colours:
            self.doc["materials"].append(dict(name=name, doubleSided=True, pbrMetallicRoughness=dict(
                baseColorFactor=rgba, metallicFactor=0.0, roughnessFactor=1.0)))
            self.colours[name] = len(self.doc["materials"]) - 1
        return self.colours[name]

    def add(self, scene, name, material, positions, indices, extras):
        if not indices:
            return 0
        flat = [c for p in positions for c in p]
        prim = dict(attributes=dict(POSITION=self.accessor(flat, 5126, 3, 34962, True)), material=material,
                    indices=self.accessor(indices, 5123 if len(positions) < 65536 else 5125, 1, 34963))
        self.doc["meshes"].append(dict(name=name, primitives=[prim]))
        self.doc["nodes"].append(dict(name=name, mesh=len(self.doc["meshes"]) - 1, extras=extras))
        scene["nodes"].append(len(self.doc["nodes"]) - 1)
        return len(indices) // 3

    def grid(self, name, extras, ground, walls, kinds):
        scene = dict(name=name, nodes=[], extras=extras)
        self.doc["scenes"].append(scene)
        triangles = 0
        by_kind = {}
        for offset in sorted(ground["surfaces"]):
            by_kind.setdefault(ground["surfaces"][offset]["kind"], []).append(ground["surfaces"][offset])
        for kind in sorted(by_kind):
            positions, indices = [], []
            for s in by_kind[kind]:
                points = outline(s)
                indices.extend(len(positions) + k for t in facing(points, s["plane"][:3]) for k in t)
                positions.extend(points)
            info = kinds[kind]
            material = self.colour("kind%02d_%s" % (kind, info["name"].lstrip("#")), info["colour"] + [1.0])
            triangles += self.add(scene, "%s_ground_%02d_%s" % (name, kind, info["name"].lstrip("#")), material,
                                  positions, indices, dict(kind=kind, name=info["name"], surfaces=len(by_kind[kind])))
        positions, indices = [], []
        for offset in sorted(walls["walls"]):
            v = walls["walls"][offset]
            if not v[7]:  # inert: never pushes, nothing to draw
                continue
            (x0, z0), (x1, z1) = wall_ends(v)
            top, bottom = v[5], v[6]
            first = len(positions)
            positions.extend([[x0, bottom, z0], [x1, bottom, z1], [x1, top, z1], [x0, top, z0]])
            indices.extend(first + k for k in (0, 1, 2, 0, 2, 3))
        triangles += self.add(scene, "%s_walls" % name, self.colour("wall", [1.0, 0.25, 0.25, 0.6]), positions,
                              indices, dict(walls=sum(1 for v in walls["walls"].values() if v[7])))
        positions, indices = [], []
        for offset in sorted(walls["poles"]):
            v = walls["poles"][offset]
            x, z, r, top, bottom = v[2:7]
            first = len(positions)
            for k in range(8):
                a = k * math.pi / 4
                positions.extend([[x + r * math.cos(a), bottom, z + r * math.sin(a)],
                                  [x + r * math.cos(a), top, z + r * math.sin(a)]])
            for k in range(8):
                p, q = first + 2 * k, first + 2 * ((k + 1) % 8)
                indices.extend([p, q + 1, q, p, p + 1, q + 1])
        triangles += self.add(scene, "%s_poles" % name, self.colour("pole", [1.0, 0.6, 0.1, 1.0]), positions,
                              indices, dict(poles=len(walls["poles"])))
        return triangles


def runtime(header, ground, walls, wall_header):
    """The grids in the form GetCollision2D / CheckColliWall walk them, with list indices for pointers."""
    surface_ids = dict((o, n) for n, o in enumerate(sorted(ground["surfaces"])))
    wall_ids = dict((o, n) for n, o in enumerate(sorted(walls["walls"])))
    pole_ids = dict((o, n) for n, o in enumerate(sorted(walls["poles"])))

    def head(h):
        return dict((k, h[k]) for k in ("x0", "z0", "x1", "z1", "columns", "rows", "cells", "size"))

    return dict(
        ground=dict(header=head(header),
                    surface_fields=["a", "b", "c", "d", "radius", "corners[4][3]", "kind", "shape"],
                    surfaces=[[f32(v) for v in s["plane"]] + [f32(s["radius"])]
                              + [[f32(v) for v in c] for c in s["corners"]] + [s["kind"], s["shape"]]
                              for s in (ground["surfaces"][o] for o in sorted(ground["surfaces"]))],
                    cell_fields=["index", "top", "bottom", "raw_halfword", "surfaces"],
                    cells=[[i, f32(t), f32(b), r, [surface_ids[o] for o in refs]]
                           for i, t, b, r, refs in ground["cells"]]),
        walls=dict(header=head(wall_header),
                   wall_fields=["a", "b", "end_x", "end_z", "d", "top", "bottom", "length"],
                   walls=[[f32(v) for v in walls["walls"][o]] for o in sorted(walls["walls"])],
                   pole_fields=["x", "z", "radius", "top", "bottom"],
                   poles=[[f32(v) for v in walls["poles"][o][2:7]] for o in sorted(walls["poles"])],
                   cell_fields=["index", "walls", "poles"],
                   cells=[[i, [wall_ids[o] for o in a], [pole_ids[o] for o in b]] for i, a, b in walls["cells"]]))


def stats(ground, walls):
    residual = 0.0
    for s in ground["surfaces"].values():
        a, b, c, d = s["plane"]
        for x, y, z in outline(s):
            residual = max(residual, abs(-(a * x + c * z + d) / b - y))
    kinds = {}
    for s in ground["surfaces"].values():
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    return dict(ground_cells=len(ground["cells"]), surfaces=len(ground["surfaces"]),
                surface_kinds=dict((str(k), n) for k, n in sorted(kinds.items())),
                max_corner_height_error=round(residual, 4), wall_cells=len(walls["cells"]),
                walls=len(walls["walls"]), inert_walls=sum(1 for v in walls["walls"].values() if not v[7]),
                poles=len(walls["poles"]), wall_cell_margin=round(walls["margin"], 3))


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    files = [(source / ("COLDC%d.BIN" % n)).read_bytes() for n in (1, 2, 3)]
    kind_table, kinds = find_kinds(executable)
    headers = find_headers(executable)
    base, grids = find_grids(executable, files, headers, kinds)
    runs = []
    for f in (0, 1):
        runs.append(dict(file=f, name=CITIES[f].lower(), games=None,
                         ground=largest(grids, f, "ground"), walls=largest(grids, f, "walls")))
    ground_tables = mini_game_tables(executable, grids, "ground")
    wall_tables = mini_game_tables(executable, grids, "walls")
    if len(ground_tables["games"]) != len(wall_tables["games"]):
        raise ValueError("Crazy Box ground and wall tables differ in length")
    pairs = {}
    for game, (g, w) in enumerate(zip(ground_tables["games"], wall_tables["games"])):
        pairs.setdefault((g[2], g[3]["address"], w[2], w[3]["address"]), dict(ground=g, walls=w, games=[]))
        pairs[(g[2], g[3]["address"], w[2], w[3]["address"])]["games"].append(game)
    for key in sorted(pairs, key=lambda k: pairs[k]["games"][0]):
        p = pairs[key]
        runs.append(dict(file=2, name="crazy_box_game_" + "_".join("%02d" % g for g in p["games"]), games=p["games"],
                         ground=p["ground"], walls=p["walls"]))
    manifest = dict(schema=1, load_address=base, kind_table=kind_table, kinds=kinds,
                    crazy_box_tables=dict((k, dict((n, t[n]) for n in ("cells_table", "index_table", "header_table")))
                                          for k, t in (("ground", ground_tables), ("walls", wall_tables))),
                    sources=dict([("1ST_READ.BIN", dict(size=len(executable), sha256=digest(executable)))]
                                 + [("COLDC%d.BIN" % (n + 1), dict(size=len(d), sha256=digest(d)))
                                    for n, d in enumerate(files)]),
                    files=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi collision</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
               '<h1>Local Crazy Taxi course collision</h1><p>World coordinates, the same space as models/BINCn.glb. '
               'Ground surfaces are coloured with the game\'s own debug colour per kind; walls are red, poles orange. '
               'Each JSON file holds one run\'s ground and wall grids as the game walks them.</p><table>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".collision-", dir=output.parent))
    try:
        for f in (0, 1, 2):
            builder = Builder()
            entries, triangles = [], 0
            for run in [r for r in runs if r["file"] == f]:
                g, w = run["ground"], run["walls"]
                info = dict(ground_cells_pointer=g[2], ground_header=g[3]["address"], walls_cells_pointer=w[2],
                            walls_header=w[3]["address"])
                if run["games"] is not None:
                    info["mini_games"] = run["games"]
                triangles += builder.grid(run["name"], info, g[4], w[4], kinds)
                data = runtime(g[3], g[4], w[4], w[3])
                data = dict(dict(schema=1, run=run["name"], city=CITIES[f], source="COLDC%d.BIN" % (f + 1)), **data)
                relative = "%s.json" % run["name"]
                blob = (json.dumps(data, separators=(",", ":")) + "\n").encode()
                (staging / relative).write_bytes(blob)
                entries.append(dict(info, run=run["name"], json=relative, json_sha256=digest(blob),
                                    **stats(g[4], w[4])))
                gallery.append('<tr><td>%s</td><td><a href="%s">%s</a></td><td>%d surfaces</td><td>%d walls</td>'
                               '<td>%d poles</td></tr>' % (html.escape(CITIES[f]), relative, relative,
                                                           len(g[4]["surfaces"]), len(w[4]["walls"]),
                                                           len(w[4]["poles"])))
            relative = "COLDC%d.glb" % (f + 1)
            blob = builder.glb()
            (staging / relative).write_bytes(blob)
            manifest["files"].append(dict(file="COLDC%d.BIN" % (f + 1), city=CITIES[f], glb=relative,
                                          glb_sha256=digest(blob), triangles=triangles, runs=entries))
            gallery.append('<tr><td>%s</td><td><a href="%s">%s</a></td><td colspan=3>%d triangles, one scene per '
                           'run</td></tr>' % (html.escape(CITIES[f]), relative, relative, triangles))
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
    print("Converted collision for %d runs into %s" % (sum(len(f["runs"]) for f in manifest["files"]), args.output))


if __name__ == "__main__":
    main()
