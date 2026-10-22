#!/usr/bin/env python3
"""Decode the disc's ADX streams and DTPK sound banks into 16-bit WAV files (stdlib only).

Format references (supplied decomp): tools/model_map.py adx_info, audio_file_rows and
dtpk_sounds list the containers; src/gen_hc.c ADX_DecodeSteFloat shows the game's block
scale ((word & 0x1FFF) + 1) and end marker (bit 15). DTPK sample entries are read as the
AICA channel registers they hold: SA (23 bits), PCMS (0 PCM16, 1 PCM8, 2/3 ADPCM),
LPCTL, LSA and LEA. A sample's playback rate comes from the pack's 64-byte playback definitions
(header word +0x30) as the disc's sound driver AICADRV.BIN computes it (note-on routine 0x3B54:
pitch = byte 10 << 8 + byte 11 << 2, both signed; 0x2E68: OCT = pitch // 3072, FNS from the
driver's 768-entry table). No upstream imports.
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
# A sample's rate lives in the playback definitions that use it; samples no definition uses
# (the instrument banks SNDDC2-3, three SNDDC1 entries) keep this nominal rate.
DTPK_NOMINAL_RATE = 22050
AICA_STEP_SCALE = (230, 230, 230, 230, 307, 409, 512, 614)
SOUND_DRIVER = "AICADRV.BIN"
# AICA plays a sample at 44100 Hz when OCT = 0 and FNS = 0; each octave doubles or halves it.
AICA_BASE_RATE = 44100
# The driver's pitch unit is 1/256 semitone: 3072 per octave, FNS table indexed by pitch >> 2.
PITCH_PER_OCTAVE = 3072


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
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".audio-", dir=output.parent))
    manifest = dict(schema=1, dtpk_nominal_rate=DTPK_NOMINAL_RATE,
                    sound_driver=dict(source=SOUND_DRIVER, sha256=digest(driver), fns_table_offset=table_offset),
                    files=[])
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi audio</title>',
            '<style>body{font-family:system-ui;background:#222;color:white}div{display:inline-block;margin:6px;'
            'font-size:12px}audio{display:block;width:220px}</style>',
            '<h1>Local audio</h1><p>ADX streams at their stored rate; DTPK samples at the rate of the first '
            'playback definition that uses them, or a nominal %d Hz if none does.</p>' % DTPK_NOMINAL_RATE]

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
                for item in samples:
                    payload = data[item["offset"]:item["offset"] + item["size"]]
                    pcm = decode_dtpk_sample(payload, item["format"])
                    uses = [p for p in record["playbacks"] if p["sample"] == item["id"]]
                    rate = round(uses[0]["rate"]) if uses else DTPK_NOMINAL_RATE
                    record["sounds"].append(dict(
                        item, channels=1, rate=rate, rate_source="playback %d" % uses[0]["id"] if uses else "nominal",
                        playbacks=[p["id"] for p in uses], samples=len(pcm) // 2, payload_sha256=digest(payload),
                        **write("%s/%04d.wav" % (folder.name, item["id"]), pcm, 1, rate)))
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
