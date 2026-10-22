#!/usr/bin/env python3
"""Convert Crazy Taxi's flat nlObjPut models to glTF 2.0 binaries (stdlib only).

Format reference: supplied decomp docs/engine.md ("Textures and the model draw") and
tools/model_map.py find_models/record_ok. No upstream imports.

A model is a 24-byte header (two words, then a bounding sphere cx cy cz r) followed by
records. A record is 20 words (PCW, ISP, TSP, TCW, sphere, texture number, specular,
ambient, face colour ARGB, offset colour ARGB, strip byte length) and its strips. A strip
is gflag, polygon count, then entries: a full vertex (x y z nx ny nz u v floats) or a
two-word reference (non-finite first word, signed byte offset) to an earlier full vertex
of the same record. gflag bit 3 means a triangle list (3 entries per polygon); otherwise
the entries form a triangle strip. A 0 word ends the model.

POLDC0-3 models become one GLB each; every BINC city archive becomes one GLB whose nodes
are its AFS entries (city pieces are stored in world coordinates). Coordinates are kept
exactly as stored. Textures are referenced from the TEXDC PNGs written by
extract_textures.py (POLDCn and BINCn use TEXDCn), never embedded.
"""
import argparse
import hashlib
import html
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

MODEL_FILES = ("POLDC0.BIN", "POLDC1.BIN", "POLDC2.BIN", "POLDC3.BIN")
CITY_FILES = ("BINC1.AFS", "BINC2.AFS", "BINC3.AFS")
MAX_RECORD_BYTES = 0x400000
MAX_POLYGONS = 4096  # decomp model_map caps at 200; three city pieces have 206-302 entry strips


def f32(word):
    return struct.unpack("<f", struct.pack("<I", word))[0]


def s32(word):
    return word - (1 << 32) if word & 0x80000000 else word


def is_reference(word):
    value = f32(word)
    return value != value or abs(value) > 1e9


def record_length(words, i):
    """Record size in words when word i plausibly starts a record header, else 0."""
    if i < 6 or i + 20 > len(words) or words[i] & 0xFCFFFF00 != 0x80000000 or words[i + 1] >> 28 < 8:
        return 0
    size = words[i + 19]
    if size == 0 or size & 3 or size > MAX_RECORD_BYTES or i + 20 + size // 4 > len(words):
        return 0
    return 20 + size // 4


def finite_or(value, fallback):
    return value if math.isfinite(value) else fallback


def decode_vertex(w, coloured):
    """(x y z nx ny nz u v r g b a, repaired) from 8 vertex words.

    Plain vertices are 8 floats. Records with specular -3 (drawn through the game's vertex
    colour routine) store word 3 as a signed-byte normal (x, y, z / 127) and words 4-5 as
    ARGB colours (the first is used). Non-finite normal or UV values are replaced and counted.
    """
    x, y, z = (f32(v) for v in w[0:3])
    if not all(math.isfinite(v) for v in (x, y, z)):
        raise ValueError("non-finite vertex position")
    if coloured:
        normal = [((w[3] >> s & 255) ^ 128) - 128 for s in (0, 8, 16)]
        colour = [(w[4] >> s & 255) / 255.0 for s in (16, 8, 0, 24)]
    else:
        normal = [f32(v) for v in w[3:6]]
        colour = [1.0, 1.0, 1.0, 1.0]
    uv = [f32(v) for v in w[6:8]]
    repaired = not all(math.isfinite(v) for v in normal + uv)
    normal = [finite_or(v, 0.0) for v in normal]
    length = math.sqrt(sum(v * v for v in normal))
    normal = [v / length for v in normal] if length > 1e-6 else [0.0, 1.0, 0.0]
    uv = [finite_or(v, 0.0) for v in uv]
    return (x, y, z) + tuple(normal) + tuple(uv) + tuple(colour), repaired


def parse_strips(words, start, end, vertices, first_vertex, coloured=False):
    """Parse the strips in words[start:end]. Appends full vertices; returns (strips, repaired count)."""
    strips, seen, p, repairs = [], {}, start, 0
    while p < end:
        if p + 2 > end:
            raise ValueError("truncated strip header")
        gflag, count = words[p], words[p + 1]
        if gflag == 0 or gflag >= 0x1000 or not 0 < count <= MAX_POLYGONS:
            raise ValueError("bad strip header at word %d" % p)
        entries = count * 3 if gflag & 8 else count
        if not gflag & 8 and count < 3:
            raise ValueError("strip with fewer than three vertices")
        p += 2
        indices = []
        for _ in range(entries):
            if p + 2 > end:
                raise ValueError("truncated strip entry")
            if is_reference(words[p]):
                target = (p * 4 + s32(words[p + 1]) + 8) // 4
                if target not in seen:
                    raise ValueError("vertex reference does not point to an earlier vertex")
                indices.append(seen[target])
                p += 2
            else:
                if p + 8 > end:
                    raise ValueError("truncated vertex")
                values, repaired = decode_vertex(words[p:p + 8], coloured)
                repairs += repaired
                seen[p] = first_vertex + len(vertices)
                indices.append(seen[p])
                vertices.append(values)
                p += 8
        strips.append(dict(gflag=gflag, count=count, indices=indices))
    if p != end:
        raise ValueError("strip data overruns record")
    return strips, repairs


def parse_model(data, offset):
    """Parse the model at byte offset; raises ValueError when it is malformed."""
    if offset % 4 or offset + 24 > len(data):
        raise ValueError("bad model offset")
    words = struct.unpack_from("<%dI" % (len(data) // 4), data)
    head = offset // 4
    sphere = [f32(w) for w in words[head + 2:head + 6]]
    if not (sphere[3] == sphere[3] and 1e-4 <= abs(sphere[3]) < 1e9):
        raise ValueError("model radius out of range")
    vertices, records, i, repairs = [], [], head + 6, 0
    while True:
        size = record_length(words, i)
        if not size:
            break
        w = words[i:i + 20]
        local = []
        strips, repaired = parse_strips(words, i + 20, i + size, local, len(vertices), s32(w[9]) == -3)
        repairs += repaired
        vertices.extend(local)
        records.append(dict(
            pcw=w[0], isp=w[1], tsp=w[2], tcw=w[3], sphere=[f32(x) for x in w[4:8]],
            texture=s32(w[8]), specular=s32(w[9]), ambient=f32(w[10]),
            face=[f32(x) for x in w[11:15]], offset_colour=[f32(x) for x in w[15:19]],
            strip_bytes=w[19], strips=strips))
        i += size
    if not records:
        raise ValueError("no records")
    return dict(offset=offset, kind=words[head], flags=words[head + 1], sphere=sphere,
                records=records, vertices=vertices, end=i * 4, repaired=repairs)


def find_models(data):
    """Every well-formed model chain: [(offset, records, strip bytes, radius, max texture)]."""
    words = struct.unpack_from("<%dI" % (len(data) // 4), data)
    following = {}
    for i in range(6, len(words) - 19):
        size = record_length(words, i)
        if size:
            following[i] = i + size
    continued = set(j for j in following.values() if j in following)
    found = []
    for i in sorted(following):
        if i in continued:
            continue
        try:
            model = parse_model(data, (i - 6) * 4)
        except ValueError:
            continue
        found.append((model["offset"], len(model["records"]),
                      sum(r["strip_bytes"] for r in model["records"]), model["sphere"][3],
                      max(r["texture"] for r in model["records"])))
    return found


def triangles(strip):
    """Triangle index triples of a strip, alternating winding, without degenerates."""
    idx = strip["indices"]
    if strip["gflag"] & 8:
        tris = [tuple(idx[k:k + 3]) for k in range(0, len(idx), 3)]
    else:
        tris = [(idx[k], idx[k + 1], idx[k + 2]) if k % 2 == 0 else (idx[k + 1], idx[k], idx[k + 2])
                for k in range(len(idx) - 2)]
    return [t for t in tris if len(set(t)) == 3]


def facing(tri, vertices):
    """Order a triangle counter-clockwise relative to its stored vertex normals."""
    a, b, c = (vertices[k] for k in tri)
    e1 = [b[n] - a[n] for n in range(3)]
    e2 = [c[n] - a[n] for n in range(3)]
    cross = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
    normal = [a[3 + n] + b[3 + n] + c[3 + n] for n in range(3)]
    return tri if sum(x * y for x, y in zip(cross, normal)) >= 0 else (tri[0], tri[2], tri[1])


def wrap(flip, clamp):
    return 33648 if flip else 33071 if clamp else 10497


def material_key(record, textures):
    """Hashable material description from the record's PowerVR words."""
    tsp, pcw = record["tsp"], record["pcw"]
    texture = record["texture"] if 0 <= record["texture"] < len(textures) else None
    shading = tsp >> 6 & 3
    colour = tuple(round(c, 4) for c in record["face"][1:] + record["face"][:1])
    if texture is not None and shading in (0, 2):
        colour = (1.0, 1.0, 1.0, colour[3])
    polygon_list = pcw >> 24 & 7
    mode = "BLEND" if polygon_list in (1, 2, 3) else "MASK" if polygon_list == 4 else "OPAQUE"
    double = any(s["gflag"] & 3 == 0 for s in record["strips"])
    return (texture, colour, mode, double, tsp >> 18 & 1, tsp >> 17 & 1, tsp >> 16 & 1, tsp >> 15 & 1,
            tsp >> 13 & 3, record["specular"] == -3)


class Gltf(object):
    """Minimal glTF 2.0 binary builder."""

    def __init__(self, texture_bank, textures, texture_root):
        self.blob = bytearray()
        self.doc = dict(asset=dict(version="2.0", generator="CrazyTaxi tools/extract_models.py"),
                        scene=0, scenes=[dict(nodes=[])], nodes=[], meshes=[], accessors=[], bufferViews=[],
                        materials=[], buffers=[])
        self.texture_bank, self.textures, self.texture_root = texture_bank, textures, texture_root
        self.material_ids, self.image_ids, self.sampler_ids, self.texture_ids = {}, {}, {}, {}

    def view(self, payload, target):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.doc["bufferViews"].append(dict(buffer=0, byteOffset=len(self.blob), byteLength=len(payload),
                                            target=target))
        self.blob.extend(payload)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, values, kind, width, target, bounds=False):
        if kind == 5126:
            payload = struct.pack("<%df" % len(values), *values)
        elif kind == 5123:
            payload = struct.pack("<%dH" % len(values), *values)
        else:
            payload = struct.pack("<%dI" % len(values), *values)
        item = dict(bufferView=self.view(payload, target), componentType=kind, count=len(values) // width,
                    type={1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[width])
        if bounds:
            columns = [values[n::width] for n in range(width)]
            item["min"], item["max"] = [min(c) for c in columns], [max(c) for c in columns]
        self.doc["accessors"].append(item)
        return len(self.doc["accessors"]) - 1

    def texture(self, number, key):
        sampler = (wrap(key[4], key[6]), wrap(key[5], key[7]), key[8])
        if sampler not in self.sampler_ids:
            filt = 9728 if sampler[2] == 0 else 9729
            self.doc.setdefault("samplers", []).append(dict(wrapS=sampler[0], wrapT=sampler[1], magFilter=filt,
                                                            minFilter=filt))
            self.sampler_ids[sampler] = len(self.doc["samplers"]) - 1
        if number not in self.image_ids:
            self.doc.setdefault("images", []).append(dict(uri=self.texture_root + self.textures[number]["png"]))
            self.image_ids[number] = len(self.doc["images"]) - 1
        pair = (self.image_ids[number], self.sampler_ids[sampler])
        if pair not in self.texture_ids:
            self.doc.setdefault("textures", []).append(dict(source=pair[0], sampler=pair[1]))
            self.texture_ids[pair] = len(self.doc["textures"]) - 1
        return self.texture_ids[pair]

    def material(self, key):
        if key not in self.material_ids:
            texture, colour, mode, double = key[:4]
            pbr = dict(baseColorFactor=list(colour), metallicFactor=0.0, roughnessFactor=1.0)
            item = dict(name="tex%d" % texture if texture is not None else "untextured",
                        pbrMetallicRoughness=pbr, alphaMode=mode, doubleSided=double)
            if mode == "MASK":
                item["alphaCutoff"] = 0.5
            if texture is not None:
                pbr["baseColorTexture"] = dict(index=self.texture(texture, key))
                item["extras"] = dict(texture_bank=self.texture_bank, texture=texture)
            self.doc["materials"].append(item)
            self.material_ids[key] = len(self.doc["materials"]) - 1
        return self.material_ids[key]

    def material_key(self, record):
        return material_key(record, self.textures)

    def mesh(self, name, model):
        """Add a mesh (one primitive per material) for a parsed model; returns (mesh index, triangle count)."""
        groups = {}
        for record in model["records"]:
            key = self.material_key(record)
            tris = groups.setdefault(key, [])
            for strip in record["strips"]:
                tris.extend(facing(t, model["vertices"]) for t in triangles(strip))
        primitives, total = [], 0
        for key, tris in groups.items():
            if not tris:
                continue
            used = sorted(set(k for t in tris for k in t))
            remap = dict((k, n) for n, k in enumerate(used))
            verts = [model["vertices"][k] for k in used]
            positions = [c for v in verts for c in v[0:3]]
            normals = [c for v in verts for c in v[3:6]]
            uvs = [c for v in verts for c in v[6:8]]
            indices = [remap[k] for t in tris for k in t]
            attributes = dict(POSITION=self.accessor(positions, 5126, 3, 34962, True),
                              NORMAL=self.accessor(normals, 5126, 3, 34962))
            if key[0] is not None:
                attributes["TEXCOORD_0"] = self.accessor(uvs, 5126, 2, 34962)
            if key[9]:
                attributes["COLOR_0"] = self.accessor([c for v in verts for c in v[8:12]], 5126, 4, 34962)
            primitives.append(dict(attributes=attributes, material=self.material(key),
                                   indices=self.accessor(indices, 5123 if len(used) < 65536 else 5125, 1, 34963)))
            total += len(tris)
        if not primitives:
            return None, 0
        self.doc["meshes"].append(dict(name=name, primitives=primitives))
        return len(self.doc["meshes"]) - 1, total

    def node(self, name, mesh, extras):
        item = dict(name=name, extras=extras)
        if mesh is not None:
            item["mesh"] = mesh
        self.doc["nodes"].append(item)
        self.doc["scenes"][0]["nodes"].append(len(self.doc["nodes"]) - 1)

    def glb(self):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.doc["buffers"] = [dict(byteLength=len(self.blob))]
        for name in ("materials", "meshes", "accessors", "bufferViews"):
            if not self.doc[name]:
                del self.doc[name]
        text = json.dumps(self.doc, separators=(",", ":")).encode()
        text += b" " * (-len(text) % 4)
        body = struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(self.blob), 0x004E4942) \
            + bytes(self.blob)
        return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def afs_entries(data):
    if data[:4] != b"AFS\0" or len(data) < 8:
        raise ValueError("not an AFS archive")
    count = struct.unpack_from("<I", data, 4)[0]
    if 8 + 8 * count > len(data):
        raise ValueError("truncated AFS table")
    entries = [struct.unpack_from("<II", data, 8 + 8 * k) for k in range(count)]
    for offset, size in entries:
        if offset + size > len(data):
            raise ValueError("AFS entry outside archive")
    return entries


def digest(data):
    return hashlib.sha256(data).hexdigest()


def summary(model, triangles_written):
    return dict(offset=model["offset"], end=model["end"], records=len(model["records"]),
                vertices=len(model["vertices"]), repaired_vertices=model["repaired"],
                triangles=triangles_written, sphere=model["sphere"],
                header=[model["kind"], model["flags"]],
                textures=sorted(set(r["texture"] for r in model["records"])))


def extract(source, textures, output):
    source, textures, output = Path(source).resolve(), Path(textures).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    texture_manifest = json.loads((textures / "manifest.json").read_text())
    banks = dict((bank["source"], bank["textures"]) for bank in texture_manifest["banks"])
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".models-", dir=output.parent))
    manifest = dict(schema=1, textures=textures.name, files=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi models</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
               '<h1>Local Crazy Taxi models</h1><p>GLB files reference ../textures; serve this folder\'s parent '
               'over HTTP to view them in a glTF viewer.</p>']
    try:
        for name in MODEL_FILES + CITY_FILES:
            data = (source / name).read_bytes()
            bank_name = "TEXDC%s.BIN" % name[-5]
            bank = banks[bank_name]
            entry = dict(source=name, size=len(data), sha256=digest(data), texture_bank=bank_name, models=[])
            gallery.append("<h2>%s</h2><table>" % html.escape(name))
            if name in MODEL_FILES:
                folder = staging / Path(name).stem
                folder.mkdir()
                for offset, *_ in find_models(data):
                    model = parse_model(data, offset)
                    gltf = Gltf(bank_name, bank, "../../%s/" % textures.name)
                    mesh, count = gltf.mesh("%s_%06x" % (Path(name).stem, offset), model)
                    gltf.node("%06x" % offset, mesh, dict(source=name, offset=offset))
                    relative = "%s/%06x.glb" % (folder.name, offset)
                    blob = gltf.glb()
                    (staging / relative).write_bytes(blob)
                    entry["models"].append(dict(summary(model, count), glb=relative, glb_sha256=digest(blob)))
                    gallery.append('<tr><td><a href="%s">%s</a></td><td>%d records</td><td>%d triangles</td></tr>'
                                   % (relative, relative, len(model["records"]), count))
            else:
                gltf = Gltf(bank_name, bank, "../%s/" % textures.name)
                entry["skipped"] = []
                for number, (offset, size) in enumerate(afs_entries(data)):
                    try:
                        model = parse_model(data[:offset + size], offset)
                    except ValueError as error:
                        entry["skipped"].append(dict(entry=number, offset=offset, size=size, reason=str(error)))
                        continue
                    if model["end"] > offset + size:
                        raise ValueError("%s entry %d model overruns entry" % (name, number))
                    mesh, count = gltf.mesh("%s_%03d" % (Path(name).stem, number), model)
                    gltf.node("entry_%03d" % number, mesh, dict(source=name, entry=number, offset=offset))
                    entry["models"].append(dict(summary(model, count), entry=number))
                relative = "%s.glb" % Path(name).stem
                blob = gltf.glb()
                (staging / relative).write_bytes(blob)
                entry.update(glb=relative, glb_sha256=digest(blob))
                gallery.append('<tr><td><a href="%s">%s</a></td><td>%d pieces</td><td>%d triangles</td></tr>'
                               % (relative, relative, len(entry["models"]),
                                  sum(m["triangles"] for m in entry["models"])))
            gallery.append("</table>")
            manifest["files"].append(entry)
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
    models = sum(len(f["models"]) for f in manifest["files"])
    tris = sum(m["triangles"] for f in manifest["files"] for m in f["models"])
    print("Converted %d models (%d triangles) from %d files into %s" % (models, tris, len(manifest["files"]), args.output))


if __name__ == "__main__":
    main()
