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


def split(sample, low, high, points):
    """An instrument split: four one-point 4-byte curves, then the pitch curve's 6-byte
    (last key, base, slope) points, padded to 4 bytes."""
    body = bytearray(0x18)
    struct.pack_into("<HBB", body, 2, 0x100 + sample, low, high)
    for group in range(5):
        body[0xC + 2 * group:0xE + 2 * group] = bytes((len(points) if group == 4 else 1, 12 + 4 * group))
    body += bytes(16)
    for last_key, base, slope in points:
        body += struct.pack("<BBHh", last_key, 0, base, slope)
    body += bytes(-len(body) % 4)
    body[0] = len(body)
    return bytes(body)
def dtpk(entries, payload, playbacks=(), programs=()):
    """A DTPK pack whose sample table sits at 0x40, entries as (pcms, loop flag, offset, size, lsa, lea),
    then (if given) a playback chunk at the end with 64-byte (sample, semitones, detune) definitions
    and an instrument chunk of programs, each a list of split() byte strings."""
    table = struct.pack("<I", len(entries) - 1)
    for pcms, looped, offset, size, lsa, lea in entries:
        register = looped << 9 | pcms << 7 | offset >> 16
        table += struct.pack("<4I", register << 16 | (offset & 0xFFFF), lea << 16 | lsa, 0, size)
    head = bytearray(0x40)
    head[:4] = b"DTPK"
    struct.pack_into("<I", head, 0x3C, 0x40)
    data = bytes(head) + table
    data = bytearray(data + bytes(max(0, entries[0][2] - len(data))) + payload)
    if playbacks:
        chunk = bytearray(0x50)
        struct.pack_into("<H", chunk, 0x10, len(playbacks) - 1)
        for number, (sample, semitones, detune) in enumerate(playbacks):
            entry = bytearray(64)
            entry[0], entry[2] = number & 0xFF, sample
            struct.pack_into("bb", entry, 10, semitones, detune)
            chunk += entry
        struct.pack_into("<I", data, 0x30, len(data))
        data += chunk
    if programs:
        chunk = bytearray(4 + 4 * len(programs))
        chunk[0] = len(programs) - 1
        for number, splits in enumerate(programs):
            struct.pack_into("<I", chunk, 4 + 4 * number, len(chunk))
            chunk += bytes((len(splits) - 1,)) + bytes(7) + b"".join(splits)
        struct.pack_into("<I", data, 0x34, len(data))
        data += chunk
    return bytes(data)


def fns_table():
    return [round(1024 * (2 ** (i / 768) - 1)) for i in range(768)]


def driver():
    """A stand-in sound driver: the checked instruction words, then the FNS table at 0x7084."""
    data = bytearray(0x7084)
    for address, word in audio.INSTRUMENT_CODE.items():
        struct.pack_into("<I", data, address, word)
    return bytes(data) + struct.pack("<768H", *fns_table()) + b"\0\x08"


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

    def test_driver_fns_table(self):
        at, table = audio.driver_fns_table(driver())
        self.assertEqual((at, table[:4], table[-1]), (0x7084, [0, 1, 2, 3], 1022))
        for bad in (b"\0" + driver(), driver()[:-10]):
            with self.subTest(size=len(bad)), self.assertRaises(ValueError):
                audio.driver_fns_table(bad)
    def test_instrument_code_check(self):
        audio.check_instrument_code(driver(), 0x7084)
        with self.assertRaises(ValueError):
            audio.check_instrument_code(driver(), 0x7086)
        for address in (0x55E8, 0x5FCC, 0x61AC):
            changed = bytearray(driver())
            changed[address] ^= 1
            with self.subTest(address=address), self.assertRaises(ValueError):
                audio.check_instrument_code(bytes(changed), 0x7084)
        with self.assertRaises(ValueError):
            audio.check_instrument_code(driver()[:0x6000], 0x7084)
    def test_split_pitch_rate(self):
        table = fns_table()
        self.assertEqual(audio.split_pitch_rate(3072, table), (0, 44100.0))
        self.assertEqual(audio.split_pitch_rate(2688, table), (0x7800, 22050.0))
        self.assertEqual(audio.split_pitch_rate(-5, table), (0x4000, 44100 / 256))
        # Clamped to 0x17FF: octave 15 - 8 = 7, step 383 reads table entry 766.
        register, rate = audio.split_pitch_rate(0x2000, table)
        self.assertEqual(register, 0x3800 | table[766])
        self.assertAlmostEqual(rate, 44100 * 128 * (1024 + table[766]) / 1024)
        # 1/32 semitone units: 32 up is one semitone, table entry 64.
        self.assertEqual(audio.split_pitch_rate(3072 + 32, table)[0], table[64])
    def test_split_pitch_segments(self):
        points = [dict(last_key=100, base=2592, slope=780), dict(last_key=127, base=2720, slope=910)]
        self.assertEqual([audio.split_pitch(points, 58, key) for key in (58, 100, 101, 127)],
                         [2592, 2592 + (780 * 42 >> 8), 2720, 2720 + (910 * 26 >> 8)])
        self.assertEqual(audio.split_pitch([dict(last_key=50, base=3000, slope=-256)], 0, 60), 2940)
    def test_dtpk_instruments(self):
        entries = [(1, 0, 0x60, 2, 0, 2), (1, 0, 0x62, 2, 0, 2)]
        programs = [[split(1, 0, 70, [(70, 2464, 702)]), split(0, 58, 127, [(100, 2592, 780), (127, 2720, 910)])],
                    [split(1, 0, 127, [(127, 2688, 323)])]]
        data = dtpk(entries, b"\x10\x20\x30\x40", programs=programs)
        found = audio.dtpk_instruments(data, 2, fns_table())
        self.assertEqual([(p["id"], [(s["sample"], s["keys"], s["size"]) for s in p["splits"]]) for p in found],
                         [(0, [(1, [0, 70], 0x30), (0, [58, 127], 0x34)]), (1, [(1, [0, 127], 0x30)])])
        last = found[0]["splits"][1]
        self.assertEqual((last["at_low_key"]["pitch"], last["at_high_key"]["pitch"]), (2592, 2812))
        self.assertEqual(found[1]["splits"][0]["at_low_key"]["rate"], 22050.0)
        self.assertEqual(audio.dtpk_instruments(dtpk(entries, bytes(4)), 2, fns_table()), [])
        at = struct.unpack_from("<I", data, 0x34)[0]
        first = at + 4 + 4 * 2 + 8
        cases = {"global sample": (first + 3, 0x00), "size": (first, 0x34), "keys": (first + 5, 0x80),
                 "pitch order": (first + 0x30 + 0x2E, 50), "curve offset": (first + 0xF, 13),
                 "program offset": (at + 8, 0x40), "split count": (at + 4 * 3, 9)}
        for name, (offset, value) in cases.items():
            changed = bytearray(data)
            changed[offset] = value
            with self.subTest(case=name), self.assertRaises(ValueError):
                audio.dtpk_instruments(bytes(changed), 2, fns_table())
        with self.assertRaises(ValueError):
            audio.dtpk_instruments(data, 1, fns_table())

    def test_pitch_rate_octaves_and_fns(self):
        table = fns_table()
        self.assertEqual(audio.pitch_rate(0, table), (0, 44100.0))
        self.assertEqual(audio.pitch_rate(-3072, table), (0x7800, 22050.0))
        self.assertEqual(audio.pitch_rate(-6144, table), (0x7000, 11025.0))
        self.assertEqual(audio.pitch_rate(3072, table), (0x0800, 88200.0))
        # -30 semitones + 29/64: OCT -3, FNS at (-7564 + 9216) >> 2 = 413 (the driver's 0xE21D, about 8 kHz).
        register, rate = audio.pitch_rate(-30 * 256 + 29 * 4, table)
        self.assertEqual(register, 0x6800 | table[413])
        self.assertAlmostEqual(rate, 44100 / 8 * (1024 + table[413]) / 1024)
        for bad in (-8 * 3072 - 4, 8 * 3072):
            with self.subTest(pitch=bad), self.assertRaises(ValueError):
                audio.pitch_rate(bad, table)

    def test_dtpk_playbacks(self):
        data = dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20", [(0, -12, 0), (0, -13, -1)])
        playbacks = audio.dtpk_playbacks(data, 1, fns_table())
        self.assertEqual([(p["id"], p["sample"], p["semitones"], p["detune"]) for p in playbacks],
                         [(0, 0, -12, 0), (1, 0, -13, -1)])
        self.assertEqual(playbacks[0]["rate"], 22050.0)
        self.assertEqual(audio.dtpk_playbacks(dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20"), 1, fns_table()), [])
        self.assertEqual(audio.dtpk_playbacks(data, 1, fns_table())[1]["pitch_register"],
                         audio.pitch_rate(-13 * 256 - 4, fns_table())[0])
        with self.assertRaises(ValueError):
            audio.dtpk_playbacks(data, 0, fns_table())
        renumbered = bytearray(data)
        renumbered[struct.unpack_from("<I", data, 0x30)[0] + 0x50 + 64] = 5
        with self.assertRaises(ValueError):
            audio.dtpk_playbacks(bytes(renumbered), 1, fns_table())
        with self.assertRaises(ValueError):
            audio.dtpk_playbacks(data[:-1], 1, fns_table())

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
            (source / "SNDDC0.BIN").write_bytes(dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20", [(0, -16, 0), (0, -12, 0)]))
            (source / "SNDDC2.BIN").write_bytes(dtpk([(1, 0, 0x54, 2, 0, 2)], b"\x10\x20",
                                                     programs=[[split(0, 0, 127, [(127, 2688, 323)])]]))
            output = Path(tmp) / "audio"
            with self.assertRaises(OSError):
                audio.extract(source, output)
            (source / audio.SOUND_DRIVER).write_bytes(driver())
            manifest = audio.extract(source, output)
            self.assertEqual(sum(len(f["sounds"]) for f in manifest["files"]), 10)
            self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)
            self.assertEqual(manifest["sound_driver"]["fns_table_offset"], 0x7084)
            with wave.open(str(output / "SONG01" / "0000.wav")) as song:
                self.assertEqual((song.getnchannels(), song.getframerate(), song.getnframes()), (1, 22050, 32))
            first = manifest["files"][2]["sounds"][0]
            self.assertEqual((first["rate"], first["rate_source"], first["playbacks"]), (17496, "playback 0", [0, 1]))  # table FNS, not 2 ** (-16 / 12)
            with wave.open(str(output / "SNDDC0" / "0000.wav")) as sample:
                self.assertEqual(sample.getframerate(), 17496)
                self.assertEqual(sample.readframes(2), struct.pack("<2h", 0x1000, 0x2000))
            self.assertEqual(manifest["files"][3]["sounds"][0]["rate_source"], "nominal")
            with wave.open(str(output / "SNDDC1" / "0000.wav")) as sample:
                self.assertEqual(sample.getframerate(), 22050)
            instrument = manifest["files"][4]
            self.assertEqual((instrument["sounds"][0]["rate_source"], instrument["sounds"][0]["splits"]),
                             ("program 0 split 0", [[0, 0]]))
            self.assertEqual(instrument["instruments"][0]["splits"][0]["at_high_key"]["pitch"], 2688 + (323 * 127 >> 8))
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
