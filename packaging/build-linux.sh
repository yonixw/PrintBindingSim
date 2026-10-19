#!/bin/sh
# Build the portable Linux binary inside Docker (works from Windows Git Bash too).
# Debian bullseye (glibc 2.31) so the result runs on most distros (Ubuntu 20.04+).
set -e
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1                 # Git Bash: don't rewrite /src
SRC="$(pwd -W 2>/dev/null || pwd)"        # Git Bash gives E:/..., Linux gives /...
docker run --rm -v "$SRC":/src -w /src \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  python:3.12-slim-bullseye sh -c '
    apt-get update -qq && apt-get install -y -qq binutils >/dev/null &&
    pip install -q --root-user-action=ignore -r packaging/requirements-build.txt &&
    python packaging/build.py &&
    chown -R "$HOST_UID:$HOST_GID" dist build'
