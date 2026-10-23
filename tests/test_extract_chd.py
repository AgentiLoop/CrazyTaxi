"""CHD v5 reader tests on small synthetic images built here: no game files required."""
import hashlib
import json
import lzma
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
import zlib

from tools import extract_chd as chd

FRAMES = 4  # frames per hunk in the synthetic images
HUNK = FRAMES * chd.FRAME


class BitWriter:
    def __init__(self):
        self.bits = []

    def write(self, value, count):
        self.bits.extend((value >> (count - 1 - i)) & 1 for i in range(count))

    def signed(self, value, count):
        self.write(value & ((1 << count) - 1), count)

    def bytes(self):
        bits = self.bits + [0] * (-len(self.bits) % 8)
        return bytes(int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8))


def reference_ecc(sector):
    """Straight per-byte P/Q parity (the classic loop) to check the vectorised version."""
    def block(major_count, minor_count, major_mult, minor_inc, dest):
        size = major_count * minor_count
        for major in range(major_count):
            index, a, b = (major >> 1) * major_mult + (major & 1), 0, 0
            for _ in range(minor_count):
                temp = sector[12 + index]
                index = (index + minor_inc) % size if index + minor_inc >= size else index + minor_inc
                a, b = chd._ECC_F[a ^ temp], b ^ temp
            a = chd._ECC_B[chd._ECC_F[a] ^ b]
            sector[dest + major], sector[dest + major + major_count] = a, a ^ b
    block(86, 24, 2, 86, 0x81C)
    block(52, 43, 86, 88, 0x8C8)


def mode1_sector(lba, fill):
    sector = bytearray(chd.SECTOR)
    sector[:12] = chd.SYNC
    minutes, rest = divmod(lba + 150, 75 * 60)
    seconds, frames = divmod(rest, 75)
    sector[12:16] = bytes(int(str(v), 16) for v in (minutes, seconds, frames)) + b"\x01"
    sector[16:2064] = bytes((fill + i) & 0xFF for i in range(2048))
    reference_ecc(sector)
    return bytes(sector)


def flac_frame(left, right):
    """One FLAC frame: left as a constant or fixed order-2 escape-coded subframe, right verbatim."""
    bits = BitWriter()
    bits.write(0x3FFE, 14)
    bits.write(0, 2)
    bits.write(7, 4)  # block size: 16-bit field follows
    bits.write(0, 4)
    bits.write(1, 4)  # independent stereo
    bits.write(4, 3)
    bits.write(0, 1)
    bits.write(0, 8)  # frame number 0 (UTF-8)
    bits.write(len(left) - 1, 16)
    bits.write(0, 8)  # CRC-8 (not checked)
    if len(set(left)) == 1:
        bits.write(0, 1), bits.write(0, 6), bits.write(0, 1)
        bits.signed(left[0], 16)
    else:
        bits.write(0, 1), bits.write(8 + 2, 6), bits.write(0, 1)
        bits.signed(left[0], 16), bits.signed(left[1], 16)
        bits.write(0, 2), bits.write(0, 4), bits.write(15, 4), bits.write(18, 5)  # rice, 1 partition, escape
        for i in range(2, len(left)):
            bits.signed(left[i] - (2 * left[i - 1] - left[i - 2]), 18)
    bits.write(0, 1), bits.write(1, 6), bits.write(0, 1)
    for sample in right:
        bits.signed(sample, 16)
    data = bits.bytes()
    return data + b"\0\0"  # CRC-16 (not checked)


def raw_lzma(data):
    return lzma.compress(data, format=lzma.FORMAT_RAW,
                         filters=[dict(id=lzma.FILTER_LZMA1, dict_size=1 << 16, lc=3, lp=0, pb=2)])


def raw_deflate(data):
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    return comp.compress(data) + comp.flush()


def cd_hunk(codec, frames):
    base = b"".join(f[:chd.SECTOR] for f in frames)
    sub = b"".join(f[chd.SECTOR:] for f in frames)
    if codec == "cdfl":
        samples = struct.unpack(">%dh" % (len(base) // 2), base)
        return flac_frame(samples[0::2], samples[1::2]) + raw_deflate(sub)
    ecc, stripped = 0, bytearray()
    for index, frame in enumerate(frames):
        sector = bytearray(frame[:chd.SECTOR])
        if sector[:12] == chd.SYNC:  # chdman strips sync + parity when they regenerate exactly
            ecc |= 1 << index
            sector[:12] = bytes(12)
            sector[0x81C:0x930] = bytes(276)
        stripped += sector
    packed = raw_lzma(bytes(stripped)) if codec == "cdlz" else raw_deflate(bytes(stripped))
    return bytes([ecc]) + struct.pack(">H", len(packed)) + packed + raw_deflate(sub)


def build_chd(path, hunks, tracks, logical_bytes=None):
    """hunks: list of (kind, payload): kind 0..2 codec index, 'none', ('self', n)."""
    codecs = [b"cdlz", b"cdzl", b"cdfl", b"\0\0\0\0"]
    meta = b""
    entries = []
    for number, (kind, frames, pad) in enumerate(tracks, 1):
        text = ("TRACK:%d TYPE:%s SUBTYPE:NONE FRAMES:%d PAD:%d PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0"
                % (number, kind, frames, pad)).encode() + b"\0"
        entries.append(text)
    meta_offset = 124
    offset = meta_offset
    for i, text in enumerate(entries):
        nxt = offset + 16 + len(text) if i + 1 < len(entries) else 0
        meta += b"CHGD" + struct.pack(">IQ", len(text), nxt) + text
        offset += 16 + len(text)
    body, rows, logical = b"", [], b""
    data_offset = meta_offset + len(meta)
    decoded = []
    for kind, payload in hunks:
        if isinstance(kind, tuple):
            rows.append((chd.SELF_0 if kind[1] == 0 else chd.TYPE_SELF, 0, kind[1], 0))
            decoded.append(decoded[kind[1]])
            continue
        frames = payload
        raw = b"".join(frames)
        decoded.append(raw)
        data = raw if kind == "none" else cd_hunk(["cdlz", "cdzl", "cdfl"][kind], frames)
        rows.append((chd.TYPE_NONE if kind == "none" else kind, len(data), data_offset + len(body), chd.crc16(raw)))
        body += data
    logical = b"".join(decoded)[:logical_bytes]
    # map: every type coded with a 4-bit canonical code (all 16 lengths = 4, so code == symbol)
    bits = BitWriter()
    for _ in range(16):
        bits.write(4, 4)
    kinds = [row[0] for row in rows]
    index = 0
    while index < len(kinds):  # runs of 4..19 equal types: the type, then RLE_SMALL with run - 4
        run = 1
        while index + run < len(kinds) and kinds[index + run] == kinds[index] and run < 19:
            run += 1
        bits.write(kinds[index], 4)
        if run >= 4:
            bits.write(chd.RLE_SMALL, 4), bits.write(run - 4, 4)
            index += run
        else:
            index += 1
    first = rows[0][2] if rows[0][0] in (0, 1, 2, chd.TYPE_NONE) else data_offset
    raw_map = bytearray()
    for kind, length, offs, crc in rows:
        if kind <= 2:
            bits.write(length, 24), bits.write(crc, 16)
        elif kind == chd.TYPE_NONE:
            bits.write(crc, 16)
        elif kind == chd.TYPE_SELF:
            bits.write(offs, 8)
        store_kind = chd.TYPE_SELF if kind == chd.SELF_0 else kind
        raw_map += bytes([store_kind]) + length.to_bytes(3, "big") + offs.to_bytes(6, "big") + crc.to_bytes(2, "big")
    packed_map = bits.bytes()
    map_offset = data_offset + len(body)
    map_header = (struct.pack(">I", len(packed_map)) + first.to_bytes(6, "big")
                  + struct.pack(">H", chd.crc16(raw_map)) + bytes([24, 8, 0, 0]))
    header = (b"MComprHD" + struct.pack(">II", 124, 5) + b"".join(codecs)
              + struct.pack(">QQQII", len(logical), map_offset, meta_offset, HUNK, chd.FRAME)
              + hashlib.sha1(logical).digest() + bytes(20) + bytes(20))
    path.write_bytes(header + meta + body + map_header + packed_map)
    return decoded


class ChdTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_vectorised_ecc_matches_reference(self):
        sector = bytearray(mode1_sector(1234, 7))
        expected = bytes(sector)
        sector[0x81C:0x930] = bytes(276)
        chd.ecc_generate(sector)
        self.assertEqual(bytes(sector), expected)
        mode2 = bytearray(expected)
        mode2[15] = 2
        reference = bytearray(mode2)
        reference[12:16] = bytes(4)
        reference_ecc(reference)
        chd.ecc_generate(mode2)
        self.assertEqual(mode2[0x81C:0x930], reference[0x81C:0x930])
        self.assertEqual(mode2[12:16], expected[12:15] + b"\x02")

    def make_image(self):
        sub = bytes(range(96))
        data = [mode1_sector(i, i * 3) + sub for i in range(12)]
        data[5] = bytes(chd.SECTOR) + sub  # a sector without sync stays as stored
        audio = []
        for f in range(FRAMES):
            samples = []
            for i in range(chd.SECTOR // 4):
                samples += [(f * 588 + i) * 5 - 3000, -(i * 7) + f]
            audio.append(struct.pack(">%dh" % len(samples), *samples) + bytes(96))
        silent = [bytes(chd.FRAME)] * FRAMES
        hunks = [(0, data[0:4]), (1, data[4:8]), ("none", data[8:12]), (2, audio), (2, silent)]
        hunks += [(("self", 0), None)] * 5  # five SELF_0 entries: coded as one type plus an RLE run
        tracks = [("MODE1_RAW", 10, 0), ("AUDIO", 8, 2), ("MODE1_RAW", 4, 0)]
        image = self.root / "Game.chd"
        decoded = build_chd(image, hunks, tracks)
        return image, decoded, data, audio

    def test_reads_every_codec_and_verifies(self):
        image, decoded, _, _ = self.make_image()
        with chd.Chd(image) as reader:
            self.assertEqual([reader.codec_of(h) for h in range(10)],
                             ["cdlz", "cdzl", "none", "cdfl", "cdfl"] + ["self"] * 5)
            for index, raw in enumerate(decoded):
                self.assertEqual(reader.hunk(index), raw, index)
            self.assertEqual(reader.verify(), hashlib.sha1(b"".join(decoded)).hexdigest())
            self.assertEqual([(t["number"], t["chd_frame"]) for t in reader.tracks], [(1, 0), (2, 12), (3, 20)])

    def test_extract_writes_tracks_without_pad_and_swaps_audio(self):
        image, decoded, data, audio = self.make_image()
        out = self.root / "out"
        manifest = chd.extract(image, out, verify=True, log=lambda _: None)
        track1 = (out / "Game (Track 1).bin").read_bytes()
        self.assertEqual(track1, b"".join(f[:chd.SECTOR] for f in data[:10]))
        track2 = (out / "Game (Track 2).bin").read_bytes()
        self.assertEqual(len(track2), 6 * chd.SECTOR)
        big = b"".join(f[:chd.SECTOR] for f in audio) + bytes(2 * chd.SECTOR)
        self.assertEqual(track2[0::2], big[1:6 * chd.SECTOR:2])
        self.assertEqual(track2[1::2], big[0:6 * chd.SECTOR:2])
        self.assertEqual((out / "Game (Track 3).bin").read_bytes(), b"".join(f[:chd.SECTOR] for f in data[:4]))
        written = json.loads((out / "manifest.json").read_text())
        self.assertEqual(written, manifest)
        self.assertTrue(manifest["raw_sha1_verified"])
        self.assertEqual([t["size"] for t in manifest["tracks"]], [10 * 2352, 6 * 2352, 4 * 2352])
        self.assertEqual(manifest["tracks"][0]["sha256"], hashlib.sha256(track1).hexdigest())

    def test_extract_one_track_and_refusals(self):
        image, _, _, _ = self.make_image()
        manifest = chd.extract(image, self.root / "one", tracks=[3], log=lambda _: None)
        self.assertEqual([p.name for p in sorted((self.root / "one").iterdir())],
                         ["Game (Track 3).bin", "manifest.json"])
        self.assertEqual([t["number"] for t in manifest["tracks"]], [3])
        with self.assertRaisesRegex(ValueError, "already exists"):
            chd.extract(image, self.root / "one", log=lambda _: None)
        with self.assertRaisesRegex(ValueError, "no track 9"):
            chd.extract(image, self.root / "nine", tracks=[9], log=lambda _: None)
        self.assertFalse((self.root / "nine").exists())
        bad = self.root / "bad.chd"
        raw = bytearray(image.read_bytes())
        bad.write_bytes(b"X" + raw[1:])
        with self.assertRaisesRegex(ValueError, "not a CHD"):
            chd.Chd(bad)
        v4 = bytearray(raw)
        v4[12:16] = struct.pack(">I", 4)
        bad.write_bytes(v4)
        with self.assertRaisesRegex(ValueError, "version 5"):
            chd.Chd(bad)
        parent = bytearray(raw)
        parent[104] = 1
        bad.write_bytes(parent)
        with self.assertRaisesRegex(ValueError, "parent"):
            chd.Chd(bad)

    def test_corruption_is_detected(self):
        image, _, _, _ = self.make_image()
        raw = bytearray(image.read_bytes())
        map_offset = struct.unpack(">Q", raw[40:48])[0]
        broken = bytearray(raw)
        broken[map_offset + 10] ^= 0xFF  # stored map CRC
        image.write_bytes(broken)
        with self.assertRaisesRegex(ValueError, "map CRC"):
            chd.Chd(image)
        broken = bytearray(raw)
        none_hunk = raw.index(mode1_sector(8, 24))  # the uncompressed hunk's first sector
        broken[none_hunk + 100] ^= 0xFF
        image.write_bytes(broken)
        with chd.Chd(image) as reader:
            with self.assertRaisesRegex(ValueError, "hunk 2 CRC"):
                reader.hunk(2)

    def test_huffman_rle_tree(self):
        bits = BitWriter()
        for value in (1, 1, 2, 3, 3, 1, 0, 0):  # lengths 1 (escaped), 2, 3, 3, then a run of 0 x (0 + 3)
            bits.write(value, 4)
        bits.write(0b1, 1), bits.write(0b01, 2), bits.write(0b000, 3), bits.write(0b001, 3)
        reader = chd.BitReader(bits.bytes())
        huff = chd.Huffman(7, 8)
        huff.import_tree_rle(reader)
        self.assertEqual(huff.codes, {(1, 1): 0, (2, 1): 1, (3, 0): 2, (3, 1): 3})
        self.assertEqual([huff.decode(reader) for _ in range(4)], [0, 1, 2, 3])
        bits = BitWriter()
        for value in (3, 3, 3):
            bits.write(value, 4)
        with self.assertRaisesRegex(ValueError, "canonical"):
            chd.Huffman(3, 8).import_tree_rle(chd.BitReader(bits.bytes()))

if __name__ == "__main__":
    unittest.main()
