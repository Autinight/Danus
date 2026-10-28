#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RM="$(command -v rm)"
TMP="$(mktemp -d)"
trap '"$RM" -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

make_python_stub(){
  local name="$1" result="$2"
  printf '#!/bin/sh\nexit %s\n' "$result" > "$TMP/bin/$name"
  chmod +x "$TMP/bin/$name"
}

make_python_stub python3.14 1
make_python_stub python3.13 0
make_python_stub python3.12 0
. "$ROOT/scripts/python-runtime.sh"
PATH="$TMP/bin:$PATH"
export PATH
[ "$(danus_find_python)" = "$TMP/bin/python3.13" ]
DANUS_BOOTSTRAP_PYTHON="$TMP/bin/python3.12"
export DANUS_BOOTSTRAP_PYTHON
[ "$(danus_find_python)" = "$TMP/bin/python3.12" ]
DANUS_BOOTSTRAP_PYTHON="$TMP/bin/python3.14"
export DANUS_BOOTSTRAP_PYTHON
if danus_find_python >/dev/null 2>&1; then exit 1; fi
printf '[ok] Python 3.10+ selection and override validation\n'
