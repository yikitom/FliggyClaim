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
  background \
  content \
  icons \
  lib \
  options \
  popup \
  -x "*.DS_Store" \
  -x "*/.DS_Store" \
  -x "*/.*" \
  > /dev/null

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
