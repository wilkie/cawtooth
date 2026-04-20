# HERAD (Herbulot Adlib)

> **Status: Phases A + B complete.** This document covers HSQ compression (Phase A) and the HERAD binary format's structural layout — header, tracks, instruments (Phase B). Event-level parsing and the sequencer — actually _playing_ a HERAD song — come in Phase C and will be added here when they land.

## What it is

HERAD (_Herbulot Adlib_) is the music engine written by Stéphane Herbulot for Cryo Interactive, powering audio in the studio's catalogue from Dune (1992) through Atlantis (1997) and beyond. HERAD files are pattern-based, instrument-driven, and compressed with a custom LZSS variant called **HSQ**.

The format has two on-disk layers:

1. **HSQ/SQX compression** — the file on disk is a compressed byte-stream. Our Phase A decompressor handles HSQ; SQX (a newer variant) isn't yet supported.
2. **HERAD payload** — once decompressed, a structured blob with a 52-byte fixed header, concatenated track event-streams, and an instrument bank. Phase B parses this structure; Phase C will interpret the per-track events into OPL register writes.

The same HSQ compression scheme underlies several file extensions:

| Ext    | Meaning                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.HSQ` | HERAD v1 compressed music — OPL2 / AdLib.                                                                                                            |
| `.AGD` | HERAD compressed music targeted at AdLib Gold (uses OPL3 features).                                                                                  |
| `.HA2` | HERAD v2 compressed music. On-disk bytes are identical to `.HSQ`; the extension flags that the decompressed payload should be parsed under v2 rules. |
| `.SQX` | A newer Cryo compression variant with different LZ parameters. Not handled here.                                                                     |

All of HSQ / AGD / HA2 are compressed with the same codec, and our decompressor handles all three.

## Binary structure

### Header (6 bytes)

```
offset   size   field
  0       2     Decompressed size (u16 LE) — bytes of output to produce
  2       1     Always 0x00 in captures we've seen
  3       2     Compressed size (u16 LE) — INCLUDING this header, so == fileSize
  5       1     Checksum byte, chosen so the sum of all 6 bytes mod 256 == 0xAB
```

The checksum is both a format marker and an integrity check. The probability of a random 6-byte tail summing to exactly `0xAB` is 1/256, so in practice the checksum is a reliable "is this an HSQ file?" signal regardless of extension.

### Data stream

A variable-length encoding of literal bytes and back-references, controlled by a 16-bit **queue** of compression flags. Queue bits are consumed LSB-first; when drained, the next 2 bytes of input are read as a fresh u16 LE queue.

For each output operation:

1. Consume one queue bit.
   - **`1` → literal.** Copy one byte from the input to the output.
   - **`0` → reference.** Consume another queue bit to pick the sub-form:
     - **`1` → long reference.** Read 2 input bytes as a u16 LE, call it `packed`:
       - `offset = (packed >> 3) - 8192` — in range `[-8192, -1]`.
       - `length = packed & 0x07`.
       - If `length == 0`: read one more input byte as an explicit length. A byte of `0` here marks **end-of-stream**.
       - `length += 2`.
     - **`0` → short reference.** Consume 2 more queue bits as `length = (hi << 1) | lo`, then read 1 input byte:
       - `offset = inputByte - 256` — in range `[-256, -1]`.
       - `length += 2`.
   - Copy `length` bytes from `output[outPos + offset]` to `output[outPos]`, advancing `outPos` each step. The source range may overlap the destination — that's how HSQ encodes a repeating-byte run.

The stream terminates on the long-reference escape sentinel (`length = 0; nextByte = 0`). Our decompressor additionally rejects streams that end without filling the declared decompressed size.

### Sentinel-bit queue trick

The reference AdPlug implementation uses a clever 17-bit queue trick: after loading the 16-bit queue from input, it OR's in `0x10000`. Each `queue >>= 1` shifts that sentinel bit closer to the LSB. When `queue == 1`, it means "only the sentinel is left, all 16 real bits consumed" — time to refill. Starting the queue at `1` forces the initial refill on the first call.

Our implementation uses the same trick. It's equivalent to a separate bit-counter but has one fewer mutable variable.

## HERAD payload (decompressed)

Once decompression is done, the payload has a 52-byte fixed header, followed by concatenated track event-streams, followed by an instrument bank. All multi-byte fields are little-endian.

### Header (52 bytes)

```
offset   size   field
  0       2     iInstOffset (u16) — byte offset of the instrument bank
  2       2     track 0 offset — always 0x32 (OPL2) or 0x52 (AGD)
  4       2     track 1 offset
  …
(up to HERAD_MAX_TRACKS = 21 entries, each u16; array terminates at the first 0)
 0x2C     2     wLoopStart (u16) — loop-start measure (0 = don't loop)
 0x2E     2     wLoopEnd   (u16) — loop-end measure
 0x30     2     wLoopCount (u16) — iteration count (0 = infinite, >0 = play N times)
 0x32     2     wSpeed     (u16) — fixed-point tempo, must be non-zero
```

The **track-offset table** at `[2..0x2C)` is the key structural element. Each slot stores a track's start position in "offset + 2" form: the actual byte position is `offset_value + 2`. The array is 0-terminated: iterate until a zero slot, and you have your track count. Real files top out at 9–13 tracks even though 21 slots are reserved.

Track 0's offset is by convention `0x32` for OPL2 files and `0x52` for AGD (AdLib Gold / OPL3) files. AGD's 32-byte bump reserves room for additional per-channel metadata between the fixed header and the first track.

### Track data

Track `i` occupies `[track_offset[i] + 2, track_offset[i+1] + 2)`, or `[track_offset[last] + 2, iInstOffset)` for the final track. Track bytes are raw event data — a sequence of per-tick events (note-on/off, pitch bend, tempo, etc.) — which Phase C will interpret. Phase B just hands these out as `Uint8Array`.

### Instrument bank

Starting at `iInstOffset` and running to the end of the file, the bank is a contiguous array of 40-byte instrument blocks. Block count is `(fileSize - iInstOffset) / 40` and must divide evenly.

Each block's first byte is the **mode**:

| Mode                | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `0`                 | SDB1 — v1 SDB (standard-definition bank) AdLib instrument.                  |
| `1`                 | SDB2 — v2 SDB AdLib instrument with slightly different operator layout.     |
| `4`                 | AGD — AdLib Gold / OPL3 instrument.                                         |
| `255` (`-1` signed) | Keymap — v2-only indirection: 36 bytes of instrument indices keyed by note. |

Our parser yields `HeradPatch` (for modes 0/1/4) with the full 40 bytes kept raw — Phase C will decode the operator parameters (KSL/MUL/AR/DR/SR/RR/waveform/etc.) at the moment it emits OPL register writes. Keymaps become `HeradKeymap` with decoded voice/noteOffset fields and a 36-byte index table.

### v1 vs v2 detection

HERAD evolved from v1 (Dune, KGB, Extase) to v2 (ALARME onward) with new event forms and keymap instruments. Our heuristic:

- **Any keymap instrument in the bank → v2.** Reliable when present.
- **No keymap → assume v1.** Incorrect for some v2 files that happen not to use keymaps (ALARME is the known case). Such files need an explicit `{ variant: 'v2' }` to `parseHerad`. A full detector requires event-level parsing, which Phase C will unlock.

## Our implementation

- Compression: [`packages/core/src/formats/herad/hsq.ts`](../../packages/core/src/formats/herad/hsq.ts)
- Parser: [`packages/core/src/formats/herad/parser.ts`](../../packages/core/src/formats/herad/parser.ts)
- Types: [`packages/core/src/formats/herad/types.ts`](../../packages/core/src/formats/herad/types.ts)
- Tests: [`hsq.test.ts`](../../packages/core/src/formats/herad/hsq.test.ts) and [`parser.test.ts`](../../packages/core/src/formats/herad/parser.test.ts)

### Public API

- `parseHerad(bytes, options?)` — accepts either compressed HSQ bytes or an already-decompressed payload (via `isHsq` dispatch). Returns a `HeradSong`.
- `parseDecompressedHerad(bytes, options?)` — for callers that decompressed separately.
- `decompressHsq`, `readHsqHeader`, `isHsq` — compression-layer entry points.

### Validation

Against the four known HSQ/AGD fixtures:

| File           | Variant | Tracks | Insts | AGD |   Speed | Loop       |
| -------------- | ------- | -----: | ----: | --: | ------: | ---------- |
| `WORMINTR.HSQ` | v1      |      9 |    21 |  no | `0x409` | 42–45 (×1) |
| `SAVAGE.HSQ`   | v1      |      9 |    44 |  no | `0x497` | 21–25 (×2) |
| `WORMINTR.AGD` | v1      |     13 |    41 | yes | `0x409` | 43–49 (×1) |
| `ALARME.HSQ`   | v2 \*   |      9 |    46 |  no | `0x3c7` | 70–71 (×1) |

\* ALARME has no keymap instruments, so the keymap heuristic classes it as v1; the test forces `{ variant: 'v2' }` to exercise the override. Phase C will correct the detection.

### Example

```ts
import { parseHerad } from 'cawtooth';

const bytes = new Uint8Array(await (await fetch('WORMINTR.HSQ')).arrayBuffer());
const song = parseHerad(bytes);

console.log(`${song.tracks.length} tracks, ${song.instruments.length} instruments`);
console.log(
  `tempo: wSpeed=0x${song.speed.toString(16)}, loop ${song.loopStart}..${song.loopEnd} x${song.loopCount}`,
);
```

## Our implementation

- Module: [`packages/core/src/formats/hsq/decompress.ts`](../../packages/core/src/formats/hsq/decompress.ts)
- Tests: [`packages/core/src/formats/hsq/decompress.test.ts`](../../packages/core/src/formats/hsq/decompress.test.ts)
- Exports: `readHsqHeader`, `isHsq`, `decompressHsq`.

### Validation strategy

Hand-crafted fixtures cover the literal-only path (easy to encode) and the header checksum. Real-file validation runs against Cryo game data dropped into `examples/hsq/data/` — `SAVAGE.HSQ`, `WORMINTR.HSQ`, `WORMINTR.AGD`, `ALARME.HSQ`, `ALARME.HA2`. Those tests assert:

- The 6-byte header checksum equals `0xAB`.
- `header.compressedSize == fileSize`.
- Decompression produces exactly `header.decompressedSize` bytes.
- The output is non-trivial (byte-distribution sanity check) — catches the degenerate "correct size, wrong bytes" failure mode.
- `ALARME.HSQ` and `ALARME.HA2` decompress to byte-identical output, confirming the extension is purely a parser-side hint.

The real-file tests skip (with a warning) when the files aren't present, so the suite stays green for anyone cloning without the game data.

### Example

```ts
import { decompressHsq, isHsq, readHsqHeader } from 'cawtooth';

const bytes = new Uint8Array(await (await fetch('WORMINTR.HSQ')).arrayBuffer());

if (!isHsq(bytes)) {
  throw new Error('Not an HSQ-compressed file');
}

const header = readHsqHeader(bytes);
console.log(`${header.compressedSize} → ${header.decompressedSize} bytes`);

const payload = decompressHsq(bytes);
// payload is now raw HERAD data ready for the HERAD parser (Phase B).
```

## References

- [AdPlug](https://github.com/adplug/adplug) — `src/herad.cpp` contains the reference `HSQ_decompress`. The canonical implementation and what we matched ours against.
- [ModdingWiki: HERAD](https://moddingwiki.shikadi.net/wiki/HERAD) — community spec for both the compression and the format; written up by people who reverse-engineered the engine.

## Maintainer notes

Update this document when:

- The decompression function changes behaviour (end-of-stream handling, truncated-input semantics, reference-copy semantics for overlapping ranges).
- A new sample file uncovers a variant we need to handle specially.
- SQX support is added — it's a related but distinct compression; likely gets its own file rather than expanding this one.

If the description here diverges from `decompress.ts`, the code is the source of truth and the doc is the bug.
