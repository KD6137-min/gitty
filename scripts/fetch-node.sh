#!/usr/bin/env bash
# Fetch the official Node.js runtime used as the Linux sidecar.
# The binary is not committed; run this once before `tauri build`.
set -euo pipefail

VERSION="${NODE_VERSION:-20.20.2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -m)" in
  x86_64)  ARCH="x64";   TRIPLE="x86_64-unknown-linux-gnu" ;;
  aarch64) ARCH="arm64"; TRIPLE="aarch64-unknown-linux-gnu" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

DEST="$ROOT/src-tauri/binaries/gitty-node-$TRIPLE"
if [ -x "$DEST" ]; then
  echo "sidecar already present: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ARCHIVE="node-v${VERSION}-linux-${ARCH}.tar.xz"
BASE="https://nodejs.org/dist/v${VERSION}"
echo "downloading Node.js v${VERSION} (${ARCH})..."
curl -fsSL "$BASE/$ARCHIVE" -o "$TMP/$ARCHIVE"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
(cd "$TMP" && grep "  $ARCHIVE\$" SHASUMS256.txt | sha256sum -c -)

tar -xJf "$TMP/$ARCHIVE" -C "$TMP"
mkdir -p "$(dirname "$DEST")"
install -m 755 "$TMP/node-v${VERSION}-linux-${ARCH}/bin/node" "$DEST"
echo "installed Node sidecar: $DEST"
