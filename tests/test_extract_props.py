"""Synthetic set object fixtures: no game files or upstream modules required."""
import math
import struct
import unittest

from tools import extract_props as ep

LOAD = ep.LOAD
BASE = 0x0CE90000


def record(position, angle, kind, variant, following):
    return struct.pack("<3fIhhI8x", *(list(position) + [angle, kind, variant, following]))


def placement(groups):
    """groups: [[(position, angle, kind, variant)]] laid out from 0x2000 in group order."""
    data = bytearray(0x10000)
    cursor = 0x2000
    for g, items in enumerate(groups):
        first = BASE + cursor if items else 0
        struct.pack_into("<3fIhhI", data, g * 32, 1.0, 2.0, 3.0, 0, len(items), 0, first)
        for n, (position, angle, kind, variant) in enumerate(items):
            following = BASE + cursor + 32 if n + 1 < len(items) else 0
            data[cursor:cursor + 32] = record(position, angle, kind, variant, following)
            cursor += 32
    return bytes(data)


def kind_executable(count=9):
    """Sphere data at 0x0/0x40, the kind table at 0x100, a stray word 0x0CE90000 elsewhere."""
    data = bytearray(0x100)
    struct.pack_into("<3f", data, 0, 0.0, 5.0, 0.0)
    struct.pack_into("<If", data, 0x40, 1, 2.5)
    for k in range(count):
        data += struct.pack("<6If2I", LOAD, LOAD + 0x40, 1, 0x4000 if k == 1 else 0, 0, 0xC00A9,
                            30.0 + k, 0, 0)
    data += struct.pack("<2I", 0x0C390000, BASE)
    return bytes(data)


class ExtractPropsTest(unittest.TestCase):
    def test_groups_follow_record_chains(self):
        data = placement([[((1, 2, 3), 0x14000, 5, 0), ((4, 5, 6), 0x8000, 6, 2)], [((7, 8, 9), 0, 1, 0)]])
        groups = ep.parse_objects(data, BASE)
        self.assertEqual([len(g["instances"]) for g in groups], [2, 1])
        first = groups[0]["instances"][0]
        self.assertEqual((first["record"], first["kind"], first["variant"], first["angle"]), (0x2000, 5, 0, 0x4000))
        self.assertEqual(groups[0]["instances"][1]["position"], [4.0, 5.0, 6.0])

    def test_bad_chains_rejected(self):
        data = bytearray(placement([[((0, 0, 0), 0, 1, 0)]]))
        struct.pack_into("<h", data, 0x10, 2)  # count disagrees with the chain
        with self.assertRaises(ValueError):
            ep.parse_objects(bytes(data), BASE)
        data = bytearray(placement([[((0, 0, 0), 0, 1, 0)]]))
        struct.pack_into("<I", data, 0x14, BASE + 0x9000)  # past the loaded 0x8000 bytes
        with self.assertRaises(ValueError):
            ep.parse_objects(bytes(data), BASE)
        with self.assertRaises(ValueError):
            ep.parse_objects(bytes(0x10000), BASE)

    def test_objects_base_is_the_word_every_file_fits(self):
        files = [placement([[((0, 0, 0), 0, 1, 0)]]) for _ in range(3)]
        self.assertEqual(ep.find_objects_base(kind_executable(), files), BASE)
        with self.assertRaises(ValueError):
            ep.find_objects_base(kind_executable()[:-4], files)

    def test_kind_table_and_spheres(self):
        executable = kind_executable()
        table, count = ep.find_kind_table(executable)
        self.assertEqual((table, count), (LOAD + 0x100, 9))
        kinds = ep.read_kinds(executable, table, count)
        self.assertEqual(kinds[1]["x_angle"], 0x4000)
        self.assertEqual((kinds[0]["sphere_offsets"], kinds[0]["sphere_radii"]), ([[0.0, 5.0, 0.0]], [2.5]))
        self.assertEqual(kinds[8]["mass"], 38.0)
        with self.assertRaises(ValueError):
            ep.find_kind_table(kind_executable(count=7))

    def test_model_table_is_an_exact_run_and_arrays_end_at_the_next(self):
        models = {0x0C390100, 0x0C390200}
        data = bytearray(0x40)
        struct.pack_into("<4I", data, 0, 0x0C390100, 0x0C390200, 0x0C390100, 0x0C390200)
        data += struct.pack("<3I", LOAD, LOAD + 8, LOAD + 12)   # the kind table: 3 arrays
        data += bytes(4)
        data += struct.pack("<5I", *([LOAD] * 5))                # a longer run (like the character table)
        table, arrays = ep.find_model_table(bytes(data), 3, models)
        self.assertEqual((table, arrays), (LOAD + 0x40, [LOAD, LOAD + 8, LOAD + 12]))
        self.assertEqual(ep.model_arrays(bytes(data), table, arrays),
                         [[0x0C390100, 0x0C390200], [0x0C390100], [0x0C390200] + [0] * 12])

    def test_quaternion_is_rotate_y_then_x(self):
        def matrix(q):
            x, y, z, w = q
            return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]

        def ry(a):
            c, s = math.cos(a), math.sin(a)
            return [[c, 0, s], [0, 1, 0], [-s, 0, c]]  # nlRotateAY: column 0 (c, 0, -s), column 2 (s, 0, c)

        def rx(a):
            c, s = math.cos(a), math.sin(a)
            return [[1, 0, 0], [0, c, -s], [0, s, c]]  # nlRotateAX: column 1 (0, c, s), column 2 (0, -s, c)

        def mul(a, b):
            return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

        for y_angle, x_angle in ((0x4000, 0), (0x2000, 0x4000), (0xC123, 0x1555), (0x10000 + 0x800, 0)):
            expected = mul(ry(y_angle * 2 * math.pi / 65536), rx(x_angle * 2 * math.pi / 65536))
            got = matrix(ep.quaternion(y_angle, x_angle))
            for i in range(3):
                for j in range(3):
                    self.assertAlmostEqual(got[i][j], expected[i][j], places=9)


if __name__ == "__main__":
    unittest.main()
