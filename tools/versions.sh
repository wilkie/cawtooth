#!/usr/bin/env bash
# Pinned tool versions. Sourced by setup and build scripts.
# Update deliberately — these lock in the toolchain across machines.

# Emscripten SDK version. This is the compiler toolchain version and
# is what affects build artifacts, so this is the important pin.
EMSCRIPTEN_VERSION="3.1.74"

# emsdk wrapper commit. The emsdk repo itself is a thin bootstrap —
# the compiler it installs is what matters. Leave as "main" unless
# you need to pin the bootstrap tool itself (e.g. CI reproducibility).
EMSDK_COMMIT="main"

# Nuked-OPL3 source commit. Pinned for reproducible WASM artifacts.
# Update intentionally; record the resolved SHA here after setup.
NUKED_OPL3_COMMIT="cfedb09efc03f1d7b5fc1f04dd449d77d8c49d50"

# reSID (Dag Lem's MOS 6581/8580 emulator) source commit. Vendored for
# the SID chip wrapper; see tools/setup-resid.sh.
RESID_COMMIT="ef7873fc8c8379dc14cef8d9ccf9b3d34d0cc439"

# fake6502 (ivop fork of Mike Chambers' MOS 6502 emulator) source commit.
# BSD 2-clause. Used as the 6510 CPU core for PSID playback; see
# tools/setup-fake6502.sh. The ivop fork has all undocumented NMOS opcodes
# and consolidated bug fixes.
FAKE6502_COMMIT="b52676f840983219b0b9baa13f1d0ebc07aac9f9"

# Ayumi (Peter Sovietov's AY-3-8910 / YM2149 emulator) source commit.
# BSD 2-clause. Single-file C emulator that models DC/DAC, panning, and
# both AY-3-8910 (16-step envelope) and YM2149 (32-step envelope)
# variants. Used for ZX Spectrum / Atari ST / Amstrad CPC chiptune
# playback; see tools/setup-ayumi.sh.
AYUMI_COMMIT="07c08b4874c359169e4a028edf73f046d8b763e2"

# AdPlug version used for the HERAD A/B harness
# (tools/adplug-capture/). Not vendored — provided by the system package
# (Debian: libadplug-dev). The harness is optional; the main test suite
# skips gracefully when the compiled binary isn't present. Recorded here so
# future contributors know which reference version we validated the
# TypeScript HERAD renderer against.
ADPLUG_VERSION_EXPECTED="2.3.3"
