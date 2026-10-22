"""Synthetic audio fixtures: no game files or upstream modules required."""
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import wave

from tools import extract_audio as audio


def adx(blocks, channels=1, rate=22050, samples=None, loop=None):
    """A type-3 ADX stream with the copyright marker before its data, then 18-byte blocks and an end marker."""
    copyright_offset = 0x34 if loop else 0x20
    total = samples if samples is not None else len(blocks) // channels * 32
    head = bytearray(copyright_offset + 4)
    struct.pack_into(">HH4BIIHBB", head, 0, 0x8000, copyright_offset, 3, 18, 4, channels, rate, total, 500, 3, 0)
    if loop:
        struct.pack_into(">HHIIIII", head, 0x14, 0, 1, 1, *loop)
    head[copyright_offset - 2:copyright_offset + 4] = b"(c)CRI"
    return bytes(head) + b"".join(blocks) + b"\x80\x01" + bytes(16)


def block(scale, nibbles):
    packed = bytes((nibbles[i] << 4) | nibbles[i + 1] for i in range(0, 32, 2))
    return struct.pack(">H", scale) + packed


def afs(entries):
    table = struct.pack("<4sI", b"AFS\0", len(entries))
    at = 0x800
    body = bytearray()
    for entry in entries:
        table += struct.pack("<II", at + len(body), len(entry))
        body += entry
    return table + bytes(at - len(table)) + bytes(body)


def dtpk(entries, payload):
    """A DTPK pack whose sample table sits at 0x40, entries as (pcms, loop flag, offset, size, lsa, lea)."""
    table = struct.pack("<I", len(entries) - 1)
    for pcms, looped, offset, size, lsa, lea in entries:
        register = looped << 9 | pcms << 7 | offset >> 16
        table += struct.pack("<4I", register << 16 | (offset & 0xFFFF), lea << 16 | lsa, 0, size)
    head = bytearray(0x40)
    head[:4] = b"DTPK"
    struct.pack_into("<I", head, 0x3C, 0x40)
    data = bytes(head) + table
    return data + bytes(max(0, entries[0][2] - len(data))) + payload


class AudioTests(unittest.TestCase):
    def test_coefficients(self):
        self.assertEqual(audio.adx_coefficients(500, 22050), (6569, -2634))
        self.assertEqual(audio.adx_coefficients(500, 44100), (7334, -3283))

    def test_adx_scale_bias_prediction_and_trim(self):
        nibbles = [1, 15] + [0] * 30
        stream = adx([block(2, nibbles)], samples=3)
        coef1, coef2 = audio.adx_coefficients(500, 22050)
        header, pcm, clipped = audio.decode_adx(stream)
        first = 3
        second = -3 + (coef1 * first >> 12)
        third = (coef1 * second + coef2 * first) >> 12
        self.assertEqual(struct.unpack("<3h", pcm), (first, second, third))
        self.assertEqual((header["samples"], clipped, header["loop"]), (3, 0, None))
        _, unbiased, _ = audio.decode_adx(stream, scale_bias=0)
        self.assertEqual(struct.unpack("<3h", unbiased)[0], 2)

    def test_adx_stereo_interleave_clip_and_loop(self):
        left, right = block(0x1FFF, [7] * 32), block(0, [0] * 32)
        header, pcm, clipped = audio.decode_adx(adx([left, right], channels=2, loop=(0, 0x30, 32, 0x54)))
        values = struct.unpack("<64h", pcm)
        self.assertEqual(values[0::2][-1], 32767)
        self.assertEqual(set(values[1::2]), {0})
        self.assertEqual(clipped, 32)
        self.assertEqual(header["loop"], dict(start_sample=0, start_byte=0x30, end_sample=32, end_byte=0x54))

    def test_adx_rejects_bad_streams(self):
        good = adx([block(1, [0] * 32)])
        cases = [b"\x00" + good[1:], good[:0x1E] + b"(C)CRI" + good[0x24:],
                 good[:4] + b"\x04" + good[5:], good[:0x13] + b"\x08" + good[0x14:],
                 good[:0x24 + 18], adx([block(0x8001, [0] * 32)]), adx([block(1, [0] * 32)])[:-18]]
        for number, stream in enumerate(cases):
            with self.subTest(case=number), self.assertRaises(ValueError):
                audio.decode_adx(stream)

    def test_afs_entries(self):
        archive = afs([b"abc", b"defg"])
        self.assertEqual(audio.afs_entries(archive), [(0x800, 3), (0x803, 4)])
        with self.assertRaises(ValueError):
            audio.afs_entries(archive[:-1])
        with self.assertRaises(ValueError):
            audio.afs_entries(b"AFX\0" + archive[4:])

    def test_dtpk_registers(self):
        data = dtpk([(2, 1, 0x80, 4, 0, 8), (0, 0, 0x84, 4, 0, 2), (1, 1, 0x10088, 2, 1, 2)],
                    bytes(0x10088 - 0x80) + b"\x80\x7f")
        entries = audio.dtpk_samples(data)
        self.assertEqual([(e["offset"], e["format"], e["loop"], e["loop_start"], e["loop_end"]) for e in entries],
                         [(0x80, "ADPCM", True, 0, 8), (0x84, "PCM16", False, 0, 2), (0x10088, "PCM8", True, 1, 2)])
        for bad in ([(0, 0, 0x80, 4, 0, 3)], [(0, 0, 0x80, 0, 0, 0)], [(0, 0, 0x80, 8, 0, 0)]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                audio.dtpk_samples(dtpk(bad, bytes(4)))
        with self.assertRaises(ValueError):
            audio.dtpk_samples(b"DTPX" + data[4:])

    def test_dtpk_sample_formats(self):
        self.assertEqual(audio.decode_dtpk_sample(b"\x01\x02\x03", "PCM16"), b"\x01\x02")
        self.assertEqual(struct.unpack("<2h", audio.decode_dtpk_sample(b"\x80\x7f", "PCM8")), (-32768, 32512))
        # Low nibble first: +7 (127 * 15 >> 3 = 238, step -> 127 * 614 >> 8 = 304), then -7 (304 * 15 >> 3 = 570).
        self.assertEqual(struct.unpack("<2h", audio.decode_aica_adpcm(b"\xf7")), (238, -332))
        with self.assertRaises(ValueError):
            audio.decode_dtpk_sample(b"", "ADPCM2")

    def test_aica_adpcm_clamps(self):
        values = struct.unpack("<200h", audio.decode_aica_adpcm(b"\x77" * 100))
        self.assertEqual(values[-1], 32767)
        values = struct.unpack("<200h", audio.decode_aica_adpcm(b"\xff" * 100))
        self.assertEqual(values[-1], -32768)

    def test_extract_writes_wavs_and_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "disc"
            source.mkdir()
            for name in audio.ADX_SOURCES:
                (source / name).write_bytes(afs([adx([block(1, [1] * 32)])]))
            for name in audio.DTPK_SOURCES:
                (source / name).write_bytes(dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20"))
            output = Path(tmp) / "audio"
            manifest = audio.extract(source, output)
            self.assertEqual(sum(len(f["sounds"]) for f in manifest["files"]), 10)
            self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)
            with wave.open(str(output / "SONG01" / "0000.wav")) as song:
                self.assertEqual((song.getnchannels(), song.getframerate(), song.getnframes()), (1, 22050, 32))
            with wave.open(str(output / "SNDDC0" / "0000.wav")) as sample:
                self.assertEqual(sample.readframes(2), struct.pack("<2h", 0x1000, 0x2000))
            with self.assertRaises(ValueError):
                audio.extract(source, output)
            (source / "SNDDC8.BIN").write_bytes(b"nope")
            with self.assertRaises(ValueError):
                audio.extract(source, Path(tmp) / "again")
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["audio", "disc"])

    def test_wav_bytes(self):
        with wave.open(io.BytesIO(audio.wav_bytes(b"\x01\x00\x02\x00", 2, 44100))) as out:
            self.assertEqual((out.getnchannels(), out.getsampwidth(), out.getframerate(), out.getnframes()),
                             (2, 2, 44100, 1))


if __name__ == "__main__":
    unittest.main()
