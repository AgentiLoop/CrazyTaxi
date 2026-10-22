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
now exports the four TEXDC banks; models, sprite banks and audio remain undecoded.
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
chunk CRC and decompressed scanline matched. Model-to-texture binding is not yet exported.

## Tests and web build

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
npm run build
```

The 26 synthetic tests include 11 disc-extractor tests for nested directories,
sector padding, partial final sectors, empty files, manifest hashes, no overwrite,
invalid descriptors, endian disagreement, out-of-track extents, cycles, unsafe
names, duplicates, multi-extent rejection, malformed records, truncated tracks,
invalid sector mode and cleanup. The 15 texture tests cover every pixel/layout
pair, twiddling, rectangular tiles, VQ, mip offsets, table aliases/alignment,
ambiguous or malformed tables, payload sizes, PNG CRCs/scanlines, manifest/gallery,
no overwrite and cleanup. No disc image is required.
The Python tests are invoked separately; `npm test` does not run them.
