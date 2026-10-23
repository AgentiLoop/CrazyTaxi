"""Orchestration tests with fake steps and a fake disc: no game files required."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tools import extract_all


def fake_step(folder, seen, fail=False):
    def run(disc, folder_of):
        seen.append((folder, disc))
        if fail:
            raise ValueError("step failed")
        out = folder_of(folder)
        out.mkdir()
        (out / "index.html").write_text("x")
        (out / "data.bin").write_bytes(b"1234")
    return (folder, folder.title(), run)


class ExtractAllTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.disc = self.root / "disc"
        self.disc.mkdir()
        (self.disc / "1ST_READ.BIN").write_bytes(b"\0")

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_step_order_matches_dependencies(self):
        order = [folder for folder, _, _ in extract_all.steps()]
        self.assertEqual(len(order), len(set(order)))
        for before, after in [("textures", "models"), ("textures", "characters"), ("textures", "vehicles"),
                              ("textures", "props"), ("courses", "customers"), ("audio", "customers"),
                              ("landmarks", "customers"), ("customers", "replay_cuts"), ("audio", "sound_uses")]:
            self.assertLess(order.index(before), order.index(after), (before, after))

    def test_steps_wire_sibling_folders(self):
        calls = {}
        names = ["extract_textures", "extract_models", "extract_customers", "extract_replay_cuts"]
        patches = [mock.patch.object(getattr(extract_all, n), "extract",
                                     side_effect=lambda *a, n=n: calls.setdefault(n, a)) for n in names]
        for p in patches:
            p.start()
        try:
            table = dict((folder, run) for folder, _, run in extract_all.steps())
            o = lambda name: Path("/out") / name  # noqa: E731
            for folder in ["textures", "models", "customers", "replay_cuts"]:
                table[folder]("D", o)
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(calls["extract_textures"], ("D", Path("/out/textures")))
        self.assertEqual(calls["extract_models"], ("D", Path("/out/textures"), Path("/out/models")))
        self.assertEqual(calls["extract_customers"], ("D", Path("/out/customers"), Path("/out/courses"),
                                                      Path("/out/audio"), Path("/out/landmarks")))
        self.assertEqual(calls["extract_replay_cuts"], ("D", Path("/out/replay_cuts"), Path("/out/customers")))

    def test_disc_folder_run_writes_manifest_and_index(self):
        seen = []
        out = self.root / "all"
        manifest = extract_all.extract(self.disc, out, step_list=[fake_step("a", seen), fake_step("b", seen)],
                                       log=lambda _: None)
        self.assertEqual([s for s, _ in seen], ["a", "b"])
        self.assertEqual(seen[0][1], self.disc.absolute())
        self.assertEqual(manifest["disc"], "../disc")
        self.assertEqual([(s["folder"], s["files"], s["bytes"], s["index"]) for s in manifest["steps"]],
                         [("a", 2, 5, True), ("b", 2, 5, True)])
        self.assertEqual(json.loads((out / "manifest.json").read_text()), manifest)
        page = (out / "index.html").read_text()
        self.assertIn('href="a/index.html"', page)
        self.assertIn('href="../disc/manifest.json"', page)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["all", "disc"])

    def test_failure_leaves_nothing(self):
        out = self.root / "all"
        with self.assertRaises(ValueError):
            extract_all.extract(self.disc, out, step_list=[fake_step("a", []), fake_step("b", [], fail=True)],
                                log=lambda _: None)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["disc"])

    def test_refusals(self):
        (self.root / "exists").mkdir()
        cases = [(self.disc, self.root / "exists", "already exists"),
                 (self.root / "missing.7z", self.root / "o", "does not exist"),
                 (self.root / "x.chd", self.root / "o", "CHD"),
                 (self.root / "x.iso", self.root / "o", "must be"),
                 (self.root / "exists", self.root / "o", "1ST_READ")]
        (self.root / "x.chd").write_bytes(b"")
        (self.root / "x.iso").write_bytes(b"")
        for source, out, message in cases:
            with self.assertRaisesRegex(ValueError, message):
                extract_all.extract(source, out, step_list=[], log=lambda _: None)

    def test_bin_source_runs_disc_extractor(self):
        track = self.root / "Game (Track 3).bin"
        track.write_bytes(b"")
        seen = []

        def fake_disc(track_path, output):
            seen.append(Path(track_path))
            output.mkdir()
            (output / "manifest.json").write_text("{}")
        with mock.patch.object(extract_all.extract_disc, "extract", side_effect=fake_disc):
            manifest = extract_all.extract(track, self.root / "all", step_list=[fake_step("a", seen)],
                                           log=lambda _: None)
        self.assertEqual(seen[0], track.absolute())
        self.assertEqual(seen[1][1].name, "disc")
        self.assertEqual(manifest["disc"], "disc")
        self.assertTrue((self.root / "all" / "disc" / "manifest.json").is_file())

    @unittest.skipUnless(shutil.which("tar"), "needs tar")
    def test_unpack_track_picks_track_3(self):
        src = self.root / "src"
        src.mkdir()
        for name in ["G (Track 1).bin", "G (Track 3).bin", "G.cue"]:
            (src / name).write_bytes(name.encode())
        archive = self.root / "g.tar"
        subprocess.run(["tar", "-cf", str(archive), "-C", str(src), "G (Track 1).bin", "G (Track 3).bin", "G.cue"],
                       check=True)
        track = extract_all.unpack_track(archive, self.root / "tracks")
        self.assertEqual(track.read_bytes(), b"G (Track 3).bin")
        self.assertEqual(sorted(p.name for p in (self.root / "tracks").iterdir()), ["G (Track 3).bin"])
        archive2 = self.root / "none.tar"
        subprocess.run(["tar", "-cf", str(archive2), "-C", str(src), "G.cue"], check=True)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            extract_all.unpack_track(archive2, self.root / "t2")


if __name__ == "__main__":
    unittest.main()
