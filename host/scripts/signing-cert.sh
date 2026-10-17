#!/bin/bash
# Creates a self-signed code-signing identity as a macOS-importable (legacy PBE) .p12.
# Usage: signing-cert.sh <outdir> <p12-password> ["Common Name"] ["Organisation"]
# With an O= field codesign's default DR is `certificate root = H"<sha1>"`; without O= it is
# `certificate leaf = H"<sha1>"` (observed on macOS 27.0). Both stay identical across rebuilds.
# Output: <outdir>/perch-signing.p12, cert.pem, key.pem. Keep key.pem/p12 SECRET (e.g. GitHub secret):
# TCC grants are keyed to `certificate root = H"<sha1 of this cert>"`, so losing it resets every
# user's permissions, and leaking it lets others sign code that inherits Perch's permissions.
set -euo pipefail
OUT="$1"; PW="$2"; CN="${3:-Perch Self-Signed Code Signing}"; ORG="${4:-Just-Rice}"
OPENSSL="$(command -v /opt/homebrew/bin/openssl || command -v openssl)"
mkdir -p "$OUT"; umask 077
cat > "$OUT/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = ext
[ dn ]
CN = $CN
O = $ORG
[ ext ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -days 7300 -config "$OUT/cert.cnf" 2>/dev/null
# OpenSSL 3+/4 default PKCS#12 (AES/PBKDF2) fails in `security import` with
# "MAC verification failed during PKCS12 import (wrong password?)", so use -legacy (3DES/SHA1).
if "$OPENSSL" version | grep -q LibreSSL; then
  "$OPENSSL" pkcs12 -export -inkey "$OUT/key.pem" -in "$OUT/cert.pem" -name "$CN" -out "$OUT/perch-signing.p12" -passout "pass:$PW"
else
  "$OPENSSL" pkcs12 -export -legacy -inkey "$OUT/key.pem" -in "$OUT/cert.pem" -name "$CN" -out "$OUT/perch-signing.p12" -passout "pass:$PW"
fi
echo "SHA1 (DR root hash): $("$OPENSSL" x509 -in "$OUT/cert.pem" -outform der | shasum -a 1 | cut -d' ' -f1)"
