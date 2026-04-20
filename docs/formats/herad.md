# HERAD (Herbulot Adlib)

> **Status: Phases A + B + C complete.** HSQ compression (Phase A), the HERAD binary format's structural layout (Phase B), and the event-level parser + renderer that produces an OPL register stream (Phase C) are all implemented. Phase C matches the AdPlug reference for all standard playback features — program changes, note on/off, pitch bend (fine and coarse), slide, transpose, velocity macros, aftertouch (v1), v2 keymaps, and AGD panning.

## What it is

HERAD (_Herbulot Adlib_) is the music engine written by Stéphane Herbulot for Cryo Interactive, powering audio in the studio's catalogue from Dune (1992) through Atlantis (1997) and beyond. HERAD files are pattern-based, instrument-driven, and compressed with a custom LZSS variant called **HSQ**.

The format has two on-disk layers:

1. **Compression** — the file on disk is a compressed byte-stream. Phase A handles both HSQ and SQX.
2. **HERAD payload** — once decompressed, a structured blob with a 52-byte fixed header, concatenated track event-streams, and an instrument bank. Phase B parses this structure; Phase C interprets the per-track events into OPL register writes.

Known file extensions, all of which `parseHerad` auto-dispatches:

| Ext    | Compression | Meaning                                                                                                       |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `.HSQ` | HSQ         | HERAD v1 music — OPL2 / AdLib.                                                                                |
| `.AGD` | HSQ         | HERAD music for AdLib Gold (OPL3 features).                                                                   |
| `.HA2` | HSQ         | HERAD v2 music. On-disk bytes are identical to `.HSQ`; the extension flags v2 parsing.                        |
| `.SQX` | SQX         | Cryo's second-generation compression (parameterised LZ with three config bytes + an offset/length split bit). |
| `.SDB` | none        | Already-decompressed HERAD payload. Typically identical to what decompressing an HSQ would produce.           |

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

## SQX compression

SQX is a parameterised cousin of HSQ. The 6-byte header is:

```
[0..2)  u16 LE   Pre-fill for output[0..2). The LZ codec writes from output[0]
                 and typically overwrites these bytes; the purpose is to give
                 very early back-references a defined value to look up when
                 they reach before position 0.
[2]     u8       op for flag "0"     (0 = literal, 1 = short ref, 2 = long ref)
[3]     u8       op for flag "10"    (same encoding)
[4]     u8       op for flag "11"    (same encoding)
[5]     u8       long-ref length-field bit count (1..15)
```

SQX has **no declared decompressed size**. The codec emits bytes until it
hits the long-ref end-of-stream sentinel (length-field 0 followed by a
length byte 0). Our decompressor allocates a ceiling-sized scratch buffer
(75 KB, matching AdPlug's `HERAD_MAX_SIZE`) and returns a trimmed copy.

Detection is heuristic (a few range checks on the flag bytes) with no
checksum — it's possible but unlikely for a non-SQX file to pass. We dispatch
HSQ before SQX in `parseHerad` because HSQ's checksum is unambiguous.

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
- **No keymap → assume v1.** Incorrect for some v2 files that happen not to use keymaps (ALARME is the known case). Such files need an explicit `{ variant: 'v2' }` to `parseHerad`. A robust detector would parse events speculatively under both variants and see which resolves cleanly — a refinement we haven't needed yet.

## Events and playback (the renderer)

The final layer converts a parsed `HeradSong` into a `RegisterEventStream` that plays through the same sequencer as IMF/DRO. Conceptually:

```
HSQ bytes → decompress → HeradSong → renderHeradToStream() → RegisterEventStream → RegisterSequencer → OPL chip
```

### Event encoding (per track)

Each track's bytes are a MIDI-ish sequence of `(VLQ delay, status byte + data)` pairs. The status-byte high nibble picks a handler:

| Status | Name           | Data bytes                        | Notes                                                            |
| ------ | -------------- | --------------------------------- | ---------------------------------------------------------------- |
| `0x80` | Note Off       | note, velocity (v1 only)          | v2 trims the velocity byte — that's the "truncated NoteOff" tell |
| `0x90` | Note On        | note, velocity                    |                                                                  |
| `0xA0` | — (unused)     | 2 bytes, skipped                  |                                                                  |
| `0xB0` | — (unused)     | 2 bytes, skipped                  |                                                                  |
| `0xC0` | Program Change | program                           |                                                                  |
| `0xD0` | Aftertouch     | pressure                          | v1 only; v2 ignores the event                                    |
| `0xE0` | Pitch Bend     | bend (single byte, 0x40 = center) | Not MIDI's 2-byte form                                           |
| `0xFF` | End of Track   | —                                 |                                                                  |

The delay between events is a MIDI variable-length quantity (7 bits per byte, high bit = continuation).

### Tick rate

HERAD's `update()` runs at `200.299 Hz`. Each update does `wTime -= 256; if (wTime < 0) { wTime += wSpeed; processEvents(); }`, so `processEvents` fires at `200.299 * 256 / wSpeed` Hz. That's the tick rate we feed to `RegisterEventStream` — VLQ delays count in those ticks.

### Rendering model

The renderer walks **tick by tick** rather than event by event, because HERAD has per-tick effects (slide) that can't be captured by just iterating song events:

1. For each tick from 0 to song end:
   1. For each voice, if a slide is active, decrement `slide_dur`, add `slide_range` to `bend`, re-emit the 0xA0/0xB0 frequency registers.
   2. For each track, process any events whose absolute tick equals the current tick.

Slide-before-event ordering mirrors AdPlug and means a same-tick song-level pitch bend correctly overwrites the slide's increment.

### Per-voice state

Each voice tracks:

| Field         | Purpose                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `program`     | Last program-change-selected instrument (may be a keymap in v2).                      |
| `playProgram` | Instrument actually producing sound. Resolves through keymap on note-on.              |
| `note`        | Currently sounding note number.                                                       |
| `keyon`       | Whether the voice is key-on.                                                          |
| `bend`        | Current pitch-bend value, 0x40 center. Updated by song events AND by slide each tick. |
| `slideDur`    | Remaining slide ticks. Set from `mc_slide_dur` on note-on; cleared on note-off.       |

### Feature coverage

All standard HERAD playback features are implemented:

- **Program change** — writes the full operator parameter set (0x20/0x23, 0x40/0x43, 0x60/0x63, 0x80/0x83, 0xC0, 0xE0/0xE3).
- **Note on/off** — F-number table (`FNum`) keyed by `note % 12`, octave from `note / 12`, key-on bit in 0xB0.
- **Pitch bend** — two paths chosen by the instrument's `mc_slide_coarse` bit 0: fine-tune via `fine_bend` with a detune fraction, or coarse-tune via `coarse_bend`.
- **Slide** — `mc_slide_dur` ticks of automatic bend updates after a note-on, each adding `mc_slide_range` to the current bend and re-emitting frequency.
- **Transpose** — `mc_transpose` shifts the note number pre-lookup.
- **Velocity macros** — `mc_mod_out_vel` / `mc_car_out_vel` / `mc_fb_vel` scale modulator output, carrier output, and feedback by `(velocity - 64) >> 1` × sensitivity.
- **Aftertouch (v1)** — the 0xD0 event triggers `mc_mod_out_at` / `mc_car_out_at` / `mc_fb_at` macros. v2 ignores the event.
- **AGD mode** — writes `0x105 = 1` to enable OPL3, routes voices 9–17 into the upper bank (`reg | 0x100`), and uses the `pan` field for OPL3 CHA/CHB routing bits.
- **v2 keymap indirection** — a program-change pointing at a keymap instrument defers the real change to note-on, which looks up `keymap.indices[note - keymap.noteOffset - 24]` and applies _that_ patch. Out-of-range notes are silent (the "drum map" behaviour).

Known omissions: HERAD's rhythm-mode percussion (not used by any sample we have) and a handful of per-operator detune fields some late HERAD variants use.

### Public API

- `parseHerad(bytes, options?)` → `HeradSong`. Accepts compressed HSQ or decompressed bytes.
- `parseDecompressedHerad(bytes, options?)` → `HeradSong`. Skip the `isHsq` dispatch.
- `renderHeradToStream(song)` → `{ stream, tickRate }`. Feed the stream to `RegisterSequencer` / `OplPlayer`.
- `parseHeradTrack(bytes, options)` → `HeradTimedEvent[]`. Exposed for tooling / inspection; not needed for playback.
- Compression helpers: `decompressHsq`, `readHsqHeader`, `isHsq`.

### Example

```ts
import { OplPlayer, parseHerad, renderHeradToStream } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

const player = await OplPlayer.create({ workletUrl, wasmUrl });
player.output.connect(player.audioContext.destination);
await player.resume();

const bytes = new Uint8Array(await (await fetch('SAVAGE.HSQ')).arrayBuffer());
const song = parseHerad(bytes); // or pass { variant: 'v2' } for ALARME-like files
const { stream, tickRate } = renderHeradToStream(song);

player.loadStream(stream, { tickRate, loop: true });
player.play();
```

## Validation

The suite runs against real Cryo game data in `examples/hsq/data/`:

| File           | Variant | Tracks | Insts | AGD |   Speed | Loop       |
| -------------- | ------- | -----: | ----: | --: | ------: | ---------- |
| `WORMINTR.HSQ` | v1      |      9 |    21 |  no | `0x409` | 42–45 (×1) |
| `SAVAGE.HSQ`   | v1      |      9 |    44 |  no | `0x497` | 21–25 (×2) |
| `WORMINTR.AGD` | v1      |     13 |    41 | yes | `0x409` | 43–49 (×1) |
| `ALARME.HSQ`   | v2 \*   |      9 |    46 |  no | `0x3c7` | 70–71 (×1) |

\* ALARME has no keymap instruments; the keymap heuristic classes it as v1, so tests force `{ variant: 'v2' }` to exercise the override.

Tests verify:

- HSQ decompression produces exactly the declared byte count.
- `ALARME.HSQ` and `ALARME.HA2` decompress to byte-identical output (extension is a hint only).
- Header parse fields (tracks, instruments, speed, loop, AGD) match known-good values.
- Rendered streams produce audible output through the real wasm chip for all four samples.
- `WORMINTR.AGD` starts with `0x105 = 1` and includes writes to voices 9+.
- Songs with slide instruments emit many intermediate 0xB0 writes (slide simulation).

The real-file tests skip (with a warning) when the files aren't present, so the suite stays green for anyone cloning without the game data.

## References

- [AdPlug](https://github.com/adplug/adplug) — `src/herad.cpp` and `src/herad.h` are the canonical reference implementation. We matched compression, parser, and renderer against it.
- [ModdingWiki: HERAD](https://moddingwiki.shikadi.net/wiki/HERAD) — community spec for the compression layer and the binary format; written up by people who reverse-engineered the engine.

## Maintainer notes

Update this document when:

- The decompression function changes behaviour (end-of-stream handling, truncated-input semantics, reference-copy semantics for overlapping ranges).
- The header layout or instrument layout reveals a new variant in the wild that required adjusting the parser.
- The renderer picks up new features from the AdPlug reference (rhythm-mode percussion, detune fields, SQX compression, etc.) or diverges intentionally.

If the description here diverges from the code, the code is the source of truth and the doc is the bug.
