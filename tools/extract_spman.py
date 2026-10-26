#!/usr/bin/env python3
"""The mod's SPMAN: Spider-Man 2000's own Spider-Man (spidey.PSX) for the Y driver.

Reads the character the sibling sp1 project exports (sp1/web/generated/spidey.json, its
frames.bin and PNG textures: tools/character.py there) and writes
local-assets/characters/spman/ (spman.json and the PNGs) for src/spman.js, which skins it
onto a Crazy Taxi figure's bones.

Every corner is posed once with the reference frame, anim 132 frame 0 (his straight
standing pose: legs and arms down), so the positions are PSX world units (x the
figure's left, y down, z backward). `parts` names the part whose matrix posed each corner
(the joint seams take the neighbouring part's). `joints` is each part's origin in the
same frame. Parts 5 and 10 (the alternate hand models: sp1 hides them the same way,
CRudeWordHitterSpidey's mask 0x420) are left out. Stdlib only.
"""
import argparse
import array
import json
import shutil
from pathlib import Path

REF_ANIM, REF_FRAME = 132, 0
HIDDEN = {5, 10}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--sp1', default='../sp1/web/generated', help='sp1 web/generated folder')
    ap.add_argument('--output', default='local-assets/characters/spman')
    a = ap.parse_args()
    src = Path(a.sp1)
    data = json.loads((src / 'spidey.json').read_text())
    assert data['schema'] == 'sp1.psx-character.v1', data['schema']
    frames = array.array('h', (src / data['frames_file']).read_bytes())
    n = data['parts']
    base = (data['anims'][REF_ANIM]['start'] + REF_FRAME) * n * 12
    mats = [frames[base + p * 12: base + p * 12 + 12] for p in range(n)]

    positions, uvs, parts, groups = [], [], [], []
    for model in data['models']:
        if model['index'] in HIDDEN:
            continue
        at = len(parts)
        ps = model['positions']
        for i, p in enumerate(model['parts']):
            m = mats[p]
            x, y, z = ps[3 * i: 3 * i + 3]
            positions += [round((m[0] * x + m[1] * y + m[2] * z) / 4096 + m[9]),
                          round((m[3] * x + m[4] * y + m[5] * z) / 4096 + m[10]),
                          round((m[6] * x + m[7] * y + m[8] * z) / 4096 + m[11])]
            parts.append(p)
        uvs += [round(u, 5) for u in model['uvs']]
        groups += [{'start': at + g['start'], 'count': g['count'], 'texture': g['texture']} for g in model['groups']]

    out = Path(a.output)
    out.mkdir(parents=True, exist_ok=True)
    textures = []
    for t in data['textures']:
        name = Path(t['file']).name
        shutil.copyfile(src / t['file'], out / name)
        textures.append({'file': name, 'alpha': t['alpha']})
    (out / 'spman.json').write_text(json.dumps({
        'schema': 'spman.v1', 'source': data['name'], 'ref': [REF_ANIM, REF_FRAME],
        'hierarchy': data['hierarchy'], 'joints': [list(m[9:12]) for m in mats],
        'textures': textures, 'groups': groups, 'parts': parts, 'positions': positions, 'uvs': uvs,
    }, separators=(',', ':')))
    print(f'{out}: {len(parts)} corners, {len(groups)} groups, {len(textures)} textures')


if __name__ == '__main__':
    main()
