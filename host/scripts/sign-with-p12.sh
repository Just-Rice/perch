#!/bin/bash
# Signs an app bundle with a self-signed .p12 identity using a throwaway keychain that is never
# added to the user's keychain search list, then deletes the keychain. Non-interactive: no GUI
# prompts (the partition list below prevents the "codesign wants to sign using key" dialog).
# Usage: sign-with-p12.sh <identity.p12> <p12-password> <App.app> [extra codesign args...]
# Example: sign-with-p12.sh perch-signing.p12 "$P12_PW" Perch.app --options runtime --timestamp
#
# Verified on macOS 27.0: works for a single self-signed cert. Does NOT work for a leaf issued by
# your own private CA: codesign fails with "unable to build chain to self-signed root" /
# errSecInternalComponent even with the CA in the keychain and the keychain in the search list
# (the CA would need trust settings, which need an interactive password prompt).
set -euo pipefail
P12="$1"; P12PW="$2"; APP="$3"; shift 3
WORK="$(mktemp -d "${TMPDIR:-/tmp}/perchsign.XXXXXX")"
KC="$WORK/sign.keychain-db"
KCPW="$(openssl rand -hex 16)"
cleanup() { security delete-keychain "$KC" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
# p12 must use legacy PBE (openssl pkcs12 -export -legacy); OpenSSL 3+ defaults fail with
# "MAC verification failed during PKCS12 import (wrong password?)".
security import "$P12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null
# A self-signed cert is listed as (CSSMERR_TP_NOT_TRUSTED) and `find-identity -v` hides it, but
# codesign still signs with it. Pick the SHA-1 from the non -v listing.
SHA1="$(security find-identity -p codesigning "$KC" | awk '/^  1\)/{print $2; exit}')"
[ -n "$SHA1" ] || { echo "no identity found in p12" >&2; exit 1; }
codesign --force --sign "$SHA1" --keychain "$KC" "$@" "$APP"
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep '^designated'
