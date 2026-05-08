#!/usr/bin/env bash
# Clone Musashi (Karl Stenerud's portable Motorola 680x0 emulator) at a
# pinned commit, then apply local patches in tools/patches/musashi/.
# Idempotent — hard-resets the working tree each invocation so patches
# always apply against pristine upstream.
#
# Parallel to tools/setup-fake6502.sh / setup-resid.sh — same layout,
# same guarantees.
#
# Musashi is MIT licensed, compatible with cawtooth's GPL-3.0-or-later.
# Used as the CPU core for SNDH (Atari ST) playback alongside Ayumi
# (which provides the YM2149 chip emulation).

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

MUSASHI_DIR="$SCRIPT_DIR/musashi"
MUSASHI_REPO="https://github.com/kstenerud/Musashi.git"
PATCH_DIR="$SCRIPT_DIR/patches/musashi"

if [ ! -d "$MUSASHI_DIR/.git" ]; then
  echo "==> Cloning Musashi into $MUSASHI_DIR"
  git clone "$MUSASHI_REPO" "$MUSASHI_DIR"
fi

pushd "$MUSASHI_DIR" > /dev/null

echo "==> Fetching Musashi updates"
git fetch --tags origin

RESOLVED_REF="$(git rev-parse "$MUSASHI_COMMIT"^{commit})"
echo "==> Resetting to pinned commit: $MUSASHI_COMMIT"
git checkout --detach "$RESOLVED_REF"
git reset --hard "$RESOLVED_REF"
git clean -fd

patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  echo "==> Applying ${#patches[@]} patch(es) from $PATCH_DIR"
  for p in "${patches[@]}"; do
    name="$(basename "$p")"
    echo "     $name"
    if ! git apply --whitespace=nowarn "$p"; then
      echo ""
      echo "Error: failed to apply $name against $MUSASHI_COMMIT."
      echo "  See $PATCH_DIR/README.md for the authoring workflow."
      exit 1
    fi
  done
else
  echo "==> No patches in $PATCH_DIR"
fi

# Musashi's source generator emits the giant opcode dispatch tables we
# need at compile time — m68kmake produces m68kops.h and m68kops.c from
# the m68k_in.c specification. Run it now so subsequent WASM builds can
# just consume the generated files.
echo "==> Building m68kmake source generator"
make m68kmake > /dev/null

echo "==> Generating opcode dispatch tables (m68kops.h / m68kops.c)"
./m68kmake > /dev/null

RESOLVED_SHA="$(git rev-parse HEAD)"
popd > /dev/null

echo ""
echo "Musashi ready at $MUSASHI_DIR"
echo "Resolved commit: $RESOLVED_SHA"
