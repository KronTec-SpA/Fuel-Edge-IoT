#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sdk_path=$(xcrun --sdk macosx15.4 --show-sdk-path)
module_cache="${TMPDIR:-/tmp}/fuel-mim-swift-module-cache"

exec xcrun swift \
    -sdk "$sdk_path" \
    -module-cache-path "$module_cache" \
    "$script_dir/scan_mim_ble.swift" "$@"
