# DRO (DOSBox Raw OPL)

## What it is

DRO is a capture format — not a game's native music format. It records the OPL register writes a DOS game performs while running under [DOSBox](https://www.dosbox.com/), producing a game-agnostic replay file. Unlike IMF, which games authored directly, DRO is produced by the emulator "listening" to the hardware interface and dumping what it sees.

This makes DRO uniquely valuable for preservation: any DOS game that used the AdLib, Sound Blaster, or Sound Blaster Pro OPL hardware can be archived this way, regardless of how its music engine stored the data internally. LucasArts iMUSE, Sierra SCI, Origin's Music Creator, Apogee's various engines — all can round-trip through DRO even when their native formats haven't been decoded.

Two on-disk variants exist:

- **v1** (DOSBox 0.63–0.73) — variable-length opcode stream. Simple but unstructured.
- **v2** (DOSBox 0.74+) — fixed (cmd, val) pairs with a codemap lookup for the common-register case. Smaller files, easier to parse, same semantics.

## Binary structure

### Common header

Both versions begin with an 8-byte ASCII magic `DBRAWOPL` at offset 0. After the magic, the two versions use **different field sizes for the version number** — a subtlety that silently shifts all downstream offsets:

- **v1:** two `u16` LE fields (major, minor) at offsets 8–11.
- **v2:** two `u8` fields (major, minor) at offsets 8–9.

We detect which variant we're reading by inspecting the `u16` at offset 8: it's 0 for v1 and 2 for v2. Every real file lands on exactly one of these values.

### v2 (modern)

```
offset   size   field
  0       8     magic "DBRAWOPL"
  8       1     iVersionMajor  (u8, = 2)
  9       1     iVersionMinor  (u8, = 0)
 10       4     iLengthPairs   (u32 LE) — number of (cmd, val) pairs
 14       4     iLengthMS      (u32 LE) — duration (informational)
 18       1     iHardwareType  — 0=OPL2, 1=dual-OPL2, 2=OPL3
 19       1     iFormat        — 0=interleaved (only value defined)
 20       1     iCompression   — 0=uncompressed (only value defined)
 21       1     iShortDelayCode — the cmd value that means "short delay"
 22       1     iLongDelayCode  — the cmd value that means "long delay"
 23       1     iCodemapLength N
 24       N     codemap[N]     — codemap[i] = base register number for index i
 24+N    *      data — iLengthPairs × 2 bytes
```

Data pair interpretation (cmd = first byte, val = second):

- `cmd == iShortDelayCode` → delay `(val + 1)` milliseconds, no register write.
- `cmd == iLongDelayCode` → delay `(val + 1) × 256` milliseconds, no register write.
- Otherwise → register write:
  - `index = cmd & 0x7F`
  - `bank = (cmd & 0x80) ? 0x100 : 0` (high bit = OPL3 upper bank / secondary chip)
  - `reg = codemap[index] | bank`
  - Write `val` to `reg`.

The codemap means the file can reference common registers (say the ~40 OPL registers a typical patch touches) with a 1-byte index, which is where most of the size savings over v1 come from.

### v1 (legacy)

```
offset   size   field
  0       8     magic "DBRAWOPL"
  8       2     iVersionMajor  (u16 LE, = 0)
 10       2     iVersionMinor  (u16 LE, = 0 or 1)
 12       4     iLengthMS      (u32 LE)
 16       4     iLengthBytes   (u32 LE) — size of the data section
 20       1     iHardwareType  — 0=OPL2, 1=OPL3, 2=dual-OPL2 (legacy ordering)
 21       3     iFormat / iCompression / iReserved (all zero in practice)
 24       *     data — opcode stream
```

Every v1 capture we've tested has data at offset 24. The three bytes after `iHardwareType` are either explicit zero fields (mirroring v2's layout) or pad a u32 alignment; either way, skipping to 24 gets us to real data.

Data is an opcode stream:

- `0x00` → short delay. Next byte is `(ms − 1)`, so 1..256 ms.
- `0x01` → long delay. Next 2 bytes are `(ms − 1)` as `u16` LE, so 1..65536 ms.
- `0x02` → switch to low bank (OPL3 bank 0 / primary chip).
- `0x03` → switch to high bank (OPL3 bank 1 / secondary chip).
- `0x04` → escape: next two bytes are `(reg, val)`. Needed when the register number would collide with an opcode (0x00–0x04).
- `0x05..0xFF` → direct register write: this byte IS the register number; the next byte is the value.

Bank state (from 0x02/0x03) persists across subsequent register writes until another bank switch, so a single v1 file can freely alternate between OPL3 banks.

## Hardware-type ambiguity

The `iHardwareType` byte means different things in v1 and v2:

| Code | v1        | v2        |
| ---- | --------- | --------- |
| 0    | OPL2      | OPL2      |
| 1    | OPL3      | dual-OPL2 |
| 2    | dual-OPL2 | OPL3      |

Conveniently, **we don't need to care** for playback: the actual chip configuration is determined by the register writes themselves (OPL3 mode is enabled by writing `1` to `0x105`), not by the header hint. Our parser reports the header's claim in the `hardware` field for information only.

## Our implementation

- Parser: [`packages/core/src/formats/dro/parser.ts`](../../packages/core/src/formats/dro/parser.ts)
- Tests: [`packages/core/src/formats/dro/parser.test.ts`](../../packages/core/src/formats/dro/parser.test.ts)
- Output shape: [`RegisterEventStream`](../../packages/core/src/sequencer/types.ts) with `tickRate: 1000` (DRO timing is in absolute milliseconds).

### Timing mapping

DRO stores independent delays between writes; our stream format attaches a "delay after" to each event. The parser accumulates pending-delay as it walks the file, then:

- Attaches it to the **preceding event's** delay when a new register write arrives.
- If a write arrives with pending delay **before any writes have happened yet**, a synthetic `(reg=0, val=0)` event is emitted to absorb the lead-in silence. Register 0 is the OPL test register; writing 0 is a no-op.
- Any delay remaining **after the final write** becomes that event's delay — important so the sequencer's computed loop point matches the file's declared length.

### Example

```ts
import { OplPlayer, parseDro } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

const player = await OplPlayer.create({ workletUrl, wasmUrl });
player.output.connect(player.audioContext.destination);
await player.resume();

const bytes = new Uint8Array(await (await fetch('track.dro')).arrayBuffer());
const song = parseDro(bytes);

console.log(song.variant, song.hardware, song.durationMs); // e.g. "v2", "opl3", 187230

player.loadStream(song.stream, { tickRate: song.tickRate, loop: true });
player.play();
```

### What the parser handles

- v1 and v2 headers, auto-detected from the `u16` major-version at offset 8.
- v1 version 0.0 and 0.1 (DOSBox bumped the minor once without changing layout).
- OPL3 upper-bank writes via v2's high-bit cmd encoding AND v1's 0x02/0x03 bank-switch opcodes.
- Leading and trailing silence (via synthetic events and final-event delay).
- Truncated data (reads up to the declared length, or less if the file is shorter).

### What it does not do

- **v2 with compression != 0.** No DRO v2 file in the wild uses a non-zero compression code; we reject it rather than silently mis-parse.
- **v2 with format != 0.** Same story.
- **Re-encoding / writing DRO.** Read-only.

## References

- [ModdingWiki: DRO Format](https://moddingwiki.shikadi.net/wiki/DRO_Format) — community reference for both v1 and v2 layouts, including the padded-header v1 variant our parser handles.
- [DOSBox source](https://sourceforge.net/p/dosbox/code-0/HEAD/tree/dosbox/trunk/src/hardware/opl.cpp) — `src/hardware/opl.cpp` contains the canonical capture logic.
- [AdPlug](https://github.com/adplug/adplug) — `src/dro.cpp` (v1) and `src/dro2.cpp` (v2) are useful comparison points.

## Maintainer notes

Update this document when:

- Parser behavior around malformed headers, truncation, or edge cases changes.
- A new on-disk variant is discovered in the wild that required a parser adjustment.
- The hardware-type handling changes (we might eventually want to validate rather than just report).

If the description here diverges from parser behavior, the parser is the source of truth — but the divergence is a bug in the documentation and should be fixed here.
