#!/usr/bin/env bash
# Build the escrow program.
#
# Run inside WSL2 (see docs/ESCROW.md §6). Two things are deliberate:
#
#   --arch v0      Anchor 1.2 defaults to SBPF v3, which LiteSVM's loader does
#                  not accept. v0 is what `cargo build-sbf` itself defaults to
#                  and what every cluster and simulator runs. The verifiable
#                  build must pass the same flag or the hashes will not match.
#
#   CARGO_TARGET_DIR on the Linux side. The repo lives on the Windows drive,
#                  and cargo's thousands of small writes over 9p turn a
#                  one-minute build into an hour. Everything Anchor produces
#                  — .so, keypair, idl/, types/ — lands there; export.sh copies
#                  what the frontend needs back into the repo.
set -euo pipefail
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/ratpool-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cd "$(dirname "$0")"
anchor build --arch v0 "$@"
echo "built: $CARGO_TARGET_DIR/deploy/ratpool_escrow.so"
sha256sum "$CARGO_TARGET_DIR/deploy/ratpool_escrow.so"
