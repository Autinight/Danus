#!/bin/bash
set -euo pipefail
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$TOOLS_DIR/.." && pwd)"
export DANUS_APP_ROOT="$APP_ROOT/upstream/danus"
export DANUS_APP_DATA="${DANUS_APP_DATA:?Set DANUS_APP_DATA to a writable directory outside the App install}"
mkdir -p "$DANUS_APP_DATA"
DANUS_APP_DATA="$(cd "$DANUS_APP_DATA" && pwd -P)"
case "$DANUS_APP_DATA/" in
  "$APP_ROOT/"*|"$DANUS_APP_ROOT/"*) echo "DANUS_APP_DATA must be outside the installed App" >&2; exit 2 ;;
esac
export DANUS_APP_DATA
mkdir -p "$DANUS_APP_DATA"/{projects,logs,config,verify-runs}
export DANUS_ROOT="$DANUS_APP_ROOT"
export DANUS_RUNTIME="$DANUS_APP_DATA"
export DANUS_AGENTS_ROOT="$DANUS_APP_DATA/projects"
export VERIFIER_RESULTS_DIR="$DANUS_APP_DATA/verify-runs"
# Reuse the local application's standard login; never copy account files.
export CODEX_HOME="$HOME/.codex"
export DANUS_PY="$APP_ROOT/dependencies/python/bin/python3"
export PYTHONHOME="$APP_ROOT/dependencies/python"
export PYTHONPATH="$DANUS_APP_ROOT:$APP_ROOT/dependencies/python/site-packages"
export DANUS_CODEX="$APP_ROOT/dependencies/codex/bin/codex"
export DANUS_CODEX_BIN="$DANUS_CODEX"
export PATH="$TOOLS_DIR:$APP_ROOT/dependencies/python/bin:$PATH"
