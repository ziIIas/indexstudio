#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$launcher_dir/stop.sh" ]]; then
  bash "$launcher_dir/stop.sh"
else
  bash "$launcher_dir/../linux/stop.sh"
fi
