#!/bin/bash
# Downloads the official Node.js build for Apple silicon (the kind Perch.app ships as Contents/Helpers/node: one
# self-contained binary, signed by the Node.js project with the JIT entitlement V8 needs), checks it against
# nodejs.org's SHA-256 list, and prints the path of its `node` binary. A copy already in <dir> is reused.
#
#   fetch-node.sh <dir> [version]      version like v24.11.0; default: the newest LTS release
set -euo pipefail
DIR="${1:?usage: fetch-node.sh <dir> [version]}"
VERSION="${2:-}"
BASE="https://nodejs.org/dist"

if [ -z "$VERSION" ]; then
  # index.json has one release per line, newest first; LTS releases name their line ("lts":"Krypton"). Read it all
  # before searching: piping curl straight into `grep -m 1` makes curl fail when grep stops reading early, and with
  # pipefail that failure ends the script.
  INDEX="$(curl -fsSL "$BASE/index.json")" || { echo "fetch-node: couldn't download $BASE/index.json" >&2; exit 1; }
  VERSION="$(printf '%s\n' "$INDEX" | grep '"lts":"' | grep 'osx-arm64-tar' | head -n 1 | sed 's/.*"version":"\(v[0-9.]*\)".*/\1/' || true)"
  [ -n "$VERSION" ] || { echo "fetch-node: couldn't find the latest LTS release" >&2; exit 1; }
fi
NAME="node-$VERSION-darwin-arm64"
mkdir -p "$DIR"
if [ ! -x "$DIR/$NAME/bin/node" ]; then
  # The .tar.xz is about half the size of the .tar.gz; macOS's tar reads both.
  ARCHIVE="$NAME.tar.xz"
  curl -fsSL -o "$DIR/$ARCHIVE" "$BASE/$VERSION/$ARCHIVE"
  SUMS="$(curl -fsSL "$BASE/$VERSION/SHASUMS256.txt")"
  WANT="$(printf '%s\n' "$SUMS" | awk -v f="$ARCHIVE" '$2 == f { print $1 }')"
  HAVE="$(shasum -a 256 "$DIR/$ARCHIVE" | awk '{ print $1 }')"
  if [ -z "$WANT" ] || [ "$WANT" != "$HAVE" ]; then
    rm -f "$DIR/$ARCHIVE"
    echo "fetch-node: $ARCHIVE doesn't match nodejs.org's checksum" >&2
    exit 1
  fi
  tar -xf "$DIR/$ARCHIVE" -C "$DIR" "$NAME/bin/node"
  rm -f "$DIR/$ARCHIVE"
fi
echo "$DIR/$NAME/bin/node"
