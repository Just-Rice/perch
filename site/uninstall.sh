#!/bin/bash
# Removes Perch from this Mac.
#
#   curl -fsSL https://just-rice.github.io/perch/uninstall.sh | bash
#
# Quits Perch, stops it starting at login, deletes its settings, logs and Keychain entry, and moves the app to the
# Trash. Your paired devices stop working with this Mac (their passkeys can then be deleted from them).
# Perch's own Setup page has an "Uninstall Perch" button that does the same.
set -uo pipefail

BUNDLE_ID="io.github.just-rice.perch"
say() { printf '%s\n' "$*"; }

APPS="$(mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" 2>/dev/null | grep -E '/Perch\.app$' || true)"
for p in /Applications/Perch.app "$HOME/Applications/Perch.app"; do
  [ -d "$p" ] && APPS="$(printf '%s\n%s' "$APPS" "$p")"
done
APPS="$(printf '%s\n' "$APPS" | sed '/^$/d' | sort -u)"

if pgrep -x Perch >/dev/null 2>&1; then
  say "Closing Perch…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Perch >/dev/null 2>&1 || break; sleep 0.5; done
  pkill -x Perch >/dev/null 2>&1 || true
fi

# Stop it starting at login (the app removes its own login item).
while IFS= read -r app; do
  [ -x "$app/Contents/MacOS/Perch" ] && "$app/Contents/MacOS/Perch" --unregister-login-item >/dev/null 2>&1 || true
done <<< "$APPS"
launchctl bootout "gui/$(id -u)/$BUNDLE_ID" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$BUNDLE_ID.plist"

say "Deleting Perch's settings and Keychain entry…"
security delete-generic-password -s "$BUNDLE_ID" -a secrets >/dev/null 2>&1 || true
rm -rf "$HOME/Library/Application Support/Perch" "$HOME/Library/Logs/Perch"

while IFS= read -r app; do
  [ -n "$app" ] && [ -d "$app" ] || continue
  if osascript -e "tell application \"Finder\" to delete (POSIX file \"$app\" as alias)" >/dev/null 2>&1; then
    say "Moved $app to the Trash."
  else
    rm -rf "$app" && say "Deleted $app."
  fi
done <<< "$APPS"

say "Perch is uninstalled. To finish, delete the Perch passkeys on your other devices (in their password settings)"
say "and remove Perch from your authenticator app."
