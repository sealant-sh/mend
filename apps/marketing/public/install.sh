#!/bin/sh
# Install the Mend CLI only:
#
#   curl -fsSL https://mend.sealant.dev/install.sh | sh
#   curl -fsSL https://mend.sealant.dev/install.sh | MEND_VERSION=0.23.0 sh
#
# This script never starts Docker or a Mend server. Run `mend server setup`
# yourself when you are ready to create or repair the local server.
set -eu

info() { printf '%s\n' "$1"; }
die() { printf 'mend install: %s\n' "$1" >&2; exit 1; }

main() {
  # Node.js 22.13 is the oldest the CLI takes (engines.node in apps/cli/package.json): node:sqlite
  # loads without a flag from there. The terminal dashboard needs Node.js 26.
  command -v node >/dev/null 2>&1 ||
    die "Node.js 22.13 or newer is required. Install it from https://nodejs.org/ or your package manager, then retry."
  node_version="$(node -p "process.versions.node" 2>/dev/null || true)"
  node_major="${node_version%%.*}"
  node_minor="${node_version#*.}"
  node_minor="${node_minor%%.*}"
  case "$node_major.$node_minor" in
    *[!0-9.]* | .* | *.)
      die "Could not read the installed Node.js version. Install Node.js 22.13 or newer, then retry."
      ;;
  esac
  [ "$node_major" -gt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 13 ]; } ||
    die "Node.js 22.13 or newer is required; found $(node --version 2>/dev/null || printf unknown). Upgrade Node.js, then retry."

  command -v npm >/dev/null 2>&1 ||
    die "npm is required. Install the npm package supplied with Node.js 22.13 or newer, then retry."

  version="${MEND_VERSION:-latest}"
  case "$version" in
    '' | *[!0-9A-Za-z._+-]*)
      die "MEND_VERSION must be an npm version or tag such as 0.23.0 or latest."
      ;;
  esac

  info "Installing @sealant/mend@$version with npm..."
  if ! npm install --global --no-fund --no-audit "@sealant/mend@$version"; then
    die "npm could not install the CLI globally. Fix npm's global prefix or permissions, then run: npm install -g @sealant/mend@$version"
  fi

  info "Mend CLI installed."
  info "Next: mend server setup"
}

main "$@"
