"""Synthetic nlObjPut fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_models as em


def fl(*values):
    return struct.pack("<%df" % len(values), *values)


def vertex(x, y, z, normal=(0.0, 0.0, 1.0), uv=(0.0, 0.0)):
    return fl(x, y, z, *normal, *uv)


def coloured_vertex(x, y, z, normal_bytes=(0, 127, 0), argb=0xFF102030, uv=(0.5, 0.25)):
    packed = normal_bytes[0] & 255 | (normal_bytes[1] & 255) << 8 | (normal_bytes[2] & 255) << 16
    return fl(x, y, z) + struct.pack("<3I", packed, argb, argb) + fl(*uv)


def reference(from_offset, to_offset):
    """Two-word reference written at byte from_offset (record-relative) to a vertex at to_offset."""
    return struct.pack("<Ii", 0x7FC00000, to_offset - from_offset - 8)


def record(strips, texture=0, specular=0, pcw=0x8000002C, tsp=0x2009A45B, face=(1.0, 1.0, 1.0, 1.0)):
    body = b"".join(strips)
    return (struct.pack("<4I", pcw, 0x83000000, tsp, 0) + fl(0, 0, 0, 1) + struct.pack("<ii", texture, specular)
            + fl(0.0) + fl(*face) + fl(0, 0, 0, 0) + struct.pack("<I", len(body)) + body)


def strip(gflag, count, entries):
    return struct.pack("<II", gflag, count) + b"".join(entries)


def model(records, radius=10.0):
    return struct.pack("<II", 1, 1) + fl(0, 0, 0, radius) + b"".join(records) + struct.pack("<I", 0)


def quad_model():
    # A 4-vertex strip facing +z, written in strip order.
    return model([record([strip(0x12, 4, [vertex(0, 0, 0, uv=(0, 1)), vertex(1, 0, 0, uv=(1, 1)),
                                         vertex(0, 1, 0, uv=(0, 0)), vertex(1, 1, 0, uv=(1, 0))])])])


def list_with_reference():
    # Triangle list (gflag bit 3): count 2 polygons = 6 entries, the last ones references.
    v = [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0)]
    first = strip(0x6A, 1, v)
    head = 24 + 80  # model header + record header
    ref_at = 8 + 3 * 32 + 8  # strip header, three vertices, second strip header
    second = strip(0x6A, 1, [reference(ref_at, 8), vertex(1, 1, 0),
                             reference(ref_at + 8 + 32, 8 + 32)])
    return model([record([first, second])]), head


def afs(entries):
    table = 8 + 8 * len(entries)
    offset = (table + 2047) // 2048 * 2048
    layout, blob = [], bytearray()
    for data in entries:
        layout.append((offset + len(blob), len(data)))
        blob += data + b"\0" * (-len(data) % 2048)
    head = b"AFS\0" + struct.pack("<I", len(entries)) + b"".join(struct.pack("<II", *e) for e in layout)
    return head + b"\0" * (offset - len(head)) + bytes(blob)


class ModelTests(unittest.TestCase):
    def test_parse_strip_and_winding(self):
        data = b"\0" * 8 + quad_model()
        parsed = em.parse_model(data, 8)
        self.assertEqual(len(parsed["records"]), 1)
        self.assertEqual(len(parsed["vertices"]), 4)
        self.assertEqual(parsed["end"], len(data) - 4)
        tris = [em.facing(t, parsed["vertices"]) for t in em.triangles(parsed["records"][0]["strips"][0])]
        self.assertEqual(len(tris), 2)
        for tri in tris:
            a, b, c = (parsed["vertices"][k] for k in tri)
            cross_z = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            self.assertGreater(cross_z, 0)

    def test_triangle_list_and_references_share_vertices(self):
        data, _ = list_with_reference()
        parsed = em.parse_model(data, 0)
        strips = parsed["records"][0]["strips"]
        self.assertEqual(len(parsed["vertices"]), 4)
        self.assertEqual(strips[1]["indices"], [0, 3, 1])
        self.assertEqual(len(em.triangles(strips[0]) + em.triangles(strips[1])), 2)

    def test_coloured_vertices(self):
        data = model([record([strip(0x52, 3, [coloured_vertex(0, 0, 0), coloured_vertex(1, 0, 0),
                                               coloured_vertex(0, 0, 1, normal_bytes=(-90, 0, -90))])],
                            specular=-3)])
        parsed = em.parse_model(data, 0)
        first, last = parsed["vertices"][0], parsed["vertices"][2]
        self.assertEqual(first[3:6], (0.0, 1.0, 0.0))
        self.assertAlmostEqual(last[3], last[5])
        self.assertLess(last[3], 0)
        self.assertAlmostEqual(last[3] ** 2 + last[4] ** 2 + last[5] ** 2, 1.0)
        self.assertEqual(first[6:8], (0.5, 0.25))
        self.assertEqual(first[8:12], (0x10 / 255.0, 0x20 / 255.0, 0x30 / 255.0, 1.0))

    def test_non_finite_attributes_repaired_but_positions_rejected(self):
        bad_uv = fl(0, 0, 0, 0, 0, 1) + struct.pack("<2I", 0x7FBFFFFF, 0)
        data = model([record([strip(0x12, 3, [bad_uv, vertex(1, 0, 0), vertex(0, 1, 0)])])])
        parsed = em.parse_model(data, 0)
        self.assertEqual(parsed["repaired"], 1)
        self.assertEqual(parsed["vertices"][0][6], 0.0)
        with self.assertRaises(ValueError):
            em.decode_vertex(struct.unpack("<8I", struct.pack("<I", 0x7F800000) + vertex(0, 0, 0)[4:]), False)

    def test_malformed_models_rejected(self):
        cases = {
            "radius": model([record([strip(0x12, 3, [vertex(0, 0, 0)] * 3)])], radius=0.0),
            "short strip": model([record([strip(0x12, 2, [vertex(0, 0, 0)] * 2)])]),
            "dangling reference": model([record([strip(0x12, 3, [vertex(0, 0, 0), vertex(1, 0, 0),
                                                                  reference(0, 4000)])])]),
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                em.parse_model(data, 0)
        overrun = bytearray(quad_model())
        struct.pack_into("<I", overrun, 24 + 76, struct.unpack_from("<I", overrun, 24 + 76)[0] - 8)
        with self.assertRaises(ValueError):
            em.parse_model(bytes(overrun), 0)

    def test_find_models_chains_records(self):
        two = model([record([strip(0x12, 3, [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0)])]),
                     record([strip(0x12, 3, [vertex(0, 0, 1), vertex(1, 0, 1), vertex(0, 1, 1)])], texture=5)])
        data = b"\0" * 64 + two + b"\0" * 32 + quad_model() + b"\xff" * 12
        found = em.find_models(data)
        self.assertEqual([(f[0], f[1], f[4]) for f in found], [(64, 2, 5), (64 + len(two) + 32, 1, 0)])

    def test_glb_structure_material_and_colour(self):
        textures = [dict(png="TEXDC0/0000.png")]
        gltf = em.Gltf("TEXDC0.BIN", textures, "../tex/")
        coloured = model([record([strip(0x52, 3, [coloured_vertex(0, 0, 0), coloured_vertex(1, 0, 0),
                                                  coloured_vertex(0, 0, 1)])], specular=-3, pcw=0x8200002C)])
        mesh_a, tri_a = gltf.mesh("a", em.parse_model(quad_model(), 0))
        mesh_b, tri_b = gltf.mesh("b", em.parse_model(coloured, 0))
        gltf.node("a", mesh_a, {})
        gltf.node("b", mesh_b, {})
        blob = gltf.glb()
        magic, version, length = struct.unpack_from("<III", blob)
        self.assertEqual((magic, version, length), (0x46546C67, 2, len(blob)))
        size, kind = struct.unpack_from("<II", blob, 12)
        self.assertEqual(kind, 0x4E4F534A)
        doc = json.loads(blob[20:20 + size])
        self.assertEqual((tri_a, tri_b), (2, 1))
        self.assertEqual(doc["images"], [dict(uri="../tex/TEXDC0/0000.png")])
        # TSP 0x2009A45B: bits 16/15 clamp U/V, bits 18/17 (flip) clear.
        self.assertEqual((doc["samplers"][0]["wrapS"], doc["samplers"][0]["wrapT"]), (33071, 33071))
        prim_a, prim_b = doc["meshes"][0]["primitives"][0], doc["meshes"][1]["primitives"][0]
        self.assertNotIn("COLOR_0", prim_a["attributes"])
        self.assertIn("COLOR_0", prim_b["attributes"])
        self.assertEqual(doc["materials"][prim_b["material"]]["alphaMode"], "BLEND")
        self.assertEqual(doc["accessors"][prim_a["attributes"]["POSITION"]]["max"], [1.0, 1.0, 0.0])
        bin_size, bin_kind = struct.unpack_from("<II", blob, 20 + size)
        self.assertEqual((bin_kind, bin_size), (0x004E4942, doc["buffers"][0]["byteLength"]))

    def fixture(self, root):
        disc, textures = root / "disc", root / "textures"
        disc.mkdir()
        (textures / "TEXDC0").mkdir(parents=True)
        banks = [dict(source="TEXDC%d.BIN" % n, textures=[dict(png="TEXDC%d/0000.png" % n)]) for n in range(4)]
        (textures / "manifest.json").write_text(json.dumps(dict(banks=banks)))
        for name in em.MODEL_FILES:
            (disc / name).write_bytes(b"\0" * 32 + quad_model() + b"\0" * 16)
        for name in em.CITY_FILES:
            (disc / name).write_bytes(afs([quad_model(), list_with_reference()[0]]))
        return disc, textures

    def test_extract_manifest_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            disc, textures = self.fixture(root)
            manifest = em.extract(disc, textures, root / "models")
            self.assertEqual([len(f["models"]) for f in manifest["files"]], [1, 1, 1, 1, 2, 2, 2])
            self.assertTrue((root / "models" / "POLDC0" / "000020.glb").is_file())
            self.assertTrue((root / "models" / "BINC1.glb").is_file())
            written = json.loads((root / "models" / "manifest.json").read_text())
            self.assertEqual(written["files"][4]["skipped"], [])
            self.assertEqual(written["files"][4]["models"][1]["entry"], 1)
            with self.assertRaises(ValueError):
                em.extract(disc, textures, root / "models")

    def test_bad_archive_cleans_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            disc, textures = self.fixture(root)
            (disc / "BINC3.AFS").write_bytes(b"AFS\0" + struct.pack("<III", 1, 4096, 16))
            with self.assertRaises(ValueError):
                em.extract(disc, textures, root / "models")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["disc", "textures"])


if __name__ == "__main__":
    unittest.main()
