#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(awk -F '"' '/^version *= *"/ { print $2; exit }' "$root/herdr-plugin.toml")
installed=""
if [ -f "$root/bin/version" ]; then
  IFS= read -r installed < "$root/bin/version" || true
fi
if [ ! -x "$root/bin/herdr-awtrix" ] || [ "$installed" != "$version" ]; then
  printf '%s\n' 'herdr-awtrix: matching binary is missing. Reinstall/update the plugin, or run `bun run build` in a locally linked checkout.' >&2
  exit 1
fi
exec "$root/bin/herdr-awtrix" "$@"
