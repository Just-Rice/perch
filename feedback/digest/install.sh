#!/bin/bash
# Installs Perch's weekly digest on this Mac: ./install.sh <owner email> <Gmail send tool>
# e.g. ./install.sh you@example.com mcp__claude_ai_Gmail__send_message
# Needs the feedback box's read-only key in the login Keychain (service perch-feedback-digest, account token).
set -euo pipefail
TO="${1:?owner email}"; TOOL="${2:?Gmail send tool name}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/LaunchAgents/com.rishirao.perch-digest.plist"
/usr/bin/security find-generic-password -s perch-feedback-digest -a token >/dev/null 2>&1 \
  || { echo "The feedback box's read-only key isn't in the Keychain (perch-feedback-digest)." >&2; exit 1; }
sed -e "s|__SCRIPT__|$HERE/weekly-digest.sh|" -e "s|__TO__|$TO|" -e "s|__TOOL__|$TOOL|" -e "s|__HOME__|$HOME|g" \
  "$HERE/com.rishirao.perch-digest.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null
launchctl bootout "gui/$(id -u)/com.rishirao.perch-digest" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed: Mondays at 9:00. Log: ~/Library/Logs/perch-digest.log. Run now: launchctl kickstart gui/$(id -u)/com.rishirao.perch-digest"
