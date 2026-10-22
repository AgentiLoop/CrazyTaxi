#!/usr/bin/env python3
"""Assemble Crazy Taxi's traffic vehicles and the four player cabs as glTF binaries.

Everything is found in the USA disc files, not taken from regional addresses:

* Model file load addresses: find_base (POLDC0, and POLDC1-3, which share one base).
* The traffic table (the decomp's carTbl): the longest run of 0xA8-byte records whose
  body, far body and shadow words are model addresses and whose +0xA4 word points into
  the executable (the type's space-padded name). Each record's models must all lie in one
  model file: POLDC0, or exactly one of POLDC1-3 (the rail vehicles).
* The traffic colours: the 12-byte RGB table that follows the last record (putCarModel's
  SetFadeColorBaseMulti source), and per type a 32-entry index list at +0x9C
  (PcarEvInit picks one at random & 31).
* The cab tables (init_CarMain): five pointers to model sets, then five pointers to wheel
  positions (+0x6C) and five to four more points (+0x70). Entry 4 is the default.

Placement follows the USA draw routines (decomp docs/engine.md "Taxi", checked against
the USA disassembly of putCarModel and putPlayerCar):

* Traffic, level of detail 0 ("near" scene): body +0x00, shadow +0x08, extra +0x10, and
  per axle k (+0x58, +0x60, +0x68) the wheel model at the axle centre (+0x70, +0x7C,
  +0x88) and, when present, the second model (+0x5C, +0x64, +0x6C) at (-x, y, z). The
  first axle is skipped when +0x58 is 0; no wheels are drawn when +0x60 is 0. Level 1
  ("far" scene): +0x04, +0x0C, +0x14, no wheels. The lamp variants (+0x18 and +0x38, four
  per level) are in a third scene.
* Cab: set[4] body and set[6] (set[5] with a fare on board) are drawn 1.2 below the car
  origin; wheels set[0..3] at the +0x6C positions (the game's suspension sets the height;
  the table's height is used). The other set entries go to an "alternates" scene.

Paint (USA putCarModel and the library record drawer at 0x0C080E20): putCarModel calls
SetFadeColorBaseMulti(r, g, b) with the car's colour from the table above, draws only the
body model (+0x00 or +0x04), then ResetFadeColor. The record drawer multiplies the face
colour of every record whose PCW colour type is 2 (intensity mode 1) by the fade base;
colour type 3 records send no face colour, so the PowerVR keeps the last one. Every body
record that shows it uses the TSP decal-alpha shading (2): pixel = texture RGB * texture A +
face RGB * (1 - texture A), alpha = face A. Decal-alpha textures are baked with that rule
and embedded: unpainted with the record's face colour, body records with face * paint. The
default body uses the type's first colour-list entry (random & 31 == 0); every distinct
list colour is a KHR_materials_variants variant "paint_NN". Lighting, the offset colour
and the fade colour's runtime changes are not applied. Other textures are referenced from
extract_textures.py output. Stdlib only; no upstream imports.
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile
import zlib

try:
    from tools.extract_models import Gltf, digest, find_models, material_key, parse_model
    from tools.extract_characters import LOAD, find_base, words
    from tools.extract_textures import png_bytes
except ImportError:  # run as a script from the tools directory
    from extract_models import Gltf, digest, find_models, material_key, parse_model
    from extract_characters import LOAD, find_base, words
    from extract_textures import png_bytes

RECORD = 0xA8
RECORD_WORDS = RECORD // 4
COLOUR_LIST = 32  # PcarEvInit: random & 31
MODEL_WORDS = list(range(0, 6)) + list(range(6, 22)) + list(range(22, 28))
CAB_SETS = 5
CAB_BODY_DROP = 1.2  # putPlayerCar: nlTranslate(0, -1.2, 0) before the body (USA 0x0C02045C)
CAB_SLOTS = {0: "wheel_0", 1: "wheel_1", 2: "wheel_2", 3: "wheel_3", 4: "body", 5: "rear_5", 6: "rear_6"}
DECAL_ALPHA = 2  # TSP shading instruction (bits 6-7)
INTENSITY_1, INTENSITY_2 = 2, 3  # PCW colour type (bits 4-5)
VARIANTS = "KHR_materials_variants"


def f32(word):
    return struct.unpack("<f", struct.pack("<I", word))[0]


def model_files(source, executable):
    """{name: (data, base, model offsets)} for POLDC0-3."""
    files, city_base = {}, None
    for n in range(4):
        name = "POLDC%d.BIN" % n
        data = (source / name).read_bytes()
        offsets = set(m[0] for m in find_models(data))
        base = find_base(executable, offsets, len(data))
        if n and city_base is not None and base != city_base:
            raise ValueError("POLDC1-3 do not share a load address")
        if n:
            city_base = base
        files[name] = (data, base, offsets)
    return files


def addresses(files, name):
    data, base, offsets = files[name]
    return set(base + o for o in offsets)


def owner(pointers, files):
    """The one model file holding every pointer (POLDC0 first, then a unique POLDC1-3)."""
    if all(p in addresses(files, "POLDC0.BIN") for p in pointers):
        return "POLDC0.BIN"
    found = [n for n in ("POLDC1.BIN", "POLDC2.BIN", "POLDC3.BIN") if all(p in addresses(files, n) for p in pointers)]
    if len(found) != 1:
        raise ValueError("vehicle models are not in exactly one model file")
    return found[0]


def find_car_table(executable, models):
    """(table address, record count): the longest run of 0xA8-byte traffic records."""
    w = words(executable)
    end = LOAD + len(executable)

    def is_record(i):
        return i + RECORD_WORDS <= len(w) and w[i] in models and w[i + 1] in models \
            and (w[i + 2] == 0 or w[i + 2] in models) and LOAD <= w[i + 41] < end

    best = (0, 0)
    for i in range(len(w)):
        if is_record(i) and not (i >= RECORD_WORDS and is_record(i - RECORD_WORDS)):
            n = 1
            while is_record(i + n * RECORD_WORDS):
                n += 1
            if n > best[1]:
                best = (i, n)
    if best[1] < 8:
        raise ValueError("no traffic table")
    return LOAD + best[0] * 4, best[1]


def read_name(executable, pointer):
    raw = executable[pointer - LOAD:pointer - LOAD + 32]
    return raw.split(b"\0")[0].decode("ascii", "replace").strip()


def car_types(executable, files):
    """Every traffic record, its model file and its colour list, plus the colour table."""
    models = set()
    for name in files:
        models |= addresses(files, name)
    table, count = find_car_table(executable, models)
    colour_table = table + count * RECORD
    types, lists = [], []
    for k in range(count):
        r = struct.unpack_from("<%dI" % RECORD_WORDS, executable, table + k * RECORD - LOAD)
        pointers = [r[i] for i in MODEL_WORDS if r[i]]
        source = owner(pointers, files)
        indices = None
        if r[39]:
            indices = list(struct.unpack_from("<%dI" % COLOUR_LIST, executable, r[39] - LOAD))
            lists.append(indices)
        types.append(dict(index=k, name=read_name(executable, r[41]), source=source, words=r,
                          axles=[list(struct.unpack_from("<3f", executable, table + k * RECORD + 0x70 + 12 * a - LOAD))
                                 for a in range(3)],
                          colour_indices=indices))
    colours = []
    total = max(max(x) for x in lists) + 1 if lists else 0
    for c in range(total):
        rgb = struct.unpack_from("<3f", executable, colour_table + 12 * c - LOAD)
        if not all(0.0 <= v <= 1.0 for v in rgb):
            raise ValueError("colour %d is not an RGB triple" % c)
        colours.append([round(v, 6) for v in rgb])
    return dict(table=table, count=count, colour_table=colour_table, colours=colours, types=types)


def find_cab_tables(executable, models):
    """(address, set pointers, wheel pointers, point pointers): five model-set pointers, then
    five pointers to 15 floats and five to 12 floats."""
    w = words(executable)
    size = len(executable)

    def inside(p, n):
        return p % 4 == 0 and LOAD <= p and p - LOAD + 4 * n <= size

    def floats(p, n):  # zero or plausible magnitudes: pointers read as floats are ~1e-31
        return inside(p, n) and all(v == 0.0 or 1e-3 < abs(v) < 1000 for v in
                                    struct.unpack_from("<%df" % n, executable, p - LOAD))

    found = []
    for i in range(len(w) - 3 * CAB_SETS):
        sets = w[i:i + CAB_SETS]
        if not all(inside(p, 5) and all(x in models for x in struct.unpack_from("<5I", executable, p - LOAD))
                   for p in sets):
            continue
        wheels, points = w[i + CAB_SETS:i + 2 * CAB_SETS], w[i + 2 * CAB_SETS:i + 3 * CAB_SETS]
        if all(floats(p, 15) for p in wheels) and all(floats(p, 12) for p in points):
            found.append((LOAD + 4 * i, list(sets), list(wheels), list(points)))
    if len(found) != 1:
        raise ValueError("expected one cab table, found %d" % len(found))
    return found[0]


def cab_sets(executable, table, sets):
    """Each set's words: up to the next set (or the table) in memory, at most 16."""
    starts = sorted(set(sets)) + [table]
    result = []
    for p in sets:
        following = [s for s in starts if s > p]
        n = min(16, (following[0] - p) // 4) if following else 16
        result.append(list(struct.unpack_from("<%dI" % n, executable, p - LOAD)))
    return result


def read_png(path):
    """(width, height, RGBA bytes) of a PNG written by extract_textures.png_bytes (8-bit RGBA, unfiltered rows)."""
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("%s is not a PNG" % path)
    p, head, idat = 8, None, b""
    while p + 8 <= len(data):
        size, tag = struct.unpack_from(">I4s", data, p)
        if tag == b"IHDR":
            head = struct.unpack(">IIBBBBB", data[p + 8:p + 21])
        elif tag == b"IDAT":
            idat += data[p + 8:p + 8 + size]
        p += 12 + size
    if head is None or head[2:] != (8, 6, 0, 0, 0):
        raise ValueError("%s is not an 8-bit RGBA PNG" % path)
    width, height = head[:2]
    rows, stride = zlib.decompress(idat), width * 4 + 1
    if len(rows) != stride * height or any(rows[y * stride] for y in range(height)):
        raise ValueError("%s uses PNG row filters" % path)
    return width, height, b"".join(rows[y * stride + 1:(y + 1) * stride] for y in range(height))


def decal_alpha(rgba, colour):
    """PowerVR decal-alpha shading: RGB = texture RGB * texture A + colour RGB * (1 - texture A), A = colour A."""
    level = [min(255, max(0, int(round(255 * c)))) for c in colour]
    table = {}
    for k in range(0, len(rgba), 4):
        pixel = rgba[k:k + 4]
        if pixel not in table:
            a = pixel[3]
            table[pixel] = bytes([int(round((pixel[n] * a + level[n] * (255 - a)) / 255.0)) for n in range(3)]
                                 + [level[3]])
    return b"".join(table[rgba[k:k + 4]] for k in range(0, len(rgba), 4))


def mark_decals(model, textures):
    """Store the (A, R, G, B) face colour the PowerVR shows as "decal_face" on every decal-alpha
    textured record (None on the others); returns how many were marked.

    Colour type 3 (intensity mode 2) records carry no face colour to the PowerVR (the record
    drawer skips it), so they show the last colour type 2 record's face colour."""
    last, marked = None, 0
    for r in model["records"]:
        kind = r["pcw"] >> 4 & 3
        if kind == INTENSITY_1:
            last = tuple(r["face"])
        r["decal_face"] = None
        if r["tsp"] >> 6 & 3 != DECAL_ALPHA or not 0 <= r["texture"] < len(textures):
            continue
        if kind not in (INTENSITY_1, INTENSITY_2) or last is None:
            raise ValueError("decal-alpha record without a face colour")
        r["decal_face"] = last
        marked += 1
    return marked


def tint(face, paint):
    """RGBA of an (A, R, G, B) face colour times a fade-base RGB."""
    return tuple(round(face[1 + n] * paint[n], 6) for n in range(3)) + (round(face[0], 6),)


def prune(doc):
    """Drop materials, textures and images nothing refers to any more, renumbering references."""
    primitives = [p for m in doc["meshes"] for p in m["primitives"]]
    mappings = [x for p in primitives for x in p.get("extensions", {}).get(VARIANTS, {}).get("mappings", [])]
    keep = sorted(set(p["material"] for p in primitives) | set(x["material"] for x in mappings))
    renumber = dict((old, new) for new, old in enumerate(keep))
    doc["materials"] = [doc["materials"][k] for k in keep]
    for item in primitives + mappings:
        item["material"] = renumber[item["material"]]
    refs = [m["pbrMetallicRoughness"]["baseColorTexture"] for m in doc["materials"]
            if "baseColorTexture" in m["pbrMetallicRoughness"]]
    keep = sorted(set(r["index"] for r in refs))
    renumber = dict((old, new) for new, old in enumerate(keep))
    doc["textures"] = [doc["textures"][k] for k in keep]
    for r in refs:
        r["index"] = renumber[r["index"]]
    keep = sorted(set(t["source"] for t in doc["textures"]))
    renumber = dict((old, new) for new, old in enumerate(keep))
    doc["images"] = [doc["images"][k] for k in keep]
    for t in doc["textures"]:
        t["source"] = renumber[t["source"]]


class VehicleGltf(Gltf):
    """Gltf whose material keys end with the record's decal face colour (None when not decal alpha)."""

    def material_key(self, record):
        return material_key(record, self.textures) + (record.get("decal_face"),)


class Builder(object):
    """One vehicle GLB: named scenes, one node per placed model, meshes shared by address."""

    def __init__(self, bank_name, bank, root, data, base, scenes, texture_dir=None):
        self.gltf = VehicleGltf(bank_name, bank, root)
        self.gltf.doc["scenes"] = [dict(name=s, nodes=[]) for s in scenes]
        self.data, self.base, self.meshes, self.triangles, self.placed = data, base, {}, 0, []
        self.texture_dir, self.bodies, self.images = texture_dir, set(), {}

    def put(self, scene, label, address, translation=None):
        offset = address - self.base
        if address not in self.meshes:
            model = parse_model(self.data, offset)
            mark_decals(model, self.gltf.textures)
            mesh, tris = self.gltf.mesh("%s_%06x" % (label, offset), model)
            self.meshes[address] = mesh
            self.triangles += tris
        if label == "body" and self.meshes[address] is not None:
            self.bodies.add(self.meshes[address])
        item = dict(name="%s_%06x" % (label, offset), extras=dict(offset=offset))
        if self.meshes[address] is not None:
            item["mesh"] = self.meshes[address]
        if translation and any(translation):
            item["translation"] = [round(v, 6) for v in translation]
        self.gltf.doc["nodes"].append(item)
        index = len(self.gltf.doc["nodes"]) - 1
        self.gltf.doc["scenes"][scene]["nodes"].append(index)
        self.placed.append(dict(scene=self.gltf.doc["scenes"][scene]["name"], part=label, offset=offset,
                                translation=item.get("translation", [0.0, 0.0, 0.0])))

    def baked_texture(self, number, colour, sampler):
        """Texture index of an embedded PNG: texture `number` baked with decal alpha over `colour`."""
        doc = self.gltf.doc
        if (number, colour) not in self.images:
            width, height, rgba = read_png(self.texture_dir / self.gltf.textures[number]["png"])
            payload = png_bytes(width, height, decal_alpha(rgba, colour))
            while len(self.gltf.blob) % 4:
                self.gltf.blob.append(0)
            doc["bufferViews"].append(dict(buffer=0, byteOffset=len(self.gltf.blob), byteLength=len(payload)))
            self.gltf.blob.extend(payload)
            doc.setdefault("images", []).append(dict(bufferView=len(doc["bufferViews"]) - 1, mimeType="image/png"))
            self.images[(number, colour)] = len(doc["images"]) - 1
        doc["textures"].append(dict(source=self.images[(number, colour)], sampler=sampler))
        return len(doc["textures"]) - 1

    def paint(self, paints=(), default=0):
        """Bake every decal-alpha material: primitives of body meshes get paints[default] (an RGB
        fade base) and one KHR_materials_variants variant per paint; others keep the face colour."""
        doc = self.gltf.doc
        keys = dict((v, k) for k, v in self.gltf.material_ids.items())
        baked, decals = {}, []
        for mesh, item in enumerate(doc["meshes"]):
            decals += [(mesh, p) for p in item["primitives"] if keys[p["material"]][-1] is not None]

        def material(key, colour):
            if (key, colour) not in baked:
                item = json.loads(json.dumps(doc["materials"][self.gltf.material_ids[key]]))
                pbr = item["pbrMetallicRoughness"]
                sampler = doc["textures"][pbr["baseColorTexture"]["index"]]["sampler"]
                pbr["baseColorTexture"] = dict(index=self.baked_texture(key[0], colour, sampler))
                item["name"] += "_decal_%02x%02x%02x" % tuple(int(round(255 * c)) for c in colour[:3])
                item["extras"]["decal_alpha_colour"] = list(colour)
                doc["materials"].append(item)
                baked[(key, colour)] = len(doc["materials"]) - 1
            return baked[(key, colour)]

        if paints and any(mesh in self.bodies for mesh, _ in decals):
            doc.setdefault("extensionsUsed", []).append(VARIANTS)
            doc.setdefault("extensions", {})[VARIANTS] = dict(variants=[dict(name=name) for name, _ in paints])
        painted = 0
        for mesh, primitive in decals:
            key = keys[primitive["material"]]
            if not (paints and mesh in self.bodies):
                primitive["material"] = material(key, tint(key[-1], (1.0, 1.0, 1.0)))
                continue
            choices = [material(key, tint(key[-1], rgb)) for _, rgb in paints]
            primitive["material"] = choices[default]
            mapping = {}
            for variant, m in enumerate(choices):
                mapping.setdefault(m, []).append(variant)
            primitive["extensions"] = {VARIANTS: dict(mappings=[dict(material=m, variants=v)
                                                                for m, v in sorted(mapping.items())])}
            painted += 1
        if decals:
            prune(doc)
        return dict(decal_primitives=len(decals), painted_primitives=painted, baked_images=len(self.images))

    def glb(self):
        self.gltf.doc["scenes"] = [s for s in self.gltf.doc["scenes"] if s["nodes"]]
        return self.gltf.glb()


def traffic_parts(r, axles):
    """[(scene, label, address, translation)] by putCarModel."""
    parts = []
    for lod, scene in ((0, 0), (1, 1)):
        for label, word in (("body", 0), ("shadow", 2), ("extra", 4)):
            if r[word + lod]:
                parts.append((scene, label, r[word + lod], None))
    if r[0x60 // 4]:
        for k, (model, mirror) in enumerate(((0x58, 0x5C), (0x60, 0x64), (0x68, 0x6C))):
            x, y, z = axles[k]
            if r[model // 4]:
                parts.append((0, "wheel_%d" % k, r[model // 4], (x, y, z)))
                if r[mirror // 4]:
                    parts.append((0, "wheel_%d_mirror" % k, r[mirror // 4], (-x, y, z)))
    for group, start in (("a", 6), ("b", 14)):
        for lod in (0, 1):
            for n in range(4):
                if r[start + 4 * lod + n]:
                    parts.append((2, "lamp_%s_%s_%d" % (group, ("near", "far")[lod], n), r[start + 4 * lod + n], None))
    return parts


def cab_parts(models, wheels):
    """[(scene, label, address, translation)] by putPlayerCar (scene 1: entries it does not draw)."""
    parts = []
    for slot, address in enumerate(models):
        if not address:
            continue
        if slot < 4:
            parts.append((0, "wheel_%d" % slot, address, tuple(wheels[3 * slot:3 * slot + 3])))
        elif slot in (4, 6):
            parts.append((0, CAB_SLOTS[slot], address, (0.0, -CAB_BODY_DROP, 0.0)))
        elif 9 <= slot <= 12:
            k = slot - 9
            parts.append((1, "slot_%d" % slot, address, tuple(wheels[3 * k:3 * k + 3])))
        else:
            parts.append((1, CAB_SLOTS.get(slot, "slot_%d" % slot), address, (0.0, -CAB_BODY_DROP, 0.0)))
    return parts


def extract(source, textures, output):
    source, textures, output = Path(source).resolve(), Path(textures).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    files = model_files(source, executable)
    traffic = car_types(executable, files)
    poldc0 = addresses(files, "POLDC0.BIN")
    cab_table, set_pointers, wheel_pointers, point_pointers = find_cab_tables(executable, poldc0)
    sets = cab_sets(executable, cab_table, set_pointers)
    for models in sets:
        if not all(m == 0 or m in poldc0 for m in models):
            raise ValueError("cab set entry is not a POLDC0 model")
    banks = dict((b["source"], b["textures"]) for b in json.loads((textures / "manifest.json").read_text())["banks"])
    root = "../../%s/" % textures.name
    manifest = dict(
        schema=1, textures=textures.name,
        sources=dict([("1ST_READ.BIN", dict(size=len(executable), sha256=digest(executable)))] +
                     [(n, dict(size=len(f[0]), sha256=digest(f[0]), base=f[1])) for n, f in sorted(files.items())]),
        car_table=traffic["table"], car_types=traffic["count"], colour_table=traffic["colour_table"],
        colours=traffic["colours"], cab_table=cab_table, cab_body_drop=CAB_BODY_DROP, traffic=[], cabs=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi vehicles</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}'
               '.c{display:inline-block;width:10px;height:10px;margin:0 1px}</style>',
               '<h1>Local Crazy Taxi vehicles</h1><p>Scene 0 is the car as drawn near; traffic GLBs also hold '
               'a "far" scene and a "lamps" scene, cab GLBs an "alternates" scene. Serve this folder\'s parent '
               'over HTTP to view them.</p><h2>Traffic</h2><table>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".vehicles-", dir=output.parent))
    try:
        (staging / "traffic").mkdir()
        (staging / "cabs").mkdir()
        for t in traffic["types"]:
            data, base, _ = files[t["source"]]
            bank = t["source"].replace("POLDC", "TEXDC")
            builder = Builder(bank, banks[bank], root, data, base, ("near", "far", "lamps"), textures)
            for scene, label, address, translation in traffic_parts(t["words"], t["axles"]):
                builder.put(scene, label, address, translation)
            variants = sorted(set(t["colour_indices"] or []))
            default = t["colour_indices"][0] if variants else None
            paint = builder.paint([("paint_%02d" % c, traffic["colours"][c]) for c in variants],
                                  variants.index(default) if variants else 0)
            r = t["words"]
            entry = dict(index=t["index"], name=t["name"], source=t["source"], texture_bank=bank,
                         axles=[[round(v, 6) for v in a] for a in t["axles"]],
                         value_94=round(f32(r[37]), 6), value_98=round(f32(r[38]), 6), value_a0=r[40],
                         colour_indices=t["colour_indices"], paint=dict(paint, default=default, variants=variants),
                         parts=builder.placed)
            relative = "traffic/type_%02d_%s.glb" % (t["index"], t["name"].lower() or "unnamed")
            blob = builder.glb()
            (staging / relative).write_bytes(blob)
            entry.update(glb=relative, glb_sha256=digest(blob), triangles=builder.triangles)
            manifest["traffic"].append(entry)
            swatches = "".join('<span class="c" style="background:rgb(%d,%d,%d)"></span>'
                               % tuple(int(255 * v) for v in traffic["colours"][c])
                               for c in sorted(set(t["colour_indices"] or [])))
            gallery.append('<tr><td>%d</td><td><a href="%s">%s</a></td><td>%s</td><td>%d triangles</td><td>%s</td></tr>'
                           % (t["index"], relative, html.escape(t["name"]), t["source"], builder.triangles, swatches))
        gallery.append("</table><h2>Cabs</h2><table>")
        data, base, _ = files["POLDC0.BIN"]
        cabbies = ("Axel", "B.D. Joe", "Gena", "Gus", "default")  # assumed: selection-screen order, entry 4 default
        for k, models in enumerate(sets):
            wheels = list(struct.unpack_from("<15f", executable, wheel_pointers[k] - LOAD))
            points = list(struct.unpack_from("<12f", executable, point_pointers[k] - LOAD))
            builder = Builder("TEXDC0.BIN", banks["TEXDC0.BIN"], root, data, base, ("car", "alternates"), textures)
            for scene, label, address, translation in cab_parts(models, wheels):
                builder.put(scene, label, address, translation)
            paint = builder.paint()
            relative = "cabs/cab_%d.glb" % k
            blob = builder.glb()
            (staging / relative).write_bytes(blob)
            manifest["cabs"].append(dict(index=k, name=cabbies[k], set=set_pointers[k], models=models,
                                         wheel_positions=[round(v, 6) for v in wheels],
                                         points_70=[round(v, 6) for v in points], paint=paint, parts=builder.placed,
                                         glb=relative, glb_sha256=digest(blob), triangles=builder.triangles))
            gallery.append('<tr><td>%d</td><td><a href="%s">%s</a></td><td>%s</td><td>%d triangles</td></tr>'
                           % (k, relative, relative, cabbies[k], builder.triangles))
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
    parser.add_argument("--textures", type=Path, required=True, help="extract_textures.py output (sibling of output)")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.textures, args.output)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Assembled %d traffic types and %d cabs into %s" % (len(manifest["traffic"]), len(manifest["cabs"]),
                                                                args.output))


if __name__ == "__main__":
    main()
