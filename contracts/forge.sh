#!/usr/bin/env bash
# Runs forge locally if installed, otherwise in the official Foundry image.
set -euo pipefail
cd "$(dirname "$0")"
if command -v forge >/dev/null 2>&1; then
  exec forge "$@"
fi
mkdir -p cache/home
exec docker run --rm -u "$(id -u):$(id -g)" -e HOME=/app/cache/home \
  -v "$PWD":/app -w /app --entrypoint forge ghcr.io/foundry-rs/foundry:stable "$@"
