#!/usr/bin/env bash
# Clone fake6502 (ivop fork of Mike Chambers' MOS 6502 emulator) at a
# pinned commit, then apply local patches in tools/patches/fake6502/.
# Idempotent — hard-resets the working tree each invocation so patches
# always apply against pristine upstream.
#
# Parallel to tools/setup-nuked.sh and tools/setup-resid.sh — same layout,
# same guarantees.
#
# fake6502 is BSD 2-clause, compatible with cawtooth's GPL-3.0-or-later.

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

FAKE_DIR="$SCRIPT_DIR/fake6502"
FAKE_REPO="https://github.com/ivop/fake6502.git"
PATCH_DIR="$SCRIPT_DIR/patches/fake6502"

if [ ! -d "$FAKE_DIR/.git" ]; then
  echo "==> Cloning fake6502 into $FAKE_DIR"
  git clone "$FAKE_REPO" "$FAKE_DIR"
fi

pushd "$FAKE_DIR" > /dev/null

echo "==> Fetching fake6502 updates"
git fetch --tags origin

RESOLVED_REF="$(git rev-parse "$FAKE6502_COMMIT"^{commit})"
echo "==> Resetting to pinned commit: $FAKE6502_COMMIT"
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
      echo "Error: failed to apply $name against $FAKE6502_COMMIT."
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
echo "fake6502 ready at $FAKE_DIR"
echo "Resolved commit: $RESOLVED_SHA"
