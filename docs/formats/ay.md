# AY-3-8910 / YM2149

This document describes the **chip family** rather than a single file
format. Several distinct music formats target the AY-3-8910 (`.vtx`,
`.ym`, `.psg`, `.ay`); each will get its own dedicated section once the
parsers land. For now the chip itself is the foundation.

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

### What works (Phase 1)

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

### What's coming (Phase 2)

- **Format parsers** for the major AY register-dump formats:
  - `.vtx` — Vortex Tracker format (compressed, ZX Spectrum origin)
  - `.ym` — Atari ST tracker format (with optional digi-drum samples)
  - `.psg` — Simple uncompressed register-dump format
  - VGM AY-only files
- A high-level `loadStream` API on `AyPlayer` mirroring `OplPlayer`,
  so the same player drives both direct register writes and
  format-rendered streams.
- Auto-detection through `CawtoothPlayer.load()`.

### What's coming later (Phase 3)

- `.ay` — Z80-bytecode music format (the AY equivalent of PSID).
  Requires vendoring a Z80 emulator alongside Ayumi, parallel to the
  fake6502+reSID setup for PSID. Likely lands as a separate
  `AyTunePlayer` class (mirroring `PsidPlayer`) since the wasm
  module is structurally different.

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

## References

- [Ayumi source + design notes](https://github.com/true-grue/ayumi)
- [AY-3-8910 datasheet (Grauw mirror)](https://map.grauw.nl/resources/sound/generalinstrument_ay-3-8910.pdf)
- [Vortex Tracker / VTX format](https://bulba.untergrund.net/vortex_e.htm)
- [YM file format](http://leonard.oxg.free.fr/ymformat.html)
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
