#!/usr/bin/env bash
# Run the LiteSVM suite against the last build. Same target dir as build.sh
# so the test's include_bytes! finds the .so. Pass a test name to filter.
set -euo pipefail
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/ratpool-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cd "$(dirname "$0")"
cargo test -p ratpool-escrow "$@"
