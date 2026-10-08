#!/bin/sh
# Install only a checksum-pinned native helper. Never compile on a user's machine.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=macos-aarch64 ;;
  Darwin:x86_64) platform=macos-x86_64 ;;
  Linux:x86_64) platform=linux-x86_64 ;;
  *) printf '%s\n' 'No prebuilt Aximo Voice runtime is available for this platform.' >&2; exit 1 ;;
esac
sha=''; url=''
while read -r key checksum location rest; do
  [ "$key" = "$platform" ] || continue
  [ -z "$sha" ] || { echo 'Duplicate runtime manifest entry.' >&2; exit 1; }
  sha=$checksum; url=$location
  [ -z "$rest" ] || { echo 'Invalid runtime manifest entry.' >&2; exit 1; }
done < "$ROOT/scripts/runtime-manifest.txt"
[ "${#sha}" -eq 64 ] || { echo 'This source preview has no published, verified runtime. See docs/installation.md.' >&2; exit 1; }
case "$sha" in *[!0-9a-f]*) echo 'Invalid runtime checksum.' >&2; exit 1;; esac
case "$url" in https://github.com/agent-axiom/aximo-voice/releases/download/v*/aximo-voice-native-*) ;; *) echo 'Untrusted runtime URL.' >&2; exit 1;; esac
[ ! -L "$ROOT/bin" ] || { echo 'Refusing symlink runtime directory.' >&2; exit 1; }
mkdir -p "$ROOT/bin"
umask 077
tmp=$(mktemp "$ROOT/bin/.runtime.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 "$url" -o "$tmp"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp" | cut -d ' ' -f 1)
else echo 'No system SHA-256 verifier found; runtime was not installed.' >&2; exit 1; fi
[ "$actual" = "$sha" ] || { echo 'Runtime checksum mismatch; runtime was not installed.' >&2; exit 1; }
chmod 700 "$tmp"
mv -f "$tmp" "$ROOT/bin/aximo-voice-native"
printf '%s\n' 'Verified Aximo Voice runtime installed.'
