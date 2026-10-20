#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$launcher_dir/../.."
if ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS or newer (with npm), then run setup again.' >&2
  exit 1
fi
exec npm run setup
