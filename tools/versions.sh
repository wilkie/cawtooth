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

# AdPlug version used for the HERAD A/B harness
# (tools/adplug-capture/). Not vendored — provided by the system package
# (Debian: libadplug-dev). The harness is optional; the main test suite
# skips gracefully when the compiled binary isn't present. Recorded here so
# future contributors know which reference version we validated the
# TypeScript HERAD renderer against.
ADPLUG_VERSION_EXPECTED="2.3.3"
