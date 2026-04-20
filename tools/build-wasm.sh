#!/usr/bin/env bash
# Build Nuked-OPL3 + wrapper.c into a standalone WASM module.
# Output: packages/core/wasm/nuked-opl3.wasm

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

EMSDK_DIR="$SCRIPT_DIR/emsdk"
NUKED_DIR="$SCRIPT_DIR/nuked-opl3"
NATIVE_DIR="$REPO_ROOT/packages/core/native"
WASM_DIR="$REPO_ROOT/packages/core/wasm"

if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
  echo "Error: Emscripten not installed. Run: tools/setup-emscripten.sh"
  exit 1
fi

if [ ! -f "$NUKED_DIR/opl3.c" ]; then
  echo "Error: Nuked-OPL3 not vendored. Run: tools/setup-nuked.sh"
  exit 1
fi

# Activate the pinned Emscripten toolchain.
# shellcheck source=/dev/null
source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1

mkdir -p "$WASM_DIR"

EXPORTS='[
  "_cawtooth_opl_create",
  "_cawtooth_opl_destroy",
  "_cawtooth_opl_reset",
  "_cawtooth_opl_write",
  "_cawtooth_opl_generate",
  "_cawtooth_opl_chip_size",
  "_malloc",
  "_free"
]'

echo "==> Compiling Nuked-OPL3 + wrapper to WASM"
emcc \
  -O3 \
  -DNDEBUG \
  -I "$NUKED_DIR" \
  "$NUKED_DIR/opl3.c" \
  "$NATIVE_DIR/wrapper.c" \
  -o "$WASM_DIR/nuked-opl3.wasm" \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=1048576 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/nuked-opl3.wasm"
ls -lh "$WASM_DIR/nuked-opl3.wasm"
