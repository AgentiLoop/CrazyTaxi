#!/usr/bin/env python3
"""Assemble Crazy Taxi's people from POLDC0 parts and convert their MOTDC motions to glTF.

Everything is recovered from the USA disc files, not from regional addresses:

* POLDC0's load address: the 64 KiB-aligned base that turns the most executable words
  into POLDC0 model addresses. The character table is the longest run of pointers to
  16-slot part arrays (slot 0 empty, every other slot null or a POLDC0 model).
* MOTDC's load address and its V-format motions: a 12-byte header {frames, bones = 15,
  data} whose data (frames x 396 bytes) ends right at the header fixes the base.
* The skeleton, the bind offsets and every per-character extra part come from the
  game's own draw routine. Of the functions that load the character table, the one a
  small symbolic SH-4 interpreter can run to its end with V-format rotations is the
  draw routine; running it once per character records its matrix pushes and pops,
  translations (bind offsets in the executable, or the motion's root vector), rotations
  (bone b uses the record's vectors at 12 + 24b and 24 + 24b) and model draws.

A V record is 33 vectors: v0 the root position, then per bone two unit vectors a, c;
the bone's rotation has columns a, c, a x c. The game plays record frame mod (frames - 1)
+ 1, so record 0 is never shown. Output per character: a GLB whose nodes are the bones
(named bone_<n>, posed with a standing record) with the parts as child mesh nodes; plus
motions.glb with the same bone nodes and one animation per motion. three.js binds clips
by node name, so any motion plays on any character. Root translation is the full v0
(the draw routine's mode 0); the game's in-place mode keeps only its height.
Format reference: supplied decomp docs/engine.md ("Humans", "Skeleton and motions").
Stdlib only; no upstream imports.
"""
import argparse
import html
import itertools
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_models import Gltf, digest, find_models, parse_model
    from tools.extract_sprites import scan_calls
except ImportError:  # run as a script from the tools directory
    from extract_models import Gltf, digest, find_models, parse_model
    from extract_sprites import scan_calls

LOAD = 0x0C010000
SLOTS = 16
RECORD = 396  # (15 + 1) * 2 + 1 vectors of 12 bytes
FRAME_RATE = 30.0  # nominal: the playback rate is not established
REST_MOTION = 0x263244  # MOTDC offset of a standing idle (decomp engine.md); its record 1 is the rest pose
STACK = 0x0F000000
SLOT_NAMES = {1: "head", 2: "left_hand", 3: "left_forearm", 4: "left_upper_arm", 5: "right_hand",
              6: "right_forearm", 7: "right_upper_arm", 8: "torso", 9: "left_foot", 10: "left_shin",
              11: "left_thigh", 12: "right_foot", 13: "right_shin", 14: "right_thigh", 15: "hips"}


def words(data):
    return struct.unpack_from("<%dI" % (len(data) // 4), data)


def find_base(executable, offsets, size):
    """64 KiB-aligned load address that maps the most executable words onto `offsets`."""
    by_low = {}
    for offset in offsets:
        by_low.setdefault(offset & 0xFFFF, []).append(offset)
    votes = {}
    for word in words(executable):
        if 0x0C000000 <= word < 0x0D000000:
            for offset in by_low.get(word & 0xFFFF, ()):
                votes[word - offset] = votes.get(word - offset, 0) + 1
    if not votes:
        raise ValueError("no pointers to the model file")
    base = max(votes, key=votes.get)
    if base & 0xFFFF or not 0x0C000000 <= base <= 0x0D000000 - size:
        raise ValueError("implausible model file base")
    return base


def find_character_table(executable, base, model_offsets):
    """(table address, [part array address]) of the longest run of pointers to part arrays."""
    w = words(executable)
    models = set(base + o for o in model_offsets)

    def is_array(address):
        i = (address - LOAD) // 4
        if address % 4 or not 0 <= i <= len(w) - SLOTS or w[i]:
            return False
        return all(x == 0 or x in models for x in w[i + 1:i + SLOTS])

    best, i = (0, 0), 0
    while i < len(w):
        j = i
        while j < len(w) and is_array(w[j]):
            j += 1
        if j - i > best[1] - best[0]:
            best = (i, j)
        i = j + 1 if j == i else j
    if best[1] - best[0] < 8:
        raise ValueError("no character table")
    return LOAD + best[0] * 4, list(w[best[0]:best[1]])


def find_motions(data):
    """(load base, [(header offset, frames)]) of every V-format motion in MOTDC."""
    w, found = words(data), {}
    for i in range(len(w) - 2):
        frames, bones, pointer = w[i], w[i + 1], w[i + 2]
        if bones == 15 and 1 < frames < 100000 and frames * RECORD <= i * 4:
            found.setdefault(pointer - (i * 4 - frames * RECORD), []).append((i * 4, frames))
    if not found:
        raise ValueError("no V motions")
    base = max(found, key=lambda b: len(found[b]))
    if len(found[base]) < 2:
        raise ValueError("motion base not confirmed by two headers")
    return base, found[base]


def record_vectors(data, header, frames, index):
    start = header - frames * RECORD + index * RECORD
    return [struct.unpack_from("<3f", data, start + 12 * k) for k in range(33)]


class Sym(object):
    """An unknown value, plus a known byte offset from it."""
    tags = itertools.count()

    def __init__(self, tag=None, off=0):
        self.tag = next(Sym.tags) if tag is None else tag
        self.off = off

    def __add__(self, other):
        return Sym(self.tag, self.off + other) if isinstance(other, int) else Sym()


def run_draw(memory, entry, args, limit=50000):
    """Symbolically run an SH-4 function; returns its calls [(target, r4, r5)] in order.

    memory: [(load address, bytes)]. Unknown values are Sym; every branch condition must be
    known. Calls are not entered: they clobber r0-r7, macl and T."""
    regs = dict((n, Sym()) for n in range(16))
    regs.update({4: args[0], 5: args[1], 6: args[2], 7: args[3], 15: STACK})
    store, state, calls = {}, dict(t=None, macl=Sym()), []

    def read(address, size, signed=False):
        if isinstance(address, int):
            if size == 4 and address in store:
                return store[address]
            for start, blob in memory:
                if start <= address <= start + len(blob) - size:
                    fmt = {1: "b", 2: "h", 4: "i"}[size] if signed else {1: "B", 2: "H", 4: "I"}[size]
                    return struct.unpack_from("<" + fmt, blob, address - start)[0] & 0xFFFFFFFF
        return Sym()

    def write(address, value):
        if isinstance(address, int):
            store[address] = value

    def add(a, b):
        if isinstance(a, int) and isinstance(b, int):
            return (a + b) & 0xFFFFFFFF
        if isinstance(a, Sym) and isinstance(b, int):
            return a + b
        if isinstance(b, Sym) and isinstance(a, int):
            return b + a
        return Sym()

    def known(*values):
        return all(isinstance(v, int) for v in values)

    def signed(v):
        return v - (1 << 32) if v & 0x80000000 else v

    def step(pc):
        """Execute one instruction; returns (kind, target) for control flow or None."""
        word = read(pc, 2)
        if not isinstance(word, int):
            raise ValueError("code outside memory at %08x" % pc)
        top, n, m, low4, low8 = word >> 12, word >> 8 & 15, word >> 4 & 15, word & 15, word & 255
        d8 = low8 - 256 if low8 & 128 else low8
        r = regs
        if word == 0x0009:
            return None
        if word == 0x000B:
            return ("rts", None)
        if top == 0:
            if low8 == 0x23:
                return ("jump", add(pc + 4, r[n]))
            if low8 == 0x03:
                return ("call", add(pc + 4, r[n]))
            if low8 == 0x1A:
                r[n] = state["macl"]
            elif low8 in (0x0A, 0x2A, 0x5A, 0x6A, 0x02, 0x12, 0x22):
                r[n] = Sym()
            elif low4 == 7:
                state["macl"] = (r[n] * r[m]) & 0xFFFFFFFF if known(r[n], r[m]) else Sym()
            elif low4 in (0xC, 0xD, 0xE):
                r[n] = read(add(r[0], r[m]), {0xC: 1, 0xD: 2, 0xE: 4}[low4], True)
            elif low4 in (4, 5, 6):
                write(add(r[0], r[n]), r[m])
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 1:
            write(add(r[n], low4 * 4), r[m])
        elif top == 2:
            if low4 in (0, 1, 2):
                write(r[n], r[m])
            elif low4 in (4, 5, 6):
                r[n] = add(r[n], -{4: 1, 5: 2, 6: 4}[low4])
                write(r[n], r[m])
            elif low4 == 8:
                state["t"] = (r[n] & r[m]) == 0 if known(r[n], r[m]) else None
            elif low4 in (9, 0xA, 0xB):
                r[n] = ({9: lambda a, b: a & b, 0xA: lambda a, b: a ^ b, 0xB: lambda a, b: a | b}[low4](r[n], r[m])
                        if known(r[n], r[m]) else Sym())
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 3:
            if low4 == 0xC:
                r[n] = add(r[n], r[m])
            elif low4 == 8:
                r[n] = (r[n] - r[m]) & 0xFFFFFFFF if known(r[n], r[m]) else Sym()
            elif low4 in (0, 2, 3, 6, 7):
                if not known(r[n], r[m]):
                    state["t"] = None
                else:
                    a, b = r[n], r[m]
                    state["t"] = {0: a == b, 2: a >= b, 6: a > b, 3: signed(a) >= signed(b),
                                  7: signed(a) > signed(b)}[low4]
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 4:
            if low8 == 0x0B:
                return ("call", r[n])
            shifts = {0x00: lambda v: v << 1, 0x01: lambda v: v >> 1, 0x08: lambda v: v << 2,
                      0x09: lambda v: v >> 2, 0x18: lambda v: v << 8, 0x19: lambda v: v >> 8,
                      0x28: lambda v: v << 16, 0x29: lambda v: v >> 16}
            if low8 in shifts:
                r[n] = shifts[low8](r[n]) & 0xFFFFFFFF if known(r[n]) else Sym()
            elif low8 in (0x12, 0x22, 0x52, 0x62):
                r[n] = add(r[n], -4)
                write(r[n], state["macl"] if low8 == 0x12 else Sym())
            elif low8 in (0x16, 0x26, 0x56, 0x66):
                if low8 == 0x16:
                    state["macl"] = read(r[n], 4)
                r[n] = add(r[n], 4)
            elif low8 in (0x5A, 0x6A):
                pass
            elif low8 == 0x10:
                r[n] = (r[n] - 1) & 0xFFFFFFFF if known(r[n]) else Sym()
                state["t"] = r[n] == 0 if known(r[n]) else None
            elif low8 in (0x11, 0x15):
                state["t"] = (signed(r[n]) >= 0 if low8 == 0x11 else signed(r[n]) > 0) if known(r[n]) else None
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 5:
            r[n] = read(add(r[m], low4 * 4), 4)
        elif top == 6:
            if low4 in (0, 1, 2):
                r[n] = read(r[m], {0: 1, 1: 2, 2: 4}[low4], True)
            elif low4 in (4, 5, 6):
                size = {4: 1, 5: 2, 6: 4}[low4]
                value = read(r[m], size, True)
                if n != m:
                    r[m] = add(r[m], size)
                r[n] = value
            elif low4 == 3:
                r[n] = r[m]
            elif low4 in (0xC, 0xD, 0xE, 0xF) and known(r[m]):
                v = r[m]
                r[n] = {0xC: v & 0xFF, 0xD: v & 0xFFFF, 0xE: (v & 0xFF) - (256 if v & 0x80 else 0),
                        0xF: (v & 0xFFFF) - (65536 if v & 0x8000 else 0)}[low4] & 0xFFFFFFFF
            else:
                r[n] = Sym()
        elif top == 7:
            r[n] = add(r[n], d8)
        elif top == 8:
            if n == 8:
                state["t"] = r[0] == (d8 & 0xFFFFFFFF) if known(r[0]) else None
            elif n in (9, 0xB, 0xD, 0xF):
                if state["t"] is None:
                    raise ValueError("unresolved branch at %08x" % pc)
                taken = state["t"] == (n in (9, 0xD))
                target = pc + 4 + 2 * d8
                if n in (0xD, 0xF):
                    return ("delayed", target if taken else None)
                return ("goto", target) if taken else None
            elif n in (0, 1):
                write(add(r[m], (word & 15) << (n)), r[0])
            elif n in (4, 5):
                r[0] = read(add(r[m], (word & 15) << (n - 4)), 1 << (n - 4), True)
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 9:
            r[n] = read(pc + 4 + low8 * 2, 2, True)
        elif top in (0xA, 0xB):
            disp = word & 0xFFF
            target = pc + 4 + 2 * (disp - 4096 if disp & 0x800 else disp)
            return ("jump" if top == 0xA else "call", target)
        elif top == 0xC:
            if n == 7:
                r[0] = (pc & ~3) + 4 + low8 * 4
            elif n == 8:
                state["t"] = (r[0] & low8) == 0 if known(r[0]) else None
            elif n in (9, 0xA, 0xB):
                r[0] = ({9: lambda a: a & low8, 0xA: lambda a: a ^ low8, 0xB: lambda a: a | low8}[n](r[0])
                        if known(r[0]) else Sym())
            else:
                raise ValueError("unhandled %04x at %08x" % (word, pc))
        elif top == 0xD:
            r[n] = read((pc & ~3) + 4 + low8 * 4, 4)
        elif top == 0xE:
            r[n] = d8 & 0xFFFFFFFF
        elif top == 0xF:
            if low4 == 9:
                r[m] = add(r[m], 4)
            elif low4 == 0xB:
                r[n] = add(r[n], -4)
        return None

    pc = entry
    for _ in range(limit):
        action = step(pc)
        if action is None:
            pc += 2
            continue
        kind, target = action
        if kind == "goto":
            pc = target
            continue
        if step(pc + 2) is not None:
            raise ValueError("branch in delay slot at %08x" % (pc + 2))
        if kind == "rts":
            return calls
        if kind == "call":
            calls.append((target, regs[4], regs[5]))
            for number in range(8):
                regs[number] = Sym()
            state["macl"], state["t"] = Sym(), None
            pc += 4
        elif kind == "delayed":
            pc = target if target is not None else pc + 4
        else:
            if not isinstance(target, int):
                raise ValueError("unknown jump target at %08x" % pc)
            pc = target
    raise ValueError("draw routine did not return")


def function_entries(executable, address):
    """Instruction addresses that load `address` from a literal pool."""
    sites = []
    for at in range(0, len(executable) - 1, 2):
        word = struct.unpack_from("<H", executable, at)[0]
        if word >> 12 == 0xD:
            pool = ((LOAD + at) & ~3) + 4 + (word & 255) * 4
            if 0 <= pool - LOAD <= len(executable) - 4 and struct.unpack_from("<I", executable, pool - LOAD)[0] == address:
                sites.append(LOAD + at)
    return sites


def call_targets(executable):
    """Function entries: every constant address the executable's jsr/bsr calls reach."""
    targets = set(c["target"] for c in scan_calls(executable) if c["target"] is not None)
    return sorted(t for t in targets if 0 <= t - LOAD < len(executable) and t % 2 == 0)


def identify(calls, model_addresses):
    """The draw primitives a V-format draw routine calls, by how it calls them; None when the
    calls do not read as one. put: every argument a model; rotate: two vectors 12 bytes apart
    in one unknown record; translate: given that record's start (the root) or a fixed vector;
    push: always argument 0; pop: a small count."""
    by_target = {}
    for target, r4, r5 in calls:
        by_target.setdefault(target, []).append((r4, r5))
    rotate = [t for t, a in by_target.items()
              if all(isinstance(x, Sym) and isinstance(y, Sym) and x.tag == y.tag and y.off - x.off == 12
                     for x, y in a)]
    put = [t for t, a in by_target.items() if all(isinstance(x, int) and x in model_addresses for x, _ in a)]
    if len(rotate) != 1 or len(put) != 1 or len(set(x.tag for x, _ in by_target[rotate[0]])) != 1:
        return None
    tag = by_target[rotate[0]][0][0].tag
    translate = [t for t, a in by_target.items() if t != rotate[0]
                 and any(isinstance(x, Sym) and x.tag == tag for x, _ in a)]
    small = [t for t, a in by_target.items() if all(isinstance(x, int) and x < 8 for x, _ in a)]
    push = [t for t in small if set(x for x, _ in by_target[t]) == {0}]
    pop = [t for t in small if t not in push and 0 not in set(x for x, _ in by_target[t])]
    if len(translate) != 1 or len(push) != 1 or len(pop) != 1:
        return None
    return dict(put=put[0], rotate=rotate[0], translate=translate[0], push=push[0], pop=pop[0])


def events(calls, functions):
    """The draw primitives' calls in order: push, pop n, root, translate address, rotate bone, put model."""
    roots = [r4.off for target, r4, _ in calls if target == functions["translate"] and isinstance(r4, Sym)]
    if len(roots) != 1:
        raise ValueError("expected one root translation")
    out = []
    for target, r4, _ in calls:
        if target == functions["put"]:
            out.append(("put", r4))
        elif target == functions["rotate"]:
            offset = r4.off - roots[0] - 12 if isinstance(r4, Sym) else -1
            if offset % 24 or not 0 <= offset // 24 < 16:
                raise ValueError("rotation outside the record")
            out.append(("rotate", offset // 24))
        elif target == functions["translate"]:
            out.append(("root",) if isinstance(r4, Sym) else ("translate", r4))
        elif target == functions["push"]:
            out.append(("push",))
        elif target == functions["pop"]:
            out.append(("pop", r4))
    return out


def draw_tree(events, executable):
    """Nodes [{bone, parent (node index or None), translation ('root', vector or None)}] and
    draws [(node index, model address)] from a draw routine's events."""
    nodes, draws, stack, node, pending = [], [], [], None, None
    for event in events:
        kind = event[0]
        if kind == "push":
            stack.append((node, pending))
        elif kind == "pop":
            count = event[1]
            if count < 1 or count > len(stack):
                raise ValueError("unbalanced matrix stack")
            node, pending = stack[-count]
            del stack[-count:]
        elif kind == "root":
            if pending is not None:
                raise ValueError("translation before root")
            pending = "root"
        elif kind == "translate":
            vector = struct.unpack_from("<3f", executable, event[1] - LOAD)
            if pending == "root":
                raise ValueError("translation after root")
            pending = vector if pending is None else tuple(a + b for a, b in zip(pending, vector))
        elif kind == "rotate":
            nodes.append(dict(bone=event[1], parent=node, translation=pending))
            node, pending = len(nodes) - 1, None
        elif kind == "put":
            if pending is not None or node is None:
                raise ValueError("model drawn off a bone")
            draws.append((node, event[1]))
    if stack:
        raise ValueError("matrix stack not empty at return")
    return nodes, draws


def quaternion(a, c):
    """(x, y, z, w) of the rotation with columns a, c, a x c (Gram-Schmidt first); and the
    input's departure from orthonormal."""
    la = math.sqrt(sum(v * v for v in a))
    error = abs(la - 1.0)
    x = [v / la for v in a]
    dot = sum(p * q for p, q in zip(x, c))
    lc = math.sqrt(sum(v * v for v in c))
    error = max(error, abs(lc - 1.0), abs(dot))
    y = [q - dot * p for p, q in zip(x, c)]
    ly = math.sqrt(sum(v * v for v in y))
    y = [v / ly for v in y]
    z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
    m00, m01, m02 = x[0], y[0], z[0]
    m10, m11, m12 = x[1], y[1], z[1]
    m20, m21, m22 = x[2], y[2], z[2]
    trace = m00 + m11 + m22
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        q = ((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s)
    elif m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        q = (0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s)
    elif m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        q = ((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s)
    else:
        s = math.sqrt(1.0 + m22 - m00 - m11) * 2
        q = ((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s)
    if q[3] < 0:
        q = tuple(-v for v in q)
    return q, error


def pose(vectors, nodes):
    """Per node: (rotation quaternion, translation or None); and the orthonormal error."""
    out, worst = [], 0.0
    for node in nodes:
        b = node["bone"]
        q, error = quaternion(vectors[1 + 2 * b], vectors[2 + 2 * b])
        worst = max(worst, error)
        t = node["translation"]
        out.append((q, tuple(vectors[0]) if t == "root" else t))
    return out, worst


def world_positions(nodes, posed):
    """World position of every node's origin (for checks)."""
    def rotate(q, v):
        x, y, z, w = q
        u = (x, y, z)
        t = [2 * (u[1] * v[2] - u[2] * v[1]), 2 * (u[2] * v[0] - u[0] * v[2]), 2 * (u[0] * v[1] - u[1] * v[0])]
        return tuple(v[i] + w * t[i] + (u[(i + 1) % 3] * t[(i + 2) % 3] - u[(i + 2) % 3] * t[(i + 1) % 3])
                     for i in range(3))

    def mul(q, r):
        x1, y1, z1, w1 = q
        x2, y2, z2, w2 = r
        return (w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2)

    world = []
    for node, (q, t) in zip(nodes, posed):
        if node["parent"] is None:
            pq, pt = (0.0, 0.0, 0.0, 1.0), (0.0, 0.0, 0.0)
        else:
            pq, pt = world[node["parent"]]
        offset = rotate(pq, t) if t else (0.0, 0.0, 0.0)
        world.append((mul(pq, q), tuple(a + b for a, b in zip(pt, offset))))
    return [p for _, p in world]


def add_nodes(gltf, nodes, posed, root_name):
    """Bone nodes under one scene root; returns their glTF indices."""
    doc = gltf.doc
    doc["nodes"].append(dict(name=root_name, children=[]))
    root = len(doc["nodes"]) - 1
    doc["scenes"][0]["nodes"].append(root)
    ids = []
    for node, (q, t) in zip(nodes, posed):
        item = dict(name="bone_%d" % node["bone"], rotation=[round(v, 7) for v in q])
        if t:
            item["translation"] = [round(v, 6) for v in t]
        doc["nodes"].append(item)
        ids.append(len(doc["nodes"]) - 1)
        parent = root if node["parent"] is None else ids[node["parent"]]
        doc["nodes"][parent].setdefault("children", []).append(ids[-1])
    return ids


def animation_accessor(gltf, values, width, bounds=False):
    index = gltf.accessor(values, 5126, width, None, bounds)
    del gltf.doc["bufferViews"][gltf.doc["accessors"][index]["bufferView"]]["target"]
    return index


def add_motion(gltf, ids, nodes, data, header, frames, name, extras):
    """One animation: records 1 .. frames-1, then record 1 again (the game's loop)."""
    order = list(range(1, frames)) + [1]
    records = [record_vectors(data, header, frames, k) for k in order]
    times = [k / FRAME_RATE for k in range(len(order))]
    time_accessor = animation_accessor(gltf, times, 1, True)
    samplers, channels, worst = [], [], 0.0
    for node_id, node in zip(ids, nodes):
        quats, previous = [], None
        for vectors in records:
            q, error = quaternion(vectors[1 + 2 * node["bone"]], vectors[2 + 2 * node["bone"]])
            worst = max(worst, error)
            if previous is not None and sum(p * v for p, v in zip(previous, q)) < 0:
                q = tuple(-v for v in q)
            quats.extend(q)
            previous = q
        samplers.append(dict(input=time_accessor, output=animation_accessor(gltf, quats, 4), interpolation="LINEAR"))
        channels.append(dict(sampler=len(samplers) - 1, target=dict(node=node_id, path="rotation")))
        if node["translation"] == "root":
            moves = [c for vectors in records for c in vectors[0]]
            samplers.append(dict(input=time_accessor, output=animation_accessor(gltf, moves, 3),
                                 interpolation="LINEAR"))
            channels.append(dict(sampler=len(samplers) - 1, target=dict(node=node_id, path="translation")))
    gltf.doc.setdefault("animations", []).append(dict(name=name, samplers=samplers, channels=channels,
                                                      extras=extras))
    return worst


def discover(source):
    """Everything the converter needs, found in the disc files."""
    executable = (source / "1ST_READ.BIN").read_bytes()
    poldc0 = (source / "POLDC0.BIN").read_bytes()
    motdc = (source / "MOTDC.BIN").read_bytes()
    model_offsets = [m[0] for m in find_models(poldc0)]
    base = find_base(executable, model_offsets, len(poldc0))
    model_addresses = set(base + o for o in model_offsets)
    table, arrays = find_character_table(executable, base, model_offsets)
    motion_base, motions = find_motions(motdc)
    headers = dict(motions)
    if REST_MOTION not in headers:
        raise ValueError("rest motion is not a V motion")
    memory = [(LOAD, executable), (base, poldc0), (motion_base, motdc)]
    entries = call_targets(executable)
    candidates = set()
    for site in function_entries(executable, table):
        before = [e for e in entries if e <= site]
        if before:
            candidates.add(before[-1])
    header = motion_base + REST_MOTION
    fullest = max(range(len(arrays)), key=lambda k: sum(1 for x in words(executable[arrays[k] - LOAD:][:64]) if x))
    found = []
    for entry in sorted(candidates):
        try:
            functions = identify(run_draw(memory, entry, (header, fullest, 1, 0)), model_addresses)
        except ValueError:
            continue
        if functions is not None:
            found.append((entry, functions))
    if len(found) != 1:
        raise ValueError("expected one V-format draw routine, found %d" % len(found))
    entry, functions = found[0]
    characters, shape = [], None
    for index, array in enumerate(arrays):
        nodes, draws = draw_tree(events(run_draw(memory, entry, (header, index, 1, 0)), functions), executable)
        signature = [(n["bone"], n["parent"], n["translation"]) for n in nodes]
        if shape is None:
            shape = signature
        elif signature != shape:
            raise ValueError("character %d has a different skeleton" % index)
        slots = list(struct.unpack_from("<%dI" % SLOTS, executable, array - LOAD))
        characters.append(dict(index=index, array=array, slots=slots, draws=draws))
    return dict(executable=executable, poldc0=poldc0, motdc=motdc, base=base, table=table,
                motion_base=motion_base, motions=sorted(motions), draw=entry, functions=functions,
                nodes=nodes, characters=characters)

def find_select_table(executable, motion_addresses, count):
    """The character-select records {word, idle motion, select motion, character}: runs of
    16-byte records whose two motions are V motions and whose character is in the table."""
    w, found = words(executable), []
    for i in range(0, len(w) - 4):
        if w[i + 1] in motion_addresses and w[i + 2] in motion_addresses and w[i + 3] < count \
                and w[i + 1] != w[i + 2]:
            found.append((LOAD + 4 * i, w[i + 1], w[i + 2], w[i + 3]))
    runs, run = [], []
    for item in found:
        if run and item[0] != run[-1][0] + 16:
            runs.append(run)
            run = []
        run.append(item)
    if run:
        runs.append(run)
    return max(runs, key=len) if runs else []


def extract(source, textures, output):
    source, textures, output = Path(source).resolve(), Path(textures).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    found = discover(source)
    bank = dict((b["source"], b["textures"]) for b in json.loads((textures / "manifest.json").read_text())["banks"])
    bank = bank["TEXDC0.BIN"]
    executable, poldc0, motdc, base = found["executable"], found["poldc0"], found["motdc"], found["base"]
    nodes, motion_base = found["nodes"], found["motion_base"]
    frames_of = dict(found["motions"])
    posed, rest_error = pose(record_vectors(motdc, REST_MOTION, frames_of[REST_MOTION], 1), nodes)
    world = world_positions(nodes, posed)
    select = find_select_table(executable, set(motion_base + o for o, _ in found["motions"]),
                               len(found["characters"]))
    cabbies = ("Axel", "B.D. Joe", "Gena", "Gus")  # selection-screen order
    names = dict((ch, cabbies[k]) for k, (_, _, _, ch) in enumerate(select)) if len(select) == 4 else {}
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".characters-", dir=output.parent))
    manifest = dict(
        schema=1, textures=textures.name, texture_bank="TEXDC0.BIN",
        sources=dict((n, dict(size=len(b), sha256=digest(b))) for n, b in
                     (("1ST_READ.BIN", executable), ("POLDC0.BIN", poldc0), ("MOTDC.BIN", motdc))),
        poldc0_base=base, character_table=found["table"], motdc_base=motion_base,
        draw_routine=found["draw"], draw_functions=found["functions"],
        frame_rate=FRAME_RATE, frame_rate_note="nominal; the game's playback rate is not established",
        rest_pose=dict(motion=REST_MOTION, record=1, orthonormal_error=rest_error,
                       bone_positions=dict(("bone_%d" % n["bone"], [round(v, 4) for v in p])
                                           for n, p in zip(nodes, world))),
        skeleton=[dict(bone=n["bone"], parent=None if n["parent"] is None else nodes[n["parent"]]["bone"],
                       translation="root" if n["translation"] == "root" else
                       None if n["translation"] is None else [round(v, 6) for v in n["translation"]])
                  for n in nodes],
        select_screen=[dict(record=r, idle=i, select=s, character=c) for r, i, s, c in select],
        characters=[], motions=[])
    gallery = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi characters</title>',
               '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px}</style>',
               '<h1>Local Crazy Taxi characters</h1><p>Each GLB is one assembled person in a standing pose; '
               'motions.glb holds every motion on the same bone names (bone_0 ... bone_15), so its clips '
               'play on any character. Serve this folder\'s parent over HTTP to view them.</p><h2>Characters</h2>'
               '<table>']
    try:
        (staging / "characters").mkdir()
        for character in found["characters"]:
            entry = dict(index=character["index"], parts_array=character["array"], parts=[])
            if character["index"] in names:
                entry["name"] = names[character["index"]]
            if character["draws"]:
                gltf = Gltf("TEXDC0.BIN", bank, "../../%s/" % textures.name)
                ids = add_nodes(gltf, nodes, posed, "character_%02x" % character["index"])
                meshes, triangles = {}, 0
                for node, address in character["draws"]:
                    bone = nodes[node]["bone"]
                    slot = bone if character["slots"][bone] == address else None
                    label = SLOT_NAMES[bone] if slot is not None else "%s_extra" % SLOT_NAMES.get(bone, "bone")
                    offset = address - base
                    if address not in meshes:
                        model = parse_model(poldc0, offset)
                        meshes[address] = gltf.mesh("POLDC0_%06x" % offset, model)
                        triangles += meshes[address][1]
                    mesh = meshes[address][0]
                    item = dict(name="%s_%06x" % (label, offset), extras=dict(source="POLDC0.BIN", offset=offset))
                    if mesh is not None:
                        item["mesh"] = mesh
                    gltf.doc["nodes"].append(item)
                    gltf.doc["nodes"][ids[node]].setdefault("children", []).append(len(gltf.doc["nodes"]) - 1)
                    entry["parts"].append(dict(bone=bone, offset=offset, part=label, slot=slot))
                relative = "characters/char_%02x.glb" % character["index"]
                blob = gltf.glb()
                (staging / relative).write_bytes(blob)
                entry.update(glb=relative, glb_sha256=digest(blob), triangles=triangles)
                gallery.append('<tr><td><a href="%s">%s</a></td><td>%s</td><td>%d parts</td><td>%d triangles</td></tr>'
                               % (relative, relative, html.escape(entry.get("name", "")), len(entry["parts"]),
                                  triangles))
            manifest["characters"].append(entry)
        gallery.append("</table><h2>Motions</h2><p><a href=\"motions.glb\">motions.glb</a></p><table>")
        gltf = Gltf(None, [], "")
        ids = add_nodes(gltf, nodes, posed, "skeleton")
        worst = 0.0
        for offset, frames in found["motions"]:
            first = record_vectors(motdc, offset, frames, 1)[0]
            last = record_vectors(motdc, offset, frames, frames - 1)[0]
            travel = math.sqrt((last[0] - first[0]) ** 2 + (last[2] - first[2]) ** 2)
            extras = dict(source="MOTDC.BIN", offset=offset, address=motion_base + offset, frames=frames)
            worst = max(worst, add_motion(gltf, ids, nodes, motdc, offset, frames, "motion_%06x" % offset, extras))
            manifest["motions"].append(dict(extras, name="motion_%06x" % offset, played_records=frames - 1,
                                            root_travel=round(travel, 4)))
            gallery.append("<tr><td>motion_%06x</td><td>%d frames</td><td>root travel %.2f</td></tr>"
                           % (offset, frames, travel))
        blob = gltf.glb()
        (staging / "motions.glb").write_bytes(blob)
        manifest.update(motions_glb="motions.glb", motions_glb_sha256=digest(blob), motion_orthonormal_error=worst)
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
    people = [c for c in manifest["characters"] if "glb" in c]
    print("Assembled %d characters (%d parts) and %d motions into %s"
          % (len(people), sum(len(c["parts"]) for c in people), len(manifest["motions"]), args.output))


if __name__ == "__main__":
    main()
