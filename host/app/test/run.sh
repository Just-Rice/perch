#!/bin/bash
# Every Perch.app test, in order:
#
#   host/app/test/run.sh [--no-real] [--no-bundle] [--no-ui] [--node-cache <dir>]
#
#   1. build (release) and `Perch --selftest`;
#   2. the fake host against --synthetic: host restarts, IPC, capture and encoding (checked with ffprobe/ffmpeg),
#      input echo, every command;
#   3. a short capture of the real screen and sound (needs Screen Recording for this terminal; everything captured
#      is deleted at once);
#   4. a built Perch.app: make-app.sh with the official Node.js (downloaded and checksum-checked; --node-cache keeps it
#      between runs) and the fake host as its bundled host;
#   5. the menu bar item, shown for a few seconds.
#
# Nothing here posts input (--echo-input everywhere), asks for a permission, shows a notification, or registers a
# login item. Each run gets its own temporary PERCH_HOME, removed at the end.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$PKG/../.." && pwd)"
REAL=1 BUNDLE=1 UI=1 NODE_CACHE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-real) REAL=0 ;;
    --no-bundle) BUNDLE=0 ;;
    --no-ui) UI=0 ;;
    --node-cache) NODE_CACHE="${2:?--node-cache needs a folder}"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

NODE="$(command -v node)" || { echo "run.sh: Node.js is needed to run the fake host" >&2; exit 1; }
for tool in ffprobe ffmpeg; do command -v "$tool" >/dev/null || { echo "run.sh: $tool is needed (brew install ffmpeg)" >&2; exit 1; }; done
TMP="$(mktemp -d -t perch-app-test)"
trap 'rm -rf "$TMP"' EXIT
APP="$PKG/.build/release/Perch"
declare -a SUMMARY=()
FAILED=0

step() { printf '\n== %s\n' "$*"; }
record() { # name status [report file]
  local verdict="PASS"
  [ "$2" = 0 ] || { verdict="FAIL (exit $2)"; FAILED=1; }
  local counts=""
  [ -n "${3:-}" ] && [ -f "$3" ] && counts=" — $(tail -n 1 "$3")"
  [ -n "${3:-}" ] && [ ! -f "$3" ] && { verdict="FAIL (no report)"; FAILED=1; }
  SUMMARY+=("$verdict $1$counts")
}
# Runs the app with the fake host in one mode. Extra arguments go to the app.
fake_host() { # mode app-binary args...
  local mode="$1" bin="$2"; shift 2
  local home="$TMP/home-$mode"
  mkdir -p "$home"
  PERCH_HOME="$home" PERCH_FAKE_MODE="$mode" PERCH_FAKE_REPORT="$home/report.txt" \
    "$bin" --echo-input --exit-with-host "$@" >"$home/output.txt" 2>&1
  local status=$?
  if [ -f "$home/report.txt" ]; then grep -v '^PASS' "$home/report.txt" | sed 's/^/   /'; fi
  [ "$status" = 0 ] || tail -n 30 "$home/output.txt" | sed 's/^/   | /'
  cp "$home/report.txt" "$TMP/report-$mode.txt" 2>/dev/null
  return $status
}

step "build"
(cd "$PKG" && swift build -c release 2>&1 | grep -vE '^\[[0-9]+/[0-9]+\]|search path .* not found')
[ -x "$APP" ] || { echo "run.sh: the build failed" >&2; exit 1; }

step "selftest"
"$APP" --selftest >"$TMP/selftest.txt" 2>&1
status=$?
grep -v '^PASS' "$TMP/selftest.txt"
record "selftest" $status
SUMMARY[${#SUMMARY[@]}-1]+=" — $(tail -n 1 "$TMP/selftest.txt")"

step "synthetic (fake host: restarts, IPC, capture, input echo, commands)"
fake_host synthetic "$APP" --synthetic --no-ui --node "$NODE" --host "$HERE/fake-host.mjs"
record "synthetic" $? "$TMP/report-synthetic.txt"

if [ "$REAL" = 1 ]; then
  step "real screen and sound (short; nothing kept)"
  fake_host real "$APP" --no-ui --node "$NODE" --host "$HERE/fake-host.mjs"
  record "real capture" $? "$TMP/report-real.txt"
  rm -rf "$TMP/home-real"
fi

if [ "$BUNDLE" = 1 ]; then
  step "Perch.app (official Node.js inside, fake host as the bundled host)"
  CACHE="${NODE_CACHE:-$TMP/node}"
  if OFFICIAL="$("$HERE/fetch-node.sh" "$CACHE")"; then
    mkdir -p "$TMP/host-bundle"
    cp "$HERE/fake-host.mjs" "$TMP/host-bundle/perch-host.mjs"
    if "$ROOT/host/scripts/make-app.sh" --skip-build --host-bundle "$TMP/host-bundle" --node "$OFFICIAL" --out "$TMP/build" >"$TMP/make-app.txt" 2>&1; then
      sed 's/^/   /' "$TMP/make-app.txt" | grep -v 'valid on disk\|satisfies its'
      fake_host bundle "$TMP/build/Perch.app/Contents/MacOS/Perch" --synthetic --no-ui
      status=$?
      # `uninstall` in a test run must leave the app where it is, still intact.
      if [ ! -d "$TMP/build/Perch.app" ] || ! codesign --verify --deep --strict "$TMP/build/Perch.app" 2>/dev/null; then
        echo "   FAIL Perch.app is gone or broken after uninstall in a test run"; status=1
      else
        echo "   PASS Perch.app still there and intact after uninstall in a test run"
      fi
      record "bundle" $status "$TMP/report-bundle.txt"
    else
      cat "$TMP/make-app.txt"; record "bundle (make-app.sh failed)" 1
    fi
  else
    record "bundle (couldn't fetch Node.js)" 1
  fi
fi

if [ "$UI" = 1 ]; then
  step "menu bar item (appears for a few seconds)"
  fake_host ui "$APP" --synthetic --node "$NODE" --host "$HERE/fake-host.mjs"
  record "menu bar" $? "$TMP/report-ui.txt"
fi

step "summary"
printf '%s\n' "${SUMMARY[@]}"
exit $FAILED
