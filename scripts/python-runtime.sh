#!/usr/bin/env bash

# Print a usable Python 3.10+ interpreter, preferring newer versioned commands.
danus_find_python(){
  local candidate path
  if [ -n "${DANUS_BOOTSTRAP_PYTHON:-}" ]; then
    candidate="$DANUS_BOOTSTRAP_PYTHON"
    if [ -x "$candidate" ]; then path="$candidate"; else path="$(command -v "$candidate" 2>/dev/null || true)"; fi
    if [ -z "$path" ] || ! "$path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      printf 'configured Python must be version 3.10 or newer: %s\n' "$candidate" >&2
      return 1
    fi
    printf '%s\n' "$path"
    return 0
  fi

  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    path="$(command -v "$candidate" 2>/dev/null || true)"
    if [ -n "$path" ] && "$path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}
