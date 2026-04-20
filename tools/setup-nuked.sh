#!/usr/bin/env bash
# Clone Nuked-OPL3 at a pinned commit. Idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

NUKED_DIR="$SCRIPT_DIR/nuked-opl3"
NUKED_REPO="https://github.com/nukeykt/Nuked-OPL3.git"

if [ ! -d "$NUKED_DIR/.git" ]; then
  echo "==> Cloning Nuked-OPL3 into $NUKED_DIR"
  git clone "$NUKED_REPO" "$NUKED_DIR"
fi

pushd "$NUKED_DIR" > /dev/null

echo "==> Fetching Nuked-OPL3 updates"
git fetch --tags origin

echo "==> Checking out pinned commit: $NUKED_OPL3_COMMIT"
# Resolve the ref first so we can use a detached-HEAD checkout that works
# whether the pin is a branch name, tag, or raw SHA.
RESOLVED_REF="$(git rev-parse "$NUKED_OPL3_COMMIT"^{commit})"
git checkout --detach "$RESOLVED_REF"

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
