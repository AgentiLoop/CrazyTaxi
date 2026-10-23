#!/usr/bin/env python3
"""Run every Crazy Taxi extractor in order into one new local folder (stdlib only).

The input is the supplied `.7z` archive, its raw high-density `(Track 3).bin`, or an already
extracted disc folder (extract_disc.py output). From the archive only the Track 3 `.bin` is
unpacked (macOS `tar`, i.e. bsdtar, reads 7z); the `.chd` is not supported because CHD
decompression is not implemented. Each converter writes its usual folder as a sibling inside the
output (`textures/`, `models/`, ...), with the cross-links the single tools take (`--textures`,
`--courses`, `--audio`, `--landmarks`, `--customers`). Everything is built in a hidden staging
folder next to the output and renamed into place only when every step succeeded; on any error the
staging folder is removed. The output gets `manifest.json` (steps, seconds, file counts and bytes)
and `index.html` linking every step's own page.
"""
import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

try:
    from tools import (extract_audio, extract_characters, extract_collision, extract_courses, extract_customers,
                       extract_disc, extract_fcv_motions, extract_landmarks, extract_models, extract_motion_uses,
                       extract_props, extract_pvr, extract_replay_cuts, extract_replays, extract_sound_uses,
                       extract_sprites, extract_textures, extract_vehicles)
except ImportError:  # run as a script from tools/
    import extract_audio, extract_characters, extract_collision, extract_courses, extract_customers  # noqa: E401
    import extract_disc, extract_fcv_motions, extract_landmarks, extract_models, extract_motion_uses  # noqa: E401
    import extract_props, extract_pvr, extract_replay_cuts, extract_replays, extract_sound_uses  # noqa: E401
    import extract_sprites, extract_textures, extract_vehicles  # noqa: E401

TRACK = re.compile(r"\(Track 3\)\.bin$", re.IGNORECASE)


def steps():
    """(folder, title, run(disc, folder_of)) in dependency order; folder_of(name) is that step's output."""
    return [
        ("textures", "TEXDC textures (PNG)", lambda d, o: extract_textures.extract(d, o("textures"))),
        ("models", "POLDC/BINC models (glTF)", lambda d, o: extract_models.extract(d, o("textures"), o("models"))),
        ("sprites", "SPR sprites (PNG)", lambda d, o: extract_sprites.extract(d, o("sprites"))),
        ("pvr", "Disc label image (PNG)", lambda d, o: extract_pvr.extract(d, o("pvr"))),
        ("audio", "Music, voices and sound banks (WAV)", lambda d, o: extract_audio.extract(d, o("audio"))),
        ("characters", "Characters and V motions (glTF)",
         lambda d, o: extract_characters.extract(d, o("textures"), o("characters"))),
        ("vehicles", "Traffic and cabs (glTF)", lambda d, o: extract_vehicles.extract(d, o("textures"), o("vehicles"))),
        ("props", "Set objects (glTF)", lambda d, o: extract_props.extract(d, o("textures"), o("props"))),
        ("collision", "Course collision (glTF + JSON)", lambda d, o: extract_collision.extract(d, o("collision"))),
        ("courses", "Course lines (glTF + JSON)", lambda d, o: extract_courses.extract(d, o("courses"))),
        ("landmarks", "Destination pictures (PNG)", lambda d, o: extract_landmarks.extract(d, o("landmarks"))),
        ("fcv_motions", "Key-curve motions (glTF)", lambda d, o: extract_fcv_motions.extract(d, o("fcv_motions"))),
        ("replays", "Recorded drives (JSON)", lambda d, o: extract_replays.extract(d, o("replays"))),
        ("motion_uses", "Motion uses (JSON)", lambda d, o: extract_motion_uses.extract(d, o("motion_uses"))),
        ("customers", "Customers and stops (JSON)",
         lambda d, o: extract_customers.extract(d, o("customers"), o("courses"), o("audio"), o("landmarks"))),
        ("replay_cuts", "Replay cuts (JSON)", lambda d, o: extract_replay_cuts.extract(d, o("replay_cuts"),
                                                                                       o("customers"))),
        ("sound_uses", "Sound request uses (JSON)",
         lambda d, o: extract_sound_uses.extract(d, o("sound_uses"), o("audio"))),
    ]


def unpack_track(archive, folder):
    """Unpack only the archive's Track 3 .bin into `folder` with tar; return its path."""
    listing = subprocess.run(["tar", "-tf", str(archive)], check=True, capture_output=True, text=True).stdout
    members = [name for name in listing.splitlines() if TRACK.search(name)]
    if len(members) != 1:
        raise ValueError("archive must hold exactly one '(Track 3).bin', found %d" % len(members))
    folder.mkdir()
    subprocess.run(["tar", "-xf", str(archive), "-C", str(folder), members[0]], check=True)
    track = folder / members[0]
    if not track.is_file():
        raise ValueError("tar did not write %s" % members[0])
    return track


def folder_stats(path):
    files = [p for p in path.rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def page(manifest):
    lines = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi local assets</title>',
             '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 10px}'
             'a{color:#9cf}</style>',
             '<h1>Local Crazy Taxi assets</h1><p>Game data: keep it local, do not publish. Serve this folder over '
             'HTTP to view the glTF files and play the WAV links.</p>',
             '<p>Disc: <a href="%s">manifest.json</a></p><table>' % html.escape(manifest["disc"] + "/manifest.json"),
             '<tr><th>Step</th><th>Folder</th><th>Files</th><th>MB</th><th>Seconds</th></tr>']
    for step in manifest["steps"]:
        link = step["folder"] + ("/index.html" if step["index"] else "/manifest.json")
        lines.append('<tr><td><a href="%s">%s</a></td><td>%s</td><td>%d</td><td>%.1f</td><td>%.1f</td></tr>'
                     % (html.escape(link), html.escape(step["title"]), html.escape(step["folder"]), step["files"],
                        step["bytes"] / 1e6, step["seconds"]))
    lines.append("</table>")
    return "\n".join(lines) + "\n"


def extract(source, output, keep_track=False, step_list=None, log=print):
    source, output = Path(source).absolute(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    if not source.exists():
        raise ValueError("source does not exist")
    kind = "disc" if source.is_dir() else source.suffix.lower()
    if kind == ".chd":
        raise ValueError("CHD is not supported; pass the .7z archive or its (Track 3).bin")
    if kind not in ("disc", ".7z", ".bin"):
        raise ValueError("source must be a .7z archive, a (Track 3).bin or an extracted disc folder")
    if kind == "disc" and not (source / "1ST_READ.BIN").is_file():
        raise ValueError("disc folder has no 1ST_READ.BIN")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".%s-" % output.name, dir=output.parent))
    manifest = dict(schema=1, source=dict(name=source.name, kind=kind), steps=[])
    try:
        if kind == "disc":
            disc = source
            manifest["disc"] = os.path.relpath(source, output)
        else:
            started = time.monotonic()
            track = source
            if kind == ".7z":
                log("unpacking Track 3 from %s" % source.name)
                track = unpack_track(source, staging / "tracks")
            log("extracting disc files")
            extract_disc.extract(track, staging / "disc")
            if kind == ".7z" and not keep_track:
                shutil.rmtree(staging / "tracks")
            disc, manifest["disc"] = staging / "disc", "disc"
            manifest["disc_seconds"] = round(time.monotonic() - started, 1)
        for folder, title, run in (step_list if step_list is not None else steps()):
            log("%s -> %s/" % (title, folder))
            started = time.monotonic()
            run(disc, lambda name: staging / name)
            files, size = folder_stats(staging / folder)
            manifest["steps"].append(dict(folder=folder, title=title, seconds=round(time.monotonic() - started, 1),
                                          files=files, bytes=size, index=(staging / folder / "index.html").is_file()))
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "index.html").write_text(page(manifest))
        staging.rename(output)
        return manifest
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help=".7z archive, raw (Track 3).bin or extracted disc folder")
    parser.add_argument("--output", type=Path, required=True, help="new local output folder")
    parser.add_argument("--keep-track", action="store_true", help="keep the unpacked Track 3 .bin under tracks/")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output, args.keep_track, log=lambda line: print(line, flush=True))
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Ran %d steps (%d files, %.0f MB) into %s" % (
        len(manifest["steps"]), sum(s["files"] for s in manifest["steps"]),
        sum(s["bytes"] for s in manifest["steps"]) / 1e6, args.output))


if __name__ == "__main__":
    main()
