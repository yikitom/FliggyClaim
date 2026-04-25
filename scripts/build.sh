#!/usr/bin/env bash
# Package the FliggyClaim Chrome extension into a distributable zip.
# Output: dist/fliggyclaim-<version>.zip
#
# Install:
#   1. Unzip the file into a folder.
#   2. Open chrome://extensions/ and toggle on "Developer mode".
#   3. Click "Load unpacked" and select the unzipped folder.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
NAME="fliggyclaim-${VERSION}"
OUT="dist/${NAME}.zip"

mkdir -p dist
rm -f "$OUT"

# Files to include
zip -r "$OUT" \
  manifest.json \
  INSTALL.txt \
  background \
  content \
  icons \
  lib \
  options \
  popup \
  scripts/install.sh \
  scripts/install.ps1 \
  -x "*.DS_Store" \
  -x "*/.DS_Store" \
  -x "*/.*" \
  > /dev/null

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"

# Also build a .crx if the signing tool's deps are available.
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "from cryptography.hazmat.primitives.asymmetric import rsa" >/dev/null 2>&1; then
    python3 "$(dirname "$0")/build-crx.py"
  else
    echo "(skip .crx: pip install cryptography to enable)"
  fi
fi
