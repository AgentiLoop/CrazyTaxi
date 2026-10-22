#!/usr/bin/env python3
"""Convert the key-curve (Fcv) motions at the start of MOTDC to glTF animations on the people skeleton.

MOTDC opens with Fcv motions, the format the cab drivers are played with. Everything is found in
the USA files, not from regional addresses:

* The motions: a header {frames, 17 word offsets} followed by 17 curves, each three channels
  {count, count x {int frame, value, in tangent, out tangent}}. A header is accepted when its
  curves parse and sit back to back right after it. The motions run back to back from offset 0.
* MOTDC's load address (from the V-format motions, as extract_characters.py finds it) is confirmed
  by the executable's motion table: the longest run of words that point at Fcv headers. It must
  list every motion, in file order.
* The two-bone solver's lengths: four floats followed by their squares (upper arm, upper leg,
  forearm, shin), as the solver reads them.
* The bind offsets: the 13-vector table whose forearm and shin vectors match those lengths
  (head, then per limb the shoulder or hip offset and the two segment lengths).

A curve is evaluated as the game's fcvCalcPosition / fcvCalcAngle do: the first key pair with
key[k].frame <= f < key[k + 1].frame is blended by Hermite (tangents unscaled, t clamped to 0..1;
angles truncated to int), f equal to key[k + 1].frame takes that key's value, and a frame no pair
covers leaves the buffer unchanged. Frame f plays at f mod (frames - 1).

The 17 curves fill the pose buffer: root position, four targets (left hand, right hand, left foot,
right foot) in the character's own axes, and twelve Rz * Ry * Rx angle triples (0x10000 = a turn).
The pose is rebuilt as the game's FcvPlayBuffer draws it: root, its angles, a quarter turn about y;
torso; head after a quarter turn back about z; per limb the shoulder or hip angles, then the solver
aims +x at the target, twists about x to keep the old z plane, and bends the two segments about z
by the law of cosines (an out-of-range cosine gives 0); then the hand or foot angles. Each bone's
local rotation goes to the node of the same name as in extract_characters.py (bone_0 ... bone_15),
so the clips play on any assembled character.
Format reference: supplied decomp docs/engine.md ("Skeleton and motions") and the USA code.
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
    from tools.extract_characters import FRAME_RATE, add_nodes, animation_accessor, find_motions, quaternion, words
    from tools.extract_models import Gltf, digest
except ImportError:  # run as a script from the tools directory
    from extract_characters import FRAME_RATE, add_nodes, animation_accessor, find_motions, quaternion, words
    from extract_models import Gltf, digest

LOAD = 0x0C010000
CURVES = 17
HEADER_WORDS = 1 + CURVES
TURN = 0x10000
# Header curve k fills pose buffer slot BUFFER[k]: 0 root, 1-4 targets, 5-16 angle triples.
BUFFER = (0, 5, 6, 7, 8, 1, 9, 10, 2, 11, 12, 13, 3, 14, 15, 4, 16)
# Per limb (left hand, right hand, left foot, right foot): target slot, root angles, end angles,
# solver mode (0 arm, 1 leg), bones (root, middle, end).
LIMBS = ((1, 8, 9, 0, (4, 3, 2)), (2, 10, 11, 0, (7, 6, 5)),
         (3, 13, 14, 1, (11, 10, 9)), (4, 15, 16, 1, (14, 13, 12)))
# Node order and parents (bone, parent bone); the same tree as the V-format draw routine.
TREE = ((0, None), (8, 0), (1, 8), (4, 8), (3, 4), (2, 3), (7, 8), (6, 7), (5, 6),
        (15, 0), (11, 15), (10, 11), (9, 10), (14, 15), (13, 14), (12, 13))


def signed(value):
    return value - (1 << 32) if value & 0x80000000 else value


def parse_curve(w, at):
    """[(count, [(frame, raw value, raw in, raw out)]) x 3] of the curve at word index at, and its
    length in words; None when it does not parse."""
    channels, p = [], at
    for _ in range(3):
        if p >= len(w):
            return None
        count = w[p]
        if not 1 <= count <= 2000 or p + 1 + 4 * count > len(w):
            return None
        keys = [(signed(w[p + 1 + 4 * k]),) + tuple(w[p + 2 + 4 * k:p + 5 + 4 * k]) for k in range(count)]
        if any(abs(k[0]) > 100000 for k in keys):
            return None
        channels.append(keys)
        p += 1 + 4 * count
    return channels, p - at


def parse_motion(w, index):
    """(frames, curves in header order, length in words) of a Fcv header at word index, else None."""
    if index + HEADER_WORDS > len(w):
        return None
    frames, offsets = w[index], w[index + 1:index + HEADER_WORDS]
    if not 1 < frames < 10000 or len(set(offsets)) != CURVES:
        return None
    curves, expected = [None] * CURVES, HEADER_WORDS
    for k in sorted(range(CURVES), key=lambda k: offsets[k]):
        if offsets[k] != expected:
            return None
        parsed = parse_curve(w, index + offsets[k])
        if parsed is None:
            return None
        curves[k] = parsed[0]
        expected += parsed[1]
    return frames, curves, expected


def find_fcv_motions(data):
    """[(offset, frames, curves)] of the Fcv motions running back to back from offset 0."""
    w, at, found = words(data), 0, []
    while True:
        parsed = parse_motion(w, at)
        if parsed is None:
            break
        found.append((at * 4, parsed[0], parsed[1]))
        at += parsed[2]
    if len(found) < 2:
        raise ValueError("no Fcv motions at the start of MOTDC")
    return found, at * 4


def find_motion_table(executable, base, offsets):
    """Address of the longest run of executable words pointing at Fcv headers."""
    w, targets = words(executable), set(base + o for o in offsets)
    best, i = (0, 0), 0
    while i < len(w):
        j = i
        while j < len(w) and w[j] in targets:
            j += 1
        if j - i > best[1] - best[0]:
            best = (i, j)
        i = j + 1 if j == i else j
    table = [w[k] - base for k in range(*best)]
    if table != sorted(offsets):
        raise ValueError("the executable's motion table does not list every Fcv motion in order")
    return LOAD + 4 * best[0]


def find_ik_lengths(executable):
    """(address, {mode: (upper, lower)}) of four positive floats followed by their squares."""
    found = []
    for at in range(0, len(executable) - 32, 4):
        v = struct.unpack_from("<8f", executable, at)
        if all(0.5 < x < 100 for x in v[:4]) and \
                all(abs(v[4 + k] - v[k] * v[k]) <= 1e-5 * v[4 + k] for k in range(4)):
            found.append((LOAD + at, {0: (v[0], v[2]), 1: (v[1], v[3])}, v[4:]))
    if len(found) != 1:
        raise ValueError("expected one solver length table, found %d" % len(found))
    return found[0]


def find_bind_offsets(executable, lengths):
    """(address, 13 vectors) of the bind table whose segment vectors match the solver lengths."""
    arm, leg = lengths[0], lengths[1]
    found = []
    for at in range(0, len(executable) - 156, 4):
        v = [struct.unpack_from("<3f", executable, at + 12 * k) for k in range(13)]
        segments = ((2, arm[0]), (3, arm[1]), (5, arm[0]), (6, arm[1]),
                    (8, leg[0]), (9, leg[1]), (11, leg[0]), (12, leg[1]))
        if not 1.0 < v[0][0] < 20.0 or v[0][1:] != (0.0, 0.0):
            continue
        if not all(v[k][1:] == (0.0, 0.0) and abs(v[k][0] - length) < 1e-3 for k, length in segments):
            continue
        if v[1][:2] == v[4][:2] and v[1][2] == -v[4][2] < 0 and v[7][:2] == v[10][:2] and v[7][2] == -v[10][2] < 0:
            found.append((LOAD + at, v))
    if len(found) != 1:
        raise ValueError("expected one bind offset table, found %d" % len(found))
    return found[0]


def hermite(a, b, t, angle):
    """The game's fcvHermite / fcvHermiteAngle between keys a and b."""
    t = min(1.0, max(0.0, t))
    t2, t3 = t * t, t * t * t
    if angle:
        av, bv, ao, bi = (signed(x) for x in (a[1], b[1], a[3], b[2]))
    else:
        av, bv, ao, bi = (struct.unpack("<f", struct.pack("<I", x))[0] for x in (a[1], b[1], a[3], b[2]))
    value = bv * (3 * t2 - 2 * t3) + av * (2 * t3 - 3 * t2 + 1) + ao * (t3 - 2 * t2 + t) + bi * (t3 - t2)
    return int(value) if angle else value


def channel_value(keys, f, angle):
    """Value of one channel at frame f, or None when the game writes nothing."""
    for k in range(len(keys) - 1):
        if keys[k][0] <= f < keys[k + 1][0]:
            return hermite(keys[k], keys[k + 1], (f - keys[k][0]) / float(keys[k + 1][0] - keys[k][0]), angle)
        if keys[k + 1][0] == f:
            value = keys[k + 1][1]
            return signed(value) if angle else struct.unpack("<f", struct.pack("<I", value))[0]
    return None


def evaluate(curves, f, previous):
    """Pose buffer (17 triples) at frame f; unwritten channels keep `previous`. Returns (buffer, misses)."""
    buffer, misses = [list(t) for t in previous], 0
    for k, curve in enumerate(curves):
        slot = BUFFER[k]
        for c, keys in enumerate(curve):
            value = channel_value(keys, f, slot >= 5)
            if value is None:
                misses += 1
            else:
                buffer[slot][c] = value
    return [tuple(t) for t in buffer], misses


def mat_mul(a, b):
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)) for r in range(3))


def apply(m, v):
    return tuple(sum(m[r][k] * v[k] for k in range(3)) for r in range(3))


def column(m, c):
    return tuple(m[r][c] for r in range(3))


def transpose(m):
    return tuple(tuple(m[c][r] for c in range(3)) for r in range(3))


def sin_cos(angle):
    radians = (angle % TURN) * 2 * math.pi / TURN
    return math.sin(radians), math.cos(radians)


def rot_x(angle):
    s, c = sin_cos(angle)
    return ((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c))


def rot_y(angle):
    s, c = sin_cos(angle)
    return ((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c))


def rot_z(angle):
    s, c = sin_cos(angle)
    return ((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0))


def fcv_rotate(angles):
    """fcvRotate: Rz(z) * Ry(y) * Rx(x)."""
    return mat_mul(mat_mul(rot_z(angles[2]), rot_y(angles[1])), rot_x(angles[0]))


def axis_angle(axis, s, c):
    """Rotation about a unit axis with the given sine and cosine (the library's axis rotation)."""
    x, y, z = axis
    t = 1.0 - c
    return ((x * x * t + c, x * y * t - z * s, x * z * t + y * s),
            (x * y * t + z * s, y * y * t + c, y * z * t - x * s),
            (x * z * t - y * s, y * z * t + x * s, z * z * t + c))


def to_angle(radians):
    return int(radians * TURN / (2 * math.pi)) & 0xFFFF


def game_acos(x):
    """The library's arc cosine in angle units: 0 outside -1..1."""
    return 0 if abs(x) > 1.0 else to_angle(math.acos(x))


def solve_ik(m, shoulder, target, lengths):
    """fcvSolveIK: (aim * twist rotation to post-multiply onto m, bend 1, bend 2, distance)."""
    upper, lower = lengths
    d = tuple(t - s for t, s in zip(target, shoulder))
    distance = math.sqrt(sum(v * v for v in d))
    u = tuple(v / distance for v in d) if distance else (0.0, 0.0, 0.0)
    local = apply(transpose(m), u)
    axis = (0.0, -local[2], local[1])  # (1, 0, 0) x local
    s = math.sqrt(sum(v * v for v in axis))
    c = local[0]
    if s != 0.0:
        aim = axis_angle(tuple(v / s for v in axis), s, c)
    elif c < 0.0:
        aim = axis_angle((0.0, 0.0, 1.0), 0.0, -1.0)
    else:
        aim = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    aimed = mat_mul(m, aim)
    z_new = column(aimed, 2)
    a = sum(p * q for p, q in zip(column(m, 2), z_new))
    b = sum(p * q for p, q in zip(column(m, 1), z_new))
    twist = to_angle(math.atan2(b, a))
    rotation = mat_mul(aim, rot_x(-twist))
    if distance == 0.0:
        return rotation, 0, 0, distance
    bend1 = game_acos((upper * upper - lower * lower + distance * distance) / (upper * distance * 2.0))
    bend2 = -game_acos((distance * distance - upper * upper - lower * lower) / (upper * lower * 2.0))
    return rotation, bend1, bend2, distance


def build_pose(buffer, bind, lengths):
    """{bone: local rotation matrix}, root translation, and per limb (distance, reach error)."""
    local = {}
    root = mat_mul(fcv_rotate(buffer[5]), rot_y(0x4000))
    local[0] = root
    local[8] = fcv_rotate(buffer[6])
    torso = mat_mul(root, local[8])
    local[1] = mat_mul(rot_z(-0x4000), fcv_rotate(buffer[7]))
    local[15] = fcv_rotate(buffer[12])
    hips = mat_mul(root, local[15])
    reach = []
    for limb, (target, first, end, mode, bones) in enumerate(LIMBS):
        parent = torso if mode == 0 else hips
        offset, segment1, segment2 = bind[1 + 3 * limb], bind[2 + 3 * limb][0], bind[3 + 3 * limb][0]
        shoulder = tuple(p + q for p, q in zip(buffer[0], apply(parent, offset)))
        m = mat_mul(parent, fcv_rotate(buffer[first]))
        rotation, bend1, bend2, distance = solve_ik(m, shoulder, buffer[target], lengths[mode])
        local[bones[0]] = mat_mul(mat_mul(fcv_rotate(buffer[first]), rotation), rot_z(bend1))
        local[bones[1]] = rot_z(bend2)
        local[bones[2]] = fcv_rotate(buffer[end])
        upper = mat_mul(parent, local[bones[0]])
        lower = mat_mul(upper, local[bones[1]])
        elbow = tuple(p + q for p, q in zip(shoulder, apply(upper, (segment1, 0.0, 0.0))))
        wrist = tuple(p + q for p, q in zip(elbow, apply(lower, (segment2, 0.0, 0.0))))
        error = math.sqrt(sum((p - q) ** 2 for p, q in zip(wrist, buffer[target])))
        forward = None
        if mode == 1:  # does the knee bend toward the toes (the foot's +y)?
            toes = column(mat_mul(lower, local[bones[2]]), 1)
            middle = tuple((p + q) / 2 for p, q in zip(shoulder, wrist))
            forward = sum((k - c) * t for k, c, t in zip(elbow, middle, toes)) > 0
        reach.append((distance, error, distance <= sum(lengths[mode]), forward))
    return local, buffer[0], reach


def skeleton(bind):
    """Nodes in extract_characters.py's form (bone, parent node index, translation)."""
    translation = {1: bind[0]}
    for limb, (_, _, _, _, bones) in enumerate(LIMBS):
        translation[bones[0]] = bind[1 + 3 * limb]
        translation[bones[1]] = bind[2 + 3 * limb]
        translation[bones[2]] = bind[3 + 3 * limb]
    order = [b for b, _ in TREE]
    nodes = []
    for bone, parent in TREE:
        nodes.append(dict(bone=bone, parent=None if parent is None else order.index(parent),
                          translation="root" if bone == 0 else translation.get(bone)))
    return nodes


def as_quaternion(m):
    q, _ = quaternion(column(m, 0), column(m, 1))
    return q


def sample(curves, frames, bind, lengths):
    """Per played frame 0 .. frames-2 (then frame 0 again): ({bone: matrix}, root). Plus stats."""
    previous, poses, misses, worst, reached, unreachable = [(0, 0, 0)] * CURVES, [], 0, 0.0, 0, 0
    knees = [0, 0]
    for f in range(frames - 1):
        buffer, missed = evaluate(curves, float(f), previous)
        previous, misses = buffer, misses + missed
        local, root, reach = build_pose(buffer, bind, lengths)
        for distance, error, ok, forward in reach:
            if ok:
                reached += 1
                worst = max(worst, error)
            else:
                unreachable += 1
            if forward is not None:
                knees[0 if forward else 1] += 1
        poses.append((local, root))
    poses.append(poses[0])
    return poses, dict(unwritten_channel_frames=misses, reach_error=worst, limbs_reached=reached,
                       limbs_out_of_reach=unreachable, knees_forward=knees[0], knees_backward=knees[1])


def add_animation(gltf, ids, nodes, poses, name, extras):
    times = [k / FRAME_RATE for k in range(len(poses))]
    time_accessor = animation_accessor(gltf, times, 1, True)
    samplers, channels = [], []
    for node_id, node in zip(ids, nodes):
        quats, previous = [], None
        for local, _ in poses:
            q = as_quaternion(local[node["bone"]])
            if previous is not None and sum(p * v for p, v in zip(previous, q)) < 0:
                q = tuple(-v for v in q)
            quats.extend(q)
            previous = q
        samplers.append(dict(input=time_accessor, output=animation_accessor(gltf, quats, 4), interpolation="LINEAR"))
        channels.append(dict(sampler=len(samplers) - 1, target=dict(node=node_id, path="rotation")))
        if node["translation"] == "root":
            moves = [c for _, root in poses for c in root]
            samplers.append(dict(input=time_accessor, output=animation_accessor(gltf, moves, 3),
                                 interpolation="LINEAR"))
            channels.append(dict(sampler=len(samplers) - 1, target=dict(node=node_id, path="translation")))
    gltf.doc.setdefault("animations", []).append(dict(name=name, samplers=samplers, channels=channels,
                                                      extras=extras))


def references(executable, address, table):
    """Executable addresses holding `address`, other than its motion-table slot."""
    w = words(executable)
    return [LOAD + 4 * i for i, x in enumerate(w) if x == address and LOAD + 4 * i != table]


def discover(source):
    executable = (source / "1ST_READ.BIN").read_bytes()
    motdc = (source / "MOTDC.BIN").read_bytes()
    base, _ = find_motions(motdc)
    motions, end = find_fcv_motions(motdc)
    table = find_motion_table(executable, base, [o for o, _, _ in motions])
    ik_address, lengths, _ = find_ik_lengths(executable)
    bind_address, bind = find_bind_offsets(executable, lengths)
    return dict(executable=executable, motdc=motdc, base=base, motions=motions, end=end, table=table,
                ik_address=ik_address, lengths=lengths, bind_address=bind_address, bind=bind)


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    found = discover(source)
    executable, motdc, base, bind, lengths = (found[k] for k in ("executable", "motdc", "base", "bind", "lengths"))
    nodes = skeleton(bind)
    first = found["motions"][0]
    rest, rest_root, _ = build_pose(evaluate(first[2], 0.0, [(0, 0, 0)] * CURVES)[0], bind, lengths)
    posed = [(as_quaternion(rest[n["bone"]]), rest_root if n["translation"] == "root" else n["translation"])
             for n in nodes]
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".fcv-", dir=output.parent))
    manifest = dict(
        schema=1, sources=dict((n, dict(size=len(b), sha256=digest(b))) for n, b in
                               (("1ST_READ.BIN", executable), ("MOTDC.BIN", motdc))),
        motdc_base=base, fcv_bytes=found["end"], motion_table=found["table"],
        solver_lengths=dict(address=found["ik_address"], arm=list(lengths[0]), leg=list(lengths[1])),
        bind_offsets=dict(address=found["bind_address"], vectors=[list(v) for v in bind]),
        frame_rate=FRAME_RATE, frame_rate_note="nominal; the game's playback rate is not established",
        skeleton=[dict(bone=n["bone"], parent=None if n["parent"] is None else nodes[n["parent"]]["bone"],
                       translation="root" if n["translation"] == "root" else
                       None if n["translation"] is None else [round(v, 6) for v in n["translation"]])
                  for n in nodes],
        motions=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi Fcv motions</title>',
            '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
            '<h1>Local Crazy Taxi key-curve (Fcv) motions</h1><p><a href="fcv_motions.glb">fcv_motions.glb</a> '
            'holds every motion on the bone names of the assembled characters (bone_0 ... bone_15).</p><table>',
            '<tr><th>index</th><th>name</th><th>frames</th><th>other references</th></tr>']
    try:
        gltf = Gltf(None, [], "")
        ids = add_nodes(gltf, nodes, posed, "skeleton")
        totals = dict(unwritten_channel_frames=0, reach_error=0.0, limbs_reached=0, limbs_out_of_reach=0,
                      knees_forward=0, knees_backward=0)
        for index, (offset, frames, curves) in enumerate(found["motions"]):
            poses, stats = sample(curves, frames, bind, lengths)
            refs = references(executable, base + offset, found["table"] + 4 * index)
            extras = dict(source="MOTDC.BIN", offset=offset, address=base + offset, frames=frames, table_index=index)
            name = "fcv_%03d_%06x" % (index, offset)
            add_animation(gltf, ids, nodes, poses, name, extras)
            for key in totals:
                totals[key] = max(totals[key], stats[key]) if key == "reach_error" else totals[key] + stats[key]
            manifest["motions"].append(dict(extras, name=name, played_frames=frames - 1,
                                            references=refs, **stats))
            page.append("<tr><td>%d</td><td>%s</td><td>%d</td><td>%s</td></tr>"
                        % (index, name, frames, html.escape(" ".join("%08X" % r for r in refs))))
        blob = gltf.glb()
        (staging / "fcv_motions.glb").write_bytes(blob)
        manifest.update(glb="fcv_motions.glb", glb_sha256=digest(blob), totals=totals)
        page.append("</table>")
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
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    totals = manifest["totals"]
    print("Converted %d Fcv motions into %s (limbs reached %d, out of reach %d, worst reach error %.2g; "
          "knees forward %d, backward %d)"
          % (len(manifest["motions"]), args.output, totals["limbs_reached"], totals["limbs_out_of_reach"],
             totals["reach_error"], totals["knees_forward"], totals["knees_backward"]))


if __name__ == "__main__":
    main()
