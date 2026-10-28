#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
APP="$TMP/home/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$(dirname "$APP")" "$TMP/empty-path"
printf '#!/bin/sh\nexit 0\n' > "$APP"
chmod +x "$APP"

HOME="$TMP/home" DANUS_CHROME_BIN="" bash -c '
  uname() { printf "Darwin\\n"; }
  . "$1/scripts/env.sh"
  DANUS_CHROME_BIN=""
  PATH="$2"
  found="$(danus_find_chrome)"
  [ "$found" = "$3" ]
' bash "$ROOT" "$TMP/empty-path" "$APP"
printf '[ok] macOS Chrome.app discovery\n'
