#!/usr/bin/env bash
# Fetch the official Node.js runtime used as the desktop sidecar (Linux/macOS).
# The binary is not committed; run this once before `tauri build`.
set -euo pipefail

VERSION="${NODE_VERSION:-20.20.2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64)  PLATFORM="linux-x64";    TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux:aarch64) PLATFORM="linux-arm64";  TRIPLE="aarch64-unknown-linux-gnu" ;;
  Darwin:arm64)  PLATFORM="darwin-arm64"; TRIPLE="aarch64-apple-darwin" ;;
  Darwin:x86_64) PLATFORM="darwin-x64";   TRIPLE="x86_64-apple-darwin" ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

DEST="$ROOT/src-tauri/binaries/gitty-node-$TRIPLE"
if [ -x "$DEST" ]; then
  echo "sidecar already present: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ARCHIVE="node-v${VERSION}-${PLATFORM}.tar.xz"
BASE="https://nodejs.org/dist/v${VERSION}"
echo "downloading Node.js v${VERSION} (${PLATFORM})..."
curl -fsSL "$BASE/$ARCHIVE" -o "$TMP/$ARCHIVE"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
if command -v sha256sum >/dev/null 2>&1; then
  CHECK=(sha256sum -c -)
else
  CHECK=(shasum -a 256 -c -)
fi
(cd "$TMP" && grep "  $ARCHIVE\$" SHASUMS256.txt | "${CHECK[@]}")

tar -xJf "$TMP/$ARCHIVE" -C "$TMP"
mkdir -p "$(dirname "$DEST")"
install -m 755 "$TMP/node-v${VERSION}-${PLATFORM}/bin/node" "$DEST"
echo "installed Node sidecar: $DEST"
