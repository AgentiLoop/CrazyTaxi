# Local Crazy Taxi disc extraction

Game data stays under ignored `local-assets/`; do not commit or publish it. The
extractor uses only Python's standard library. It reads the raw high-density
MODE1/2352 track; `tools/extract_chd.py` (below) recovers that track from the
`.chd`, and `tar` from the `.7z`.

## Reproduce with the supplied USA archive

Run from the repository root (macOS `tar` was verified against this archive):

```sh
mkdir -p local-assets/tracks
tar -xkf '/Users/toddbruss/Downloads/Crazy Taxi (USA).7z' \
  -C local-assets/tracks \
  'Crazy Taxi (USA) (Track 3).bin' 'Crazy Taxi (USA).cue'
python3 tools/extract_disc.py \
  'local-assets/tracks/Crazy Taxi (USA) (Track 3).bin' \
  --output local-assets/disc
```

Skip the `tar` step when those files already exist. The extractor intentionally
refuses an existing output directory. For another run choose a new directory
inside `local-assets/`. Use `--list` to inspect ISO entries without extracting.

### From the CHD image
```sh
python3 tools/extract_chd.py '/Users/toddbruss/Downloads/Crazy Taxi (USA).chd' \
  --output local-assets/chd_tracks --verify
```
`tools/extract_chd.py` is an independent stdlib reader for MAME CHD v5 CD/GD-ROM
images. It decodes the compressed hunk map (RLE-coded canonical Huffman types,
checked against the map CRC-16) and the three CD codecs chdman uses: `cdlz` (raw
LZMA sectors plus deflate subcode; sync and P/Q ECC are rebuilt for the frames the
hunk flags), `cdzl` (deflate plus deflate) and `cdfl` (FLAC 16-bit stereo plus
deflate subcode; its own FLAC frame decoder handles constant, verbatim, fixed and
LPC subframes and all stereo decorrelation modes), plus uncompressed and
self-referencing hunks. Parent (delta) CHDs and versions other than 5 are refused.
Each decoded hunk is checked against its map CRC-16; `--verify` also hashes all
hunks against the header's raw SHA-1. Tracks come from the `CHGD`/`CHT2`/`CHTR`
metadata: each takes `FRAMES` frames padded to a multiple of 4, and its last `PAD`
frames are padding that is not written. Data sectors are written as stored (2352
bytes, subcode dropped); audio is byte-swapped to little-endian. `--track N`
(repeatable) picks tracks, `--list` prints tracks and per-hunk codec counts, and
`manifest.json` records each track's layout, size and SHA-256.
Verified October 23, 2026 on the USA `.chd` (70,092,227 bytes; 68,644 hunks of 8
frames: 61,327 `cdlz`, 1,749 `cdzl`, 37 `cdfl`, 5,531 self): the map CRC, every hunk
CRC and the raw SHA-1 all matched, in 52 s for all three tracks. Track 3 (504,150
frames) has SHA-256 `027d5c54…9078`, byte-identical to the `.7z` Track 3. Track 1
(600 frames, PAD 150) gives 450 frames identical to the `.7z` Track 1. Track 2
(44,400 frames, PAD 43,874) gives 526 audio frames identical to the `.7z` Track 2
after its leading 150 silent pregap frames, which the CHD does not store in that
track. No `chdman` was used; it is not installed here.

### Everything in one command

```sh
python3 tools/extract_all.py '/Users/toddbruss/Downloads/Crazy Taxi (USA).7z' \
  --output local-assets/all
```

`tools/extract_all.py` runs every converter below in dependency order into one new
folder: it unpacks only the archive's `(Track 3).bin` with `tar` into `tracks/`,
runs `extract_disc.py` into `disc/` and deletes the unpacked track (keep it with
`--keep-track`), then writes `textures/`, `models/`, `sprites/`, `pvr/`, `audio/`,
`characters/`, `vehicles/`, `props/`, `collision/`, `courses/`, `landmarks/`,
`fcv_motions/`, `replays/`, `motion_uses/`, `customers/`, `replay_cuts/` and
`sound_uses/` with the same cross-links the single tools take (`--textures`,
`--courses`, `--audio`, `--landmarks`, `--customers`). The source may also be the
raw `(Track 3).bin`, the `.chd` (only track 3 is decompressed, with
`extract_chd.py`), or an already extracted disc folder (then `disc/` is not copied
and the top page links to it relatively). All work happens in a hidden staging folder beside the output that
is renamed into place only after every step succeeded and removed on any error;
the output is refused if it exists. The top `manifest.json` lists each step's
folder, seconds, file count and bytes, and `index.html` links each step's page.

Verified October 23, 2026 on this Mac: from `local-assets/disc` the 17 steps took
2 min 9 s and wrote 4,744 files (255 MB); every step folder matched the folders made
by the single tools (`diff -rq`), except `audio/`, whose older copy predated the
sound-request decoding. From the `.7z` the unpack and disc steps took 3.8 s and the
converters 130 s; its `disc/` (manifest and track hash included) and all 17 step
folders are identical to the disc-folder run. From the `.chd` the track 3
decompression and disc steps took 26.9 s (2 min 39 s in all); its `disc/` and all
17 step folders are identical (`diff -rq`) to the `.7z` run.

## Verified result, October 22, 2026

- Archive Track 3: 1,185,760,800 bytes; primary ISO descriptor at relative sector
  16, high-density start LBA 45000, root directory LBA 45020, volume `CRAZY_TAXI`.
- Bootstrap identifies region `U`, product `MK-51035`, version `V1.004`.
- Recovered **51 ISO files totaling 105,229,316 bytes**, plus the 32,768-byte
  bootstrap `IP.BIN`, into `local-assets/disc/`.
- Output includes `POLDC0.BIN`–`POLDC3.BIN`, `TEXDC0.BIN`–`TEXDC3.BIN`,
  `MOTDC.BIN`, `BINC1.AFS`–`BINC3.AFS`, `LANDDC1.AFS`, `LANDDC2.AFS`,
  sprite files, sound files, `SONG01.AFS`, `VOICE01.AFS`, and `1ST_READ.BIN`.
- Every output file was re-read and SHA-256 checked. `manifest.json` records each
  path, absolute LBA, exact size and hash, plus the raw source track's SHA-256.
- Independently compared all 51 directory entries and payload hashes against
  the supplied decomp's `tools/gdi_read.py`; all matched. A temporary one-track
  GDI descriptor was used only for that comparison.

## Scope and reference

The local reference is
`/Users/toddbruss/Downloads/crazy-taxi-decomp-main/tools/gdi_read.py`:
lines 39–49 describe sector payload access and lines 51–77 describe ISO directory
walking. The new reader is independently implemented and adds bounded extents,
record checks, endian-copy validation, safe paths, cycle/duplicate rejection,
streaming reads, no-overwrite output, temporary staging and hash verification.
It supports this single high-density raw Mode 1 track, not arbitrary multi-track
GDI layouts, cooked sectors, interleaved or multi-extent files (CHD images are
handled first by `extract_chd.py`).

**The disc extractor recovers original containers.** The texture conversion below
now exports the four TEXDC banks and the model conversion exports POLDC/BINC
geometry, the audio conversion exports ADX and DTPK sounds, and the sprite
conversion exports the SPR banks; the character conversion assembles people and
exports their V-format motions; the vehicle conversion assembles traffic and cabs;
the set-object conversion places the OBJDC street props; the collision conversion
exports the COLDC ground and wall grids; the course-line conversion exports the
SPLDC traffic lanes with their links; the destination-picture conversion decodes
the LANDDC pictures with their names; the Fcv conversion exports the key-curve
motions at the start of MOTDC; the recorded-drive conversion exports the four
REC* input recordings; the customer conversion exports where customers wait, the
stops they ask for and the stop areas.
The decomp's `tools/model_map.py` documents model/texture mappings (lines 6–50 and
83–93). Do not apply region-specific executable addresses to this USA build
without validating them. No upstream source or game data was copied into the
tracked tool/test sources.

## TEXDC texture conversion

After disc extraction, write PNGs to a new ignored directory:

```sh
python3 tools/extract_textures.py local-assets/disc --output local-assets/textures
```

The tool finds texture-record runs in `1ST_READ.BIN` (16 bytes: dimensions,
data type/pixel format, RAM data address, reserved zero). Each `TEXDC0.BIN`–
`TEXDC3.BIN` must match exactly one run whose payloads are contiguous after
32-byte alignment, including final padding. Output contains `TEXDCn/####.png`,
`manifest.json` (source, payload, RGBA and PNG SHA-256) and `index.html`.
It decodes ARGB1555, RGB565 and ARGB4444 twiddled, mipmapped twiddled,
VQ, mipmapped VQ, linear and twiddled-rectangle data; only top mip levels are exported.

Verified October 22, 2026 against the USA files: **1,323 textures** (TEXDC0 438,
TEXDC1 336, TEXDC2 324, TEXDC3 225). Their tables are at `1ST_READ.BIN` offsets
`0x130570`, `0x134cb0`, `0x1361c0` and `0x137610`; every bank has 18 bytes of
final alignment padding. An independent check used the decomp `texture_lists`
with base 0 and `textures.decode` reference: every entry, RGBA hash, PNG hash,
chunk CRC and decompressed scanline matched.

## Model conversion (glTF 2.0)

After the texture step, write GLB files to a new ignored directory:

```sh
python3 tools/extract_models.py local-assets/disc \
  --textures local-assets/textures --output local-assets/models
```

Models use the NAOMI flat `nlObjPut` format described in the decomp's
`docs/engine.md` ("Textures and the model draw"). Each `POLDC0`–`POLDC3`
model becomes `POLDCn/<offset>.glb`. Each `BINC1`–`BINC3.AFS` city archive
becomes one `BINCn.glb` with one node per AFS entry, since city pieces are stored
in world coordinates. Records keep their texture numbers as materials: `POLDCn`
and `BINCn` refer to `TEXDCn` PNGs by relative URI (not embedded). The PowerVR
words set alpha mode (list 0 opaque, 2 blend, 4 mask), U/V clamp/flip wrapping,
point/bilinear filtering, modulate/decal colour and double-siding (strip culling 0).
Triangle lists (`gflag` bit 3: three entries per polygon) and strips are both
handled, and two-word vertex references resolve to shared vertices. Records with
specular `-3` use a vertex-colour layout: signed-byte normal in word 3, ARGB colour
in word 4, then U/V. These were found in the USA data and exported as `COLOR_0`.
Records with TSP shading 2 (decal alpha) are the exception to referenced textures:
the PowerVR shows texture RGB × texture alpha + face RGB × (1 − texture alpha) with
the face alpha as alpha, which glTF cannot express. Those textures are baked with
the face colour the USA record drawer (`0x0C080E20`) sends and embedded as PNGs
(the same rule and code as the vehicle conversion, without traffic paint; colour
type 3 records take the previous colour type 2 record's face colour). No fade
colour is applied; its initial value (USA `0x0C0E93AC`) is 1, 1, 1. The manifest
gives `decal_records` (and `baked_images` for a POLDC model, or per BINC file) when
a model has any.
Triangles are wound so they face the same way as the stored vertex normals.
Coordinates are kept as stored; handedness has not been checked against the
running game.

Verified October 22, 2026 on the USA files: **2,721 models, 543,791 triangles**
(POLDC0 1,563, POLDC1 45, POLDC2 81, POLDC3 7; BINC1 495, BINC2 400 and BINC3 130
pieces — every AFS entry). The decomp's `model_map.find_models` lists the same
offsets, record counts, strip byte totals and full-vertex counts for every model.
The only exception is three city pieces (BINC2 entries 201–202, BINC3 entry 86):
our tool also reads them, while the decomp skips them because their strips have
206–302 entries and its scan stops at 200.
Eight BINC1 vertices have NaN U values; these are replaced with 0 and counted in
`repaired_vertices`. All 1,699 GLBs passed Khronos `gltf-validator`, with every
image URI resolved, and reported 0 errors and 0 warnings. Decal alpha: 21 models
have such records (POLDC0 18, POLDC2 3; none in POLDC1, POLDC3 or the BINC
archives), 88 records in all, giving 76 baked images and 87 baked materials (face colours white, yellow
(1, 1, 0) and (1, 0.994, 1)). Only those 21 GLBs differ from the unbaked output;
they validate with 0 errors and 0 warnings, every baked image re-decodes to the
decal-alpha rule applied to its TEXDC PNG pixel for pixel, and two runs give
identical output. Characters are assembled
by the character conversion below, vehicles by the vehicle conversion and the
street props (set objects) by the set-object conversion.

## Audio conversion (WAV)

```sh
python3 tools/extract_audio.py local-assets/disc --output local-assets/audio
```

This writes 16-bit PCM WAVs to `<SOURCE>/<id>.wav`, plus `manifest.json` (source,
stream and WAV hashes, offsets, loop points, clip counts) and an `index.html`
player page. The run takes about 10 seconds.

* **ADX** (`SONG01.AFS` music, `VOICE01.AFS` speech): type-3 4-bit CRI ADX. The
  prediction coefficients come from the header's high-pass cutoff. The block scale
  is `(word & 0x1FFF) + 1`, the same `+ 1` as the game's own decoder (decomp
  `src/gen_hc.c`, `ADX_DecodeSteFloat`). The game decodes in floating point;
  this tool uses the standard integer method. Header loop points (version 3) are
  saved in the manifest.
* **DTPK** (`SNDDC*.BIN` sound effects): each 16-byte entry in the sample table
  holds AICA channel registers. These are the start address (23 bits), PCMS
  (0 = PCM16, 1 = PCM8, 2 = ADPCM), the loop flag, LSA/LEA and the byte size.
  The decomp's `dtpk_sounds` uses `word >> 24` as the format. That reads PCM8
  entries as PCM16 and skips entries above 16 MB. Proof that the register
  reading is right: the entries run back to back, and every LEA is within 3
  samples of the length decoded in that format. ADPCM is Yamaha AICA (low nibble
  first, step 127). The pack's sample table holds no rate; see the playback
  definitions below.
* **DTPK playback rate**: the header word `+0x30` points to the playback
  definitions: last index at chunk `+0x10` (u16), then 64-byte entries from
  `+0x50` (`+0` index, `+2` sample, `+10` signed semitones, `+11` signed 1/64
  semitones, `+0x1C` random tune). The disc's sound driver `AICADRV.BIN`
  (AM2/AICAsoundDrv 990623 Ver1.70, ARM7, disassembled with `llvm-objdump
  --triple=armv4t`) computes the pitch in note-on routine `0x3B54`. The pitch
  is `byte10 << 8 + byte11 << 2` in 1/256 semitones. The voice's key offset,
  channel transpose/detune, bend and random tune are added to it. Routine
  `0x2E68` then splits it into `OCT = pitch // 3072` and FNS = the driver's
  768-entry table (at file offset `0x7084`, exactly
  `round(1024 * (2 ** (i / 768) - 1))`) at index `(pitch mod 3072) >> 2`. The
  rate is `44100 * 2 ** OCT * (1024 + FNS) / 1024`. Each sample's WAV uses the
  rate of the first definition that plays it. The manifest's `playbacks` list
  holds every definition with its pitch register and exact rate. Samples no
  definition uses fall back to the instrument splits below.
* **DTPK instrument programs** (header word `+0x34`, present in SNDDC1-3): the
  driver's program change (`0x55E0`) looks the bank up by header byte `0x11` and
  reads this chunk: last program index (u8), then u32 program offsets from `+4`,
  relative to the chunk. A program is an 8-byte header (`+0` last split index;
  the other bytes are unexplained) followed by its splits. Note-on (`0x57B8`)
  steps from split to split by the split's own size byte (`+0`). Each split holds
  the sample as a u16 at `+2` (the sample lookup `0x3C98` treats values from
  `0x100` as this pack's sample `n - 0x100`; lower values would be a global
  table), the lowest and highest key at `+4`/`+5`, and five (point count,
  offset from `+0xC`) curve groups at `+0xC`. Groups 0-3 use 4-byte points;
  group 4 is the pitch curve with 6-byte points {last key, -, base u16, slope
  s16}. Curve routine `0x5FFC` picks the first point whose last key is at least
  the note (or the last point). The value is `base + (slope * (note - segment
  start)) >> 8`, where the first segment starts at the split's lowest key and
  each later one starts after the previous point's last key. The value is in
  1/32 semitones. The driver adds two channel controls (both 0 when centred),
  clamps the result to `0..0x17FF`, and routine `0x5FB0` turns it into the
  OCT/FNS register: `OCT = value // 384 - 8`, FNS = FNS table entry
  `2 * (value mod 384)`. The register is written to the AICA channel's `+0x18`.
  The manifest's `instruments` list holds every program and split with its
  pitch points and the pitch register and rate at its lowest and highest key. A
  sample no definition plays takes the rate of its first split at that split's
  lowest key. The tool refuses to run unless 64 checked instruction and literal
  words in `AICADRV.BIN` are exactly as expected and the FNS table sits at
  `0x7084`, where this code reads it.
* **DTPK sound requests** (header word `+0x2C`, present in SNDDC0-1 and 5-8):
  the game sends the driver a 32-bit command; top bytes `0xA8`-`0xAD` are sound
  requests (`0x764`), `0xA0` is a driver control command. The lookup (`0x6B40`)
  walks the 8 loaded banks: the chunk holds the last group index (u8), then u32
  entries `id << 16 | group offset`; the entry whose id equals `command >> 16`
  wins. A group holds the last sequence index (u8), then u32 sequence offsets;
  command bits 8-15 pick the sequence. All offsets are relative to the chunk. A
  sequence's first byte is a header; with bit 7 set the rest is a **script** of
  events, otherwise a 4-byte header is followed by a **track list** of u32 words
  (top byte 0: events at sequence + offset, then the next word; `0x80`: send
  the low 24 bits `<< 8` as a driver command; `0x90`: jump; anything else ends,
  after playing the events at its offset if that is not 0). The event reader
  (`0x6338`) is MIDI-like: a byte with bit 7 is a status (kept as running
  status), `0xFF` ends, and the status's bits 4-6 pick how many data bytes follow
  (jump table `0x6594`). In a script, `0xDn key velocity flag` is sent as note-on
  `0x9n` (`0x637C` clears bit 30); the flag's low 7 bits go to command bits 4-10
  and its bit 7 means "no delay follows". Every other event is followed by a
  delay in ticks (one byte, or `(b << 7 | next) & ~0x4000` when the first has bit
  7). Note-on with velocity 0 is a note-off (`0x30D4`). For a playback-definition
  channel (program type 2, which the `+0x30` chunk starts with) note-on picks
  definition `key + (command & 0xF0) << 3` (`0x3280`) and plays it only if the
  velocity lies in the definition's `+0x20`..`+0x21` range (`0x32EC`). The
  manifest's `requests` list holds every group and sequence with its timed
  events, and each sample lists the requests that play it. `index.html` has one
  line per request with links to the WAVs. The tool refuses to run if any of 82
  checked words in `AICADRV.BIN` differs (the tool commit message says 104; 82
  is the real count), a request id lies outside `0xA8`-`0xAD`, a note plays a
  missing definition or a velocity outside its range, events run past the chunk,
  a track list loops, or the same id appears in two packs.

Verified October 22, 2026 on the USA files: **798 sounds**. They are SONG01 9
stereo 44.1 kHz tracks (621.8 s; tracks 0 and 8 loop), VOICE01 699 mono 22.05 kHz
clips (1,034.7 s), and 90 DTPK samples (SNDDC0 41, SNDDC1 20, SNDDC2 2, SNDDC3 3,
SNDDC5 4, SNDDC6 7, SNDDC7 8, SNDDC8 5; 38 ADPCM, 38 PCM16, 14 PCM8). Two
independent checks against ffmpeg 8 passed:

* All 708 ADX streams decoded with `scale_bias=0` match ffmpeg's `adx` decoder
  sample-for-sample. ffmpeg leaves out the game's `+ 1` and pads the last block.
* All 38 ADPCM samples match ffmpeg's `adpcm_aica` decoder sample-for-sample.

All 798 WAVs open in `ffprobe` without errors. Clamping to 16 bits affects 718
music samples and 215 voice samples.

DTPK playback rates (USA): 96 definitions (SNDDC0 52, SNDDC1 20, SNDDC5 4,
SNDDC6 7, SNDDC7 8, SNDDC8 5; SNDDC2-3 have none). Every chunk ends exactly
where the next chunk or the pack's end begins. 82 of the 90 samples get a
definition rate: 60 play at 22,050 Hz, and others range from 10,406 Hz to
44,100 Hz (5 at 44,100). 7 samples are played by definitions with different
rates; their WAV uses the first one.

DTPK instruments (USA): 5 programs with 8 splits (SNDDC1 2 programs / 3 splits,
SNDDC2 2 / 2, SNDDC3 1 / 3). Each program ends exactly where the next one or
the sample table begins, and every split's size equals its curve data rounded
up to 4 bytes. The splits play exactly the 8 samples no definition uses
(SNDDC1 1, 2 and 19; SNDDC2 0-1; SNDDC3 0-2), so no sample keeps the nominal
rate any more. Their lowest-key rates are SNDDC1 18,540 / 14,718 / 22,050 Hz,
SNDDC2 19,649 / 29,436 Hz and SNDDC3 15,364 / 15,816 / 18,271 Hz; across their
key ranges they rise to between 20,780 and 53,876 Hz. The slopes are 258 to
1,646 (1 to 6.4 pitch units, i.e. 1/32 to 1/5 semitone, per key), far from
normal keyboard tracking. The note seems to drive a continuous pitch (an
engine-like sound), but that is not verified. SNDDC1 program 0 split 1's two
pitch segments meet within one unit (2,719 at key 100, 2,720 at key 101), which
supports the segment rule. Two runs give identical manifests, the PCM of all 90
samples is unchanged, and 7 WAV rates changed (SNDDC1 sample 19 stays at
22,050 Hz, now from its split).

DTPK sound requests (USA): 18 request ids with 102 sequences (SNDDC0 9 ids / 53,
SNDDC1 3 / 19, SNDDC5 1 / 4, SNDDC6 2 / 11, SNDDC7 1 / 10, SNDDC8 1 / 5;
SNDDC2-3 have none). The ids are `0xA800` and `0xA900`-`0xA911` without
`0xA906` and `0xA90E`; no id appears in two packs. 101 sequences are scripts
with header `0xC0` on channel 15; together they hold 96 note-ons and 9
note-offs. **Every one of the 96 playback definitions is played by exactly the
requests in its own pack, and the highest key in each pack equals its last
definition**, which supports the key-to-definition rule. 82 of the 90 samples
are reached by a request; the other 8 are the instrument-only samples. Only two
scripts wait: `0xA9000D00` plays definition 14 50 ticks after 13, and
`0xA9000E00` plays 16 20 ticks after 15. SNDDC1 `0xA9050000` and `0xA9050100`
start two definitions at once. Requests such as `0xA9040200` (note-off for 27
after `0xA9040100` starts it) stop looping sounds. All flag bytes are 0 or
`0x80`, so no note uses the `<< 3` definition offset. The one track list,
`0xA8000000`, plays nothing: it sends driver commands `0xA0001200` and
`0xA0190000` and ends. Two runs give identical output and all 798 WAVs are
byte-identical to the previous run.

Limits:

* The rate is the definition's own pitch, or the split's at its lowest key. Key
  offset (`note - 60`, used only when the channel enables it), channel
  transpose/detune and bend aren't applied. The sound requests use playback
  definitions only; which notes reach the instrument programs isn't known.
* Random tune is listed but not applied.
* Tick length (tempo) isn't traced, so request delays are in ticks. The
  sequence header bits other than bit 7 (the driver reads them at `0x6BD4`-`0x6DE0`
  when it picks or clears a sequence slot; not traced), the `0xA0` control commands,
  are not decoded. Which game code sends each request is listed by
  `tools/extract_sound_uses.py` (see Sound request uses).
* Split curve groups 0-3 (read by the driver, not traced), the split bytes `+1`
  and `+6..+0xB`, the program header's bytes 1-7, the chunks at header words
  `+0x20`-`+0x28` and `+0x38` (SNDDC0 only), envelopes and filters aren't
  decoded.
* Sample-entry word `+8` (`0x80` on SNDDC1 samples 3 and 4) is unexplained. The
  driver's sample lookup (`0x3C70`) reads only `+0`, `+4` and `+6`.

## Sprite conversion (PNG)

```sh
python3 tools/extract_sprites.py local-assets/disc --output local-assets/sprites
```

The `SPR*.BIN` files are headerless texture data. Each one's 16-byte texture records are in
`1ST_READ.BIN` as a run ended by an all-`0xFF` record. The run whose packed size
equals the file's size is its table. Records pointing outside the file (one
128×128 render target in SPRCOMM) are listed as `external` with no PNG. That
record is the destination-picture texture filled from LANDDC (see below).

Most sprites (448 of 687) are palettised twiddled textures: Kamui type 5 (4-bit,
low nibble first) and type 7 (8-bit). The files hold neither palettes nor palette
selectors. The tool recovers both from the game's own loader code. A linear
SH-4 pass tracks constant registers (`mov #imm`, PC-relative `mov.w`/`mov.l`,
`mov Rm,Rn`, delay slots, forward `bra`) and records `r4`–`r6` at every call:

* The sprite loader takes `(table, selector array)`. It writes `selector[i]` into
  TCW bits 21–26 for pixel formats 5 and 6. A null array means no palettes
  (SPRBOX, SPRADV).
* The menu loader that loads SPRCOMM copies four palettes into palette RAM:
  entries 0, 256 and 512 (256 each) and 768 (16), at `0x0C08A688`, `0x0C08A828`,
  `0x0C08AA28` and `0x0C08A808`. These are ARGB4444: the game calls
  `paletteSetMode(2)` (decomp `src/game_p.c`), and the 16-bit entries ramp
  `0x0FFF`→`0xFFFF` for antialiased white fonts. The executable holds three other
  literal references to the upload routine (pool words at `0x0C073434`,
  `0x0C079978` and `0x0C080084`, inside SDK code). They were not traced, so the
  banks 1–2 used in-game are assumed to be the ones the menu loaded.
* An 8-bit texture reads entry `(selector & 0x30) * 16 + index`. A 4-bit texture
  reads `selector * 16 + index`. The selectors found are 0, 16 and 32 for 8-bit
  and 48 (the 16-entry font palette) for 4-bit.

Texture numbers (`texture_number`) come from the executable's
(common-texture offset, table) word pairs. They match the
`nlSetCommonTextureOffset` values passed before each load (for example
SPRCOMM 0, SPRGAME 240, SPRMENG 860).

Verified October 22, 2026 on the USA files: **687 PNGs from 11 banks** (SPRADV 13,
SPRBOX 23, SPRCENG 19, SPRCJAP 19, SPRCOMM 122 + 1 external, SPRGAME 217, SPRGENG 4,
SPRGJAP 7, SPRMENG 113, SPRMENU 54, SPRMJAP 96; ~2 s). All 239 non-palettised
textures match the decomp's `textures.decode` RGBA bit for bit (fed a synthetic
PVRT header). The decomp does not decode palettised data, so the other 448 have no
outside reference. Checks done on them instead:

* Every texture indexes only palette entries that were loaded.
* No bank-0 texture uses an index of 192 or above, where bank 0 overlaps the next
  uploads.
* Font and digit sprites read as clean glyphs when printed as text, which confirms
  the twiddle order and nibble order.

Palette RAM in-game could still differ if a code path not found here rewrites it.

## Characters and motions (glTF 2.0)

After the texture step:

```sh
python3 tools/extract_characters.py local-assets/disc \
  --textures local-assets/textures --output local-assets/characters
```

This writes `characters/char_XX.glb` (one assembled person per character-table
entry, standing), `motions.glb` (one animation per motion), `manifest.json` and
`index.html` in about 18 s. Bones are nodes named `bone_0`–`bone_15`. Each body
part is a child mesh node of its bone. Every motion targets the same node names,
so three.js can play any clip from `motions.glb` on any character.

Nothing is taken from the decomp's European addresses. The tool finds them all in
the USA files:

* **POLDC0 load address** `0x0C390000`: the 64 KiB-aligned base that turns the
  most executable words into POLDC0 model addresses.
* **Character table** `0x0C131EB8`: the longest run of pointers to 16-slot part
  arrays (slot 0 empty, the rest null or POLDC0 models). It has 63 entries.
* **MOTDC load address** `0x0C880000` and its **56 V-format motions**. Each
  header is `{frames, 15, data}`, and the data (`frames` × 396 bytes) ends at the
  header. All 56 headers agree on the base.
* **Skeleton, bind offsets and extra parts**, from the game's own draw routine.
  Of the functions that load the character table, only one can be run end to end
  by a small symbolic SH-4 interpreter with V-format rotations: `0x0C0689D4`. The
  interpreter runs that routine once per character, starting from the executable's
  initial data. It records the matrix push/pop calls, translations (bind vectors at
  `0x0C0D4290`–`0x0C0D4320`, or the motion's root vector), rotations and model
  draws. It picks the five primitives by how they are called, not by address:
  `0x0C077260` push, `0x0C077210` pop, `0x0C0779F0` translate, `0x0C06A160`
  rotate, `0x0C078FC0` draw.

Results, verified October 22, 2026 on the USA files:

* **63 characters, 1,014 part draws, 25,354 triangles.** All 63 characters share
  one 16-bone tree. Its bones, parents and bind offsets match the decomp's
  `docs/engine.md` table exactly.
* **Extra parts.** The draw routine adds 122 extra parts on top of the slot
  parts, picked by `cmp/eq` chains and a `braf` jump table on the character
  number. They include all 94 extras in the decomp's `models.txt`, plus 28 it
  does not list (mostly hip and thigh pieces). Two of them, the left-hand extras
  of characters `0x21` and `0x24`, are gated by the flag at `0x0C13DAA0`. That
  flag is 1 in the executable's initial data, so they are drawn here; at runtime
  it may change.
* **Cabbies.** The character-select table at `0x0C12F454` (idle motion, select
  motion, character) names characters `0x3B`–`0x3E`. The manifest labels them
  Axel, B.D. Joe, Gena and Gus, in the selection screen's order.
* **Rest pose.** Each character stands in record 1 of the standing idle at
  MOTDC offset `0x263244`. In that pose the pelvis is at y 10.58, the head joint at
  15.06 and the ankles at 1.25, and bones 7 and 14 (right side) sit at +x, as the
  decomp describes. Character `0x3B`'s parts span y 0.02–18.3, x ±2.9.
* **Rotations.** A record holds the root vector, then two unit vectors a and c
  per bone. The rotation's columns are a, c and a × c. Every rotation in every
  record is orthonormal to within 1.5e-6.
* **Validation.** All 64 GLBs pass the Khronos `gltf-validator` with 0 errors and
  0 warnings, and every texture URI resolves. Two runs produce identical output.

How the animations are built, and what is assumed:

* **Looping.** The game plays record `frame mod (frames − 1) + 1`, so record 0
  is never shown. Each animation therefore holds records 1…frames−1, then
  record 1 again to close the loop.
* **Frame rate.** Keys are spaced at a nominal 30 fps; the game's real playback
  rate has not been established.
* **Root movement.** Translation is the full root vector, which matches the
  draw routine's mode 0. Walking customers use mode 1, which keeps only the
  height (the game moves them by root travel instead); `root_travel` in the
  manifest shows which clips move.
* **Interpolation.** Rotations are interpolated as quaternions. The game instead
  averages the a and c vectors and normalises them, so in-between frames can
  differ slightly.

Not exported:

* The start of MOTDC: the key-curve (Fcv) motions, played with two-bone IK.
  `tools/extract_fcv_motions.py` converts them (see below).
* The low-detail 8-part people table at `0x0C1324D4`.

## Vehicles (glTF 2.0)

```sh
python3 tools/extract_vehicles.py local-assets/disc \
  --textures local-assets/textures --output local-assets/vehicles
```

This takes about 13 seconds and writes 22 traffic GLBs (`traffic/type_NN_<name>.glb`),
5 cab GLBs (`cabs/cab_N.glb`), `manifest.json` and `index.html`. Everything is found
in the USA files; no regional address is reused:

* **Traffic table (carTbl).** The longest run of 0xA8-byte records whose body,
  far body and shadow words are model addresses and whose `+0xA4` word points to
  the type's name. USA: `0x0C0A1488`, 22 types (decomp EU `0x0C0A2628`). The names
  are space-padded: `E_Taxi`, `P_Compact`, `P_Wagon`, `P_Sedan_A`, `P_Sedan_B`,
  `P_JEEP`, `P_Picup`, `P_Box`, `P_Sedan_C`, `P_IceBox`, `P_Bus`, `P_Convoy`,
  `P_Convoy_TLR`, `P_Convoy_TLR2`, `P_Mercury`, `P_Cable`, `P_RailRoad_A/B/C`
  and three more `P_Cable`. Types 0–15 use POLDC0; 16–21 use POLDC2 (the only
  model file holding all their models, at the shared POLDC1–3 base `0x0C5E0000`).
* **Colours.** The 32 RGB triples after the last record (`0x0C0A22F8`, the
  literal in the USA `putCarModel`), and per type a 32-entry index list at
  `+0x9C` (PcarEvInit picks `random & 31`). E_Taxi, IceBox, Bus, the convoy and
  the rail vehicles have none.
* **Paint (USA disassembly).** `putCarModel` reads the car's colour as a halfword
  at `+0x7C` of the `_car` when the word there is not negative, and calls
  `SetFadeColorBaseMulti(r, g, b)` (`0x0C02FF6A`) with that colour-table entry.
  That multiplies the fade base (`0x0C0E93AC`, 1, 1, 1 in the file) and stores it
  with `nlObjPutSetFadeColorBase` (`0x0C079180`, into `0x0C148678`). Only the body
  model (`+0x00`, or `+0x04` far away) is drawn before `ResetFadeColor`
  (`0x0C02FFC2`); the models drawn after it (the `+0x10` extra among them) are not
  tinted. The library record drawer (`0x0C080E20`, the decomp's EU `FUN_0c081660`)
  copies the fade base and, for a record whose PCW colour type is 2 (bit `0x20`
  set, `0x10` clear: intensity mode 1), multiplies the header's face colour R, G, B
  by it before sending it to the PowerVR. Colour type 3 records (intensity mode 2)
  send no face colour, so the hardware uses the last mode 1 colour. In the eight
  painted bodies (near and far) every record but five is textured with TSP shading
  2 (decal alpha), where the PowerVR shows texture RGB × texture alpha + face RGB ×
  (1 − texture alpha), with the face alpha as alpha; the five are a plain decal
  record in each P_Sedan_B/C body and one modulate record in P_Picup's far body.
  The body textures carry graded alpha (ARGB4444), so the paint shows through where
  the texture is transparent.
* **Paint in the GLBs.** glTF has no decal-alpha mode, so every decal-alpha texture
  is baked with that rule and embedded as a PNG: on non-body models and on types
  without a colour list with the record's own face colour (E_Taxi's face colour is
  yellow), on painted bodies with face colour × paint. A body's default material
  uses the first entry of the type's list (`random & 31` = 0); every distinct list
  entry is a `KHR_materials_variants` variant named `paint_NN` (NN = colour-table
  index). The manifest's `paint` entry gives the default, the variants and counts.
  USA: 12 types have decal-alpha records (E_Taxi, types 1–8 and the three
  POLDC2 `P_Cable`s); types 1–8 are painted (6, 8 or 16 colours each, 432 baked
  images); no cab uses decal alpha. A P_Picup body record has a face colour of
  (1, 1, 0.994), so its decal materials are kept apart by face colour.
* **Placement (USA `putCarModel`, about `0x0C0434E0`).** Scene "near": body
  `+0x00`, shadow `+0x08`, extra `+0x10`, and for axle k the wheel model
  (`+0x58/+0x60/+0x68`) at the axle centre (`+0x70/+0x7C/+0x88`) plus the second
  model (`+0x5C/+0x64/+0x6C`) at (−x, y, z). The first axle is skipped when
  `+0x58` is 0, and no wheels are drawn when `+0x60` is 0. Scene "far" holds
  `+0x04/+0x0C/+0x14` (no wheels). Scene "lamps" holds the eight light variants
  per level at `+0x18` and `+0x38`.
* **Cabs (init_CarMain tables, USA `0x0C0D9DC4`).** Five model-set pointers, then
  five pointers to wheel positions (`+0x6C`) and five to four more points
  (`+0x70`); entry 4 is the default. USA sets have 14 words (the default set has 7
  before it runs into set 0). Scene "car" follows the USA `putPlayerCar`
  (`0x0C0203E8`): set[4] body and set[6] drawn 1.2 below the car origin (the
  `nlTranslate(0, −1.2, 0)` at `0x0C02045C`), wheels set[0..3] at the `+0x6C`
  positions. Every other entry goes to the "alternates" scene: set[5] (drawn
  instead of set[6] with a fare on board), set[7]/[8] (roof height), set[9..12]
  (wheel-sized, placed at the wheel positions) and set[13] (a second body).

Checks:

* The decomp's model map (`model-map/game.dcgs`) labels 68 vehicle models; 67 are
  in the same file, at the same offset, on the same type, with the same role here.
  The other is POLDC3 offset 0, which the decomp ties to a code literal rather
  than to carTbl.
* Axles, `+0x94` (2000 for cars, 8000 for the bus) and `+0x98` (28, 40) match the
  decomp's figures. P_Mercury's body is cab set 3's body, as the decomp says.
* All 27 GLBs pass the Khronos `gltf-validator` (which knows
  `KHR_materials_variants`) with 0 errors, 0 warnings and no unused objects, and
  every texture URI resolves. Every baked image was decoded again and matches the
  decal-alpha rule applied to its TEXDC PNG pixel for pixel. Two runs give identical
  output. 6,843 traffic and 14,356 cab triangles; no model has been visually
  inspected.

Assumptions and limits:

* The cab order (Axel, B.D. Joe, Gena, Gus) is the selection-screen order.
* Wheel heights come from the tables; in play the suspension sets them. The traffic
  body sits at the car origin; in play it is lifted by the suspension values.
* The roles of the cab alternates and the lamp variants are read from where the
  models sit and which flags pick them, not confirmed in play.
* The default cab set's wheel models (one thin disc twice, one full axle twice) are
  placed as the game would place them, so its axle models overlap.
* Paint is the static colour only: lighting (the records' intensity), the offset
  colour and runtime fade changes are not applied. Which colour a given car gets
  is random in play.
* `extract_models.py` bakes decal alpha with the same code (moved there) but with
  the unpainted face colour, so its POLDC0 traffic bodies show the face colour,
  not a traffic paint. The vehicle GLBs were byte-identical before and after the
  move.

## Set objects (glTF 2.0)

```sh
python3 tools/extract_props.py local-assets/disc \
  --textures local-assets/textures --output local-assets/props
```

This takes about 11 seconds and writes `OBJDC1.glb` (Arcade), `OBJDC2.glb`
(Original) and `OBJDC3.glb` (Crazy Box), `manifest.json` and `index.html`. These
are the knock-over street objects (the decomp's "set objects": postboxes, signs,
crates and so on). Positions are world coordinates, so each file lines up with the
same city's `models/BINCn.glb`.

* **OBJDCn.BIN.** `loadCity` loads the first 0x8000 bytes at a fixed address and
  uses the absolute pointers inside unchanged. The tool takes the one 64 KiB-aligned
  word in the executable under which every file's pointers resolve: USA
  `0x0CE90000`. 32-byte groups from offset 0 (centre, `+0x10` count, `+0x14` first
  record) until the first empty one, then 32-byte records (position, `+0x0C` Y angle
  in 1/65536 turns, `+0x10` kind, `+0x12` variant, `+0x14` next record). Arcade has
  58 groups and 527 objects, Original 63 and 505, Crazy Box 24 and 401; every
  chain length equals its group count.
* **Kinds.** The longest run of 0x24-byte records in the executable: USA
  `0x0C0EC998`, 28 kinds (sphere offsets and radii, count, `+0x0C` X angle, hit
  handler, flags, mass). The model table is the one run of exactly 28 pointers to
  model-pointer arrays: USA `0x0C0ECF8C`; each array runs to the next one.
* **Placement (USA `setObjPlace` `0x0C03737C` and the draw in `SetObjFly`).**
  Translate to the position, `nlRotateAY(angle)`, `nlRotateAX(kind X angle)`,
  then the model. The USA `nlRotateAY`/`nlRotateAX` (`0x0C0775E0`/`0x0C077430`)
  were read to fix the sign of each rotation. POLDC0 models use TEXDC0; the
  city's own models (kind 16 in Arcade, kinds 17 and 19 in Crazy Box) use TEXDCn.
* **Groups a run opens (USA `InitSetObject` `0x0C037728`).** Arcade walks groups
  0–57 and empties group 24 first; Original walks 0–62; Crazy Box walks a range per
  mini game (`MiniGame_No` 3: 0, 1: 1–2, 8: 3, 9: 4–9, 14: 10–23, others 24–57).
  Scene "props" holds the groups some run opens, scene "unused" the rest (only
  Arcade group 24). Each group node lists its runs in `extras`.

Checks:

* The decomp's model map has 50 rows for this model table (EU `0x0C0EDFB0`); all
  50 give the same POLDC0 offset at the same index in the USA table. The table
  entries it has no row for (kind 0, and the city models of kinds 16, 17 and 19)
  are models the map lists under other tables.
* Every object's model is in POLDC0 or in its own city's POLDCn, and every variant
  is inside its kind's array.
* With the rotation applied, the lowest point of each model sits on the city
  surface under it (a ray through `BINCn.glb`): median gap 0.01, 0.007 and 0.005
  units, and within 0.5 units for 488 of 527, 461 of 505 and 379 of 401 objects.
  Kind 5, which also has a 90° X turn, sits flat too.
* All 3 GLBs pass the Khronos `gltf-validator` with 0 errors and 0 warnings, and
  every texture URI resolves. Two runs give identical output. 1,396, 1,679 and
  1,435 triangles; no model has been visually inspected.

Assumptions and limits:

* This is the resting layout. In play an object is drawn only within 1000 units of
  the camera, groups open and close by distance, and a hit object flies, bounces
  and is removed (`SetObjFly`); none of that is exported, though the manifest
  keeps each kind's collision spheres and mass.
* The Crazy Box mini game numbers are `MiniGame_No` values; which menu game each
  is was not checked.
* Kinds 21–27 have models but no OBJDC record uses them; whatever places them (if
  anything) is not traced. SPLDCn and LANDDCn are not read here; COLDCn is read by
  the collision conversion below.

## Course collision (glTF 2.0 + JSON)

```sh
python3 tools/extract_collision.py local-assets/disc --output local-assets/collision
```

This takes about 5 seconds and writes, per city, a GLB view (`COLDC1.glb` Arcade,
`COLDC2.glb` Original, `COLDC3.glb` Crazy Box with one scene per mini-game grid)
and one JSON file per run (`arcade.json`, `original.json`,
`crazy_box_game_NN.json`) holding the ground and wall grids the way the game walks
them, plus `manifest.json` and `index.html`. Positions are world coordinates, the
same space as `models/BINCn.glb`. Ground surfaces are coloured with the game's
own debug colour for their kind; walls are red quads, poles orange prisms.

* **Layout (decomp `src/collide.c`, Equivalent C).** COLDCn is loaded whole and
  keeps absolute pointers. A grid is a 32-byte header in the executable (first and
  last cell x and z, cells per row, rows, cell count, cell size) plus a pointer to
  an array of cell pointers in the file. Ground cell: top, bottom, a halfword (kept
  raw), the surface count, the surface pointers. Surface (0x4C bytes): plane a, b,
  c, d (`y = -(a*x + c*z + d) / b`), a radius around the first corner, four corners,
  the kind and the shape (3: a triangle of corners 1-3; 4: a quad). Wall cell: wall
  and pole counts, then the pointers. Wall: the line a, b, d, an end point, top,
  bottom and length; it runs from the end point to `(x - length*b, z + length*a)`,
  as `CheckColliWallSegment`'s along-wall coordinate shows. Pole: centre, radius,
  top, bottom.
* **Finding it in the USA executable.** The load address is the one 64 KiB-aligned
  word under which the cell arrays read: USA `0x0CB40000` (the staging area the
  decomp memory map gives). Headers are found by their internal consistency;
  a word in the executable is a cell array for a header when every cell's surfaces
  lie in that cell's square and height range, and every surface, wall and pole is
  listed in the cell under its centre or a neighbour of it. Arcade and Original
  take the largest such grid in their file. Crazy Box takes, per `MiniGame_No`,
  the cell-pointer table followed by an index table into one header table. The
  surface kinds are the longest run of 28-byte entries named `#...` (bounce, debug
  RGB, name): USA `0x0C08ECC0`, 22 kinds (`#road`, `#rokata`, `#kabe`, `#grass`,
  `#shougai`, `#water`, `#ikenai`, `#puddle`, `#tuti`, `#suna`, `#hodou`, `#rock`,
  `#jump`, `#slope`, `#sea`, `#ice`, `#high_road`, `#tosub_slop`, `#sub_slope`,
  `#tosub_hodo`, `#sub_hodou`, `#sub_road`); `#kabe` and `#ikenai` bounce 1.0, as
  the decomp says of kinds 2 and 6.
* **Result.** Arcade: 17,880 surfaces, 3,607 walls (25 inert), 424 poles.
  Original: 22,050 surfaces, 6,164 walls (316 inert), 206 poles. Crazy Box: 14
  grid pairs for 15 mini games (games 7 and 11 share one). Inert walls have a zero
  normal and length, so `CheckColliWallSegment` never pushes from them; they stay
  in the JSON and are left out of the GLB.

Checks:

* The grids found are the ones the USA code loads. A disassembly of USA
  `InitCollision` (`0x0C030CC4`) and `InitColliWall` (`0x0C033374`) gives Arcade
  `0x0CD5A3D8` / header `0x0C08EC40` (walls `0x0CDF6150` / `0x0C08EC60`), Original
  `0x0CDC1EC8` / `0x0C08EF28` (walls `0x0CE36B90` / `0x0C08EF48`) and the Crazy Box
  tables `0x0C0EC1B0` / `0x0C0EC1EC` and `0x0C0EC600` / `0x0C0EC63C` with headers
  from `0x0C08F1F0`; the tool finds all of them from data alone.
* Every listed item lies within 50 units of each cell holding it (half an Arcade
  or Original cell; the largest gap found is 50.0).
* Placed set objects (`extract_props.py`) against a Python port of
  `GetCollision2D` run on the Arcade and Original JSON: every object has ground
  under it, and each kind's pivot sits a fixed height above that ground (for
  example kind 5 at 7.5 and kind 9 at 2.0, the same in both cities). 514 of 527
  and 483 of 505 objects are within 0.5 units of their kind's median height, 410
  and 397 within 0.01. Two independent files agree.
* All 3 GLBs pass the Khronos `gltf-validator` with 0 errors and 0 warnings, and
  two runs give identical output. Nothing has been visually inspected.

Assumptions and limits:

* Corners need not be planar: the largest gap between a corner and its plane is
  4.4 units in Arcade (0.04 in Original). The game takes heights from the plane,
  and so should a remake.
* The ground cell's halfword at `+0x08` is kept raw; its meaning is not known.
* `InitColliWall` has a fourth case (city mode -1) whose header in the USA build
  is text, not a grid; it is not exported.
* Collision objects that move (cars, set objects, the extra boxes `InitColliWall`
  builds afterwards) are not part of these files.

## Course lines (glTF 2.0 + JSON)

```sh
python3 tools/extract_courses.py local-assets/disc --output local-assets/courses
```

This takes about 1 second and writes, per city, a GLB of line strips
(`SPLDC1.glb` Arcade, `SPLDC2.glb` Original, `SPLDC3.glb` Crazy Box with an `all`
scene and one scene per mini game) and a JSON file (`arcade.json`,
`original.json`, `crazy_box.json`) with every course's points, flags and links and
each run's course range, plus `manifest.json` and `index.html`. Positions are
world coordinates, the same space as `models/BINCn.glb`. Course 0 is white, the
courses a run uses are coloured by speed index, the rest cyan.

* **Layout.** SPLDCn holds only points (x, y, z floats), each course followed by
  its 32-bit point count. The executable holds the rest:
  * a directory of three (table, count) pairs, one per CourseMode (the decomp's
    `CourseSplineGet` / `CourseSplineNumGet` read `table + i*12` and the word its
    second pointer points to): USA `0x0C0C718C`, tables `0x0C0C4F9C` (Arcade, 290),
    `0x0C0C5D34` (Original, 328) and `0x0C0C6C94` (Crazy Box, 106);
  * 12-byte course records: points pointer, count pointer, info pointer. Original
    courses 319-327 keep their points in the executable, with their counts in a
    separate executable array;
  * 12-byte info records of six halfwords. Halfword 0 is flags: USA code at four
    sites (for example `0x0C0449BE` and `0x0C0453EE`) reads it through
    `@(8, record)`, masks it with 15 and indexes a float table with it (USA
    `0x0C0C2D64`, 7 speeds: 0.833, 1.157, 1.852, 4.167, 4.630, 6.481, 7.407).
    Halfword 1 is kept raw. Halfwords 2-5 are course numbers, named from the
    geometry they agree with (below): `next`, `branch`, `previous`, `neighbour`;
  * a stage table of 12-byte (flag, first, count) entries indexed by
    `Game_No + MiniGame_No` (`0x0C1EBF30` + `0x0C1EBF34`): USA `0x0C0C2BAC`. The
    USA routine at `0x0C048ED2` walks the entry's courses, keeps the nearest point
    to a position and copies it out, as the decomp describes `getNearLineIndexAll`. Arcade uses courses 1-282, Original 1-314,
    the 15 Crazy Box games one course each except game 9 (16-75), game 12 (76-79)
    and game 13 (80-94); games 7 and 11 share course 102, as they share a
    collision grid. These courses get the role `stage`; course 0 is `line`, the
    others `other` (Arcade 283-289, Original 315-327, Crazy Box 1-15).
* **Finding it in the USA executable.** The load address and directory are
  found together: three (table, count) pairs whose every record reads back, with
  each in-file count right after its points, for SPLDC1-3 at one shared
  sector-aligned address. That gives `0x0C328000`, which the decomp's memory map
  gives for SPLDCn. The stage table is the longest run of entries that fit the
  three tables and is referenced by a pool word; the speed table is the address
  every `and #15,r0; shll2 r0; fmov.s @(r0,Rm)` site loads into `Rm` (4 sites).
* **Result.** Arcade 290 courses, 26,883 points; Original 328, 31,500; Crazy Box
  106, 17,094. The files are covered exactly by the referenced courses except 4
  runs of 476-488 bytes in SPLDC2 that nothing points to (listed in the manifest).
  Crazy Box courses 0-5, 7-12, 14 and 15 all point at course 98's 3 points, and 6
  at course 101's.

Checks:

* Links against geometry, over each city's stage courses: `next` goes from this
  end to that start (Arcade median gap 280, at most 540; Original 250, 634),
  `previous` from that end to this start (280/540; 256/4,075), `branch` is a
  second next (61 Arcade, 60 Original), and `neighbour` is a parallel lane: from
  this course's middle point the neighbour's nearest point is a median 39.7 units
  away in Arcade (at most 66) and 51.4 in Original, and 262 of 278 / 290 of 314
  pairs name each other back.
* Points against the collision ground (`extract_collision.py` JSON and a port of
  `GetCollision2D`): all 25,712 Arcade stage points are on `#road`, median 0.0
  units above it and all within 2; 27,744 of 27,806 Original stage points are
  within 2 units (`#road` or `#high_road`). Original courses 315-318 run on
  `#sub_road`. Course 0 sits about 5 units above the Arcade road.
* All 3 GLBs pass the Khronos `gltf-validator` with 0 errors and 0 warnings, and
  two runs give identical output. Nothing has been visually inspected.

Assumptions and limits:

* `next`, `branch`, `previous` and `neighbour` are names taken from the geometry
  above, not from code that was read; the flag bits above the low nibble and
  halfword 1 are kept raw.
* The speed values' units (per frame or otherwise) are not established.
* The decomp's engine notes call 288/289 the Arcade cable-car lines; the other
  `other` courses (Arcade 283-287, Original 315-327, Crazy Box 1-15) were not
  traced to the code that uses them.
* The Arcade visibility lists the car's nearest course-0 point selects are not
  exported.

## Destination pictures (PNG)

```sh
python3 tools/extract_landmarks.py local-assets/disc --output local-assets/landmarks
```

Runs in under a second. Writes `LANDDC1/NN.png` (Arcade) and `LANDDC2/NN.png`
(Original), a manifest and an index page with each picture's name.

`LANDDC1.AFS` and `LANDDC2.AFS` each hold 40 entries of 32,768 bytes with no
header. The game streams one entry into a fixed buffer and re-uploads one sprite
texture from it. That texture is the SPRCOMM record the sprite tool lists as
`external` (texture 122: 128×128, twiddled, RGB565, buffer `0x0CE98000`). The
tool takes the format from that record and checks it two ways: its size must
equal the AFS entry size, and its buffer address must be a code literal next to
the literals naming the two LANDDC files. In the USA build those literals are at
`0x0C02E8D0`–`0x0C02E8E0`, in the loader at `0x0C02E738` (file 1 when its
argument is 0), which reads 16 sectors and re-uploads texture 122.

Names: the executable has one list of 62 destination-name pointers
(`0x0C0EC0AC`) and a pair of city bases after it (`0x0C0EC1A4`): Arcade starts at
name 0, Original at name 33. The landmark routine (`0x0C030868`) requests
picture `i`, stores `i`, and later draws `base[Game_No][i]`. So every picture is
listed with the name that formula gives.

Checks and results:

* 78 pictures; entry 35 of each file is all zeros and is listed as empty.
* Entries 0–34 of both files (70 pictures) have a 2-pixel opaque white frame
  in the decoded image. Entries 36–39 have none and may be a different kind of
  picture. Each payload has exactly 1,008 `0xFFFF` words, which is the frame's
  pixel count. A plain row-by-row decode is about twice as rough (mean
  neighbouring-pixel difference 97 vs 46) for all 78 pictures.
* Original names by the formula cover entries 0–28 exactly (29 names, ending at
  "Camping Village"). LANDDC2 entries 29–34 are byte-identical copies of LANDDC1
  29–34, so they look like filler. Arcade entries 0–33 have Arcade names.
* Two runs give identical output. No picture has been visually inspected.

Assumptions and limits:

* The customers tool traces which entry a run requests: the customer's destination
  stop number n (Arcade 0–32, Original 0–28). Entries outside those ranges are not
  requested by customers; whether anything else uses them wasn't traced.
  The two city ranges overlap at name 33 ("Big Hills Park"), and the formula
  gives LANDDC1 34 and 36–39 names from the Original part of the list.
* The AFS entry number is taken to be the picture index passed to the loader.

## Key-curve (Fcv) motions (glTF 2.0)

```sh
python3 tools/extract_fcv_motions.py local-assets/disc --output local-assets/fcv_motions
```

Runs in about 12 seconds. Writes `fcv_motions.glb` (one animation per motion),
`manifest.json` and `index.html`. The animations drive the same nodes as the
characters (`bone_0`–`bone_15`, same parents and offsets; the manifest's skeleton
equals the characters manifest's), so any clip plays on any `char_XX.glb`.

MOTDC starts with **278 Fcv motions** in bytes `0`–`0x174738`. The first V-format
motion's data starts right after them (its header is at `0x17CAB4`). Each motion
is a header `{frames, 17 word offsets}` followed by 17 curves. Each curve is three
channels of `{count, count × {int frame, value, in tangent, out tangent}}`. A
header is accepted only when its curves sit back to back right after it. In the
data, every channel has at least 2 keys and covers frames 0 to `frames − 1`. 577
of the 14,178 channels have keys out of frame order, and some start at a negative
frame.

Found in the USA files, with no regional address reused:

* **Motion table** `0x0C0CFE1C`: the longest run of executable words pointing at
  Fcv headers, using the MOTDC base `0x0C880000` from the V motions. It lists all
  278 motions in file order. The manifest also lists each motion's other
  references in the executable.
* **Solver lengths** `0x0C0D4370`: four floats followed by their squares. Arm:
  2.50798 and 2.51448; leg: 4.05096 and 4.24663.
* **Bind offsets** `0x0C0D4290`: the 13-vector table whose segment vectors match
  those lengths (head 4.4849, shoulders, hips and segments).

How a frame is built, ported from the USA code (`FcvStoreBuffer` and its curve
functions, `FcvPlayBuffer`, `fcvSolveIK` at `0x0C066DE8`, `fcvRotate`):

* **Curves.** The search takes the first key pair with `key[k].frame ≤ f <
  key[k+1].frame` and blends it by Hermite. The tangents are not scaled by the
  key gap, and `t` is clamped to 0–1. Angles are truncated to integers. If `f`
  equals `key[k+1].frame`, that key's value is used. A frame that no pair covers
  leaves the old value in place; this happens 0 times in the USA data. Frame `f`
  plays as `f mod (frames − 1)`. Each animation holds frames 0 to `frames − 2`,
  then frame 0 again.
* **Pose buffer.** The buffer holds the root position; four targets (left hand,
  right hand, left foot, right foot) in the character's own axes; and twelve
  `Rz·Ry·Rx` angle triples (`0x10000` = one turn).
* **Bones.** The root uses its angles, then a quarter turn about y. The torso
  uses its angles. The head turns a quarter turn back about z first, which puts
  its 4.4849 offset on the V tree's +x. Each arm or leg then takes:
  * its shoulder or hip angles;
  * the solver: aim +x at the target with the shortest rotation, twist about x
    by `atan2(oldY·newZ, oldZ·newZ)` back, then bend both segments about z by
    the law of cosines (a cosine outside −1…1 gives 0, which leaves the limb
    straight);
  * the hand or foot angles.

Checks (verified October 22, 2026 on the USA files):

* **Reach.** 102,527 limb poses are within reach, and every one ends within
  0.00077 of its target. 985 (under 1%, in 92 motions) are out of reach and
  point straight at the target.
* **Knee direction.** 51,330 of 51,756 knee poses (99.2%) bend toward the
  toes (the foot's +y, the direction given for the foot in the decomp's
  skeleton table). This supports the twist and bend signs.
* **Plausible poses.** In motion 4 the root is at y 5.6, the hands are at
  y 8.3–8.8, 2–3 units forward (−z), and the feet are 8.5 forward at y 3.2:
  a seated driver.
* **Validator and repeat runs.** The GLB passes `gltf-validator` with 0 errors,
  0 warnings and 278 animations; the only infos are empty leaf bone nodes. Two
  runs give identical output.

Assumptions and limits:

* Keys are spaced at a nominal 30 fps; the drivers' frame step was not traced.
* The math is done in float64 with the exact library formulas, but not with the
  SH-4's `fsca` table or its arc tangent and arc sine approximations, so angles
  can differ from the console by small amounts.
* This manifest lists only raw executable references. Which routine loads each
  motion (driver actions, customer states and others) is in the motion-use
  listing below.
* `FcvPlayBuffer`'s extra models (hats and the like) aren't drawn here. The
  characters tool already places the V draw routine's extras.
* No animation has been viewed.

## Recorded drives (JSON)

```sh
python3 tools/extract_replays.py local-assets/disc --output local-assets/replays
```

Runs in about a second. Writes `recadvac.json`, `recadvdc.json`,
`recendac.json` and `recenddc.json` (one column per field, one entry per frame),
`manifest.json` and an `index.html` that charts steering, accelerator and brake.

Each `REC*.BIN` is 108,000 bytes: **5,400 frame records of 20 bytes**. The USA
replay routine (`0x0C04AE88`; its set-up at `0x0C04ADF8` sets the frame limit to
5,400) copies one record per frame into the player's input block:

| Offset | Type | Field |
| --- | --- | --- |
| `+0x00` | f32 | steering, −1…1 (pad X through `padToAnalog`) |
| `+0x04` | f32 | accelerator, 0…1 (copied to the car's throttle) |
| `+0x08` | f32 | brake, 0…1 (copied to the car's brake) |
| `+0x0C` | u32 | buttons: `0x200000` reverse held, `0x100000` drive held, `0x20` reverse pressed, `0x10` drive pressed |
| `+0x10` | u32 | value of the game's random generator on that frame |

Field meanings come from the decomp's `padToAnalog` and car-control code (the
throttle and brake floats feed car `+0x118` and `+0x11C`; the two held bits set
reverse or drive gear). During playback the routine calls the generator and
compares the result with `+0x10`, but discards the comparison.

Found in the USA files, with no regional address reused: the executable's only
literal pool holding the four file-name pointers in a row (`0x0C02BD74`). The two
words before the loader routine's address give the buffer `0x0C30C000` and its
capacity `0x1C000`. The loader at `0x0C02BCAE` picks the Adv files when
`0x0C1EBF54` is 0 and the End files otherwise, and the AC file when the city mode
`0x0C1EBF2C` is 0 (Arcade), DC otherwise (Original). The tool labels the files
"advertise"/"ending" and Arcade/Original from that pool order.

Checks (verified October 22, 2026 on the USA files):

* **Ranges and buttons.** Every steering value is in −1…1, accelerator and
  brake in 0…1, and the only button bits are the four above. A pressed bit
  appears only on a frame where its held bit rises (10–12 reverse and 6–8 drive
  presses per file); the parser rejects anything else.
* **Random generator.** The generator is `seed = seed × 1103515245 + 12345`,
  value `(seed >> 16) & 0x7FFF` (`0x0C048AA6`), reseeded with 12345
  (`0x0C048AA0`, called from three places). Every file's frame 0 holds 21468, the
  first value after that reseed. The tool follows the generator from frame to
  frame (up to 1,024 calls) and treats 21468 as a reseed:
  * Adv/Arcade: 5,378 of 5,400 frames match, with 29 reseeds; Adv/Original:
    5,368 frames, 33 reseeds. Every unmatched frame except the last is the frame
    just before a reseed. Most frames take 20–35 calls.
  * End/Arcade: frames 0–179 match (12–17 calls per frame) and then 3,491–4,011
    after a reseed (701 frames in all). End/Original: frames 0–179 and
    3,491–5,398 (2,088). The frames in between don't follow the generator
    within 1,024 calls; why was not traced.
* Two runs give identical output.

Assumptions and limits:

* The frame rate of the recordings was not traced; 5,400 frames would be 90 s at
  60 fps or 3 minutes at 30 fps.
* Only inputs are stored. Playing a drive back needs the game's start state and
  deterministic car, traffic and customer simulation, which this project doesn't
  have. The tables `setReplayType` selects by city (`0x0C0A3600`/`0x0C0F2CF0`
  Arcade, `0x0C0B1700`/`0x0C0F2E88` Original) are decoded by the replay-cuts tool
  below. It gives the car snapshot and camera for each reseed frame.
* The roles "advertise" (attract-mode demo) and "ending" are read from the file
  names; what triggers the End files wasn't traced.

## Disc label image (PNG)

```sh
python3 tools/extract_pvr.py local-assets/disc --output local-assets/pvr
```

Decodes every stand-alone `.PVR` file in the disc directory. The USA disc has one,
`0GDTEX.PVR` (131,088 bytes), written as `0GDTEX.png` with `manifest.json` and an
`index.html` page.

Layout (decomp `model_map.pvrt_at` and `textures.decode`): an optional `GBIX`
chunk, then `PVRT`, u32 length of the rest, u8 pixel format, u8 data type, u16 0,
u16 width, u16 height and the pixels. `0GDTEX.PVR` has no `GBIX`; it is 256×256,
data type 1 (square twiddled), pixel format 2 (ARGB4444), and its length field
covers exactly the rest of the file. Pixels go through the texture tool's decoder.

Checks (verified October 22, 2026 on the USA file):

* The RGBA output is byte-identical to the decomp's `textures.decode` (SHA-256
  `75d8992d…7e6d26`).
* Its alpha forms a round label: 99.99% of pixels at radius 128 or more are
  transparent, 92.7% inside radius 120 are opaque, and the centre pixel is
  transparent (16 alpha levels in all).
* Neither `1ST_READ.BIN` nor `IP.BIN` contains the name `0GDTEX`, so the game
  code doesn't load it. Its use as the console menu's disc picture is an
  assumption, not traced. The image has not been viewed.

## Motion uses (JSON)

```sh
python3 tools/extract_motion_uses.py local-assets/disc --output local-assets/motion_uses
```

Runs in under a second. Writes `manifest.json` and an `index.html` table that
lists, for every routine, the motions it loads. It covers both MOTDC formats: the
56 V motions (named `motion_<offset>` as in the characters tool) and the 278 Fcv
motions (named `fcv_<index>_<offset>` as in the Fcv tool).

Code picks a motion with a PC-relative long load (`mov.l @(disp, PC), Rn`). The
pool word is either the motion's address (a direct use) or the address of a run of
motion addresses that the routine copies and picks from (a table use). A table
runs over consecutive motion words. It ends at the first word that isn't a
motion, or where another table that code loads begins. The tool scans every such
load in the code (below `0x0C08A000`) and files it under the routine that
contains it.

Routine names and sizes come from the decomp's `functions.txt` (EU build). The
USA code sits at a different place, shifted by an amount that changes along the
executable:

* −0xE2C for the ride lines (`Chat_*`), the driver (`Drv_*`) and the customer
  (`psg*`) code;
* −0xE30 for the mini-game and later customer routines;
* −0xF18 near the course objects;
* −0x954 near the attract states;
* −0xF00 for `nd_StartWait_PutKyaku`.

A shift is accepted only where at least 6 of the 13 decomp functions around a
name land on USA call targets or pointer words. The tool refuses to run unless
every listed start is a call target, a pointer word, or opens with a register
push. Loads outside the listed routines are kept without a name, under the nearest
routine start before them: a call target, a code pointer, or the first push of a
run. The crowd code (`ped*`) doesn't line up with the decomp's sizes, so it stays
unnamed. `group` comes from the name prefix: `psg`/`Psg`/`EndPsg` → customer,
`Drv_` → driver, `Chat_` → chat, otherwise other. In `psgEnterState0`, the five
tables are labelled from the decomp's `src/psg.c`: idle (motion set A), idle (set B),
calling out, hey taxi, and the mini game 8 boyfriend.

Each motion entry lists its uses (routine, `direct` or `table` with the table
address and slot, plus a label where one is known) and its `other_words`. These
are executable words that hold the motion's address but that no listed load or
table accounts for. They include the two all-motion tables and data records such
as the character-select table.

Results on the USA files (verified October 22, 2026):

* 354 loads and 65 tables, filed under 42 routines: 37 named and 5 unnamed.
* Code loads 275 of the 278 Fcv motions and 48 of the 56 V motions.
  * The three Fcv motions with no load (`fcv_077`, `fcv_170`, `fcv_171`) appear
    only in the Fcv motion table.
  * The eight V motions with no load are the character-select motions. Each
    appears in the all-V table and in the select records at `0x0C12F454`.
* By group:
  * Fcv: 164 customer, 136 driver, 24 chat and 24 other.
  * V: 41 customer and 29 other.
  * A motion can count in more than one group.
* `psgEnterState0` through `psgEnterState6` start at the seven addresses in the
  customer state-entry pointer table at `0x0C0D48F8`.
* Cross-check against the decomp's C: for each of the 31 named routines whose
  decomp source spells out motion addresses, every one of those motions is among
  the USA routine's loads. None are missing.
  * The five `psgEnterState0` tables equal the decomp's lists entry for entry
    (10, 6, 7, 5 and 3 motions).
  * The extras come from data tables that the C copies from templates. In
    addition, `Drv_StartGetOff` loads `fcv_276` and `fcv_277`, and
    `Exec_DCmini_Game9` loads two more motions than its decomp C names.
* Two runs give identical output.

Assumptions and limits:

* The names are the decomp's, carried over by shift. Only the 31 cross-checked
  routines and the state-entry table are confirmed beyond the entry check.
* Table extents follow the stop rule above. A table that is really an array of
  records (for example the tennis players' at `0x0C13E1D0`) is listed as one run.
  Which slot a routine picks at run time, and why, wasn't traced except where the
  decomp documents it.
* Motions reached only through computed addresses, or loaded outside the code
  range, aren't attributed.
* Group labels follow the name prefixes. They don't say who is drawn: for example,
  `Chat_Direction`'s motions may be played by the driver.

## Customers and stops (JSON)

```sh
python3 tools/extract_customers.py local-assets/disc --output local-assets/customers \
  --courses local-assets/courses --audio local-assets/audio --landmarks local-assets/landmarks
```

Runs in under a second and reads `1ST_READ.BIN`, `VOICE01.AFS` and `LANDDC1-2.AFS`
(`--courses` is optional and only feeds one check; `--audio` and `--landmarks`, the
audio and landmarks tools' output, are optional and only add links). Writes
`manifest.json` and an `index.html` with each stop's name (and picture with
`--landmarks`) and voice ids, the generic rows and the replies (linked to
`VOICE01/NNNN.wav` when `--audio` is given), then one top-view map per customer table: green stop areas
with their numbers, yellow customers.

Everything is static data in the executable, read the way these routines read it
(USA addresses; the decomp's are the EU ones):

* `kyakuInitStops` (`0x0C025640`) picks the customer table:
  * CourseMode (`0x0C1EBF2C`) 0 or 1: by ReverseMode (`0x0C17720C`, the decomp's
    name) between a normal and a reverse table;
  * CourseMode 0 with MiniGame_No (`0x0C1EBF34`) 15: a one-customer table;
  * CourseMode 2 (Crazy Box): one table per mini game 3–14 through a `braf` jump
    table at `0x0C0257A4`. Other mini games fall back to the Arcade reverse table
    read with a count of 246.
* A customer record is 40 bytes: `+0` flag, `+4` kind (−1 = unused), `+8` x, y, z,
  `+0x14` a line index, `+0x18` three signed destination stop numbers (−1 = none),
  `+0x1B` pad, `+0x1C` three floats. The routine overwrites `+0x14` (nearest point
  on the current line) and `+0x1C` (route lengths) at run time; the file values are
  kept as `line_index_in_file` and `route_lengths_in_file`.
* `kyakuTaskStart` (`0x0C024718`) asks for destination `(frame counter / 600) % 3`
  and draws the customer with character `kind_to_character[kind]` (`0x0C08A118`:
  kind k → character 23 + k, the `char_NN.glb` numbers).
* Stops are indexed `[Game_No (0x0C1EBF30)][MiniGame_No]`: counts at `0x0C0EC7C4`,
  areas at `0x0C0EC764` (per stop: point count, point pointer). As in
  `GetStopPosCenter` (`0x0C025A4C`), the centre is the mean of the area points and
  the radius is 1.2 × the farthest point's distance.
* `Chat_TellDestination` (`0x0C060490`) chooses the spoken destination: Arcade city
  `table[stop × 5 + slot]` at `0x0C0D1EE8`; Original city a fixed Arcade-table row
  for 16 stops (`original_voice_rows`) and otherwise a rotating generic table at
  `0x0C0D217C`; Crazy Box always the generic table. `slot` is bits 29–31 of
  passenger word `+0x148`. Each stop lists its five ids as `voices` (`null` =
  generic line).
* A voice id is a `VOICE01.AFS` file number, so `VOICE01/NNNN.wav` from the audio
  tool. The path: `Chat_TellDestination` writes the id as a one-step voice script
  `{id, start frame 2, length 0x7FFFFFFF}` at `0x0C13D910` and queues it on voice
  channel 2 with `Voice_Request` (`0x0C0720E8`). `Voice_ExecuteChannel`
  (`0x0C072060`) hands the step's first word to `adxStartAfs2` (`0x0C02DCFC`),
  which calls `ADXT_StartAfs` (`0x0C14F838`) with partition 2. `gdc_SetStreamAFS`
  loads partition 2 from the name `VOICE01.AFS` (`0x0C08B9BC`, 700 slots) and
  partition 1 from `SONG01.AFS`.
* Before the destination, the same routine queues a reply step on channel 1: entry
  `3 × (byte 0x0C2AA498 − 1) + (counter 0x0C13D898 mod 3)` of a 12-step table at
  `0x0C0D2A2C` (`replies`: group, variant, voice, start frame, length).
* The asked-for stop number is also the destination picture and name (`landmark`
  per stop: file, entry, name). `kyakuInitStops` fills a RAM table of 24-byte stop
  entries at `0x0C177270` whose word 0 counts from −1, so entry 1 + n holds n.
  `kyakuTaskStart` reads the signed byte at record `+0x18 + slot`, takes word 0 of
  entry 1 + that byte and passes it to the passenger set-up (`0x0C06A41E`), which
  stores it at passenger `+0x140`. `Chat_TellDestination` reads `+0x140` as the
  stop above. When the customer gets in, the passenger code copies `+0x140` to
  `0x0C0E37DC`, and the kyaku loop calls `PutLandmark` (`0x0C030868`) with it.
  `PutLandmark` requests that picture (`gdc_LandmarkReq`, `0x0C02E7F6`;
  `LANDDC1.AFS` in the Arcade city, `LANDDC2.AFS` in the Original city) and draws
  name `base[Game_No][n]` (bases at `0x0C0EC1A4`, the list the landmarks tool
  finds). Crazy Box stops get no landmark.

The table addresses are the decomp's data addresses moved by −0x1200. The tool
refuses to run unless each is the word the USA routine loads from its literal pool,
the voice-path instructions are the expected ones (start frame, channels, partition
2 in both the start and the load call, step word 0 as the id) and the partition name
is `VOICE01.AFS`, the 18 landmark-path instructions and 12 pool words above match,
each Crazy Box case label loads its table, and the 17 tables lie
back to back (`0x0C0D9E08`–`0x0C0E37A0`). Every voice id must be below the
`VOICE01.AFS` file count, and with `--audio` its WAV must exist. Every Arcade and
Original stop must have a non-empty `LANDDCn.AFS` entry and a name, and with
`--landmarks` its `LANDDCn/NN.png` must exist.

Results on the USA files (verified October 22, 2026):

* 17 customer tables, 983 records, all used (none has kind −1): Arcade 246,
  Arcade reverse 202, Original 246, Original reverse 246, the mini game 15 table 1,
  and Crazy Box games 3–14: 1, 1, 1, 1, 1, 10, 3, 8, 7, 1, 1, 7.
* Stops: Arcade 33, Original 29, Crazy Box games 3–15: 1, 1, 1, 1, 7, 5, 3, 8, 7,
  1, 1, 1, 8.
* All 2,510 destinations of tables with a stop set are below their stop count, and
  every kind is in 0–35.
* `line_index_in_file` is the nearest course-0 point (x/z) for 246/246 Arcade and
  201/202 Arcade reverse customers. It does not match for Original (1/246 and
  8/246), so its meaning there is unknown.
* 154 distinct voice ids (stop rows, generic rows and replies), all below
  `VOICE01.AFS`'s 699 files. The 12 replies all start at frame 75 with no length
  limit: groups 0–3 use files 27/2/28, 68/46/69, 128/151/129 and 112/87/113.
* All 62 stops (Arcade 33, Original 29) are named; they use all 62 names
  (Arcade 0–32, Original 33–61) and only non-empty pictures (`LANDDC1` 0–32,
  `LANDDC2` 0–28). For example, Arcade stop 0 is "Cable car stop TOP" and
  Original stop 28 "Camping Village".
* Independent cross-check: of the 16 Original stops that reuse an Arcade voice row,
  8 have the same name as that Arcade stop (Pizza Hut, FILA, Levi's, Tower Records,
  KFC, Police station, Cafeteria, Fire station). The others are the same kind of
  place: banks, parks, hotels and five stations sharing the "R.B.station" row.
* Two runs give identical output.

Assumptions and limits:

* `PutLandmark` only draws when `0x0C1EBF54` and `0x0C1EBF58` are 1; what those
  flags are wasn't traced. No picture or name was checked in the running game.
* "Reverse" is only the decomp's variable name; what the player sees for it wasn't
  checked.
* Who speaks each of the five slots wasn't traced, and what byte `0x0C2AA498`
  selects (4 reply groups; the driver is likely) wasn't traced either. No clip was
  listened to.
* The CourseMode 0 / mini game 15 table has no stop set attached: its destination
  isn't checked.
## Replay cuts (JSON)
```sh
python3 tools/extract_replay_cuts.py local-assets/disc --output local-assets/replay_cuts --customers local-assets/customers
```
Runs in under a second. Writes `manifest.json` and an `index.html` with one table
and top-view map per recorded drive. `--customers` (the customers tool's output)
is optional; it adds the stop cross-check below.
The recorded drives hold only inputs. What the game does around them is static
data in the USA executable:
* `setReplayType` (`0x0C04ADF8`) sets the frame limit to 5,400. By city mode
  (`0x0C1EBF2C`) it points `0x0C2A3F68` at a **car snapshot table** (Arcade
  `0x0C0A3600`, Original `0x0C0B1700`) and `0x0C2A3F6C` at a **point table**
  (Arcade `0x0C0F2CF0`, Original `0x0C0F2E88`).
* `replayChangeControl` (`0x0C04B794`) gets type 1 or 2 from the advertise set-up
  (`0x0C02B504`: Arcade 1, otherwise 2) and type 3 from the ending (`0x0C02CB4A`).
  Type 1 uses the **cut table** `0x0C0F18F0`, type 2 `0x0C0F1DF0`, and type 3
  `0x0C0F22F0` (Arcade) or `0x0C0F27F0` (Original). Each table has 40 rows of 32
  bytes. When the replay frame (`0x0C1EC05C`) reaches a row's frame, the game
  applies that row and moves on to the next. So only the rows before the first
  frame ≥ 5,400 are used.
* The field names come from the game's own debug printer (strings `0x0C0C2218`
  to `0x0C0C22B4`):
| Offset | Field |
| --- | --- |
| `+0x00` | frame (`frameNo`) |
| `+0x04` | camera only (`camChgOnly`); 1 = no car or passenger change |
| `+0x08` | snapshot number (`startCarNo`) |
| `+0x0C` | camera style |
| `+0x10` | character |
| `+0x14` | point number; in the ending also the passenger's destination stop |
| `+0x18`, `+0x1C` | passed on to `EndPsg_Start`; not traced |
* Snapshot n is 960 bytes at table + 960 × n. Word 0 is `carType`. The other 956
  bytes are a player car block, which the row copies over `Car_Data`
  (`0x0C176E4C`): position at `+0x78`, velocity at `+0x0C`, matrix at `+0xB4`.
* The camera style and point n go to `SetAdvCamera` (`0x0C028F8E`). Styles below 0
  or above 4 become 3. Style 0 sets camera mode 0, and −1 sets style 0 and camera
  mode 6. `ExecAdvCamera` (`0x0C028972`) runs style 1 inline, 2 as chase
  (`0x0C028ABA`), 3 as random (`0x0C028BD0`) and 4 as fixed (`0x0C028F04`).
* In the ending (`0x0C1EBF54` ≠ 0), a row whose character is 23 or more calls
  `EndPsg_Start` (`0x0C070F04`) with (character, `+0x14`, `+0x18`, `+0x1C`). That
  routine hands `+0x14` to `Psg_Init` (`0x0C06A41E`) as the passenger's
  destination stop (`+0x140`, see Customers). The tool names that stop with its
  landmark.
The tool refuses to run unless 29 pool words, 3 pool halfwords, 42 instructions
and 5 debug strings along these paths match.
Results on the USA disc (verified October 22, 2026):
* **Advertise drives.** Arcade uses 29 rows and Original 33. Every row restores a
  snapshot. The cameras are 26 random and 3 inline (Arcade) and 28 random and 5
  inline (Original). The snapshots cycle through `carType` 0–3.
* **Ending drives.** Each uses 12 rows, every 301 frames from frame 180, all with
  the fixed camera. Rows 0–10 start an ending passenger. Row 11 (frame 3,491)
  restores snapshot 59 with no passenger. For example, Arcade row 1 has character
  47 going to stop 5 ("West side beach").
* All 86 rows use non-empty snapshots with orthonormal matrices and `+0x00` =
  `+0x78`.
Checks:
* **Random reseeds.** In each advertise table the row frames are exactly the
  frames where the recorded-drives tool finds the random generator reseeded:
  29 for Arcade and 33 for Original. The tool fails if they differ. This is what
  ties type 1 to `RECADVAC` and type 2 to `RECADVDC`.
* **Stops.** With `--customers`, point n lies inside stop n's area for every stop:
  33 of 33 Arcade and 29 of 29 Original, at no more than 0.83 of the radius. The
  game's recorder (`getReplayPassenger`) writes point n from the passenger's
  spot. Points 33 (Arcade) and 29–33 (Original) are past the last stop.
* Two runs give identical output.
Assumptions and limits:
* In the ending the recorded random values don't follow the generator from frame
  180 to frame 3,490. These are exactly the 11 passenger rows (0 frames in sync).
  The tool reports this but didn't trace why.
* The meanings of `carType`, row `+0x18`/`+0x1C` and of `+0x10` in the advertise
  tables (23 or 0, which go through a separate non-ending path) were not traced.
* The snapshot table rows that aren't used (Arcade 39, 52–58 are empty; several
  Original rows repeat Arcade positions) are not exported row by row; only the
  rows a cut uses are.
* Nothing was checked in the running game.
## Sound request uses (JSON)
```sh
python3 tools/extract_sound_uses.py local-assets/disc --output local-assets/sound_uses --audio local-assets/audio
```
Runs in under a second. Writes `manifest.json` and an `index.html` with one row per
sound request. `--audio` (the audio tool's output) is optional; it links each
request's samples to their WAV files.

How the game asks for a sound (USA addresses):
* `Sound_Request(word, channel)` (`0x0C071338`; decomp `src/sound.c`) queues the
  word for one of three channels when `MainMode` (`0x0C1EBF54`) is 1.
* `Sound_Execute` (`0x0C0713E8`) hands each queued word to `0x0C07EA8C`, which
  refuses words whose low byte lacks bit 7 and otherwise writes the word unchanged
  into the driver's command ring (`0xA0800400`-`0xA0800500`).
* The driver (`AICADRV.BIN` `0x734`-`0x754`) copies the four bytes in reverse
  before decoding them. So `Sound_Request(0x000505A9, 0)` is driver request
  `0xA9050500`: id `0xA905`, sequence 5, as decoded by the audio tool.

The tool refuses to run unless 10 SH-4 instructions, 4 pool words and 9 driver
instructions along this path match (plus the audio tool's request check). It then
finds every `jsr` or tail `jmp` whose target register holds `0x0C071338`, and
walks the code backwards along every path to that call to find `r4` (word) and
`r5` (channel). It follows constants (`mov #imm`, `mov.w`/`mov.l @(disp,PC)`) and
copies (`mov Rm,Rn`); registers r0-r7 are lost across other calls. A word read
with `mov.l @(R0,Rm),Rn` from a constant address is a table: if the index comes
from an and-mask on the same straight path, the entries are exactly the masked
indices (all must be requests); otherwise the tool lists the run of consecutive
words that are requests. Literal pool words are found from the loads that read
them, repeated until stable, because pool words can themselves look like loads.
Every constant word must be a request some pack holds.

Each request also lists the decomp functions that pass its word as a constant
(`DECOMP_CALLERS`, taken from the decomp's `src/*.c`, EU build). The words don't
change between builds, so names are matched by value, not by address.

Results on the USA disc (verified October 23, 2026):
* 92 call sites: 84 `jsr` and 8 tail `jmp`. 82 pass constants (7 of them pass
  different words on different paths), 8 read tables and 2 are unresolved.
* The 8 tables: `0x0C0EC89C` and `0x0C0EC8BC` (index `& 7`, 8 entries each),
  `0x0C0A25C8` and `0x0C0A2608` (4 masked entries each), and runs at `0x0C0A2478`
  and `0x0C0A25E8` (7), `0x0C12EC84` (16) and `0x0C13DA58` (5).
* 84 of the 102 requests are reached (53 by a constant). The 18 others: the
  control-only `0xA8000000`, `0xA9000B00`-`0xA9000D00`, seven of id `0xA904`,
  `0xA9050300`, `0xA9080000`, `0xA9080200` and `0xA90B0100`-`0xA90B0400`.
* Channels: 0 on 77 calls, 1 on 17, 2 on 6, one unknown (`0x0C060F40`, after a
  call).
* All 45 constant words in the decomp's C are found in the USA code. Eight USA
  words are not constants in the decomp's C (`0x00CA9`, `0x00FA9`, `0x011A9`,
  `0x111A9`, `0x30FA9`, `0x310A9`, `0x401A9`, `0x410A9`); there the decomp computes
  the word or the USA code differs.
* What the decomp names suggest: `0xA900` (SNDDC0) results-screen titles; `0xA904`
  HUD drums, time and ranking; `0xA905` (SNDDC1) timer, fare, arrow and results
  digits; `0xA90A` (SNDDC7) the train; `0xA90B` the gear box; `0xA90C` (SNDDC1)
  effects; `0xA90F` (SNDDC5) Crazy Box games; `0xA911` (SNDDC6) course objects and
  the helicopter; `0xA909`/`0xA903` passengers (channel 2). These are function
  names, not verified sound names.
* Two runs give identical manifests apart from the WAV link paths.

Limits:
* The 2 unresolved sites read the word from an object (`0x0C036F1C`) or from a
  table chosen at run time (`0x0C04500A`); run tables may list entries the index
  never reaches.
* Function names are only attached through the decomp's constants; USA call sites
  are listed by address, not by routine.
* Nothing was checked in the running game.
## Tests and web build

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
npm run build
```

The 196 synthetic tests include 6 CHD tests (synthetic v5 images with `cdlz`,
`cdzl`, uncompressed, `cdfl` constant/fixed/verbatim and RLE-coded self hunks;
vectorised P/Q ECC against the per-byte loop for mode 1 and 2; canonical Huffman
import and rejection; PAD trimming, audio byte swap, one-track output and raw SHA-1
check; refusals of non-CHD, v4 and parent images; map and hunk CRC corruption), 11 disc-extractor tests for nested directories,
sector padding, partial final sectors, empty files, manifest hashes, no overwrite,
invalid descriptors, endian disagreement, out-of-track extents, cycles, unsafe
names, duplicates, multi-extent rejection, malformed records, truncated tracks,
invalid sector mode and cleanup. The 15 texture tests cover every pixel/layout
pair, twiddling, rectangular tiles, VQ, mip offsets, table aliases/alignment,
ambiguous or malformed tables, payload sizes, PNG CRCs/scanlines, manifest/gallery,
no overwrite and cleanup. The 10 model tests cover strip winding, triangle lists
with references, vertex-colour records, repaired attributes, malformed models,
record chaining, GLB chunks/materials/samplers, manifest output, decal-alpha
baking in single and city GLBs (counts, pruning, embedded pixels), no overwrite and
cleanup. The 20 audio tests cover ADX coefficients, scale bias, prediction,
stereo interleave, clamping, loop points, malformed streams, AFS tables, DTPK
register decoding and validation, PCM8/PCM16/AICA ADPCM, the FNS table, playback
pitch, the driver instruction check, split pitch registers, clamping and curve
segments, instrument program/split layout and rejection, split rate sources, the
request-path driver check, script and track event streams (running status,
two-byte delays), request groups, track lists, bad ids, missing definitions, a
missing end, looping jumps, velocity ranges, request links, duplicate ids, WAV
output, no overwrite and cleanup. The 9 sprite tests cover 4-bit nibble order and selectors, 8-bit
banks and rectangular twiddling, unloaded palette entries, SH-4 delay slots,
pool constants and forward branches, terminated tables with external records,
texture-number pairs, PNG/manifest output and no overwrite. The 12 character tests
run a hand-assembled draw routine symbolically (pool loads, delay slots, `cmp/eq`
branches on the character, a `braf` jump table, unresolved-branch rejection),
identify its primitives, build the bone tree, reject unbalanced matrix stacks, and
cover base/table/motion/select-table discovery, quaternions, world positions,
looping animation output and no overwrite. The 9 vehicle tests cover traffic-table
runs, names, colour tables, model-file ownership (including ambiguity), putCarModel
wheel/mirror/level rules, cab-table discovery and set lengths, multi-scene GLBs
with shared meshes, decal-alpha baking and PNG reading, intensity mode 2 records
taking the last mode 1 face colour, and paint variants on body meshes only with
unused materials pruned. The 6 set-object tests cover record chains and their
rejection (count mismatch, pointers past the loaded bytes, empty files), the
load-address search, the kind table and spheres, the exact-length model table and
array bounds, and the Y-then-X rotation against the SH-4 matrices. The 10
collision tests cover shortest exact float text, header consistency, the kind
table, wall ends against `CheckColliWallSegment`, ground grids (shifted or
rescaled headers, surfaces outside their cell, items missing from their cell),
inert walls, winding, the largest-grid rule and a full extraction with shared
Crazy Box games. The 7 course-line tests cover counts that must follow their
points, executable-resident points, the directory and shared load address
(rejecting a shifted file), the longest stage-table run, the speed table from the
masked-index code, link statistics and a full extraction with shared points,
unreferenced bytes and per-game scenes. The 5 destination-picture tests cover the
streamed sprite record and its literal-pool check, the name list and city bases,
the white frame and a full extraction with empty, unframed and shared entries.
The 14 Fcv motion tests cover Hermite basis and tangents, signed truncated
angles, the game's key search (out-of-order keys, uncovered frames keeping the
old value), back-to-back motion discovery and gap rejection, the motion table's
order check, solver lengths and bind table, the bone tree, rotation order and the
head quarter turn, IK reach, out-of-reach limbs, looping and a full extraction.
The 8 recorded-drive tests cover field columns, range, unknown-bit and
press-without-rising-edge rejection, the loader pool (order, capacity), generator
continuations, reseeds, lost state and the call limit, and a full extraction.
The 7 PVR tests cover header fields, the `GBIX` prefix, length and reserved-byte
rejection, twiddled pixels and a full extraction with no overwrite.
The 7 motion-use tests cover pool-load decoding, table extents (non-motion words
and other table starts), routine starts from push runs, the entry check, the
function table's order, prefix groups and a full extraction with labelled tables,
data-only words, no overwrite and a rejected entry.
The 15 customer tests cover the literal-pool check (rejecting a moved table), the
Crazy Box jump table, back-to-back tables, stop centre and radius, the 40-byte
record, voice rows per city, the voice-path instruction and partition-name checks,
the reply steps, voice ids beyond the AFS file count, audio links and a missing
WAV, the landmark-path checks, stop names from the city bases, stop pictures (a
missing PNG and an empty AFS entry), an out-of-range destination and a deterministic full extraction with the
line-index check and no overwrite.
The 10 replay-cut tests cover the pool, instruction and debug-string checks, the
reseed-frame match, row order and the end row, empty and non-car snapshots, stop
and point ranges, the customer-stop cross-check and a deterministic full extraction.
The 7 sound-use tests cover the byte reversal, written registers, call sites with
constants, per-path words, words lost across a call, masked and run tables,
unresolved and tail-jump sites, non-request table words, pool words that look
like loads, the code checks and a full extraction with decomp callers and WAV links.
The 8 one-command tests cover step order against the cross-links, the sibling
folders each step is given, a disc-folder run with its manifest and page, cleanup
after a failed step, refused sources and outputs, a `.bin` source through the disc
extractor, a `.chd` source decompressing only track 3, and picking only Track 3
from an archive.
No disc image is required.
The Python tests are invoked separately; `npm test` does not run them.
