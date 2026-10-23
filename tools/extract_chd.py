#!/usr/bin/env python3
"""Read a MAME CHD v5 CD/GD-ROM image and write its tracks as raw .bin files (stdlib only).

Supports the codecs chdman uses for CDs: `cdlz` (LZMA sectors + deflate subcode, with sync/ECC
rebuilt for flagged frames), `cdzl` (deflate + deflate) and `cdfl` (FLAC audio + deflate subcode),
plus uncompressed and self-referencing hunks. Parent (delta) CHDs are refused. Every hunk is
checked against the CRC-16 stored in the map, and a full read is checked against the header's raw
SHA-1. Track layout comes from the CHGD/CHT2/CHTR metadata: each track occupies `FRAMES` frames
padded to a multiple of 4 in the CHD; its last `PAD` frames are padding and are not written. Data
tracks are written as stored (2352-byte sectors); audio tracks are byte-swapped to little-endian
samples like `chdman extractcd`.
"""
import argparse
import binascii
import hashlib
import json
import lzma
import operator
from pathlib import Path
import re
import struct
import zlib

FRAME, SECTOR, SUBCODE = 2448, 2352, 96
SYNC = b"\x00" + b"\xff" * 10 + b"\x00"
TRACK_PADDING = 4
META_TAGS = (b"CHGD", b"CHT2", b"CHTR")
# map compression types
TYPE_NONE, TYPE_SELF, TYPE_PARENT, RLE_SMALL, RLE_LARGE = 4, 5, 6, 7, 8
SELF_0, SELF_1, PARENT_SELF, PARENT_0, PARENT_1 = 9, 10, 11, 12, 13


class ChdError(ValueError):
    pass


def crc16(data):
    """CRC-16/CCITT-FALSE (poly 0x1021, seed 0xFFFF) as used by chd for map and hunk checks."""
    return binascii.crc_hqx(bytes(data), 0xFFFF)
class BitReader:
    """MSB-first bit reader; reads past the end return zero bits like chd's bitstream_in."""

    def __init__(self, data, pos=0):
        self.data, self.bit = data, pos * 8

    def read(self, count):
        value = 0
        for _ in range(count):
            byte = self.bit >> 3
            bit = (self.data[byte] >> (7 - (self.bit & 7))) & 1 if byte < len(self.data) else 0
            value = (value << 1) | bit
            self.bit += 1
        return value


class Huffman:
    """chd's huffman_decoder with an RLE-imported tree and canonical codes."""

    def __init__(self, numcodes, maxbits):
        self.numcodes, self.maxbits = numcodes, maxbits

    def import_tree_rle(self, bits):
        numbits = 5 if self.maxbits >= 16 else 4 if self.maxbits >= 8 else 3
        lengths = []
        while len(lengths) < self.numcodes:
            nodebits = bits.read(numbits)
            if nodebits != 1:
                lengths.append(nodebits)
            else:
                nodebits = bits.read(numbits)
                if nodebits == 1:
                    lengths.append(1)
                else:
                    lengths.extend([nodebits] * (bits.read(numbits) + 3))
        if len(lengths) != self.numcodes:
            raise ChdError("huffman tree overruns its code count")
        histo = [0] * 33
        for length in lengths:
            if length > self.maxbits:
                raise ChdError("huffman code longer than maxbits")
            histo[length] += 1
        start = 0
        for length in range(32, 0, -1):
            nxt = (start + histo[length]) >> 1
            if length != 1 and nxt * 2 != start + histo[length]:
                raise ChdError("huffman tree is not canonical")
            histo[length], start = start, nxt
        self.codes = {}
        for symbol, length in enumerate(lengths):
            if length:
                self.codes[(length, histo[length])] = symbol
                histo[length] += 1

    def decode(self, bits):
        code = 0
        for length in range(1, self.maxbits + 1):
            code = (code << 1) | bits.read(1)
            if (length, code) in self.codes:
                return self.codes[(length, code)]
        raise ChdError("invalid huffman code")


# --- CD-ROM ECC (P/Q parity), as in chd's cdrom ecc_generate ---
_ECC_F = bytearray(256)
_ECC_B = bytearray(256)
for _i in range(256):
    _j = ((_i << 1) ^ (0x11D if _i & 0x80 else 0)) & 0xFF
    _ECC_F[_i] = _j
    _ECC_B[_i ^ _j] = _i


# Row gathers: P rows are contiguous 86-byte runs; Q rows (52 columns of 43, wrapping at 2236) use getters.
_Q_ROWS = [operator.itemgetter(*[12 + ((major >> 1) * 86 + (major & 1) + minor * 88) % 2236 for major in range(52)])
           for minor in range(43)]
def _ecc_parity(rows, count):
    """Compute `count` P/Q parity pairs at once: the per-column GF(2^8) loop done with bytes.translate."""
    a = b = 0
    for row in rows:
        value = int.from_bytes(row, "big")
        a = int.from_bytes((a ^ value).to_bytes(count, "big").translate(_ECC_F), "big")
        b ^= value
    a_bytes = (int.from_bytes(a.to_bytes(count, "big").translate(_ECC_F), "big") ^ b).to_bytes(count, "big")
    a_bytes = a_bytes.translate(_ECC_B)
    return a_bytes + (int.from_bytes(a_bytes, "big") ^ b).to_bytes(count, "big")
def ecc_generate(sector):
    """Fill the P (0x81C) and Q (0x8C8) parity of a 2352-byte mode 1/2 sector in place."""
    header = bytes(sector[12:16])
    if header[3] == 2:  # mode 2: parity is computed over a zeroed header
        sector[12:16] = b"\0\0\0\0"
    sector[0x81C:0x8C8] = _ecc_parity((sector[12 + 86 * m:98 + 86 * m] for m in range(24)), 86)
    sector[0x8C8:0x930] = _ecc_parity((bytes(get(sector)) for get in _Q_ROWS), 52)
    sector[12:16] = header
# --- FLAC (subset written by chdman's cdfl: 16-bit stereo, no metadata) ---
class FlacReader(BitReader):
    def signed(self, count):
        value = self.read(count)
        return value - (1 << count) if count and value >> (count - 1) else value

    def unary(self):
        count = 0
        while not self.read(1):
            count += 1
        return count

    def rice(self, param):
        value = (self.unary() << param) | self.read(param)
        return (value >> 1) ^ -(value & 1)

    def utf8(self):
        first = self.read(8)
        mask, extra = 0x80, 0
        while first & mask:
            mask >>= 1
            extra += 1
        value = first & (mask - 1)
        for _ in range(max(extra - 1, 0)):
            value = (value << 6) | (self.read(8) & 0x3F)
        return value

    def align(self):
        self.bit = (self.bit + 7) & ~7


def _flac_residual(bits, blocksize, order, samples):
    method = bits.read(2)
    if method > 1:
        raise ChdError("reserved FLAC residual method")
    param_bits, escape = (4, 15) if method == 0 else (5, 31)
    partition_order = bits.read(4)
    partitions = 1 << partition_order
    for part in range(partitions):
        count = (blocksize >> partition_order) - (order if part == 0 else 0)
        param = bits.read(param_bits)
        if param == escape:
            width = bits.read(5)
            samples.extend(bits.signed(width) for _ in range(count))
        else:
            samples.extend(bits.rice(param) for _ in range(count))


def _flac_subframe(bits, blocksize, depth):
    if bits.read(1):
        raise ChdError("bad FLAC subframe padding")
    kind = bits.read(6)
    wasted = 0
    if bits.read(1):
        wasted = bits.unary() + 1
        depth -= wasted
    if kind == 0:
        samples = [bits.signed(depth)] * blocksize
    elif kind == 1:
        samples = [bits.signed(depth) for _ in range(blocksize)]
    elif 8 <= kind <= 12:
        order = kind - 8
        samples = [bits.signed(depth) for _ in range(order)]
        _flac_residual(bits, blocksize, order, samples)
        for i in range(order, blocksize):
            if order == 1:
                samples[i] += samples[i - 1]
            elif order == 2:
                samples[i] += 2 * samples[i - 1] - samples[i - 2]
            elif order == 3:
                samples[i] += 3 * samples[i - 1] - 3 * samples[i - 2] + samples[i - 3]
            elif order == 4:
                samples[i] += 4 * samples[i - 1] - 6 * samples[i - 2] + 4 * samples[i - 3] - samples[i - 4]
    elif kind >= 32:
        order = kind - 31
        samples = [bits.signed(depth) for _ in range(order)]
        precision = bits.read(4) + 1
        if precision == 16:
            raise ChdError("invalid FLAC LPC precision")
        shift = bits.signed(5)
        coefs = [bits.signed(precision) for _ in range(order)]
        _flac_residual(bits, blocksize, order, samples)
        for i in range(order, blocksize):
            acc = 0
            for j, coef in enumerate(coefs):
                acc += coef * samples[i - 1 - j]
            samples[i] += acc >> shift
    else:
        raise ChdError("reserved FLAC subframe type %d" % kind)
    if wasted:
        samples = [s << wasted for s in samples]
    return samples


def flac_decode(data, sample_count):
    """Decode raw FLAC frames to interleaved 16-bit stereo; return (samples, bytes consumed)."""
    bits = FlacReader(data)
    out = []
    while len(out) < sample_count * 2:
        if bits.read(14) != 0x3FFE:
            raise ChdError("lost FLAC frame sync")
        bits.read(2)
        bs_code, _rate, chan, _size = bits.read(4), bits.read(4), bits.read(4), bits.read(3)
        bits.read(1)
        bits.utf8()
        if bs_code == 1:
            blocksize = 192
        elif 2 <= bs_code <= 5:
            blocksize = 576 << (bs_code - 2)
        elif bs_code == 6:
            blocksize = bits.read(8) + 1
        elif bs_code == 7:
            blocksize = bits.read(16) + 1
        elif bs_code >= 8:
            blocksize = 256 << (bs_code - 8)
        else:
            raise ChdError("reserved FLAC block size")
        if _rate == 12:
            bits.read(8)
        elif _rate in (13, 14):
            bits.read(16)
        bits.read(8)  # header CRC-8
        if chan == 8:  # left/side
            left = _flac_subframe(bits, blocksize, 16)
            side = _flac_subframe(bits, blocksize, 17)
            right = [l - s for l, s in zip(left, side)]
        elif chan == 9:  # side/right
            side = _flac_subframe(bits, blocksize, 17)
            right = _flac_subframe(bits, blocksize, 16)
            left = [s + r for s, r in zip(side, right)]
        elif chan == 10:  # mid/side
            mid = _flac_subframe(bits, blocksize, 16)
            side = _flac_subframe(bits, blocksize, 17)
            left, right = [], []
            for m, s in zip(mid, side):
                m = (m << 1) | (s & 1)
                left.append((m + s) >> 1)
                right.append((m - s) >> 1)
        elif chan == 1:
            left = _flac_subframe(bits, blocksize, 16)
            right = _flac_subframe(bits, blocksize, 16)
        else:
            raise ChdError("unsupported FLAC channel assignment %d" % chan)
        bits.align()
        bits.read(16)  # frame CRC-16
        for l, r in zip(left, right):
            out.append(l)
            out.append(r)
    return out[:sample_count * 2], bits.bit >> 3


def _inflate(data, size):
    out = zlib.decompressobj(-15).decompress(data, size)
    if len(out) != size:
        raise ChdError("deflate stream too short")
    return out


def _lzma(data, size, hunkbytes):
    # chd's lzma codec: raw LZMA1, lc=3 lp=0 pb=2, no end marker; dictionary sized for one hunk
    dict_size = 1 << 12
    while dict_size < hunkbytes:
        dict_size <<= 1
    dec = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[dict(id=lzma.FILTER_LZMA1, dict_size=dict_size,
                                                              lc=3, lp=0, pb=2)])
    out = dec.decompress(data, size)
    if len(out) != size:
        raise ChdError("LZMA stream too short")
    return out


class Chd:
    def __init__(self, path):
        self.path = Path(path)
        self.file = open(self.path, "rb")
        try:
            self._open()
        except BaseException:
            self.file.close()
            raise
    def _open(self):
        header = self.file.read(124)
        if header[:8] != b"MComprHD":
            raise ChdError("not a CHD file")
        length, version = struct.unpack(">II", header[8:16])
        if version != 5 or length != 124:
            raise ChdError("only CHD version 5 is supported (found %d)" % version)
        self.codecs = [header[16 + 4 * i:20 + 4 * i].decode("latin-1") for i in range(4)]
        (self.logical_bytes, self.map_offset, self.meta_offset, self.hunk_bytes,
         self.unit_bytes) = struct.unpack(">QQQII", header[32:64])
        self.raw_sha1, self.sha1, self.parent_sha1 = header[64:84].hex(), header[84:104].hex(), header[104:124]
        if any(self.parent_sha1):
            raise ChdError("parent (delta) CHDs are not supported")
        if self.hunk_bytes % FRAME or self.unit_bytes != FRAME:
            raise ChdError("not a CD CHD (hunk %d, unit %d)" % (self.hunk_bytes, self.unit_bytes))
        for codec in self.codecs:
            if codec.strip("\0") and codec not in ("cdlz", "cdzl", "cdfl"):
                raise ChdError("unsupported codec %r" % codec)
        self.hunk_count = (self.logical_bytes + self.hunk_bytes - 1) // self.hunk_bytes
        self.frames_per_hunk = self.hunk_bytes // FRAME
        self.metadata = self._read_metadata()
        self.tracks = self._parse_tracks()
        self._read_map()
        self._cache = (None, None)

    def close(self):
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _read(self, offset, size):
        self.file.seek(offset)
        data = self.file.read(size)
        if len(data) != size:
            raise ChdError("CHD is truncated")
        return data

    def _read_metadata(self):
        entries, offset, seen = [], self.meta_offset, set()
        while offset:
            if offset in seen:
                raise ChdError("metadata loop")
            seen.add(offset)
            tag, flags_len, nxt = struct.unpack(">4sIQ", self._read(offset, 16))
            entries.append((tag, self._read(offset + 16, flags_len & 0xFFFFFF)))
            offset = nxt
        return entries

    def _parse_tracks(self):
        tracks, chd_frame = [], 0
        for tag, data in self.metadata:
            if tag not in META_TAGS:
                continue
            fields = dict(re.findall(r"(\w+):(\S+)", data.rstrip(b"\0").decode("ascii")))
            frames = int(fields["FRAMES"])
            track = dict(number=int(fields["TRACK"]), type=fields["TYPE"], subtype=fields.get("SUBTYPE", "NONE"),
                         frames=frames, pregap=int(fields.get("PREGAP", 0)), pgtype=fields.get("PGTYPE", ""),
                         postgap=int(fields.get("POSTGAP", 0)), pad=int(fields.get("PAD", 0)),
                         chd_frame=chd_frame)
            tracks.append(track)
            chd_frame += frames + (-frames) % TRACK_PADDING
        tracks.sort(key=lambda t: t["number"])
        if not tracks:
            raise ChdError("CHD has no CD track metadata")
        return tracks

    def _read_map(self):
        raw = self._read(self.map_offset, 16)
        map_bytes, = struct.unpack(">I", raw[:4])
        first_offset = int.from_bytes(raw[4:10], "big")
        map_crc, = struct.unpack(">H", raw[10:12])
        length_bits, self_bits, parent_bits = raw[12], raw[13], raw[14]
        bits = BitReader(self._read(self.map_offset + 16, map_bytes))
        huff = Huffman(16, 8)
        huff.import_tree_rle(bits)
        kinds, last, repeat = [], 0, 0
        for _ in range(self.hunk_count):
            if repeat:
                kinds.append(last)
                repeat -= 1
                continue
            value = huff.decode(bits)
            if value == RLE_SMALL:
                kinds.append(last)
                repeat = 2 + huff.decode(bits)
            elif value == RLE_LARGE:
                kinds.append(last)
                repeat = 2 + 16 + (huff.decode(bits) << 4)
                repeat += huff.decode(bits)
            else:
                kinds.append(value)
                last = value
        self.map, cur, last_self, last_parent = [], first_offset, 0, 0
        raw_map = bytearray()
        for hunk, kind in enumerate(kinds):
            length = offset = crc = 0
            if kind <= 3 or kind == TYPE_NONE:
                length = bits.read(length_bits) if kind <= 3 else self.hunk_bytes
                offset, cur = cur, cur + length
                crc = bits.read(16)
            elif kind == TYPE_SELF:
                offset = last_self = bits.read(self_bits)
            elif kind == TYPE_PARENT:
                offset = last_parent = bits.read(parent_bits)
            elif kind in (SELF_0, SELF_1):
                if kind == SELF_1:
                    last_self += 1
                kind, offset = TYPE_SELF, last_self
            elif kind == PARENT_SELF:
                kind = TYPE_PARENT
                offset = last_parent = hunk * self.hunk_bytes // self.unit_bytes
            elif kind in (PARENT_0, PARENT_1):
                if kind == PARENT_1:
                    last_parent += self.hunk_bytes // self.unit_bytes
                kind, offset = TYPE_PARENT, last_parent
            else:
                raise ChdError("bad map entry type %d" % kind)
            self.map.append((kind, length, offset, crc))
            raw_map += bytes([kind]) + length.to_bytes(3, "big") + offset.to_bytes(6, "big") + crc.to_bytes(2, "big")
        if crc16(raw_map) != map_crc:
            raise ChdError("map CRC mismatch")

    def codec_of(self, hunk):
        kind = self.map[hunk][0]
        return self.codecs[kind] if kind <= 3 else {TYPE_NONE: "none", TYPE_SELF: "self",
                                                    TYPE_PARENT: "parent"}[kind]

    def hunk(self, index):
        if self._cache[0] == index:
            return self._cache[1]
        kind, length, offset, crc = self.map[index]
        if kind == TYPE_SELF:
            return self.hunk(offset)
        if kind == TYPE_PARENT:
            raise ChdError("hunk %d needs a parent CHD" % index)
        data = self._read(offset, length)
        if kind == TYPE_NONE:
            out = data
        else:
            out = self._decode_cd(self.codecs[kind], data)
        if crc16(out) != crc:
            raise ChdError("hunk %d CRC mismatch" % index)
        self._cache = (index, out)
        return out

    def _decode_cd(self, codec, src):
        frames = self.frames_per_hunk
        base_size, sub_size = frames * SECTOR, frames * SUBCODE
        if codec == "cdfl":
            samples, used = flac_decode(src, base_size // 4)
            base = struct.pack(">%dh" % len(samples), *samples)
            sub = _inflate(src[used:], sub_size)
            ecc = b""
        else:
            ecc_bytes = (frames + 7) // 8
            len_bytes = 2 if self.hunk_bytes < 65536 else 3
            header = ecc_bytes + len_bytes
            base_len = int.from_bytes(src[ecc_bytes:header], "big")
            if codec == "cdlz":
                base = _lzma(src[header:header + base_len], base_size, base_size)
            else:
                base = _inflate(src[header:header + base_len], base_size)
            sub = _inflate(src[header + base_len:], sub_size)
            ecc = src[:ecc_bytes]
        out = bytearray()
        for frame in range(frames):
            sector = bytearray(base[frame * SECTOR:(frame + 1) * SECTOR])
            if ecc and ecc[frame // 8] & (1 << (frame % 8)):
                sector[:12] = SYNC
                ecc_generate(sector)
            out += sector + sub[frame * SUBCODE:(frame + 1) * SUBCODE]
        return bytes(out)

    def frame(self, index):
        hunk, part = divmod(index, self.frames_per_hunk)
        return self.hunk(hunk)[part * FRAME:(part + 1) * FRAME]

    def track(self, number):
        for track in self.tracks:
            if track["number"] == number:
                return track
        raise ChdError("no track %d" % number)

    def track_sectors(self, number):
        """Yield the track's 2352-byte sectors without its trailing PAD frames (audio byte-swapped)."""
        track = self.track(number)
        audio = track["type"] == "AUDIO"
        for index in range(track["chd_frame"], track["chd_frame"] + track["frames"] - track["pad"]):
            sector = self.frame(index)[:SECTOR]
            if audio:
                swapped = bytearray(sector)
                swapped[0::2], swapped[1::2] = sector[1::2], sector[0::2]
                sector = bytes(swapped)
            yield sector

    def verify(self):
        """Read every hunk (CRC-checked) and compare the SHA-1 of the logical data with the header."""
        digest = hashlib.sha1()
        remaining = self.logical_bytes
        for index in range(self.hunk_count):
            data = self.hunk(index)
            digest.update(data[:remaining])
            remaining -= len(data)
        if digest.hexdigest() != self.raw_sha1:
            raise ChdError("raw SHA-1 mismatch")
        return digest.hexdigest()


def track_name(stem, number):
    return "%s (Track %d).bin" % (stem, number)


def extract(chd_path, output, tracks=None, verify=False, log=print):
    """Write the chosen tracks (all by default) to `output` with a manifest; return its dict."""
    chd_path, output = Path(chd_path), Path(output)
    if output.exists():
        raise ValueError("output already exists")
    with Chd(chd_path) as chd:
        wanted = [t["number"] for t in chd.tracks] if tracks is None else list(tracks)
        for number in wanted:
            chd.track(number)
        output.mkdir(parents=True)
        manifest = dict(schema=1, source=dict(name=chd_path.name, size=chd_path.stat().st_size,
                                              sha1=chd.sha1, raw_sha1=chd.raw_sha1),
                        codecs=[c for c in chd.codecs if c.strip("\0")], hunk_bytes=chd.hunk_bytes,
                        hunks=chd.hunk_count, tracks=[])
        for number in wanted:
            track = chd.track(number)
            name = track_name(chd_path.stem, number)
            log("track %d (%s, %d frames) -> %s" % (number, track["type"], track["frames"] - track["pad"], name))
            digest = hashlib.sha256()
            with open(output / name, "wb") as handle:
                for sector in chd.track_sectors(number):
                    handle.write(sector)
                    digest.update(sector)
            entry = dict(track)
            entry.update(path=name, size=(track["frames"] - track["pad"]) * SECTOR, sha256=digest.hexdigest())
            manifest["tracks"].append(entry)
        if verify:
            log("verifying raw SHA-1 of all %d hunks" % chd.hunk_count)
            chd.verify()
            manifest["raw_sha1_verified"] = True
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("chd", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--track", type=int, action="append", help="track number (repeatable; default all)")
    parser.add_argument("--list", action="store_true", help="print the tracks and hunk codecs, write nothing")
    parser.add_argument("--verify", action="store_true", help="also check the header raw SHA-1 over all hunks")
    args = parser.parse_args()
    if args.list:
        with Chd(args.chd) as chd:
            counts = {}
            for hunk in range(chd.hunk_count):
                counts[chd.codec_of(hunk)] = counts.get(chd.codec_of(hunk), 0) + 1
            print(json.dumps(dict(tracks=chd.tracks, hunk_codecs=counts), indent=2))
        return
    extract(args.chd, args.output, args.track, args.verify)


if __name__ == "__main__":
    main()
