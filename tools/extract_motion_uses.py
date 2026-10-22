#!/usr/bin/env python3
"""List which game routines play each MOTDC motion: customers, cab drivers, the crowd and others.

MOTDC holds two motion formats (extract_characters.py: V-format, extract_fcv_motions.py: Fcv).
Code picks a motion by loading its address from a literal pool (`mov.l @(disp, PC), Rn`), either
the motion itself or a table of motion addresses that the routine copies and picks from. This
tool scans the USA executable for every such load and files it under the routine it sits in:

* A load whose pool word is a motion address is a direct use.
* A load whose pool word points at a run of motion addresses is a table use. The table runs from
  that address over consecutive motion words, up to the first word that is not a motion or the
  start of another table some code loads.

Routine names and extents come from the supplied decomp's functions.txt (EU build), moved to the
USA build by local shifts (FUNCTIONS below). Each entry is checked in the USA executable: its
start must be a call target, appear as a pointer word (the customers' state entries are reached
through a pointer table) or open with a register push (mov.l r14,@-r15 or sts.l pr,@-r15). Loads in game code outside every listed routine are
kept with no name. The decomp's state-0 sources name the five tables psgEnterState0 picks a
waiting customer's motion from (TABLE_LABELS); other tables are listed by address.

Stdlib only; no upstream imports.
"""
import argparse
import html
import json
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools.extract_characters import call_targets, find_motions
    from tools.extract_fcv_motions import find_fcv_motions
    from tools.extract_models import digest
except ImportError:  # run as a script from the tools directory
    from extract_characters import call_targets, find_motions
    from extract_fcv_motions import find_fcv_motions
    from extract_models import digest

LOAD = 0x0C010000
CODE_END = 0x0C08A000  # end of the executable's code (game code, then the library)
# (USA start, size in bytes, decomp name): decomp functions.txt address moved by the local shift
# (-0x954 near the attract states, -0xF18 near the course objects, -0xE30 in the mini games and the
# late customer code, -0xE2C in the chat, driver and customer code). A shift is accepted where at
# least 6 of the 13 decomp functions around the name land on USA call targets or pointer words.
# The code between (the crowd, ped*, and the nd_StartWait_* routines) differs in size from the
# decomp's and is left unnamed, except nd_StartWait_PutKyaku (-0xF00): a routine start there loads
# the same two motions the decomp's C does.
FUNCTIONS = (
    (0x0C02B326, 292, "AdvStateLogo"),
    (0x0C04DED8, 286, "Put_Transporter"),
    (0x0C04E078, 166, "Put_Course_Obj_Fcv"),
    (0x0C04F852, 704, "nd_StartWait_PutKyaku"),
    (0x0C05C45E, 516, "Exec_DCmini_Game9"),
    (0x0C05C6CC, 90, "Put_PoleMarriageKiss"),
    (0x0C05FDD8, 248, "Act_Init"),
    (0x0C06010C, 874, "Chat_Getoff"),
    (0x0C060704, 938, "Chat_Direction"),
    (0x0C061088, 420, "Drv_Init"),
    (0x0C0612A2, 44, "Drv_StartDrive"),
    (0x0C06132C, 42, "Drv_StartReverse"),
    (0x0C061374, 1518, "Drv_StartGetOn"),
    (0x0C061962, 82, "Drv_StartSeated"),
    (0x0C0619F8, 1282, "Drv_StartGetOff"),
    (0x0C061EFA, 70, "Drv_StartPickUp"),
    (0x0C061F78, 206, "Drv_StartReady"),
    (0x0C062074, 190, "Drv_StartPsgReact"),
    (0x0C062132, 38, "Drv_StartChoin"),
    (0x0C062158, 40, "Drv_StartHorn"),
    (0x0C062768, 360, "Drv_ExecGetOff"),
    (0x0C063CE2, 208, "camGetOffSelect"),
    (0x0C06A394, 12, "PatchMotion"),
    (0x0C06A41E, 682, "Psg_Init"),
    (0x0C06A758, 374, "psgEnterState0"),
    (0x0C06A8F8, 684, "psgEnterState1"),
    (0x0C06ABA4, 1072, "psgEnterState2"),
    (0x0C06AFFC, 2746, "psgEnterState3"),
    (0x0C06BAD8, 3386, "psgEnterState4"),
    (0x0C06C812, 410, "psgEnterState5"),
    (0x0C06C9AC, 426, "psgEnterState6"),
    (0x0C06D5F4, 1022, "psgFrameState1"),
    (0x0C06DE84, 1508, "psgFrameState3"),
    (0x0C06EF40, 2364, "psgFrameState4"),
    (0x0C070F88, 88, "EndPsg_ClearIpBuff"),
    (0x0C071518, 172, "DrawTennisPlayers"),
    (0x0C07160C, 198, "HesLate"),
    (0x0C0718DC, 322, "breathMove"),
)
# Name prefix -> who the routine animates (decomp naming: psg = passenger, Drv = cab driver,
# Chat = the ride's spoken lines).
GROUPS = (("psg", "customer"), ("Psg", "customer"), ("EndPsg", "customer"), ("Drv_", "driver"),
          ("Chat_", "chat"))
# psgEnterState0's tables in load order (decomp src/psg.c): which list a waiting customer's
# motion is drawn from.
TABLE_LABELS = {"psgEnterState0": ("idle, motion set A", "idle, motion set B", "calling out",
                                   "hey taxi", "mini game 8 boyfriend")}


def group(name):
    for prefix, label in GROUPS:
        if name and name.startswith(prefix):
            return label
    return "other"


def pool_loads(executable, end=CODE_END):
    """(instruction address, pool address, pool word) of every PC-relative long load before `end`."""
    out = []
    for at in range(0, min(len(executable), end - LOAD) - 1, 2):
        op = struct.unpack_from("<H", executable, at)[0]
        if op >> 12 != 0xD:
            continue
        pool = ((LOAD + at) & ~3) + 4 + (op & 255) * 4
        if pool - LOAD <= len(executable) - 4:
            out.append((LOAD + at, pool, struct.unpack_from("<I", executable, pool - LOAD)[0]))
    return out


def word_at(executable, address):
    if LOAD <= address and address - LOAD <= len(executable) - 4 and address % 4 == 0:
        return struct.unpack_from("<I", executable, address - LOAD)[0]
    return None


PUSHES = (0x2FE6, 0x4F22)  # mov.l r14,@-r15; sts.l pr,@-r15


def find_uses(executable, motions, functions=FUNCTIONS):
    """Direct and table uses of the motion addresses in `motions`, filed under `functions`; a use
    outside them gets the nearest routine start at or before it, with no name: a call target, a code
    pointer or the first of a run of register pushes."""
    loads = pool_loads(executable)
    starts = set(w for _, _, w in loads if w not in motions and word_at(executable, w) in motions)
    pointers = struct.unpack_from("<%dI" % (len(executable) // 4), executable)
    entries = set(call_targets(executable)) | set(w for w in pointers if LOAD <= w < CODE_END and w % 2 == 0)
    ops = struct.unpack_from("<%dH" % ((min(len(executable), CODE_END - LOAD)) // 2), executable)
    entries.update(LOAD + 2 * i for i, op in enumerate(ops)
                   if op in PUSHES and (i == 0 or ops[i - 1] & 0xFF0F not in (0x2F06, 0x4F02)))
    entries = sorted(entries)
    tables = {}
    for start in sorted(starts):
        members, at = [], start
        while word_at(executable, at) in motions and (at == start or at not in starts):
            members.append(word_at(executable, at))
            at += 4
        tables[start] = members
    uses = []
    for site, pool, word in loads:
        if word not in motions and word not in tables:
            continue
        owner = next((f for f in functions if f[0] <= site < f[0] + f[1]), None)
        if owner is None:
            before = [e for e in entries if e <= site]
            owner = (before[-1] if before else None, 0, None)
        uses.append(dict(site=site, pool=pool, function=owner[2], function_address=owner[0],
                         motion=word if word in motions else None,
                         table=word if word in tables else None))
    return uses, tables


def confirm_entries(executable, functions=FUNCTIONS):
    """Names whose start is not a call target, a pointer word or a register push."""
    targets = set(call_targets(executable))
    pointers = set(struct.unpack_from("<%dI" % (len(executable) // 4), executable))
    return [name for start, _, name in functions if start not in targets and start not in pointers
            and struct.unpack_from("<H", executable, start - LOAD)[0] not in PUSHES]


def discover(source):
    executable = (source / "1ST_READ.BIN").read_bytes()
    motdc = (source / "MOTDC.BIN").read_bytes()
    base, v_motions = find_motions(motdc)
    fcv, _ = find_fcv_motions(motdc)
    motions = {}
    for offset, frames in sorted(v_motions):
        motions[base + offset] = dict(format="V", name="motion_%06x" % offset, offset=offset, frames=frames)
    for index, (offset, frames, _) in enumerate(fcv):
        motions[base + offset] = dict(format="Fcv", name="fcv_%03d_%06x" % (index, offset), offset=offset,
                                      frames=frames)
    uses, tables = find_uses(executable, motions)
    return dict(executable=executable, motdc=motdc, base=base, motions=motions, uses=uses, tables=tables,
                unconfirmed=confirm_entries(executable))


def extract(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    found = discover(source)
    if found["unconfirmed"]:
        raise ValueError("routine entries not found in the executable: " + ", ".join(found["unconfirmed"]))
    executable, motions, uses, tables = (found[k] for k in ("executable", "motions", "uses", "tables"))
    names = dict((a, m["name"]) for a, m in motions.items())
    routines = {}
    for use in uses:
        key = use["function"] or "unnamed_%08x" % use["function_address"]
        entry = routines.setdefault(key, dict(
            function=use["function"], address=use["function_address"], group=group(use["function"]),
            sites=[], motions=[], tables=[]))
        entry["sites"].append(use["site"])
        if use["motion"] is not None and names[use["motion"]] not in entry["motions"]:
            entry["motions"].append(names[use["motion"]])
        if use["table"] is not None and use["table"] not in [t["address"] for t in entry["tables"]]:
            entry["tables"].append(dict(address=use["table"], motions=[names[a] for a in tables[use["table"]]]))
    for name, labels in TABLE_LABELS.items():
        if name in routines:
            listed = routines[name]["tables"]
            if len(listed) != len(labels):
                raise ValueError("%s loads %d tables, expected %d" % (name, len(listed), len(labels)))
            for table, label in zip(listed, labels):
                table["label"] = label
    per_motion = dict((a, []) for a in motions)
    for key, entry in routines.items():
        for name in entry["motions"]:
            per_motion[next(a for a in motions if names[a] == name)].append(dict(routine=key, how="direct"))
        for table in entry["tables"]:
            for index, name in enumerate(table["motions"]):
                use = dict(routine=key, how="table", table=table["address"], index=index)
                if "label" in table:
                    use["label"] = table["label"]
                per_motion[next(a for a in motions if names[a] == name)].append(use)
    # Words holding a motion address that no listed load or table accounts for (data records,
    # the all-motion tables).
    covered = set(u["pool"] for u in uses if u["motion"] is not None)
    covered.update(start + 4 * i for start, members in tables.items() for i in range(len(members)))
    held = {}
    for i, word in enumerate(struct.unpack_from("<%dI" % (len(executable) // 4), executable)):
        if word in motions and LOAD + 4 * i not in covered:
            held.setdefault(word, []).append(LOAD + 4 * i)
    listing = []
    for address in sorted(motions):
        m = motions[address]
        groups = sorted(set(routines[u["routine"]]["group"] for u in per_motion[address]))
        listing.append(dict(m, address=address, groups=groups, uses=per_motion[address],
                            other_words=held.get(address, [])))
    counts = {}
    for item in listing:
        key = item["format"]
        c = counts.setdefault(key, dict(motions=0, used=0))
        c["motions"] += 1
        c["used"] += bool(item["uses"])
    manifest = dict(
        schema=1, sources=dict((n, dict(size=len(b), sha256=digest(b))) for n, b in
                               (("1ST_READ.BIN", executable), ("MOTDC.BIN", found["motdc"]))),
        motdc_base=found["base"], name_shift="USA = decomp (EU) functions.txt address + local shift (FUNCTIONS)",
        counts=counts, sites=len(uses), tables=len(tables),
        routines=[dict(routines[k], key=k) for k in sorted(routines, key=lambda k: min(routines[k]["sites"]))],
        motions=listing)
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi motion uses</title>',
            '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px;'
            'vertical-align:top}</style><h1>Local Crazy Taxi motion uses</h1><table>',
            '<tr><th>routine</th><th>group</th><th>motions</th></tr>']
    for r in manifest["routines"]:
        parts = list(r["motions"]) + ["[%s%s]" % ("%s: " % t["label"] if "label" in t else "%08X: " % t["address"],
                                                  " ".join(t["motions"])) for t in r["tables"]]
        page.append("<tr><td>%s</td><td>%s</td><td>%s</td></tr>"
                    % (html.escape(r["key"]), r["group"], html.escape(" ".join(parts))))
    page.append("</table>")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".motion-uses-", dir=output.parent))
    try:
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
        (staging / "index.html").write_text("\n".join(page) + "\n")
        if output.exists():
            raise ValueError("output already exists")
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="extracted disc directory")
    parser.add_argument("--output", type=Path, required=True, help="new local output directory")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    print("Filed %d motion loads (%d tables) under %d routines into %s; used: %s"
          % (manifest["sites"], manifest["tables"], len(manifest["routines"]), args.output,
             ", ".join("%s %d/%d" % (k, v["used"], v["motions"]) for k, v in sorted(manifest["counts"].items()))))


if __name__ == "__main__":
    main()
