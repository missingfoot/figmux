#!/usr/bin/env bash
# Updates Electron (and with it Chromium) to the latest release, then reinstalls.
# --auto (used by the systemd timer): only reinstalls when Electron changed, and
# reports through desktop notifications instead of the terminal.
set -euo pipefail

cd "$(dirname "$0")/.."

auto=false
[ "${1:-}" = "--auto" ] && auto=true

notify() {
  notify-send --app-name=Figma --icon=figmux "$@" 2>/dev/null || true
}

if $auto; then
  trap 'notify --urgency=critical "Figma update failed" "Run: journalctl --user -u figmux-update"' ERR
fi

before=$(node -p "require('electron/package.json').version")
npm install --save-dev electron@latest electron-builder@latest
after=$(node -p "require('electron/package.json').version")

if [ "$before" = "$after" ]; then
  echo "Electron is already up to date ($after)."
  $auto && exit 0
else
  echo "Electron $before -> $after"
fi

./scripts/install.sh

if $auto && [ "$before" != "$after" ]; then
  notify "Figma updated" "Electron $before → $after. Restart Figma to use it."
fi
