#!/usr/bin/env python3
"""Decode the disc's ADX streams and DTPK sound banks into 16-bit WAV files (stdlib only).

Format references (supplied decomp): tools/model_map.py adx_info, audio_file_rows and
dtpk_sounds list the containers; src/gen_hc.c ADX_DecodeSteFloat shows the game's block
scale ((word & 0x1FFF) + 1) and end marker (bit 15). DTPK sample entries are read as the
AICA channel registers they hold: SA (23 bits), PCMS (0 PCM16, 1 PCM8, 2/3 ADPCM),
LPCTL, LSA and LEA. A sample's playback rate comes from the pack's 64-byte playback definitions
(header word +0x30) as the disc's sound driver AICADRV.BIN computes it (note-on routine 0x3B54:
pitch = byte 10 << 8 + byte 11 << 2, both signed; 0x2E68: OCT = pitch // 3072, FNS from the
driver's 768-entry table). Samples played by instrument programs (header word +0x34, driver
program-change 0x55E0, split walk 0x57B8) take the rate of the split's pitch curve at its lowest
key (curve 0x5FFC group 4, register 0x5FB0: OCT = value // 384 - 8). The sound requests the game
sends (header word +0x2C, driver lookup 0x6B40, event reader 0x6338) are decoded into their timed
note events, each naming the playback definition and sample it plays. No upstream imports.
"""
import argparse
import hashlib
import html
import io
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile
import wave


ADX_SOURCES = ("SONG01.AFS", "VOICE01.AFS")
DTPK_SOURCES = ("SNDDC0.BIN", "SNDDC1.BIN", "SNDDC2.BIN", "SNDDC3.BIN",
                "SNDDC5.BIN", "SNDDC6.BIN", "SNDDC7.BIN", "SNDDC8.BIN")
# A sample's rate lives in the playback definitions or instrument splits that use it; samples
# neither uses keep this nominal rate.
DTPK_NOMINAL_RATE = 22050
AICA_STEP_SCALE = (230, 230, 230, 230, 307, 409, 512, 614)
SOUND_DRIVER = "AICADRV.BIN"
# AICA plays a sample at 44100 Hz when OCT = 0 and FNS = 0; each octave doubles or halves it.
AICA_BASE_RATE = 44100
# The driver's pitch unit is 1/256 semitone: 3072 per octave, FNS table indexed by pitch >> 2.
PITCH_PER_OCTAVE = 3072
# Instrument split pitch curves use 1/32 semitone: 384 per octave, value 3072 = OCT 0, FNS 0;
# the driver clamps the value to 0..0x17FF and reads FNS table entry 2 * (value mod 384).
SPLIT_PITCH_PER_OCTAVE = 384
SPLIT_PITCH_ZERO_OCTAVE = 8
SPLIT_PITCH_MAX = 0x17FF
# Split samples >= 0x100 index the pack's own sample table (driver 0x3C98); lower ones a global table.
SPLIT_LOCAL_SAMPLE = 0x100
# AICADRV.BIN instruction words the instrument decoding relies on (llvm-objdump --triple=armv4t).
INSTRUMENT_CODE = {
    0x55E8: 0xE3A01011,  # mov r1, #17: program change looks up header byte 0x11 ...
    0x2BA4: 0x15970034,  # ldrne r0, [r7, #0x34]: ... whose chunk is header word +0x34
    0x5604: 0xE4D10004,  # ldrb r0, [r1], #4: last program index, offsets follow
    0x5608: 0xE1570000,  # cmp r7, r0
    0x5610: 0xE1A00107,  # lsl r0, r7, #2
    0x5614: 0xE7910000,  # ldr r0, [r1, r0]: u32 program offset from the chunk start
    0x5620: 0xE0855000,  # add r5, r5, r0
    0x5660: 0xE58B5004,  # str r5, [r11, #4]: channel program
    0x5664: 0xE3A00040,  # mov r0, #64: channel controls reset to centre ...
    0x5678: 0xE5CB000E,  # strb r0, [r11, #0xe]
    0x57B8: 0xE59B9004,  # ldr r9, [r11, #4]: note-on walks the program's splits
    0x57BC: 0xE5D97000,  # ldrb r7, [r9]: last split index
    0x57C4: 0xE2899008,  # add r9, r9, #8: splits start after an 8-byte header
    0x57DC: 0xE5D90000,  # ldrb r0, [r9]: split size ...
    0x57E0: 0xE0899000,  # add r9, r9, r0: ... steps to the next split
    0x57F8: 0xE5D90004,  # ldrb r0, [r9, #4]: lowest key
    0x57FC: 0xE5D91005,  # ldrb r1, [r9, #5]: highest key
    0x5B7C: 0xE5991002,  # ldr r1, [r9, #2]: sample (u16) ...
    0x5B84: 0xE0011006,  # and r1, r1, r6
    0x3C98: 0xE3510C01,  # cmp r1, #256: ... below 256 global, else pack sample - 256
    0x3CB4: 0xE2411C01,  # sub r1, r1, #256
    0x3CB8: 0xE1A01201,  # lsl r1, r1, #4
    0x3CBC: 0xE2811004,  # add r1, r1, #4
    0x5C8C: 0xE3A00004,  # mov r0, #4: pitch is curve group 4
    0x5CB8: 0xE5DB100C,  # ldrb r1, [r11, #0xc]: + (control 0xc - 64) << 5
    0x5CBC: 0xE2411040,
    0x5CC0: 0xE1A01281,
    0x5CC4: 0xE5DB200E,  # ldrb r2, [r11, #0xe]: + (control 0xe - 64) >> 1
    0x5CC8: 0xE2422040,
    0x5CCC: 0xE1A020C2,
    0x5CD0: 0xE59F34D4,  # clamp to the literal at 0x61AC
    0x5CE4: 0xE1500003,
    0x5CE8: 0x81A00003,
    0x61AC: SPLIT_PITCH_MAX,
    0x5974: 0xE58C0168,  # str r0, [r12, #0x168]: pitch register ...
    0x5B10: 0xE59C0168,
    0x5B2C: 0xE58E0018,  # ... written to the AICA channel's OCT/FNS register (+0x18)
    0x5FB0: 0xE3A01D06,  # mov r1, #384: octave = value // 384
    0x5FB8: 0xE1500001,
    0x5FC0: 0xE2811D06,
    0x5FCC: 0xE2422008,  # sub r2, r2, #8: OCT = octave - 8 ...
    0x5FD0: 0xE202200F,
    0x5FD4: 0xE1A02582,  # ... << 11
    0x5FE0: 0xE1A00100,  # lsl r0, r0, #2: FNS table byte offset 4 * (value mod 384)
    0x5FE4: 0xE59F11CC,  # table address literal at 0x61B8
    0x5FE8: 0xE7910000,
    0x61B8: 0x7084,
    0x6004: 0xE5D94004,  # ldrb r4, [r9, #4]: curve starts at the lowest key
    0x6008: 0xE289700C,  # add r7, r9, #12: (count, offset) pairs at split +0xC ...
    0x600C: 0xE1A06080,
    0x6014: 0xE5D65000,
    0x6018: 0xE5D66001,  # ... offsets from split +0xC
    0x6020: 0xE5D60000,  # ldrb r0, [r6]: point's last key
    0x6024: 0xE15A0000,
    0x6034: 0xE2804001,  # next segment starts after it
    0x6038: 0xE35E0004,
    0x603C: 0x12866004,  # groups 0-3: 4-byte points
    0x6040: 0x02866006,  # group 4: 6-byte points
    0x6054: 0x05960002,  # ldreq r0, [r6, #2]: group 4 base (u16)
    0x6058: 0x05961004,  # ldreq r1, [r6, #4]: group 4 slope (s16, 1/256 per key)
    0x605C: 0xE04A2004,
    0x6074: 0xE0030291,  # mul r3, r1, r2
    0x6078: 0xE1A03443,  # asr r3, r3, #8
    0x607C: 0xE0800003,
}
# AICADRV.BIN instruction words the sound request decoding relies on (llvm-objdump --triple=armv4t).
REQUEST_CODE = {
    0x0764: 0xE35100A8,  # cmp r1, #0xA8: commands 0xA8..0xAD are sound requests ...
    0x076C: 0xE35100AD,  # cmp r1, #0xAD
    0x66E0: 0xE1A01C20,  # lsr r1, r0, #24: ... (0xA0 is a driver control command)
    0x66E4: 0xE35100A0,
    0x6B58: 0xE592302C,  # ldr r3, [r2, #0x2c]: request chunk is header word +0x2C
    0x6B5C: 0xE0822003,
    0x6B64: 0xE4D34004,  # ldrb r4, [r3], #4: last group index, entries follow
    0x6B68: 0xE4935004,  # ldr r5, [r3], #4: entry = id << 16 | group offset
    0x6B6C: 0xE1A06825,
    0x6B70: 0xE1560820,  # cmp r6, r0, lsr #16: id = request >> 16
    0x6B94: 0xE3C554FF,
    0x6B98: 0xE3C558FF,
    0x6B9C: 0xE0823005,  # group = chunk + offset
    0x6BA0: 0xE4D34004,  # ldrb r4, [r3], #4: last sequence index
    0x6BA4: 0xE2005CFF,  # and r5, r0, #0xff00: index = request bits 8-15
    0x6BA8: 0xE1540425,
    0x6BAC: 0x3AFFFFF7,
    0x6BB0: 0xE7931325,  # ldr r1, [r3, index * 4]: sequence offset ...
    0x6BBC: 0xE0821001,  # ... from the chunk start
    0x6BD4: 0xE3140080,  # tst r4, #128: header bit 7 = script, else track list
    0x6E4C: 0xE3A034FF,
    0x6E50: 0xE5823010,  # a script has no track list ...
    0x6E54: 0xE5821018,  # ... and its events start after the header byte
    0x633C: 0xE35500FF,  # cmp r5, #255: end of events
    0x6344: 0xE3150080,  # tst r5, #128: status byte, else running status
    0x634C: 0x15C85003,
    0x6350: 0x05D85003,
    0x6358: 0xE4D46001,  # ldrb r6, [r4], #1: first data byte
    0x635C: 0xE206707F,
    0x6364: 0xE2055070,  # and r5, r5, #0x70: data layout by status
    0x6370: 0xE597F000,
    0x6594: 0x63B4, 0x6598: 0x63A8, 0x659C: 0x63A8, 0x65A0: 0x63A8,
    0x65A4: 0x63B4, 0x65A8: 0x6374, 0x65AC: 0x6398, 0x65B0: 0x63A8,
    0x6374: 0xE3130080,  # tst r3, #128: in a script 0xDn ...
    0x637C: 0xE3C00101,  # bic r0, r0, #0x40000000: ... becomes note-on 0x9n
    0x6380: 0xE4D46001,  # ldrb r6, [r4], #1: velocity
    0x6384: 0xE1800406,
    0x6388: 0xE4D46001,  # ldrb r6, [r4], #1: flag byte, low 7 bits << 4
    0x638C: 0xE206707F,
    0x6390: 0xE1800207,
    0x6398: 0xE206707F,  # 0xEn: one byte into bits 8-14
    0x639C: 0xE3C008FF,
    0x63A0: 0xE1800407,
    0x63A8: 0xE4D46001,  # second data byte
    0x63AC: 0xE206707F,
    0x63B0: 0xE1800407,
    0x6400: 0xE3160080,  # tst r6, #128: last byte bit 7 = no delta follows
    0x6408: 0xE4D45001,  # delta byte ...
    0x640C: 0xE3150080,
    0x6414: 0xE4D46001,  # ... bit 7: (b << 7 | next) & ~0x4000
    0x6418: 0xE1865385,
    0x641C: 0xE3C55901,
    0x6424: 0xE0866805,
    0x6440: 0xE4945004,  # ldr r5, [r4], #4: track list word ...
    0x6444: 0xE1B06C25,  # ... top byte 0 = events at sequence + offset
    0x6464: 0xE3560080,  # 0x80 = driver command (low 24 bits << 8)
    0x6510: 0xE3560090,  # 0x90 = jump; others end (after events if offset != 0)
    0x6520: 0xE1B05005,
    0x30D0: 0xE21110FF,  # ands r1, r1, #255: note-on velocity 0 is a note-off
    0x30D4: 0x0AFFFFE2,
    0x31F8: 0xE5D10000,  # ldrb r0, [r1]: channel program type ...
    0x3204: 0xE3500002,  # ... 2 = playback definition list (the +0x30 chunk starts with 2)
    0x3270: 0xE2898040,  # add r8, r9, #64: definitions after the 0x40-byte list header
    0x3274: 0xE5997000,  # ldr r7, [r9]: last definition (u16)
    0x327C: 0xE0077000,
    0x3280: 0xE5DC00E2,  # ldrb r0, [r12, #0xe2]: key ...
    0x3284: 0xE5DC10E0,  # ... + (command byte 0 & 0xF0) << 3
    0x3288: 0xE20110F0,
    0x328C: 0xE1A01181,
    0x3290: 0xE1800001,
    0x3294: 0xE1500007,
    0x329C: 0xE1A00300,  # lsl r0, r0, #6: 64-byte definitions
    0x32A0: 0xE0888000,
    0x32EC: 0xE5DC00E1,  # ldrb r0, [r12, #0xe1]: velocity must lie in definition +0x20..+0x21
    0x32F0: 0xE5D81020,
    0x32FC: 0xE5D81021,
}
# Sound request ids the driver accepts: command top byte 0xA8..0xAD (0x764).
REQUEST_FIRST, REQUEST_LAST = 0xA8, 0xAD


def digest(data):
    return hashlib.sha256(data).hexdigest()


def clamp16(value):
    return -32768 if value < -32768 else 32767 if value > 32767 else value


def afs_entries(data):
    """[(offset, size)] of an AFS archive, every entry checked to lie inside it."""
    if data[:4] != b"AFS\0" or len(data) < 8:
        raise ValueError("not an AFS archive")
    count = struct.unpack_from("<I", data, 4)[0]
    if not 0 < count < 100000 or 8 + 8 * count > len(data):
        raise ValueError("bad AFS entry count")
    entries = [struct.unpack_from("<II", data, 8 + 8 * i) for i in range(count)]
    for offset, size in entries:
        if offset < 8 + 8 * count or offset + size > len(data):
            raise ValueError("AFS entry outside archive")
    return entries


def adx_coefficients(cutoff, rate):
    a = math.sqrt(2.0) - math.cos(2.0 * math.pi * cutoff / rate)
    b = math.sqrt(2.0) - 1.0
    c = (a - math.sqrt((a + b) * (a - b))) / b
    return int(c * 8192.0), int(-(c * c) * 4096.0)


def adx_header(data):
    """Header fields of a standard (type 3, unencrypted) 4-bit ADX stream at the start of data."""
    if len(data) < 0x18 or data[0] != 0x80 or data[1] != 0:
        raise ValueError("not an ADX stream")
    copyright_offset = struct.unpack_from(">H", data, 2)[0]
    enc, block, bits, channels = data[4:8]
    rate, samples = struct.unpack_from(">II", data, 8)
    cutoff = struct.unpack_from(">H", data, 0x10)[0]
    version, flags = data[0x12], data[0x13]
    if data[copyright_offset - 2:copyright_offset + 4] != b"(c)CRI":
        raise ValueError("ADX copyright marker missing")
    if enc != 3 or block != 18 or bits != 4 or flags:
        raise ValueError("unsupported ADX encoding")
    if not 1 <= channels <= 2 or not 4000 <= rate <= 192000 or not cutoff:
        raise ValueError("bad ADX channel count, rate or cutoff")
    header = dict(channels=channels, rate=rate, samples=samples, cutoff=cutoff, version=version,
                  data_offset=copyright_offset + 4, loop=None)
    if version == 3 and copyright_offset + 4 >= 0x2C:
        _, _, enabled, start, start_byte, end, end_byte = struct.unpack_from(">HHIIIII", data, 0x14)
        if enabled:
            header["loop"] = dict(start_sample=start, start_byte=start_byte, end_sample=end, end_byte=end_byte)
    return header


def decode_adx(data, scale_bias=1):
    """(header, interleaved little-endian PCM16 bytes, clipped sample count). The game adds 1 to
    each block scale; scale_bias=0 reproduces decoders that do not (ffmpeg) for cross-checks."""
    header = adx_header(data)
    channels, total = header["channels"], header["samples"]
    coef1, coef2 = adx_coefficients(header["cutoff"], header["rate"])
    frames = -(-total // 32)
    at = header["data_offset"]
    if at + frames * 18 * channels > len(data):
        raise ValueError("ADX stream truncated")
    history = [[0, 0] for _ in range(channels)]
    out = [0] * (frames * 32 * channels)
    clipped = 0
    for frame in range(frames):
        for ch in range(channels):
            raw = (data[at] << 8) | data[at + 1]
            if raw & 0x8000:
                raise ValueError("ADX end marker before last sample")
            scale = (raw & 0x1FFF) + scale_bias
            s1, s2 = history[ch]
            index = frame * 32 * channels + ch
            for byte in data[at + 2:at + 18]:
                for nibble in (byte >> 4, byte & 15):
                    value = (nibble - 16 if nibble & 8 else nibble) * scale + ((coef1 * s1 + coef2 * s2) >> 12)
                    if not -32768 <= value <= 32767:
                        clipped += 1
                        value = clamp16(value)
                    s2, s1 = s1, value
                    out[index] = value
                    index += channels
            history[ch] = [s1, s2]
            at += 18
    if data[at:at + 2] != b"\x80\x01":
        raise ValueError("ADX end marker missing")
    out = out[:total * channels]
    return header, struct.pack("<%dh" % len(out), *out), clipped


def dtpk_samples(data):
    """Sample entries of a DTPK pack: the table at the header word +0x3C holds the last index, then
    16-byte entries of AICA registers {PCMS/LPCTL/SA, LSA | LEA << 16, unknown, byte size}."""
    if data[:4] != b"DTPK" or len(data) < 0x40:
        raise ValueError("not a DTPK pack")
    table = struct.unpack_from("<I", data, 0x3C)[0]
    if table + 4 > len(data):
        raise ValueError("DTPK sample table outside pack")
    count = struct.unpack_from("<I", data, table)[0] + 1
    if not 0 < count < 4096 or table + 4 + 16 * count > len(data):
        raise ValueError("bad DTPK sample count")
    samples = []
    for number in range(count):
        word, loop, extra, size = struct.unpack_from("<4I", data, table + 4 + 16 * number)
        register = word >> 16
        start = (register & 0x7F) << 16 | (word & 0xFFFF)
        pcms = register >> 7 & 3
        count_for_format = (size // 2, size, size * 2, size * 2)[pcms]
        if register & ~0x3FF or start + size > len(data) or not size or (loop >> 16) > count_for_format:
            raise ValueError("bad DTPK sample entry %d" % number)
        samples.append(dict(id=number, offset=start, size=size, format=("PCM16", "PCM8", "ADPCM", "ADPCM")[pcms],
                            loop=bool(register >> 9 & 1), loop_start=loop & 0xFFFF, loop_end=loop >> 16,
                            word2=extra))
    return samples


def decode_aica_adpcm(payload):
    """Yamaha AICA 4-bit ADPCM, low nibble first, starting from a zero signal and step 127."""
    signal, step, out = 0, 127, []
    for byte in payload:
        for nibble in (byte & 15, byte >> 4):
            delta = (step * ((nibble & 7) * 2 + 1)) >> 3
            signal = clamp16(signal - delta if nibble & 8 else signal + delta)
            step = min(max((step * AICA_STEP_SCALE[nibble & 7]) >> 8, 127), 24576)
            out.append(signal)
    return struct.pack("<%dh" % len(out), *out)


def decode_dtpk_sample(payload, sample_format):
    if sample_format == "PCM16":
        return payload[:len(payload) & ~1]
    if sample_format == "PCM8":
        return struct.pack("<%dh" % len(payload), *(b * 256 for b in struct.unpack("%db" % len(payload), payload)))
    if sample_format == "ADPCM":
        return decode_aica_adpcm(payload)
    raise ValueError("unsupported DTPK sample format")


def driver_fns_table(driver):
    """(offset, table) of the sound driver's FNS table: 768 halfwords for one octave in 1/64
    semitone steps, located by the values 1024 * (2 ** (i / 768) - 1) rounded."""
    expected = struct.pack("<768H", *(round(1024 * (2 ** (i / 768) - 1)) for i in range(768)))
    at = driver.find(expected)
    if at < 0 or at & 1:
        raise ValueError("FNS table not found in sound driver")
    return at, list(struct.unpack_from("<768H", driver, at))


def pitch_rate(pitch, table):
    """(OCT/FNS register, rate in Hz) for a driver pitch in 1/256 semitones relative to 44100 Hz."""
    octave, step = divmod(pitch, PITCH_PER_OCTAVE)
    if not -8 <= octave <= 7:
        raise ValueError("pitch outside the AICA octave range")
    fns = table[step >> 2]
    return (octave & 15) << 11 | fns, AICA_BASE_RATE * 2.0 ** octave * (1024 + fns) / 1024


def dtpk_playbacks(data, sample_count, table):
    """Playback definitions of a DTPK pack: the chunk at the header word +0x30 holds the last index
    (u16 at +0x10), then 64-byte entries from +0x50 {+0 index, +2 sample, +10 signed semitones,
    +11 signed 1/64 semitones, +0x1C random tune}. A pack without the chunk has none."""
    at = struct.unpack_from("<I", data, 0x30)[0]
    if not at:
        return []
    if at + 0x50 > len(data):
        raise ValueError("DTPK playback chunk outside pack")
    count = struct.unpack_from("<H", data, at + 0x10)[0] + 1
    following = [o for o in struct.unpack_from("<8I", data, 0x20) if o > at]
    if at + 0x50 + 64 * count > min(following, default=len(data)):
        raise ValueError("DTPK playback chunk overlaps the next chunk")
    playbacks = []
    for number in range(count):
        entry = data[at + 0x50 + 64 * number:at + 0x50 + 64 * (number + 1)]
        semitones, detune = struct.unpack_from("bb", entry, 10)
        if entry[0] != number & 0xFF or entry[2] >= sample_count:
            raise ValueError("bad DTPK playback entry %d" % number)
        register, rate = pitch_rate(semitones * 256 + detune * 4, table)
        playbacks.append(dict(id=number, sample=entry[2], semitones=semitones, detune=detune,
                              pitch_register=register, rate=round(rate, 3), random_tune=entry[0x1C]))
    return playbacks


def check_instrument_code(driver, table_offset):
    """Refuse a sound driver whose program-change, split and pitch-curve code differs from the USA one."""
    for address, word in sorted(INSTRUMENT_CODE.items()):
        if address + 4 > len(driver) or struct.unpack_from("<I", driver, address)[0] != word:
            raise ValueError("sound driver instruction at 0x%X is not the expected one" % address)
    if table_offset != INSTRUMENT_CODE[0x61B8]:
        raise ValueError("sound driver FNS table is not where the split pitch code reads it")


def split_pitch_rate(value, table):
    """(OCT/FNS register, rate in Hz) for a split pitch-curve value, clamped as the driver does."""
    value = min(max(value, 0), SPLIT_PITCH_MAX)
    octave, step = divmod(value, SPLIT_PITCH_PER_OCTAVE)
    octave -= SPLIT_PITCH_ZERO_OCTAVE
    fns = table[2 * step]
    return (octave & 15) << 11 | fns, AICA_BASE_RATE * 2.0 ** octave * (1024 + fns) / 1024


def split_pitch(points, low, key):
    """Driver curve 0x5FFC for group 4: the first point whose last key >= key (else the last
    point); value = base + slope * (key - segment start) >> 8, the first segment starting at low."""
    start = low
    for number, point in enumerate(points):
        if key <= point["last_key"] or number == len(points) - 1:
            return point["base"] + ((point["slope"] * (key - start)) >> 8)
        start = point["last_key"] + 1


def dtpk_instruments(data, sample_count, table):
    """Instrument programs of a DTPK pack: the chunk at the header word +0x34 holds the last
    program index (u8), then u32 program offsets from +4 (relative to the chunk). A program is
    an 8-byte header (+0 last split index) and its splits, each {+0 size, +2 sample (u16),
    +4 lowest key, +5 highest key, +0xC five (point count, offset from +0xC) curve groups};
    group 4 is the pitch curve with 6-byte points {last key, -, base u16, slope s16}, groups
    0-3 have 4-byte points. A pack without the chunk has none."""
    at = struct.unpack_from("<I", data, 0x34)[0]
    if not at:
        return []
    following = [o for o in struct.unpack_from("<8I", data, 0x20) if o > at]
    limit = min(following, default=len(data))
    count = data[at] + 1
    if at + 4 + 4 * count > limit:
        raise ValueError("DTPK instrument chunk overlaps the next chunk")
    programs, end = [], at + 4 + 4 * count
    for number, offset in enumerate(struct.unpack_from("<%dI" % count, data, at + 4)):
        program = at + offset
        if program != end:
            raise ValueError("DTPK program %d does not follow the previous one" % number)
        splits, split = [], program + 8
        for split_number in range(data[program] + 1):
            size = data[split] if split < limit else 0
            if not size or split + size > limit:
                raise ValueError("DTPK program %d split %d outside the chunk" % (number, split_number))
            sample, low, high = struct.unpack_from("<HBB", data, split + 2)
            groups = [tuple(data[split + 0xC + 2 * g:split + 0xE + 2 * g]) for g in range(5)]
            group_end = 0x18
            for group, (group_points, start) in enumerate(groups):
                if not group_points or start != group_end - 0xC:
                    raise ValueError("DTPK program %d split %d curve %d misplaced" % (number, split_number, group))
                group_end += group_points * (6 if group == 4 else 4)
            if -(-group_end // 4) * 4 != size or not low <= high <= 127:
                raise ValueError("DTPK program %d split %d size or keys wrong" % (number, split_number))
            if not SPLIT_LOCAL_SAMPLE <= sample < SPLIT_LOCAL_SAMPLE + sample_count:
                raise ValueError("DTPK program %d split %d sample not in the pack" % (number, split_number))
            points, previous = [], low - 1
            for point in range(groups[4][0]):
                last_key, _, base, slope = struct.unpack_from("<BBHh", data, split + 0xC + groups[4][1] + 6 * point)
                if last_key <= previous:
                    raise ValueError("DTPK program %d split %d pitch keys out of order" % (number, split_number))
                points.append(dict(last_key=last_key, base=base, slope=slope))
                previous = last_key
            ends = {}
            for name, key in (("low", low), ("high", high)):
                value = split_pitch(points, low, key)
                register, rate = split_pitch_rate(value, table)
                ends[name] = dict(key=key, pitch=value, pitch_register=register, rate=round(rate, 3))
            splits.append(dict(id=split_number, offset=split, size=size, sample=sample - SPLIT_LOCAL_SAMPLE,
                               keys=[low, high], pitch_points=points, at_low_key=ends["low"],
                               at_high_key=ends["high"]))
            split += size
        programs.append(dict(id=number, offset=program, header=data[program:program + 8].hex(), splits=splits))
        end = split
    if end > limit:
        raise ValueError("DTPK instrument chunk overlaps the next chunk")
    return programs


def check_request_code(driver):
    """Refuse a sound driver whose request lookup, event reader or note-on code differs from the USA one."""
    for address, word in sorted(REQUEST_CODE.items()):
        if address + 4 > len(driver) or struct.unpack_from("<I", driver, address)[0] != word:
            raise ValueError("sound driver instruction at 0x%X is not the expected one" % address)


def request_events(data, at, limit, script):
    """(events, end tick, end offset) of an event stream as the driver reads it (0x6338): MIDI-like
    status bytes with running status, 0xFF ends. In a script 0xDn is a note-on 0x9n with a third
    byte whose low 7 bits go to command bits 4-10 and whose bit 7 means no delta follows; other
    events are always followed by a delta (one byte, or two when the first has bit 7)."""
    events, tick, status = [], 0, None

    def byte():
        nonlocal at
        if at >= limit:
            raise ValueError("sound request events run past the chunk")
        at += 1
        return data[at - 1]

    while True:
        first = byte()
        if first == 0xFF:
            return events, tick, at
        if first & 0x80:
            status = first
        elif status is None:
            raise ValueError("sound request events start without a status byte")
        else:
            at -= 1
        last = byte()
        command = status << 24 | (last & 0x7F) << 16
        layout = status >> 4 & 7
        if layout == 5 and script:
            velocity, last = byte(), byte()
            command = command & ~0x40000000 | velocity << 8 | (last & 0x7F) << 4
        elif layout == 6:
            command = command & ~0xFF0000 | (last & 0x7F) << 8
        elif layout in (1, 2, 3, 7):
            last = byte()
            command |= (last & 0x7F) << 8
        events.append(dict(tick=tick, command="0x%08X" % command, value=command))
        if not last & 0x80:
            delta = byte()
            if delta & 0x80:
                delta = (delta << 7 | byte()) & ~0x4000
            tick += delta


def describe_event(event, playbacks, defs_at, data):
    """Name a decoded command; note-ons pick playback definition key + (command & 0xF0) << 3 (0x3280)."""
    command = event.pop("value")
    status, key, velocity = command >> 24, command >> 16 & 0xFF, command >> 8 & 0xFF
    if status >> 4 == 9 and velocity:
        number = key | (command & 0xF0) << 3
        if number >= len(playbacks):
            raise ValueError("sound request plays missing playback definition %d" % number)
        low, high = data[defs_at + 64 * number + 0x20:defs_at + 64 * number + 0x22]
        if not low <= velocity <= high:
            raise ValueError("sound request velocity outside playback definition %d" % number)
        event.update(kind="note_on", channel=status & 15, playback=number, velocity=velocity,
                     sample=playbacks[number]["sample"])
    elif status >> 4 in (8, 9):
        event.update(kind="note_off", channel=status & 15, playback=key | (command & 0xF0) << 3)
    else:
        event.update(kind="command")
    return event


def dtpk_requests(data, playbacks):
    """Sound requests of a DTPK pack: the chunk at the header word +0x2C holds the last group
    index (u8), then u32 entries {id << 16 | group offset}; a group holds the last sequence index
    (u8), then u32 sequence offsets, all relative to the chunk. The game requests id << 16 |
    index << 8. A sequence whose header byte has bit 7 is a script of events; otherwise a track
    list of u32 words follows the 4-byte header (top byte 0 events, 0x80 driver command,
    0x90 jump, others end). A pack without the chunk has none."""
    at = struct.unpack_from("<I", data, 0x2C)[0]
    if not at:
        return []
    following = [o for o in struct.unpack_from("<8I", data, 0x20) if o > at]
    limit = min(following, default=len(data))
    defs_at = struct.unpack_from("<I", data, 0x30)[0] + 0x50
    if at + 4 + 4 * (data[at] + 1) > limit:
        raise ValueError("DTPK request chunk overlaps the next chunk")
    groups = []
    for number in range(data[at] + 1):
        entry = struct.unpack_from("<I", data, at + 4 + 4 * number)[0]
        ident, group = entry >> 16, at + (entry & 0xFFFF)
        if not REQUEST_FIRST <= ident >> 8 <= REQUEST_LAST:
            raise ValueError("DTPK request id 0x%04X outside the driver's range" % ident)
        if group + 4 + 4 * (data[group] + 1) > limit:
            raise ValueError("DTPK request group 0x%04X outside the chunk" % ident)
        sequences = []
        for index in range(data[group] + 1):
            start = at + struct.unpack_from("<I", data, group + 4 + 4 * index)[0]
            if not at < start < limit:
                raise ValueError("DTPK request 0x%04X/%d outside the chunk" % (ident, index))
            header = data[start]
            item = dict(index=index, request="0x%08X" % (ident << 16 | index << 8), offset=start,
                        header=header)
            if header & 0x80:
                events, ticks, _ = request_events(data, start + 1, limit, True)
                item.update(form="script", ticks=ticks,
                            events=[describe_event(e, playbacks, defs_at, data) for e in events])
            else:
                track, words, seen = [], start + 4, set()
                while True:
                    if words + 4 > limit or words in seen:
                        raise ValueError("DTPK request 0x%04X/%d track list runs away" % (ident, index))
                    seen.add(words)
                    word = struct.unpack_from("<I", data, words)[0]
                    words += 4
                    kind, value = word >> 24, word & 0xFFFFFF
                    if kind == 0x80:
                        track.append(dict(kind="command", command="0x%08X" % (value << 8)))
                    elif kind == 0x90:
                        track.append(dict(kind="jump", offset=start + value))
                        words = start + value
                    elif kind and not value:
                        track.append(dict(kind="end"))
                        break
                    else:
                        events, ticks, _ = request_events(data, start + value, limit, False)
                        track.append(dict(kind="events", offset=start + value, ticks=ticks,
                                          events=[describe_event(e, playbacks, defs_at, data) for e in events]))
                        if kind:
                            break
                item.update(form="track_list", track=track)
            sequences.append(item)
        groups.append(dict(id="0x%04X" % ident, offset=group, sequences=sequences))
    return groups


def wav_bytes(pcm, channels, rate):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm)
    return buffer.getvalue()


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    driver = (source / SOUND_DRIVER).read_bytes()
    table_offset, table = driver_fns_table(driver)
    check_instrument_code(driver, table_offset)
    check_request_code(driver)
    request_ids = set()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".audio-", dir=output.parent))
    manifest = dict(schema=1, dtpk_nominal_rate=DTPK_NOMINAL_RATE,
                    sound_driver=dict(source=SOUND_DRIVER, sha256=digest(driver), fns_table_offset=table_offset),
                    files=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi audio</title>',
            '<style>body{font-family:system-ui;background:#222;color:white}div{display:inline-block;margin:6px;'
            'font-size:12px}audio{display:block;width:220px}</style>',
            '<h1>Local audio</h1><p>ADX streams at their stored rate; DTPK samples at the rate of the first '
            'playback definition that uses them, else the first instrument split that plays them (at its '
            'lowest key), or a nominal %d Hz if neither does.</p>' % DTPK_NOMINAL_RATE]

    def write(relative, pcm, channels, rate):
        encoded = wav_bytes(pcm, channels, rate)
        target = staging / relative
        target.write_bytes(encoded)
        if digest(target.read_bytes()) != digest(encoded):
            raise ValueError("written WAV hash mismatch")
        page.append('<div>%s<audio controls preload="none" src="%s"></audio></div>'
                    % (html.escape(relative), html.escape(relative)))
        return dict(wav=relative, pcm_sha256=digest(pcm), wav_sha256=digest(encoded))

    try:
        for name in ADX_SOURCES + DTPK_SOURCES:
            data = (source / name).read_bytes()
            folder = staging / Path(name).stem
            folder.mkdir()
            record = dict(source=name, size=len(data), sha256=digest(data), sounds=[])
            page.append("<h2>%s</h2>" % html.escape(name))
            if name in ADX_SOURCES:
                for number, (offset, size) in enumerate(afs_entries(data)):
                    stream = data[offset:offset + size]
                    header, pcm, clipped = decode_adx(stream)
                    record["sounds"].append(dict(
                        id=number, offset=offset, size=size, format="ADX", channels=header["channels"],
                        rate=header["rate"], samples=header["samples"], cutoff=header["cutoff"],
                        loop=header["loop"], clipped=clipped, stream_sha256=digest(stream),
                        **write("%s/%04d.wav" % (folder.name, number), pcm, header["channels"], header["rate"])))
            else:
                samples = dtpk_samples(data)
                record["playbacks"] = dtpk_playbacks(data, len(samples), table)
                record["instruments"] = dtpk_instruments(data, len(samples), table)
                record["requests"] = dtpk_requests(data, record["playbacks"])
                played = {}
                for group in record["requests"]:
                    if group["id"] in request_ids:
                        raise ValueError("sound request id %s is in two packs" % group["id"])
                    request_ids.add(group["id"])
                    for sequence in group["sequences"]:
                        streams = [sequence] if sequence["form"] == "script" else \
                            [t for t in sequence["track"] if t["kind"] == "events"]
                        for event in (e for s in streams for e in s["events"] if e["kind"] == "note_on"):
                            played.setdefault(event["sample"], []).append(sequence["request"])
                for item in samples:
                    payload = data[item["offset"]:item["offset"] + item["size"]]
                    pcm = decode_dtpk_sample(payload, item["format"])
                    uses = [p for p in record["playbacks"] if p["sample"] == item["id"]]
                    splits = [(program["id"], split) for program in record["instruments"]
                              for split in program["splits"] if split["sample"] == item["id"]]
                    if uses:
                        rate, rate_source = round(uses[0]["rate"]), "playback %d" % uses[0]["id"]
                    elif splits:
                        rate = round(splits[0][1]["at_low_key"]["rate"])
                        rate_source = "program %d split %d" % (splits[0][0], splits[0][1]["id"])
                    else:
                        rate, rate_source = DTPK_NOMINAL_RATE, "nominal"
                    record["sounds"].append(dict(
                        item, channels=1, rate=rate, rate_source=rate_source,
                        playbacks=[p["id"] for p in uses], splits=[[p, split["id"]] for p, split in splits],
                        requests=sorted(set(played.get(item["id"], []))),
                        samples=len(pcm) // 2, payload_sha256=digest(payload),
                        **write("%s/%04d.wav" % (folder.name, item["id"]), pcm, 1, rate)))
                for group in record["requests"]:
                    for sequence in group["sequences"]:
                        streams = [sequence] if sequence["form"] == "script" else \
                            [t for t in sequence["track"] if t["kind"] == "events"]
                        parts = ["tick %d %s" % (e["tick"], '<a href="%s/%04d.wav">playback %d</a>'
                                                 % (folder.name, e["sample"], e["playback"])
                                                 if e["kind"] == "note_on" else e["kind"] + " " + e["command"])
                                 for s in streams for e in s["events"]]
                        if sequence["form"] != "script":
                            parts += [t["kind"] + " " + t.get("command", "") for t in sequence["track"]
                                      if t["kind"] != "events"]
                        page.append("<p>request %s: %s</p>" % (sequence["request"], ", ".join(parts)))
            manifest["files"].append(record)
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "index.html").write_text("\n".join(page) + "\n")
        if output.exists():
            raise ValueError("output already exists")
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Decoded %d sounds from %d files into %s" %
          (sum(len(item["sounds"]) for item in manifest["files"]), len(manifest["files"]), args.output))


if __name__ == "__main__":
    main()
