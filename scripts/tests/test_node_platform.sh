#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT/scripts/node-platform.sh"

assert_target(){
  local expected="$1" system="$2" machine="$3" actual
  actual="$(danus_node_platform "$system" "$machine")"
  [ "$actual" = "$expected" ] || {
    printf 'expected "%s", got "%s"\n' "$expected" "$actual" >&2
    exit 1
  }
}

assert_target 'linux x64 tar.xz' Linux x86_64
assert_target 'linux arm64 tar.xz' Linux aarch64
assert_target 'darwin x64 tar.gz' Darwin x86_64
assert_target 'darwin arm64 tar.gz' Darwin arm64
if danus_node_platform Windows x86_64 >/dev/null 2>&1; then exit 1; fi
if danus_node_platform Darwin riscv64 >/dev/null 2>&1; then exit 1; fi
printf '[ok] Node.js platform and architecture mapping\n'
