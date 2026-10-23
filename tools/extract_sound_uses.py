#!/usr/bin/env python3
"""List which game code asks for each DTPK sound request, and what that request plays.

The game queues a sound with Sound_Request(word, channel) (decomp src/sound.c; USA 0x0C071338).
Sound_Execute later hands each queued word to the sound library (USA 0x0C07EA8C), which writes it
unchanged into the sound driver's command ring at 0xA0800400. The driver (AICADRV.BIN 0x734)
reads the word's bytes in reverse, so Sound_Request(0x000505A9, 0) is driver request 0xA9050500:
request id 0xA905, sequence 5 (extract_audio.py decodes those sequences).

This tool finds every call or tail jump to Sound_Request in the USA executable and works out the
word (r4) and channel (r5) at each one by walking the code backwards along every path that
reaches it: constants loaded with mov #imm / mov.w / mov.l @(disp,PC), copied with mov Rm,Rn. A
word read from a table (mov.l @(R0,Rm),R4 with a constant R0) lists the table's entries; when the
index comes from an and-mask the entries are exactly the masked indices, otherwise the run of
consecutive words that are valid requests. Anything else is reported as unresolved.

Routine names come from the supplied decomp's C sources (EU build): DECOMP_CALLERS lists, per
word, the decomp functions that pass it as a constant. The request words are the same in both
builds, so each USA request is matched to those names by value; the manifest lists the words only
one side has.

Stdlib only; no upstream imports.
"""
import argparse
import html
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile

try:
    from tools import extract_audio as audio
    from tools.extract_models import digest
except ImportError:  # run as a script from the tools directory
    import extract_audio as audio
    from extract_models import digest

LOAD = 0x0C010000
CODE_END = 0x0C08A000  # end of the executable's code (game code, then the library)
SOUND_REQUEST = 0x0C071338
# USA SH-4 halfwords (and pool words) the request path relies on.
GAME_CODE = {
    0x0C071340: 0x8801,  # Sound_Request: cmp/eq #1,r0 (MainMode must be 1)
    0x0C07134C: 0x6E53,  # mov r5,r14: channel ...
    0x0C071350: 0x4E08,  # shll2 r14: ... indexes the per-channel write pointers
    0x0C071366: 0x2342,  # mov.l r4,@r3: the word is queued as is
    0x0C07142C: 0x64B2,  # Sound_Execute: mov.l @r11,r4; jsr @r2 (0x0C07EA8C); mov.l @r4,r4
    0x0C07142E: 0x420B,
    0x0C071430: 0x6442,
    0x0C07EAAC: 0xC880,  # 0x0C07EA8C: tst #128,r0 (low byte bit 7 marks a command) ...
    0x0C07EADE: 0x53F1,  # mov.l @(4,r15),r3
    0x0C07EAE0: 0x2232,  # mov.l r3,@r2: ... written unchanged into the driver's ring
}
GAME_POOL = {
    0x0C0713D4: 0x0C1EBF54,  # MainMode
    0x0C0714AC: 0x0C07EA8C,  # Sound_Execute's sender
    0x0C07EB18: 0xA0800500,  # ring end ...
    0x0C07EB1C: 0xA0800400,  # ... wraps to its start
}
# AICADRV.BIN: the driver copies the four bytes of a ring word in reverse before decoding it.
DRIVER_CODE = {
    0x0734: 0xE5D70008, 0x0738: 0xE5C7000F,  # ldrb r0,[r7,#8]; strb r0,[r7,#0xf]
    0x073C: 0xE5D70009, 0x0740: 0xE5C7000E,
    0x0744: 0xE5D7000A, 0x0748: 0xE5C7000D,
    0x074C: 0xE5D7000B, 0x0750: 0xE5C7000C,
    0x0754: 0xE597000C,  # ldr r0,[r7,#0xc]: the reversed word is the request
}
# Decomp (EU) functions that pass each Sound_Request word as a constant, with the channel
# (supplied decomp src/*.c: game_p.c and the gen_*.c files).
DECOMP_CALLERS = {
    0x002A9: (("exec_KyakuMain", 0),),
    0x003A9: (("psgFrameState4", 2),),
    0x004A9: (("Put_Pass_Time", 0),),
    0x005A9: (("Exec_Time_Spark", 0),),
    0x009A9: (("psgFrameState3", 2), ("psgFrameState4", 2)),
    0x00AA9: (("trainControlExec", 0),),
    0x00BA9: (("Put_GearBox", 0),),
    0x102A9: (("carRumble", 0),),
    0x104A9: (("Result_Money_Put", 0),),
    0x105A9: (("setTechnicalBonus", 1),),
    0x108A9: (("carRumble", 0),),
    0x10AA9: (("trainControlExec", 0),),
    0x10CA9: (("ExecEffect", 1),),
    0x10FA9: (("Check_DCmini_End", 0), ("Exec_DCmini_Game7", 0)),
    0x204A9: (("Result_Money_Put", 0),),
    0x205A9: (("Put_TotalDrum_Digits", 0), ("Result_Money_Digit_Put", 0), ("hudDrawFareDigits", 0),
              ("hudUpdateRankDrum", 0)),
    0x20AA9: (("trainControlExec", 0),),
    0x20CA9: (("ExecEffect", 0),),
    0x20FA9: (("Move_Balloon", 0),),
    0x211A9: (("Put_Course_Obj_Sound", 0),),
    0x304A9: (("ExecNameEntrySelect", 0), ("Result_Earned_Text_Put", 0)),
    0x308A9: (("Drv_ExecBikePedal", 0), ("selectPlayPickMotion", 0)),
    0x30AA9: (("trainControlExec", 0),),
    0x30CA9: (("ExecEffect", 0),),
    0x311A9: (("Put_Course_Obj_Sound", 0),),
    0x405A9: (("ExecNameEntrySelect", 0), ("Result_Class_Put", 0), ("Result_Rank_Put", 0),
              ("Start_Pass_Judgement", 0)),
    0x40AA9: (("trainCarDrive", 1),),
    0x40CA9: (("ExecEffect", 0),),
    0x411A9: (("ExecHelicopter", 0),),
    0x501A9: (("selectDrawDriver", 0), ("selectPlayPickMotion", 0)),
    0x505A9: (("Put_Remain_Time", 0), ("Put_Remain_Time_Mode2", 0)),
    0x50AA9: (("trainCarDrive", 1),),
    0x511A9: (("MoveHelicopter", 0),),
    0x604A9: (("Put_TotalDrum_Update", 0), ("hudDrawPassRanking", 0), ("hudDrawTime", 0)),
    0x605A9: (("init_GameSystem", 0),),
    0x60AA9: (("trainCarDrive", 1),),
    0x704A9: (("Put_TotalDrum_Update", 0), ("hudDrawTime", 0), ("hudUpdateRankDrum", 0)),
    0x705A9: (("Put_Remain_Time_Gauge", 0), ("hudUpdateFareState", 0)),
    0x70AA9: (("trainControlExec", 1),),
    0x805A9: (("ExecArrow", 0),),
    0x80AA9: (("trainControlExec", 1),),
    0x905A9: (("hudUpdateFareState", 0),),
    0x90AA9: (("trainCarDrive", 1),),
    0xA00A9: (("Result_Awesome_Put", 0), ("Result_Crazy_Put", 0), ("Result_Title_Put", 0)),
    0xE00A9: (("Result_Awesome_Put", 0), ("Result_Crazy_Put", 0)),
}
TABLE_RUN_LIMIT = 64
WALK_LIMIT = 20000
UNKNOWN = "unknown"


def driver_request(word):
    """The driver's view of a queued word: its bytes reversed."""
    return struct.unpack(">I", struct.pack("<I", word))[0]


def written(op):
    """Registers an SH-4 instruction may write (general registers only)."""
    top, n, m, low = op >> 12, op >> 8 & 15, op >> 4 & 15, op & 15
    if top == 0x0:
        if low in (0xC, 0xD, 0xE) or op & 0xFF in (0x29, 0x02, 0x12, 0x22, 0x32, 0x42, 0x0A, 0x1A, 0x2A,
                                                   0x5A, 0x6A, 0xFA, 0x3A, 0x4A):
            return {n}
        return {n, m} if low == 0xF else set()
    if top == 0x2:
        return {n} if low in (4, 5, 6, 9, 0xA, 0xB, 0xD) else set()
    if top == 0x3:
        return {n} if low in (4, 8, 0xA, 0xB, 0xC, 0xE, 0xF) else set()
    if top == 0x4:
        if op & 0xFF in (0x0B, 0x2B, 0x11, 0x15, 0x1B) or low in (0xA, 0xE):
            return set()
        return {n, m} if low == 0xF else {n}
    if top in (0x5, 0x7, 0x9, 0xD, 0xE):
        return {n}
    if top == 0x6:
        return {n, m} if low in (4, 5, 6) else {n}
    if top == 0x8:
        return {0} if n in (4, 5) else set()
    if top == 0xC:
        return {0} if n in (4, 5, 6, 7, 9, 0xA, 0xB) else set()
    if top == 0xF:
        return {m} if low == 9 else {n} if low == 0xB else set()
    return set()


class Code:
    """Instruction-level control flow of the executable's code region."""

    def __init__(self, executable, end=CODE_END):
        self.executable = executable
        self.end = min(end, LOAD + len(executable) // 2 * 2)
        self.ops = struct.unpack_from("<%dH" % ((self.end - LOAD) // 2), executable)
        # Literal pool words are the targets of PC-relative loads (and mova). Pool words can
        # themselves decode as loads, so loads that sit in a pool are dropped until nothing changes.
        self.data = set()
        for _ in range(8):
            data = set()
            for i, op in enumerate(self.ops):
                at = LOAD + 2 * i
                if at in self.data:
                    continue
                if op >> 12 == 0xD or op >> 8 == 0xC7:
                    pool = (at & ~3) + 4 + (op & 255) * 4
                    data.update((pool, pool + 2))
                elif op >> 12 == 0x9:
                    data.add(at + 4 + (op & 255) * 2)
            if data == self.data:
                break
            self.data = data
        self.branches = {}
        for i, op in enumerate(self.ops):
            at = LOAD + 2 * i
            if at in self.data:
                continue
            if op >> 12 == 0xA:
                self.branches.setdefault(at + 4 + 2 * signed(op & 0xFFF, 12), []).append(at + 2)
            elif op >> 8 in (0x89, 0x8B, 0x8D, 0x8F):
                target = at + 4 + 2 * signed(op & 255, 8)
                self.branches.setdefault(target, []).append(at + 2 if op >> 8 in (0x8D, 0x8F) else at)

    def op(self, at):
        return self.ops[(at - LOAD) // 2]

    def code(self, at):
        return LOAD <= at < self.end and at not in self.data

    def kind(self, at):
        op = self.op(at)
        if op >> 12 == 0xA or op in (0x000B, 0x002B) or op & 0xF0FF in (0x402B, 0x0023):
            return "end"
        if op >> 12 == 0xB or op & 0xF0FF in (0x400B, 0x0003):
            return "call"
        return None

    def preds(self, at):
        """(address, after a call) of every instruction that can run just before `at`."""
        out = []
        before = at - 2
        if self.code(before) and not (self.code(before - 2) and self.kind(before - 2) == "end"):
            out.append((before, self.code(before - 2) and self.kind(before - 2) == "call"))
        out.extend((p, False) for p in self.branches.get(at, ()))
        return out

    def word(self, address, fmt="<I"):
        offset = address - LOAD
        size = struct.calcsize(fmt)
        if 0 <= offset <= len(self.executable) - size:
            return struct.unpack_from(fmt, self.executable, offset)[0]
        return None

    def resolve(self, starts, registers, table=None):
        """Set of value tuples the `registers` can hold after any instruction in `starts` runs,
        following every path backwards. Values are ints, UNKNOWN or table() results."""
        results, seen, budget = set(), set(), [WALK_LIMIT]
        stack = [(at, tuple(("r", r) for r in registers)) for at in starts]
        if not stack:  # nothing runs before a routine entry: the registers are arguments
            return {tuple(UNKNOWN for _ in registers)}
        while stack:
            at, state = stack.pop()
            if (at, state) in seen:
                continue
            seen.add((at, state))
            budget[0] -= 1
            if budget[0] < 0:
                raise ValueError("register walk from %s too long" % ", ".join("%08X" % s for s in starts))
            if not self.code(at):
                state = tuple(("v", UNKNOWN) if s[0] == "r" else s for s in state)
            else:
                state = tuple(self.step(at, s, table) if s[0] == "r" else s for s in state)
            if all(s[0] == "v" for s in state):
                results.add(tuple(s[1] for s in state))
                continue
            preds = self.preds(at)
            if not preds:  # a routine entry: the value is an argument
                results.add(tuple(s[1] if s[0] == "v" else UNKNOWN for s in state))
                continue
            for pred, after_call in preds:
                stack.append((pred, tuple(("v", UNKNOWN) if after_call and s[0] == "r" and s[1] < 8 else s
                                          for s in state)))
        return results

    def before(self, at, registers, table=None):
        """Like resolve(), for the values just before the instruction at `at` runs."""
        out = set()
        preds = self.preds(at)
        if not preds:
            return {tuple(UNKNOWN for _ in registers)}
        for pred, after_call in preds:
            kept = [r for r in registers if not (after_call and r < 8)]
            found = self.resolve([pred], kept, table) if kept else {()}
            for values in found:
                lookup = dict(zip(kept, values))
                out.add(tuple(lookup.get(r, UNKNOWN) for r in registers))
        return out

    def step(self, at, pending, table):
        """A pending register after the instruction at `at` runs backwards over it."""
        op, register = self.op(at), pending[1]
        if register not in written(op):
            return pending
        top, m = op >> 12, op >> 4 & 15
        if top == 0xE:
            return ("v", signed(op & 255, 8) & 0xFFFFFFFF)
        if top == 0x9:
            return ("v", self.word(at + 4 + (op & 255) * 2, "<h") & 0xFFFFFFFF)
        if top == 0xD:
            return ("v", self.word((at & ~3) + 4 + (op & 255) * 4))
        if top == 0x6 and op & 15 == 3:
            return ("r", m)
        if top == 0x0 and op & 15 == 0xE and table is not None:
            return ("v", table(self, at, m))
        return ("v", UNKNOWN)

    def single_pred(self, at):
        preds = self.preds(at)
        return preds[0] if len(preds) == 1 and not preds[0][1] else None

    def index_offsets(self, at, register):
        """Byte offsets an index register can hold at `at` when it comes from an and-mask on the
        same straight-line path (and #imm,r0 or and Rm,Rn with a constant Rm), shifted and copied
        afterwards; None if no such mask is found."""
        shifts = []
        for _ in range(24):
            step = self.single_pred(at)
            if step is None:
                return None
            at = step[0]
            op = self.op(at)
            n, m = op >> 8 & 15, op >> 4 & 15
            if register not in written(op):
                continue
            if op >> 12 == 0x4 and op & 0xFF in (0x00, 0x01, 0x08, 0x09, 0x18, 0x19):
                shifts.append({0x00: 1, 0x01: -1, 0x08: 2, 0x09: -2, 0x18: 8, 0x19: -8}[op & 0xFF])
            elif op >> 12 == 0x6 and op & 15 == 3:
                register = m
            elif op >> 12 == 0x4 and op & 15 == 0xC:
                amounts = self.before(at, [m])
                if len(amounts) != 1 or not isinstance(next(iter(amounts))[0], int):
                    return None
                shifts.append(signed(next(iter(amounts))[0], 32))
            elif op >> 8 == 0xC9 and register == 0 or op >> 12 == 0x2 and op & 15 == 9:
                if op >> 12 == 0xC:
                    mask = op & 255
                else:
                    masks = self.before(at, [m])
                    if len(masks) != 1 or not isinstance(next(iter(masks))[0], int):
                        return None
                    mask = next(iter(masks))[0]
                bits = [1 << b for b in range(32) if mask >> b & 1]
                if len(bits) > 8:
                    return None
                values = set()
                for pick in range(1 << len(bits)):
                    value = sum(bit for i, bit in enumerate(bits) if pick >> i & 1)
                    for shift in reversed(shifts):
                        value = value << shift if shift > 0 else value >> -shift
                    values.add(value & 0xFFFFFFFF)
                return sorted(values)
            else:
                return None
        return None


def signed(value, bits):
    return value - (1 << bits) if value >> (bits - 1) & 1 else value


def table_reader(known):
    """A table() callback for Code.resolve: the requests a mov.l @(R0,Rm),Rn load can read."""

    def table(code, at, other):
        """The load reads R0 + Rm: whichever of the two is a constant is the table, the other the index."""
        for base_register, index in ((0, other), (other, 0)):
            bases = code.before(at, [base_register])
            if len(bases) == 1 and isinstance(next(iter(bases))[0], int):
                break
        else:
            return UNKNOWN
        base = next(iter(bases))[0]
        if code.word(base) is None or base % 4:
            return UNKNOWN
        offsets = code.index_offsets(at, index)
        if offsets is not None:
            if any(offset % 4 for offset in offsets):
                return UNKNOWN
            entries = tuple((offset // 4, code.word(base + offset)) for offset in offsets)
            missing = [w for _, w in entries if w is None or driver_request(w) not in known]
            if missing:
                raise ValueError("request table %08X holds non-request words %s"
                                 % (base, ", ".join("%08X" % (w or 0) for w in missing)))
            return ("table", base, "mask", entries)
        entries = []
        while len(entries) < TABLE_RUN_LIMIT:
            word = code.word(base + 4 * len(entries))
            if word is None or driver_request(word) not in known:
                break
            entries.append((len(entries), word))
        return ("table", base, "run", tuple(entries)) if entries else UNKNOWN

    return table


def find_calls(executable, known, target=SOUND_REQUEST):
    """Every call (jsr, bsr) or tail jump (jmp, bra) to `target`, with the (word, channel) pairs
    each can pass."""
    code = Code(executable)
    table = table_reader(known)
    sites = []
    for i, op in enumerate(code.ops):
        at = LOAD + 2 * i
        if at in code.data:
            continue
        if op & 0xF0DF == 0x400B:  # jsr / jmp @Rn
            via = "jsr" if op & 0x20 == 0 else "jmp"
            targets = code.before(at, [op >> 8 & 15])
            if (target,) not in targets:
                continue
        elif op >> 12 in (0xA, 0xB):
            if at + 4 + 2 * signed(op & 0xFFF, 12) != target:
                continue
            via = "bsr" if op >> 12 == 0xB else "bra"
        else:
            continue
        pairs = code.resolve([at + 2], [4, 5], table)
        sites.append(dict(site=at, via=via, pairs=sorted(pairs, key=repr)))
    return sites


def check_code(executable, driver):
    for address, value in GAME_CODE.items():
        if struct.unpack_from("<H", executable, address - LOAD)[0] != value:
            raise ValueError("executable instruction at %08X differs from the USA build" % address)
    for address, value in GAME_POOL.items():
        if struct.unpack_from("<I", executable, address - LOAD)[0] != value:
            raise ValueError("executable word at %08X differs from the USA build" % address)
    for address, value in DRIVER_CODE.items():
        if address + 4 > len(driver) or struct.unpack_from("<I", driver, address)[0] != value:
            raise ValueError("sound driver instruction at 0x%04X differs from the USA build" % address)
    audio.check_request_code(driver)


def pack_requests(source, driver):
    """{driver request: (pack, group id, sequence)} over every DTPK pack, as extract_audio decodes them."""
    _, fns = audio.driver_fns_table(driver)
    known = {}
    for name in audio.DTPK_SOURCES:
        data = (source / name).read_bytes()
        playbacks = audio.dtpk_playbacks(data, len(audio.dtpk_samples(data)), fns)
        for group in audio.dtpk_requests(data, playbacks):
            for sequence in group["sequences"]:
                request = int(sequence["request"], 16)
                if request in known:
                    raise ValueError("sound request %s is in two packs" % sequence["request"])
                known[request] = (name, group["id"], sequence)
    return known


def played_samples(sequence):
    streams = [sequence] if sequence["form"] == "script" else \
        [t for t in sequence["track"] if t["kind"] == "events"]
    out = []
    for event in (e for s in streams for e in s["events"] if e["kind"] == "note_on"):
        if event["sample"] not in out:
            out.append(event["sample"])
    return out


def describe(value, channel):
    """Manifest form of one (word, channel) pair."""
    item = dict(channel=channel if isinstance(channel, int) else None)
    if isinstance(value, tuple):
        item.update(table=dict(address=value[1], indices=value[2],
                               entries=[dict(index=i, word=w, request="0x%08X" % driver_request(w))
                                        for i, w in value[3]]))
    elif isinstance(value, int):
        item.update(word=value, request="0x%08X" % driver_request(value))
    else:
        item.update(unresolved=True)
    return item


def extract(source, output, audio_dir=None):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists():
        raise ValueError("output already exists")
    executable = (source / "1ST_READ.BIN").read_bytes()
    driver = (source / audio.SOUND_DRIVER).read_bytes()
    check_code(executable, driver)
    known = pack_requests(source, driver)
    sites = find_calls(executable, known)
    by_request = dict((r, dict(constant=[], table=[])) for r in known)
    listed = []
    for site in sites:
        calls = [describe(value, channel) for value, channel in site["pairs"]]
        for call in calls:
            if "word" in call:
                request = driver_request(call["word"])
                if request not in known:
                    raise ValueError("Sound_Request at %08X passes %08X, which no pack requests"
                                     % (site["site"], call["word"]))
                by_request[request]["constant"].append(site["site"])
            for entry in call.get("table", {}).get("entries", ()):
                by_request[driver_request(entry["word"])]["table"].append(site["site"])
        listed.append(dict(site=site["site"], via=site["via"], calls=calls))
    constant_words = set(c["word"] for s in listed for c in s["calls"] if "word" in c)
    audio_links = None
    if audio_dir is not None:
        audio_links = Path(audio_dir).resolve()
        if not (audio_links / "manifest.json").is_file():
            raise ValueError("audio directory has no manifest.json")
    requests = []
    for request in sorted(known):
        pack, ident, sequence = known[request]
        word = struct.unpack("<I", struct.pack(">I", request))[0]
        item = dict(request="0x%08X" % request, word="0x%08X" % word, pack=pack, id=ident,
                    index=sequence["index"], form=sequence["form"],
                    samples=played_samples(sequence),
                    decomp_callers=[dict(function=f, channel=c) for f, c in DECOMP_CALLERS.get(word, ())],
                    sites=sorted(set(by_request[request]["constant"])),
                    table_sites=sorted(set(by_request[request]["table"])))
        if audio_links is not None:
            item["wavs"] = []
            for sample in item["samples"]:
                wav = audio_links / Path(pack).stem / ("%04d.wav" % sample)
                if not wav.is_file():
                    raise ValueError("missing audio file %s" % wav)
                item["wavs"].append(os.path.relpath(wav, output.parent.resolve() / output.name))
        requests.append(item)
    counts = dict(
        sites=len(listed),
        constant=sum(1 for s in listed if all("word" in c for c in s["calls"])),
        table=sum(1 for s in listed if any("table" in c for c in s["calls"])),
        unresolved=sum(1 for s in listed if any(c.get("unresolved") for c in s["calls"])),
        requests=len(requests),
        requests_with_constant_sites=sum(1 for r in requests if r["sites"]),
        requests_reached=sum(1 for r in requests if r["sites"] or r["table_sites"]))
    manifest = dict(
        schema=1,
        sources=dict((n, dict(size=len(b), sha256=digest(b)))
                     for n, b in (("1ST_READ.BIN", executable), (audio.SOUND_DRIVER, driver))),
        sound_request=SOUND_REQUEST, counts=counts,
        decomp_only=["0x%05X" % w for w in sorted(set(DECOMP_CALLERS) - constant_words)],
        usa_only=["0x%05X" % w for w in sorted(constant_words - set(DECOMP_CALLERS))],
        sites=listed, requests=requests)
    page = ['<!doctype html><meta charset="utf-8"><title>Crazy Taxi sound requests</title>',
            '<style>body{font-family:system-ui;background:#222;color:#eee}td{padding:2px 8px;'
            'vertical-align:top}a{color:#9cf}</style><h1>Local Crazy Taxi sound requests</h1>',
            '<p>Sound_Request word, the driver request it becomes, its pack and samples, the decomp '
            'functions that pass it and the USA call sites.</p><table>',
            '<tr><th>word</th><th>request</th><th>pack</th><th>samples</th><th>decomp callers</th>'
            '<th>USA sites</th></tr>']
    for item in requests:
        if "wavs" in item:
            samples = " ".join('<a href="%s">%d</a>' % (html.escape(w), s)
                               for s, w in zip(item["samples"], item["wavs"]))
        else:
            samples = " ".join(str(s) for s in item["samples"])
        sites_text = " ".join("%08X" % s for s in item["sites"]) + \
            "".join(" [table] %08X" % s for s in item["table_sites"])
        page.append("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            item["word"], item["request"], html.escape(item["pack"]), samples,
            html.escape(", ".join("%s (ch %d)" % (c["function"], c["channel"]) for c in item["decomp_callers"])),
            sites_text))
    page.append("</table>")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".sound-uses-", dir=output.parent))
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
    parser.add_argument("--audio", type=Path, help="extract_audio.py output to link WAV files from")
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output, args.audio)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    c = manifest["counts"]
    print("Found %d Sound_Request sites (%d constant, %d table, %d unresolved); %d/%d requests reached "
          "into %s" % (c["sites"], c["constant"], c["table"], c["unresolved"], c["requests_reached"],
                       c["requests"], args.output))


if __name__ == "__main__":
    main()
