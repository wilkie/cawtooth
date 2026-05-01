# Cawtooth

[![ci](https://github.com/wilkie/cawtooth/actions/workflows/ci.yml/badge.svg)](https://github.com/wilkie/cawtooth/actions/workflows/ci.yml)

![The cawtooth logo which is the head of a crow looking side-eyed at the camera where its profile is roughly triangular and forms the last and third part of a sawtooth wave stylized together. The term 'cawtooth' appears underneath in a somewhat futuristic, sans-serif font.](cawtooth_logo.png)

This is a collection of libraries to handle different chiptune formats and an encompassing
player.

## Supported Formats

- **DRO**: The DOSBox Raw OPL format which just describes the OPL2/3 AdLib commands that were, typically, captured during emulation, although this format is a versatile format to which we can export most other OPL formats.
- **IMF**, **WLF**: Id Software Music Format housing OPL2 AdLib commands from earlier Id Software games such as Commander Keen and Wolfenstein 3D
- **HSQ**, **SQX**, **AGD**, **HA2**: Cryo's HERAD music format that was used to sequence OPL2/3 AdLib music in games such as Dune, Megarace, and KGB.
- **SID**: The PSID format which contains Commodore 64 instructions that are emulated to produce music for the SID chip.
- **AY-3-8910 / YM2149**: chip support for the General Instrument PSG used by the ZX Spectrum 128, Atari ST, Amstrad CPC, MSX, and many arcade machines. The library ships the chip emulator plus parsers for the three major register-dump container formats:
  - **PSG**: the simple uncompressed ZX Spectrum register-dump format used by AY Emul and many demoscene utilities.
  - **VTX**: the Vortex Tracker container — column-major register dump compressed with LH5, the de-facto AY tracker format.
  - **YM**: the Atari ST tracker format (YM5/YM6 inside an LHA wrapper, also LH5-compressed). Digidrum samples are recognized but not played back.
  - The Z80-bytecode `.ay` format remains a follow-up.

## Installation

```
npm install cawtooth
```

The package ships ESM + CJS bundles, generated `.d.ts` files, the bundled
AudioWorklet processors (under `cawtooth/worklet/opl`, `cawtooth/worklet/sid`,
`cawtooth/worklet/psid`, `cawtooth/worklet/ay`), and the WebAssembly chip
emulators (under `cawtooth/wasm/*.wasm`). Most browser bundlers can resolve
these via the `?url` import suffix — see the examples for the exact wiring.

## Examples

These are some general examples using the library.

### Loading and Playback

`CawtoothPlayer` is the high-level entry point: it auto-detects the format
from the bytes (or filename), parses the file, and returns a ready-to-play
`Player`.

```ts
import { CawtoothPlayer } from 'cawtooth';
import oplWorkletUrl from 'cawtooth/worklet/opl?url';
import oplWasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

const factory = await CawtoothPlayer.init({
  formats: {
    opl: { workletUrl: oplWorkletUrl, wasmUrl: oplWasmUrl },
  },
});

// `bytes` is an ArrayBuffer — typically from a fetch() or <input type="file">.
const player = await factory.load(bytes, { filename: 'song.dro' });
player.output.connect(player.audioContext.destination);
await player.resumeAudio(); // wakes the AudioContext on first user gesture
player.play(); // players are paused-at-zero after load()
```

Every `Player` exposes the same transport surface — `play()`, `pause()`,
`stop()` — plus `onProgress`, `onEnded`, and `onChannels` for hooking up
progress UIs and per-voice oscilloscopes.

### Format Determination

If you only need the format identifier (e.g. for routing or display) without
constructing a player, use `detectFormat` directly. It sniffs PSID/RSID, DRO,
PSG, raw YM5/YM6, VTX (`ay`/`ym` magic), and HSQ/SQX-compressed HERAD from
magic bytes; for IMF, decompressed HERAD, and LHA-wrapped YM, which need a
hint, it falls back to a filename extension.

```ts
import { detectFormat } from 'cawtooth';

const fmt = detectFormat(new Uint8Array(bytes), 'tune.imf');
// → 'psid' | 'imf' | 'dro' | 'herad' | 'psg' | 'vtx' | 'ym'
```

Inside `CawtoothPlayer.load()` this is the same step that picks the parser
and worklet — calling `detectFormat` ahead of time is purely informational.

### Exporting to PCM/WAV

`renderSidTuneToWav` runs the PSID emulator offline (no AudioWorklet) and
returns a fully-formed WAV file. PSID tunes have no natural end on real
hardware, so `durationSec` is required.

```ts
import { parsePsid, SidTune, createSidplayImports, renderSidTuneToWav } from 'cawtooth';
import sidplayWasmUrl from 'cawtooth/wasm/sidplay.wasm?url';

const wasmBytes = await (await fetch(sidplayWasmUrl)).arrayBuffer();
const wasmModule = await WebAssembly.compile(wasmBytes);
const instance = new WebAssembly.Instance(wasmModule, createSidplayImports());

const song = parsePsid(new Uint8Array(sidBytes));
const tune = new SidTune(instance, song, { sampleRate: 44100 });

const wav = renderSidTuneToWav({
  tune,
  durationSec: 60,
  fadeOutSec: 3,
});
tune.dispose();

const blob = new Blob([wav], { type: 'audio/wav' });
```

For OPL formats, `renderToPcm` / `renderToWav` do the same thing against a
parsed `RegisterEventStream` — see `examples/sid` for a full download flow.

### Exporting to DRO

Every OPL parser produces a format-agnostic `TimedRegisterStream`, and
`parseOpl` is the unified entry point that auto-detects the source
format and dispatches to the right parser/renderer. HSQ/SQX wrappers are
decompressed transparently. Once you have the stream, hand it to any
OPL encoder.

```ts
import { parseOpl, encodeDro } from 'cawtooth';
import { writeFile } from 'node:fs/promises';

const stream = parseOpl(new Uint8Array(hsqBytes));
if (!stream) throw new Error('not an OPL format');

const droBytes = encodeDro(stream); // hardware auto-detected
await writeFile('out.dro', droBytes);
```

The same `stream` re-encodes to IMF (`encodeImf(stream, { ... })`),
plays through `OplPlayer.loadStream(stream.stream, { tickRate: stream.tickRate })`,
or accepts in-between transformations like `dedupRegisterEventStream`
before encoding.

## Development

This is a pnpm workspace monorepo. Source for the library lives in
`packages/core`; each format has a small browser demo under `examples/`;
end-to-end Playwright tests live under `tests/`.

```sh
pnpm install         # install JS dependencies for all workspaces
pnpm build           # build packages/core (lib + worklets + .d.ts)
pnpm test            # Jest unit tests
pnpm typecheck       # tsc across the workspace
pnpm lint            # eslint across the workspace
pnpm format          # prettier --write
```

To run a demo locally, filter by its workspace name (each has its own
Vite dev server on a fixed port):

```sh
pnpm --filter @cawtooth-examples/player dev    # universal player demo
pnpm --filter @cawtooth-examples/imf dev       # IMF / WLF demo
pnpm --filter @cawtooth-examples/sid dev       # PSID / RSID demo
pnpm --filter @cawtooth-examples/ay dev        # PSG / VTX / YM player demo
pnpm --filter @cawtooth-examples/ay-tone dev   # AY-3-8910 / YM2149 chord demo
# …also: dro, herad, sid-tone, tone
```

### Rebuilding the WebAssembly emulators

The compiled `.wasm` artifacts under `packages/core/wasm/` are committed,
so a fresh clone can run `pnpm install` + `pnpm build` without any C
toolchain. Rebuilding from source — required when bumping a vendored
emulator's pinned commit in `tools/versions.sh` — needs Emscripten:

```sh
./tools/setup-emscripten.sh   # one-time: vendor emsdk at the pinned version
./tools/setup-nuked.sh        # vendor Nuked-OPL3 source
./tools/setup-resid.sh        # vendor reSID source
./tools/setup-fake6502.sh     # vendor fake6502 source
./tools/setup-ayumi.sh        # vendor Ayumi source
./tools/build-wasm.sh         # compile all four .wasm targets
```

Each vendored source lives under `tools/<name>/` and is gitignored. The
build script applies any patches under `tools/patches/<name>/` before
compiling.

## Tests

Two layers, separated by what they're cheap enough to assert on.

**Jest unit tests** (`packages/core/src/**/*.test.ts`) run in Node against
the wasm chip emulators directly. They verify exact things — register-write
parser output, sample-accurate event scheduling, decompression byte
round-trips, A/B audio samples against reference players (AdPlug for
HERAD). They are fast and form the bulk of correctness coverage.

```sh
pnpm test                # Jest, ~6s
pnpm --filter cawtooth test:watch
```

**Playwright end-to-end tests** (`tests/specs/*.spec.ts`) run against a
real headless Chromium, drive the actual `AudioWorklet` path, and verify
that audio frames flow. They exist to catch regressions in the worklet /
message-port plumbing that unit tests can't reach — they don't validate
exact waveforms (that's what Jest does), they assert that non-silent
samples arrive within a window after `play()`.

```sh
cd tests
pnpm install-browsers    # one-time: download Chromium (~120 MiB)
pnpm test                # full e2e suite, ~12s
pnpm test:headed         # watch the browser run
pnpm test:ui             # Playwright's interactive runner
```

Both layers run on every push and pull request via `.github/workflows/ci.yml`.

## Acknowledgements

The cawtooth library would not be possible without the use of the following software packages. We
are entirely grateful and indebted to the work these authors have put into the art of software
preservation through emulation, reverse engineering, and documentation.

**Vendored emulator sources** (compiled to WebAssembly and shipped in the package):

- [**Nuked-OPL3**](https://github.com/nukeykt/Nuked-OPL3) — cycle-accurate
  Yamaha YMF262 (OPL3) / YM3812 (OPL2) emulator by Alexey Khokholov
  ("Nuke.YKT"). Drives every OPL-format playback path (IMF, DRO, HERAD).
- [**reSID**](https://en.wikipedia.org/wiki/ReSID) — MOS 6581 / 8580 SID
  chip emulator by Dag Lem. Drives PSID / RSID playback, including the
  per-voice oscilloscope tap (via a small patch exposing `voice_output`).
- [**fake6502**](https://github.com/ivop/fake6502) — MOS 6502 CPU
  emulator originally by Mike Chambers, with the ivop fork's NMOS
  undocumented opcodes and bug fixes. Acts as the 6510 CPU core for PSID
  playback.
- [**Ayumi**](https://github.com/true-grue/ayumi) — General Instrument
  AY-3-8910 / Yamaha YM2149 emulator by Peter Sovietov. Models the
  paired-step AY DAC and the YM's 32-step envelope DAC, with proper
  per-channel pan, DC removal, and 8× FIR-decimated output. Drives all
  ZX Spectrum / Atari ST / Amstrad CPC / MSX chiptune playback.

**Build toolchain**:

- [**Emscripten**](https://emscripten.org/) — the LLVM/Clang → WebAssembly
  toolchain used to compile every native source into the bundled
  `.wasm` modules.

**Reference / cross-check material**:

- [**AdPlug**](http://adplug.github.io/) — long-running OPL-format player
  library; used as the reference implementation against which the HERAD
  renderer is A/B tested.
- [**High Voltage SID Collection**](https://hvsc.c64.org/) (HVSC) — the
  authoritative SID archive. Its `Songlengths.md5` database powers the
  duration / auto-advance feature, and the `md5new` hash spec is
  re-implemented inline in the library.
- [**Modding Wiki**](https://moddingwiki.shikadi.net/) — primary reference
  for IMF, DRO, and adjacent format documentation.
- [**DOSBox**](https://www.dosbox.com/), Id Software, and Cryo Interactive
  for inventing the formats this library can play.

## License

See [LICENSE](LICENSE) for the software license.

## AI Disclosure

This repository is largely produced using the Claude Code AI agent.
