#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Release launchers live at the top level; source launchers live in launchers/linux.
if [[ -f "$launcher_dir/app/scripts/launcher.mjs" ]]; then
  app_dir="$launcher_dir/app"
else
  app_dir=$(CDPATH= cd -- "$launcher_dir/../.." && pwd)
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS or newer from https://nodejs.org/en/download, then start again.' >&2
  exit 1
fi
exec node "$app_dir/scripts/launcher.mjs" start
