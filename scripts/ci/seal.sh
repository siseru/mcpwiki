#!/usr/bin/env bash
# Encrypt-then-MAC a directory into a single file (and back) for workflow artifacts.
# Artifacts of public repositories are downloadable by anyone; the synthesized cloud assembly contains the
# account id, hosted zone and host names. Key: environment secret ARTIFACT_ENCRYPTION_KEY (>= 32 chars).
#   scripts/ci/seal.sh seal   <dir>  <out.sealed>
#   scripts/ci/seal.sh unseal <in.sealed> <dir>
set -euo pipefail
key="${ARTIFACT_ENCRYPTION_KEY:-}"
if [ "${#key}" -lt 32 ]; then echo "seal: ARTIFACT_ENCRYPTION_KEY must be set (>= 32 chars)" >&2; exit 1; fi
# Separate keys for encryption and authentication, derived from the secret.
enc_key=$(printf '%s' "enc:$key" | sha256sum | cut -d' ' -f1)
mac_key=$(printf '%s' "mac:$key" | sha256sum | cut -d' ' -f1)
mac() { openssl dgst -sha256 -mac HMAC -macopt "hexkey:$mac_key" -r "$1" | cut -d' ' -f1; }

case "${1:-}" in
  seal)
    src="$2"; out="$3"
    tar -C "$(dirname "$src")" -czf - "$(basename "$src")" |
      openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "pass:$enc_key" -out "$out.enc"
    mac "$out.enc" > "$out.mac"
    tar -cf "$out" -C "$(dirname "$out")" "$(basename "$out").enc" "$(basename "$out").mac"
    rm -f "$out.enc" "$out.mac"
    echo "seal: $(du -h "$out" | cut -f1) sealed"
    ;;
  unseal)
    in="$2"; dest="$3"; work=$(mktemp -d)
    tar -xf "$in" -C "$work"
    enc=$(ls "$work"/*.enc); expected=$(cat "$work"/*.mac)
    if [ "$(mac "$enc")" != "$expected" ]; then echo "unseal: MAC mismatch (artifact tampered or wrong key)" >&2; exit 1; fi
    mkdir -p "$dest"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$enc_key" -in "$enc" | tar -xzf - -C "$dest"
    rm -rf "$work"
    echo "unseal: ok"
    ;;
  *) echo "usage: seal.sh seal <dir> <out> | unseal <in> <dir>" >&2; exit 2 ;;
esac
