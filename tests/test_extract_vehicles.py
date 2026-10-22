"""Synthetic vehicle fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from tools import extract_vehicles as ev
from tools import extract_models as em
from tools.extract_models import parse_model
from tools.extract_textures import png_bytes
from tests.test_extract_models import model, quad_model, record, strip, vertex

LOAD = ev.LOAD
BASE0, CITY = 0x0C390000, 0x0C5E0000
PCW_INTENSITY_1, PCW_INTENSITY_2 = 0x8000002C, 0x8000003C  # colour type 2 / 3, textured
TSP_DECAL = 0x2009A49B  # shading instruction 2 (decal alpha)


def chunk(tag, body):
    return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))


def files():
    """POLDC0 models at 0x100/0x200/0x300; POLDC2 alone has 0x40; POLDC1 and 3 have 0x80."""
    return {"POLDC0.BIN": (b"", BASE0, {0x100, 0x200, 0x300}), "POLDC1.BIN": (b"", CITY, {0x80}),
            "POLDC2.BIN": (b"", CITY, {0x40}), "POLDC3.BIN": (b"", CITY, {0x80})}


def car_record(body, far, shadow, name, colours=0, axles=((0, 3, 14), (0, 3, -14), (0, 0, 0)), wheels=(0, 0, 0, 0)):
    r = [0] * ev.RECORD_WORDS
    r[0], r[1], r[2], r[3] = body, far, shadow, shadow
    r[22], r[24] = wheels[0], wheels[1]
    r[23], r[25] = wheels[2], wheels[3]
    for k, axle in enumerate(axles):
        for n, v in enumerate(axle):
            r[28 + 3 * k + n] = struct.unpack("<I", struct.pack("<f", v))[0]
    r[37] = struct.unpack("<I", struct.pack("<f", 2000.0))[0]
    r[39], r[41] = colours, name
    return struct.pack("<%dI" % ev.RECORD_WORDS, *r)


def car_executable(count=9, city_record=False):
    """Names at 0x0, colour list at 0x40, table at 0x100 then the colour table."""
    data = bytearray(0x100)
    data[0:16] = b"P_Test        \x00\xee"
    struct.pack_into("<32I", data, 0x40, *[k % 3 for k in range(32)])
    for k in range(count):
        if city_record and k == count - 1:
            data += car_record(CITY + 0x40, CITY + 0x40, 0, LOAD, LOAD + 0x40)
        else:
            data += car_record(BASE0 + 0x100, BASE0 + 0x200, BASE0 + 0x300, LOAD, LOAD + 0x40,
                               wheels=(BASE0 + 0x300, BASE0 + 0x300, 0, 0))
    data += struct.pack("<9f", 1.0, 0.5, 0.0, 0.25, 0.25, 0.25, 0.0, 0.0, 1.0)
    data += bytes(64)
    return bytes(data)


class ExtractVehiclesTest(unittest.TestCase):
    def test_car_table_run_colours_and_owner(self):
        executable = car_executable(city_record=True)
        found = ev.car_types(executable, files())
        self.assertEqual((found["table"], found["count"]), (LOAD + 0x100, 9))
        self.assertEqual(found["colour_table"], LOAD + 0x100 + 9 * ev.RECORD)
        self.assertEqual(found["colours"], [[1.0, 0.5, 0.0], [0.25, 0.25, 0.25], [0.0, 0.0, 1.0]])
        self.assertEqual(found["types"][0]["name"], "P_Test")
        self.assertEqual(found["types"][0]["source"], "POLDC0.BIN")
        self.assertEqual(found["types"][8]["source"], "POLDC2.BIN")
        self.assertEqual(found["types"][0]["axles"][0], [0.0, 3.0, 14.0])

    def test_short_run_and_ambiguous_owner_rejected(self):
        with self.assertRaises(ValueError):
            ev.find_car_table(car_executable(count=7), set(BASE0 + o for o in (0x100, 0x200, 0x300)))
        with self.assertRaises(ValueError):
            ev.owner([CITY + 0x80], files())

    def test_traffic_parts_follow_put_car_model(self):
        r = struct.unpack("<%dI" % ev.RECORD_WORDS, car_record(1, 2, 3, 0, wheels=(10, 11, 12, 13)))
        r = list(r)
        r[5], r[7], r[15] = 6, 7, 15
        parts = ev.traffic_parts(r, [(6.0, 3.0, 14.0), (6.0, 3.0, -14.0), (0.0, 0.0, 0.0)])
        self.assertIn((0, "wheel_0", 10, (6.0, 3.0, 14.0)), parts)
        self.assertIn((0, "wheel_0_mirror", 12, (-6.0, 3.0, 14.0)), parts)
        self.assertIn((0, "wheel_1_mirror", 13, (-6.0, 3.0, -14.0)), parts)
        self.assertIn((1, "extra", 6, None), parts)
        self.assertIn((2, "lamp_a_near_1", 7, None), parts)
        self.assertIn((2, "lamp_b_near_1", 15, None), parts)
        self.assertEqual([p for p in parts if p[0] == 1 and p[1] == "body"], [(1, "body", 2, None)])
        r[22] = 0  # no first axle: only the second is drawn
        self.assertEqual([p[1] for p in ev.traffic_parts(r, [(0, 0, 0)] * 3) if p[1].startswith("wheel")],
                         ["wheel_1", "wheel_1_mirror"])
        r[24] = 0  # +0x60 empty: no wheels at all
        self.assertFalse([p for p in ev.traffic_parts(r, [(0, 0, 0)] * 3) if p[1].startswith("wheel")])

    def test_cab_table_and_parts(self):
        data = bytearray(0x400)
        models = [BASE0 + o for o in (0x100, 0x200, 0x300)]
        for k in range(5):
            struct.pack_into("<14I", data, 0x40 + 0x38 * k, *([models[0]] * 4 + [models[1], 0, models[2]] + [0] * 7))
        struct.pack_into("<15f", data, 0x200, *([6.5, 2.8, 15.0] * 5))
        struct.pack_into("<12f", data, 0x240, *([7.0, 4.0, 16.0] * 4))
        struct.pack_into("<15I", data, 0x300, *([LOAD + 0x40 + 0x38 * k for k in range(5)] + [LOAD + 0x200] * 5
                                                 + [LOAD + 0x240] * 5))
        executable = bytes(data)
        table, sets, wheels, points = ev.find_cab_tables(executable, set(models))
        self.assertEqual(table, LOAD + 0x300)
        self.assertEqual(ev.cab_sets(executable, table, [sets[0]])[0][:7], [models[0]] * 4 + [models[1], 0, models[2]])
        self.assertEqual([len(s) for s in ev.cab_sets(executable, table, sets)], [14, 14, 14, 14, 16])
        parts = ev.cab_parts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [float(v) for v in range(15)])
        self.assertIn((0, "wheel_2", 3, (6.0, 7.0, 8.0)), parts)
        self.assertIn((0, "body", 5, (0.0, -ev.CAB_BODY_DROP, 0.0)), parts)
        self.assertIn((0, "rear_6", 7, (0.0, -ev.CAB_BODY_DROP, 0.0)), parts)
        self.assertIn((1, "rear_5", 6, (0.0, -ev.CAB_BODY_DROP, 0.0)), parts)
        self.assertIn((1, "slot_9", 10, (0.0, 1.0, 2.0)), parts)
        self.assertEqual(len(parts), 14)

    def test_cab_table_needs_float_data(self):
        data = bytearray(0x400)
        model = BASE0 + 0x100
        struct.pack_into("<5I", data, 0x40, *([model] * 5))
        struct.pack_into("<15I", data, 0x300, *([LOAD + 0x40] * 15))  # pointers to models, not floats
        with self.assertRaises(ValueError):
            ev.find_cab_tables(bytes(data), {model})

    def test_builder_scenes_share_meshes(self):
        blob = bytes(0x100) + quad_model()
        builder = ev.Builder(None, [], "", blob, BASE0, ("near", "far", "lamps"))
        builder.put(0, "body", BASE0 + 0x100)
        builder.put(0, "wheel_0", BASE0 + 0x100, (1.0, 2.0, 3.0))
        builder.put(1, "body", BASE0 + 0x100)
        glb = builder.glb()
        length = struct.unpack_from("<I", glb, 12)[0]
        doc = json.loads(glb[20:20 + length])
        self.assertEqual([s["name"] for s in doc["scenes"]], ["near", "far"])
        self.assertEqual(len(doc["meshes"]), 1)
        self.assertEqual(doc["nodes"][1]["translation"], [1.0, 2.0, 3.0])
        self.assertEqual(builder.triangles, 2)
        self.assertEqual([p["scene"] for p in builder.placed], ["near", "near", "far"])

    def test_decal_alpha_and_png_round_trip(self):
        rgba = bytes([10, 20, 30, 0, 200, 100, 50, 255, 0, 0, 0, 51])
        self.assertEqual(em.decal_alpha(rgba, (1.0, 0.5, 0.0, 1.0)),
                         bytes([255, 128, 0, 255, 200, 100, 50, 255, 204, 102, 0, 255]))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "t.png"
            path.write_bytes(png_bytes(3, 1, rgba))
            self.assertEqual(em.read_png(path), (3, 1, rgba))
            raw = zlib.compress(b"\x01" + rgba)
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 3, 1, 8, 6, 0, 0, 0))
                             + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
            with self.assertRaises(ValueError):
                em.read_png(path)

    def test_mark_decals_inherits_last_intensity_1_face(self):
        quad = strip(0x12, 4, [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0), vertex(1, 1, 0)])
        data = model([record([quad], pcw=PCW_INTENSITY_1, tsp=TSP_DECAL, face=(1.0, 1.0, 1.0, 0.0)),
                      record([quad], pcw=PCW_INTENSITY_2, tsp=TSP_DECAL, face=(1.0, 0.5, 0.5, 0.5)),
                      record([quad])])
        parsed = parse_model(data, 0)
        self.assertEqual(em.mark_decals(parsed, [dict(png="t.png")]), 2)
        self.assertEqual([r["decal_face"] for r in parsed["records"]],
                         [(1.0, 1.0, 1.0, 0.0), (1.0, 1.0, 1.0, 0.0), None])
        with self.assertRaises(ValueError):
            em.mark_decals(parse_model(model([record([quad], pcw=PCW_INTENSITY_2, tsp=TSP_DECAL)]), 0),
                           [dict(png="t.png")])
        self.assertEqual(em.tint((1.0, 1.0, 1.0, 0.0), (0.5, 0.25, 1.0)), (0.5, 0.25, 0.0, 1.0))

    def test_paint_variants_on_body_only(self):
        quad = strip(0x12, 4, [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0), vertex(1, 1, 0)])
        decal = model([record([quad], pcw=PCW_INTENSITY_1, tsp=TSP_DECAL, face=(1.0, 1.0, 1.0, 0.0))])
        blob = bytes(0x100) + decal + bytes(-len(decal) % 0x100) + decal
        second = 0x100 + len(decal) + (-len(decal) % 0x100)
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "t.png").write_bytes(png_bytes(2, 1, bytes([10, 20, 30, 0, 200, 100, 50, 255])))
            builder = ev.Builder("TEXDC0.BIN", [dict(png="t.png")], "../", blob, BASE0, ("near",), Path(folder))
            builder.put(0, "body", BASE0 + 0x100)
            builder.put(0, "extra", BASE0 + second)
            info = builder.paint([("paint_00", (1.0, 0.0, 0.0)), ("paint_03", (0.0, 0.0, 1.0))], 1)
            glb = builder.glb()
        self.assertEqual(info, dict(decal_primitives=2, painted_primitives=1, baked_images=3))
        length = struct.unpack_from("<I", glb, 12)[0]
        doc, binary = json.loads(glb[20:20 + length]), glb[28 + length:]
        self.assertEqual(doc["extensionsUsed"], [em.VARIANTS])
        self.assertEqual(doc["extensions"][em.VARIANTS]["variants"], [{"name": "paint_00"}, {"name": "paint_03"}])
        body, extra = (m["primitives"][0] for m in doc["meshes"])
        colours = [m["extras"]["decal_alpha_colour"] for m in doc["materials"]]
        self.assertEqual(colours[body["material"]], [0.0, 0.0, 0.0, 1.0])  # yellow face * blue paint
        self.assertEqual(colours[extra["material"]], [1.0, 1.0, 0.0, 1.0])
        mappings = body["extensions"][em.VARIANTS]["mappings"]
        self.assertEqual(sorted((colours[x["material"]], x["variants"]) for x in mappings),
                         [([0.0, 0.0, 0.0, 1.0], [1]), ([1.0, 0.0, 0.0, 1.0], [0])])
        self.assertEqual(len(doc["materials"]), 3)  # the unbaked material is pruned
        self.assertEqual(len(doc["images"]), 3)
        image = doc["images"][doc["textures"][doc["materials"][extra["material"]]["pbrMetallicRoughness"]
                                              ["baseColorTexture"]["index"]]["source"]]
        view = doc["bufferViews"][image["bufferView"]]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "baked.png"
            path.write_bytes(binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]])
            self.assertEqual(em.read_png(path), (2, 1, bytes([255, 255, 0, 255, 200, 100, 50, 255])))


if __name__ == "__main__":
    unittest.main()
