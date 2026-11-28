#!/bin/bash
# A signed test build of what is committed, installed on this Mac:
#   host/scripts/alpha.sh [--no-install] [--now] [--next x.y.z]
#
# 1. Tags HEAD v<next>-alpha.<n> (<next> is the version after the one in the code, 0.3.3 → 0.3.4; <n> one more than
#    the last test build of it; --next names the version, e.g. 0.4.0 after the last 0.3.x) and pushes only that tag.
# 2. The Release workflow builds it on GitHub's Mac, signs it with Perch's certificate (so this Mac keeps Perch's
#    Screen Recording and Accessibility) and publishes it as a pre-release: install.sh installs it only by name, and
#    Perch's update check never offers it. About five minutes.
# 3. Waits until nobody is connected to this Mac's Perch (--now: don't wait), then installs it with this checkout's
#    install.sh, which quits Perch, replaces it and opens it again.
set -euo pipefail
INSTALL=1 NOW=0 NAMED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --now) NOW=1 ;;
    --next) NAMED="${2:?--next needs a version}"; shift ;;
    *) echo "usage: alpha.sh [--no-install] [--now] [--next x.y.z]" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$NAMED" ] || [[ "$NAMED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "alpha: --next takes x.y.z" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "alpha: commit your changes first (a test build is of what is committed)." >&2; exit 1; }

BASE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' host/app/Resources/Info.plist)"
IFS=. read -r MAJOR MINOR PATCH <<< "$BASE"
NEXT="${NAMED:-$MAJOR.$MINOR.$((PATCH + 1))}"
git fetch -q --tags origin
LAST="$(git tag -l "v$NEXT-alpha.*" | sed "s/^v$NEXT-alpha\.//" | sort -n | tail -n 1)"
VERSION="$NEXT-alpha.$(( ${LAST:-0} + 1 ))"
TAG="v$VERSION"
git tag "$TAG"
git push -q origin "$TAG"
echo "alpha: building $VERSION on GitHub…"

RUN=""
for _ in $(seq 1 30); do
  RUN="$(gh run list --workflow release.yml --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
  [ -n "$RUN" ] && break
  sleep 4
done
[ -n "$RUN" ] || { echo "alpha: GitHub didn't start the build for $TAG." >&2; exit 1; }
if ! gh run watch "$RUN" --exit-status --interval 20 >/dev/null 2>&1; then
  echo "alpha: the build failed. See: gh run view $RUN --log-failed" >&2
  exit 1
fi
echo "alpha: $VERSION is published (pre-release)."
[ "$INSTALL" = 1 ] || exit 0

# Someone connected? The app logs every change of its menu bar icon.
LOG="$HOME/Library/Logs/Perch/host.log"
connected() { [ -f "$LOG" ] && grep -E '\[app\] menu bar icon: (connected|idle)$' "$LOG" | tail -n 1 | grep -q 'connected$'; }
if [ "$NOW" = 0 ] && connected; then
  echo "alpha: someone is connected to Perch; installing once they leave…"
  while connected; do sleep 15; done
fi
PERCH_VERSION="$VERSION" bash "$ROOT/site/install.sh"
echo "alpha: Perch $VERSION is installed."
