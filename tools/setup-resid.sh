#!/usr/bin/env bash
# Clone reSID (Dag Lem's MOS 6581/8580 emulator) at a pinned commit,
# then apply local patches in tools/patches/resid/. Idempotent — hard-
# resets the working tree each invocation so patches always apply against
# pristine upstream.
#
# Parallel to tools/setup-nuked.sh — same layout, same guarantees.

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

RESID_DIR="$SCRIPT_DIR/resid"
RESID_REPO="https://github.com/daglem/reSID.git"
PATCH_DIR="$SCRIPT_DIR/patches/resid"

if [ ! -d "$RESID_DIR/.git" ]; then
  echo "==> Cloning reSID into $RESID_DIR"
  git clone "$RESID_REPO" "$RESID_DIR"
fi

pushd "$RESID_DIR" > /dev/null

echo "==> Fetching reSID updates"
git fetch --tags origin

RESOLVED_REF="$(git rev-parse "$RESID_COMMIT"^{commit})"
echo "==> Resetting to pinned commit: $RESID_COMMIT"
git checkout --detach "$RESOLVED_REF"
git reset --hard "$RESOLVED_REF"
git clean -fd

# reSID's build normally generates `siddefs.h` from `siddefs.h.in` via
# autoconf. We skip the autotools dance entirely (much simpler for a
# WASM build) by writing siddefs.h directly here with the conservative
# fallback values autoconf would pick when constexpr cmath / consteval
# aren't available. RESID_CONSTEXPR=const + RESID_CONSTINIT=blank avoids
# needing std::exp/log to be constexpr, which isn't guaranteed across
# libc++ versions. Performance cost is negligible — just moves a handful
# of coefficient initializations from compile time to first-use runtime.
cat > src/siddefs.h <<'EOF'
#ifndef RESID_SIDDEFS_H
#define RESID_SIDDEFS_H

#define RESID_INLINING 1
#define RESID_INLINE inline
#define RESID_BRANCH_HINTS 1
#define RESID_FPGA_CODE 0

#define RESID_CONSTEVAL
#define RESID_CONSTEXPR const
#define RESID_CONSTINIT
#define HAVE_BUILTIN_EXPECT 1

#ifndef VERSION
#define VERSION "1.0-pre1-cawtooth"
#endif

#if RESID_BRANCH_HINTS && HAVE_BUILTIN_EXPECT
#define likely(x)      __builtin_expect(!!(x), 1)
#define unlikely(x)    __builtin_expect(!!(x), 0)
#else
#define likely(x)      (x)
#define unlikely(x)    (x)
#endif

namespace reSID {

typedef unsigned int reg4;
typedef unsigned int reg8;
typedef unsigned int reg12;
typedef unsigned int reg16;
typedef unsigned int reg24;

typedef int cycle_count;
typedef short short_point[2];
typedef double double_point[2];

enum chip_model { MOS6581, MOS8580 };

enum sampling_method { SAMPLE_FAST, SAMPLE_INTERPOLATE,
                       SAMPLE_RESAMPLE, SAMPLE_RESAMPLE_FASTMEM };

} // namespace reSID

extern "C"
{
#ifndef RESID_VERSION_CC
extern const char* resid_version_string;
#else
const char* resid_version_string = VERSION;
#endif
}

#endif // not RESID_SIDDEFS_H
EOF

patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  echo "==> Applying ${#patches[@]} patch(es) from $PATCH_DIR"
  for p in "${patches[@]}"; do
    name="$(basename "$p")"
    echo "     $name"
    if ! git apply --whitespace=nowarn "$p"; then
      echo ""
      echo "Error: failed to apply $name against $RESID_COMMIT."
      echo "  See $PATCH_DIR/README.md for the authoring workflow."
      exit 1
    fi
  done
else
  echo "==> No patches in $PATCH_DIR"
fi

RESOLVED_SHA="$(git rev-parse HEAD)"
popd > /dev/null

echo ""
echo "reSID ready at $RESID_DIR"
echo "Resolved commit: $RESOLVED_SHA"
