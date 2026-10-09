#!/bin/sh
# Install a checksum-pinned helper bundle. Never compile on a user's machine.
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
case "$url" in https://github.com/agent-axiom/aximo-voice/releases/download/v*/aximo-voice-native-"$platform".tar.gz) ;; *) echo 'Untrusted runtime URL.' >&2; exit 1;; esac
[ ! -L "$ROOT/bin" ] || { echo 'Refusing symlink runtime directory.' >&2; exit 1; }
[ ! -e "$ROOT/bin" ] || [ -d "$ROOT/bin" ] || { echo 'Runtime destination is not a directory.' >&2; exit 1; }
umask 077
tmp=$(mktemp -d "$ROOT/.runtime-setup.XXXXXXXX")
cleanup() {
  if [ ! -e "$ROOT/bin" ] && [ -d "$tmp/previous" ]; then mv "$tmp/previous" "$ROOT/bin" || return; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
archive="$tmp/runtime.tar.gz"
curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 "$url" -o "$archive"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
else echo 'No system SHA-256 verifier found; runtime was not installed.' >&2; exit 1; fi
[ "$actual" = "$sha" ] || { echo 'Runtime checksum mismatch; runtime was not installed.' >&2; exit 1; }
# Runtime packages contain flat regular files only. Reject path traversal, links,
# duplicate paths and surprising names before extracting even a verified bundle.
tar -tzf "$archive" > "$tmp/names"
[ -s "$tmp/names" ] || { echo 'Runtime archive is empty.' >&2; exit 1; }
while IFS= read -r name; do
  case "$name" in ''|.*|*[!a-zA-Z0-9._-]*) echo 'Unsafe runtime archive entry.' >&2; exit 1;; esac
done < "$tmp/names"
[ -z "$(sort "$tmp/names" | uniq -d)" ] || { echo 'Duplicate runtime archive entry.' >&2; exit 1; }
tar -tvzf "$archive" > "$tmp/types"
if grep -v '^-' "$tmp/types" >/dev/null; then echo 'Runtime archive may contain only regular files.' >&2; exit 1; fi
mkdir "$tmp/runtime"
tar -xzf "$archive" -C "$tmp/runtime" --no-same-owner
[ -f "$tmp/runtime/aximo-voice-native" ] && [ ! -L "$tmp/runtime/aximo-voice-native" ] || { echo 'Runtime executable is missing.' >&2; exit 1; }
chmod 700 "$tmp/runtime/aximo-voice-native"
"$tmp/runtime/aximo-voice-native" --version >/dev/null
[ ! -d "$ROOT/bin" ] || mv "$ROOT/bin" "$tmp/previous"
mv "$tmp/runtime" "$ROOT/bin"
printf '%s\n' 'Verified Aximo Voice runtime bundle installed.'
