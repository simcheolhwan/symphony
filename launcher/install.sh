#!/bin/sh
set -eu

launcher_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/bin"
ln -sfn "$launcher_dir/src/symphonyctl.ts" "$HOME/.local/bin/symphonyctl"
