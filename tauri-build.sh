#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname)" == "Darwin" ]]; then
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

  if [[ "$APPLE_SIGNING_IDENTITY" == "-" ]]; then
    echo "Using ad-hoc macOS code signing (set APPLE_SIGNING_IDENTITY to use a certificate)."
  else
    echo "Using macOS signing identity from APPLE_SIGNING_IDENTITY."
  fi
fi

exec tauri build "$@"
