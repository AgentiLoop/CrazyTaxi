# Local Crazy Taxi disc extraction

Game data stays under ignored `local-assets/`; do not commit or publish it. The
extractor uses only Python's standard library. It reads the raw high-density
MODE1/2352 track, not the `.7z` or `.chd` container directly.

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
The `.chd` is not needed for this verified route and remains unchanged.

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
GDI layouts, cooked sectors, CHD decompression, interleaved or multi-extent files.

**The disc extractor recovers original containers.** The texture conversion below
now exports the four TEXDC banks and the model conversion exports POLDC/BINC
geometry, the audio conversion exports ADX and DTPK sounds, and the sprite
conversion exports the SPR banks; motion remains undecoded.
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
image URI resolved, and reported 0 errors and 0 warnings. Not yet exported: character
skeleton assembly, traffic car part sets, motion, and placing POLDC1–3 props.

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
  first, step 127). A pack does not store a sample rate (the program's pitch sets
  it), so each WAV uses a nominal 22,050 Hz.

Verified October 22, 2026 on the USA files: **798 sounds**. They are SONG01 9
stereo 44.1 kHz tracks (621.8 s; tracks 0 and 8 loop), VOICE01 699 mono 22.05 kHz
clips (1,034.7 s), and 90 DTPK samples (SNDDC0 41, SNDDC1 20, SNDDC2 2, SNDDC3 3,
SNDDC5 4, SNDDC6 7, SNDDC7 8, SNDDC8 5; 38 ADPCM, 38 PCM16, 14 PCM8). Two
independent checks against ffmpeg 8 passed:

* All 708 ADX streams decoded with `scale_bias=0` match ffmpeg's `adx` decoder
  sample-for-sample. ffmpeg leaves out the game's `+ 1` and pads the last block.
* All 38 ADPCM samples match ffmpeg's `adpcm_aica` decoder sample-for-sample.

All 798 WAVs open in `ffprobe` without errors. Clamping to 16 bits affects 718
music samples and 215 voice samples. Not yet done: DTPK programs/sequences (pitch,
envelopes and which sample each sound effect plays).

## Sprite conversion (PNG)

```sh
python3 tools/extract_sprites.py local-assets/disc --output local-assets/sprites
```

The `SPR*.BIN` files are headerless texture data. Each one's 16-byte texture records are in
`1ST_READ.BIN` as a run ended by an all-`0xFF` record. The run whose packed size
equals the file's size is its table. Records pointing outside the file (one
128×128 render target in SPRCOMM) are listed as `external` with no PNG.

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

## Tests and web build

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
npm run build
```

The 54 synthetic tests include 11 disc-extractor tests for nested directories,
sector padding, partial final sectors, empty files, manifest hashes, no overwrite,
invalid descriptors, endian disagreement, out-of-track extents, cycles, unsafe
names, duplicates, multi-extent rejection, malformed records, truncated tracks,
invalid sector mode and cleanup. The 15 texture tests cover every pixel/layout
pair, twiddling, rectangular tiles, VQ, mip offsets, table aliases/alignment,
ambiguous or malformed tables, payload sizes, PNG CRCs/scanlines, manifest/gallery,
no overwrite and cleanup. The 9 model tests cover strip winding, triangle lists
with references, vertex-colour records, repaired attributes, malformed models,
record chaining, GLB chunks/materials/samplers, manifest output, no overwrite and
cleanup. The 10 audio tests cover ADX coefficients, scale bias, prediction,
stereo interleave, clamping, loop points, malformed streams, AFS tables, DTPK
register decoding and validation, PCM8/PCM16/AICA ADPCM, WAV output, no overwrite
and cleanup. The 9 sprite tests cover 4-bit nibble order and selectors, 8-bit
banks and rectangular twiddling, unloaded palette entries, SH-4 delay slots,
pool constants and forward branches, terminated tables with external records,
texture-number pairs, PNG/manifest output and no overwrite. No disc image is required.
The Python tests are invoked separately; `npm test` does not run them.
