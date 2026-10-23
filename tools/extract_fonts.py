#!/usr/bin/env python3
"""Extract the four pfSetFont bitmap fonts from 1ST_READ.BIN and SPR*.BIN.

Stdlib only. Finds the font descriptor arrays and UV tables by their structure,
then decodes the original sprite textures. Outputs atlases, upright glyph PNGs,
metrics and a local preview. Does not convert bitmap artwork into vector fonts.
Reference: supplied decomp src/gen_ae.c (pfSetFont), gen_ic.c (pfPutc),
small_a.c (pfLength). No regional addresses or game bytes are embedded here.
"""
import argparse
import html
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_sprites import (LOAD, PALETTE_TYPES, discover_tables, texture_numbers,
                                       recover_loads, palette_ram, decode_palettised)
    from tools.extract_textures import decode, digest, png_bytes
except ImportError:
    from extract_sprites import (LOAD, PALETTE_TYPES, discover_tables, texture_numbers,
                                 recover_loads, palette_ram, decode_palettised)
    from extract_textures import decode, digest, png_bytes


# pfPutc uses eight 1/8-height rows, two half-height rows, and a quarter-height logo.
V_TOP = (1, .875, .75, .625, .5, .375, .25, .125, 1, .5, .25)
V_BOTTOM = (.875, .75, .625, .5, .375, .25, .125, 0, .5, 0, 0)


def discover_fonts(executable, textures):
    """Locate four parallel arrays: texture ids, TSP size bits, metrics, U scales, heights."""
    candidates = []
    for at in range(0, len(executable) - 79, 4):
        ids = struct.unpack_from('<4I', executable, at)
        if len(set(ids)) != 4 or not all(i in textures for i in ids):
            continue
        flags = struct.unpack_from('<4I', executable, at + 16)
        pointers = struct.unpack_from('<4I', executable, at + 32)
        scales = struct.unpack_from('<4f', executable, at + 48)
        heights = struct.unpack_from('<4f', executable, at + 64)
        fonts = []
        for i, number in enumerate(ids):
            texture = textures[number]
            width, height = texture['width'], texture['height']
            expected = (int(math.log2(width)) - 3) << 3 | (int(math.log2(height)) - 3)
            offset = pointers[i] - LOAD
            if flags[i] != expected or scales[i] != 1 / width or not 0 < heights[i] <= height \
                    or not 0 <= offset <= len(executable) - 96 * 16:
                break
            glyphs = []
            for code in range(32, 128):
                x, w, row, reserved = struct.unpack_from('<ffII', executable, offset + (code - 32) * 16)
                if not math.isfinite(x) or not math.isfinite(w) or x != int(x) or w != int(w) \
                        or x < -1 or not 1 <= w <= width or row >= len(V_TOP) or reserved:
                    break
                if x >= 0 and x + w > width:
                    break
                glyphs.append(dict(code=code, character=chr(code) if code < 127 else None,
                                   x=int(x), width=int(w), row=row, advance=w - 1,
                                   drawable=x >= 0, uv=[x / width, V_TOP[row],
                                                       (x + w) / width, V_BOTTOM[row]] if x >= 0 else None))
            if len(glyphs) != 96 or sum(g['drawable'] for g in glyphs) < 64:
                break
            fonts.append(dict(id=i, texture_number=number, metrics_address=pointers[i],
                              tsp_size_bits=flags[i], u_scale=scales[i], height=heights[i], glyphs=glyphs))
        if len(fonts) == 4:
            candidates.append((LOAD + at, fonts))
    if len(candidates) != 1:
        raise ValueError('expected one four-font descriptor table, found %d' % len(candidates))
    needle = struct.pack('<22f', *(V_TOP + V_BOTTOM))
    hits = [at for at in range(0, len(executable) - len(needle) + 1, 4)
            if executable[at:at + len(needle)] == needle]
    if len(hits) != 1:
        raise ValueError('expected one font V-coordinate table, found %d' % len(hits))
    address, fonts = candidates[0]
    return address, LOAD + hits[0], fonts


def crop_glyph(rgba, width, height, glyph):
    """pfPutc's top vertex samples the larger V: reverse source rows for upright PNGs."""
    x, w = glyph['x'], glyph['width']
    if not glyph['drawable'] or x < 0 or w < 1 or x + w > width:
        raise ValueError('glyph has no valid drawable rectangle')
    top = round(V_TOP[glyph['row']] * height)
    bottom = round(V_BOTTOM[glyph['row']] * height)
    if len(rgba) != width * height * 4 or not 0 <= bottom < top <= height:
        raise ValueError('invalid atlas or glyph bounds')
    return w, top - bottom, b''.join(rgba[(y * width + x) * 4:(y * width + x + w) * 4]
                                    for y in range(top - 1, bottom - 1, -1))


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError('output already exists')
    executable = (source / '1ST_READ.BIN').read_bytes()
    files = {p.name: p.read_bytes() for p in sorted(source.glob('SPR*.BIN'))}
    if not files:
        raise ValueError('no SPR*.BIN files in source')
    tables = discover_tables(executable, {n: len(b) for n, b in files.items()})
    numbers = texture_numbers(executable, tables)
    textures = {numbers[name] + index: dict(entry, bank=name, index=index)
                for name, table in tables.items() for index, entry in enumerate(table['entries'])
                if not entry['external']}
    address, v_address, fonts = discover_fonts(executable, textures)
    selectors, uploads = recover_loads(executable, tables)
    ram = palette_ram(executable, uploads)
    manifest = dict(schema=1, executable=dict(path='1ST_READ.BIN', sha256=digest(executable)),
                    descriptor_address=address, v_table_address=v_address,
                    v_top=V_TOP, v_bottom=V_BOTTOM, fonts=fonts,
                    notes=['Bitmap fonts, not TTF/OTF.', 'Codes 32..127; 127 is a special slot, not a Unicode glyph.',
                           'Negative x means advance only; advance is width - 1 before runtime scaling.',
                           'Atlas keeps source orientation; glyph PNGs reverse V as pfPutc does.',
                           'Runtime tint, scaling, aspect ratio and filtering are not baked in.'])
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.fonts-', dir=output.parent))
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi bitmap fonts</title>',
            '<style>body{background:#222;color:#fff;font-family:system-ui}figure{display:inline-block;'
            'vertical-align:top;margin:8px}img{image-rendering:pixelated}figcaption{font-size:12px}'
            '.sample{display:flex;align-items:flex-start;margin:16px 0}</style>',
            '<h1>Extracted bitmap fonts</h1><p>Original pixels, upright glyphs. '
            'Code 127 is a special game slot. Spaces and unsupported slots advance without drawing.</p>']
    try:
        for font in fonts:
            folder = staging / ('font_%d' % font['id'])
            folder.mkdir()
            t = textures[font['texture_number']]
            data = files[t['bank']]
            payload = data[t['offset']:t['offset'] + t['size']]
            selector = struct.unpack_from('<I', executable, selectors[t['bank']] - LOAD + t['index'] * 4)[0] \
                if selectors[t['bank']] else 0
            rgba = decode_palettised(payload, t['width'], t['height'], t['data_type'], selector, ram) \
                if t['data_type'] in PALETTE_TYPES else decode(payload, t['width'], t['height'],
                                                            t['data_type'], t['pixel_format'])
            atlas = png_bytes(t['width'], t['height'], rgba)
            (folder / 'atlas.png').write_bytes(atlas)
            font.update(source=dict(bank=t['bank'], bank_sha256=digest(data), index=t['index'],
                                    offset=t['offset'], size=t['size'], data_type=t['data_type'],
                                    pixel_format=t['pixel_format'], palette_selector=selector,
                                    payload_sha256=digest(payload)),
                        atlas=dict(png=folder.name + '/atlas.png', width=t['width'], height=t['height'],
                                   png_sha256=digest(atlas), rgba_sha256=digest(rgba)))
            page.append('<h2>Font %d — texture %d, height %g</h2>' %
                        (font['id'], font['texture_number'], font['height']))
            for glyph in font['glyphs']:
                if not glyph['drawable']:
                    continue
                w, h, pixels = crop_glyph(rgba, t['width'], t['height'], glyph)
                png = png_bytes(w, h, pixels)
                relative = '%s/%03d.png' % (folder.name, glyph['code'])
                (staging / relative).write_bytes(png)
                glyph.update(png=relative, height=h, png_sha256=digest(png), rgba_sha256=digest(pixels))
                page.append('<figure><img src="%s"><figcaption>%d %s</figcaption></figure>' %
                            (relative, glyph['code'], html.escape(glyph['character'] or '(special)')))
            page.append('<div class="sample">')
            for char in 'Crazy Taxi! ABC xyz 0123456789 $99.99':
                glyph = font['glyphs'][ord(char) - 32]
                page.append('<img src="%s" style="margin-right:-1px">' % glyph['png'] if glyph['drawable']
                            else '<span style="width:%gpx"></span>' % glyph['advance'])
            page.append('</div>')
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (staging / 'index.html').write_text('\n'.join(page) + '\n')
        if output.exists():
            raise ValueError('output already exists')
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='extracted disc directory')
    parser.add_argument('--output', required=True, type=Path, help='new local output directory')
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, 'error: %s\n' % error)
    print('Extracted %d fonts, %d glyph PNGs into %s' %
          (len(manifest['fonts']), sum(g['drawable'] for f in manifest['fonts'] for g in f['glyphs']), args.output))


if __name__ == '__main__':
    main()
