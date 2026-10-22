"""Synthetic key-curve (Fcv) motion fixtures: no game files or upstream modules required."""
import json
from pathlib import Path
import struct
import tempfile
import unittest

from tools import extract_fcv_motions as fcv

LOAD = fcv.LOAD
BASE = 0x0C880000
ARM, LEG = (2.508, 2.5145), (4.051, 4.2466)
BIND = [(4.4849, 0.0, 0.0), (3.6611, 0.056, -1.7876), (ARM[0], 0.0, 0.0), (ARM[1], 0.0, 0.0),
        (3.6611, 0.056, 1.7876), (ARM[0], 0.0, 0.0), (ARM[1], 0.0, 0.0),
        (1.1603, 0.1486, -1.1764), (LEG[0], 0.0, 0.0), (LEG[1], 0.0, 0.0),
        (1.1603, 0.1486, 1.1764), (LEG[0], 0.0, 0.0), (LEG[1], 0.0, 0.0)]


def f32(x):
    return struct.unpack("<I", struct.pack("<f", x))[0]


def channel(keys):
    """keys: [(frame, raw value, raw in, raw out)]."""
    return struct.pack("<I", len(keys)) + b"".join(struct.pack("<iIII", *k) for k in keys)


def constant(values, frames, angle):
    """A three-channel curve holding `values` from frame 0 to frames - 1."""
    raw = [(v & 0xFFFFFFFF) if angle else f32(v) for v in values]
    return b"".join(channel([(0, r, 0, 0), (frames - 1, r, 0, 0)]) for r in raw)


# A seated pose in the character's axes: root, then left/right hand and left/right foot targets.
POSE = {0: (0.0, 5.6, 0.0), 1: (-3.3, 8.8, -1.9), 2: (2.0, 8.3, -3.0), 3: (-2.3, 3.2, -8.5), 4: (1.4, 3.2, -8.6)}


def motion(frames):
    """One Fcv motion: header (frames, 17 offsets) and its curves in header order."""
    curves = []
    for k in range(fcv.CURVES):
        slot = fcv.BUFFER[k]
        if slot < 5:
            curves.append(constant(POSE[slot], frames, False))
        else:
            curves.append(constant((0x100 * slot, -0x80 * slot, 0x40 * slot), frames, True))
    offsets, at = [], fcv.HEADER_WORDS
    for c in curves:
        offsets.append(at)
        at += len(c) // 4
    return struct.pack("<18I", frames, *offsets) + b"".join(curves)


def v_motion(frames, base, at):
    """A V-format motion (frames x 396 bytes, then {frames, 15, data}) placed at offset at."""
    return bytes(frames * 396) + struct.pack("<3I", frames, 15, base + at)


def fixture_motdc():
    first, second = motion(5), motion(9)
    data = first + second
    v1 = v_motion(2, BASE, len(data))
    v2 = v_motion(3, BASE, len(data) + len(v1))
    return data + v1 + v2, [0, len(first)], len(data)


def fixture_executable(offsets):
    exe = bytearray(0x400)
    struct.pack_into("<I", exe, 0x08, BASE + offsets[1])  # a stray reference
    struct.pack_into("<%dI" % len(offsets), exe, 0x40, *(BASE + o for o in offsets))
    struct.pack_into("<8f", exe, 0x100, ARM[0], LEG[0], ARM[1], LEG[1],
                     ARM[0] ** 2, LEG[0] ** 2, ARM[1] ** 2, LEG[1] ** 2)
    for k, v in enumerate(BIND):
        struct.pack_into("<3f", exe, 0x200 + 12 * k, *v)
    return bytes(exe)


def write_disc(folder):
    motdc, offsets, _ = fixture_motdc()
    (folder / "MOTDC.BIN").write_bytes(motdc)
    (folder / "1ST_READ.BIN").write_bytes(fixture_executable(offsets))


def lengths():
    exe = fixture_executable([0, 4])
    return fcv.find_ik_lengths(exe)[1]


class CurveTests(unittest.TestCase):
    def test_hermite_basis_and_tangents(self):
        a, b = (0, f32(1.0), 0, 0), (10, f32(3.0), 0, 0)
        self.assertEqual(fcv.hermite(a, b, 0.0, False), 1.0)
        self.assertEqual(fcv.hermite(a, b, 1.0, False), 3.0)
        self.assertAlmostEqual(fcv.hermite(a, b, 0.5, False), 2.0)
        self.assertEqual(fcv.hermite(a, b, 2.0, False), 3.0)  # t is clamped
        out = (0, f32(0.0), 0, f32(1.0))  # only a's out tangent
        self.assertAlmostEqual(fcv.hermite(out, (10, f32(0.0), 0, 0), 0.5, False), 0.125)
        into = (10, f32(0.0), f32(1.0), 0)  # only b's in tangent
        self.assertAlmostEqual(fcv.hermite((0, f32(0.0), 0, 0), into, 0.5, False), -0.125)

    def test_angles_are_signed_and_truncated(self):
        a, b = (0, 0, 0, 0), (2, (-3) & 0xFFFFFFFF, 0, 0)
        self.assertEqual(fcv.hermite(a, b, 0.5, True), -1)  # -1.5 truncates toward zero

    def test_channel_search_follows_the_game(self):
        keys = [(0, f32(0.0), 0, 0), (4, f32(4.0), 0, 0), (8, f32(8.0), 0, 0)]
        self.assertAlmostEqual(fcv.channel_value(keys, 2.0, False), 2.0)
        self.assertEqual(fcv.channel_value(keys, 4.0, False), 4.0)
        self.assertEqual(fcv.channel_value(keys, 8.0, False), 8.0)
        self.assertIsNone(fcv.channel_value(keys, 9.0, False))
        self.assertIsNone(fcv.channel_value(keys, -1.0, False))
        backwards = [(0, f32(0.0), 0, 0), (6, f32(6.0), 0, 0), (3, f32(3.0), 0, 0), (9, f32(9.0), 0, 0)]
        self.assertEqual(fcv.channel_value(backwards, 3.0, False), 3.0)  # equality with the next key wins
        t = 4.0 / 6.0  # 7 falls in the (3, 9) pair; zero tangents give a smoothstep
        self.assertAlmostEqual(fcv.channel_value(backwards, 7.0, False), 3.0 + 6.0 * (3 * t * t - 2 * t ** 3))

    def test_unwritten_channels_keep_the_previous_value(self):
        curves = [[[(0, f32(1.0), 0, 0), (2, f32(1.0), 0, 0)]] * 3] * fcv.CURVES
        buffer, misses = fcv.evaluate(curves, 5.0, [(7, 7, 7)] * fcv.CURVES)
        self.assertEqual(misses, 3 * fcv.CURVES)
        self.assertEqual(buffer[0], (7, 7, 7))


class DiscoveryTests(unittest.TestCase):
    def test_motions_run_back_to_back_and_stop_at_v_data(self):
        motdc, offsets, end = fixture_motdc()
        found, stop = fcv.find_fcv_motions(motdc)
        self.assertEqual([o for o, _, _ in found], offsets)
        self.assertEqual([f for _, f, _ in found], [5, 9])
        self.assertEqual(stop, end)

    def test_gap_between_curves_is_rejected(self):
        data = bytearray(motion(5))
        struct.pack_into("<I", data, 8, struct.unpack_from("<I", data, 8)[0] + 1)
        self.assertIsNone(fcv.parse_motion(fcv.words(bytes(data) + bytes(64)), 0))

    def test_motion_table_must_list_every_motion_in_order(self):
        self.assertEqual(fcv.find_motion_table(fixture_executable([0, 0x40]), BASE, [0, 0x40]), LOAD + 0x40)
        with self.assertRaises(ValueError):
            fcv.find_motion_table(fixture_executable([0x40, 0]), BASE, [0, 0x40])

    def test_solver_lengths_and_bind_table(self):
        exe = fixture_executable([0, 4])
        address, found, _ = fcv.find_ik_lengths(exe)
        self.assertEqual(address, LOAD + 0x100)
        self.assertAlmostEqual(found[0][0], ARM[0], places=5)
        self.assertAlmostEqual(found[1][1], LEG[1], places=5)
        address, bind = fcv.find_bind_offsets(exe, found)
        self.assertEqual(address, LOAD + 0x200)
        self.assertAlmostEqual(bind[0][0], 4.4849, places=5)

    def test_skeleton_matches_the_draw_tree(self):
        nodes = fcv.skeleton(BIND)
        bones = [n["bone"] for n in nodes]
        self.assertEqual(bones, [0, 8, 1, 4, 3, 2, 7, 6, 5, 15, 11, 10, 9, 14, 13, 12])
        parent = dict((n["bone"], None if n["parent"] is None else bones[n["parent"]]) for n in nodes)
        self.assertEqual((parent[1], parent[4], parent[2], parent[11], parent[12]), (8, 8, 3, 15, 13))
        self.assertEqual(nodes[0]["translation"], "root")
        self.assertEqual(nodes[2]["translation"], BIND[0])
        self.assertEqual(nodes[13]["translation"], BIND[10])


class PoseTests(unittest.TestCase):
    def test_rotation_order_and_head_quarter_turn(self):
        m = fcv.fcv_rotate((0x1000, 0x2000, 0x3000))
        expected = fcv.mat_mul(fcv.mat_mul(fcv.rot_z(0x3000), fcv.rot_y(0x2000)), fcv.rot_x(0x1000))
        self.assertEqual(m, expected)
        head = fcv.apply(fcv.rot_z(-0x4000), (0.0, 4.4849, 0.0))
        self.assertAlmostEqual(head[0], 4.4849)
        self.assertAlmostEqual(head[1], 0.0)

    def test_limbs_reach_reachable_targets(self):
        buffer = [POSE.get(k, (0, 0, 0)) for k in range(5)] + [(0x100 * s, -0x80 * s, 0x40 * s) for s in range(5, 17)]
        local, root, reach = fcv.build_pose(buffer, BIND, lengths())
        self.assertEqual(root, POSE[0])
        self.assertEqual(sorted(local), list(range(16)))
        for distance, error, ok, _ in reach:
            self.assertTrue(ok)
            self.assertLess(error, 1e-3)

    def test_out_of_reach_limb_points_straight_at_the_target(self):
        m = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        rotation, bend1, bend2, distance = fcv.solve_ik(m, (0, 0, 0), (0.0, 20.0, 0.0), ARM)
        self.assertEqual((bend1, bend2), (0, 0))
        tip = fcv.apply(rotation, (1.0, 0.0, 0.0))
        self.assertAlmostEqual(tip[1], 1.0)
        self.assertEqual(fcv.game_acos(1.5), 0)

    def test_sample_loops_back_to_frame_zero(self):
        motdc, _, _ = fixture_motdc()
        (offset, frames, curves), _ = fcv.find_fcv_motions(motdc)[0]
        poses, stats = fcv.sample(curves, frames, BIND, lengths())
        self.assertEqual(len(poses), frames)
        self.assertIs(poses[-1], poses[0])
        self.assertEqual(stats["unwritten_channel_frames"], 0)
        self.assertEqual(stats["limbs_reached"], 4 * (frames - 1))


class ExtractTests(unittest.TestCase):
    def test_full_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            disc = Path(tmp) / "disc"
            disc.mkdir()
            write_disc(disc)
            manifest = fcv.extract(disc, Path(tmp) / "out")
            out = Path(tmp) / "out"
            self.assertEqual(manifest["motdc_base"], BASE)
            self.assertEqual(manifest["motion_table"], LOAD + 0x40)
            self.assertEqual([m["frames"] for m in manifest["motions"]], [5, 9])
            self.assertEqual(manifest["motions"][1]["references"], [LOAD + 0x08])
            self.assertEqual(manifest["motions"][0]["references"], [])
            saved = json.loads((out / "manifest.json").read_text())
            self.assertEqual(saved["totals"]["limbs_out_of_reach"], 0)
            blob = (out / "fcv_motions.glb").read_bytes()
            self.assertEqual(blob[:4], b"glTF")
            length = struct.unpack_from("<I", blob, 12)[0]
            doc = json.loads(blob[20:20 + length])
            self.assertEqual([a["name"] for a in doc["animations"]], ["fcv_000_000000", "fcv_001_%06x" % (
                manifest["motions"][1]["offset"])])
            names = set(n.get("name") for n in doc["nodes"])
            self.assertTrue(set("bone_%d" % b for b in range(16)) <= names)
            self.assertTrue((out / "index.html").exists())
            with self.assertRaises(ValueError):
                fcv.extract(disc, out)
            again = fcv.extract(disc, Path(tmp) / "again")
            self.assertEqual(again["glb_sha256"], manifest["glb_sha256"])


if __name__ == "__main__":
    unittest.main()
