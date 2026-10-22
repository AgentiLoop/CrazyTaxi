#!/usr/bin/env python3
"""Extract ISO9660 files from a Dreamcast high-density MODE1/2352 track.

Layout reference: crazy-taxi-decomp/tools/gdi_read.py (Disc.sector/files/_walk).
This independent reader accepts the raw track supplied in the USA archive; it
neither applies European executable addresses nor decodes model/texture payloads.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile

SECTOR = 2352
PAYLOAD = 2048
HD_LBA = 45000
SYNC = b"\x00" + b"\xff" * 10 + b"\x00"


def both32(data, offset):
    little, big = struct.unpack_from("<I", data, offset)[0], struct.unpack_from(">I", data, offset + 4)[0]
    if little != big:
        raise ValueError("ISO9660 endian copies disagree")
    return little


def safe_name(raw):
    name = raw.decode("ascii").split(";", 1)[0]
    if not name or name in (".", "..") or any(c in name for c in '/\\:') or any(ord(c) < 32 for c in name):
        raise ValueError(f"Unsafe ISO9660 name: {raw!r}")
    return name


class RawTrack:
    def __init__(self, path):
        self.path = Path(path)
        self.size = self.path.stat().st_size
        if self.size % SECTOR:
            raise ValueError("Raw track length is not a multiple of 2352")
        self.count = self.size // SECTOR
        self.handle = self.path.open("rb")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.handle.close()

    def check_extent(self, lba, size):
        start = lba - HD_LBA
        if size < 0 or start < 0 or start + (size + PAYLOAD - 1) // PAYLOAD > self.count:
            raise ValueError(f"Extent outside high-density track: LBA {lba}, size {size}")

    def chunks(self, lba, size):
        self.check_extent(lba, size)
        self.handle.seek((lba - HD_LBA) * SECTOR)
        remaining = size
        while remaining:
            sectors = min(128, (remaining + PAYLOAD - 1) // PAYLOAD)
            raw = self.handle.read(sectors * SECTOR)
            if len(raw) != sectors * SECTOR:
                raise ValueError("Truncated raw track")
            block = bytearray()
            for offset in range(0, len(raw), SECTOR):
                if raw[offset:offset + 12] != SYNC or raw[offset + 15] != 1:
                    raise ValueError("Expected raw Mode 1 sector")
                block.extend(raw[offset + 16:offset + 16 + PAYLOAD])
            chunk = bytes(block[:remaining])
            remaining -= len(chunk)
            yield chunk

    def read(self, lba, size):
        return b"".join(self.chunks(lba, size))

    def files(self):
        pvd = self.read(HD_LBA + 16, PAYLOAD)
        if pvd[:7] != b"\x01CD001\x01":
            raise ValueError("No primary ISO9660 descriptor at high-density sector 16")
        if pvd[128:132] != b"\x00\x08\x08\x00":
            raise ValueError("Expected 2048-byte ISO9660 logical blocks")
        self.volume = pvd[40:72].decode("ascii").strip()
        root = pvd[156:190]
        pending = [(both32(root, 2), both32(root, 10), "", 0)]
        visited, names, files = set(), set(), []
        while pending:
            lba, size, prefix, depth = pending.pop()
            if lba in visited or depth > 32:
                raise ValueError("Cyclic, aliased, or excessively deep ISO directory")
            visited.add(lba)
            if size > 16 * 1024 * 1024:
                raise ValueError("ISO directory exceeds 16 MiB safety bound")
            data = self.read(lba, size)
            offset = 0
            while offset < len(data):
                length = data[offset]
                if length == 0:
                    offset = (offset // PAYLOAD + 1) * PAYLOAD
                    continue
                if length < 34 or offset + length > len(data) or offset % PAYLOAD + length > PAYLOAD:
                    raise ValueError("Invalid ISO directory record length")
                rec = data[offset:offset + length]
                offset += length
                if not rec[32] or 33 + rec[32] > length:
                    raise ValueError("Invalid ISO directory name length")
                raw_name = rec[33:33 + rec[32]]
                if raw_name in (b"\x00", b"\x01"):
                    continue
                if rec[1] or rec[26] or rec[27] or rec[25] & 0x80:
                    raise ValueError("Extended, interleaved, and multi-extent records are unsupported")
                name = safe_name(raw_name)
                path = f"{prefix}/{name}" if prefix else name
                key = path.casefold()
                if key in names:
                    raise ValueError(f"Duplicate ISO path: {path}")
                names.add(key)
                extent, length = both32(rec, 2), both32(rec, 10)
                self.check_extent(extent, length)
                if rec[25] & 2:
                    pending.append((extent, length, path, depth + 1))
                else:
                    files.append({"path": path, "lba": extent, "size": length})
        return sorted(files, key=lambda entry: entry["path"])


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract(track_path, output):
    output = Path(output).absolute()
    if output.exists():
        raise FileExistsError(f"Output already exists (will not overwrite): {output}")
    with RawTrack(track_path) as disc:
        entries = disc.files()
        boot = disc.read(HD_LBA, 16 * PAYLOAD)
        if not boot.startswith(b"SEGA SEGAKATANA "):
            raise ValueError("Track lacks a Dreamcast bootstrap")
        if any(entry["path"].split("/")[0].casefold() in ("ip.bin", "manifest.json") for entry in entries):
            raise ValueError("Disc path conflicts with extraction metadata")
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
        try:
            for entry in entries:
                target = staging / entry["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with target.open("xb") as handle:
                    for chunk in disc.chunks(entry["lba"], entry["size"]):
                        handle.write(chunk)
                        digest.update(chunk)
                entry["sha256"] = digest.hexdigest()
                if target.stat().st_size != entry["size"] or sha256_file(target) != entry["sha256"]:
                    raise ValueError(f"Output verification failed: {entry['path']}")
            (staging / "IP.BIN").write_bytes(boot)
            bootstrap = {"path": "IP.BIN", "size": len(boot), "sha256": hashlib.sha256(boot).hexdigest()}
            if sha256_file(staging / "IP.BIN") != bootstrap["sha256"]:
                raise ValueError("Bootstrap verification failed")
            manifest = {
                "schema": 1,
                "source": {"name": disc.path.name, "size": disc.size, "sha256": sha256_file(disc.path)},
                "format": "Dreamcast high-density MODE1/2352, start LBA 45000",
                "volume": disc.volume,
                "bootstrap_header": boot[:256].decode("ascii", errors="replace").rstrip(),
                "bootstrap": bootstrap,
                "file_count": len(entries),
                "total_bytes": sum(entry["size"] for entry in entries),
                "files": entries,
            }
            (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            staging.rename(output)
            return manifest
        except BaseException:
            shutil.rmtree(staging)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("track", type=Path, help="Raw high-density Track 3 .bin from the supplied archive")
    parser.add_argument("--output", type=Path, default=Path("local-assets/disc"))
    parser.add_argument("--list", action="store_true", help="List ISO entries without writing files")
    args = parser.parse_args()
    try:
        if args.list:
            with RawTrack(args.track) as disc:
                print(json.dumps(disc.files(), indent=2))
        else:
            result = extract(args.track, args.output)
            print(f"Verified {result['file_count']} files ({result['total_bytes']} bytes) plus IP.BIN -> {args.output}")
    except (OSError, ValueError, struct.error) as error:
        parser.exit(1, f"Extraction failed: {error}\n")


if __name__ == "__main__":
    main()
