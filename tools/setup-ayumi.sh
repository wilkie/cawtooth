#!/usr/bin/env bash
# Clone Ayumi (Peter Sovietov's AY-3-8910 / YM2149 emulator) at a pinned
# commit, then apply local patches in tools/patches/ayumi/. Idempotent —
# hard-resets the working tree each invocation so patches always apply
# against pristine upstream.
#
# Parallel to tools/setup-fake6502.sh / tools/setup-resid.sh / tools/setup-nuked.sh.
#
# Ayumi is BSD 2-clause, compatible with cawtooth's GPL-3.0-or-later.

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

AYUMI_DIR="$SCRIPT_DIR/ayumi"
AYUMI_REPO="https://github.com/true-grue/ayumi.git"
PATCH_DIR="$SCRIPT_DIR/patches/ayumi"

if [ ! -d "$AYUMI_DIR/.git" ]; then
  echo "==> Cloning Ayumi into $AYUMI_DIR"
  git clone "$AYUMI_REPO" "$AYUMI_DIR"
fi

pushd "$AYUMI_DIR" > /dev/null

echo "==> Fetching Ayumi updates"
git fetch --tags origin

RESOLVED_REF="$(git rev-parse "$AYUMI_COMMIT"^{commit})"
echo "==> Resetting to pinned commit: $AYUMI_COMMIT"
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
      echo "Error: failed to apply $name against $AYUMI_COMMIT."
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
echo "Ayumi ready at $AYUMI_DIR"
echo "Resolved commit: $RESOLVED_SHA"
