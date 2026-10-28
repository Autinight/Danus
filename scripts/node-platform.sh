#!/usr/bin/env bash

# Print the Node.js distribution platform, architecture, and archive suffix.
danus_node_platform(){
  local system="${1:-$(uname -s)}" machine="${2:-$(uname -m)}" node_os node_suffix node_arch
  case "$system" in
    Linux) node_os=linux; node_suffix=tar.xz ;;
    Darwin) node_os=darwin; node_suffix=tar.gz ;;
    *) printf 'unsupported operating system: %s\n' "$system" >&2; return 1 ;;
  esac
  case "$machine" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) printf 'unsupported CPU architecture: %s\n' "$machine" >&2; return 1 ;;
  esac
  printf '%s %s %s\n' "$node_os" "$node_arch" "$node_suffix"
}
