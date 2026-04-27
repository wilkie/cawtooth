# AY-3-8910 / YM2149

This document covers the **chip family** plus the three register-dump
container formats we currently parse: `.psg`, `.vtx`, and `.ym`. Each
container ultimately resolves to a sequence of register writes against
the same emulator, so they share the same player (`AyPlayer`) and only
differ in how the bytes on disk are framed and compressed. The
Z80-bytecode `.ay` format (the AY equivalent of PSID) is not yet
implemented — see Phase 3 below.

## What it is

The General Instrument **AY-3-8910** is a 1978 three-channel
"Programmable Sound Generator" (PSG) — a simple, cheap chip that
defined the sound of an entire generation of 8-bit and 16-bit home
computers and arcade machines. Its three square-wave tone channels,
shared noise generator, shared envelope generator, and 16-volume DAC
became the lingua franca of European chiptune music for a decade.

Notable hosts and clock rates:

| Host                  | Clock      | Notes                               |
| --------------------- | ---------- | ----------------------------------- |
| ZX Spectrum 128       | 1.7734 MHz | Two AY-3-8912 chips on the +2A/+3   |
| Atari ST              | 2.0 MHz    | YM2149 (Yamaha second-source)       |
| Amstrad CPC           | 1.0 MHz    | AY-3-8912 (cost-reduced AY)         |
| MSX                   | 1.7898 MHz | YM2149 in most models               |
| Intellivision         | 0.894 MHz  | AY-3-8914 (variant register layout) |
| Various arcade boards | varies     | Konami, Capcom, Sega System 1, etc. |

The **Yamaha YM2149** is a near-perfect second-source clone with one
substantive difference: it has 32 envelope levels instead of the AY's
16-doubled (the AY's hardware envelope counter ticks at half speed and
each step is duplicated, so resolution is effectively 16). Music
written for the YM uses this finer DAC for smoother volume sweeps; AY
playback of YM-targeted material sounds slightly stepped.

The **AY-3-8912** and **AY-3-8914** are pin-compatible variants with
fewer I/O ports (or different I/O port semantics on the 8914). For
sound-generation purposes they are identical to the AY-3-8910 and
share its DAC table.

## Chip overview

### Register file

The AY exposes **16 registers** addressed by writing the register
number to the address latch and the value to the data port. We model
this directly: `writeRegister(reg, value)` updates a 16-byte register
file and re-derives the affected emulator state.

| Reg | Bits    | Purpose                                                         |
| --- | ------- | --------------------------------------------------------------- |
| R0  | 8       | Channel A tone period, low byte                                 |
| R1  | 4 (low) | Channel A tone period, high nibble                              |
| R2  | 8       | Channel B tone period, low byte                                 |
| R3  | 4 (low) | Channel B tone period, high nibble                              |
| R4  | 8       | Channel C tone period, low byte                                 |
| R5  | 4 (low) | Channel C tone period, high nibble                              |
| R6  | 5 (low) | Noise period                                                    |
| R7  | 8       | Mixer + I/O direction (see below)                               |
| R8  | 5 (low) | Channel A amplitude (bit 4 = "use envelope", bits 0–3 = volume) |
| R9  | 5 (low) | Channel B amplitude                                             |
| R10 | 5 (low) | Channel C amplitude                                             |
| R11 | 8       | Envelope period, low byte                                       |
| R12 | 8       | Envelope period, high byte                                      |
| R13 | 4 (low) | Envelope shape (writing **always** restarts the envelope)       |
| R14 | 8       | I/O port A — not used for sound                                 |
| R15 | 8       | I/O port B — not used for sound                                 |

### R7 mixer layout

Bit 0 = tone A disable, bit 1 = tone B disable, bit 2 = tone C
disable. Bits 3–5 = noise A/B/C disable, same convention. Bits 6–7
control I/O port direction (0 = input, 1 = output) — irrelevant for
sound but standard practice is to set them to input (`0xC0` masked off
the data bits) so the host's keyboard / mouse scanning still works.

A bit set to **1 disables** the corresponding source. A channel with
both tone and noise disabled is silent. Many sound effects mix tone
and noise on the same channel by clearing both disable bits.

### Tone period to frequency

```
freq_hz = clock_hz / (16 * tone_period)
```

`tone_period` is 12 bits, so the lowest tone is `clock / (16 * 4095)`
and the highest is `clock / 16`. At ZX clock (1.7734 MHz) that's
~27 Hz to ~111 kHz; the audible band is roughly tone_period 50–4000.

### Envelope shapes

R13 selects one of 16 envelope shapes (low 4 bits) describing the
envelope counter's behaviour:

```
0x00–0x03:  \___    (down once, hold low)
0x04–0x07:  /___    (up once, hold low)
0x08:       \\\\    (sawtooth down, repeating)
0x09:       \___    (down once, hold low)
0x0A:       \/\/    (triangle down)
0x0B:       \¯¯¯    (down once, hold high)
0x0C:       ////    (sawtooth up, repeating)
0x0D:       /¯¯¯    (up once, hold high)
0x0E:       /\/\    (triangle up)
0x0F:       /___    (up once, hold low)
```

A channel uses the envelope by setting bit 4 of its R8/R9/R10 amplitude
register; the low 4 bits are then ignored.

## Our implementation

Cawtooth uses [Ayumi](https://github.com/true-grue/ayumi) by Peter
Sovietov as the chip emulator. Ayumi is a single-file C library that
models the AY's DAC, panning, and envelope curves natively, then
applies 8× internal oversampling and a 192-tap polyphase FIR before
decimating to the host audio rate. DC removal is enabled by default
(removes the slow drift Ayumi's mixer accumulates from the DAC's
non-zero idle level).

### What works (Phase 1 — chip)

- Both **AY-3-8910** (16-step DAC) and **YM2149** (32-step DAC)
  variants, selectable via the `model` option.
- The full **16-register file**, including envelope shape restart
  semantics on R13 writes.
- Configurable **host clock rate** — defaults to ZX Spectrum
  (1.7734 MHz). Constants exposed for ZX, Atari ST (2 MHz),
  Amstrad CPC (1 MHz), and MSX (1.7898 MHz).
- **Per-channel pan** — defaults to ABC stereo (A=L, B=center, C=R),
  the standard ZX Spectrum convention. Caller can pass any
  `[number, number, number]` triple in `[0, 1]` for arbitrary stereo
  fields (e.g. ACB, mono, mid-side).
- **Per-voice channel taps** for scope visualization — pre-pan,
  pre-mix DAC samples for each of the three tone channels.

### What works (Phase 2 — formats)

- **`.psg`** parser — simple uncompressed register-dump format with
  one-byte run-length opcodes (`0xFF` = end-of-frame, `0xFE n` = skip
  `4·n` frames, `0xFD` = end-of-music).
- **`.vtx`** parser — Vortex Tracker container with a binary header,
  five CP1251 metadata strings, and an LH5-compressed column-major
  register dump (14 registers per frame).
- **`.ym`** parser — Atari ST format. Handles YM5! / YM6! with the
  standard "interleaved" attribute bit set and the LHA "-lh5-"
  wrapper most files in the wild use. See "What we don't model"
  below for digidrum and YM3 caveats.
- **`AyPlayer.loadStream`** — the same transport surface as
  `OplPlayer.loadStream` (play / pause / stop / progress / ended /
  channel taps). Direct `writeRegister` and `loadStream` coexist on
  the same player; the tone demo uses the former, format playback
  uses the latter.
- **`CawtoothPlayer.load()` auto-dispatch** — magic-byte sniffing
  for PSG and YM5/YM6, lowercase `ay` / `ym` for VTX, plus filename
  fallback for LHA-wrapped YM and any of the three when the bytes
  themselves are ambiguous.

### What's coming later (Phase 3)

- `.ay` — Z80-bytecode music format (the AY equivalent of PSID).
  Requires vendoring a Z80 emulator alongside Ayumi, parallel to the
  fake6502+reSID setup for PSID. Likely lands as a separate
  `AyTunePlayer` class (mirroring `PsidPlayer`) since the wasm
  module is structurally different.
- VGM AY-only register dumps — the spec is well-documented, and the
  byte-for-byte register stream maps cleanly onto our existing
  sequencer; landing it once we have a real reason (e.g. a corpus
  test or a user request).

### What we don't model

- **I/O ports** (R14, R15). Host applications that scan the keyboard
  via the AY's I/O ports won't get any feedback through the chip — we
  accept R14/R15 writes silently and reads always return 0. Sound
  formats never depend on I/O state, so this is fine.
- **AY-3-8914 register layout**. The Intellivision variant has
  registers in a different order. No format we plan to support
  targets it.
- **Sub-sample tone toggles**. The per-voice scope tap snapshots the
  tone state at output rate, not at the chip's internal 8× oversampled
  rate. The stereo mix is FIR-decimated and accurate; the per-voice
  view is faithful for visualisation but slightly undersampled
  compared to the actual mixer input.
- **YM digidrum samples**. YM5/YM6 files can carry raw PCM samples
  triggered by a special encoding in R13. We parse past the sample
  directory and data so the file loads, but the drum hits themselves
  don't reach the chip. Tunes that lean on digidrums sound thinner
  than they should; melodic content is unaffected.
- **YM3 / YM3b raw variants**. The pre-LHA YM formats are
  uncompressed 14-bytes-per-frame dumps with no inner header; we
  don't probe for them yet. They're rare in modern archives.
- **VTX layout / loop-frame replay**. We surface the file's
  `loop=true` flag and respect the caller's loop choice, but ignore
  the layout byte (mono vs. ABC vs. ACB stereo) — `AyPlayer` applies
  its own pan defaults. The loop start frame from the header isn't
  used; loops restart from event 0.

## .psg binary structure

```
offset  size  field
0       4     magic = 'P','S','G',0x1A
4       1     version (informational; commonly 0x10)
5       1     frame rate Hz (0 = default 50)
6       10    reserved (zero-padded)
16+     ...   payload of one-byte opcodes
```

Payload opcodes:

| Opcode   | Meaning                                                        |
| -------- | -------------------------------------------------------------- |
| `0xFD`   | End of music — parser stops.                                   |
| `0xFE n` | Wait `n × 4` frames before the next event.                     |
| `0xFF`   | Wait one frame (advance to the next tick).                     |
| `R V`    | Write byte `V` to register `R` (`R` masked to low 4 bits). All |
|          | (R, V) pairs between two `0xFF` markers happen on the same     |
|          | tick.                                                          |

The format encodes no metadata — title, author, model, and clock are
not present. We default to AY-3-8910 at the ZX Spectrum clock; callers
that know better can override at the player layer.

## .vtx binary structure

All multi-byte integers are **little-endian**.

```
offset  size  field
0       2     magic = 'a','y'  → AY-3-8910
              or     'y','m'  → YM2149
2       1     channel layout (0=mono, 1..6 = stereo permutations)
3       2     loop start frame index
5       4     chip clock Hz
9       1     interrupt frequency Hz (50 PAL / 60 NTSC)
10      2     year (informational)
12      4     decompressed payload size in bytes
16      ...   five null-terminated CP1251 strings:
                title, author, program, tracker, comment
...     ...   LH5-compressed payload — a column-major register table
              of 14 columns (R0..R13) × N rows (frames). Decompressed
              size = 14 * numFrames.
```

The compressed payload is a raw LH5 bitstream (no LHA wrapper).
Decoding produces `column[k][i]` = the value the original program
held in register `k` at frame `i`. We de-interleave into a row-major
event stream, emitting only writes whose value differs from the
previous frame.

## .ym binary structure

YM is the Atari ST tracker format. Almost every file in the wild is
wrapped in an LHA archive whose single member is the raw YM5/YM6
register dump compressed with **LH5**. We unwrap level-0 and level-1
LHA headers; level-2 headers are uncommon for YM files and not yet
supported.

The inner YM header is **big-endian** (note the difference from VTX):

```
offset  size  field
0       4     magic = 'Y','M','5','!'  or 'Y','M','6','!'
4       8     check string = 'L','e','O','n','A','r','D','!'
12      4     number of frames (BE u32)
16      4     attribute flags (BE u32) — bit 0: interleaved storage
20      2     digidrum sample count (BE u16)
22      4     chip clock Hz (BE u32)
26      2     tick rate Hz (BE u16) — 50 typically, 60 occasionally
28      4     loop start frame (BE u32)
32      2     extra-info size in bytes (BE u16; we skip them)
```

Following the fixed header, in order:

- Optional digidrum directory: `digidrumCount × 4` bytes of BE u32
  sample sizes, then concatenated PCM data.
- Three null-terminated Windows-1252 strings: song name, author,
  comment.
- `numFrames × 16` bytes of register data. Interleaved layout (column
  k spans `numFrames` consecutive bytes) when attribute bit 0 is set,
  frame-major (16-byte rows) when clear.
- Trailing 4-byte sentinel `'E','n','d','!'` (we don't enforce it —
  some re-packers strip it).

We track only the lower 14 registers for change-detection — R14 and
R15 are I/O ports / digidrum control that AyumiChip doesn't model.

## References

- [Ayumi source + design notes](https://github.com/true-grue/ayumi)
- [AY-3-8910 datasheet (Grauw mirror)](https://map.grauw.nl/resources/sound/generalinstrument_ay-3-8910.pdf)
- [Vortex Tracker / VTX format](https://bulba.untergrund.net/vortex_e.htm)
- [YM file format (Leonard Oxaal)](http://leonard.oxg.free.fr/ymformat.html)
- [LHA / LZH file format spec](https://github.com/jca02266/lha)
- [VGM format (covers AY)](https://vgmrips.net/wiki/VGM_Specification)

## Maintainer notes

- Ayumi's `ayumi_set_envelope_shape` always restarts the envelope
  counters — matching real AY hardware behaviour, where any write to
  R13 (even with the same value) restarts the envelope. Don't add a
  "dedupe identical R13 writes" optimisation; it's a feature, not a
  bug.
- Resetting the chip needs to reset Ayumi's DC filter delay line (1024
  samples) and FIR delay lines, not just the register file. The
  wrapper does this by re-running `ayumi_configure` from cached
  parameters; a register-only zero leaves the DC filter biased and
  produces an audible thump. See `cawtooth_ay_reset` in the wrapper.
- Per-channel scope output uses the snapshot pattern documented in
  `ayumi-wrapper.c` (`generate_channels`). It's a deliberate
  simplification — patching ayumi.c to expose pre-mix per-channel
  values during the FIR loop would be more accurate but adds
  maintenance burden. Revisit if scope artifacts become a problem in
  practice.
- The Ayumi pin (`tools/versions.sh`, `AYUMI_COMMIT`) is a moving
  target on the upstream `master` branch. Verify the chip tests still
  pass after a bump; the most likely source of breakage is internal
  field reordering in `struct ayumi`, which would silently break the
  per-channel snapshot in `cawtooth_ay_generate_channels`.
- The LH5 decoder under `formats/ay/lh5.ts` uses a tree-walk Huffman
  decoder rather than the table-based version in the LHA reference.
  It's slower per-byte but markedly easier to verify against the
  spec; AY payloads top out around 100 KiB, so the speed delta is
  invisible. Rewriting to a table form is fine if a profiler ever
  pinpoints it.
- Test coverage for `lh5.ts` includes a hand-built non-singleton
  Huffman block (`decodes a non-singleton c_table built from real
canonical Huffman codes`) — it's the canary for any regression in
  `buildTree`'s canonical-code assignment, which is the part of the
  decoder most likely to silently break.
- VTX strings are decoded as **CP1251** (Cyrillic Windows codepage)
  to match the format's ZX Spectrum demoscene origins. YM strings
  use **CP1252** (Western Europe), matching Atari ST defaults. Don't
  unify them — round-tripping ASCII through both works, but Cyrillic
  metadata is unreadable through CP1252 and vice versa.
