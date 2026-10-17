#!/bin/bash
# Builds Perch.app from host/app with the Command Line Tools alone (no Xcode):
#
#   host/scripts/make-app.sh [--host-bundle <dir>] [--node <path>] [--out <dir>]
#                            [--identity <sha1> --keychain <path>] [--skip-build]
#
#   --host-bundle <dir>  the bundled Node host (must contain perch-host.mjs); copied to Contents/Resources/host/
#   --node <path>        a Node.js binary to ship as Contents/Helpers/node. It must be a self-contained build, such
#                        as the official one from nodejs.org: Homebrew's node needs Homebrew's libraries and would
#                        not start on another Mac, so it is refused.
#   --out <dir>          where Perch.app goes (default: build/ at the top of the repository)
#   --identity <sha1>    sign with this code-signing identity instead of ad hoc ("-"), e.g. the self-signed Perch
#   --keychain <path>    certificate in a throwaway keychain (see sign-with-p12.sh for how one is made)
#   --skip-build         use the binary already in host/app/.build/release
#
# Layout: Contents/MacOS/Perch, Contents/Info.plist, Contents/Resources/{AppIcon.icns, host/},
# Contents/Helpers/node. Signing goes inside out without --deep (node first, then the app), with the hardened
# runtime, and the result is checked with `codesign --verify --deep --strict`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PKG="$ROOT/host/app"
OUT="$ROOT/build"
HOST_BUNDLE=""
NODE=""
IDENTITY="-"
KEYCHAIN=""
BUILD=1

die() { printf 'make-app: %s\n' "$*" >&2; exit 1; }
say() { printf 'make-app: %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host-bundle) HOST_BUNDLE="${2:?--host-bundle needs a folder}"; shift ;;
    --node) NODE="${2:?--node needs a path}"; shift ;;
    --out) OUT="${2:?--out needs a folder}"; shift ;;
    --identity) IDENTITY="${2:?--identity needs a SHA-1}"; shift ;;
    --keychain) KEYCHAIN="${2:?--keychain needs a path}"; shift ;;
    --skip-build) BUILD=0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  shift
done
[ -n "$KEYCHAIN" ] && [ "$IDENTITY" = "-" ] && die "--keychain only makes sense with --identity"
[ -z "$HOST_BUNDLE" ] || [ -f "$HOST_BUNDLE/perch-host.mjs" ] || die "$HOST_BUNDLE has no perch-host.mjs"
[ -z "$NODE" ] || [ -x "$NODE" ] || die "$NODE is not an executable"

# One version number: Info.plist says what the app is; the binary's fallback (for runs outside the bundle) must agree.
PLIST="$PKG/Resources/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
CODE_VERSION="$(sed -n 's/.*static let version = "\(.*\)".*/\1/p' "$PKG/Sources/Perch/Options.swift")"
[ "$VERSION" = "$CODE_VERSION" ] ||
  die "Info.plist says $VERSION but Sources/Perch/Options.swift says $CODE_VERSION; make them the same"

# 1. Build.
if [ "$BUILD" = 1 ]; then
  say "building Perch $VERSION (release)…"
  (cd "$PKG" && swift build -c release)
fi
BIN="$(cd "$PKG" && swift build -c release --show-bin-path)/Perch"
[ -x "$BIN" ] || die "no binary at $BIN (build first, or drop --skip-build)"

# 2. Assemble next to the destination, then swap it in, so a failed build never leaves half an app behind.
mkdir -p "$OUT"
STAGE="$(mktemp -d "$OUT/.Perch.app.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Perch.app"
C="$APP/Contents"
mkdir -p "$C/MacOS" "$C/Resources"
cp "$BIN" "$C/MacOS/Perch"
cp "$PLIST" "$C/Info.plist"
cp "$PKG/Resources/AppIcon.icns" "$C/Resources/AppIcon.icns"
printf 'APPL????' > "$C/PkgInfo"
if [ -n "$HOST_BUNDLE" ]; then
  ditto "$HOST_BUNDLE" "$C/Resources/host"
else
  say "note: no --host-bundle, so this Perch.app has no host inside (fine for tests that pass --host)"
fi

NODE_SIGNED_BY_US=0
if [ -n "$NODE" ]; then
  mkdir -p "$C/Helpers"
  cp -L "$NODE" "$C/Helpers/node"
  chmod 755 "$C/Helpers/node"
  file -b "$C/Helpers/node" | grep -q 'Mach-O' || die "$NODE is not a Mach-O executable"
  # A node that loads libraries from outside the system won't start on a Mac without the same libraries.
  FOREIGN="$(otool -L "$C/Helpers/node" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)"
  if [ -n "$FOREIGN" ]; then
    die "$NODE needs $(echo "$FOREIGN" | head -n 1) and $(($(echo "$FOREIGN" | wc -l))) libraries in all that other Macs won't have. Use the official build from nodejs.org."
  fi
  NODE_VERSION="$("$C/Helpers/node" --version)" || die "the copied node doesn't run"
  [ "${NODE_VERSION#v}" != "$NODE_VERSION" ] && [ "$(echo "${NODE_VERSION#v}" | cut -d. -f1)" -ge 22 ] ||
    die "Perch's host needs Node.js 22 or later (this is $NODE_VERSION)"
  say "node $NODE_VERSION ($(lipo -archs "$C/Helpers/node"))"
fi

# Finder metadata and quarantine flags make codesign refuse ("resource fork, Finder information, or similar detritus").
xattr -cr "$APP"

# 3. Sign, inside out. The official node is already signed by its makers (hardened runtime, the JIT entitlement V8
#    needs): keep that. A node without a valid signature gets ours, with the same entitlements Node.js ships with.
SIGN=(codesign --force --options runtime --sign "$IDENTITY")
[ -n "$KEYCHAIN" ] && SIGN+=(--keychain "$KEYCHAIN")
if [ -n "$NODE" ] && ! codesign --verify --strict "$C/Helpers/node" 2>/dev/null; then
  ENT="$STAGE/node.entitlements"
  cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
PLIST
  "${SIGN[@]}" --entitlements "$ENT" "$C/Helpers/node"
  rm -f "$ENT"
  NODE_SIGNED_BY_US=1
fi
# Perch itself needs no entitlements: screen recording, accessibility and input are granted by the user (TCC).
"${SIGN[@]}" "$APP"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | sed 's/^/make-app: /'

# 4. Swap it in.
DEST="$OUT/Perch.app"
rm -rf "$DEST"
mv "$APP" "$DEST"
say "built $DEST"
say "  version $VERSION, signed $([ "$IDENTITY" = "-" ] && echo "ad hoc" || echo "by $IDENTITY")$([ "$NODE_SIGNED_BY_US" = 1 ] && echo ", node re-signed")"
codesign -d -r- "$DEST" 2>&1 | sed -n 's/^designated => /make-app:   designated requirement: /p'
