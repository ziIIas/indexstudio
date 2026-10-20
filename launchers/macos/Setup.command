#!/usr/bin/env bash
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if bash "$launcher_dir/../linux/setup.sh"; then exit 0; fi
if [[ -t 0 ]]; then read -r -p 'Press Return to close.'; fi
exit 1
