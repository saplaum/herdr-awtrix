#!/bin/sh
# Herdr runs this build step on install/update, before registering the plugin.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf 'herdr-awtrix install: %s\n' "$*" >&2; exit 1; }

version=$(awk -F '"' '/^version *= *"/ { print $2; exit }' "$root/herdr-plugin.toml")
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "invalid manifest version"
case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required to download the binary"
command -v tar >/dev/null 2>&1 || fail "tar is required to unpack the binary"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

archive="herdr-awtrix-${os}-${arch}.tar.gz"
base="https://github.com/saplaum/herdr-awtrix/releases/download/v${version}"
mkdir -p "$root/bin"
staging=$(mktemp -d "$root/bin/.install.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' HUP INT TERM

for file in SHA256SUMS "$archive"; do
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --output "$staging/$file" "$base/$file" \
    || fail "could not download $file for v$version; check that the release is published"
done
expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$staging/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "missing or invalid checksum for $archive"
actual=$(checksum "$staging/$archive")
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive; refusing to install"

tar -xzf "$staging/$archive" -C "$staging" herdr-awtrix || fail "could not unpack binary"
[ -f "$staging/herdr-awtrix" ] && [ ! -L "$staging/herdr-awtrix" ] || fail "release must contain a regular binary"
chmod 755 "$staging/herdr-awtrix"
"$staging/herdr-awtrix" --help >/dev/null || fail "binary cannot run on this machine"
printf '%s\n' "$version" > "$staging/version"
mv -f "$staging/herdr-awtrix" "$root/bin/herdr-awtrix"
mv -f "$staging/version" "$root/bin/version"
printf 'herdr-awtrix: installed v%s (%s-%s)\n' "$version" "$os" "$arch"
