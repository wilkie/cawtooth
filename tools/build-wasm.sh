#!/usr/bin/env bash
# Build vendored emulator cores + C/C++ wrappers into standalone WASM modules.
# Outputs:
#   packages/core/wasm/nuked-opl3.wasm  (Yamaha OPL2/OPL3)
#   packages/core/wasm/resid.wasm       (MOS 6581/8580 SID, chip only)
#   packages/core/wasm/sidplay.wasm     (fake6502 + reSID + 64KB RAM for PSID playback)
#   packages/core/wasm/ayumi.wasm       (AY-3-8910 / YM2149, chip only)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

EMSDK_DIR="$SCRIPT_DIR/emsdk"
NUKED_DIR="$SCRIPT_DIR/nuked-opl3"
RESID_DIR="$SCRIPT_DIR/resid/src"
FAKE_DIR="$SCRIPT_DIR/fake6502"
AYUMI_DIR="$SCRIPT_DIR/ayumi"
MUSASHI_DIR="$SCRIPT_DIR/musashi"
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

if [ ! -f "$RESID_DIR/sid.cc" ]; then
  echo "Error: reSID not vendored. Run: tools/setup-resid.sh"
  exit 1
fi

if [ ! -f "$RESID_DIR/siddefs.h" ]; then
  echo "Error: reSID siddefs.h missing. Re-run: tools/setup-resid.sh"
  exit 1
fi

if [ ! -f "$FAKE_DIR/fake6502.c" ]; then
  echo "Error: fake6502 not vendored. Run: tools/setup-fake6502.sh"
  exit 1
fi

if [ ! -f "$AYUMI_DIR/ayumi.c" ]; then
  echo "Error: Ayumi not vendored. Run: tools/setup-ayumi.sh"
  exit 1
fi

if [ ! -f "$MUSASHI_DIR/m68kcpu.c" ] || [ ! -f "$MUSASHI_DIR/m68kops.c" ]; then
  echo "Error: Musashi not vendored. Run: tools/setup-musashi.sh"
  exit 1
fi

# Activate the pinned Emscripten toolchain.
# shellcheck source=/dev/null
source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1

mkdir -p "$WASM_DIR"

OPL_EXPORTS='[
  "_cawtooth_opl_create",
  "_cawtooth_opl_destroy",
  "_cawtooth_opl_reset",
  "_cawtooth_opl_write",
  "_cawtooth_opl_generate",
  "_cawtooth_opl_generate_channels",
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
  -sEXPORTED_FUNCTIONS="$OPL_EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/nuked-opl3.wasm"
ls -lh "$WASM_DIR/nuked-opl3.wasm"

SID_EXPORTS='[
  "_cawtooth_sid_create",
  "_cawtooth_sid_destroy",
  "_cawtooth_sid_reset",
  "_cawtooth_sid_write",
  "_cawtooth_sid_read",
  "_cawtooth_sid_generate",
  "_cawtooth_sid_generate_channels",
  "_cawtooth_sid_handle_size",
  "_malloc",
  "_free"
]'

RESID_SOURCES=(
  "$RESID_DIR/sid.cc"
  "$RESID_DIR/voice.cc"
  "$RESID_DIR/wave.cc"
  "$RESID_DIR/envelope.cc"
  "$RESID_DIR/filter.cc"
  "$RESID_DIR/extfilt.cc"
  "$RESID_DIR/pot.cc"
  "$RESID_DIR/version.cc"
)

echo ""
echo "==> Compiling reSID + wrapper to WASM"
# -msimd128 enables the WebAssembly SIMD proposal (stable in Chrome 91+,
# Firefox 89+, Safari 16.4+, Node 16.4+). Big win on reSID's FIR
# resampler — the 125-tap convolution in SAMPLE_RESAMPLE / RESAMPLE_FASTMEM
# auto-vectorizes to v128 MACs. No runtime feature detection needed for
# the browsers we support.
emcc \
  -O3 \
  -DNDEBUG \
  -fno-exceptions \
  -std=c++17 \
  -msimd128 \
  -I "$RESID_DIR" \
  "${RESID_SOURCES[@]}" \
  "$NATIVE_DIR/resid-wrapper.cc" \
  -o "$WASM_DIR/resid.wasm" \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=20971520 \
  -sEXPORTED_FUNCTIONS="$SID_EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/resid.wasm"
ls -lh "$WASM_DIR/resid.wasm"

SIDPLAY_EXPORTS='[
  "_cawtooth_sidplay_create",
  "_cawtooth_sidplay_destroy",
  "_cawtooth_sidplay_set_extra_sid",
  "_cawtooth_sidplay_load",
  "_cawtooth_sidplay_init",
  "_cawtooth_sidplay_get_play_interval",
  "_cawtooth_sidplay_generate",
  "_cawtooth_sidplay_generate_channels",
  "_cawtooth_sidplay_peek",
  "_cawtooth_sidplay_reset_sid",
  "_malloc",
  "_free"
]'

echo ""
echo "==> Compiling fake6502 + reSID + sidplay wrapper to WASM"
# No -std=c++17 here: this compile mixes .c and .cc, and emcc rejects
# -std=c++ on .c files. Each file uses its language default (C for .c,
# C++ for .cc), which is fine — our reSID siddefs.h already picks the
# conservative non-constexpr fallbacks, so no specific C++ std is needed.
# -msimd128: enable WebAssembly SIMD; see resid.wasm build comment above.
emcc \
  -O3 \
  -DNDEBUG \
  -fno-exceptions \
  -msimd128 \
  -I "$RESID_DIR" \
  -I "$FAKE_DIR" \
  "${RESID_SOURCES[@]}" \
  "$FAKE_DIR/fake6502.c" \
  "$NATIVE_DIR/sidplay-wrapper.cc" \
  -o "$WASM_DIR/sidplay.wasm" \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=20971520 \
  -sEXPORTED_FUNCTIONS="$SIDPLAY_EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/sidplay.wasm"
ls -lh "$WASM_DIR/sidplay.wasm"

AY_EXPORTS='[
  "_cawtooth_ay_create",
  "_cawtooth_ay_destroy",
  "_cawtooth_ay_reset",
  "_cawtooth_ay_write",
  "_cawtooth_ay_read",
  "_cawtooth_ay_set_pan",
  "_cawtooth_ay_generate",
  "_cawtooth_ay_generate_channels",
  "_cawtooth_ay_chip_size",
  "_malloc",
  "_free"
]'

echo ""
echo "==> Compiling Ayumi + wrapper to WASM"
# Plain C build — Ayumi is single-file C, wrapper is C, no C++ stdlib
# bring-up needed. -msimd128 is harmless here (Ayumi's hot path is the
# 192-tap FIR decimator, which the compiler vectorizes when given the
# chance). 1 MiB initial memory — Ayumi's working set is tiny (a few
# KB struct + ~3 KB FIR delay lines).
emcc \
  -O3 \
  -DNDEBUG \
  -msimd128 \
  -I "$AYUMI_DIR" \
  "$AYUMI_DIR/ayumi.c" \
  "$NATIVE_DIR/ayumi-wrapper.c" \
  -o "$WASM_DIR/ayumi.wasm" \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=1048576 \
  -sEXPORTED_FUNCTIONS="$AY_EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/ayumi.wasm"
ls -lh "$WASM_DIR/ayumi.wasm"

SNDH_EXPORTS='[
  "_cawtooth_sndh_create",
  "_cawtooth_sndh_destroy",
  "_cawtooth_sndh_load",
  "_cawtooth_sndh_init",
  "_cawtooth_sndh_get_play_interval",
  "_cawtooth_sndh_generate",
  "_cawtooth_sndh_generate_channels",
  "_cawtooth_sndh_set_pan",
  "_cawtooth_sndh_peek",
  "_cawtooth_sndh_reset_chip",
  "_malloc",
  "_free"
]'

echo ""
echo "==> Compiling Musashi + Ayumi + SNDH wrapper to WASM"
# Musashi's m68kcpu.c #includes m68kfpu.c and m68kmmu.h directly, so
# only m68kcpu.c + m68kops.c go on the compile line — feeding m68kfpu.c
# separately would duplicate-define m68040_fpu_op0/op1.
# softfloat is required by m68kfpu.c for FPU/MMU paths even on a 68000
# build (the M68K_EMULATE_040 / M68K_EMULATE_PMMU defaults stay ON).
# -sSUPPORT_LONGJMP=0 disables Emscripten's setjmp/longjmp shims (which
# would otherwise need invoke_* JS imports incompatible with
# STANDALONE_WASM). Musashi only uses setjmp for the bus-error trap,
# which never fires on healthy SNDH playback — the wrapper validates
# every memory access before delegation, so nothing reaches longjmp.
# 16 MiB initial memory: 4 MiB for the simulated Atari ST RAM is
# baked into the wrapper as a static array, plus headroom for malloc
# and the WASM stack. -msimd128 helps Ayumi's FIR decimator.
emcc \
  -O3 \
  -DNDEBUG \
  -msimd128 \
  -I "$MUSASHI_DIR" \
  -I "$MUSASHI_DIR/softfloat" \
  -I "$AYUMI_DIR" \
  "$MUSASHI_DIR/m68kcpu.c" \
  "$MUSASHI_DIR/m68kops.c" \
  "$MUSASHI_DIR/softfloat/softfloat.c" \
  "$AYUMI_DIR/ayumi.c" \
  "$NATIVE_DIR/sndh-wrapper.c" \
  -o "$WASM_DIR/sndh.wasm" \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 \
  -sSUPPORT_LONGJMP=0 \
  -sEXPORTED_FUNCTIONS="$SNDH_EXPORTS" \
  --no-entry

echo ""
echo "==> Built: $WASM_DIR/sndh.wasm"
ls -lh "$WASM_DIR/sndh.wasm"
