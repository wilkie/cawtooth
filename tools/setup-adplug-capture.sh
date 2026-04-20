#!/usr/bin/env bash
# Set up the AdPlug cross-check harness (tools/adplug-capture/).
# Idempotent — safe to re-run.
#
# Requirements are met by the system package libadplug-dev. We check that
# it's installed and warn if the version differs from what we've validated
# against.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./versions.sh
source "$SCRIPT_DIR/versions.sh"

CAPTURE_DIR="$SCRIPT_DIR/adplug-capture"

echo "==> Checking AdPlug availability"
if ! pkg-config --exists adplug; then
  cat <<EOF >&2
Error: libadplug is not installed (or not visible to pkg-config).

On Debian / Ubuntu:
    sudo apt install libadplug-dev libbinio-dev build-essential pkg-config

See $CAPTURE_DIR/README.md for details.
EOF
  exit 1
fi

ADPLUG_VERSION="$(pkg-config --modversion adplug)"
echo "==> Found AdPlug $ADPLUG_VERSION"
if [ "$ADPLUG_VERSION" != "$ADPLUG_VERSION_EXPECTED" ]; then
  echo "    Note: we validated against $ADPLUG_VERSION_EXPECTED."
  echo "    Running the cross-check with a different version may surface"
  echo "    divergences that reflect AdPlug changes rather than bugs in"
  echo "    our renderer."
fi

echo "==> Building capture-herad"
make -C "$CAPTURE_DIR" >/dev/null

echo ""
echo "Harness ready at: $CAPTURE_DIR/capture-herad"
echo "Test suite will pick it up automatically when run:"
echo "    pnpm -F cawtooth test"
