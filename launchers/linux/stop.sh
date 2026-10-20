#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$launcher_dir/app/scripts/launcher.mjs" ]]; then
  app_dir="$launcher_dir/app"
else
  app_dir=$(CDPATH= cd -- "$launcher_dir/../.." && pwd)
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is not on your PATH. Close the server terminal to stop a foreground server.' >&2
  exit 1
fi
exec node "$app_dir/scripts/launcher.mjs" stop
