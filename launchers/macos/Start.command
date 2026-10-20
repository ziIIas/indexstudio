#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$launcher_dir/start.sh" ]]; then
  bash "$launcher_dir/start.sh" && exit 0
else
  bash "$launcher_dir/../linux/start.sh" && exit 0
fi
if [[ -t 0 ]]; then read -r -p 'Press Return to close.'; fi
exit 1
