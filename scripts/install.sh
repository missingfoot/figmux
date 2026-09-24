#!/usr/bin/env bash
# Builds figmux and installs it for the current user with a desktop launcher.
set -euo pipefail

cd "$(dirname "$0")/.."

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/figmux/app"
DESKTOP_FILE="$DATA_HOME/applications/figmux.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor"

npm run dist

# Stage the new build next to the old one and swap them, so a running instance
# keeps its files until it's restarted instead of losing them mid-copy.
rm -rf "$APP_DIR.new" "$APP_DIR.old"
mkdir -p "$(dirname "$APP_DIR")" "$(dirname "$DESKTOP_FILE")"
cp -a dist/linux-unpacked "$APP_DIR.new"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
rm -f "$ICON_DIR/scalable/apps/figmux.svg"
for size in 16 24 32 48 64 128 256 512; do
  mkdir -p "$ICON_DIR/${size}x${size}/apps"
  magick assets/icon.png -resize "${size}x${size}" "$ICON_DIR/${size}x${size}/apps/figmux.png"
done

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Figma
GenericName=Interface Design
Comment=Figma with document tabs
Exec="$APP_DIR/figmux" %U
Icon=figmux
Terminal=false
Categories=Graphics;2DGraphics;VectorGraphics;
StartupWMClass=figmux
StartupNotify=true
Keywords=figma;design;figjam;
EOF

# Monthly background update of Electron/Chromium (see scripts/update.sh --auto).
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/figmux-update.service" <<EOF
[Unit]
Description=Update figmux (Electron/Chromium)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PWD
ExecStart=$PWD/scripts/update.sh --auto
EOF
cat > "$UNIT_DIR/figmux-update.timer" <<EOF
[Unit]
Description=Monthly figmux update

[Timer]
OnCalendar=monthly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now figmux-update.timer >/dev/null 2>&1 || echo "Could not enable figmux-update.timer"

update-desktop-database "$DATA_HOME/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$ICON_DIR" 2>/dev/null || true
kbuildsycoca6 >/dev/null 2>&1 || true

echo "Installed figmux (Electron $(node -p "require('electron/package.json').version")) to $APP_DIR"
if pgrep -f "$APP_DIR/figmux" >/dev/null; then
  echo "Figma is running the old version; restart it to use the new one."
fi
