#!/bin/sh
set -eu

launcher_dir=$(cd "$(dirname "$0")" && pwd)
root_dir=$(cd "$launcher_dir/.." && pwd)
mkdir -p "$HOME/.local/bin"
ln -sfn "$launcher_dir/src/symphonyctl.ts" "$HOME/.local/bin/symphonyctl"
ln -sfn "$root_dir/node_modules/mise/bin/mise" "$HOME/.local/bin/mise"
