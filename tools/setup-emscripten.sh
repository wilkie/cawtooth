#!/usr/bin/env bash
# Clone emsdk at a pinned commit and install a pinned Emscripten version.
# Idempotent — safe to re-run. Output lives under tools/emsdk (gitignored).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

EMSDK_DIR="$SCRIPT_DIR/emsdk"
EMSDK_REPO="https://github.com/emscripten-core/emsdk.git"

if [ ! -d "$EMSDK_DIR/.git" ]; then
  echo "==> Cloning emsdk into $EMSDK_DIR"
  git clone "$EMSDK_REPO" "$EMSDK_DIR"
fi

pushd "$EMSDK_DIR" > /dev/null

echo "==> Fetching emsdk updates"
git fetch --tags origin

echo "==> Checking out pinned emsdk commit: $EMSDK_COMMIT"
RESOLVED_REF="$(git rev-parse "$EMSDK_COMMIT"^{commit})"
git checkout --detach "$RESOLVED_REF"

echo "==> Installing Emscripten $EMSCRIPTEN_VERSION"
./emsdk install "$EMSCRIPTEN_VERSION"

echo "==> Activating Emscripten $EMSCRIPTEN_VERSION"
./emsdk activate "$EMSCRIPTEN_VERSION"

popd > /dev/null

echo ""
echo "Emscripten $EMSCRIPTEN_VERSION is installed at $EMSDK_DIR"
echo "Build scripts in tools/ will source emsdk_env.sh automatically."
