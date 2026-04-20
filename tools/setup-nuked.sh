#!/usr/bin/env bash
# Clone Nuked-OPL3 at a pinned commit, then apply local patches.
# Idempotent — safe to re-run. Resets the working tree each invocation so
# patches always apply against clean upstream, never on top of themselves.

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

NUKED_DIR="$SCRIPT_DIR/nuked-opl3"
NUKED_REPO="https://github.com/nukeykt/Nuked-OPL3.git"
PATCH_DIR="$SCRIPT_DIR/patches/nuked-opl3"

if [ ! -d "$NUKED_DIR/.git" ]; then
  echo "==> Cloning Nuked-OPL3 into $NUKED_DIR"
  git clone "$NUKED_REPO" "$NUKED_DIR"
fi

pushd "$NUKED_DIR" > /dev/null

echo "==> Fetching Nuked-OPL3 updates"
git fetch --tags origin

# Resolve the ref first so we can use a detached-HEAD checkout that works
# whether the pin is a branch name, tag, or raw SHA.
RESOLVED_REF="$(git rev-parse "$NUKED_OPL3_COMMIT"^{commit})"

echo "==> Resetting to pinned commit: $NUKED_OPL3_COMMIT"
# Hard reset + clean guarantees we're applying patches against pristine upstream
# every run, regardless of any prior patched state left in the working tree.
git checkout --detach "$RESOLVED_REF"
git reset --hard "$RESOLVED_REF"
git clean -fd

# Apply local patches in filename-sorted order. See patches/nuked-opl3/README.md
# for the authoring workflow.
patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  echo "==> Applying ${#patches[@]} patch(es) from $PATCH_DIR"
  for p in "${patches[@]}"; do
    name="$(basename "$p")"
    echo "     $name"
    if ! git apply --whitespace=nowarn "$p"; then
      echo ""
      echo "Error: failed to apply $name against $NUKED_OPL3_COMMIT."
      echo "  If the pinned SHA was bumped, the patch may need to be regenerated"
      echo "  against the new base. See $PATCH_DIR/README.md for the workflow."
      exit 1
    fi
  done
else
  echo "==> No patches in $PATCH_DIR"
fi

RESOLVED_SHA="$(git rev-parse HEAD)"
popd > /dev/null

echo ""
echo "Nuked-OPL3 ready at $NUKED_DIR"
echo "Resolved commit: $RESOLVED_SHA"
if [ "$NUKED_OPL3_COMMIT" = "main" ] || [ "$NUKED_OPL3_COMMIT" = "master" ]; then
  echo ""
  echo "  Tip: for reproducible builds, update NUKED_OPL3_COMMIT in versions.sh"
  echo "       to the resolved SHA above."
fi
