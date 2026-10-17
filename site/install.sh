#!/bin/bash
# Perch installer.
#
#   curl -fsSL https://just-rice.github.io/perch/install.sh | bash
#
# What it does, in order:
#   1. checks this is an Apple silicon Mac on macOS 14 or later;
#   2. asks GitHub for the latest Perch release (or the version in $PERCH_VERSION);
#   3. downloads Perch.zip and its checksum, and stops unless they match;
#   4. checks the app's code signature is intact;
#   5. quits Perch if it's running, puts the new copy in /Applications (or ~/Applications if you can't write to
#      /Applications), and opens it. Perch then opens its Setup page in your browser.
#
# Files fetched by curl aren't marked "downloaded from the internet", which is why macOS opens Perch without the
# "Apple cannot check it" block even though Perch isn't registered with Apple's paid developer programme.
# Uses only tools every Mac has (curl, shasum, ditto, codesign, osascript). Never asks for your password.
#
# Options: --update (quiet; used by Perch's own "Update" menu item), --no-open, --dir <folder>.
set -euo pipefail

REPO="Just-Rice/perch"
BUNDLE_ID="io.github.just-rice.perch"
UPDATE=0
OPEN=1
DEST_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --no-open) OPEN=0 ;;
    --dir) DEST_DIR="${2:?--dir needs a folder}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$UPDATE" = 1 ] || printf '%s\n' "$*"; }
fail() { printf 'Perch install failed: %s\n' "$*" >&2; exit 1; }

# 1. This Mac.
[ "$(uname -s)" = "Darwin" ] || fail "Perch runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Perch needs a Mac with Apple silicon (M1 or later). Intel Macs aren't supported yet."
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MACOS_MAJOR" -ge 14 ] 2>/dev/null || fail "Perch needs macOS 14 Sonoma or later (this Mac has $(sw_vers -productVersion))."

# 2. Which release.
# PERCH_RELEASES_API lets tests point the installer at a local copy of the releases API.
API="${PERCH_RELEASES_API:-https://api.github.com/repos/$REPO/releases}"
if [ -n "${PERCH_VERSION:-}" ]; then
  RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/tags/v${PERCH_VERSION#v}")" ||
    fail "couldn't find Perch version ${PERCH_VERSION}."
else
  RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/latest")" ||
    fail "couldn't reach GitHub to find the latest Perch. Check your internet connection and try again."
fi
# The release JSON is parsed with plain grep/sed so nothing extra is needed.
asset_url() {
  printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https:[^"]*\)"/\1/' |
    grep -E "/$1\$" | head -n 1
}
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
ZIP_URL="$(asset_url 'Perch-[0-9][0-9.]*\.zip')"
SUM_URL="$(asset_url 'Perch-[0-9][0-9.]*\.zip\.sha256')"
[ -n "$TAG" ] && [ -n "$ZIP_URL" ] && [ -n "$SUM_URL" ] || fail "the latest release doesn't have the files this installer expects."
say "Installing Perch ${TAG#v}…"

# 3. Download and check.
WORK="$(mktemp -d -t perch-install)"
trap 'rm -rf "$WORK"' EXIT
curl -fL --retry 3 --progress-bar -o "$WORK/Perch.zip" "$ZIP_URL" 2>/dev/null || curl -fsSL --retry 3 -o "$WORK/Perch.zip" "$ZIP_URL" ||
  fail "the download didn't finish. Try again."
curl -fsSL --retry 3 -o "$WORK/Perch.zip.sha256" "$SUM_URL" || fail "couldn't download the checksum."
EXPECTED="$(awk '{print $1; exit}' "$WORK/Perch.zip.sha256")"
ACTUAL="$(shasum -a 256 "$WORK/Perch.zip" | awk '{print $1}')"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] ||
  fail "the download doesn't match its checksum, so it was not installed. Try again later."

# 4. Unpack and check the signature.
ditto -x -k "$WORK/Perch.zip" "$WORK/unpacked"
NEW_APP="$WORK/unpacked/Perch.app"
[ -d "$NEW_APP" ] || fail "the download doesn't contain Perch.app."
codesign --verify --deep --strict "$NEW_APP" 2>/dev/null || fail "Perch's code signature is broken, so it was not installed."
[ "$(defaults read "$NEW_APP/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "$BUNDLE_ID" ] || fail "that isn't Perch."

# 5. Install.
if [ -z "$DEST_DIR" ]; then
  EXISTING="$(mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" 2>/dev/null | grep -E '/Perch\.app$' | grep -v "^$WORK" | head -n 1 || true)"
  if [ -n "$EXISTING" ] && [ -w "$(dirname "$EXISTING")" ]; then
    DEST_DIR="$(dirname "$EXISTING")"
  elif [ -w /Applications ]; then
    DEST_DIR="/Applications"
  else
    DEST_DIR="$HOME/Applications"
  fi
fi
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/Perch.app"

if pgrep -x Perch >/dev/null 2>&1; then
  say "Closing the running Perch…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Perch >/dev/null 2>&1 || break; sleep 0.5; done
  pkill -x Perch >/dev/null 2>&1 || true
  sleep 0.5
fi

# Replace in place at the same path, so macOS keeps Perch's login item.
if [ -d "$DEST" ]; then rm -rf "$DEST.old"; mv "$DEST" "$DEST.old"; fi
if ditto "$NEW_APP" "$DEST"; then
  rm -rf "$DEST.old"
else
  [ -d "$DEST.old" ] && mv "$DEST.old" "$DEST"
  fail "couldn't copy Perch into $DEST_DIR."
fi
# Belt and braces: make sure nothing marked the copy as downloaded.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

say "Perch ${TAG#v} is installed in $DEST_DIR."
if [ "$OPEN" = 1 ]; then
  open "$DEST"
  say "Perch is starting: look for its icon in the menu bar. Setup opens in your browser the first time."
fi
