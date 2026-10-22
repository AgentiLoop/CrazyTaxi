#!/usr/bin/env python3
"""Place Crazy Taxi's set objects (postboxes, signs, crates...) from OBJDC1-3 as glTF binaries.

OBJDCn.BIN is the placement file of city n (loadCity: Arcade, Original, Crazy Box). The game
loads its first 0x8000 bytes at a fixed address and uses the pointers inside unchanged:

* Groups: 32 bytes from the start, until the first empty one: centre (3 floats), +0x10 the
  instance count (16 bits), +0x14 the first instance record (an absolute address).
* Instance records: 32 bytes: position (3 floats), +0x0C the Y angle (16-bit binary angle),
  +0x10 the kind (16 bits), +0x12 the variant, +0x14 the next record of the group (0 ends).

The executable gives each kind its model and collision (found by shape, no regional addresses):

* The kind table: 0x24-byte records: sphere offsets (pointer to 12-byte vectors), sphere
  radii (pointer to 8-byte entries, radius at +4), the sphere count, +0x0C an X angle,
  +0x10 the hit handler, +0x14 flags, +0x18 the mass.
* The model table: one pointer per kind to an array of model pointers indexed by variant.

Placement follows setObjPlace / SetObjFly (USA disassembly): translate to the position,
nlRotateAY(angle), nlRotateAX(kind X angle), then the model. Models in POLDC0 use TEXDC0, the
city's own models (POLDCn) use TEXDCn. Which groups a run can open is fixed in InitSetObject
(USA 0x0C037728): Arcade groups 0-57 with group 24 emptied, Original 0-62, Crazy Box a range
per mini game. Groups no run opens go to an "unused" scene.

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
    from tools.extract_models import Gltf, digest, find_models, parse_model
    from tools.extract_characters import LOAD, find_base, words
except ImportError:  # run as a script from the tools directory
    from extract_models import Gltf, digest, find_models, parse_model
    from extract_characters import LOAD, find_base, words

LOADED = 0x8000  # loadCity: gdc_FileLoad(objDC, 0x8000)
GROUP = 32
INSTANCE = 32
KIND = 0x24
CITIES = ("Arcade", "Original", "Crazy Box")
# InitSetObject (USA 0x0C037728-0x0C0378C8): the group range each run walks.
RUNS = {
    1: [dict(run="Arcade", first=0, end=58, emptied=[24])],
    2: [dict(run="Original", first=0, end=63, emptied=[])],
    3: [dict(run="Crazy Box MiniGame_No 3", first=0, end=1, emptied=[]),
        dict(run="Crazy Box MiniGame_No 1", first=1, end=3, emptied=[]),
        dict(run="Crazy Box MiniGame_No 8", first=3, end=4, emptied=[]),
        dict(run="Crazy Box MiniGame_No 9", first=4, end=10, emptied=[]),
        dict(run="Crazy Box MiniGame_No 14", first=10, end=24, emptied=[]),
        dict(run="Crazy Box other games", first=24, end=58, emptied=[])],
}


def f32(word):
    return struct.unpack("<f", struct.pack("<I", word))[0]


def parse_objects(data, base):
    """[group] with instances, read the way setObjGroupExec walks them."""
    if len(data) < LOADED:
        raise ValueError("placement file shorter than its load size")
    groups = []
    for g in range(LOADED // GROUP):
        x, y, z = struct.unpack_from("<3f", data, g * GROUP)
        count, = struct.unpack_from("<h", data, g * GROUP + 0x10)
        pointer, = struct.unpack_from("<I", data, g * GROUP + 0x14)
        if count <= 0 and not pointer:
            break
        instances, seen = [], set()
        while pointer:
            offset = pointer - base
            if not GROUP * (g + 1) <= offset <= LOADED - INSTANCE or offset % INSTANCE or offset in seen:
                raise ValueError("group %d: record pointer 0x%08X outside the loaded file" % (g, pointer))
            seen.add(offset)
            px, py, pz, angle, kind, variant, pointer = struct.unpack_from("<3fIhhI", data, offset)
            if not all(math.isfinite(v) for v in (px, py, pz)) or kind < 0:
                raise ValueError("group %d: bad record at 0x%X" % (g, offset))
            instances.append(dict(record=offset, position=[px, py, pz], angle=angle & 0xFFFF,
                                  kind=kind, variant=variant))
        if len(instances) != count:
            raise ValueError("group %d: count %d but %d records" % (g, count, len(instances)))
        groups.append(dict(index=g, centre=[x, y, z], instances=instances))
    if not groups:
        raise ValueError("no set object groups")
    return groups


def find_objects_base(executable, files):
    """The one 64 KiB-aligned executable word that every file's record pointers fit under."""
    candidates = set(w for w in words(executable) if 0x0C000000 <= w < 0x0D000000 and not w & 0xFFFF)
    found = []
    for base in sorted(candidates):
        try:
            for data in files:
                parse_objects(data, base)
        except ValueError:
            continue
        found.append(base)
    if len(found) != 1:
        raise ValueError("expected one placement load address, found %d" % len(found))
    return found[0]


def find_kind_table(executable):
    """(address, count): the longest run of 0x24-byte kind records."""
    w = words(executable)
    end = LOAD + len(executable)
    n = KIND // 4

    def is_kind(i):
        if i + n > len(w):
            return False
        mass = f32(w[i + 6])
        return all(LOAD <= w[i + k] < end and w[i + k] % 4 == 0 for k in (0, 1)) and 1 <= w[i + 2] <= 64 \
            and w[i + 3] < 0x10000 and (w[i + 4] == 0 or LOAD <= w[i + 4] < end) \
            and math.isfinite(mass) and 0.0 < mass < 1e6 and w[i + 7] == 0 and w[i + 8] == 0

    best = (0, 0)
    for i in range(len(w)):
        if is_kind(i) and not (i >= n and is_kind(i - n)):
            k = 1
            while is_kind(i + k * n):
                k += 1
            if k > best[1]:
                best = (i, k)
    if best[1] < 8:
        raise ValueError("no set object kind table")
    return LOAD + 4 * best[0], best[1]


def read_kinds(executable, table, count):
    kinds = []
    for k in range(count):
        r = struct.unpack_from("<9I", executable, table + k * KIND - LOAD)
        offsets = [list(struct.unpack_from("<3f", executable, r[0] + 12 * s - LOAD)) for s in range(r[2])]
        radii = [struct.unpack_from("<If", executable, r[1] + 8 * s - LOAD) for s in range(r[2])]
        kinds.append(dict(index=k, sphere_offsets=[[round(v, 6) for v in o] for o in offsets],
                          sphere_radii=[round(v[1], 6) for v in radii], sphere_words=[v[0] for v in radii],
                          x_angle=r[3], hit_handler=r[4], flags=r[5], mass=round(f32(r[6]), 6)))
    return kinds


def find_model_table(executable, count, models):
    """(address, [array address]): `count` pointers to arrays whose first word is a model."""
    w = words(executable)
    end = LOAD + len(executable)

    def ok(p):
        return LOAD <= p < end and p % 4 == 0 and w[(p - LOAD) // 4] in models

    found = [i for i in range(len(w) - count + 1)  # a run of exactly `count` (the character table is longer)
             if all(ok(w[i + k]) for k in range(count)) and not (i and ok(w[i - 1]))
             and not (i + count < len(w) and ok(w[i + count]))]
    if len(found) != 1:
        raise ValueError("expected one set object model table, found %d" % len(found))
    i = found[0]
    return LOAD + 4 * i, list(w[i:i + count])


def model_arrays(executable, table, arrays):
    """Each kind's model pointers: up to the next array (or the table) in memory."""
    starts = sorted(set(arrays)) + [table]
    result = []
    for p in arrays:
        n = (min(s for s in starts if s > p) - p) // 4
        result.append(list(struct.unpack_from("<%dI" % n, executable, p - LOAD)))
    return result


def quaternion(y_angle, x_angle):
    """glTF (x, y, z, w) of nlRotateAY(y) then nlRotateAX(x) (binary angles, 0x10000 a turn)."""
    a = (y_angle & 0xFFFF) * math.pi / 65536.0  # half angles
    b = (x_angle & 0xFFFF) * math.pi / 65536.0
    sy, cy, sx, cx = math.sin(a), math.cos(a), math.sin(b), math.cos(b)
    return [cy * sx, sy * cx, -sy * sx, cy * cx]


class Builder(Gltf):
    """One GLB holding models from two texture banks (materials and images kept per bank)."""

    def __init__(self, banks, root):
        Gltf.__init__(self, None, None, root)
        self.banks, self.state, self.meshes, self.triangles = banks, {}, {}, 0

    def use(self, bank):
        if bank not in self.state:
            self.state[bank] = ({}, {}, {})
        self.texture_bank, self.textures = bank, self.banks[bank]
        self.material_ids, self.image_ids, self.texture_ids = self.state[bank]

    def model(self, source, bank, data, offset):
        key = (source, offset)
        if key not in self.meshes:
            self.use(bank)
            mesh, tris = self.mesh("%s_%06x" % (source.split(".")[0], offset), parse_model(data, offset))
            self.meshes[key] = mesh
            self.triangles += tris
        return self.meshes[key]


def extract(source, textures, output):
    source, textures, output = Path(source).resolve(), Path(textures).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    placements = [(source / ("OBJDC%d.BIN" % n)).read_bytes() for n in (1, 2, 3)]
    base = find_objects_base(executable, placements)
    kind_table, kind_count = find_kind_table(executable)
    kinds = read_kinds(executable, kind_table, kind_count)
    files, city_base = {}, None
    for n in range(4):
        name = "POLDC%d.BIN" % n
        data = (source / name).read_bytes()
        offsets = set(m[0] for m in find_models(data))
        files[name] = (data, find_base(executable, offsets, len(data)), offsets)
        if n:
            if city_base is not None and files[name][1] != city_base:
                raise ValueError("POLDC1-3 do not share a load address")
            city_base = files[name][1]
    every = set()
    for data, b, offsets in files.values():
        every |= set(b + o for o in offsets)
    model_table, arrays = find_model_table(executable, kind_count, every)
    variants = model_arrays(executable, model_table, arrays)
    banks = dict((b["source"], b["textures"]) for b in json.loads((textures / "manifest.json").read_text())["banks"])
    root = "../%s/" % textures.name
    manifest = dict(schema=1, textures=textures.name, objects_base=base, loaded_bytes=LOADED,
                    kind_table=kind_table, model_table=model_table,
                    sources=dict([(n, dict(size=len(d), sha256=digest(d))) for n, d in
                                  [("1ST_READ.BIN", executable)] +
                                  [("OBJDC%d.BIN" % (k + 1), p) for k, p in enumerate(placements)]] +
                                 [(n, dict(size=len(f[0]), sha256=digest(f[0]), base=f[1]))
                                  for n, f in sorted(files.items())]),
                    kinds=[dict(k, models=variants[k["index"]]) for k in kinds], cities=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi set objects</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
               '<h1>Local Crazy Taxi set objects</h1><p>World coordinates, the same space as models/BINCn.glb. '
               'Scene 0 holds the groups a run opens, scene 1 ("unused") the rest. Serve this folder\'s '
               'parent over HTTP to view them.</p><table>']
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".props-", dir=output.parent))
    try:
        for n in (1, 2, 3):
            city = "POLDC%d.BIN" % n
            groups = parse_objects(placements[n - 1], base)
            runs = RUNS[n]
            opened = set(g for r in runs for g in range(r["first"], r["end"]) if g not in r["emptied"])
            builder = Builder(banks, root)
            builder.doc["scenes"] = [dict(name="props", nodes=[]), dict(name="unused", nodes=[])]
            counts, entry_groups = {}, []
            for group in groups:
                g = group["index"]
                parent = dict(name="group_%02d" % g, children=[],
                              extras=dict(centre=[round(v, 4) for v in group["centre"]],
                                          runs=[r["run"] for r in runs
                                                if r["first"] <= g < r["end"] and g not in r["emptied"]]))
                items = []
                for i, inst in enumerate(group["instances"]):
                    k, v = inst["kind"], inst["variant"]
                    if k >= kind_count or v >= len(variants[k]):
                        raise ValueError("OBJDC%d group %d: kind %d variant %d has no model" % (n, g, k, v))
                    pointer = variants[k][v]
                    owner = [m for m in ("POLDC0.BIN", city)
                             if 0 <= pointer - files[m][1] and pointer - files[m][1] in files[m][2]]
                    if len(owner) != 1:
                        raise ValueError("OBJDC%d kind %d variant %d: model 0x%08X not in POLDC0 or %s"
                                         % (n, k, v, pointer, city))
                    m = owner[0]
                    offset = pointer - files[m][1]
                    mesh = builder.model(m, m.replace("POLDC", "TEXDC"), files[m][0], offset)
                    rotation = quaternion(inst["angle"], kinds[k]["x_angle"])
                    node = dict(name="g%02d_%02d_kind%02d_v%02d" % (g, i, k, v),
                                translation=[round(c, 4) for c in inst["position"]],
                                extras=dict(kind=k, variant=v, angle=inst["angle"], model=m, offset=offset))
                    if any(abs(c) > 1e-9 for c in rotation[:3]):
                        node["rotation"] = [round(c, 7) for c in rotation]
                    if mesh is not None:
                        node["mesh"] = mesh
                    builder.doc["nodes"].append(node)
                    parent["children"].append(len(builder.doc["nodes"]) - 1)
                    counts[k] = counts.get(k, 0) + 1
                    items.append(dict(record=inst["record"], kind=k, variant=v, angle=inst["angle"],
                                      position=[round(c, 4) for c in inst["position"]],
                                      model=m, offset=offset))
                builder.doc["nodes"].append(parent)
                builder.doc["scenes"][0 if g in opened else 1]["nodes"].append(len(builder.doc["nodes"]) - 1)
                entry_groups.append(dict(index=g, centre=parent["extras"]["centre"], opened=g in opened,
                                         runs=parent["extras"]["runs"], instances=items))
            builder.doc["scenes"] = [s for s in builder.doc["scenes"] if s["nodes"]]
            blob = builder.glb()
            relative = "OBJDC%d.glb" % n
            (staging / relative).write_bytes(blob)
            total = sum(len(g["instances"]) for g in groups)
            manifest["cities"].append(dict(file="OBJDC%d.BIN" % n, city=CITIES[n - 1], models=city, runs=runs,
                                           groups=entry_groups, instances=total,
                                           kinds=dict((str(k), c) for k, c in sorted(counts.items())),
                                           glb=relative, glb_sha256=digest(blob), triangles=builder.triangles))
            gallery.append('<tr><td><a href="%s">%s</a></td><td>%s</td><td>%d groups</td><td>%d objects</td>'
                           '<td>%d triangles</td></tr>' % (relative, relative, html.escape(CITIES[n - 1]),
                                                          len(groups), total, builder.triangles))
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
    print("Placed %s set objects into %s" % ("/".join(str(c["instances"]) for c in manifest["cities"]),
                                              args.output))


if __name__ == "__main__":
    main()
