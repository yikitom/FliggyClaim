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

# Web Store variant: strips the `key` field (the Store assigns its own key).
STORE_OUT="dist/${NAME}-webstore.zip"
rm -f "$STORE_OUT"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cp -R manifest.json background content icons lib options popup "$TMP_DIR/"
python3 -c "
import json, pathlib
p = pathlib.Path('$TMP_DIR/manifest.json')
m = json.loads(p.read_text())
m.pop('key', None)
p.write_text(json.dumps(m, indent=2, ensure_ascii=False))
"
( cd "$TMP_DIR" && zip -r "$ROOT/$STORE_OUT" . -x "*.DS_Store" -x "*/.*" > /dev/null )
echo "Built $STORE_OUT ($(du -h "$STORE_OUT" | cut -f1))  ← upload this to Web Store"

# Also build a .crx if the signing tool's deps are available.
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "from cryptography.hazmat.primitives.asymmetric import rsa" >/dev/null 2>&1; then
    python3 "$(dirname "$0")/build-crx.py"
  else
    echo "(skip .crx: pip install cryptography to enable)"
  fi
fi
