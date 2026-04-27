# ASC Sound Master (.asc)

## What it is

**ASC Sound Master** is a tracker for the ZX Spectrum's AY-3-8910 / YM2149, written in the early 1990s by **Andrey Sazhnev** ("ASM" / "Sair Soft"). Its module format — the `.asc` file — is one of the canonical tracker formats of the ZX Spectrum demoscene, alongside Pro Tracker, Sound Tracker Pro, and Vortex Tracker. Files from 1992–1996 are still actively traded on AY Riders, ZXAAA, and similar archives.

Unlike the register-dump formats covered in [the AY chip doc](../ay.md), an `.asc` file is **not** a stream of (R, V) pairs the chip can replay directly. It's a packed tracker module: a position list, a pattern table, a bank of instrument samples, a bank of pitch ornaments, and per-channel pattern bytecode. Turning that into AY register writes requires a **replayer** — code that walks the patterns at a fixed tempo, advances per-channel sample/ornament cursors, applies effects, and emits the resulting register state once per frame.

The replayer in cawtooth (`packages/core/src/formats/ay/asc-render.ts`) is a TypeScript port of [ZXTune](https://github.com/vitamin-caig/zxtune)'s `Module::ASCSoundMaster::DataRenderer`, kept as faithful as practical so anyone debugging it can cross-reference the C++ line-by-line.

## Why this is different from .psg / .vtx / .ym

The PSG / VTX / YM formats are **register dumps**: every frame is just 14 bytes (one per AY register), and playback amounts to "write these 14 bytes, wait one frame, repeat". The original tune was authored on some tracker, but by the time the bytes hit disk, the music engine has already collapsed all of its sample / ornament / effect logic into a flat per-frame register stream.

`.asc` files are the original tracker module — the input the tracker's replayer engine consumes at runtime, not its output. They're roughly **10× smaller** than equivalent register dumps because the same 32-line drum sample plays from one shared bank instead of being unrolled into 32 frames worth of register writes per drum hit. The tradeoff: every `.asc` file ships with an implicit dependency on a specific replayer's behaviour, and getting that replayer's quirks wrong produces wrong music.

## How we play it

Two-step pipeline:

1. `parseAsc(bytes)` walks the on-disk structure and returns an `AscModule` — header, positions, samples, ornaments, patterns. No music interpretation; this is purely a structural decode.
2. `renderAsc(module)` runs the per-tick state machine for one full pass through the position list and emits a `RegisterEventStream` of AY register writes. The result is the same shape `parsePsg` / `parseVtx` / `parseYm` produce, so it plugs into `AyPlayer.loadStream` unchanged.

For the common case (auto-detect + play), `parseAscToAySong` bundles both steps and `CawtoothPlayer.load()` dispatches to it on `.asc` filenames or from the unified loader.

## Binary structure

All multi-byte integers are **little-endian**. The format ships in two header variants — Ver0 (older, no explicit loop point) and Ver1 (modern, with a Loop byte). They share every field except the Loop byte, so we read both and accept whichever passes range checks (tempo ∈ [3, 50], loop ∈ [0, 99], length ∈ [1, 100], all positions < 32).

### Ver1 header (10 bytes)

```
offset  size  field
0       1     tempo (ticks per pattern row, 3..50)
1       1     loop (position-list loop point, 0..length-1)
2       2     patterns table offset (file-relative)
4       2     samples table offset
6       2     ornaments table offset
8       1     length (number of positions)
9       N     positions[length]  — pattern indices to play in order
```

### Ver0 header (9 bytes)

Same as Ver1 but with no Loop byte; loop is implicitly 0.

```
offset  size  field
0       1     tempo
1       2     patterns table offset
3       2     samples table offset
5       2     ornaments table offset
7       1     length
8       N     positions[length]
```

### Optional ID block (63 bytes)

Immediately after the position list, an optional metadata block may begin with the literal prefix `'ASM COMPILATION OF '` (19 bytes). When present:

```
offset  size  field
0       19    'ASM COMPILATION OF '
19      20    title (CP1252, space/null-padded)
39      4     ' BY ' delimiter (sometimes 'BY  ' or ' BY ')
43      20    author (CP1252)
```

When absent — older files, stripped containers — both fields surface as empty strings.

### Patterns table

Located at `patternsOffset`. Each entry is **6 bytes**: three little-endian `u16` offsets, one per channel, each relative to `patternsOffset` (not file start). A position byte indexes this table; the format imposes no upper bound on table size beyond the implicit `ASC_MAX_PATTERNS = 32`.

### Samples list

Located at `samplesOffset`. **32 little-endian `u16` offsets**, each relative to `samplesOffset`, pointing at that sample's data. Samples are indexed 0..31 from the bytecode.

### Sample data

Each sample is a list of **3-byte lines** walked until a "finished" flag fires (or the file ends, or 150 lines are consumed — whichever comes first). The line layout:

```
byte 0:  BEFaaaaa
         B = 1: this line is the loop start point
         E = 1: this line is the loop end point
         F = 1: this line is the last line of the sample
         a (5 bits, signed): "adding" — a per-line delta applied to either
                             noise period or envelope tone (see replay
                             engine notes)

byte 1:  signed 8-bit tone deviation (added to the channel's tone period
         each tick this line is active)

byte 2:  LLLLnCCt
         L (4 bits): volume level 0..15
         n (1 bit): noise mask (1 = noise disabled this line)
         C (2 bits): command — 0=none, 1=enable envelope, 2=volume slide
                     down, 3=volume slide up
         t (1 bit): tone mask (1 = tone disabled this line)
```

A sample with no `B` flags loops from line 0; with no `E` flags it loops at the last line. The `F` flag terminates parsing — the line that carries it is the final line of the sample.

### Ornaments list

Located at `ornamentsOffset`. **32 little-endian `u16` offsets**, same convention as the samples list.

### Ornament data

Each ornament is a list of **2-byte lines** walked the same way (up to 30 lines, terminated by the F flag).

```
byte 0:  BEFooooo
         B / E / F flags as above
         o (5 bits, signed): noise period offset, applied each tick

byte 1:  signed 8-bit semitone offset, added to the channel's base note
```

Samples carry timbre and amplitude shape; ornaments carry pitch movement (arpeggios, vibratos, drop slides). Most channels reference both — sample for "what it sounds like", ornament for "what notes it plays around the base pitch".

### Pattern data — bytecode per channel

Each pattern's three channel offsets point at independent **bytecode streams** that the replayer walks in lockstep. A row of the pattern is one beat; a channel with a non-zero "skip period" simply waits a row; channel 0 hitting `0xFF` ends the pattern.

The command table:

| Range       | Command          | Operands                 | Effect                                    |
| ----------- | ---------------- | ------------------------ | ----------------------------------------- |
| `0x00–0x55` | Note             | (+1 byte if envelope on) | Set note 0..0x55, terminate row           |
| `0x56–0x5D` | Stop             | —                        | End row, keep cell mutations              |
| `0x5E`      | Break sample     | —                        | Halt the running sample, end row          |
| `0x5F`      | Rest             | —                        | Disable channel, end row                  |
| `0x60–0x9F` | Skip period      | —                        | Skip `cmd-0x60` rows after this one       |
| `0xA0–0xBF` | Sample select    | —                        | Channel sample = `cmd-0xA0`               |
| `0xC0–0xDF` | Ornament select  | —                        | Channel ornament = `cmd-0xC0`             |
| `0xE0`      | Vol 15 + env on  | —                        | Volume = 15, enable envelope              |
| `0xE1–0xEF` | Vol N + env off  | —                        | Volume = `cmd-0xE0`, disable envelope     |
| `0xF0`      | Noise            | byte                     | Set channel base noise period             |
| `0xF1`      | Cont. sample     | —                        | Don't reset sample cursor on next note    |
| `0xF2`      | Cont. ornament   | —                        | Don't reset ornament cursor on next note  |
| `0xF3`      | Cont. both       | —                        | Both of the above                         |
| `0xF4`      | Tempo            | byte                     | Override pattern-row tempo                |
| `0xF5`      | Glissade down    | byte                     | Continuous tone slide ±16 × byte per tick |
| `0xF6`      | Glissade up      | byte                     | Same, opposite sign                       |
| `0xF7`      | Slide w/ sample  | signed byte              | Stepped slide; also sets cont-sample      |
| `0xF8`      | Envelope shape 8 | —                        | R13 = 8                                   |
| `0xF9`      | Slide standalone | signed byte              | Stepped slide N steps                     |
| `0xFA`      | Envelope shape A | —                        | R13 = 10                                  |
| `0xFB`      | Volume slide     | byte                     | Period (low 5 bits) + direction (bit 5)   |
| `0xFC`      | Envelope shape C | —                        | R13 = 12                                  |
| `0xFD`      | (unused)         | —                        | Falls through                             |
| `0xFE`      | Envelope shape E | —                        | R13 = 14                                  |
| `0xFF`      | End of pattern   | —                        | (Channel 0 only; ends the pattern)        |

Notes on the note byte:

- When the channel has envelope **active** (bit 4 of its R8/R9/R10 amplitude register is set, via the `0xE0` command), a note byte is followed by **one additional byte** that programs R11 (envelope period low byte) — the tracker leans on this for "envelope-pitched" sounds, where the envelope retriggers per note at a frequency related to the note itself.
- A note that arrives while a stepped slide (`0xF7` / `0xF9`) is pending becomes the slide's **target note**, not the channel's immediate note. The replayer accumulates `sliding` toward the target over `N` ticks, then snaps `note := target` and zeros the slide state. This is the "SLIDE_NOTE" upgrade in the ZXTune replayer.

## Replay engine

The replayer ticks at **50 Hz** (the ZX Spectrum's frame interrupt) and runs `tempo` ticks per pattern row. Default tempo is 6 (so 8.33 rows per second); `0xF4` commands change it persistently.

### Per-channel state

```
enabled, envelope, breakSample        — current mode flags
volume, volumeAddon                   — base + slide accumulator
volSlideDelay, volSlideAddon, volSlideCounter — volume-slide ramp state
baseNoise, currentNoise               — noise period base + per-tick accumulator
note, noteAddon                       — base semitone + ornament-applied delta
sampleNum, currentSampleNum, posInSample
ornamentNum, currentOrnamentNum, posInOrnament
toneDeviation                         — per-tick tone period delta from sample
slidingSteps, sliding, glissade,
slidingTargetNote                     — stepped-slide / glissade state
```

Plus a track-level `envelopeTone` (the running 16-bit R11/R12 value).

### Tick 0 of each row

For each channel:

1. Reset `volSlideCounter` and `slidingSteps` to 0.
2. Apply the cell's commands in order: envelope shape / tone, envelope on/off, noise, glissade / slide setup, volume-slide setup, break-sample, ornament select, sample select, note (with the SLIDE_NOTE upgrade if a slide command is also present).
3. If the cell carried a **note** (and not just a slide), trigger a **reload-note** sequence: reset `currentNoise` to `baseNoise`; if no `cont-sample`, reset `posInSample` / `volumeAddon` / `toneDeviation` and clear `breakSample`; if no `cont-ornament`, reset `posInOrnament` / `noteAddon`. Volume can be updated last.

### Every tick (including tick 0)

For each channel that's enabled:

1. **Volume slide:** decrement `volSlideCounter`; on hitting 1, add `volSlideAddon` to `volumeAddon` and reload the counter. Also accumulate the sample line's `volSlide` (`-1` / 0 / `+1`) per tick. Clamp `volumeAddon` to `[-15, 15]`.

2. **Tone:** accumulate `toneDeviation += sampleLine.toneDeviation` and `noteAddon += ornamentLine.noteAddon` (the latter wraps as `int8`). Compute `halfTone = clamp(int8(note + noteAddon), 0, 0x55)`. Look up `TABLE_ASM[halfTone]` and add `toneDeviation + sliding/16`. Mask to 12 bits → R0/R1, R2/R3, R4/R5.

3. **Amplitude:** `amp = (volume + 1) × clamp(volumeAddon + sampleLine.level, 0, 15) / 16`. If `envelope && sampleLine.enableEnvelope`, set bit 4 (use envelope) on top of the 4-bit amplitude → R8 / R9 / R10.

4. **Mixer (R7) and noise (R6):** if `sampleLine.toneMask`, set the channel's tone-disable bit; otherwise clear it. If `sampleLine.noiseMask && sampleLine.enableEnvelope`, the sample's `adding` field nudges `envelopeTone` (R11/R12); otherwise it nudges `currentNoise`. If `!sampleLine.noiseMask`, write R6 = `(currentNoise + sliding/256) & 0x1f` and clear the channel's noise-disable bit; otherwise set the noise-disable bit.

5. **Sliding update:** if `slidingSteps > 0`, decrement; on hitting 0 with a target note pending, snap `note := slidingTargetNote` and zero `sliding` / `glissade`. Always accumulate `sliding += glissade`.

6. **Cursor advance:** post-increment `posInSample`. If the old value was at the loop-end limit, either wrap to `posInSample := loop` (no break) or — if `breakSample` is set and we've fallen off the end of the data — set `enabled := false`. Same wrap logic for `posInOrnament` (without the break-sample exit).

### Tone-period table — `TABLE_ASM`

The 96-entry frequency table comes verbatim from ZXTune's `module/players/aym/freq_tables.cpp`. Entry 0 = note 0 (low C) = 0xEDC, entry 95 = top note = 0x010. The replayer indexes this with the post-clamp `halfTone`, so the highest playable note is `0x55` (85), well under the table's 96-entry bound.

The table is calibrated to the **ZX Spectrum's 1.7734 MHz** clock. Cawtooth tags ASC songs with that clock unconditionally.

### Force-write semantics for R13

Writing R13 retriggers the AY's envelope counter on every write — even with the same value. The diff-based event emitter would naturally suppress re-writes, so the renderer maintains a per-tick "force-write" mask: any cell that carries an envelope-shape command flags R13 (and any cell that carries an envelope-tone command flags R11/R12) so they're emitted regardless of value.

## What we don't model

- **Loop position semantics.** The render output represents one full pass through the position list, with `loop=true` flagging the player to loop back to event 0. ASC's `module.loop` (the Ver1 header byte) specifies the position to loop *from*, not to the start — a tune with `loop=4` is supposed to play positions 0..N-1 then loop 4..N-1. We currently replay the whole intro on each loop. Most tunes use `loop=0`, so this is a small visible artifact in practice; fixing it requires either two-pass rendering or a richer stream loop point than `RegisterEventStream` exposes today.
- **Out-of-range sample / ornament references.** If the bytecode selects sample 31 but the file's samples list only points at valid data for samples 0..15, the parser inserts a silent stub line. Audible silence rather than a parser fault. ZXTune does the same.
- **Pattern lengths above 64 lines.** The format permits up to 64 (`ASC_MAX_PATTERN_LINES`); files that exceed it would be truncated. No real-world `.asc` file in the wild does this.
- **Z80-side custom replayers.** Some `.asc` files in the wild have been patched / extended by hand-written Z80 code that runs alongside the standard ASC engine — additional drum samples, custom command codes, etc. Our replayer follows the *baseline* bytecode and ignores any such extensions; the affected channels in those rare files will sound off.

## References

- [ZXTune source — ASC parser](https://github.com/vitamin-caig/zxtune/blob/master/src/formats/chiptune/aym/ascsoundmaster.cpp)
- [ZXTune source — ASC replayer](https://github.com/vitamin-caig/zxtune/blob/master/src/module/players/aym/ascsoundmaster.cpp)
- [ZXTune source — frequency tables](https://github.com/vitamin-caig/zxtune/blob/master/src/module/players/aym/freq_tables.cpp)
- [The AY chip doc in this repo](../ay.md) — register file, mixer layout, envelope shapes
- [AY Riders archive](http://aymarchive.org/) — ASC corpus

## Maintainer notes

- The replayer mirrors ZXTune line-by-line on purpose. When a bug surfaces, the fastest path to a fix is to read the corresponding C++ in `Module::ASCSoundMaster::DataRenderer::SynthesizeChannel` and check what we missed — that's how the SLIDE_NOTE upgrade and the R13 force-write semantics were caught during initial development. Resist the temptation to "TypeScript-ify" the structure; clarity-of-mapping outweighs idiomatic JS here.
- C++ semantics that bit hard during the port: `Math::Clamp<int8_t>(value, 0, 0x55)` truncates `value` to `int8_t` *first*, then clamps; integer division is truncate-toward-zero (use `Math.trunc(a / b)`, not `a / b | 0` — the latter is wrong for `a < 0`); post-increment in `if (i++ >= limit)` checks the **old** value of `i`. `int8(noteAddon + ornamentLine.noteAddon)` is a load-bearing wrap-around, not a defensive clamp — without it, long ornaments accumulate beyond `int8` range and break the halfTone clamp.
- The `adding` field on a sample line goes into either noise period or envelope tone depending on `(noiseMask && enableEnvelope)`. The decision is per-tick, per-channel, per-sample-line; getting the branch wrong silently misroutes vibrato or drum tonality.
- `parseSample` forces `loopLimit = max(parsedLoopLimit, lines.length - 1)` so samples without an explicit loop-end flag wrap at the last line. This is fine for ZX-tracker content; if a real-world file ever needs the tail-after-loop-end behavior (sample with `IsLoopEnd` mid-data and trailing one-shot lines under `breakSample`), revisit this.
- ASC has no fixed magic — detection is by filename extension `.asc`. A file dropped in without an extension would need an explicit `format: 'asc'` to `CawtoothPlayer.load()`. If we ever want content-sniffing, the most reliable signal is the tempo byte (3..50) followed by three plausible 16-bit offsets, but it's a heuristic — keep the explicit-format escape hatch available.
- The `.asc` extension is unrelated to the **Asciidoc** documentation format that uses `.asc` / `.adoc`. Don't be surprised if a content-sniffing tool you don't control fights you on this; pass `format: 'asc'` explicitly when running tests through such tools.
