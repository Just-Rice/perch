#!/bin/bash
# Sets Perch's version everywhere it is written down, so the app, the host and the release tag agree:
#   host/scripts/set-version.sh 0.2.0
# Then commit, tag v0.2.0 and push the tag; .github/workflows/release.yml builds and publishes the release.
# A test build's version has a pre-release part, like 0.3.4-alpha.1: the release workflow stamps it in by itself
# (nothing is committed) and publishes it as a pre-release, which install.sh and every Mac's updater skip.
set -euo pipefail
V="${1:?usage: set-version.sh <x.y.z>[-alpha.N]}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] || { echo "set-version: $V is not x.y.z or x.y.z-alpha.N" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$ROOT/host/app/Resources/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $V" "$PLIST"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $((BUILD + 1))" "$PLIST"
sed -i '' "s/static let version = \"[^\"]*\"/static let version = \"$V\"/" "$ROOT/host/app/Sources/Perch/Options.swift"
(cd "$ROOT/host/node" && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
echo "Perch is now $V (app build $((BUILD + 1)))."
grep -n "static let version" "$ROOT/host/app/Sources/Perch/Options.swift"
