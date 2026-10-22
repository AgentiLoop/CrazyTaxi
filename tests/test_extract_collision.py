"""Synthetic collision fixtures: no game files or upstream modules required."""
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_collision as ec

LOAD = ec.LOAD
BASE = 0x0CB40000
KINDS = [("#road", 0.0, (1.0, 1.0, 1.0)), ("#kabe", 1.0, (0.5, 0.5, 0.5)), ("#slope", 0.0, (1.0, 1.0, 0.5)),
         ("#grass", 0.0, (0.0, 1.0, 0.0))]


def surface(corners, kind=0, shape=4):
    """A flat surface at the first corner's height (a plane y = h: 0, 1, 0, -h)."""
    h = corners[0][1]
    radius = max(math.hypot(c[0] - corners[0][0], c[2] - corners[0][2]) for c in corners) + 1.0
    return struct.pack("<5f12f2i", 0.0, 1.0, 0.0, -h, radius, *[v for c in corners for v in c], kind, shape)


def square(x, z, size, y=0.0, kind=0):
    return surface([(x, y, z), (x, y, z + size), (x + size, y, z + size), (x + size, y, z)], kind)


def wall(x0, z0, x1, z1, top=50.0, bottom=0.0):
    length = math.hypot(x1 - x0, z1 - z0)
    a, b = (z1 - z0) / length, -(x1 - x0) / length
    return struct.pack("<8f", a, b, x0, z0, -(a * x0 + b * z0), top, bottom, length)


def pole(x, z, radius, top=50.0, bottom=0.0):
    return struct.pack("<2I5f", 0, 0, x, z, radius, top, bottom)


def header(x0, z0, x1, z1, size):
    columns, rows = x1 - x0 + 1, z1 - z0 + 1
    return struct.pack("<7if", x0, z0, x1, z1, columns, rows, columns * rows, size)


def cells_of(head):
    x0, z0, x1, z1, columns, rows, count, size = struct.unpack("<7if", head)
    for index in range(count):
        cx, cz = index % columns + x0, index // columns + z0
        yield index, (cx * size, cz * size, (cx + 1) * size, (cz + 1) * size), size


def build(grids):
    """grids: [("ground", header, [surface bytes]) | ("walls", header, [wall bytes], [pole bytes])] -> (file,
    [cell array address]). Surfaces are filed in every cell their outline box touches; walls and poles in every
    cell within half a cell of them."""
    data, arrays = bytearray(), []
    for grid in grids:
        if grid[0] == "ground":
            offsets = []
            for s in grid[2]:
                offsets.append(len(data))
                data += s
            cells = {}
            for index, box, size in cells_of(grid[1]):
                for o, s in zip(offsets, grid[2]):
                    corners = struct.unpack_from("<12f", s, 0x14)
                    xs, zs, ys = corners[0::3], corners[2::3], corners[1::3]
                    if max(xs) > box[0] and min(xs) < box[2] and max(zs) > box[1] and min(zs) < box[3]:
                        cells.setdefault(index, []).append((o, ys))
            places = {}
            for index, refs in sorted(cells.items()):
                places[index] = len(data)
                ys = [y for r in refs for y in r[1]]
                data += struct.pack("<2fhh", max(ys), min(ys), 0, len(refs))
                data += struct.pack("<%dI" % len(refs), *[BASE + r[0] for r in refs])
        else:
            walls, poles = [], []
            for w in grid[2]:
                walls.append((len(data), w))
                data += w
            for p in grid[3]:
                poles.append((len(data), p))
                data += p
            places = {}
            for index, box, size in cells_of(grid[1]):
                def close(xs, zs, r):
                    return max(box[0] - max(xs) - r, min(xs) - r - box[2], box[1] - max(zs) - r,
                               min(zs) - r - box[3]) <= size / 2

                near_walls = [o for o, w in walls if close(*([[e[0] for e in ec.wall_ends(struct.unpack("<8f", w))],
                                                              [e[1] for e in ec.wall_ends(struct.unpack("<8f", w))],
                                                              0.0]))]
                near_poles = [o for o, p in poles if close([struct.unpack("<2I5f", p)[2]],
                                                          [struct.unpack("<2I5f", p)[3]],
                                                          struct.unpack("<2I5f", p)[4])]
                if near_walls or near_poles:
                    places[index] = len(data)
                    data += struct.pack("<2h", len(near_walls), len(near_poles))
                    data += struct.pack("<%dI" % (len(near_walls) + len(near_poles)),
                                        *[BASE + o for o in near_walls + near_poles])
        count = struct.unpack_from("<i", grid[1], 24)[0]
        arrays.append(BASE + len(data))
        data += struct.pack("<%dI" % count, *[BASE + places[i] if i in places else 0 for i in range(count)])
    return bytes(data), arrays


def kind_table():
    data = bytearray()
    for name, bounce, colour in KINDS:
        data += struct.pack("<4f", bounce, *colour) + name.encode().ljust(11) + b"\0"
    return bytes(data)


class Fixture(object):
    """An executable plus COLDC1-3 laid out the way the USA game holds them."""

    def __init__(self):
        # every header a different size, as in the game, so no two can read the same array
        a_ground, a_walls = header(0, 0, 3, 2, 100.0), header(0, 0, 3, 3, 100.0)
        o_ground, o_walls = header(-2, 0, 0, 0, 150.0), header(-1, 0, 0, 4, 100.0)
        self.cb_headers = [header(0, 0, 0, 0, 200.0), header(-1, -1, 0, 0, 200.0),
                           header(0, 0, 0, 1, 200.0), header(-1, -1, 0, 1, 200.0)]
        arcade = [("ground", a_ground, [square(0, 0, 100), square(100, 0, 100, 5.0, kind=2),
                                        surface([(0, 1, 100), (0, 1, 100), (0, 1, 200), (100, 1, 200)], shape=3),
                                        square(300, 200, 100)]),
                  ("walls", a_walls, [wall(10, 10, 10, 190), wall(220, 350, 380, 350)], [pole(150, 50, 3.0)])]
        original = [("ground", o_ground, [square(-300, 0, 150), square(-150, 0, 150, 2.0, kind=1)]),
                    ("walls", o_walls, [wall(-50, 20, -50, 180), wall(-80, 420, -20, 480)], [])]
        crazy = [("ground", self.cb_headers[0], [square(0, 0, 200)]),
                 ("ground", self.cb_headers[1], [square(-200, -200, 200), square(-200, 0, 200, 3.0)]),
                 ("walls", self.cb_headers[2], [wall(10, 10, 190, 10)], []),
                 ("walls", self.cb_headers[3], [wall(-190, -10, -10, -10)], [pole(-100, 300, 5.0)])]
        self.files, self.arrays = [], []
        for grids in (arcade, original, crazy):
            data, arrays = build(grids)
            self.files.append(data)
            self.arrays.append(arrays)
        exe = bytearray(0x100)
        exe += kind_table() + bytes(28)              # 0x100: kinds, then a non-"#" entry
        exe += bytes(0x200 - len(exe))
        exe += a_ground + a_walls + o_ground + o_walls  # 0x200
        exe += bytes(0x300 - len(exe))
        exe += b"".join(self.cb_headers)            # 0x300: the Crazy Box header table
        exe += bytes(0x400 - len(exe))
        exe += struct.pack("<4I", self.arrays[0][0], 0, self.arrays[0][1], 0)
        exe += struct.pack("<4I", self.arrays[1][0], 0, self.arrays[1][1], 0)
        # 0x420: per game (games 0 and 2 share): ground cell arrays, then header indices; same for walls
        exe += struct.pack("<3I3i", self.arrays[2][0], self.arrays[2][1], self.arrays[2][0], 0, 1, 0)
        exe += struct.pack("<3I3i", self.arrays[2][2], self.arrays[2][3], self.arrays[2][2], 2, 3, 2)
        exe += struct.pack("<2I", 0, BASE)
        self.executable = bytes(exe)


class ExtractCollisionTest(unittest.TestCase):
    def test_f32_is_the_shortest_exact_decimal(self):
        for value in (0.1, 100.0, -8984.580078125, 1e-7, 0.8999999761581421):
            single = struct.unpack("<f", struct.pack("<f", value))[0]
            text = ec.f32(single)
            self.assertEqual(struct.pack("<f", text), struct.pack("<f", single))
            self.assertLessEqual(len(repr(text)), len(repr(single)))
        self.assertEqual(ec.f32(struct.unpack("<f", struct.pack("<f", 0.9))[0]), 0.9)

    def test_headers_must_be_self_consistent(self):
        data = bytes(8) + header(-157, -142, 164, 140, 100.0) + header(0, 0, 3, 3, 50.0)[:24] + struct.pack("<i", 15) \
            + struct.pack("<f", 50.0)
        found = ec.find_headers(data)
        self.assertEqual([h["address"] for h in found], [LOAD + 8])
        self.assertEqual((found[0]["columns"], found[0]["rows"], found[0]["cells"]), (322, 283, 91126))

    def test_kind_table_is_the_longest_named_run(self):
        data = bytes(12) + kind_table() + bytes(28) + struct.pack("<4f", 0, 1, 1, 1) + b"#lone".ljust(12, b"\0")
        address, kinds = ec.find_kinds(data)
        self.assertEqual(address, LOAD + 12)
        self.assertEqual([k["name"] for k in kinds], ["#road", "#kabe", "#slope", "#grass"])
        self.assertEqual((kinds[1]["bounce"], kinds[1]["colour"]), (1.0, [0.5, 0.5, 0.5]))

    def test_wall_ends_match_check_colli_wall_segment(self):
        values = struct.unpack("<8f", wall(3.0, 4.0, 63.0, 84.0))
        a, b, ex, ez, d, top, bottom, length = values
        (x0, z0), (x1, z1) = ec.wall_ends(values)
        self.assertAlmostEqual(length, 100.0, places=4)
        for x, z, along in ((x0, z0, 0.0), (x1, z1, length)):
            self.assertAlmostEqual((ex - x) * b - (ez - z) * a, along, places=3)  # the along-wall coordinate
            self.assertAlmostEqual(a * x + b * z + d, 0.0, places=3)                # on the line

    def test_ground_grid_reads_and_rejects_wrong_headers(self):
        f = Fixture()
        h = ec.read_header(f.executable, LOAD + 0x200)
        g = ec.parse_ground(f.files[0], BASE, h, f.arrays[0][0], len(KINDS))
        self.assertEqual(len(g["surfaces"]), 4)
        self.assertEqual(sorted(s["shape"] for s in g["surfaces"].values()), [3, 4, 4, 4])
        for shifted in (header(2, 0, 5, 2, 100.0), header(0, 0, 3, 2, 50.0)):
            with self.assertRaises(ValueError):
                ec.parse_ground(f.files[0], BASE, ec.read_header(b"" + shifted, LOAD), f.arrays[0][0], len(KINDS))
        with self.assertRaises(ValueError):  # walls do not read as ground
            ec.parse_ground(f.files[0], BASE, ec.read_header(f.executable, LOAD + 0x220), f.arrays[0][1], len(KINDS))

    def test_ground_surface_must_be_in_the_cell_under_its_centre(self):
        head = header(0, 0, 3, 0, 100.0)
        data, arrays = build([("ground", head, [square(0, 0, 100), square(300, 0, 100)])])
        h = ec.read_header(head, LOAD)
        self.assertEqual(len(ec.parse_ground(data, BASE, h, arrays[0], 1)["surfaces"]), 2)
        broken = bytearray(data)
        struct.pack_into("<I", broken, arrays[0] - BASE + 12, 0)  # drop cell 3 (the second square's only cell)
        self.assertEqual(len(ec.parse_ground(bytes(broken), BASE, h, arrays[0], 1)["surfaces"]), 1)
        # a cell that lists a far surface fails the cell test
        struct.pack_into("<I", broken, arrays[0] - BASE + 4, struct.unpack_from("<I", data, arrays[0] - BASE + 12)[0])
        with self.assertRaises(ValueError):
            ec.parse_ground(bytes(broken), BASE, h, arrays[0], 1)

    def test_wall_grid_and_inert_walls(self):
        head = header(0, 0, 1, 0, 100.0)
        inert = struct.pack("<8f", 0.0, 0.0, -1500.0, 0.0, 0.0, 4730.0, 0.0, 0.0)
        data, arrays = build([("walls", head, [wall(20, 50, 180, 50)], [pole(50, 20, 2.0)])])
        h = ec.read_header(head, LOAD)
        parsed = ec.parse_walls(data, BASE, h, arrays[0])
        self.assertEqual((len(parsed["walls"]), len(parsed["poles"]), len(parsed["cells"])), (1, 1, 2))
        self.assertLessEqual(parsed["margin"], 50.0)
        # an inert wall (zero normal and length) is accepted anywhere and never drawn
        extra = bytearray(data) + inert
        cell = struct.unpack_from("<I", data, arrays[0] - BASE)[0] - BASE
        nw, npole = struct.unpack_from("<2h", data, cell)
        pointers = list(struct.unpack_from("<%dI" % (nw + npole), data, cell + 4))
        new_cell = len(extra)
        extra += struct.pack("<2h", nw + 1, npole) + struct.pack("<%dI" % (nw + npole + 1), *(
            pointers[:nw] + [BASE + len(data)] + pointers[nw:]))
        struct.pack_into("<I", extra, arrays[0] - BASE, BASE + new_cell)
        parsed = ec.parse_walls(bytes(extra), BASE, h, arrays[0])
        self.assertEqual(len(parsed["walls"]), 2)
        self.assertEqual(ec.stats(dict(surfaces={}, cells=[]), parsed)["inert_walls"], 1)

    def test_facing_follows_the_plane_normal(self):
        up = [0.0, 1.0, 0.0]
        points = [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]]
        for tri in ec.facing(points, up):
            a, b, c = (points[k] for k in tri)
            u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            self.assertGreater(u[2] * v[0] - u[0] * v[2], 0)  # y of u x v
        self.assertEqual(ec.outline(dict(shape=3, corners=[[9, 9, 9], [1, 0, 0], [2, 0, 0], [3, 0, 0]])),
                         [[1, 0, 0], [2, 0, 0], [3, 0, 0]])

    def test_largest_prefers_most_items_then_cells(self):
        def grid(f, kind, items, cells, size):
            return (f, kind, 0, dict(cells=size), dict(surfaces=dict.fromkeys(range(items)), cells=[0] * cells))
        grids = [grid(0, "ground", 5, 4, 10), grid(0, "ground", 9, 4, 10), grid(0, "ground", 9, 3, 99)]
        self.assertIs(ec.largest(grids, 0, "ground"), grids[1])
        with self.assertRaises(ValueError):
            ec.largest(grids + [grid(0, "ground", 9, 4, 10)], 0, "ground")
        with self.assertRaises(ValueError):
            ec.largest(grids, 1, "ground")

    def test_extract_end_to_end(self):
        f = Fixture()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            (source / "1ST_READ.BIN").write_bytes(f.executable)
            for n, data in enumerate(f.files):
                (source / ("COLDC%d.BIN" % (n + 1))).write_bytes(data)
            out = Path(tmp) / "collision"
            manifest = ec.extract(source, out)
            self.assertEqual(manifest["load_address"], BASE)
            self.assertEqual(manifest["kind_table"], LOAD + 0x100)
            self.assertEqual(manifest["crazy_box_tables"]["ground"],
                             dict(cells_table=LOAD + 0x420, index_table=LOAD + 0x42C, header_table=LOAD + 0x300))
            runs = [r for file in manifest["files"] for r in file["runs"]]
            self.assertEqual([r["run"] for r in runs],
                             ["arcade", "original", "crazy_box_game_00_02", "crazy_box_game_01"])
            self.assertEqual((runs[0]["ground_header"], runs[0]["walls_header"]), (LOAD + 0x200, LOAD + 0x220))
            self.assertEqual((runs[3]["ground_header"], runs[3]["walls_header"]), (LOAD + 0x320, LOAD + 0x360))
            self.assertEqual((runs[0]["surfaces"], runs[0]["walls"], runs[0]["poles"]), (4, 2, 1))
            self.assertEqual(runs[0]["surface_kinds"], {"0": 3, "2": 1})
            arcade = json.loads((out / "arcade.json").read_text())
            self.assertEqual(arcade["ground"]["header"]["columns"], 4)
            self.assertEqual(len(arcade["ground"]["surfaces"]), 4)
            self.assertEqual(arcade["walls"]["poles"], [[150.0, 50.0, 3.0, 50.0, 0.0]])
            for cell in arcade["ground"]["cells"]:
                self.assertTrue(all(0 <= s < 4 for s in cell[4]))
            blob = (out / "COLDC3.glb").read_bytes()
            self.assertEqual(blob[:4], b"glTF")
            doc = json.loads(blob[20:20 + struct.unpack_from("<I", blob, 12)[0]])
            self.assertEqual([s["name"] for s in doc["scenes"]], ["crazy_box_game_00_02", "crazy_box_game_01"])
            self.assertEqual(doc["scenes"][0]["extras"]["mini_games"], [0, 2])
            self.assertTrue((out / "index.html").exists())
            with self.assertRaises(ValueError):
                ec.extract(source, out)


if __name__ == "__main__":
    unittest.main()
